package com.example.jsonbridgereceiver

import android.annotation.SuppressLint
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings

/**
 * 后台保活辅助：检查/申请「电池优化白名单」，以及跳转各厂商的自启动管理页。
 *
 * 说明：Android 没有"一个按钮拿到永久后台权限"的官方 API，标准做法就是
 * 电池优化白名单（官方 API）+ 厂商自启动开关（无 API，只能引导用户手点）。
 *
 * ⚠️ 该操作会让 App 不受 Doze 省电策略限制，仅适合本类需要常驻监听的工具。
 */
object KeepAlive {

    /** 是否已加入电池优化白名单（API 23+；低版本无此机制，视为已放行） */
    fun isIgnoringBatteryOptimizations(ctx: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return true
        return pm.isIgnoringBatteryOptimizations(ctx.packageName)
    }

    /**
     * 申请加入电池优化白名单：直接弹系统授权框。
     * 少数 ROM 不带这个 Activity，此时退回「电池优化设置」列表页让用户手动选。
     */
    @SuppressLint("BatteryLife") // 常驻监听场景确有必要，已向用户说明用途
    fun requestIgnoreBatteryOptimizations(ctx: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        // 部分 ROM 会把 APPLY 直接返回 false，故先尝试直连授权框，失败再退回列表
        try {
            ctx.startActivity(
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = Uri.parse("package:${ctx.packageName}")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
            )
            return
        } catch (_: Exception) {
            // 落到下面的列表页
        }
        try {
            ctx.startActivity(
                Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        } catch (_: Exception) {
            openAppDetailSettings(ctx)
        }
    }

    /**
     * 打开厂商的「自启动 / 后台运行」管理页。
     * 这些页面没有统一 API，只能按 ComponentName 逐个试，全失败则落到应用详情页。
     */
    fun openAutoStartSettings(ctx: Context) {
        // 常见厂商的自启动管理页（包名 + Activity 全名）
        val candidates = listOf(
            "com.coloros.safecenter" to "com.coloros.safecenter.permission.startup.StartupAppListActivity",
            "com.coloros.safecenter" to "com.coloros.safecenter.startupapp.StartupAppListActivity",
            "com.oppo.safe" to "com.oppo.safe.permission.startup.StartupAppListActivity",
            "com.vivo.permissionmanager" to "com.vivo.permissionmanager.activity.BgStartUpManagerActivity",
            "com.iqoo.secure" to "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity",
            "com.huawei.systemmanager" to "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
            "com.huawei.systemmanager" to "com.huawei.systemmanager.optimize.process.ProtectActivity",
            "com.miui.securitycenter" to "com.miui.permcenter.autostart.AutoStartManagementActivity",
            "com.letv.android.letvsafe" to "com.letv.android.letvsafe.AutobootManageActivity",
            "com.samsung.android.lool" to "com.samsung.android.sm.ui.battery.BatteryActivity",
            "com.asus.mobilemanager" to "com.asus.mobilemanager.autostart.AutoStartActivity"
        )
        for ((pkg, cls) in candidates) {
            val i = Intent().apply {
                component = ComponentName(pkg, cls)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            if (ctx.packageManager.resolveActivity(i, 0) != null) {
                try {
                    ctx.startActivity(i)
                    return
                } catch (_: Exception) {
                    // 继续试下一个
                }
            }
        }
        // 都不存在：落到本应用详情页，用户可自行找"自启动/后台运行"
        openAppDetailSettings(ctx)
    }

    fun openAppDetailSettings(ctx: Context) {
        try {
            ctx.startActivity(
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = Uri.parse("package:${ctx.packageName}")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
            )
        } catch (_: Exception) {
            LogBus.w("keepalive", "无法打开应用详情页")
        }
    }
}
