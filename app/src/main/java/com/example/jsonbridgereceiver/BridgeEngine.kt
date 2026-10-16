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
        /** 当前待处理事件（队首，即界面上正在显示的那条） */
        val pending: Pending? = null,
        /** 待处理事件总数（用于通知里的"共 N 条"） */
        val queued: Int = 0,
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

    // 「发现电脑」日志节流：组播每秒一条，避免把有效日志刷掉
    @Volatile
    private var lastDiscoveryKey: String? = null

    @Volatile
    private var lastDiscoveryLogTs: Long = 0L

    @Synchronized
    fun start(ctx: Context) {
        if (scope != null) return
        val app = ctx.applicationContext
        appContext = app

        val identity = AppIdentity.get(app)
        _state.value = _state.value.copy(cid = identity.cid)
        LogBus.i("engine", "服务启动，cid=${identity.cid.take(8)}…")

        val s = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        scope = s

        discovery = DiscoveryListener(app, MULTICAST_GROUP, DISCOVERY_PORT).also {
            it.start(
                scope = s,
                onFound = { f -> onDiscovered(f) },
                onError = { msg -> _state.value = _state.value.copy(status = "discovery: $msg") }
            )
        }

        // 先用上次记住的电脑直连一次：手机在后台时组播包常被系统丢掉，
        // 只靠发现广播会出现「服务活着却一直连不上」，事件就在空窗里被后端丢弃。
        LastPeer.load(app)?.let { p ->
            LogBus.i("engine", "直连上次的电脑 ${p.host}:${p.port}")
            connectTo(p.host, p.port, p.sid, p.name)
        }
    }

    private fun onDiscovered(found: DiscoveryListener.Found) {
        val app = appContext ?: return
        val cur = _state.value

        // 同一台电脑、且会话仍在跑（含正在退避重连）→ 不重建，避免和内部自动重连打架。
        // 只有目标变了、或会话已停（如握手被拒）才重建。
        val sameTarget = cur.sid == found.sid && cur.host == found.host
        if (sameTarget && session?.isRunning() == true) return

        // 目标变化时立即记一条；同一目标的重试每 10 秒最多记一条（防重连风暴刷屏）
        val key = "${found.sid}@${found.host}"
        val now = System.currentTimeMillis()
        if (key != lastDiscoveryKey || now - lastDiscoveryLogTs > 10_000L) {
            LogBus.i("engine", "发现电脑「${found.name}」@ ${found.host}:${found.tcpPort}")
            lastDiscoveryKey = key
            lastDiscoveryLogTs = now
        }

        LastPeer.save(app, LastPeer.Peer(found.host, found.tcpPort, found.sid, found.name))
        connectTo(found.host, found.tcpPort, found.sid, found.name)
    }

    /** 建立（或切换）到指定电脑的会话；旧会话先停掉 */
    private fun connectTo(host: String, port: Int, sid: String, name: String) {
        val app = appContext ?: return
        val s = scope ?: return
        session?.stop()
        val identity = AppIdentity.get(app)
        val sess = SenderSession(
            host = host,
            port = port,
            sid = sid,
            cid = identity.cid,
            token = identity.token,
            scope = s,
            onEvent = { seq, payload -> onEvent(seq, payload) },
            onState = { st ->
                // 状态变化记录（退避重连期间连接/断开会来回切，属正常）
                LogBus.i("session", "连接状态 → $st")
                _state.value = _state.value.copy(status = st)
            }
        )
        session = sess
        _state.value = _state.value.copy(status = "connecting", sid = sid, host = host)
        sess.start()
    }

    private fun onEvent(seq: Int, payload: JSONObject) {
        val kind = payload.optString("kind", "unknown")
        LogBus.i("engine", "收到事件 seq=$seq kind=$kind")
        if (kind != "approval" && kind != "question") {
            // 未知类型：记历史但不进队列
            LogBus.w("engine", "未知事件类型 kind=$kind，已忽略")
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
        _state.value = _state.value.copy(
            pending = queue.firstOrNull(),
            queued = queue.size
        )
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
        _state.value = _state.value.copy(
            pending = queue.firstOrNull(),
            queued = queue.size
        )
    }

    private fun appendHistory(text: String) {
        val list = (_state.value.events + text).takeLast(MAX_EVENTS)
        _state.value = _state.value.copy(events = list)
    }

    private fun sendReply(p: Pending, payload: JSONObject) {
        // 摘要：批准 / 拒绝 / 回答内容 / 取消
        val brief = when {
            payload.has("ok") -> if (payload.optBoolean("ok")) "批准" else "拒绝"
            payload.has("answer") -> "回答: ${payload.optString("answer")}"
            payload.has("cancel") -> "取消"
            else -> "回执"
        }
        LogBus.i("engine", "发送回执 seq=${p.seq} · $brief")
        session?.sendReply(p.seq, payload)
    }

    @Synchronized
    fun stop() {
        discovery?.stop(); discovery = null
        session?.stop(); session = null
        scope?.cancel(); scope = null
        queue.clear()
        LogBus.i("engine", "服务停止")
        _state.value = UiState(cid = _state.value.cid)
    }

    fun resetPairing(ctx: Context) {
        session?.stop(); session = null
        LogBus.w("engine", "重置配对，cid / token 将重新生成")
        AppIdentity.get(ctx).reset(ctx)
        LastPeer.clear(ctx)     // 连记住的电脑也一起忘掉，重新走一次发现
        val identity = AppIdentity.get(ctx)
        _state.value = UiState(status = "idle", cid = identity.cid)
    }
}