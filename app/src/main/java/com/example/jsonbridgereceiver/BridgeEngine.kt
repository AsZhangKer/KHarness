package com.example.jsonbridgereceiver

import android.content.Context
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject

object BridgeEngine {
    private const val MULTICAST_GROUP = "239.255.42.99"
    private const val DISCOVERY_PORT = 37020
    private const val MAX_EVENTS = 50

    data class Event(val seq: Int, val text: String, val ts: Long)

    data class UiState(
        val status: String = "idle",
        val sid: String? = null,
        val host: String? = null,
        val cid: String = "",
        val events: List<Event> = emptyList()
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    private var scope: CoroutineScope? = null
    private var discovery: DiscoveryListener? = null
    private var session: SenderSession? = null
    private var appContext: Context? = null

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
        val text = payload.optString("text", payload.toString())
        val ev = Event(seq = seq, text = text, ts = System.currentTimeMillis())
        val list = (_state.value.events + ev).takeLast(MAX_EVENTS)
        _state.value = _state.value.copy(events = list)
    }

    fun sendReply(seq: Int, payload: JSONObject) {
        session?.sendReply(seq, payload)
    }

    @Synchronized
    fun stop() {
        discovery?.stop(); discovery = null
        session?.stop(); session = null
        scope?.cancel(); scope = null
        _state.value = UiState(cid = _state.value.cid)
    }

    fun resetPairing(ctx: Context) {
        session?.stop(); session = null
        AppIdentity.get(ctx).reset(ctx)
        val identity = AppIdentity.get(ctx)
        _state.value = UiState(status = "idle", cid = identity.cid)
    }
}