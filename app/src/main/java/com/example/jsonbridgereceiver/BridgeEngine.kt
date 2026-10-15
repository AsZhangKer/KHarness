package com.example.jsonbridgereceiver

import android.content.Context
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject

/**
 * 桥引擎：接收 KHarness 推来的「审批 / ask_user 提问 / 继续」事件，手机端裁决后回执。
 * 协议与参考项目 JsonBridge 完全一致（发现广播 + TCP 帧 + 握手配对 + event/reply）。
 */
object BridgeEngine {
    private const val MULTICAST_GROUP = "239.255.42.99"
    private const val DISCOVERY_PORT = 37020
    private const val MAX_EVENTS = 50

    /** 一条待处理事件（审批或提问） */
    data class Pending(
        val seq: Int,
        val kind: String,        // "approval" | "question"
        val id: String,          // KHarness 侧的事件 id
        val title: String,       // 标题（工具名 / "提问"）
        val body: String,        // 正文（审批原因 / 问题）
        val options: List<String>, // 提问选项（审批为空）
        val chatId: Long?,
        val ts: Long
    )

    data class UiState(
        val status: String = "idle",
        val sid: String? = null,
        val host: String? = null,
        val cid: String = "",
        /** 当前待处理事件（队首） */
        val pending: Pending? = null,
        /** 历史事件（已处理） */
        val events: List<String> = emptyList()
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    private var scope: CoroutineScope? = null
    private var discovery: DiscoveryListener? = null
    private var session: SenderSession? = null
    private var appContext: Context? = null
    private val queue = ArrayDeque<Pending>()

    @Synchronized
    fun start(ctx: Context) {
        if (scope != null) return
        val app = ctx.applicationContext
        appContext = app

        val identity = AppIdentity.get(app)
        _state.value = _state.value.copy(cid = identity.cid)

        val s = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        scope = s

        discovery = DiscoveryListener(app, MULTICAST_GROUP, DISCOVERY_PORT).also {
            it.start(
                scope = s,
                onFound = { f -> onDiscovered(f) },
                onError = { msg -> _state.value = _state.value.copy(status = "discovery: $msg") }
            )
        }
    }

    private fun onDiscovered(found: DiscoveryListener.Found) {
        val app = appContext ?: return
        val s = scope ?: return
        val cur = _state.value

        val alreadyHere = cur.sid == found.sid && cur.host == found.host
        val busy = cur.status == "connecting" || cur.status == "connected"
        if (alreadyHere && busy) return

        session?.stop()

        val identity = AppIdentity.get(app)
        val sess = SenderSession(
            host = found.host,
            port = found.tcpPort,
            sid = found.sid,
            cid = identity.cid,
            token = identity.token,
            scope = s,
            onEvent = { seq, payload -> onEvent(seq, payload) },
            onState = { st -> _state.value = _state.value.copy(status = st) }
        )
        session = sess
        _state.value = _state.value.copy(
            status = "connecting",
            sid = found.sid,
            host = found.host
        )
        sess.start()
    }

    private fun onEvent(seq: Int, payload: JSONObject) {
        val kind = payload.optString("kind", "unknown")
        if (kind != "approval" && kind != "question") {
            // 未知类型：记历史但不进队列
            appendHistory("未知事件 seq=$seq")
            return
        }
        val id = payload.optString("id", "")
        val title = when (kind) {
            "approval" -> "审批 · ${payload.optString("tool", "")}"
            else -> "AI 提问"
        }
        val body = when (kind) {
            "approval" -> payload.optString("reason", payload.optString("tool", ""))
            else -> payload.optString("question", "")
        }
        val options = mutableListOf<String>()
        val opts = payload.optJSONArray("options")
        if (opts != null) {
            for (i in 0 until opts.length()) options.add(opts.optString(i))
        }
        val chatId = if (payload.has("chat_id")) payload.optLong("chat_id") else null
        val item = Pending(
            seq = seq, kind = kind, id = id, title = title, body = body,
            options = options, chatId = chatId, ts = System.currentTimeMillis()
        )
        // 审批/提问入队，队首显示
        queue.addLast(item)
        if (_state.value.pending == null) _state.value = _state.value.copy(pending = queue.firstOrNull())
    }

    /** 批准（审批） */
    fun approve() {
        val p = _state.value.pending ?: return
        sendReply(p, JSONObject().put("ok", true))
        dismissPending(p)
    }

    /** 拒绝（审批） */
    fun reject() {
        val p = _state.value.pending ?: return
        sendReply(p, JSONObject().put("ok", false))
        dismissPending(p)
    }

    /** 回答提问（选选项或输入文字） */
    fun answer(text: String) {
        val p = _state.value.pending ?: return
        if (p.kind != "question") return
        sendReply(p, JSONObject().put("answered", true).put("answer", text))
        dismissPending(p)
    }

    /** 取消提问 */
    fun cancelQuestion() {
        val p = _state.value.pending ?: return
        if (p.kind != "question") return
        sendReply(p, JSONObject().put("cancel", true))
        dismissPending(p)
    }

    private fun dismissPending(p: Pending) {
        queue.removeAll { it.seq == p.seq }
        appendHistory("${if (p.kind == "approval") "审批" else "提问"}已处理：${p.title}")
        _state.value = _state.value.copy(pending = queue.firstOrNull())
    }

    private fun appendHistory(text: String) {
        val list = (_state.value.events + text).takeLast(MAX_EVENTS)
        _state.value = _state.value.copy(events = list)
    }

    private fun sendReply(p: Pending, payload: JSONObject) {
        session?.sendReply(p.seq, payload)
    }

    @Synchronized
    fun stop() {
        discovery?.stop(); discovery = null
        session?.stop(); session = null
        scope?.cancel(); scope = null
        queue.clear()
        _state.value = UiState(cid = _state.value.cid)
    }

    fun resetPairing(ctx: Context) {
        session?.stop(); session = null
        AppIdentity.get(ctx).reset(ctx)
        val identity = AppIdentity.get(ctx)
        _state.value = UiState(status = "idle", cid = identity.cid)
    }
}