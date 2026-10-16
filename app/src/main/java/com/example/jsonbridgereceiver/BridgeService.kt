package com.example.jsonbridgereceiver

import android.app.*
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationManagerCompat
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collectLatest

/**
 * 前台服务：让手机端在后台常驻，持续监听电脑推来的审批/提问事件。
 *
 * 保活三层（缺一层都可能被系统冻结）：
 * 1. 前台服务 + START_STICKY：进程被回收后由系统重建，通知栏常驻可见
 * 2. 电池优化白名单（见 KeepAlive）：不被 Doze 深度冻结
 * 3. 开机自启（BootReceiver）：重启手机后自动恢复
 */
class BridgeService : Service() {

    companion object {
        /** 已提醒过的事件 seq，避免状态反复推送时重复弹通知（静态：切后台补检查也要读它） */
        @Volatile
        private var alertedSeq: Int? = null

        fun start(ctx: Context) {
            val i = Intent(ctx, BridgeService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(i)
            } else {
                ctx.startService(i)
            }
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, BridgeService::class.java))
        }

        /**
         * App 切到后台时调用：补一次检查。
         *
         * 为什么需要：事件若在 App 前台时到达，按「不打扰正在看的人」的规则不会弹通知；
         * 但用户随后直接切走、并没有处理它，此时必须补提醒，否则这条事件就静默丢失了。
         */
        fun refreshAlertIfNeeded(ctx: Context) {
            val s = BridgeEngine.state.value
            val p = s.pending
            if (p == null) {
                alertedSeq = null
                Notifier.cancelAlert(ctx)
                return
            }
            if (p.seq != alertedSeq) {
                alertedSeq = p.seq
                Notifier.postAlert(ctx, alertTitle(p), alertBody(p), s.queued)
            }
        }

        /**
         * App 回到前台时调用：撤掉通知栏提醒，并清掉"已提醒"标记。
         *
         * 清标记是必须的：否则用户看了一眼又切走、事件仍未处理，就再也收不到提醒了
         * （refreshAlertIfNeeded 会因 seq 相同而跳过）。
         */
        fun onAppForeground(ctx: Context) {
            alertedSeq = null
            Notifier.cancelAlert(ctx)
        }

        private fun alertTitle(p: BridgeEngine.Pending): String =
            if (p.kind == "approval") "待你审批" else "待你回答"

        private fun alertBody(p: BridgeEngine.Pending): String =
            p.body.ifBlank { p.title }

        private fun statusText(status: String, host: String?): String = when {
            status == "connected" -> "已连接电脑 ${host ?: ""}".trim()
            status == "connecting" -> "正在查找电脑…"
            status.startsWith("rejected") -> "配对被拒绝，请在电脑端重新配对"
            status.startsWith("error") -> "连接出错：${status.removePrefix("error:").trim()}"
            else -> "后台运行中"
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var collectJob: Job? = null

    override fun onCreate() {
        super.onCreate()
        Notifier.ensureChannels(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 必须先 startForeground，否则前台服务会因超时抛 ANR/崩溃
        startForeground(Notifier.ID_SERVICE, Notifier.buildServiceNotification(this, "正在运行"))

        BridgeEngine.start(applicationContext)

        if (collectJob == null) {
            collectJob = scope.launch {
                BridgeEngine.state.collectLatest { s ->
                    // 常驻通知实时反映连接状态
                    updateServiceNotification(statusText(s.status, s.host))

                    // 新事件提醒：仅当 App 不在前台（切后台/锁屏）时弹 heads-up
                    val p = s.pending
                    when {
                        p == null -> {
                            alertedSeq = null
                            Notifier.cancelAlert(this@BridgeService)
                        }
                        AppForeground.isForeground -> onAppForeground(this@BridgeService)
                        p.seq != alertedSeq -> {
                            alertedSeq = p.seq
                            Notifier.postAlert(this@BridgeService, alertTitle(p), alertBody(p), s.queued)
                        }
                    }
                }
            }
        }
        return START_STICKY
    }

    /** 就地更新常驻通知（同一 id，反复 notify 即刷新文本） */
    private fun updateServiceNotification(text: String) {
        try {
            NotificationManagerCompat.from(this)
                .notify(Notifier.ID_SERVICE, Notifier.buildServiceNotification(this, text))
        } catch (_: SecurityException) {
            // 通知权限被撤销时忽略
        }
    }

    override fun onDestroy() {
        collectJob?.cancel()
        scope.cancel()
        BridgeEngine.stop()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    /** 从最近任务里划掉 App：不停止服务，靠 START_STICKY 继续常驻 */
    override fun onTaskRemoved(rootIntent: Intent?) {
        LogBus.i("service", "App 被划出最近任务，服务继续保持后台运行")
        super.onTaskRemoved(rootIntent)
    }
}
