package com.example.jsonbridgereceiver.ui

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
import com.example.jsonbridgereceiver.BridgeEngine
import com.example.jsonbridgereceiver.BridgeService
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