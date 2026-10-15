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
import androidx.compose.ui.Alignment
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

    var answerText by remember { mutableStateOf("") }
    var lastError by remember { mutableStateOf<String?>(null) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp)
    ) {
        Text("KHarness 手机端", style = MaterialTheme.typography.titleLarge)
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

        // 当前待处理事件
        val p = state.pending
        if (p == null) {
            Text("没有待处理事件", style = MaterialTheme.typography.titleMedium)
        } else {
            Card(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 4.dp)
            ) {
                Column(Modifier.padding(12.dp)) {
                    Text(p.title, style = MaterialTheme.typography.titleMedium)
                    Spacer(Modifier.height(6.dp))
                    Text(p.body)
                    Spacer(Modifier.height(10.dp))

                    when (p.kind) {
                        "approval" -> {
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Button(
                                    onClick = {
                                        lastError = null
                                        BridgeEngine.approve()
                                    },
                                    modifier = Modifier.weight(1f)
                                ) { Text("批准") }
                                OutlinedButton(
                                    onClick = {
                                        lastError = null
                                        BridgeEngine.reject()
                                    },
                                    modifier = Modifier.weight(1f)
                                ) { Text("拒绝") }
                            }
                        }
                        "question" -> {
                            // 选项按钮
                            p.options.forEach { opt ->
                                OutlinedButton(
                                    onClick = {
                                        lastError = null
                                        BridgeEngine.answer(opt)
                                    },
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(vertical = 2.dp)
                                ) { Text(opt) }
                            }
                            // 自定义回答
                            OutlinedTextField(
                                value = answerText,
                                onValueChange = { answerText = it },
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .heightIn(min = 56.dp),
                                isError = lastError != null,
                                placeholder = { Text("输入自定义回答…") }
                            )
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Button(
                                    onClick = {
                                        if (answerText.isBlank()) {
                                            lastError = "回答内容不能为空"
                                            return@Button
                                        }
                                        lastError = null
                                        BridgeEngine.answer(answerText.trim())
                                        answerText = ""
                                    },
                                    modifier = Modifier.weight(1f)
                                ) { Text("回答") }
                                OutlinedButton(
                                    onClick = {
                                        lastError = null
                                        BridgeEngine.cancelQuestion()
                                    },
                                    modifier = Modifier.weight(1f)
                                ) { Text("取消") }
                            }
                        }
                    }
                    lastError?.let {
                        Spacer(Modifier.height(4.dp))
                        Text(it, color = MaterialTheme.colorScheme.error)
                    }
                }
            }
        }

        Spacer(Modifier.height(12.dp))
        Text("处理历史", style = MaterialTheme.typography.titleMedium)
        LazyColumn(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
        ) {
            items(state.events.reversed()) { text ->
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 2.dp)
                ) {
                    Text(text, Modifier.padding(10.dp))
                }
            }
        }
    }
}