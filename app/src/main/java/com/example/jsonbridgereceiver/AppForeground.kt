package com.example.jsonbridgereceiver

/**
 * 前后台状态追踪：仅记录"当前有几个 Activity 处于已启动状态"。
 *
 * 用途：新事件到达时判断是否需要弹通知 —— 用户正看着界面就不打扰，
 * 只有 App 被切到后台/锁屏时才提醒。
 *
 * 用计数而非布尔，避免多 Activity/配置变更时状态错乱。
 */
object AppForeground {
    @Volatile
    private var started = 0

    val isForeground: Boolean
        get() = started > 0

    fun onActivityStart() {
        started++
    }

    fun onActivityStop() {
        // 防御：极端时序下可能多减，钳到 0 即可
        started = (started - 1).coerceAtLeast(0)
    }
}
