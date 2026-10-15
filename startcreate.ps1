$ErrorActionPreference = 'Stop'

$root = Join-Path $PSScriptRoot 'app\src\main\java\com\example\jsonbridgereceiver'
$pkg  = 'com.example.jsonbridgereceiver'

if (-not (Test-Path $root)) {
    Write-Host "[错误] 目录不存在: $root" -ForegroundColor Red
    Write-Host "请确认 Android Studio 项目路径。"
    Read-Host "按回车退出"
    exit 1
}

$uiDir = Join-Path $root 'ui'
if (-not (Test-Path $uiDir)) { New-Item -ItemType Directory -Path $uiDir | Out-Null }

function Write-Kt($name, $content) {
    $path = Join-Path $root $name
    $content = $content.Replace('__PKG__', $pkg)
    # UTF-8 without BOM
    [System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host ("written: {0}" -f $path) -ForegroundColor Green
}

# ---------------- AppIdentity.kt ----------------
Write-Kt 'AppIdentity.kt' @'
package __PKG__

import android.content.Context
import java.util.UUID

class AppIdentity private constructor(
    val cid: String,
    val token: String
) {
    companion object {
        private const val PREF = "jsonbridge_identity"
        private const val KEY_CID = "cid"
        private const val KEY_TOKEN = "token"

        @Volatile private var instance: AppIdentity? = null

        fun get(context: Context): AppIdentity {
            instance?.let { return it }
            synchronized(this) {
                instance?.let { return it }
                val sp = context.applicationContext
                    .getSharedPreferences(PREF, Context.MODE_PRIVATE)

                var cid = sp.getString(KEY_CID, null)
                var token = sp.getString(KEY_TOKEN, null)
                if (cid == null || token == null) {
                    cid = UUID.randomUUID().toString()
                    token = UUID.randomUUID().toString()
                    sp.edit().putString(KEY_CID, cid).putString(KEY_TOKEN, token).apply()
                }
                val id = AppIdentity(cid, token)
                instance = id
                return id
            }
        }
    }

    fun reset(context: Context) {
        synchronized(this) {
            instance = null
            context.applicationContext
                .getSharedPreferences(PREF, Context.MODE_PRIVATE)
                .edit().clear().apply()
        }
    }
}
'@

# ---------------- JsonFraming.kt ----------------
Write-Kt 'JsonFraming.kt' @'
package __PKG__

import org.json.JSONObject
import java.io.InputStream
import java.io.OutputStream

object JsonFraming {
    private const val MAX_FRAME = 8 * 1024 * 1024

    fun write(out: OutputStream, json: JSONObject) {
        val bytes = json.toString().toByteArray(Charsets.UTF_8)
        require(bytes.size in 1..MAX_FRAME) { "frame too large: ${bytes.size}" }
        val header = byteArrayOf(
            (bytes.size ushr 24).toByte(),
            (bytes.size ushr 16).toByte(),
            (bytes.size ushr 8).toByte(),
            bytes.size.toByte()
        )
        out.write(header)
        out.write(bytes)
        out.flush()
    }

    fun read(input: InputStream): JSONObject? {
        val header = ByteArray(4)
        if (!readExact(input, header)) return null
        val len = ((header[0].toInt() and 0xFF) shl 24) or
                  ((header[1].toInt() and 0xFF) shl 16) or
                  ((header[2].toInt() and 0xFF) shl 8) or
                  (header[3].toInt() and 0xFF)
        require(len in 1..MAX_FRAME) { "invalid frame length: $len" }
        val body = ByteArray(len)
        if (!readExact(input, body)) return null
        return JSONObject(String(body, Charsets.UTF_8))
    }

    private fun readExact(input: InputStream, buf: ByteArray): Boolean {
        var off = 0
        while (off < buf.size) {
            val n = input.read(buf, off, buf.size - off)
            if (n <= 0) return false
            off += n
        }
        return true
    }
}
'@

# ---------------- DiscoveryListener.kt ----------------
Write-Kt 'DiscoveryListener.kt' @'
package __PKG__

import android.content.Context
import android.net.wifi.WifiManager
import kotlinx.coroutines.*
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.InetAddress
import java.net.MulticastSocket
import java.net.NetworkInterface

class DiscoveryListener(
    private val context: Context,
    private val group: String,
    private val port: Int
) {
    data class Found(
        val sid: String,
        val name: String,
        val host: String,
        val tcpPort: Int
    )

    private var job: Job? = null
    private var socket: MulticastSocket? = null
    private var lock: WifiManager.MulticastLock? = null

    fun start(
        scope: CoroutineScope,
        onFound: (Found) -> Unit,
        onError: (String) -> Unit
    ) {
        stop()
        job = scope.launch(Dispatchers.IO) {
            try {
                val wifi = context.applicationContext
                    .getSystemService(Context.WIFI_SERVICE) as WifiManager
                lock = wifi.createMulticastLock("jsonbridge-mc").apply {
                    setReferenceCounted(false)
                    acquire()
                }

                val groupAddr = InetAddress.getByName(group)
                val ms = MulticastSocket(port)
                ms.reuseAddress = true
                pickWifiInterface()?.let { ms.networkInterface = it }
                ms.joinGroup(groupAddr)
                socket = ms

                val buf = ByteArray(4096)
                while (isActive) {
                    val pkt = DatagramPacket(buf, buf.size)
                    try {
                        ms.receive(pkt)
                    } catch (e: Exception) {
                        if (!isActive) break
                        onError("recv: ${e.message}")
                        continue
                    }
                    val text = String(pkt.data, 0, pkt.length, Charsets.UTF_8)
                    val obj = runCatching { JSONObject(text) }.getOrNull() ?: continue
                    if (obj.optString("magic") != "JSONBRIDGE/1") continue
                    if (obj.optString("role") != "win-controller") continue
                    val sid = obj.optString("sid")
                    val tcpPort = obj.optInt("tcp_port", 0)
                    if (sid.isEmpty() || tcpPort <= 0) continue
                    val host = pkt.address?.hostAddress ?: continue
                    onFound(Found(sid, obj.optString("name"), host, tcpPort))
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                onError("discovery: ${e.message}")
            }
        }
    }

    private fun pickWifiInterface(): NetworkInterface? {
        val ifaces = NetworkInterface.getNetworkInterfaces() ?: return null
        var fallback: NetworkInterface? = null
        while (ifaces.hasMoreElements()) {
            val ni = ifaces.nextElement()
            if (!ni.isUp || ni.isLoopback) continue
            val n = ni.name.lowercase()
            if (n.contains("wlan") || n.contains("wifi")) return ni
            if (fallback == null) fallback = ni
        }
        return fallback
    }

    fun stop() {
        job?.cancel(); job = null
        runCatching { socket?.close() }; socket = null
        runCatching { lock?.release() }; lock = null
    }
}
'@

# ---------------- SenderSession.kt ----------------
Write-Kt 'SenderSession.kt' @'
package __PKG__

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
'@

# ---------------- BridgeEngine.kt ----------------
Write-Kt 'BridgeEngine.kt' @'
package __PKG__

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
'@

# ---------------- BridgeService.kt ----------------
Write-Kt 'BridgeService.kt' @'
package __PKG__

import android.app.*
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.example.jsonbridgereceiver.ui.MainActivity
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collectLatest

class BridgeService : Service() {

    companion object {
        private const val CHANNEL_ID = "jsonbridge"
        private const val NOTIF_ID = 1001

        fun start(ctx: Context) {
            val i = Intent(ctx, BridgeService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(i)
            } else {
                ctx.startService(i)
            }
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, BridgeService::class.java))
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var collectJob: Job? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIF_ID, buildNotification("正在运行"))
        BridgeEngine.start(applicationContext)

        if (collectJob == null) {
            collectJob = scope.launch {
                BridgeEngine.state.collectLatest { s ->
                    val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
                    nm.notify(NOTIF_ID, buildNotification(statusText(s.status, s.host)))
                }
            }
        }
        return START_STICKY
    }

    private fun statusText(status: String, host: String?): String = when {
        status == "connected" -> "已连接 $host"
        status == "connecting" -> "连接中…"
        status.startsWith("rejected") -> "被拒绝: $status"
        status.startsWith("error") -> "错误: $status"
        else -> status
    }

    override fun onDestroy() {
        collectJob?.cancel()
        scope.cancel()
        BridgeEngine.stop()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(
                CHANNEL_ID,
                "JsonBridge",
                NotificationManager.IMPORTANCE_LOW
            )
            val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(ch)
        }
    }

    private fun buildNotification(text: String): Notification {
        val pi = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("JsonBridge 接收端")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setOngoing(true)
            .setContentIntent(pi)
            .build()
    }
}
'@

# ---------------- ui/MainActivity.kt ----------------
$mainActivityPath = Join-Path $uiDir 'MainActivity.kt'
$mainContent = @'
package __PKG__.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import __PKG__.BridgeEngine
import __PKG__.BridgeService
import org.json.JSONObject

class MainActivity : ComponentActivity() {

    private val requestNotif = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(
                    this, Manifest.permission.POST_NOTIFICATIONS
                ) != PackageManager.PERMISSION_GRANTED
            ) {
                requestNotif.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }

        BridgeService.start(this)

        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    ReceiverScreen()
                }
            }
        }
    }
}

@Composable
fun ReceiverScreen() {
    val ctx = LocalContext.current
    val state by BridgeEngine.state.collectAsStateWithLifecycle()

    var inputText by remember {
        mutableStateOf("""{"ok":true,"choice":"continue"}""")
    }
    var lastError by remember { mutableStateOf<String?>(null) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp)
    ) {
        Text("JsonBridge 接收端", style = MaterialTheme.typography.titleLarge)
        Spacer(Modifier.height(8.dp))

        Text("状态 : ${state.status}")
        Text("对端 : ${state.sid ?: "-"}")
        Text("地址 : ${state.host ?: "-"}")
        Text("CID  : ${state.cid}", fontFamily = FontFamily.Monospace)

        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { BridgeService.start(ctx) }) { Text("启动服务") }
            OutlinedButton(onClick = {
                BridgeEngine.resetPairing(ctx)
                lastError = null
            }) { Text("重置配对") }
            OutlinedButton(onClick = { BridgeService.stop(ctx) }) { Text("停止服务") }
        }

        Spacer(Modifier.height(12.dp))
        Text("事件历史", style = MaterialTheme.typography.titleMedium)
        LazyColumn(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
        ) {
            items(state.events.reversed()) { ev ->
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 4.dp)
                ) {
                    Column(Modifier.padding(12.dp)) {
                        Text("seq=${ev.seq}", style = MaterialTheme.typography.labelSmall)
                        Text(ev.text)
                    }
                }
            }
        }

        Spacer(Modifier.height(8.dp))
        Text("回复内容 (JSON)", style = MaterialTheme.typography.titleMedium)
        OutlinedTextField(
            value = inputText,
            onValueChange = { inputText = it },
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 96.dp),
            isError = lastError != null
        )
        lastError?.let {
            Text(it, color = MaterialTheme.colorScheme.error)
        }
        Spacer(Modifier.height(8.dp))
        Button(
            onClick = {
                val last = state.events.lastOrNull()
                if (last == null) {
                    lastError = "还没有收到任何事件"
                    return@Button
                }
                val payload = runCatching { JSONObject(inputText) }.getOrNull()
                if (payload == null) {
                    lastError = "不是合法 JSON"
                    return@Button
                }
                lastError = null
                BridgeEngine.sendReply(last.seq, payload)
            },
            modifier = Modifier.fillMaxWidth()
        ) { Text("发送回复到最后一条事件") }
    }
}
'@.Replace('__PKG__', $pkg)

[System.IO.File]::WriteAllText($mainActivityPath, $mainContent, (New-Object System.Text.UTF8Encoding($false)))
Write-Host ("written: {0}" -f $mainActivityPath) -ForegroundColor Green

Write-Host ""
Write-Host "全部完成。打开 Android Studio，等 Gradle Sync，然后 Run。" -ForegroundColor Cyan
Read-Host "按回车退出"