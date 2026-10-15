package com.example.jsonbridgereceiver

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