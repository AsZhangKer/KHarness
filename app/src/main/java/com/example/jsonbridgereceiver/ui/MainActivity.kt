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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.example.jsonbridgereceiver.AppForeground
import com.example.jsonbridgereceiver.BridgeEngine
import com.example.jsonbridgereceiver.BridgeService
import com.example.jsonbridgereceiver.KeepAlive
import com.example.jsonbridgereceiver.LogBus
import com.example.jsonbridgereceiver.LogEntry
import com.example.jsonbridgereceiver.Notifier

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
            MaterialTheme(colorScheme = KhDarkScheme) {
                Surface(modifier = Modifier.fillMaxSize()) {
                    ReceiverScreen()
                }
            }
        }
    }

    /** 回前台：标记为可见，并撤掉通知栏里的提醒（人已经在看了） */
    override fun onStart() {
        super.onStart()
        AppForeground.onActivityStart()
        BridgeService.onAppForeground(this)
    }

    /** 切后台：标记不可见；若仍有未处理事件，此刻补弹提醒（前台时被有意压掉的那些） */
    override fun onStop() {
        AppForeground.onActivityStop()
        BridgeService.refreshAlertIfNeeded(this)
        super.onStop()
    }
}

/** KHarness 手机端深色主题：沉稳深灰底 + 青蓝主色，工具类观感 */
private val KhDarkScheme = darkColorScheme(
    primary = Color(0xFF4FC3F7),
    onPrimary = Color(0xFF00324A),
    primaryContainer = Color(0xFF004D68),
    onPrimaryContainer = Color(0xFFC4E7FF),
    secondary = Color(0xFF80DEEA),
    background = Color(0xFF121418),
    onBackground = Color(0xFFE3E6EA),
    surface = Color(0xFF1A1E23),
    onSurface = Color(0xFFE3E6EA),
    surfaceVariant = Color(0xFF2A2F36),
    onSurfaceVariant = Color(0xFFC2C7CE),
    error = Color(0xFFEF5350),
    onError = Color(0xFF3A0906)
)

// 状态语义色（不随主题变，保证「连 / 断 / 错」一眼可辨）
private val ColConnected = Color(0xFF66BB6A)
private val ColConnecting = Color(0xFF42A5F5)
private val ColIdle = Color(0xFF9E9E9E)
private val ColError = Color(0xFFEF5350)
private val ColWarn = Color(0xFFFFA726)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReceiverScreen() {
    val ctx = LocalContext.current
    val state by BridgeEngine.state.collectAsStateWithLifecycle()

    var answerText by remember { mutableStateOf("") }
    var lastError by remember { mutableStateOf<String?>(null) }
    var showLogs by remember { mutableStateOf(false) }
    var showKeepAlive by remember { mutableStateOf(false) }
    var menuOpen by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("KHarness 手机端", fontWeight = FontWeight.SemiBold) },
                actions = {
                    // 日志查看入口
                    IconButton(onClick = { showLogs = true }) {
                        Icon(Icons.AutoMirrored.Filled.List, contentDescription = "运行日志")
                    }
                    // 运维操作收进溢出菜单，保持主界面干净
                    Box {
                        IconButton(onClick = { menuOpen = true }) {
                            Icon(Icons.Filled.MoreVert, contentDescription = "更多")
                        }
                        DropdownMenu(
                            expanded = menuOpen,
                            onDismissRequest = { menuOpen = false }
                        ) {
                            DropdownMenuItem(
                                text = { Text("后台常驻设置") },
                                onClick = { showKeepAlive = true; menuOpen = false }
                            )
                            DropdownMenuItem(
                                text = { Text("启动服务") },
                                onClick = { BridgeService.start(ctx); menuOpen = false }
                            )
                            DropdownMenuItem(
                                text = { Text("停止服务") },
                                onClick = { BridgeService.stop(ctx); menuOpen = false }
                            )
                            DropdownMenuItem(
                                text = { Text("重置配对") },
                                onClick = {
                                    BridgeEngine.resetPairing(ctx)
                                    lastError = null
                                    menuOpen = false
                                }
                            )
                        }
                    }
                }
            )
        }
    ) { pad ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(pad)
                .padding(horizontal = 16.dp)
        ) {
            Spacer(Modifier.height(4.dp))
            StatusCard(status = state.status, host = state.host)
            Spacer(Modifier.height(12.dp))

            val p = state.pending
            if (p == null) {
                EmptyPendingHint()
            } else {
                PendingCard(
                    p = p,
                    answerText = answerText,
                    onAnswerChange = { answerText = it },
                    lastError = lastError,
                    onError = { lastError = it },
                    onApprove = { lastError = null; BridgeEngine.approve() },
                    onReject = { lastError = null; BridgeEngine.reject() },
                    onAnswer = { t -> lastError = null; BridgeEngine.answer(t); answerText = "" },
                    onCancel = { lastError = null; BridgeEngine.cancelQuestion() }
                )
            }

            Spacer(Modifier.height(12.dp))
            Text(
                "处理历史",
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(Modifier.height(6.dp))
            LazyColumn(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
            ) {
                items(state.events.reversed()) { text ->
                    HistoryRow(text)
                }
            }
        }
    }

    if (showLogs) {
        LogDialog(onDismiss = { showLogs = false })
    }

    if (showKeepAlive) {
        KeepAliveDialog(onDismiss = { showKeepAlive = false })
    }
}

/**
 * 后台常驻设置：电池优化白名单 + 厂商自启动管理入口。
 * 两者状态实时读取（用户从系统设置返回后会重新组合），避免显示过期状态。
 */
@Composable
private fun KeepAliveDialog(onDismiss: () -> Unit) {
    val ctx = LocalContext.current
    // 用 resume 计数器强制在从系统设置返回时重新读取状态
    var probe by remember { mutableIntStateOf(0) }
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) probe++
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    val batteryOk = remember(probe) { KeepAlive.isIgnoringBatteryOptimizations(ctx) }
    val notifOk = remember(probe) { Notifier.canPost(ctx) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("后台常驻设置") },
        text = {
            Column {
                Text(
                    "手机端需要在后台保持运行，才能及时收到电脑推来的审批与提问。",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Spacer(Modifier.height(14.dp))

                SettingRow(
                    title = "电池优化白名单",
                    desc = if (batteryOk) "已放行，不会被系统冻结" else "未放行，锁屏后可能收不到提醒",
                    ok = batteryOk,
                    actionText = if (batteryOk) null else "去设置",
                    onAction = { KeepAlive.requestIgnoreBatteryOptimizations(ctx) }
                )
                Spacer(Modifier.height(10.dp))
                SettingRow(
                    title = "通知权限",
                    desc = if (notifOk) "已开启，新事件会弹提醒" else "未开启，收不到新事件提醒",
                    ok = notifOk,
                    actionText = if (notifOk) null else "去开启",
                    onAction = { KeepAlive.openAppDetailSettings(ctx) }
                )
                Spacer(Modifier.height(10.dp))
                SettingRow(
                    title = "自启动管理",
                    desc = "部分手机需手动允许本应用自启动（开机后自动恢复监听）",
                    // 系统没有查询"是否已允许自启动"的 API，这里只能给入口、不能给状态，
                    // 故用中性图标 rather than 绿勾，避免让用户误以为已经开好了
                    ok = null,
                    actionText = "去设置",
                    onAction = { KeepAlive.openAutoStartSettings(ctx) }
                )

                Spacer(Modifier.height(14.dp))
                Text(
                    "提示：从最近任务里划掉本应用不影响后台监听。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text("完成") }
        }
    )
}

/** 一行设置项：状态图标 + 标题 + 说明 + 可选操作按钮。ok = null 表示该项无法探测状态，只给入口 */
@Composable
private fun SettingRow(
    title: String,
    desc: String,
    ok: Boolean?,
    actionText: String?,
    onAction: () -> Unit
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(
            when (ok) {
                true -> Icons.Filled.CheckCircle
                false -> Icons.Filled.Warning
                null -> Icons.Filled.Info
            },
            contentDescription = null,
            tint = when (ok) {
                true -> ColConnected
                false -> ColWarn
                null -> MaterialTheme.colorScheme.onSurfaceVariant
            },
            modifier = Modifier.size(20.dp)
        )
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            Text(
                desc,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        if (actionText != null) {
            Spacer(Modifier.width(8.dp))
            TextButton(onClick = onAction) { Text(actionText) }
        }
    }
}

/** 顶部连接状态卡：大图标 + 人话状态 + 副标题，替代原先裸露的技术字段 */
@Composable
private fun StatusCard(status: String, host: String?) {
    val (label, color, icon) = statusVisual(status)
    val subtitle = statusSubtitle(status, host)
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = color.copy(alpha = 0.12f))
    ) {
        Row(
            modifier = Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Surface(shape = CircleShape, color = color) {
                Icon(
                    imageVector = icon,
                    contentDescription = null,
                    tint = Color.White,
                    modifier = Modifier.padding(10.dp)
                )
            }
            Spacer(Modifier.width(14.dp))
            Column {
                Text(
                    label,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onSurface
                )
                if (subtitle != null) {
                    Text(
                        subtitle,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }
    }
}

/** 状态字 → (人话标签, 语义色, 图标)。status 字面量来自 SenderSession.onState */
private fun statusVisual(status: String): Triple<String, Color, ImageVector> = when {
    status == "connected" -> Triple("已连接", ColConnected, Icons.Filled.CheckCircle)
    status == "connecting" -> Triple("连接中…", ColConnecting, Icons.Filled.Refresh)
    status == "disconnected" -> Triple("连接已断开", ColIdle, Icons.Filled.Info)
    status.startsWith("rejected") -> Triple("配对被拒绝", ColError, Icons.Filled.Warning)
    status.startsWith("error") -> Triple("连接出错", ColError, Icons.Filled.Warning)
    status.startsWith("discovery") -> Triple("搜索异常", ColWarn, Icons.Filled.Warning)
    else -> Triple("未连接", ColIdle, Icons.Filled.Info)
}

/** 状态副标题：连接中给提示、已连接给主机、错误给原因 */
private fun statusSubtitle(status: String, host: String?): String? = when {
    status == "connected" -> host?.let { "电脑 $it" }
    status == "connecting" -> "正在同一 Wi-Fi 下查找电脑…"
    status.startsWith("rejected") ->
        status.removePrefix("rejected:").trim().ifBlank { "请在电脑端重新配对" }
    status.startsWith("error") -> status.removePrefix("error:").trim().ifBlank { null }
    status.startsWith("discovery") -> status.removePrefix("discovery:").trim().ifBlank { null }
    else -> null
}

@Composable
private fun EmptyPendingHint() {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant
        )
    ) {
        Row(
            modifier = Modifier.padding(16.dp).fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(
                Icons.Filled.Info,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(Modifier.width(12.dp))
            Text(
                "暂无待处理事件",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium
            )
        }
    }
}

/** 待处理事件卡：审批 / 提问分区视觉，交互逻辑与原版一致 */
@Composable
private fun PendingCard(
    p: BridgeEngine.Pending,
    answerText: String,
    onAnswerChange: (String) -> Unit,
    lastError: String?,
    onError: (String?) -> Unit,
    onApprove: () -> Unit,
    onReject: () -> Unit,
    onAnswer: (String) -> Unit,
    onCancel: () -> Unit
) {
    val isApproval = p.kind == "approval"
    val accent = if (isApproval) ColWarn else ColConnecting
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Surface(
                color = accent.copy(alpha = 0.18f),
                shape = RoundedCornerShape(6.dp)
            ) {
                Text(
                    if (isApproval) "审批" else "提问",
                    color = accent,
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp)
                )
            }
            Spacer(Modifier.height(8.dp))
            Text(
                p.title,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold
            )
            if (p.body.isNotBlank()) {
                Spacer(Modifier.height(6.dp))
                Text(
                    p.body,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Spacer(Modifier.height(12.dp))

            if (isApproval) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = onApprove, modifier = Modifier.weight(1f)) { Text("批准") }
                    OutlinedButton(onClick = onReject, modifier = Modifier.weight(1f)) { Text("拒绝") }
                }
            } else {
                p.options.forEach { opt ->
                    OutlinedButton(
                        onClick = { onAnswer(opt) },
                        modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp)
                    ) { Text(opt) }
                }
                OutlinedTextField(
                    value = answerText,
                    onValueChange = onAnswerChange,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
                    isError = lastError != null,
                    placeholder = { Text("输入自定义回答…") }
                )
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = {
                            if (answerText.isBlank()) {
                                onError("回答内容不能为空")
                            } else {
                                onAnswer(answerText.trim())
                            }
                        },
                        modifier = Modifier.weight(1f)
                    ) { Text("回答") }
                    OutlinedButton(onClick = onCancel, modifier = Modifier.weight(1f)) { Text("取消") }
                }
            }
            lastError?.let {
                Spacer(Modifier.height(6.dp))
                Text(
                    it,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall
                )
            }
        }
    }
}

@Composable
private fun HistoryRow(text: String) {
    Card(
        modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface
        )
    ) {
        Text(
            text,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

/** 运行日志查看入口：实时展示 LogBus 内存日志，支持清空 */
@Composable
private fun LogDialog(onDismiss: () -> Unit) {
    val logs by LogBus.logs.collectAsStateWithLifecycle()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("运行日志") },
        text = {
            if (logs.isEmpty()) {
                Text(
                    "暂无日志",
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            } else {
                LazyColumn(Modifier.heightIn(max = 420.dp)) {
                    items(logs.reversed()) { e -> LogRow(e) }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text("关闭") }
        },
        dismissButton = {
            TextButton(onClick = { LogBus.clear() }) { Text("清空") }
        }
    )
}

@Composable
private fun LogRow(e: LogEntry) {
    val lvColor = when (e.level) {
        "ERROR" -> ColError
        "WARN" -> ColWarn
        "EVENT" -> ColConnecting
        "REPLY" -> ColConnected
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Column(Modifier.padding(vertical = 5.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                e.time,
                fontFamily = FontFamily.Monospace,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(Modifier.width(6.dp))
            Surface(color = lvColor.copy(alpha = 0.18f), shape = RoundedCornerShape(4.dp)) {
                Text(
                    e.level,
                    color = lvColor,
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(horizontal = 5.dp, vertical = 1.dp)
                )
            }
            Spacer(Modifier.width(6.dp))
            Text(
                e.tag,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        Text(e.msg, style = MaterialTheme.typography.bodySmall)
    }
}
