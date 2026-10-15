package com.example.jsonbridgereceiver

import android.app.*
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.example.jsonbridgereceiver.ui.MainActivity
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collectLatest

class BridgeService : Service() {

    companion object {
        private const val CHANNEL_ID = "jsonbridge"
        private const val NOTIF_ID = 1001

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
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var collectJob: Job? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIF_ID, buildNotification("正在运行"))
        BridgeEngine.start(applicationContext)

        if (collectJob == null) {
            collectJob = scope.launch {
                BridgeEngine.state.collectLatest { s ->
                    val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
                    nm.notify(NOTIF_ID, buildNotification(statusText(s.status, s.host)))
                }
            }
        }
        return START_STICKY
    }

    private fun statusText(status: String, host: String?): String = when {
        status == "connected" -> "已连接 $host"
        status == "connecting" -> "连接中…"
        status.startsWith("rejected") -> "被拒绝: $status"
        status.startsWith("error") -> "错误: $status"
        else -> status
    }

    override fun onDestroy() {
        collectJob?.cancel()
        scope.cancel()
        BridgeEngine.stop()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(
                CHANNEL_ID,
                "JsonBridge",
                NotificationManager.IMPORTANCE_LOW
            )
            val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(ch)
        }
    }

    private fun buildNotification(text: String): Notification {
        val pi = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("JsonBridge 接收端")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setOngoing(true)
            .setContentIntent(pi)
            .build()
    }
}