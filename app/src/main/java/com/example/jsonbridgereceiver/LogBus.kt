package com.example.jsonbridgereceiver

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 一条运行日志。level 取值：INFO / WARN / ERROR / EVENT / REPLY。
 * time 为本地 HH:mm:ss，仅供日志查看入口展示。
 */
data class LogEntry(
    val ts: Long,
    val level: String,
    val tag: String,
    val msg: String
) {
    val time: String
        get() = TIME_FMT.format(Date(ts))

    companion object {
        private val TIME_FMT = SimpleDateFormat("HH:mm:ss", Locale.US)
    }
}

/**
 * 内存日志环：只保存在内存（不落盘），供「运行日志」入口实时查看。
 * 保留最近 [MAX] 条，超出丢弃最旧的。线程安全（写时加锁）。
 */
object LogBus {
    private const val MAX = 300

    private val _logs = MutableStateFlow<List<LogEntry>>(emptyList())
    val logs: StateFlow<List<LogEntry>> = _logs.asStateFlow()

    @Synchronized
    fun log(level: String, tag: String, msg: String) {
        val entry = LogEntry(System.currentTimeMillis(), level, tag, msg)
        _logs.value = (_logs.value + entry).takeLast(MAX)
    }

    @Synchronized
    fun clear() {
        _logs.value = emptyList()
    }

    fun i(tag: String, msg: String) = log("INFO", tag, msg)
    fun w(tag: String, msg: String) = log("WARN", tag, msg)
    fun e(tag: String, msg: String) = log("ERROR", tag, msg)
}
