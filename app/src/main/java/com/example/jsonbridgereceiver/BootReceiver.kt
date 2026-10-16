package com.example.jsonbridgereceiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * 开机自启：手机重启后自动拉起前台服务，不需要用户手动打开 App。
 *
 * 注意：国产 ROM 还需用户在「自启动管理」里放行本应用，否则收不到这个广播
 * （见 KeepAlive.openAutoStartSettings 的引导）。
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action == Intent.ACTION_BOOT_COMPLETED ||
            action == Intent.ACTION_MY_PACKAGE_REPLACED
        ) {
            LogBus.i("boot", "开机/更新后自动启动后台服务")
            try {
                BridgeService.start(context)
            } catch (e: Exception) {
                // Android 12+ 后台启动前台服务有限制，失败只记日志，等用户手动打开 App
                LogBus.w("boot", "自动启动失败：${e.message}")
            }
        }
    }
}
