package com.example.jsonbridgereceiver

import kotlinx.coroutines.*
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.net.InetSocketAddress
import java.net.Socket

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

    fun start() {
        stop()
        job = scope.launch(Dispatchers.IO) {
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
                    runCatching { s.close() }
                    return@launch
                }

                onState("connected")

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
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                onState("error: ${e.message}")
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