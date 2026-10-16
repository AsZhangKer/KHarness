package com.example.jsonbridgereceiver

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.example.jsonbridgereceiver.ui.MainActivity

/**
 * 通知中心：统一管理渠道与通知。
 *
 * 两个渠道（职责分离，避免"常驻通知"把重要提醒挤掉）：
 * - [CH_SERVICE] 常驻通知：前台服务存活标识，IMPORTANCE_LOW，静音、不弹横幅、不可划掉
 * - [CH_ALERT]   事件提醒：有新事件待处理时弹 heads-up + 响铃震动，IMPORTANCE_HIGH
 *
 * 说明：本 App 走局域网直连（手机 ↔ 电脑 45678），**没有云端服务端，也没有接 Google 服务**，
 * 因此无法使用 FCM 这类真正的「消息推送服务」；"App 不在前台时提醒"由
 * 前台服务常驻 + 本地通知实现（效果等同：锁屏/后台时直接弹提醒）。
 */
object Notifier {

    private const val CH_SERVICE = "jsonbridge_service"
    private const val CH_ALERT = "jsonbridge_alert"

    /** 常驻通知 id（固定，反复 notify 同一 id 即更新） */
    const val ID_SERVICE = 1001

    /** 事件提醒通知 id（固定，队列变化时更新；无待处理事件时取消） */
    const val ID_ALERT = 1002

    fun ensureChannels(ctx: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        // 常驻渠道：静音低调，只是让用户知道服务活着
        nm.createNotificationChannel(
            NotificationChannel(CH_SERVICE, "后台服务", NotificationManager.IMPORTANCE_LOW).apply {
                description = "保持与电脑的连接，显示当前连接状态"
                setShowBadge(false)
            }
        )

        // 提醒渠道：高优先级才会弹 heads-up（锁屏/其他应用上方横幅）
        nm.createNotificationChannel(
            NotificationChannel(CH_ALERT, "待处理事件", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "有新的审批或提问需要处理时提醒"
                enableVibration(true)
                setShowBadge(true)
                // 高优先级渠道必须有关联音频属性，否则部分 ROM 仍不弹横幅
                setSound(
                    android.provider.Settings.System.DEFAULT_NOTIFICATION_URI,
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                        .build()
                )
            }
        )
    }

    /** 通知权限是否可用（Android 13+ 需 POST_NOTIFICATIONS，用户可随时在系统里关掉） */
    fun canPost(ctx: Context): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) return false
        return NotificationManagerCompat.from(ctx).areNotificationsEnabled()
    }

    /** 打开 App 的 PendingIntent（点通知回到主界面） */
    private fun openApp(ctx: Context, reqCode: Int): PendingIntent = PendingIntent.getActivity(
        ctx,
        reqCode,
        Intent(ctx, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        },
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )

    /** 常驻通知：显示连接状态 */
    fun buildServiceNotification(ctx: Context, text: String): Notification =
        NotificationCompat.Builder(ctx, CH_SERVICE)
            .setContentTitle("KHarness 手机端")
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_notification)
            .setOngoing(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(openApp(ctx, 0))
            .build()

    /**
     * 新事件提醒：heads-up 弹出。
     * @param title  一句话说清是什么（如"待审批 · Bash"）
     * @param text   正文（审批原因 / 问题）
     * @param queued 待处理总数（用于"还有 N 条"）
     */
    fun postAlert(ctx: Context, title: String, text: String, queued: Int) {
        if (!canPost(ctx)) return
        val more = if (queued > 1) "（共 $queued 条待处理）" else ""
        val n = NotificationCompat.Builder(ctx, CH_ALERT)
            .setContentTitle(title + more)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setSmallIcon(R.drawable.ic_notification)
            .setPriority(NotificationCompat.PRIORITY_HIGH)   // heads-up 关键
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            // 注意：不要设 setOnlyAlertOnce —— 同一 id 复用，新事件到来时必须再响一次
            .setContentIntent(openApp(ctx, 1))
            .build()
        try {
            NotificationManagerCompat.from(ctx).notify(ID_ALERT, n)
        } catch (_: SecurityException) {
            // 权限刚被撤销时 notify 会抛，静默即可
        }
    }

    /** 待处理事件清空后撤掉提醒（通知栏不留过期条目） */
    fun cancelAlert(ctx: Context) {
        NotificationManagerCompat.from(ctx).cancel(ID_ALERT)
    }

    fun cancelService(ctx: Context) {
        NotificationManagerCompat.from(ctx).cancel(ID_SERVICE)
    }
}
