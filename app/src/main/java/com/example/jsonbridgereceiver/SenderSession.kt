package com.example.jsonbridgereceiver

import kotlinx.coroutines.*
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.net.InetSocketAddress
import java.net.Socket

/**
 * 与电脑端的一条长连接会话。
 *
 * 关键设计：**断线自动重连**（指数退避 1s → 2s → 4s → … → 30s 封顶）。
 *
 * 为什么必须自己做重连：手机进入后台后，系统的 Wi-Fi 省电 / 后台限制会丢弃组播包，
 * 而设备发现（DiscoveryListener）正是靠组播驱动。若把「重连」寄托在发现广播上，
 * 就会出现「服务还活着、却几十分钟连不上」的空窗 —— 这段时间电脑推来的
 * 审批 / 提问全部丢失（后端在无连接时是直接丢弃的）。
 *
 * 例外：握手被拒（sid_mismatch / cid_mismatch / bad_token）属于配对问题，
 * 重连多少次都一样，所以直接停下，等用户在界面上重新配对。
 */
class SenderSession(
    private val host: String,
    private val port: Int,
    private val sid: String,
    private val cid: String,
    private val token: String,
    private val scope: CoroutineScope,
    private val onEvent: (seq: Int, payload: JSONObject) -> Unit,
    private val onState: (String) -> Unit
) {
    @Volatile private var socket: Socket? = null
    @Volatile private var out: BufferedOutputStream? = null
    private var job: Job? = null
    private val writeLock = Any()

    /** 会话是否还在跑（含正在退避等待重连）——上层据此判断要不要重建会话 */
    fun isRunning(): Boolean = job?.isActive == true

    fun start() {
        stop()
        job = scope.launch(Dispatchers.IO) {
            var backoff = 1000L          // 重连退避：1 秒起步，每失败一次翻倍
            while (isActive) {
                var rejected = false     // 握手被拒：配对问题，不重连
                try {
                    onState("connecting")
                    val s = Socket()
                    s.tcpNoDelay = true
                    s.connect(InetSocketAddress(host, port), 5000)
                    socket = s
                    val input = BufferedInputStream(s.getInputStream())
                    val output = BufferedOutputStream(s.getOutputStream())
                    out = output

                    val hello = JSONObject().apply {
                        put("type", "hello")
                        put("sid", sid)
                        put("cid", cid)
                        put("token", token)
                    }
                    synchronized(writeLock) { JsonFraming.write(output, hello) }

                    val ack = JsonFraming.read(input)
                    if (ack == null ||
                        ack.optString("type") != "hello_ack" ||
                        !ack.optBoolean("ok", false)) {
                        val err = ack?.optString("error") ?: "no_ack"
                        onState("rejected: $err")
                        rejected = true
                        runCatching { s.close() }
                    } else {
                        onState("connected")
                        backoff = 1000L   // 连上了：退避重置，下次断线仍从 1 秒起
                        while (isActive) {
                            val msg = JsonFraming.read(input) ?: break
                            when (msg.optString("type")) {
                                "event" -> {
                                    val seq = msg.optInt("seq", -1)
                                    val payload = msg.optJSONObject("payload") ?: JSONObject()
                                    if (seq >= 0) onEvent(seq, payload)
                                }
                                "ping" -> {
                                    val pong = JSONObject().apply {
                                        put("type", "pong")
                                        put("ts", System.currentTimeMillis() / 1000)
                                    }
                                    synchronized(writeLock) { JsonFraming.write(output, pong) }
                                }
                                "pong" -> { }
                            }
                        }
                        onState("disconnected")
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    onState("error: ${e.message}")
                } finally {
                    runCatching { socket?.close() }
                    socket = null
                    out = null
                }

                if (rejected) return@launch      // 配对不对：停下等用户处理

                // 退避等待后重连（stop() 取消 job 时 delay 会立刻中断）
                try { delay(backoff) } catch (e: CancellationException) { throw e }
                backoff = (backoff * 2).coerceAtMost(30_000L)
            }
        }
    }

    fun sendReply(seq: Int, payload: JSONObject) {
        val o = out ?: return
        val msg = JSONObject().apply {
            put("v", 1)
            put("type", "reply")
            put("seq", seq)
            put("payload", payload)
        }
        scope.launch(Dispatchers.IO) {
            runCatching { synchronized(writeLock) { JsonFraming.write(o, msg) } }
        }
    }

    fun stop() {
        job?.cancel(); job = null
        runCatching { socket?.close() }; socket = null
        out = null
    }
}
