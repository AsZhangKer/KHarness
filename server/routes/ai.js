const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { exec, execFile } = require('child_process');
const multer = require('multer');
const { fetch, ProxyAgent } = require('undici');
const { db } = require('../database');
const { ok, fail, failErr, wrap } = require('../utils/respond');
const { sanitizeText } = require('../utils/sanitize');
const undoStore = require('../utils/undo');
const perms = require('../utils/permissions');
const thinking = require('../utils/thinking');
const texttool = require('../utils/texttool');
const recycle = require('../utils/recycle');
const trashStore = require('../utils/trash');   // 会话/项目回收站：删除前快照，恢复时按快照插回去
const remoteUtil = require('../utils/remote');   // SSH/SFTP 通道：远程项目/会话的目录校验与工具分叉
const remoteexec = require('../utils/remoteexec'); // 远程会话下接管命令与文件类工具的执行层
const notifier = require('../utils/notify');
const userdir = require('../utils/userdir');   // 当前用户的桌面（自由会话默认工作目录）
const { TOOL_SCHEMAS, resolveToolName } = require('../utils/schemas');
require('../utils/apitools');   // 副作用注册：桌面《API文档》整理出的外部接口工具
require('../utils/extools');    // 副作用注册：后台任务 / 长期记忆 / ask_user / 子智能体
require('../utils/inapp');      // 副作用注册：内置浏览器（动作实际在桌面窗口里执行）
const subagent = require('../utils/subagent');
const orchestrator = require('../utils/orchestrator');   // 托管模式：监工 ⇄ 工作者
const sidebar = require('../utils/sidebar');
const supervisor = require('../utils/supervisor');
const mcp = require('../utils/mcp');
const toolgate = require('../utils/toolgate');
const procguard = require('../utils/procguard');
const { buildShell } = require('../utils/shellcmd');
const protocols = require('../utils/protocols');

const router = express.Router();

// 对话活跃时间更新（模块级，供多处使用）
const touchChatStmt = db.prepare('UPDATE ai_chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?');

// ---------- 常量 ----------
const TEST_MESSAGE = '测试可用性，可用则回复"pass"，不需要其他多余文本。';
const TEST_TIMEOUT_MS = 30 * 1000;
const TEST_CONCURRENCY = 5;      // 同时测试的模型数上限
const REPLY_MAX_LEN = 2000;
const ERROR_MAX_LEN = 500;
/**
 * 把上游 fetch 的失败说清楚。Node 的 fetch 只会抛一句干巴巴的 "fetch failed"，
 * 真正的原因在 e.cause 里（UND_ERR_SOCKET / UND_ERR_BODY_TIMEOUT / ECONNRESET / ENOTFOUND /
 * 证书错误……），有时还嵌套两三层。以前只取 e.message，用户看到的就是「流式输出中断：fetch failed」
 * 且无处可查 —— 这里把 cause 链拼进消息，同时用 console.error 打一份到服务端日志
 * （装机版会落进 %APPDATA%\KHarness\desktop.log，出问题能事后翻）。
 */
function errDetail(e) {
  if (!e) return String(e);
  const bits = [];
  const push = (s) => { const v = String(s || '').trim(); if (v && !bits.includes(v)) bits.push(v); };
  if (e.code && !(e.cause && e.cause.code === e.code)) push(e.code);
  push(e.name && e.name !== 'Error' ? `${e.name}: ${e.message}` : (e.message || String(e)));
  let c = e.cause;
  for (let depth = 0; c && depth < 3; depth++, c = c.cause) {
    push([c.code, c.errno, c.syscall, c.message].filter(Boolean).join(' '));
  }
  return bits.join('｜').substring(0, 600);
}
/**
 * 上游返回的错误正文往往是一整坨 JSON / 多行 HTML。直接塞进 note 会把提示刷成屏霸，
 * 又完全看不见重点。这里压成一行（换行→空格）再截断，细节全量仍写进服务端日志。
 */
function oneLine(text, max = 200) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().substring(0, max);
}
const CHAT_TIMEOUT_MS = 120 * 1000;
const APP_ROOT = path.join(__dirname, '..', '..');           // 程序根目录（应用自己的东西写在这下面）
// 自由会话（没挂项目、也不是远程）的默认工作目录 = 当前用户的桌面。
// 以前这里用程序根，等于让 AI 默认在装机目录 / 仓库目录里写文件，是意外行为不是设计。
const AGENT_DEFAULT_CWD = userdir.desktop();
const RATE_LIMIT_RETRY = 2;      // 上游 429 自动重试次数
// Agent 主循环步数上限（防模型无进展地反复调工具烧 token）；单轮内多个并行调用不计为额外步
const AGENT_MAX_STEPS = parseInt(process.env.AGENT_MAX_STEPS || '60');
// 工具执行超时：run_command 单次命令默认 360 秒（设置项 cmd_timeout_seconds，0 = 不限制），
// 超时后杀整棵进程树并回喂「部分输出 + 改用 run_background」的建议；用户也可点「超时」按钮提前判定。
const DEFAULT_CMD_TIMEOUT_SECONDS = 360;

// 撤销快照落盘目录：<数据目录>/.kh-undo/（重启后历史步骤仍可撤销）
// 以前落在程序根目录 —— 装机版装进 Program Files 时那里只读，写不进去就等于「任何删除都可撤销」
// 这条承诺静默失效。第二个参数是老位置：只用来读/删已有快照，不做迁移（下次存自然进新目录）。
// 注意不是 AGENT_DEFAULT_CWD —— 后者现在是用户桌面，快照不该散到桌面上去。
undoStore.init(path.join(require('../config').DATA_DIR, '.kh-undo'), path.join(APP_ROOT, '.kh-undo'));
setImmediate(() => { try { undoStore.sweepOrphans(); } catch (e) { /* 清理失败不影响启动 */ } });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- 平台 / Shell ----------
const os = require('os');
const IS_WIN = process.platform === 'win32';

// 当前 Agent Shell（settings 表 agent_shell；空 = 系统默认）
function getShellSetting() {
  return (db.prepare("SELECT value FROM settings WHERE key = 'agent_shell'").get()?.value || '').trim();
}

// settings 表里读一个数（压缩保留条数、审批等待时长这些都在那儿），带上下限防手滑
function numSetting(key, def, min, max) {
  let raw;
  try { raw = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value; } catch (e) { return def; }
  const n = parseInt(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// ---------- 编码自适配（中文环境核心修复） ----------
// Windows 中文系统下：cmd/PowerShell 控制台输出为 GBK(cp936)，而文件多为 UTF-8 或 ANSI(GBK)。
// Node 默认按 UTF-8 解码，GBK 字节流被错误解码成乱码。规则：
// 1) BOM 优先（UTF-8 / UTF-16LE / UTF-16BE）；2) 严格 UTF-8 解码失败 → 回退 GBK；3) 都失败 → 宽松 UTF-8
function makeDecoder(label, opts) { try { return new TextDecoder(label, opts); } catch (e) { return null; } }
const DEC_UTF8_STRICT = makeDecoder('utf-8', { fatal: true });
const DEC_UTF8 = makeDecoder('utf-8');
const DEC_UTF16LE = makeDecoder('utf-16le');
const DEC_UTF16BE = makeDecoder('utf-16be');
const DEC_GBK = makeDecoder('gbk');

function decodeTextSmart(buf) {
  const u8 = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) {
    return DEC_UTF8 ? DEC_UTF8.decode(u8.subarray(3)) : u8.toString('utf8').replace(/^\uFEFF/, '');
  }
  if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe && DEC_UTF16LE) return DEC_UTF16LE.decode(u8.subarray(2));
  if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff && DEC_UTF16BE) return DEC_UTF16BE.decode(u8.subarray(2));
  if (DEC_UTF8_STRICT) {
    try { return DEC_UTF8_STRICT.decode(u8); } catch (e) { /* 非 UTF-8，走 GBK 回退 */ }
  } else if (DEC_UTF8) {
    return DEC_UTF8.decode(u8);
  }
  if (DEC_GBK) {
    try { return DEC_GBK.decode(u8); } catch (e) { /* GBK 也不行，最后兜底 */ }
  }
  return u8.toString('utf8');
}

// 命令行输出解码：与文件解码同一套规则（控制台代码页 GBK ↔ UTF-8 自适配）
function decodeConsoleOutput(buf) {
  return decodeTextSmart(buf);
}

// 首次启动探测：返回平台候选 shell 列表（前端弹窗用；missing 标记本机未检测到）
router.get('/shell', wrap(async (req, res) => {
  const current = getShellSetting();
  let candidates;
  if (IS_WIN) {
    const winCandidates = [
      { value: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', label: 'PowerShell 5（系统自带）' },
      { value: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', label: 'PowerShell 7（推荐）' },
      { value: 'C:\\Windows\\System32\\cmd.exe', label: 'CMD（传统）' },
      { value: 'C:\\Windows\\System32\\bash.exe', label: 'WSL Bash' },
      { value: 'C:\\Program Files\\Git\\bin\\bash.exe', label: 'Git Bash' }
    ];
    candidates = winCandidates.map(c => ({ ...c, missing: !fs.existsSync(c.value) }));
  } else {
    candidates = [
      { value: '/bin/bash', label: 'bash（推荐）' },
      { value: '/bin/zsh', label: 'zsh' },
      { value: '/bin/sh', label: 'sh（POSIX）' }
    ].map(c => ({ ...c, missing: !fs.existsSync(c.value) }));
  }
  ok(res, { platform: process.platform, current, candidates, is_set: !!current });
}));

router.put('/shell', wrap(async (req, res) => {
  const shell = String(req.body?.shell || '').trim();
  if (shell.length > 260) return fail(res, 400, 'Shell 路径过长');
  if (shell) {
    // 校验可执行文件存在（Windows 允许仅文件名，交给 PATH 解析）
    if (shell.includes('/') || shell.includes('\\')) {
      try { fs.accessSync(shell, fs.constants.X_OK); } catch (e) { return fail(res, 400, `Shell 不可执行或不存在：${shell}`); }
    }
  }
  db.prepare("INSERT INTO settings (key, value) VALUES ('agent_shell', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP").run(shell);
  ok(res, { shell }, shell ? `默认 Shell 已设为 ${shell}` : '已恢复系统默认 Shell');
}));

// 按所选 Shell 的调用格式执行命令（Shell 拼参与 run_background 共用 shellcmd，避免两条路径分叉）。
// holder：{ child, pid, manualTimeout } —— 供「停止」与「超时」按钮从请求作用域拿到正在跑的子进程。
// timeoutMs>0 时到点杀整棵进程树（procguard 只允许杀本服务登记过的 PID），并把已收集输出回喂模型。
function getCmdTimeoutMs() {
  const raw = db.prepare("SELECT value FROM settings WHERE key = 'cmd_timeout_seconds'").get()?.value;
  const n = parseInt(raw);
  if (raw === undefined || raw === null || raw === '' || !Number.isFinite(n)) return DEFAULT_CMD_TIMEOUT_SECONDS * 1000;
  return n <= 0 ? 0 : n * 1000; // 0 = 不限制
}

function runShellCommand(command, cwd, holder, timeoutMs) {
  const sh = buildShell(command);
  return new Promise((resolve) => {
    const outBuf = [];
    const errBuf = [];
    let settled = false;
    let timer = null;
    const concat = (list) => (list.length ? Buffer.concat(list) : Buffer.alloc(0));
    const partialText = () => {
      const parts = [decodeConsoleOutput(concat(outBuf))];
      if (errBuf.length) parts.push('[stderr]\n' + decodeConsoleOutput(concat(errBuf)));
      return parts.filter(Boolean).join('\n');
    };
    const finish = (r) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      holder.child = null;
      holder.pid = null;
      holder.command = '';
      holder.startedAt = null;
      holder.manualTimeout = null;
      resolve(r);
    };
    const opts = { cwd, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer', windowsHide: true };
    const done = (err, stdout, stderr) => {
      if (settled) return; // 超时分支已先行结算
      const out = [stdout, stderr].filter(Boolean).map(decodeConsoleOutput).join('\n[stderr]\n') || partialText();
      if (err && !stdout && !stderr && !out) return finish({ error: String(err.message) });
      finish({ output: out || '(无输出)' });
    };
    const child = sh ? execFile(sh.file, sh.args, opts, done) : exec(command, opts, done);
    if (child.stdout) child.stdout.on('data', c => outBuf.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
    if (child.stderr) child.stderr.on('data', c => errBuf.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
    procguard.claim(child.pid, sh ? sh.image : (IS_WIN ? 'cmd.exe' : 'sh'), 'run_command');
    holder.child = child;
    holder.pid = child.pid;
    holder.command = command;

    // 超时判定（定时器与「超时」按钮共用）：先杀树，再把部分输出与建议回喂，会话继续
    const triggerTimeout = async (byUser, waitedMs) => {
      if (settled) return false;
      const secs = Math.max(1, Math.round((waitedMs || (timeoutMs || 0)) / 1000));
      const partial = partialText();
      const k = await procguard.killTree(child.pid);
      const head = byUser
        ? `用户在第 ${secs} 秒手动判定该命令已超时，进程树已被终止。`
        : `命令运行超过 ${secs} 秒已超时，进程树已被终止。`;
      finish({
        error: head + (k.ok ? `（${k.note}）` : `（注意：进程树未能确认回收——${k.note}）`) +
          `\n已收集到的部分输出：\n${(partial || '(无输出)').substring(0, 6000)}` +
          `\n[系统提示] 命令未完成而不是环境故障：需要更久请改用 run_background 异步运行（不阻塞本轮），再用 background_status 查进度；` +
          `或者把命令拆小、加 head/tail/grep 过滤输出后重试。不要原样重跑同一条命令。`
      });
      return true;
    };
    const startedAt = Date.now();
    holder.startedAt = startedAt;
    holder.manualTimeout = () => triggerTimeout(true, Date.now() - startedAt);
    if (timeoutMs > 0) timer = setTimeout(() => { triggerTimeout(false, timeoutMs); }, timeoutMs);
  });
}

// ---------- AGENTS.md / AGENT.md 静态上下文 ----------
// 实现搬到 utils/agentsmd.js（第二十九轮之后）：主聊天、侧栏提问、托管工作者、子智能体
// 四条路共用一份收集逻辑，设置页与项目右键的编辑器也走同一套路径解析，
// 免得出现「界面改的文件和模型读的文件不是同一个」。
const agentsMd = require('../utils/agentsmd');
// 工具层里叫 collect / collectRemote，这里保留原来的调用名，改动面小一点
const { estimateTokens, AGENTS_MD_MAX_BYTES } = agentsMd;
const collectAgentsMd = agentsMd.collect;
const collectAgentsMdRemote = (hostRow, projectRoot, cwd) => agentsMd.collectRemote(hostRow, projectRoot, cwd);

// ---------- 敏感数据脱敏（只脱"进入 AI 上下文"的数据；AI 输出的代码绝不脱敏） ----------
let secretsCache = { at: 0, list: [] };
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function getSecretPatterns() {
  const now = Date.now();
  if (now - secretsCache.at > 5000) {
    const rows = db.prepare('SELECT id, pattern FROM secrets ORDER BY id ASC').all();
    // 除了用户手填的正则，提供商表里的真实 key 也必须算进去：
    // 本机 secrets 表往往是空的，只靠手填规则等于没脱敏，而 key 就在 kh.db 里躺着。
    const keys = db.prepare("SELECT DISTINCT api_key FROM ai_providers WHERE api_key IS NOT NULL AND length(api_key) >= 8")
      .all().map(r => r.api_key);
    secretsCache = {
      at: now,
      list: [
        ...rows.map(r => {
          try { return { id: r.id, re: new RegExp(r.pattern, 'g') }; }
          catch (e) { return { id: r.id, re: null, bad: r.pattern }; }
        }),
        ...keys.map((k, i) => ({ id: 'provider:' + i, re: new RegExp(escapeRe(k), 'g') })),
      ]
    };
  }
  return secretsCache.list;
}

const REDACTED = '***REDACTED***';
function redactSecrets(text) {
  let out = String(text ?? '');
  for (const { re, bad } of getSecretPatterns()) {
    if (bad) continue;
    re.lastIndex = 0;
    out = out.replace(re, REDACTED);
  }
  return out;
}

// ---------- 自定义技能（<数据目录>/skills/，遵循 opencode frontmatter 规范） ----------
// 以前放在 server/agent-skills-custom —— 装机版那就是包体内部，装到 Program Files 根本写不进去，
// 热同步/重装也会把用户自己导入的技能冲掉。数据目录才是它该待的地方。
const SKILLS_CUSTOM_DIR = path.join(require('../config').DATA_DIR, 'skills');
const SKILLS_LEGACY_DIR = path.join(__dirname, 'agent-skills-custom');

// 老位置有文件、新位置还没有 → 搬一次（只搬，不删老目录里的东西除非搬成功）
function migrateCustomSkills() {
  try {
    if (!fs.existsSync(SKILLS_LEGACY_DIR)) return 0;
    const files = fs.readdirSync(SKILLS_LEGACY_DIR).filter((f) => f.endsWith('.md'));
    if (!files.length) return 0;
    fs.mkdirSync(SKILLS_CUSTOM_DIR, { recursive: true });
    let moved = 0;
    for (const f of files) {
      const from = path.join(SKILLS_LEGACY_DIR, f);
      const to = path.join(SKILLS_CUSTOM_DIR, f);
      if (fs.existsSync(to)) continue;          // 新位置已有同名文件：不覆盖用户后来的版本
      fs.copyFileSync(from, to);
      fs.unlinkSync(from);
      moved++;
    }
    try { if (!fs.readdirSync(SKILLS_LEGACY_DIR).length) fs.rmdirSync(SKILLS_LEGACY_DIR); } catch (e) { /* 空目录删不掉无所谓 */ }
    if (moved) console.log(`[skills] 已把 ${moved} 个自定义技能从包体迁到 ${SKILLS_CUSTOM_DIR}`);
    return moved;
  } catch (e) {
    console.error('[skills] 迁移自定义技能失败：', e.message);
    return 0;
  }
}
setImmediate(migrateCustomSkills);

// ---------- 任务列表（Plan 模式） ----------
function getTasks(chatId) {
  return db.prepare('SELECT id, content, status, error_summary, seq FROM tasks WHERE chat_id = ? ORDER BY seq ASC, id ASC').all(chatId);
}

// 解析并剥离 AI 正文中的任务标签；返回 { text, changed }
// <plan>\n- 任务1\n- 任务2\n</plan> → 重建该会话任务列表
// <task-status idx="N" status="doing|done|failed" error="摘要"/> → 更新对应任务状态
function parseTaskTags(content, chatId) {
  let text = String(content || '');
  let changed = false;
  const planRe = /<plan>([\s\S]*?)<\/plan>/gi;
  text = text.replace(planRe, (_m, body) => {
    const items = String(body).split('\n')
      .map(l => l.trim())
      .filter(l => l)
      .map(l => l.replace(/^[-*•]\s*/, '').trim())
      .filter(l => l)
      .slice(0, 50);
    if (items.length) {
      const del = db.prepare('DELETE FROM tasks WHERE chat_id = ?');
      const ins = db.prepare('INSERT INTO tasks (chat_id, content, status, seq) VALUES (?, ?, ?, ?)');
      db.transaction(() => {
        del.run(chatId);
        items.forEach((c, i) => ins.run(chatId, c.substring(0, 500), 'pending', i + 1));
      })();
      changed = true;
    }
    return '';
  });
  const statusRe = /<task-status\b[^>]*\/?>/gi;
  text = text.replace(statusRe, (tag) => {
    const idx = parseInt((tag.match(/idx\s*=\s*["']?(\d+)/i) || [])[1]);
    const status = ((tag.match(/status\s*=\s*["']?(doing|done|failed)/i) || [])[1] || '').toLowerCase();
    const error = ((tag.match(/error\s*=\s*["']([^"']*)["']/i) || [])[1] || '').substring(0, 300);
    if (Number.isInteger(idx) && idx >= 1 && ['doing', 'done', 'failed'].includes(status)) {
      const t = db.prepare('SELECT id FROM tasks WHERE chat_id = ? AND seq = ?').get(chatId, idx);
      if (t) {
        db.prepare('UPDATE tasks SET status = ?, error_summary = ? WHERE id = ?').run(status, status === 'failed' ? (error || '（AI 未提供错误摘要）') : '', t.id);
        changed = true;
      }
    }
    return '';
  });
  return { text: text.trim(), changed };
}

// 工具失败兜底：把当前 doing 的任务自动标 failed（AI 随后可用 task-status 纠正）
function markDoingTaskFailed(chatId, errorSummary) {
  const doing = db.prepare('SELECT id FROM tasks WHERE chat_id = ? AND status = ?').all(chatId, 'doing');
  if (!doing.length) return false;
  const upd = db.prepare("UPDATE tasks SET status = 'failed', error_summary = ? WHERE id = ?");
  for (const t of doing) upd.run(String(errorSummary || '').substring(0, 300), t.id);
  return true;
}

// ---------- 工具审批（橙色=越界访问，红色=危险命令/敏感目录） ----------
const SENSITIVE_DIRS = /^\/(etc|root|sys|proc|boot|dev|usr|sbin|bin|lib|opt|srv|run|var)(\/|$)/;
// Windows 系统敏感目录（正则不依赖运行平台，Linux 上出现此类路径字符串同样拦截）
const SENSITIVE_DIRS_WIN = /^[a-zA-Z]:[\\/](windows|program files( \(x86\))?|programdata)([\\/]|$)/i;
const DANGEROUS_CMD = /\b(rm|dd|mkfs|mke2fs|shutdown|reboot|halt|poweroff|fdisk|parted|blockdev|kill|killall|pkill|chmod|chown|shred|wipefs|format|del|rd|rmdir)\b|\bsudo\b|\bsu\b|\|\s*(ba)?sh\b|:\(\)\{/;

// 统一的审批判定：权限规则（黑/白名单）→ 审批模式（严格/默认/免除）→ 高权限底线
// 返回 { need, level:'orange'|'red'|null, reason, isHigh, denied?:string }
// 三种模式语义：
//   strict 严格：所有「修改类」工具调用（含工作目录内写文件/编辑/删除/建目录/执行的危险命令）一律先人工审批
//   default 默认：仅当操作越出工作目录、涉系统关键设置、或为危险命令时审批
//   exempt 免除：除高权限操作外全部自动放行
function decideApproval2(chatId, name, args, cwd, projectRoot, bypass) {
  const mode = effectiveApprovalMode(chatId);
  // 这条会话在远端：路径判定必须换成 posix（一次 SQLite 查表，微秒级）
  const remoteTurn = !!remoteHostFor(chatId);
  const subj = collectToolSubjects(name, args, cwd, remoteTurn);

  // 权限规则：黑名单直接拒绝（任何模式、含高权限底线之上），白名单免审批
  const pv = perms.evaluate(subj);
  if (pv.verdict === 'deny') {
    const label = { command: '命令', path: '路径', keyword: '关键词', tool: '工具' }[pv.rule.kind] || pv.rule.kind;
    const which = pv.rule.list === 'black' ? '黑名单' : '名单';
    return { need: false, level: null, reason: null, isHigh: false, denied: `权限${label}${which}拦截：命中规则「${pv.rule.pattern}」（${pv.rule.note || '无备注'}）。该操作被主人禁止，请改用其他方式完成，或与用户确认后再调整设置页规则。` };
  }
  const whiteAllowed = pv.verdict === 'allow';

  // 识别高权限操作（任何模式下都必须人工审批）
  const isHigh = isHighPrivilege(name, args);
  const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'run_command', 'run_background', 'delete_file', 'create_dir', 'delete_dir', 'rename_file', 'move_file']);
  const isMutating = MUTATING_TOOLS.has(name);
  const base = checkApproval(name, args, cwd, projectRoot, remoteTurn);
  const level = base ? base.level : null;
  const reason = base ? base.reason : '';

  if (isHigh) {
    return { need: true, level: 'red', reason: reason || '此操作涉及关机/重启/格式化磁盘等高风险权限操作，必须由你确认', isHigh: true };
  }
  if (whiteAllowed) return { need: false, level: null, reason: null, isHigh: false, whitelisted: pv.rule };
  if (bypass) return { need: false, level: null, reason: null, isHigh };

  // MCP 工具是第三方能力，不天然享有 gate 工具的审批豁免：只有 server 自己在
  // tools/list 里标了 annotations.readOnlyHint 的才当只读放行；标了破坏性的抬到红色确认。
  // 黑白名单与「免除模式」仍在上面优先生效，用户想放开有明确出口。
  {
    const pol = toolgate.gatePolicy(name);
    if (pol.mcp && !pol.readOnly) {
      if (pol.destructive) {
        return { need: true, level: 'red', reason: reason || `MCP 工具 ${name} 自声明为破坏性操作，必须确认`, isHigh: true };
      }
      if (level) return { need: true, level, reason, isHigh: false };
      return { need: true, level: 'orange', reason: reason || `第三方 MCP 工具 ${name} 未声明只读，需确认后执行（可在设置里加入白名单免询问）`, isHigh: false };
    }
  }

  // 普通读操作（read/list/grep/glob/web_fetch/load_skill）、只读的后台任务与记忆查询、
  // 以及开关型扩展工具里的只读联网接口 —— 绝不需要审批
  const READ_ONLY = new Set(['read_file', 'list_dir', 'grep', 'glob', 'web_fetch', 'load_skill', 'use_skill',
    'background_status', 'background_list']);
  if (READ_ONLY.has(name) || toolgate.isGateTool(name)) {
    // 但读操作命中「越界/敏感目录」仍需审批（默认模式下原逻辑即如此）
    if (base) return { need: true, level, reason, isHigh: false };
    return { need: false, level: null, reason: null, isHigh };
  }

  if (mode === 'strict') {
    if (isMutating || level === 'red' || level === 'orange') {
      return { need: true, level: level === 'red' ? 'red' : 'orange', reason: reason || '严格模式下需要你手动确认本次更改', isHigh };
    }
    return { need: false, level: null, reason: null, isHigh };
  }

  if (mode === 'exempt') return { need: false, level: null, reason: null, isHigh };

  // default：仅越界/敏感/危险命令审批
  if (base) return { need: true, level, reason, isHigh: false };
  return { need: false, level: null, reason: null, isHigh: false };
}

// 收集一次工具调用的判定对象：命令原文 + 全部涉及路径（绝对化）+ 参数文本
// remote=true 时路径按 posix 绝对化（远程会话的 cwd 是 /home/ker 这种远端路径，
// 用 path.resolve 会得出 D:\home\ker，越界判定立刻全错 → 每次操作都弹审批）
function collectToolSubjects(name, args, cwd, remote = false) {
  const paths = [];
  const keywords = [];
  let command = '';
  const pushPath = (raw) => {
    if (typeof raw !== 'string' || !raw.trim()) return;
    if (remote) { paths.push(remoteexec.rj(cwd, raw)); return; }
    try { paths.push(path.resolve(cwd || process.cwd(), raw)); } catch (e) { paths.push(raw); }
  };
  if (name === 'run_command' || name === 'run_background') {
    // 后台任务与前台命令同等对待：命令内容一样要过危险命令判定与权限规则
    command = String(args?.command || '');
    // 命令里出现的绝对路径（含 Windows 盘符路径）；/c、/y 等开关已由 permissions 模块排除
    for (const p of perms.extractPaths(command)) pushPath(p);
    keywords.push(command);
  } else {
    pushPath(args?.path);
    pushPath(args?.new_path);
    pushPath(args?.to);
    pushPath(args?.url);
    for (const [k, v] of Object.entries(args || {})) {
      if (typeof v === 'string') keywords.push(`${k}=${v}`);
    }
  }
  return { tool: name, command, paths, keywords };
}

const FILE_TARGET_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'list_dir', 'grep', 'glob', 'delete_file', 'delete_dir', 'create_dir', 'rename_file']);

function checkApproval(name, args, cwd, projectRoot = null, remote = false) {
  const rp = remote ? remoteUtil.posixPath(cwd || '/') : cwd;   // 远程会话一律用 posix 的 cwd 做边界
  if (FILE_TARGET_TOOLS.has(name)) {
    // 项目会话：文件工具由 guardTargetPath 硬边界统一处理（拒绝时作为 tool_result 让 AI 反思），不走人工审批
    if (projectRoot) return null;
    const targets = [args?.path, name === 'rename_file' ? args?.new_path : null].filter(v => typeof v === 'string' && v.trim());
    for (const t of targets) {
      const p = remote ? remoteexec.rj(rp, t) : path.resolve(cwd, t);
      // 对原始输入与 resolve 结果都做检测（跨平台：Windows 盘符路径在 Linux 上 resolve 后会被当相对路径拼接）
      if (SENSITIVE_DIRS.test(p) || SENSITIVE_DIRS_WIN.test(p) || SENSITIVE_DIRS.test(t) || SENSITIVE_DIRS_WIN.test(t)) {
        return { level: 'red', reason: `访问系统敏感目录：${p}` };
      }
      const outside = remote ? !(p === rp || p.startsWith(rp + '/')) : !(p.startsWith(cwd + path.sep) || p === cwd);
      if (outside) return { level: 'orange', reason: `访问工作目录之外的路径：${p}（当前目录 ${rp}）` };
    }
    return null;
  }
  if (name === 'run_command') {
    const cmd = String(args?.command || '');
    if (/\b(sudo|su)\b/.test(cmd)) return { level: 'red', reason: '命令请求管理员(sudo/su)权限' };
    if (DANGEROUS_CMD.test(cmd)) return { level: 'red', reason: '命令包含潜在危险操作（删除/格式化/关机/杀进程等）' };
    if (SENSITIVE_DIRS.test(cmd) || SENSITIVE_DIRS_WIN.test(cmd)) return { level: 'red', reason: '命令涉及系统敏感目录' };
    // 命令中出现的绝对路径若在工作目录之外 → 橙色审批
    // 注意：/c、/y、/Force 这类命令行开关不是路径（旧实现按正则贪婪匹配会把它们误判为越界路径）
    for (const raw of perms.extractPaths(cmd)) {
      const p = remote ? remoteexec.rj(rp, raw) : (path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(cwd || process.cwd(), raw));
      if (SENSITIVE_DIRS.test(p)) return { level: 'red', reason: `命令涉及系统敏感目录：${p}` };
      if (remote ? (p === rp || p.startsWith(rp + '/')) : (p === cwd || p.startsWith(cwd + path.sep) || p.startsWith(cwd + '/'))) continue;
      if (/^\/(tmp|usr\/bin|bin|sbin)(\/|$)/.test(p) || p === '/usr/bin/env') continue; // 系统可执行/临时目录不算越界
      if (!remote && process.platform !== 'win32' && !p.startsWith('/')) continue;
      return { level: 'orange', reason: `命令涉及工作目录之外的路径：${p}` };
    }
    return null;
  }
  return null;
}

// ---------- 审批模式（严格 strict / 默认 default / 免除 exempt） ----------
// 存储：settings 表 approval_mode，null/空 = default
const APPROVAL_MODES = ['default', 'strict', 'exempt'];
function getApprovalMode() {
  return (db.prepare("SELECT value FROM settings WHERE key = 'approval_mode'").get()?.value || 'default');
}
function setApprovalMode(m) {
  if (!APPROVAL_MODES.includes(m)) return false;
  db.prepare("INSERT INTO settings (key, value) VALUES ('approval_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP").run(m);
  return true;
}
// 会话级审批模式：写入 ai_chats.approval_mode（空串=跟随全局）。
// 存库而非进程内 Map，避免多窗口/新会话共用同一个 key 相互覆盖，且重启后仍保持
function getChatApprovalMode(chatId) {
  if (!Number.isInteger(chatId) || chatId <= 0) return '';
  try {
    return String(db.prepare('SELECT approval_mode FROM ai_chats WHERE id = ?').get(chatId)?.approval_mode || '');
  } catch (e) { return ''; }
}
function setChatApprovalMode(chatId, mode) {
  if (!Number.isInteger(chatId) || chatId <= 0) return false;
  const v = APPROVAL_MODES.includes(mode) ? mode : '';
  try { db.prepare('UPDATE ai_chats SET approval_mode = ? WHERE id = ?').run(v, chatId); } catch (e) { return false; }
  return true;
}
function effectiveApprovalMode(chatId) {
  const m = getChatApprovalMode(chatId);
  return m || getApprovalMode();
}

// ---------- 高权限操作识别（免除模式下仍需审批，且不弹 Windows 通知） ----------
// 关机/重启/格式化磁盘/操作盘符/管理员权限提升 等
const HIGH_PRIV_REC = /(shutdown|reboot|halt|poweroff|format|mkfs|fdisk|parted|diskpart|chkdsk|clean\s+all|label\s+[a-zA-Z]:|bootrec|bcdedit|sfc\s*\/|dism|reg\s+delete|sc\s+delete|takeown|icacls|fsutil|mountvol|wmic|powershell\s+-command.*(remove-item|stop-service|set-service)|del\s+\\?\\.\\)/i;
const HIGH_PRIV_PATH = /^[a-zA-Z]:[\\/](windows|program files( \(x86\))?|programdata|recovery|system volume information)([\\/]|$)/i;
function isHighPrivilege(name, args) {
  if (name === 'run_command') {
    const cmd = String(args?.command || '');
    if (/^(shutdown|reboot|halt|poweroff)\b/i.test(cmd.trim())) return true;
    if (HIGH_PRIV_REC.test(cmd)) return true;
  }
  // 直接对系统分区/EFI 盘符操作
  const p = String(args?.path || '');
  if (HIGH_PRIV_PATH.test(path.resolve('.', p))) return true;
  return false;
}
// 判定某路径是否在 cwd 之外（默认模式下审批条件之一）
function isOutsideCwd(p, cwd) {
  const abs = path.resolve(cwd, p);
  return !(abs === cwd || abs.startsWith(cwd + path.sep));
}

// ---------- 审批等待：挂起工具执行，等待前端用户裁决 ----------
const pendingApprovals = new Map();

// 每个模型「已验证可用」的思考参数样式（modelId|mode|effort → 样式序号）
const thinkingStyleCache = new Map();

// 记住某模型的工具体征（native/text），下次直接按可用方式发起，不再重复试错
function persistToolStyle(row, style) {
  if (!row || !row.id) return;
  row.tool_style = style;
  try { db.prepare('UPDATE ai_models SET tool_style = ? WHERE id = ?').run(style, row.id); } catch (e) { /* 旧库无列时忽略 */ }
}

// 原生模式下发现模型「用文本写调用」：累计 2 次才判定为文本协议模型（避免把举例当成调用而误改体征）
function noteTextAttempt(row) {
  const n = (Number(row.tool_fail_count) || 0) + 1;
  row.tool_fail_count = n;
  try { db.prepare('UPDATE ai_models SET tool_fail_count = ? WHERE id = ?').run(n, row.id); } catch (e) { /* ignore */ }
  if (n >= 2) {
    persistToolStyle(row, 'text');
    row.tool_fail_count = 0;
    try { db.prepare('UPDATE ai_models SET tool_fail_count = 0 WHERE id = ?').run(row.id); } catch (e) { /* ignore */ }
    return true;
  }
  return false;
}

function waitApproval(id, deniedList) {
  return new Promise((resolve) => {
    // 等待时长可在「设置 → 常规」改；到点按拒绝处理，不让一轮对话永远挂在那儿
    const waitMs = numSetting('approval_timeout_seconds', 180, 30, 3600) * 1000;
    const timer = setTimeout(() => {
      if (pendingApprovals.has(id)) {
        pendingApprovals.delete(id);
        resolve({ allow: false, timeout: true });
      }
    }, waitMs);
    pendingApprovals.set(id, (allow) => {
      clearTimeout(timer);
      pendingApprovals.delete(id);
      resolve({ allow });
    });
    deniedList.push(() => {
      if (pendingApprovals.has(id)) {
        pendingApprovals.delete(id);
        resolve({ allow: false, timeout: true });
      }
    });
  });
}

// 「始终允许」记忆：chatId -> Set（文件/目录前缀、命令全文），会话级内存（重启清空）
const chatAlwaysAllow = new Map();
const normalizeAllowPath = (p) => {
  let s = path.resolve(String(p || ''));
  if (process.platform === 'win32') s = s.toLowerCase();
  return s;
};
const addAlwaysAllow = (chatId, entry) => {
  if (!chatAlwaysAllow.has(chatId)) chatAlwaysAllow.set(chatId, new Set());
  chatAlwaysAllow.get(chatId).add(entry);
};
// 匹配：条目为路径前缀（含自身与子路径）或命令全文
const isAlwaysAllowed = (chatId, kind, value) => {
  const set = chatAlwaysAllow.get(chatId);
  if (!set) return false;
  const norm = kind === 'path' ? normalizeAllowPath(value) : String(value || '').trim();
  if (set.has(norm)) return true;
  if (kind === 'path') {
    for (const e of set) {
      // 路径条目：value 以该前缀开头（目录内全部允许）
      if (!e.includes('cmd:')) {
        const sep = process.platform === 'win32' ? '\\\\' : '/';
        if (norm === e || norm.startsWith(e + sep)) return true;
      }
    }
  }
  return false;
};

// 审批裁决端点（前端批准/拒绝；always=true 时把目标加入本会话的始终允许清单）
router.post('/chat/approve', wrap((req, res) => {
  const id = String(req.body?.id || '');
  const resolver = pendingApprovals.get(id);
  if (!resolver) return fail(res, 404, '审批请求不存在或已过期');
  if (req.body?.allow && req.body?.always && req.body?.target) {
    const chatId = parseInt(req.body.chat_id);
    if (Number.isInteger(chatId)) {
      const t = req.body.target;
      if (t.kind === 'path') addAlwaysAllow(chatId, normalizeAllowPath(t.value));
      else addAlwaysAllow(chatId, `cmd:${t.value}`);
      // 该路径已获始终允许：后续同路径/子路径不再弹窗
    }
  }
  resolver(!!req.body?.allow);
  ok(res, null, req.body?.allow ? (req.body?.always ? '已批准，后续同目标不再询问' : '已批准') : '已拒绝');
}));

// ---------- 正在运行的工具句柄（供「超时」按钮定位到本会话当前命令） ----------
// 只登记 holder 本身，不登记任何外部可传入的 PID：手动超时只能作用于本服务自己起的进程。
const activeHolders = new Map(); // chatId -> holder

// ---------- ask_user：AI 主动提问（复用审批那套「挂起 → SSE → 前端裁决」通道） ----------
const pendingQuestions = new Map(); // id -> { resolve, chatId }
const QUESTION_DEFAULT_TIMEOUT = 10 * 60 * 1000;

function waitQuestion(id, chatId, timeoutMs, deniedList) {
  return new Promise((resolve) => {
    let timer = null;
    const finish = (r) => {
      if (!pendingQuestions.has(id)) return;
      pendingQuestions.delete(id);
      if (timer) clearTimeout(timer);
      const i = deniedList.indexOf(cancel);
      if (i >= 0) deniedList.splice(i, 1);
      resolve(r);
    };
    const cancel = () => finish({ answered: false, cancelled: true });
    pendingQuestions.set(id, { resolve: (r) => finish(r), chatId });
    timer = setTimeout(() => finish({ answered: false, timeout: true }), timeoutMs || QUESTION_DEFAULT_TIMEOUT);
    deniedList.push(cancel);
  });
}

// 用户在问题挂着时直接发起新一轮对话：视为「未回答」并立刻放行，避免白等 10 分钟
function releaseQuestionsForChat(chatId, note) {
  for (const [id, q] of [...pendingQuestions.entries()]) {
    if (q.chatId !== chatId) continue;
    q.resolve({ answered: false, superseded: true, note: note || '用户未回答该问题，直接发起了新一轮对话' });
  }
}

router.post('/chat/answer', wrap((req, res) => {
  const id = String(req.body?.id || '');
  const q = pendingQuestions.get(id);
  if (!q) return fail(res, 404, '该提问已结束或已超时');
  if (req.body?.cancel) {
    q.resolve({ answered: false, cancelled: true });
    return ok(res, null, '已取消，AI 会自行决定下一步');
  }
  const answer = String(req.body?.answer ?? '').trim().substring(0, 2000);
  if (!answer) return fail(res, 400, '回答内容为空（不想回答请点「取消」）');
  q.resolve({ answered: true, answer });
  ok(res, null, '已回答');
}));

// 「超时」按钮：让当前正在跑的命令立刻按超时处理（杀进程树 + 回喂部分输出），会话继续
router.post('/chat/tool-timeout', wrap(async (req, res) => {
  const chatId = parseInt(req.body?.chat_id);
  if (!Number.isInteger(chatId)) return fail(res, 400, '缺少 chat_id');
  const holder = activeHolders.get(chatId);
  if (!holder || typeof holder.manualTimeout !== 'function' || !holder.child) {
    return fail(res, 409, '当前会话没有正在运行的命令，无需判定超时');
  }
  const cmd = String(holder.command || '').substring(0, 120);
  const okIt = await holder.manualTimeout();
  ok(res, { triggered: !!okIt }, okIt ? `已按超时处理：${cmd || '当前命令'}` : '该命令已经结束了');
}));

// ---------- /insert 安全边界缓冲区 与 /skills-load 会话技能 ----------
const INSERT_MAX_ITEMS = 20;
const INSERT_MAX_CHARS = 2000;

function readJsonCol(chatId, col) {
  try {
    const raw = db.prepare(`SELECT ${col} AS v FROM ai_chats WHERE id = ?`).get(chatId)?.v;
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(x => String(x)) : [];
  } catch (e) { return []; }
}

function writeJsonCol(chatId, col, list) {
  try {
    db.prepare(`UPDATE ai_chats SET ${col} = ? WHERE id = ?`).run(JSON.stringify(list || []), chatId);
    return true;
  } catch (e) { return false; }
}

const readInsertBuffer = (chatId) => readJsonCol(chatId, 'insert_buffer');
const clearInsertBuffer = (chatId) => writeJsonCol(chatId, 'insert_buffer', []);

function appendInsertBuffer(chatId, text) {
  const body = String(text ?? '').trim().substring(0, INSERT_MAX_CHARS);
  if (!body) return { error: '插入内容为空' };
  const list = readInsertBuffer(chatId);
  list.push(body);
  while (list.length > INSERT_MAX_ITEMS) list.shift();
  writeJsonCol(chatId, 'insert_buffer', list);
  return { list };
}

// 安全边界取用：取出即清空（UI 与缓冲区一起清），一条提示词只注入一次
function takeInsertBuffer(chatId) {
  const list = readInsertBuffer(chatId);
  if (list.length) clearInsertBuffer(chatId);
  return list;
}

const getLoadedSkills = (chatId) => readJsonCol(chatId, 'loaded_skills');

router.get('/chats/:id/insert', wrap((req, res) => {
  const chatId = parseInt(req.params.id);
  ok(res, { items: readInsertBuffer(chatId), max: INSERT_MAX_ITEMS, max_chars: INSERT_MAX_CHARS });
}));

router.post('/chats/:id/insert', wrap((req, res) => {
  const chatId = parseInt(req.params.id);
  const r = appendInsertBuffer(chatId, req.body?.text);
  if (r.error) return fail(res, 400, r.error);
  ok(res, { items: r.list }, `已加入待注入队列（当前 ${r.list.length} 条，将在工具结果回喂时注入）`);
}));

router.delete('/chats/:id/insert', wrap((req, res) => {
  const chatId = parseInt(req.params.id);
  clearInsertBuffer(chatId);
  ok(res, { items: [] }, '待注入提示词已清空');
}));

router.get('/chats/:id/skills', wrap((req, res) => {
  ok(res, { loaded: getLoadedSkills(parseInt(req.params.id)), available: listSkills().map(s => ({ name: s.name, description: s.description })) });
}));

router.put('/chats/:id/skills', wrap((req, res) => {
  const chatId = parseInt(req.params.id);
  const wanted = Array.isArray(req.body?.loaded) ? req.body.loaded.map(x => String(x).trim()).filter(Boolean) : [];
  const valid = new Set(listSkills().map(s => s.name));
  const kept = wanted.filter(n => valid.has(n)).slice(0, 12);
  const skipped = wanted.filter(n => !valid.has(n));
  writeJsonCol(chatId, 'loaded_skills', kept);
  ok(res, { loaded: kept }, kept.length
    ? `已加载 ${kept.length} 个技能${skipped.length ? `（忽略不存在的：${skipped.join('、')}）` : ''}`
    : '已清空会话技能');
}));

// ---------- 上下文导入 / 导出 ----------
// 导出的是「能接着聊」的完整上下文：正文 + 思考 + 工具轨迹 + 会话摘要与参数。
// 默认过 redactSecrets（导出的文件会离开本机，工具结果里可能夹带密钥）；raw=1 才出明文。
// 图片本来就只以 [[img:token]] 形式存在于正文、dataURL 从不落盘，所以导出天然不含二进制。
const CONTEXT_KIND = 'kharness.context';
const CONTEXT_VERSION = 1;
const IMPORT_MAX_MESSAGES = 2000;
const IMPORT_MAX_CONTENT = 200000;   // 单条正文上限
const IMPORT_MAX_STEPS = 400;        // 单条轨迹步数上限

function contextStepsForExport(row) {
  let steps = [];
  try { steps = JSON.parse(row.steps_json || '[]'); } catch (e) { steps = []; }
  if (!Array.isArray(steps)) return [];
  return steps.slice(0, IMPORT_MAX_STEPS);
}

router.get('/chats/:id/context', wrap((req, res) => {
  const id = parseInt(req.params.id);
  const chat = db.prepare(`
    SELECT c.*, m.model_id AS p_model_id, m.display_name AS p_display_name
    FROM ai_chats c LEFT JOIN ai_models m ON c.model_row_id = m.id WHERE c.id = ? AND c.user_id = 1
  `).get(id);
  if (!chat) return fail(res, 404, '对话不存在');
  const raw = String(req.query?.raw ?? '') === '1' || String(req.query?.raw ?? '') === 'true';
  const rows = db.prepare(
    'SELECT id, role, content, reasoning, steps_json, created_at, archived, unfinished, model_row_id, speaker FROM ai_chat_messages WHERE chat_id = ? ORDER BY id ASC'
  ).all(id);
  const nameOf = db.prepare('SELECT model_id FROM ai_models WHERE id = ?');
  const messages = rows.map(r => {
    const body = raw ? (r.content || '') : redactSecrets(r.content || '');
    const think = raw ? (r.reasoning || '') : redactSecrets(r.reasoning || '');
    let steps = contextStepsForExport(r);
    // 轨迹里同样带工具输出，逐字段过一遍脱敏；raw 时原样
    if (!raw) {
      steps = steps.map(s => {
        const o = Object.assign({}, s);
        for (const k of ['output', 'error', 'message', 'text', 'new', 'old']) {
          if (typeof o[k] === 'string') o[k] = redactSecrets(o[k]);
        }
        if (o.args && typeof o.args === 'object') {
          const a = {};
          for (const [k, v] of Object.entries(o.args)) a[k] = typeof v === 'string' ? redactSecrets(v) : v;
          o.args = a;
        }
        if (Array.isArray(o.lines)) {
          o.lines = o.lines.map(l => (l && typeof l.text === 'string') ? Object.assign({}, l, { text: redactSecrets(l.text) }) : l);
        }
        return o;
      });
    }
    const usedModel = r.model_row_id ? nameOf.get(r.model_row_id) : null;
    return {
      role: r.role,
      content: body,
      reasoning: think || undefined,
      steps: steps.length ? steps : undefined,
      created_at: r.created_at,
      archived: r.archived ? 1 : 0,
      unfinished: r.unfinished ? 1 : 0,
      model: usedModel ? usedModel.model_id : undefined,
      // 托管模式才有意义：默认 worker 时干脆不发这个字段，旧客户端与旧数据载荷一字不变
      speaker: r.speaker && r.speaker !== 'worker' ? r.speaker : undefined,
    };
  });
  ok(res, {
    kind: CONTEXT_KIND,
    version: CONTEXT_VERSION,
    exported_at: new Date().toISOString(),
    redacted: !raw,
    source_chat_id: id,
    chat: {
      title: chat.title || '',
      cwd: chat.cwd || '',
      context_limit: chat.context_limit || 0,
      summary: raw ? (chat.summary || '') : redactSecrets(chat.summary || ''),
      approval_mode: chat.approval_mode || '',
      thinking_level: chat.thinking_level || '',
      plan_mode: chat.plan_mode ? 1 : 0,
      temperature: chat.temperature ?? null,
      model: chat.p_model_id ? { model_id: chat.p_model_id, display_name: chat.p_display_name || '' } : null,
      // 项目只带名字不带路径：换机器/路径变了也不至于导入失败
      project: chat.project_id
        ? (db.prepare('SELECT name FROM projects WHERE id = ?').get(chat.project_id)?.name || null)
        : null,
    },
    messages,
  });
}));

// 导入上下文 → 新建一个会话。绝不覆盖已有会话，避免误操作把在聊的记录冲掉。
router.post('/chats/import', wrap((req, res) => {
  const ctx = req.body;
  if (!ctx || typeof ctx !== 'object') return fail(res, 400, '导入内容为空');
  if (ctx.kind !== CONTEXT_KIND) return fail(res, 400, '不是 KHarness 的上下文导出文件（缺少 kind 标识）');
  if (!Array.isArray(ctx.messages) || !ctx.messages.length) return fail(res, 400, '文件里没有任何消息');
  if (ctx.messages.length > IMPORT_MAX_MESSAGES) {
    return fail(res, 400, `消息 ${ctx.messages.length} 条，超过导入上限 ${IMPORT_MAX_MESSAGES} 条`);
  }
  // 归一 + 校验每条
  const clean = [];
  for (const m of ctx.messages) {
    const role = m?.role === 'user' ? 'user' : (m?.role === 'assistant' ? 'assistant' : null);
    if (!role) continue;
    let content = typeof m.content === 'string' ? m.content : '';
    if (content.length > IMPORT_MAX_CONTENT) content = content.substring(0, IMPORT_MAX_CONTENT) + '\n…(导入时截断)';
    if (!content.trim()) continue;
    let reasoning = typeof m.reasoning === 'string' ? m.reasoning.substring(0, IMPORT_MAX_CONTENT) : '';
    let stepsJson = '[]';
    if (Array.isArray(m.steps) && m.steps.length) {
      stepsJson = JSON.stringify(m.steps.slice(0, IMPORT_MAX_STEPS));
      if (stepsJson.length > 400000) stepsJson = '[]';   // 轨迹过大就舍弃，正文优先
    }
    clean.push({
      role, content, reasoning,
      steps_json: stepsJson,
      archived: m.archived ? 1 : 0,
      unfinished: m.unfinished ? 1 : 0,
      model_id: typeof m.model === 'string' ? m.model : '',
    });
  }
  if (!clean.length) return fail(res, 400, '文件里没有可用的消息（role 非 user/assistant 或正文为空）');

  // 模型：优先按 model_id 找回同名模型，找不到就用库里第一个可用模型
  const wanted = String(ctx.chat?.model?.model_id || '').trim();
  let modelRow = wanted
    ? db.prepare('SELECT id, model_id FROM ai_models WHERE model_id = ? ORDER BY id ASC LIMIT 1').get(wanted)
    : null;
  const modelFallback = !modelRow;
  if (!modelRow) modelRow = db.prepare('SELECT id, model_id FROM ai_models ORDER BY id ASC LIMIT 1').get();
  if (!modelRow) return fail(res, 400, '本机还没有任何可用模型，请先到「模型」页添加提供商与模型');

  // 项目：按名字匹配；匹配不上就退回本机默认工作目录
  const projectName = String(ctx.chat?.project || '').trim();
  let projectId = null;
  if (projectName) {
    const p = db.prepare('SELECT id, root_path FROM projects WHERE name = ? ORDER BY id ASC LIMIT 1').get(projectName);
    if (p) { projectId = p.id; }
  }
  let cwd = '';
  if (projectId) cwd = path.resolve(db.prepare('SELECT root_path FROM projects WHERE id = ?').get(projectId).root_path);
  else {
    const imported = String(ctx.chat?.cwd || '').trim();
    // 导入的绝对路径在本机确实存在才沿用，否则用默认目录
    cwd = (imported && path.isAbsolute(imported) && fs.existsSync(imported)) ? imported : AGENT_DEFAULT_CWD;
  }

  const srcTitle = String(ctx.chat?.title || '').trim().substring(0, 60) || '导入的会话';
  const title = `${srcTitle}（导入）`.substring(0, 60);
  const defCtx = (() => { const n = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'default_context_limit'").get()?.value); return Number.isInteger(n) && n > 0 ? n : 0; })();
  const limit = Number.isInteger(ctx.chat?.context_limit) && ctx.chat.context_limit >= 0 ? ctx.chat.context_limit : defCtx;

  const insert = db.prepare(`
    INSERT INTO ai_chat_messages (chat_id, role, content, reasoning, steps_json, archived, unfinished, model_row_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let chatId = 0;
  db.transaction(() => {
    const r = db.prepare('INSERT INTO ai_chats (user_id, model_row_id, title, project_id, cwd, plan_mode, context_limit) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(1, modelRow.id, title, projectId, cwd, ctx.chat?.plan_mode ? 1 : 0, limit);
    chatId = Number(r.lastInsertRowid);
    if (typeof ctx.chat?.thinking_level === 'string') {
      db.prepare('UPDATE ai_chats SET thinking_level = ? WHERE id = ?').run(ctx.chat.thinking_level.substring(0, 20), chatId);
    }
    if (typeof ctx.chat?.approval_mode === 'string' && APPROVAL_MODES.includes(ctx.chat.approval_mode)) {
      db.prepare('UPDATE ai_chats SET approval_mode = ? WHERE id = ?').run(ctx.chat.approval_mode, chatId);
    }
    if (ctx.chat?.summary) {
      db.prepare('UPDATE ai_chats SET summary = ? WHERE id = ?').run(String(ctx.chat.summary).substring(0, 12000), chatId);
    }
    for (const m of clean) {
      insert.run(chatId, m.role, m.content, m.reasoning, m.steps_json, m.archived, m.unfinished, modelRow.id, m.created_at || undefined);
    }
  })();

  ok(res, {
    chat_id: chatId,
    title,
    cwd,
    messages: clean.length,
    archived: clean.filter(m => m.archived).length,
    model: modelRow.model_id,
    model_fallback: modelFallback,
    project_matched: !!projectId,
    redacted_source: ctx.redacted === true,
  }, `已导入为会话「${title}」：${clean.length} 条消息` +
    (modelFallback ? `（原模型不在本机，已改用 ${modelRow.model_id}）` : '') +
    (projectId ? '' : (projectName ? `（本机没有项目「${projectName}」，工作目录用 ${cwd}）` : '')));
}));

// 系统通知回退通道：浏览器 Web Notification 未授权时，由本机弹 Windows 通知
router.post('/notify', wrap(async (req, res) => {
  const r = await notifier.notify(req.body?.title, req.body?.body);
  if (!r.ok) return fail(res, 502, `系统通知发送失败：${r.error}`);
  ok(res, null, '已发送系统通知');
}));

// 读取/设置全局审批模式（default / strict / exempt）
router.get('/approval-mode', wrap((req, res) => {
  ok(res, { mode: getApprovalMode(), modes: APPROVAL_MODES });
}));
router.put('/approval-mode', wrap((req, res) => {
  const mode = String(req.body?.mode || '');
  if (!APPROVAL_MODES.includes(mode)) return fail(res, 400, '无效的审批模式（default/strict/exempt）');
  setApprovalMode(mode);
  ok(res, { mode }, `审批模式已设为 ${mode}`);
}));
// 会话级审批模式（存库；mode='' 表示恢复跟随全局）
router.post('/approval-mode/override', wrap((req, res) => {
  const mode = String(req.body?.mode || '');
  if (mode && !APPROVAL_MODES.includes(mode)) return fail(res, 400, '无效的审批模式');
  const chatId = parseInt(req.body?.chat_id);
  if (Number.isInteger(chatId) && chatId > 0) {
    setChatApprovalMode(chatId, mode);
    return ok(res, { mode: mode || getApprovalMode(), scope: 'chat' }, mode ? `本会话审批模式设为 ${mode}` : '本会话恢复跟随全局审批模式');
  }
  if (mode) setApprovalMode(mode);
  ok(res, { mode: getApprovalMode(), scope: 'global' }, `全局审批模式设为 ${getApprovalMode()}`);
}));

// ---------- 外部 API 工具（设置里可选启用；先启用才注入工具清单） ----------
router.get('/tools', wrap((req, res) => {
  ok(res, toolgate.listForUi());
}));

/**
 * 整组开关：一个套装（某个 MCP 服务器 / 内置增强 / 外部接口）十几个工具，
 * 逐个点十几次不叫功能。只接受已注册的名字，注册表里没有的直接忽略并回报，
 * 免得前端拼错名字时静默以为生效了。
 */
router.post('/tools/bulk', wrap((req, res) => {
  const names = Array.isArray(req.body?.names) ? req.body.names.map(String) : [];
  const enabled = !!req.body?.enabled;
  if (!names.length) return fail(res, 400, 'names 不能为空');
  const hit = [];
  const miss = [];
  for (const n of names) {
    if (!toolgate.registry.has(n)) { miss.push(n); continue; }
    const cur = toolgate.configOf(n);
    toolgate.upsert(n, enabled, cur);
    hit.push(n);
  }
  ok(res, { changed: hit.length, ignored: miss },
    enabled ? `已启用 ${hit.length} 个工具${miss.length ? `（忽略未注册 ${miss.length} 个）` : ''}`
      : `已停用 ${hit.length} 个工具${miss.length ? `（忽略未注册 ${miss.length} 个）` : ''}`);
}));

// 启用/停用 + 保存该工具的配置（配置项由注册表声明，未知键忽略）
router.put('/tools/:name', wrap((req, res) => {
  const name = String(req.params.name || '');
  const def = toolgate.registry.get(name);
  if (!def) return fail(res, 404, '未知的工具');
  const cur = toolgate.configOf(name);
  const next = {};
  for (const f of (def.configFields || [])) {
    const v = req.body?.config?.[f.key];
    if (v === undefined || v === null || v === '') { next[f.key] = cur[f.key] ?? f.def; continue; }
    if (f.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) return fail(res, 400, `${f.label} 必须是数字`);
      if (f.min != null && n < f.min) return fail(res, 400, `${f.label} 不能小于 ${f.min}`);
      if (f.max != null && n > f.max) return fail(res, 400, `${f.label} 不能大于 ${f.max}`);
      next[f.key] = n;
    } else if (f.type === 'bool') {
      next[f.key] = !!v;
    } else {
      next[f.key] = String(v).substring(0, 500);
    }
  }
  const enabled = req.body?.enabled === undefined ? toolgate.isEnabled(name) : !!req.body.enabled;
  toolgate.upsert(name, enabled, next);
  ok(res, { name, enabled }, enabled ? `${def.label} 已启用，下次对话即可调用` : `${def.label} 已停用`);
}));

// 设置页「试跑」：真实调用一次（外部接口会消耗积分、run_background 会真的起一个进程），返回原始输出
router.post('/tools/:name/test', wrap(async (req, res) => {
  const name = String(req.params.name || '');
  const tool = toolgate.registry.get(name);
  if (!tool) return fail(res, 404, '未知的工具');
  const args = (req.body && typeof req.body.args === 'object' && req.body.args) || {};
  const ctx = { chatId: null, cwd: AGENT_DEFAULT_CWD, testRun: true };
  try {
    const r = await tool.run(args, ctx);
    if (r.error) return ok(res, { ok: false, text: String(r.error).substring(0, 4000) }, '调用返回错误');
    ok(res, { ok: true, text: String(r.output || '').substring(0, 8000) }, '调用成功');
  } catch (e) {
    failErr(res, 500, '试跑异常', e);
  }
}));

/* ---------- 整库导出 / 导入（桌面端与仓库端之间搬数据唯一的口子） ---------- */

router.get('/database', wrap((req, res) => {
  ok(res, require('../utils/dbio').status());
}));

// 导出走在线备份：直接读 kh.db 文件会漏掉 WAL 里还没落盘的部分（这个坑踩过一次）
router.get('/database/export', wrap(async (req, res) => {
  const dbio = require('../utils/dbio');
  const { file, size } = await dbio.exportSnapshot();
  const name = `kharness-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}-${size}B.db`.replace(/\.db$/, '.db');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  fs.createReadStream(file)
    .on('error', (e) => { if (!res.headersSent) fail(res, 500, `读取备份失败：${e.message}`); res.end(); })
    .on('close', () => { fs.rm(file, { force: true }, () => {}); })
    .pipe(res);
}));

// 导入只「暂存」：真替换发生在下次启动打开连接之前，见 utils/sqlitefile.js
router.post('/database/import', wrap(async (req, res) => {
  const dbio = require('../utils/dbio');
  const r = dbio.stageImport(req.body, String(req.get('x-file-name') || req.query.name || 'import.db'));
  if (r.error) return fail(res, 400, r.error);
  const counts = Object.entries(r.counts || {}).map(([k, v]) => `${k} ${v}`).join('，');
  ok(res, r, `已暂存待应用的数据库（${counts}）。重启后生效。`);
}));

router.post('/database/import/cancel', wrap((req, res) => {
  const r = require('../utils/dbio').cancelPending();
  ok(res, null, r.message);
}));

/* ---------- MCP 服务器：外部能力热插拔 ----------
   工具一旦 discover 出来就并进 toolgate，所以「启用开关 / 试跑 / 用量统计」这些都用现成的
   （见 /tools 与 /tools/:name/test）。这里只管 server 的连接与增删改。 */

router.get('/mcp/servers', wrap((req, res) => {
  ok(res, mcp.listForUi());
}));

// 建 + 按 enabled 立刻连一次（连不上也保留配置，把原因回出来，方便在设置页看到）
router.post('/mcp/servers', wrap(async (req, res) => {
  const r = mcp.create(req.body || {});
  if (r.error) return fail(res, 400, r.error);
  let connectInfo = null;
  let connectError = '';
  if (r.row && r.row.enabled) {
    try { connectInfo = await mcp.connect(r.row); } catch (e) { connectError = String((e && e.message) || e).substring(0, 400); }
  }
  ok(res, { row: mcp.rowOf(r.id), connected: !!connectInfo, tools: connectInfo ? connectInfo.tools.length : 0, error: connectError },
    connectError ? `已保存，但连接失败：${connectError}` : (connectInfo ? `已连接，发现 ${connectInfo.tools.length} 个工具` : '已保存（未启用）'));
}));

router.put('/mcp/servers/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const cur = mcp.rowOf(id);
  if (!cur) return fail(res, 404, '没有这个 MCP server');
  const r = mcp.update(id, req.body || {});
  if (r.error) return fail(res, 400, r.error);
  mcp.disconnect(id);
  let tools = 0;
  let error = '';
  if (r.row && r.row.enabled) {
    try { tools = (await mcp.connect(r.row)).tools.length; } catch (e) { error = String((e && e.message) || e).substring(0, 400); }
  }
  ok(res, { row: r.row, tools, error }, error ? `已保存，但连接失败：${error}` : `已保存${tools ? `，发现 ${tools} 个工具` : ''}`);
}));

router.delete('/mcp/servers/:id', wrap((req, res) => {
  const r = mcp.remove(Number(req.params.id));
  if (r.error) return fail(res, 404, r.error);
  ok(res, null, r.message);
}));

router.post('/mcp/servers/:id/reconnect', wrap(async (req, res) => {
  const row = mcp.rowOf(Number(req.params.id));
  if (!row) return fail(res, 404, '没有这个 MCP server');
  mcp.disconnect(row.id);
  try {
    const r = await mcp.connect(row);
    ok(res, { tools: r.tools, server_info: r.serverInfo }, `已连接，发现 ${r.tools.length} 个工具`);
  } catch (e) {
    ok(res, { tools: [], error: String((e && e.message) || e).substring(0, 400) }, '连接失败');
  }
}));

/* ---------- 内置浏览器通道：服务端排队，桌面窗口取动作并回填 ---------- */

// 长轮询取下一个动作（25s 内没动作就返回 null，让窗口那头重新挂一个）
router.get('/browser/poll', wrap(async (req, res) => {
  const action = await require('../utils/inapp').poll();
  ok(res, action);
}));

// 回填结果。id 对不上（已超时）也不报错给窗口，只说没等到
router.post('/browser/report', wrap((req, res) => {
  const inapp = require('../utils/inapp');
  const id = Number(req.body?.id);
  const done = inapp.report(id, req.body?.result, req.body?.error);
  ok(res, { accepted: done }, done ? '' : '该动作已超时或不存在');
}));

router.get('/browser/status', wrap((req, res) => {
  ok(res, require('../utils/inapp').status());
}));

// 权限规则（命令/路径/关键词/工具 × 黑白名单）
router.get('/permissions', wrap((req, res) => {
  let rows = [];
  try { rows = db.prepare('SELECT * FROM perm_rules ORDER BY id ASC').all(); } catch (e) { rows = []; }
  ok(res, { rules: rows, kinds: perms.KINDS, lists: perms.LISTS, matches: perms.MATCHES });
}));
router.post('/permissions', wrap((req, res) => {
  const v = perms.validateRule(req.body);
  if (v.error) return fail(res, 400, v.error);
  const r = v.value;
  db.prepare('INSERT INTO perm_rules (kind, list, pattern, match, enabled, note) VALUES (?, ?, ?, ?, ?, ?)')
    .run(r.kind, r.list, r.pattern, r.match, r.enabled, r.note);
  perms.reload();
  ok(res, null, '规则已添加并立即生效');
}));
router.put('/permissions/:id', wrap((req, res) => {
  const id = parseInt(req.params.id);
  const v = perms.validateRule(req.body);
  if (v.error) return fail(res, 400, v.error);
  const r = v.value;
  db.prepare('UPDATE perm_rules SET kind = ?, list = ?, pattern = ?, match = ?, enabled = ?, note = ? WHERE id = ?')
    .run(r.kind, r.list, r.pattern, r.match, r.enabled, r.note, id);
  perms.reload();
  ok(res, null, '规则已更新');
}));
router.delete('/permissions/:id', wrap((req, res) => {
  db.prepare('DELETE FROM perm_rules WHERE id = ?').run(parseInt(req.params.id));
  perms.reload();
  ok(res, null, '规则已删除');
}));
// 试跑：给定工具/命令/路径，看会被哪条规则判定（不执行任何操作）
router.post('/permissions/test', wrap((req, res) => {
  const tool = String(req.body?.tool || '');
  const command = String(req.body?.command || '');
  const paths = Array.isArray(req.body?.paths) ? req.body.paths.map(String) : [];
  ok(res, perms.test({ tool, command, paths, keywords: [String(req.body?.text || '')] }));
}));

// ---------- 文件操作撤销 / 回收站 ----------
// 快照由 utils/undo 落盘 + 入库（重启后历史步骤的「撤销」按钮依然有效）

// 读取目标的原始字节（不存在返回 null；目录标记 isDir）
async function snapshotOf(p) {
  let st = null;
  try { st = await fsp.stat(p); } catch (e) { return { existed: false, isDir: false, buf: null }; }
  if (st.isDirectory()) return { existed: true, isDir: true, buf: null };
  try { return { existed: true, isDir: false, buf: await fsp.readFile(p) }; }
  catch (e) { return { existed: true, isDir: false, buf: null }; }
}

// 记录一个可撤销操作；chatId 用于后续按会话清理
function recordUndo(targetPath, snapshot, chatId, label) {
  return undoStore.record({ ...snapshot, path: targetPath, chatId, label });
}

// 撤销一个操作：恢复文件/目录到操作前状态（原始字节丢失时明确告知不可恢复）
// 成功后把「已撤销」持久写回该条回复的 steps_json，并在正文追加撤销说明——
// 这样刷新后按钮仍是禁用态、大模型下一轮能从上下文里知道改动已不再生效、轨迹页也检索得到
router.post('/undo', wrap(async (req, res) => {
  const opId = String(req.body?.op_id || '');
  const chatId = parseInt(req.body?.chat_id);
  const messageId = parseInt(req.body?.message_id);
  // 远程操作的撤销走另一条异步通路（把快照推回远端 / 从远端回收站 rename 回来），
  // 本地那条 apply() 一行没动，避免为远程给成熟路径加 await
  const opRow = undoStore.peek(opId);
  const r = opRow && opRow.remote_id ? await undoStore.applyRemote(opId) : undoStore.apply(opId);
  if (!r.ok) return fail(res, r.error && r.error.includes('不存在') ? 404 : 409, r.error);

  let target = null;
  if (Number.isInteger(chatId) && chatId > 0) {
    target = Number.isInteger(messageId) && messageId > 0
      ? db.prepare('SELECT id, content, steps_json FROM ai_chat_messages WHERE id = ? AND chat_id = ?').get(messageId, chatId)
      : db.prepare("SELECT id, content, steps_json FROM ai_chat_messages WHERE chat_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1").get(chatId);
  }
  if (target) {
    let steps = [];
    try { steps = JSON.parse(target.steps_json || '[]'); } catch (e) { steps = []; }
    let marked = false;
    if (Array.isArray(steps)) {
      for (const st of steps) {
        if (st && st.undo_id === opId) {
          st.undone = true;
          st.undone_at = new Date().toISOString();
          st.undo_note = `用户已撤销：${r.label || st.name || ''} → ${r.path}`;
          marked = true;
        }
      }
    }
    const marker = `[撤销记录 ${opId}]`;
    let content = String(target.content || '');
    if (!content.includes(marker)) {
      content += `\n\n${marker} 操作「${r.label || ''}」已被用户撤销，${r.path} 已恢复到该操作之前的状态。请勿再假定这次改动仍然生效。`;
    }
    db.prepare('UPDATE ai_chat_messages SET content = ?, steps_json = ? WHERE id = ?')
      .run(content, marked ? JSON.stringify(steps) : target.steps_json, target.id);
    touchChatStmt.run(chatId);
  }
  ok(res, { path: r.path, label: r.label, message_id: target ? target.id : null }, r.message);
}));

// 查询撤销记录状态（前端渲染历史步骤时判断按钮是否仍可用）
router.get('/undo/:opId', wrap((req, res) => {
  const row = undoStore.peek(String(req.params.opId || ''));
  if (!row) return ok(res, { available: false, undone: false });
  ok(res, { available: !row.undone, undone: !!row.undone, path: row.path, type: row.type, label: row.label });
}));


// 删除文件：严格模式必须入回收站（绝不直接抹掉）；失败即报错，不静默降级为永久删除
async function deleteFileSafe(p, useRecycle) {
  if (!useRecycle) { fs.unlinkSync(p); return 'perm'; }
  try {
    await recycle.moveToRecycle(p);
    return 'recycle';
  } catch (e) {
    throw new Error(`入回收站失败（${e.message}），已取消删除以免不可恢复`);
  }
}


// 撤回消息：删除指定用户消息及其之后的所有消息（上下文回退）
router.post('/chat/retract', wrap((req, res) => {
  const chatId = parseInt(req.body?.chat_id);
  const messageId = parseInt(req.body?.message_id);
  if (!Number.isInteger(chatId) || chatId < 1) return fail(res, 400, '无效的对话ID');
  if (!Number.isInteger(messageId) || messageId < 1) return fail(res, 400, '无效的消息ID');
  const chat = db.prepare('SELECT id FROM ai_chats WHERE id = ? AND user_id = ?').get(chatId, 1);
  if (!chat) return fail(res, 404, '对话不存在');
  const target = db.prepare('SELECT id, content FROM ai_chat_messages WHERE id = ? AND chat_id = ?').get(messageId, chatId);
  if (!target) return fail(res, 404, '消息不存在');
  // 锚点要跟着减：删掉的正文先从锚点里扣掉，否则撤回后右侧用量会停在虚高的数字（下一轮才自愈）
  const doomed = db.prepare('SELECT content FROM ai_chat_messages WHERE chat_id = ? AND id >= ?').all(chatId, messageId);
  const dropped = doomed.reduce((a, m) => a + estimateTokens(m.content || ''), 0);
  const del = db.prepare('DELETE FROM ai_chat_messages WHERE chat_id = ? AND id >= ?').run(chatId, messageId);
  try {
    const row = db.prepare('SELECT ctx_anchor_tokens, ctx_anchor_msg_id FROM ai_chats WHERE id = ?').get(chatId);
    if (row && Number(row.ctx_anchor_tokens) > 0) {
      const kept = Math.max(0, Number(row.ctx_anchor_tokens) - dropped);
      const lastId = db.prepare('SELECT id FROM ai_chat_messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1').get(chatId);
      db.prepare('UPDATE ai_chats SET ctx_anchor_tokens = ?, ctx_anchor_msg_id = ? WHERE id = ?')
        .run(kept, lastId ? lastId.id : 0, chatId);
    }
  } catch (e) { /* 旧库无列时忽略 */ }
  touchChatStmt.run(chatId);
  ok(res, { deleted: del.changes, content: target.content }, `已撤回 ${del.changes} 条消息`);
}));

// ---------- 视觉文件内存仓库 ----------
// 上传的图片只存内存、绝不落盘；30 分钟 TTL 自动销毁，删除对话不影响（token 随时间自然失效）
const IMAGE_TTL_MS = 30 * 60 * 1000;
const IMAGE_STORE_MAX_BYTES = 80 * 1024 * 1024;
const imageStore = new Map(); // token -> { dataUrl, size, createdAt }

setInterval(() => {
  const cutoff = Date.now() - IMAGE_TTL_MS;
  for (const [k, v] of imageStore) {
    if (v.createdAt < cutoff) imageStore.delete(k);
  }
}, 10 * 60 * 1000).unref();

function imageStorePut(dataUrl) {
  // 超出总容量时按最旧优先淘汰
  const size = dataUrl.length;
  let total = 0;
  for (const v of imageStore.values()) total += v.size;
  while (total + size > IMAGE_STORE_MAX_BYTES && imageStore.size) {
    const oldestKey = [...imageStore.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0][0];
    total -= imageStore.get(oldestKey).size;
    imageStore.delete(oldestKey);
  }
  const token = crypto.randomBytes(16).toString('hex');
  imageStore.set(token, { dataUrl, size, createdAt: Date.now() });
  return token;
}

// Playground 上传视觉图片（仅内存，10MB 上限，自动销毁）
const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 }
});

router.post('/chat/upload', (req, res) => {
  chatUpload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? '图片最大 10MB' : '上传失败';
      return fail(res, 400, msg);
    }
    const file = req.file;
    if (!file) return fail(res, 400, '请选择图片文件');
    if (!/^image\//.test(file.mimetype)) return fail(res, 400, '仅支持图片文件');
    const dataUrl = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
    const token = imageStorePut(dataUrl);
    ok(res, { token });
  });
});

// 通过随机 token 查看已上传图片（token 即访问凭证，图片过期自动 404）
router.get('/chat/image/:token', (req, res) => {
  const img = imageStore.get(String(req.params.token));
  if (!img) return fail(res, 404, '图片已销毁或不存在');
  const meta = img.dataUrl.slice(5, img.dataUrl.indexOf(','));
  const mime = meta.split(';')[0] || 'image/png';
  const b64 = img.dataUrl.slice(img.dataUrl.indexOf(',') + 1);
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'private, max-age=600');
  res.end(Buffer.from(b64, 'base64'));
});

// ---------- Agent 模式：技能 + 工具 ----------

// 技能库：server/agent-skills/*.md（内置）+ server/agent-skills-custom/*.md（用户自定义导入）
// 格式遵循通用 skills 规范：frontmatter（name/description）+ 正文；放入文件即生效
const SKILLS_DIR = path.join(__dirname, '../agent-skills');

function parseSkillFile(file, raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const meta = {};
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^(\w+):\s*(.*)$/);
      if (kv) meta[kv[1]] = kv[2].trim();
    }
  }
  return {
    name: meta.name || path.basename(file).replace(/\.md$/, ''),
    description: meta.description || '',
    body: (m ? m[2] : raw).trim(),
    custom: path.resolve(file).startsWith(path.resolve(SKILLS_CUSTOM_DIR))
  };
}

function listSkills() {
  const byName = new Map();
  // 先内置后自定义：同名时自定义那份覆盖内置（用户可以拿自己的版本盖掉示例）
  for (const dir of [SKILLS_DIR, SKILLS_CUSTOM_DIR]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.md')) continue;
        try {
          const s = parseSkillFile(path.join(dir, f), fs.readFileSync(path.join(dir, f), 'utf8'));
          byName.set(s.name, s);
        } catch (e) { /* 单文件损坏跳过 */ }
      }
    } catch (e) { /* 目录不存在跳过 */ }
  }
  return [...byName.values()];
}

const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: '在服务器上以 shell 执行命令并等待其结束。工作目录由会话 /dir 决定。默认单次 360 秒超时（用户可在设置里改，0=不限制），超时会终止整棵进程树并返回已收集的部分输出。预计要跑很久（装依赖、大仓构建、watch、起服务）的命令不要用本工具，改用 run_background 异步启动再用 background_status 查进度。',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: '要执行的 shell 命令' } },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取服务器上的文本文件（相对路径基于当前工作目录，自动识别 UTF-8/GBK 编码，返回完整内容）',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '文件路径' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '覆盖式写入：用 content 整体替换目标文件，用于新建文件或确实需要整体重写的场景。修改已有文件时优先使用 edit_file，避免重写整个文件（会丢上下文、diff 也难以审阅）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径(相对当前工作目录或绝对路径)' },
          content: { type: 'string', description: '完整文件内容' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: '对已有文件做精确替换:把唯一匹配的 old_text 替换为 new_text。只改局部时优先用此工具,改动会以彩色 diff 展示给用户。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径(相对当前工作目录或绝对路径)' },
          old_text: { type: 'string', description: '要替换的原文(必须在文件中精确且唯一出现)' },
          new_text: { type: 'string', description: '替换后的新内容' }
        },
        required: ['path', 'old_text', 'new_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: '列出目录内容（目录名以 / 结尾）',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '目录路径，默认当前工作目录' } },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: '按正则表达式递归搜索目录下所有文本文件的内容，返回「文件:行号: 匹配行」列表。自动跳过 node_modules/.git/dist 等目录和二进制文件。查代码、找关键字优先用本工具，比在 shell 里敲 grep/findstr 更快更稳。（旧名 search_files 仍可用）',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '正则表达式（JavaScript 语法）' },
          path: { type: 'string', description: '搜索的起始目录，默认当前工作目录' },
          include: { type: 'string', description: '文件名过滤，如 *.js、*.{ts,vue}（可选）' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: '按通配符模式递归查找文件并只返回路径列表（不看内容）。支持 **（跨目录）、*（文件名内）、?（单字符）、{a,b}（多选一）。pattern 不含 / 时匹配任意层级的文件名。自动排除 .git/node_modules/__pycache__/.venv 等噪音目录，最多 500 条，输出相对路径。定位文件比 list_dir 逐层翻更快。（旧名 find_files 仍可用）',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '通配符模式，如 **/*.ts、src/*.{js,vue}、package.json' },
          path: { type: 'string', description: '查找的起始目录，默认当前工作目录' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: '抓取网页/接口内容并转为纯文本（自动去除 HTML 标签/脚本）。用于查文档、看 API 返回等。仅支持 http/https。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '完整的 http/https 地址' } },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'load_skill',
      description: '加载一个技能的完整说明（专项知识库/操作手册）。技能详情不占用系统提示词，执行对应专项任务前必须先调用本工具获取完整步骤。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: '技能名称' } },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: '删除文件。任何模式下都会在操作旁提供「撤销」按钮：撤销可把文件恢复到删除前状态。严格审批模式下必须先入系统回收站（入站失败则中止删除）；默认/免除模式下直接删除但保留快照。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '要删除的文件路径（相对工作目录或绝对路径）' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_dir',
      description: '删除目录（整个目录树）。执行前先做整树快照，操作旁提供「撤销」按钮可原样恢复目录；快照容量超限（约 3000 个文件或 200MB）会拒绝执行。严格审批模式下删除会先放入系统回收站。删除文件请用 delete_file。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '要删除的目录路径（相对工作目录或绝对路径）' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_dir',
      description: '创建目录（可递归创建多级）。创建后操作旁提供撤销按钮，可删除刚创建的目录。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '要创建的目录路径' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'rename_file',
      description: '重命名/移动文件。操作记录撤销快照，可恢复原名。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '原文件路径' },
          new_path: { type: 'string', description: '新文件路径' }
        },
        required: ['path', 'new_path']
      }
    }
  }
];

// ---------- 子智能体宿主 ----------
// subagent.js 不 require 本文件（会成环），要用的能力在这里注入：
//   execTool      —— 复用同一套工具执行（路径防护 / 编码自适配 / 黑名单都白嫖）
//   builtinToolDefs —— 按白名单挑内置工具定义
//   emitSubagent   —— 把子智能体进度转成父会话 SSE 上的一条 subagent 事件
// 每个会话开始流式响应时把自己的 send 注册进来，结束即摘除。
const subagentSenders = new Map();   // chatId -> send(evt)
subagent.setHost({
  defaultCwd: AGENT_DEFAULT_CWD,
  execTool: (...a) => execTool(...a),
  redact: (s) => redactSecrets(s),
  resolveToolName: (n) => resolveToolName(n),
  builtinToolDefs: (names) => AGENT_TOOLS.filter(t => names.has(t.function?.name)),
  emitSubagent: (evt) => {
    const send = subagentSenders.get(evt.chat_id);
    if (!send) return;
    try { send({ t: 'subagent', ...evt }); } catch (e) { /* 流已关，进度丢掉无所谓 */ }
  },
});

// 右栏「子智能体」面板用：列表 / 详情 / 停止 / 删除
router.get('/subagents', wrap((req, res) => {
  const cid = parseInt(req.query?.chat_id);
  ok(res, subagent.list(Number.isInteger(cid) && cid > 0 ? cid : null));
}));

router.get('/subagents/:id', wrap((req, res) => {
  const d = subagent.detail(String(req.params.id || ''));
  if (d.error) return fail(res, 404, d.error);
  ok(res, d);
}));

router.post('/subagents/kill', wrap((req, res) => {
  const r = subagent.kill(String(req.body?.agent_id || ''));
  if (r.error) return fail(res, 400, r.error);
  ok(res, null, r.message);
}));

router.post('/subagents/delete', wrap((req, res) => {
  const r = subagent.remove(String(req.body?.agent_id || ''));
  if (r.error) return fail(res, 400, r.error);
  ok(res, null, r.message);
}));

// 人工直接下发一个子智能体任务（不经过主模型）
router.post('/subagents/spawn', wrap((req, res) => {
  const r = subagent.spawn({
    name: req.body?.name, task: req.body?.task, model: req.body?.model,
    cwd: req.body?.cwd, chatId: parseInt(req.body?.chat_id) || null,
  });
  if (r.error) return fail(res, 400, r.error);
  ok(res, r, `已派出子智能体 ${r.name || r.id}`);
}));

// ---------- 侧栏提问（Sidebar AI）----------
// 只读、硬锁工作目录的旁路小助手（引擎见 utils/sidebar.js）。
// 它不写文件、不执行命令、不进主会话上下文，所以主 Agent 正在跑时也能用。
sidebar.setHost({
  defaultCwd: AGENT_DEFAULT_CWD,
  execTool: (...a) => execTool(...a),
  resolveToolName: (n) => resolveToolName(n),
  builtinToolDefs: (names) => AGENT_TOOLS.filter(t => names.has(t.function?.name)),
});

// 托管模式（监工）的宿主：监工自己只拿只读 + 浏览器；改动全部通过自调 /chat 交给主智能体，
// 所以审批那一套不必注入给它（主循环里本来就有）。
orchestrator.setHost({
  defaultCwd: AGENT_DEFAULT_CWD,
  execTool: (...a) => execTool(...a),
  resolveToolName: (n) => resolveToolName(n),
  builtinToolDefs: (names) => AGENT_TOOLS.filter(t => names.has(t.function?.name)),
});

// 每个会话同时只跑一场托管；停止 = 断 SSE，这里再留一个手动掐的口子
const hostedRuns = new Map();

router.post('/hosted/run', (req, res) => {
  const chatId = parseInt(req.body?.chat_id);
  const content = String(req.body?.content || '');
  const relay = !!req.body?.relay;
  if (!Number.isInteger(chatId) || chatId <= 0) return fail(res, 400, '缺少 chat_id');
  if (!content.trim() && !relay) return fail(res, 400, '任务不能为空');
  if (hostedRuns.has(chatId)) return fail(res, 409, '这个会话已经有一场托管在跑了，先停掉再开');

  const controller = new AbortController();
  hostedRuns.set(chatId, controller);
  res.on('close', () => {
    if (hostedRuns.get(chatId) === controller) hostedRuns.delete(chatId);
    try { controller.abort(); } catch (e) { /* 已结束 */ }
  });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (obj) => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    } catch (e) { /* 客户端已断开 */ }
  };

  (async () => {
    try {
      await orchestrator.runTurn({
        chatId, content,
        supervisorModel: req.body?.supervisor_model,
        workerModel: req.body?.worker_model,
        relay: !!req.body?.relay,          // 主智能体跑完后的「回叫」：不落新的用户消息
        onEvent: send,
        signal: controller.signal,
      });
    } catch (e) {
      send({ t: 'error', message: String(e?.message || e).substring(0, 300) });
    } finally {
      if (hostedRuns.get(chatId) === controller) hostedRuns.delete(chatId);
      try { res.end(); } catch (e) { /* 已关 */ }
    }
  })();
});

router.post('/hosted/stop', wrap((req, res) => {
  const chatId = parseInt(req.body?.chat_id);
  const c = hostedRuns.get(chatId);
  if (!c) return ok(res, { stopped: false }, '这一场托管已经结束了');
  try { c.abort(); } catch (e) { /* 忽略 */ }
  hostedRuns.delete(chatId);
  ok(res, { stopped: true });
}));

router.get('/hosted/status', wrap((req, res) => {
  const chatId = parseInt(req.query?.chat_id);
  const running = Number.isInteger(chatId) && hostedRuns.has(chatId);
  let last = null;
  try {
    last = db.prepare('SELECT id, status, goal, tasks_assigned, created_at FROM ai_hosted_runs WHERE chat_id = ? ORDER BY id DESC LIMIT 1').get(chatId || -1) || null;
  } catch (e) { last = null; }
  ok(res, { running, last, busy: [...hostedRuns.keys()] });
}));

router.get('/sidebar/threads', wrap((req, res) => {
  ok(res, sidebar.listThreads());
}));

router.get('/sidebar/thread', wrap((req, res) => {
  const d = sidebar.threadWithMessages(req.query?.id);
  if (d.error) return fail(res, 404, d.error);
  ok(res, d);
}));

router.post('/sidebar/thread', wrap((req, res) => {
  const r = sidebar.createThread({
    title: req.body?.title, cwd: req.body?.cwd, modelRowId: req.body?.model_row_id,
  });
  ok(res, r);
}));

router.post('/sidebar/thread/rename', wrap((req, res) => {
  const r = sidebar.renameThread(req.body?.id, req.body?.title);
  if (r.error) return fail(res, 400, r.error);
  ok(res, null, '已改名');
}));

router.post('/sidebar/thread/delete', wrap((req, res) => {
  const r = sidebar.deleteThread(req.body?.id);
  if (r.error) return fail(res, 400, r.error);
  ok(res, null, '已删除');
}));

// 提问：SSE 流式。客户端断开（关面板 / 点停止）即 abort 这一轮。
router.post('/sidebar/chat', (req, res) => {
  const content = String(req.body?.content || '');
  const threadId = parseInt(req.body?.thread_id) || 0;
  const modelRowId = parseInt(req.body?.model_row_id);
  const cwd = typeof req.body?.cwd === 'string' ? req.body.cwd.trim() : '';
  if (!content.trim()) return fail(res, 400, '问题不能为空');
  if (cwd) {
    try {
      if (!fs.statSync(cwd).isDirectory()) return fail(res, 400, `不是目录：${cwd}`);
    } catch (e) { return fail(res, 400, `工作目录不存在或不可访问：${cwd}`); }
  }

  const controller = new AbortController();
  res.on('close', () => { try { controller.abort(); } catch (e) { /* 已结束 */ } });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (obj) => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    } catch (e) { /* 客户端已断开 */ }
  };

  (async () => {
    try {
      await sidebar.runTurn({
        threadId, content, cwd,
        model: Number.isInteger(modelRowId) && modelRowId > 0 ? modelRowId : undefined,
        onEvent: send, signal: controller.signal,
      });
    } catch (e) {
      send({ t: 'error', message: String(e?.message || e).substring(0, 300) });
    } finally {
      res.end();
    }
  })();
});

// ---------- AI 监工（阶段 3）----------
// 按项目根的 kh.checks.md 驱动内置浏览器跑一轮网页自测：只出报告与证据，不改代码。
// 清单在哪：项目根优先，其次会话 cwd（往上找最多 4 层）。

function superviseScope(body = {}) {
  const chatId = parseInt(body.chat_id);
  if (Number.isInteger(chatId) && chatId > 0) {
    const row = db.prepare('SELECT c.cwd, p.root_path FROM ai_chats c LEFT JOIN projects p ON p.id = c.project_id WHERE c.id = ?').get(chatId);
    if (row) return { cwd: row.cwd || '', projectRoot: row.root_path || '' };
  }
  const p = String(body.cwd || '').trim();
  return { cwd: p || AGENT_DEFAULT_CWD, projectRoot: '' };
}

router.get('/supervise/checks', wrap((req, res) => {
  const info = supervisor.checks.load(superviseScope(req.query));
  ok(res, { exists: info.exists, file: info.file, cases: info.cases, errors: info.errors, bytes: info.bytes || 0, template: supervisor.checks.TEMPLATE });
}));

router.get('/supervise/runs', wrap((req, res) => {
  ok(res, supervisor.listRuns(parseInt(req.query?.limit) || 20));
}));

// 跑一轮：SSE 推进度。关掉面板 = 断开 = 停止后续用例。
router.post('/supervise/run', (req, res) => {
  const scope = superviseScope(req.body);
  const modelRowId = parseInt(req.body?.model_row_id);
  const diagnose = !(req.body?.diagnose === false || req.body?.diagnose === 'false');
  let stopFlag = false;
  res.on('close', () => { stopFlag = true; });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (obj) => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    } catch (e) { /* 客户端已断开 */ }
  };
  (async () => {
    try {
      await supervisor.run({
        ...scope, diagnose, modelRowId: Number.isInteger(modelRowId) && modelRowId > 0 ? modelRowId : undefined,
        onEvent: send, shouldStop: () => stopFlag,
      });
    } catch (e) {
      send({ t: 'error', message: String(e?.message || e).substring(0, 300) });
    } finally {
      res.end();
    }
  })();
});

// 按行计算两文本差异,输出与 opencode 编辑块一致的展示结构:
// 每行带 1 起始行号(最终文件中的序号)。删除行显示其变更位置的行号,新增/上下文行
// 依次递增(一增一删同号计)。随后把变化的连续行聚合成 hunks,每个 hunk 带上、下各
// 4 行上下文;相距超过 8 行的两个 hunk 不会共享上下文,块间以 gap 标记(……更多行)省略。
function computeUnifiedDiff(oldText, newText) {
  const aRaw = (oldText || '').split('\n');
  const bRaw = (newText || '').split('\n');

  // 公共前后缀修剪:edit_file 是局部替换,修剪后 LCS 规模骤减,同时规避大文件 O(n*m) 内存膨胀
  let start = 0;
  while (start < aRaw.length && start < bRaw.length && aRaw[start] === bRaw[start]) start++;
  let endA = aRaw.length, endB = bRaw.length;
  while (endA > start && endB > start && aRaw[endA - 1] === bRaw[endB - 1]) { endA--; endB--; }
  const a = aRaw.slice(start, endA), b = bRaw.slice(start, endB);
  const n = a.length, m = b.length;

  const ops = []; // {t:'ctx'|'add'|'del', text:string},行号统一在下一步分配
  for (let k = 0; k < start; k++) ops.push({ t: 'ctx', text: aRaw[k] });
  if (n * m > 4 * 1024 * 1024) {
    // 修剪后仍过大(如整文件重写且无公共行):退化为整块删除+新增,不再做 LCS
    for (let i = 0; i < n; i++) ops.push({ t: 'del', text: a[i] });
    for (let j = 0; j < m; j++) ops.push({ t: 'add', text: b[j] });
  } else if (n > 0 || m > 0) {
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    // 从头追踪得到有序操作序列;优先删后增,保证"5- / 5+"同号成对
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { ops.push({ t: 'ctx', text: a[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: 'del', text: a[i] }); i++; }
      else { ops.push({ t: 'add', text: b[j] }); j++; }
    }
    while (i < n) { ops.push({ t: 'del', text: a[i] }); i++; }
    while (j < m) { ops.push({ t: 'add', text: b[j] }); j++; }
  }
  for (let k = endA; k < aRaw.length; k++) ops.push({ t: 'ctx', text: aRaw[k] });

  // 分配行号:ctx/add 占用新文件行号依次递增;del 不递增,与紧随的新增行同号
  let curNew = 1;
  for (const op of ops) { op.new = curNew; if (op.t !== 'del') curNew++; }

  // 聚合成变化块:间隔 ≤8 行上下文的连续变化合并为一个 hunk(否则上下文会重叠重复),
  // 超过 8 行间隔的拆分展示,块间以 gapBefore 标记中间有省略行
  const changes = [];
  ops.forEach((op, idx) => { if (op.t !== 'ctx') changes.push(idx); });
  const groups = [];
  let gs = -1, prev = -1;
  for (const idx of changes) {
    if (gs === -1) gs = idx;
    else if (idx - prev - 1 > 8) { groups.push([gs, prev]); gs = idx; }
    prev = idx;
  }
  if (gs !== -1) groups.push([gs, prev]);

  const segments = [];
  groups.forEach(([from, to], g) => {
    const before = [];
    for (let p = from - 1, up = 0; p >= 0 && ops[p].t === 'ctx' && up < 4; p--, up++) before.unshift(ops[p]);
    const after = [];
    for (let q = to + 1, dn = 0; q < ops.length && ops[q].t === 'ctx' && dn < 4; q++, dn++) after.push(ops[q]);
    segments.push({ before, change: ops.slice(from, to + 1), after, gapBefore: g > 0 });
  });
  return segments;
}

// 文件 diff 展示数据:展平成 [{kind:'ctx'|'add'|'del'|'gap', line, text}] 列表,
// gap 行(……更多行)表示两个 hunk 之间被省略的未变更内容
function buildFileDiff(oldText, newText) {
  const out = [];
  for (const s of computeUnifiedDiff(oldText, newText)) {
    if (s.gapBefore) out.push({ kind: 'gap', line: null, text: '……更多行' });
    for (const l of s.before) out.push({ kind: 'ctx', line: l.new, text: l.text });
    // 合并 hunk 内部夹带的未变行同样是 ctx,按其实际类型映射,不得误标为 add
    for (const l of s.change) out.push({ kind: l.t, line: l.new, text: l.text });
    for (const l of s.after) out.push({ kind: 'ctx', line: l.new, text: l.text });
  }
  return out;
}

// 新建文件:整体作为 add 展示;超长文件截断为头尾各 300 行,中间以 gap 标记省略
function buildNewFileDiff(content) {
  const lines = (content || '').split('\n');
  const out = lines.map((text, i) => ({ kind: 'add', line: i + 1, text }));
  if (out.length > 600) {
    return [...out.slice(0, 300), { kind: 'gap', line: null, text: '……更多行' }, ...out.slice(-300)];
  }
  return out;
}

const fsp = fs.promises;

// ---------- Tool Call 参数严格校验（模型常捏造参数名/产出非法 JSON） ----------
// 轻量 JSON 修复：去尾逗号、全角引号/冒号/逗号、包裹非 JSON 输出
function repairJson(raw) {
  let s = String(raw || '').trim();
  // 剥离 markdown 代码围栏与前后缀文本，取首个 {...} 或 [...] 块
  const m = s.match(/[[{][\s\S]*[\]}]/);
  if (m) s = m[0];
  s = s.replace(/[，]/g, ',').replace(/[：]/g, ':').replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  s = s.replace(/,\s*([}\]])/g, '$1');
  return s;
}

// 内置 + 已启用的扩展工具（外部 API 接口 / 后台任务 / 记忆 / ask_user）的参数 schema
function allToolSchemas() {
  return { ...TOOL_SCHEMAS, ...toolgate.schemas() };
}

// 本次请求实际可用的工具清单（扩展工具按设置里的开关动态挂载，改完不用重启）
function activeAgentTools() {
  return AGENT_TOOLS.concat(toolgate.definitions());
}

// 上游要求 assistant.tool_calls[].arguments 必须是合法 JSON 字符串。
// 模型输出被截断或吐空时 rawArgs 可能是残缺片段（如 `{"path":"foo`），
// 原样回喂会让下一个请求整包被拒成 400「Assistant tool call arguments must be valid JSON」，
// 本轮彻底走不动。所以进上游消息前先修复，修不好退化成 {} —— 参数缺失另有
// validateToolArgs 那条路径负责把可行动的提示回喂给模型。
function safeArgsJson(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '{}';
  try {
    const o = JSON.parse(s);
    return (o && typeof o === 'object' && !Array.isArray(o)) ? s : '{}';
  } catch (e) { /* 继续尝试修复 */ }
  try {
    const o = JSON.parse(repairJson(s));
    return (o && typeof o === 'object' && !Array.isArray(o)) ? JSON.stringify(o) : '{}';
  } catch (e) { return '{}'; }
}

// 就地修掉上游消息里所有非法的 tool_call 参数，返回改动条数。
// 用于「已经发出去过坏参数、上游开始持续 400」时的自愈重试。
function sanitizeUpstreamToolCalls(list) {
  let fixed = 0;
  for (const m of list) {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    for (const c of m.tool_calls) {
      const raw = c?.function?.arguments;
      const ok = safeArgsJson(raw);
      if (ok !== raw) {
        if (!c.function) c.function = { name: c?.function?.name || '', arguments: ok };
        else c.function.arguments = ok;
        fixed++;
      }
    }
  }
  return fixed;
}

// 上游因「工具调用参数不是合法 JSON」而拒绝整个请求的特征
function isToolArgsError(status, body) {
  return status === 400 && /arguments must be valid JSON|tool call.*arguments|invalid json.*arguments/i.test(String(body || ''));
}

// 返回 null = 通过；返回 string = 给 AI 的校验错误（作为 tool_result 触发反思重试）
function validateToolArgs(name, args) {
  const schema = allToolSchemas()[resolveToolName(name)];
  if (!schema) return null;
  const errs = [];
  for (const [key, rule] of Object.entries(schema)) {
    const v = args?.[key];
    if (v === undefined || v === null || v === '') {
      if (rule.required) errs.push(`缺少必填参数 "${key}"（${rule.desc}）`);
      continue;
    }
    if (rule.type === 'string' && typeof v !== 'string') errs.push(`参数 "${key}" 应为字符串，实际为 ${typeof v}`);
  }
  if (errs.length) {
    const expected = Object.entries(schema).map(([k, r]) => `"${k}"${r.required ? '(必填)' : '(可选)'}: ${r.desc}`).join(', ');
    return `参数校验失败：${errs.join('；')}。工具 ${name} 的正确参数：${expected}。请修正后重试。`;
  }
  return null;
}

// 错误分类：是否 AI 无能为力（不允许反复重试浪费 token）
function isFatalToolError(name, args, errText) {
  const e = String(errText || '');
  return /ENOENT|EACCES|EPERM|不存在|没有写权限|权限|not found|no such file|is not a directory|Access is denied|拒绝访问/i.test(e);
}

// 路径安全防护（跨平台，文件类工具在执行前统一调用）：
// 1) 项目会话硬边界：目标真实路径必须位于项目根内（符号链接/junction 解析后也不得逃逸，bypass 不越过）
// 2) 自由会话：表面路径在工作目录内、但真实路径经链接逃出 → 拒绝并提示（防止链接攻击绕过审批）
// 返回 null = 放行；{ error } = 拒绝（作为 tool_result 返回给 AI 反思修正）
async function guardTargetPath(raw, cwd, projectRoot) {
  const p = path.resolve(cwd, String(raw ?? '.'));
  let real = null;
  try {
    real = await fsp.realpath(p);
  } catch (e) {
    if (e.code !== 'ENOENT') return { error: `路径不可访问：${p}（${e.message}）` };
    // 目标不存在（新建文件场景）：逐级向上找最近存在的祖先目录，以其真实路径为基拼接
    let anc = path.dirname(p);
    let ancReal = null;
    for (;;) {
      try { ancReal = await fsp.realpath(anc); break; } catch (e2) {
        if (e2.code !== 'ENOENT') return { error: `路径不可访问：${p}（${e2.message}）` };
        const next = path.dirname(anc);
        if (next === anc) return { error: `路径不可解析：${p}` };
        anc = next;
      }
    }
    real = path.join(ancReal, path.relative(anc, p));
  }

  if (projectRoot) {
    let rootReal = null;
    try { rootReal = await fsp.realpath(path.resolve(projectRoot)); } catch (e) {
      return { error: `项目根目录不可访问：${projectRoot}` };
    }
    if (!insideRoot(real, rootReal)) {
      return { error: `访问被拒绝：项目会话只能操作项目目录内的路径。目标 ${p} 实际指向 ${real}，位于项目根 ${projectRoot} 之外（注意：不得通过符号链接或 .. 越出项目）。请改用项目内的路径。` };
    }
    return null;
  }

  // 自由会话：表面路径在 cwd 内但真实位置逃出 cwd → 链接攻击提示
  const surfIn = insideRoot(p, cwd);
  let cwdReal = cwd;
  try { cwdReal = await fsp.realpath(cwd); } catch (e) { /* cwd 不可解析时退回表面路径 */ }
  if (surfIn && !insideRoot(real, cwdReal)) {
    return { error: `目标路径是指向工作目录之外的符号链接（${p} → ${real}）。已被安全策略拦截；如确需访问该位置请使用绝对路径并让用户确认。` };
  }
  return null;
}

// 递归搜索/查找时跳过的目录（依赖产物与版本库等）
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.venv', 'venv', '__pycache__', '.idea', '.vscode', '.kh-undo', '.pytest_cache', '.turbo', '.parcel-cache', 'coverage']);

// 通配符转正则：** 跨目录、* 单段内任意、? 单字符、{a,b} 多选一；其余字符按字面匹配
function globToRx(pat) {
  const conv = (seg) => String(seg)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0001/g, '.*');
  let re = '';
  let i = 0;
  while (i < pat.length) {
    if (pat.startsWith('**/', i)) { re += '(?:.*/)?'; i += 3; continue; }
    if (pat.startsWith('**', i)) { re += '.*'; i += 2; continue; }
    if (pat[i] === '{') {
      const end = pat.indexOf('}', i + 1);
      if (end === -1) { re += conv(pat[i]); i++; continue; }
      re += '(?:' + pat.slice(i + 1, end).split(',').map(conv).join('|') + ')';
      i = end + 1;
      continue;
    }
    re += conv(pat[i]);
    i++;
  }
  return new RegExp('^' + re + '$', 'i');
}

// 模糊匹配（服务端）：子序列 + 编辑距离容错，用于搜索/检索的容错
function fuzzyMatchServer(haystack, needle) {
  if (!needle) return true;
  const t = String(haystack).toLowerCase();
  const q = String(needle).toLowerCase().trim();
  if (!q) return true;
  if (t.includes(q)) return true;
  let ti = 0, qi = 0;
  while (ti < t.length && qi < q.length) { if (t[ti] === q[qi]) qi++; ti++; }
  if (qi === q.length) return true;
  if (q.length <= 8) {
    const words = t.split(/[\s\-_\/\.]+/);
    for (const w of words) {
      if (levenshteinServer(w, q) <= 1) return true;
      if (q.length >= 4 && levenshteinServer(w, q) <= 2) return true;
    }
  }
  return false;
}
function levenshteinServer(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 3;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

// 远程执行层要用到本文件的差异算法与超时设置，注入而不是复制一份（同 orchestrator 的做法）
remoteexec.setHost({ buildFileDiff, buildNewFileDiff, decodeTextSmart, getCmdTimeoutMs });

/** 这个会话属于哪台远程主机（null = 本机）。提示词与 execTool 都要用，收在一处查。 */
function remoteHostFor(chatId) {
  if (!chatId) return null;
  const rid = db.prepare('SELECT remote_id FROM ai_chats WHERE id = ?').get(chatId)?.remote_id;
  if (!rid) return null;
  return db.prepare('SELECT * FROM ai_remote_hosts WHERE id = ?').get(rid) || null;
}

async function execTool(rawName, args, cwd, holder = { child: null }, projectRoot = null, readonlyMode = false, approvalModeNow = 'default', chatId = null, ctx = {}) {
  // holder 传 null 会让 run_command 的收尾（holder.child = null）在子进程回调里抛
  // TypeError —— 那地方不在任何 promise 链上，整个服务进程会被未捕获异常带走。
  // 侧栏/托管这类嵌套调用方本来就常传 null，这里统一兜一层。
  if (!holder || typeof holder !== 'object') holder = { child: null };
  // 旧工具名兼容：模型沿用 search_files / find_files 时按新名执行（清单里只出新的 grep / glob）
  const name = resolveToolName(rawName);
  // 只读模式：禁止一切修改/执行类工具，仅允许查看（read/list/grep/glob/web_fetch/load_skill 与只读扩展工具）
  // 内置浏览器同理：开页面/读结构算查看，点击/输入/按键算改动（可能提交表单），只读模式下拦掉
  const MUTATE_TOOLS = new Set(['run_command', 'run_background', 'write_file', 'edit_file', 'delete_file', 'delete_dir', 'create_dir', 'rename_file',
    'browser_click', 'browser_type', 'browser_press', 'browser_select']);
  if (readonlyMode && MUTATE_TOOLS.has(name)) {
    return { error: '只读模式已开启：当前禁止修改文件、执行命令与启动后台任务（用户可通过界面 /mode read-only 关闭）。请仅使用查看类工具，或向用户说明需要写权限才能继续。' };
  }
  // 只读模式同样挡住「没自声明只读」的 MCP 工具：第三方能力无法证明自己不写文件
  if (readonlyMode) {
    const pol = toolgate.gatePolicy(name);
    if (pol.mcp && !pol.readOnly) {
      return { error: `只读模式已开启：MCP 工具 ${name} 未声明 readOnlyHint，无法确认它只做查看，已拒绝执行。请让用户关闭只读模式，或到设置页把它加入白名单。` };
    }
  }
  // 远程会话：命令与文件类工具改走 SSH/SFTP 执行层（utils/remoteexec.js），
  // 路径边界、审批、只读门这些前置判断都已经在上面跑过了，两边规则一致。
  // 与文件系统无关的工具（web_fetch / 记忆 / 子智能体 / MCP / 内置浏览器）返回 undefined，继续走本地。
  // 注意：连接被删但会话还挂着 remote_id 时**必须报错**，不能退回本地执行 ——
  // 否则 /srv/app 这类远端路径会被 path.resolve 到本机盘符上真写文件。
  const remoteId = chatId ? db.prepare('SELECT remote_id FROM ai_chats WHERE id = ?').get(chatId)?.remote_id : null;
  if (remoteId) {
    const hostRow = db.prepare('SELECT * FROM ai_remote_hosts WHERE id = ?').get(remoteId);
    if (!hostRow) return { error: `这个会话属于远程连接（id=${remoteId}），但连接已被删除，无法执行 ${name}。请重新建立连接或改用本地会话。` };
    const r = await remoteexec.execRemoteTool(hostRow, name, args, cwd, { projectRoot, chatId, holder });
    if (r !== undefined) return r;
  }
  // 文件类工具：先过路径安全防护
  if (FILE_TARGET_TOOLS.has(name)) {
    const guard = await guardTargetPath(name === 'grep' || name === 'glob' ? (args?.path || '.') : args?.path, cwd, projectRoot);
    if (guard) return guard;
  }
  try {
    // 开关型扩展工具（外部 API 接口 + 后台任务/记忆/ask_user）：未启用时明确告知模型，避免它反复尝试
    if (toolgate.isGateTool(name)) return await toolgate.run(name, args, Object.assign({ chatId, cwd }, ctx));
    switch (name) {
      case 'run_command': {
        // 单次超时（设置项 cmd_timeout_seconds，0=不限）；到点杀进程树并回喂部分输出。
        // 用户也可点操作条上的「超时」按钮提前触发同一逻辑（holder.manualTimeout），会话不中断。
        return await runShellCommand(String(args.command || ''), cwd, holder, getCmdTimeoutMs());
      }
      case 'read_file': {
        const p = path.resolve(cwd, String(args.path || ''));
        const d = decodeTextSmart(await fsp.readFile(p));
        // 不做长度截断：完整返回，上下文窗口 + 自动压缩兜底
        return { output: d || '(空文件)' };
      }
      case 'write_file': {
        const p = path.resolve(cwd, String(args.path || ''));
        const content = String(args.content ?? '');
        let prev = null;
        try { prev = decodeTextSmart(await fsp.readFile(p)); } catch (e) {/* 不存在=新建 */}
        // 记录撤销快照（原始字节；覆盖/新建前的状态）
        const snap = await snapshotOf(p);
        const opId = recordUndo(p, { type: 'file', buf: snap.buf, existed: snap.existed }, chatId, `写入 ${path.basename(p)}`);
        await fsp.writeFile(p, content);
        const diff = prev === null ? buildNewFileDiff(content) : buildFileDiff(prev, content);
        return {
          output: `已${prev === null ? '创建' : '覆盖'} ${p}(${content.length} 字符)`,
          diff, path: p, new_file: prev === null, undo_id: opId
        };
      }
      case 'edit_file': {
        const p = path.resolve(cwd, String(args.path || ''));
        const oldText = String(args.old_text ?? '');
        const newText = String(args.new_text ?? '');
        if (!oldText) return { error: 'edit_file:old_text 不能为空', path: p };
        let prev;
        try { prev = decodeTextSmart(await fsp.readFile(p)); }
        catch (e) { return { error: `edit_file:目标文件不存在:${p}`, path: p }; }
        // 换行符自适应：模型常把 CRLF 文件里的原文写成 LF，导致精确匹配失败
        let needle = oldText, replacement = newText, matched = prev.indexOf(needle);
        if (matched === -1 && /\r\n/.test(prev)) {
          const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
          const lf = (s) => s.replace(/\r\n/g, '\n');
          if (prev.indexOf(crlf(oldText)) !== -1) { needle = crlf(oldText); replacement = crlf(newText); }
          else if (oldText.includes('\n') && prev.indexOf(lf(oldText)) !== -1) { needle = lf(oldText); replacement = lf(newText); }
          matched = prev.indexOf(needle);
        }
        if (matched === -1) {
          return { error: `edit_file:未找到要替换的原文(请先 read_file 确认内容一致)`, path: p };
        }
        if (prev.indexOf(needle, matched + needle.length) !== -1) {
          return { error: `edit_file:原文出现多次,匹配不唯一,未做任何修改,请用 read_file 确认并给出更长的唯一片段`, path: p };
        }
        const next = prev.slice(0, matched) + replacement + prev.slice(matched + needle.length);
        // 记录撤销快照（编辑前完整原始字节）
        const snap = await snapshotOf(p);
        const opId = recordUndo(p, { type: 'file', buf: snap.buf, existed: true }, chatId, `编辑 ${path.basename(p)}`);
        await fsp.writeFile(p, next);
        return {
          output: `已编辑 ${p}`,
          diff: buildFileDiff(prev, next),
          path: p,
          new_file: false,
          undo_id: opId
        };
      }
      case 'delete_file': {
        const p = path.resolve(cwd, String(args.path || ''));
        const snap = await snapshotOf(p);
        if (!snap.existed) return { error: `delete_file:目标文件不存在:${p}`, path: p };
        if (snap.isDir) return { error: `delete_file:目标是目录(${p})，本工具只删除文件`, path: p };
        // 任何模式下都先记快照；严格模式必须入回收站，非严格模式直接删除但可用快照恢复
        const strict = approvalModeNow === 'strict';
        const opId = recordUndo(p, { type: 'delete', buf: snap.buf, existed: true, isDir: false }, chatId, `删除 ${path.basename(p)}`);
        let how = '已永久删除（可撤销恢复）';
        if (strict) {
          try { await deleteFileSafe(p, true); how = '已移入系统回收站（可撤销恢复）'; }
          catch (e) { return { error: `${e.message}`, path: p, undo_id: opId }; }
        } else {
          fs.unlinkSync(p);
        }
        return { output: `已删除 ${p}（${how}）`, path: p, undo_id: opId, deleted: true };
      }
      case 'delete_dir': {
        const p = path.resolve(cwd, String(args.path || ''));
        let st = null;
        try { st = await fsp.stat(p); } catch (e) { return { error: `delete_dir:目录不存在:${p}`, path: p }; }
        if (!st.isDirectory()) return { error: `delete_dir:目标不是目录:${p}（删除单个文件请用 delete_file）`, path: p };
        if (path.parse(p).root === p) return { error: `delete_dir:拒绝删除文件系统根目录 ${p}`, path: p };
        // 先做整树快照：快照失败（超限/无权限）就不删除，保证「任何删除都可撤销」
        const opId = undoStore.recordTree({ path: p, chatId, label: `删除目录 ${path.basename(p)}` });
        if (!opId || opId.error) return { error: `delete_dir:${(opId && opId.error) || '快照失败'}，已取消删除`, path: p };
        // 严格模式必须入回收站；非严格模式回收站不可用时退回递归删除（快照已在，仍可撤销）
        let how;
        try {
          await deleteFileSafe(p, true);
          how = '已移入系统回收站（可用撤销整树恢复）';
        } catch (e) {
          if (approvalModeNow === 'strict') return { error: `${e.message}`, path: p, undo_id: opId };
          fs.rmSync(p, { recursive: true, force: true });
          how = '已递归删除（可用撤销整树恢复）';
        }
        return { output: `已删除目录 ${p}（${how}）`, path: p, undo_id: opId, deleted: true };
      }
      case 'create_dir': {
        const p = path.resolve(cwd, String(args.path || ''));
        if (fs.existsSync(p)) return { error: `create_dir:目录已存在:${p}`, path: p };
        const opId = recordUndo(p, { type: 'dir', buf: null, existed: false }, chatId, `创建目录 ${path.basename(p)}`);
        fs.mkdirSync(p, { recursive: true });
        return { output: `已创建目录 ${p}`, path: p, undo_id: opId };
      }
      case 'rename_file': {
        const p = path.resolve(cwd, String(args.path || ''));
        const np = path.resolve(cwd, String(args.new_path || args.to || ''));
        if (!fs.existsSync(p)) return { error: `rename_file:原文件不存在:${p}`, path: p };
        const opId = recordUndo(np, { type: 'rename', buf: null, existed: true, oldPath: p }, chatId, `重命名 ${path.basename(p)}`);
        fs.renameSync(p, np);
        return { output: `已重命名 ${p} → ${np}`, path: np, new_file: false, undo_id: opId };
      }
      case 'list_dir': {
        const p = path.resolve(cwd, String(args.path || '.'));
        const list = await fsp.readdir(p, { withFileTypes: true });
        const out = list.map(e => (e.isDirectory() ? e.name + '/' : e.name)).join('\n');
        return { output: out || '(空目录)' };
      }
      case 'grep': {
        const base = path.resolve(cwd, String(args.path || '.'));
        const st = await fsp.stat(base).catch(() => null);
        if (!st || !st.isDirectory()) return { error: `grep:目录不存在:${base}`, path: base };
        let rx;
        try { rx = new RegExp(String(args.pattern || ''), 'i'); }
        catch (e) { return { error: `grep:正则无效:${e.message}`, path: base }; }
        const incRx = args.include ? globToRx(String(args.include)) : null;
        const entries = await fsp.readdir(base, { recursive: true, withFileTypes: true });
        const lines = [];
        const MAX_HITS = 400;
        let truncated = false;
        for (const ent of entries) {
          if (!ent.isFile()) continue;
          const full = path.join(ent.parentPath || ent.path, ent.name);
          const rel = path.relative(base, full).split(path.sep).join('/');
          if (rel.split('/').some(seg => SKIP_DIRS.has(seg))) continue;
          if (incRx && !incRx.test(ent.name)) continue;
          let buf;
          try { buf = await fsp.readFile(full); } catch (e) { continue; }
          if (buf.length > 2 * 1024 * 1024 || buf.includes(0)) continue; // 跳过超大文件/二进制
          const ls = decodeTextSmart(buf).split('\n');
          const plainPattern = String(args.pattern || '').replace(/[.*+?^${}()|[\]\\]/g, '').trim();
          const isSimplePattern = plainPattern.length > 0 && plainPattern.length === String(args.pattern || '').trim().length;
          for (let i = 0; i < ls.length; i++) {
            if (rx.test(ls[i])) {
              lines.push(`${rel}:${i + 1}: ${ls[i].trim()}`);
            } else if (isSimplePattern && fuzzyMatchServer(ls[i], plainPattern)) {
              lines.push(`${rel}:${i + 1}: ${ls[i].trim()} (模糊)`);
            } else continue;
            if (lines.length >= MAX_HITS) { truncated = true; break; }
          }
          if (truncated) break;
        }
        return { output: (lines.join('\n') || '(无匹配)') + (truncated ? `\n…（命中已达 ${MAX_HITS} 行上限被截断，请缩小 path 范围或加 include 过滤）` : '') };
      }
      case 'glob': {
        const base = path.resolve(cwd, String(args.path || '.'));
        const st = await fsp.stat(base).catch(() => null);
        if (!st || !st.isDirectory()) return { error: `glob:目录不存在:${base}`, path: base };
        const pat = String(args.pattern || '').trim();
        if (!pat) return { error: 'glob:pattern 不能为空', path: base };
        const rx = globToRx(pat);
        const nameOnly = !pat.includes('/'); // 不含 / 的模式按“任意层级下的文件名”匹配
        const entries = await fsp.readdir(base, { recursive: true, withFileTypes: true });
        const out = [];
        const MAX_PATHS = 500;
        for (const ent of entries) {
          if (!ent.isFile()) continue;
          const full = path.join(ent.parentPath || ent.path, ent.name);
          const rel = path.relative(base, full).split(path.sep).join('/');
          if (rel.split('/').some(seg => SKIP_DIRS.has(seg))) continue;
          if (nameOnly ? rx.test(ent.name) : rx.test(rel)) out.push(rel);
          if (out.length >= MAX_PATHS) break;
        }
        const capNote = out.length >= MAX_PATHS ? `\n…（已达 ${MAX_PATHS} 条上限，结果被截断：请收窄 pattern 或指定更小的 path）` : '';
        let output = out.join('\n') || '(无匹配)';
        // 无精确匹配时，对简单文件名尝试模糊匹配（不含通配符的纯文本）
        if (!out.length && !/[*?{\[]/.test(pat)) {
          const fuzzyOut = [];
          for (const ent of entries) {
            if (!ent.isFile()) continue;
            const full = path.join(ent.parentPath || ent.path, ent.name);
            const rel = path.relative(base, full).split(path.sep).join('/');
            if (rel.split('/').some(seg => SKIP_DIRS.has(seg))) continue;
            if (fuzzyMatchServer(ent.name, pat) || fuzzyMatchServer(rel, pat)) fuzzyOut.push(rel + ' (模糊)');
            if (fuzzyOut.length >= 30) break;
          }
          if (fuzzyOut.length) output = fuzzyOut.join('\n') + '\n…(模糊匹配)';
        }
        return { output: output + capNote };
      }
      case 'web_fetch': {
        const url = String(args.url || '').trim();
        if (!/^https?:\/\//i.test(url)) return { error: 'web_fetch:仅支持 http/https 地址' };
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 20000);
        try {
          const resp = await fetch(url, {
            signal: ctrl.signal,
            redirect: 'follow',
            headers: { 'user-agent': 'Mozilla/5.0 KHarness/1.0', accept: 'text/html,application/json,text/plain,*/*' }
          });
          const ctype = resp.headers.get('content-type') || '';
          const raw = await resp.text();
          if (!resp.ok) return { error: `web_fetch:HTTP ${resp.status} ${ctype}`, output: raw || null };
          let text = raw;
          if (/html/i.test(ctype) || /^\s*<(!doctype|html)/i.test(raw)) {
            text = raw
              .replace(/<script[\s\S]*?<\/script>/gi, ' ')
              .replace(/<style[\s\S]*?<\/style>/gi, ' ')
              .replace(/<[^>]+>/g, ' ')
              .replace(/&nbsp;/gi, ' ')
              .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
              .replace(/[ \t]+/g, ' ')
              .replace(/\n\s*\n\s*\n+/g, '\n\n')
              .trim();
          }
          return { output: text || '(空内容)' };
        } catch (e) {
          return { error: `web_fetch:${e.name === 'AbortError' ? '请求超时(20 秒)' : e.message}` };
        } finally {
          clearTimeout(timer);
        }
      }
      case 'load_skill':
      case 'use_skill': {
        const wanted = String(args.name || '').trim();
        const skill = listSkills().find(s => s.name === wanted);
        if (!skill) {
          return { error: `技能不存在：${wanted}。可用技能：${listSkills().map(s => s.name).join(', ') || '(无)'}` };
        }
        return { output: `【技能：${skill.name}】\n${skill.body}`.substring(0, 8000) };
      }
      default:
        return { error: `未知工具：${name}` };
    }
  } catch (e) {
    return { error: e.message };
  }
}

// agent 系统提示词：cwd / 平台与 Shell / AGENTS.md 长期记忆 / 技能惰性加载 / Plan 模式协议
function agentSystemPrompt(cwd, opts = {}) {
  const { projectRoot, planMode, agentsFiles, readonlyMode, loadedSkills, remote } = opts;
  const cmdTimeoutSec = Math.round(getCmdTimeoutMs() / 1000);
  const shell = getShellSetting() || (IS_WIN ? 'cmd.exe（系统默认）' : process.env.SHELL || 'bash');
  // 远程会话必须让模型知道「自己在哪台机器上」，否则它会端出 Windows 路径和 cmd 语法
  const platformNote = remote
    ? `运行平台：远程 Linux 主机 ${remote.username}@${remote.host}:${remote.port}（命令经 SSH 执行、文件经 SFTP 读写，本机不是目标机器）。` +
      '命令一律用 POSIX/bash 语法；路径一律是远端绝对路径（如 /srv/app 或 ~/proj），不要用 Windows 盘符与反斜杠；' +
      '远端家目录是 ' + (remote.home || remote.default_cwd || '/') + '。'
    : IS_WIN
      ? '运行平台：Windows。命令需符合当前 Shell 语法；路径分隔符为 \\，含空格路径需加引号。'
      : '运行平台：Linux/macOS。使用 POSIX 命令语法。';
  const skills = listSkills();
  const lines = [
    remote ? '你是运行在本机 KHarness 中的开发运维助手，通过 SSH 直接操作那台远程 Linux 机器（主人本人使用）。'
           : '你是运行在本机 KHarness 中的开发运维助手，可以通过工具直接操作这台机器（主人本人使用）。',
    `当前工作目录：${cwd}（用户可用 /dir 指令切换，仅影响工具执行；相对路径一律基于该目录解析）。`,
    platformNote,
    remote ? '当前 Shell：远端登录 shell（由 sshd 拉起，通常是 bash）。'
           : `当前 Shell：${shell}（run_command 将使用它执行命令）。`,
    '使用工具的规则：',
    '- 执行命令前先想清楚必要性；绝不执行毁灭性命令（如 rm -rf /）；改代码前先读文件确认现状',
    '- 找文件用 glob(通配符→只给路径)、搜内容用 grep(正则,自动跳过 node_modules/.git)，查网页/文档用 web_fetch；这些专用工具优先于在 shell 里敲 grep/findstr/ls 组合',
    `- run_command 会等待命令结束，单次上限 ${cmdTimeoutSec > 0 ? cmdTimeoutSec + ' 秒（超时会终止整棵进程树并只回部分输出）' : '不限（用户可手动判定超时）'}；` +
      '装依赖、大仓构建、watch、起服务这类长任务一律用 run_background 异步跑，再用 background_status/background_list 查进度，不要用前台命令干等',
    '- 命令输出很长时用 head/tail/grep 收窄；需要读完整长输出时改读文件',
    '- 修改已有文件优先用 edit_file(只替换唯一匹配片段,改动会以彩色 diff 反馈给用户);write_file 是覆盖式写入，只用于新建文件或确实需要整体重写',
    '- 遇到「必须由用户拍板、选错方向代价大」的分叉时用 ask_user（会弹选项让用户点选或自己输入）；一般性偏好请自己合理决定并在回复里说明假设，不要动不动就问',
    '- 值得跨会话记住的用户偏好/环境事实/踩坑原因用 memory_write 沉淀下来；动手前若不确定既往约定，先 memory_list 再 memory_read（不要凭印象猜名字）',
    '- 工具调用参数必须严格按 schema 命名（例如路径参数是 path，不是 folder/dir/filepath）',
    '- 用户消息里形如 @path/to/file 的记号是他用输入框点出来的文件：那是相对当前工作目录的路径（也可能是绝对路径），代表他要你看的文件。动手前先用 read_file / list_dir 读取确认内容，禁止只凭文件名猜。',
    '- 需要执行命令、读写文件、列出目录等实际操作时，必须调用对应的工具函数完成，禁止只用文字描述操作过程或假装已执行',
    '- 用户消息里以 [工具结果回喂时插入提示词_用户输入] 开头的段落，是主人在工具返回结果后临时补充的指示，优先级高于你此前的计划，必须据此调整后续动作'
  ];
  if (projectRoot) {
    lines.push(`- 本会话绑定项目，项目根目录：${projectRoot}。所有文件操作与命令的工作目录都被限制在该目录内，越界访问会被安全策略直接拒绝，请始终使用项目内路径。`);
  }
  if (readonlyMode) {
    lines.push('- 【只读模式已开启】用户禁止任何修改操作：write_file / edit_file / run_command / run_background 均不可用，调用会被直接拒绝。请仅使用 read_file / list_dir / grep / glob / web_fetch 等查看类工具；需要修改时，先向用户说明并获得许可。');
  }
  // 技能惰性加载：system prompt 只给名字清单，详情由 load_skill 按需取回，避免撑爆上下文
  lines.push(skills.length
    ? `- 可用技能（${skills.length} 个）：${skills.map(s => s.name).join('、')}。技能详情不在此展开；执行对应专项任务（部署/重启/git/数据库等）前，先调用 load_skill(name) 获取完整说明再行动。用户消息中的 @技能名 表示用户要求你加载该技能。`
    : '- 当前无可用技能');
  // /skills-load：用户在界面上为本会话勾选的技能，正文直接注入（无需模型再调 load_skill）
  if (Array.isArray(loadedSkills) && loadedSkills.length) {
    for (const s of loadedSkills.slice(0, 12)) {
      if (!s || !s.body) continue;
      lines.push(`\n<<用户为本次会话加载的技能：${s.name}（必须遵循）>>\n${String(s.body).substring(0, 8000)}`);
    }
    lines.push(`（以上 ${Math.min(loadedSkills.length, 12)} 个技能由主人通过 /skills-load 常驻本会话，不需要再调用 load_skill 重复获取）`);
  }
  // AGENTS.md 长期记忆（哈希校验热加载；全局兜底 + 项目/目录覆盖叠加）
  // 拼装文本交给 utils/agentsmd.promptBlock —— 侧栏/托管/子智能体三条路用同一个函数，
  // 四处的措辞与格式不会走偏。
  const block = agentsMd.promptBlock(agentsFiles || collectAgentsMd(projectRoot, cwd));
  if (block) lines.push('', block);
  if (planMode) {
    lines.push('', [
      '[任务模式（Plan 模式）已开启——协议必须严格遵守]',
      '1. 接到需要多步完成的任务时，先输出计划：<plan> 标签内每行一条任务（以 "- " 开头），标签结束后再开始执行。',
      '2. 执行过程中用状态标签同步进度（单独一行，会被系统解析并从正文中移除，用户在任务面板中看到状态）：',
      '   <task-status idx="1" status="doing"/> 开始某项前；<task-status idx="1" status="done"/> 完成后；',
      '   <task-status idx="1" status="failed" error="失败原因摘要"/> 失败时（error 写明卡在哪，用户不看日志也能懂）。',
      '3. idx 从 1 开始对应 <plan> 中的行序号。每完成一项就同步状态，不要等全部结束才汇报。',
      '4. 某步骤失败且无法自行修复（权限/资源不存在等）时，把该项标记 failed 并继续其余任务，最后向用户总结。',
      '5. 简单问答（无需多步执行）不必输出 <plan>，直接回答。'
    ].join('\n'));
  }
  // 外部 API 工具：仅在设置里启用后才告知模型（未启用的不要提，免得它凭空调用）
  const apiNotes = toolgate.promptNotes();
  if (apiNotes) lines.push(apiNotes);
  return lines.join('\n');
}

// ---------- 对话压缩（/press、/context、自动压缩共用） ----------

// 用当前模型把可读上下文压缩为摘要：写入 ai_chats.summary，被压缩消息归档（保留最近几条由设置决定）
async function compressChat(chatId, modelRow, dispatcher, signal, send = null) {
  const chat = db.prepare('SELECT summary FROM ai_chats WHERE id = ?').get(chatId);
  const rows = db.prepare(
    "SELECT id, role, content FROM ai_chat_messages WHERE chat_id = ? AND archived = 0 ORDER BY id ASC"
  ).all(chatId);
  // 保留最近 N 条不归档（设置-常规「压缩保留条数」，0 = 一条不留全压进摘要），保证当前话题连续
  const keep = Math.min(numSetting('compress_keep_messages', 2, 0, 50), rows.length);
  const toCompress = rows.slice(0, rows.length - keep);
  if (toCompress.length === 0) {
    return { skipped: true, length: (chat.summary || '').length, message: rows.length ? '最近交互保留中，暂无需要压缩的内容' : '没有可压缩的对话内容' };
  }

  let transcript = toCompress
    .map(r => `${r.role === 'user' ? '用户' : 'AI'}: ${stripImageTokens(r.content).substring(0, 2000)}`)
    .join('\n');
  if (transcript.length > 24000) transcript = transcript.substring(0, 24000) + '\n…(过长已截断)';

  const prev = chat.summary ? `[此前摘要]\n${chat.summary}\n\n` : '';
  const prompt =
    '请将以下网站对话记录压缩为一份简洁摘要，必须保留：讨论的主题与结论、关键命令/文件路径/数字、未完成的任务与约定、语气要点。直接输出摘要正文，不要任何多余说明。\n\n' +
    prev + '[对话记录]\n' + transcript;

  const req = protocols.buildChatRequest(modelRow, { model: modelRow.model_id, messages: [{ role: 'user', content: prompt }], stream: false });
  const resp = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: JSON.stringify(req.body),
    dispatcher,
    signal
  });
  if (!resp.ok) {
    const detail = (await resp.text().catch(() => '')).substring(0, 200);
    throw new Error(`压缩请求失败 HTTP ${resp.status}: ${detail}`);
  }
  const data = await resp.json();
  const summary = stripThinking(protocols.normalizeReply(modelRow, data).choices?.[0]?.message?.content || '').substring(0, 8000);
  if (!summary.trim()) throw new Error('压缩结果为空');

  db.prepare('UPDATE ai_chats SET summary = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(summary, chatId);
  const archive = db.prepare('UPDATE ai_chat_messages SET archived = 1 WHERE id = ?');
  db.transaction(ids => { for (const id of ids) archive.run(id); })(toCompress.map(r => r.id));
  // 整包内容换了（一批消息归档、摘要重写），旧锚点不再代表现在的大小 → 作废，等下一次上游回执重新校准
  invalidateContextAnchor(chatId);
  return { skipped: false, length: summary.length, summary, archived: toCompress.length };
}

// 上下文窗口按「会话设定 → 模型 max_context → 全局默认」依次取值。
// 三处都是 0 时返回 0：没有窗口就没有 80% 可言，自动压缩也就无从触发。
function resolveContextWindow(chatId) {
  const chat = db.prepare(
    'SELECT c.context_limit, m.max_context FROM ai_chats c LEFT JOIN ai_models m ON c.model_row_id = m.id WHERE c.id = ?'
  ).get(chatId) || {};
  const n = (v) => { const x = parseInt(v); return Number.isInteger(x) && x > 0 ? x : 0; };
  if (n(chat.context_limit)) return { limit: n(chat.context_limit), source: 'chat' };
  if (n(chat.max_context)) return { limit: n(chat.max_context), source: 'model' };
  const g = n(db.prepare("SELECT value FROM settings WHERE key = 'default_context_limit'").get()?.value);
  if (g) return { limit: g, source: 'default' };
  return { limit: 0, source: 'none' };
}

/** 一批上游消息（外加 tools schema）按经验尺子换成 token —— 与 agentsmd 的估算同一把尺，保证可比 */
function packageTokens(msgs, tools) {
  let n = 0;
  for (const m of msgs || []) {
    n += estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''));
    if (m.tool_calls) n += estimateTokens(JSON.stringify(m.tool_calls));
  }
  if (tools && tools.length) n += estimateTokens(JSON.stringify(tools));
  return n;
}

/**
 * 上下文用量（决定右侧「已用/窗口」和 80% 自动压缩）。
 *
 * 口径分两层，**优先真实值**：
 *   1) 锚点：上一轮上游回执的 prompt_tokens + completion_tokens —— 那就是实打实发出去的整包
 *      （system 提示词、AGENTS.md、技能清单、几十个工具的 schema 全在里面）。
 *      锚点之后新增的正文按估算补上（`id > ctx_anchor_msg_id` 的未归档消息）。
 *   2) 没有锚点（全新会话、或刚压缩完主动作废）：退回「正文 + 摘要」估算，
 *      调用方可以把已知的固定开销（system + tools）通过 opts.overhead 传进来补平。
 *
 * 为什么非要真实值：只按正文估算实测低估 99%（三条短消息正文 38 tok，整包 5619 tok），
 * 结果就是「界面写着 ≥80% 将自动压缩、服务端却以为自己还很空」，问题被直接抛给模型。
 */
function chatContextUsage(chatId, opts = {}) {
  const rows = db.prepare(
    "SELECT id, content FROM ai_chat_messages WHERE chat_id = ? AND archived = 0"
  ).all(chatId);
  let body = 0;
  for (const r of rows) body += estimateTokens(r.content);
  // 摘要同样会作为上文发出去。漏算它的话，刚压缩完的会话会显示成接近 0%，
  // 看着像「还有巨大余量」，实际余量比显示的小。
  const chat = db.prepare('SELECT summary, ctx_anchor_tokens, ctx_anchor_msg_id FROM ai_chats WHERE id = ?').get(chatId) || {};
  if (chat.summary) body += estimateTokens(chat.summary);
  const anchor = Number(chat.ctx_anchor_tokens) || 0;
  const anchorMsg = Number(chat.ctx_anchor_msg_id) || 0;
  let used, basis;
  if (anchor > 0) {
    let since = 0;
    for (const r of rows) if (r.id > anchorMsg) since += estimateTokens(r.content);
    used = anchor + since;
    basis = 'anchor';
  } else {
    used = body + (Number(opts.overhead) || 0);
    basis = opts.overhead ? 'body+overhead' : 'body';
  }
  const { limit, source } = resolveContextWindow(chatId);
  return { used, body, anchor, anchor_msg_id: anchorMsg, basis, limit, limit_source: source };
}

/** 压缩之后锚点作废（整包已经换了内容），等下一轮上游回执重新校准 */
function invalidateContextAnchor(chatId) {
  try { db.prepare('UPDATE ai_chats SET ctx_anchor_tokens = 0, ctx_anchor_msg_id = 0 WHERE id = ?').run(chatId); } catch (e) { /* 旧库无列时忽略 */ }
}

/** 回合结束：把这一轮上游实测的整包大小记成锚点（右侧用量与压缩判定都以它为基准） */
function recordContextAnchor(chatId, usage) {
  if (!chatId || !usage) return;
  const anchor = (Number(usage.prompt_tokens) || 0) + (Number(usage.completion_tokens) || 0);
  if (anchor <= 0) return;
  const last = db.prepare('SELECT id FROM ai_chat_messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1').get(chatId);
  try {
    db.prepare('UPDATE ai_chats SET ctx_anchor_tokens = ?, ctx_anchor_msg_id = ? WHERE id = ?')
      .run(anchor, last ? last.id : 0, chatId);
  } catch (e) { /* 旧库无列时忽略 */ }
}

// 手动压缩（/press 指令）。不传 model_row_id 就用本会话正在用的那个模型，
// 而不是报「请先选择一个模型」——那等于把功能锁死了。
function modelRowForCompress(chatId, modelRowId) {
  const SELECT = `
    SELECT m.model_id, p.base_url, p.api_key, p.proxy_enabled, p.proxy_host, p.proxy_port,
           p.api_style, p.max_tokens, p.custom
    FROM ai_models m JOIN ai_providers p ON m.provider_id = p.id WHERE m.id = ?
  `;
  const given = parseInt(modelRowId);
  if (Number.isInteger(given) && given > 0) {
    const row = db.prepare(SELECT).get(given);
    if (row) return row;
  }
  const own = db.prepare('SELECT model_row_id FROM ai_chats WHERE id = ?').get(chatId);
  if (own?.model_row_id) {
    const row = db.prepare(SELECT).get(own.model_row_id);
    if (row) return row;
  }
  // 会话记的模型已被删：退到库里第一个可用模型
  const any = db.prepare('SELECT id FROM ai_models ORDER BY id ASC LIMIT 1').get();
  return any ? db.prepare(SELECT).get(any.id) : null;
}

// 手动压缩（/press 指令）
router.post('/chat/press', wrap(async (req, res) => {
  const chatId = parseInt(req.body?.chat_id);
  if (!Number.isInteger(chatId) || chatId < 1) return fail(res, 400, '无效的对话ID');
  const chat = db.prepare('SELECT id FROM ai_chats WHERE id = ? AND user_id = ?').get(chatId, 1);
  if (!chat) return fail(res, 404, '对话不存在');
  const modelRow = modelRowForCompress(chatId, req.body?.model_row_id);
  if (!modelRow) return fail(res, 400, '本机没有可用模型，无法压缩。请先到「模型」页添加提供商与模型。');
  const dispatcher = modelRow.proxy_enabled && modelRow.proxy_host
    ? new ProxyAgent(`http://${modelRow.proxy_host}:${modelRow.proxy_port}`) : undefined;
  try {
    const r = await compressChat(chatId, { ...modelRow, base_url: modelRow.base_url }, dispatcher, AbortSignal.timeout(90 * 1000));
    if (r.skipped) return ok(res, { length: r.length, skipped: true, model: modelRow.model_id }, '没有可压缩的对话内容');
    ok(res, { length: r.length, model: modelRow.model_id }, `已用 ${modelRow.model_id} 压缩，摘要 ${r.length} 字符`);
  } catch (e) {
    failErr(res, 502, '压缩失败', e);
  }
}));

// 设定上下文窗口并立即压缩（/context 指令）
router.post('/chat/context', wrap(async (req, res) => {
  const chatId = parseInt(req.body?.chat_id);
  const limit = parseInt(req.body?.limit);
  if (!Number.isInteger(chatId) || chatId < 1) return fail(res, 400, '无效的对话ID');
  if (!Number.isInteger(limit) || limit < 1000 || limit > 1000000) {
    return fail(res, 400, '上下文窗口需为 1000 ~ 1000000 的整数（token 数）');
  }
  const chat = db.prepare('SELECT id FROM ai_chats WHERE id = ? AND user_id = ?').get(chatId, 1);
  if (!chat) return fail(res, 404, '对话不存在');
  db.prepare('UPDATE ai_chats SET context_limit = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(limit, chatId);

  const modelRow = modelRowForCompress(chatId, req.body?.model_row_id);
  let compressed = null;
  if (modelRow) {
    const dispatcher = modelRow.proxy_enabled && modelRow.proxy_host
      ? new ProxyAgent(`http://${modelRow.proxy_host}:${modelRow.proxy_port}`) : undefined;
    try {
      compressed = await compressChat(chatId, modelRow, dispatcher, AbortSignal.timeout(90 * 1000));
    } catch (e) {
      compressed = { error: e.message };
    }
  }
  const usage = chatContextUsage(chatId);
  ok(res, { ...usage, compressed }, compressed && compressed.error ? `窗口已设为 ${limit}，但压缩失败：${compressed.error}` : `上下文窗口已设为 ${limit} 字符，历史已压缩`);
}));

// Agent 信息（默认目录 + 技能列表）
router.get('/agent/info', wrap((req, res) => {
  ok(res, {
    cwd: AGENT_DEFAULT_CWD,
    skills: listSkills().map(({ name, description }) => ({ name, description }))
  });
}));

// 判断 dir 是否位于 root 内（含 root 本身）；用 path.relative 规避 Windows 盘符大小写问题
function insideRoot(dir, root) {
  const rel = path.relative(root, dir);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// 浏览器传来的路径是否为绝对路径（POSIX 根 / Windows 盘符 / UNC）
function isAbsPath(p) {
  return /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(p);
}

// 切换/校验工作目录（/dir 指令）
// body: { path, chat_id?, base? }
// - 相对路径以 base（前端当前 cwd）或会话存量 cwd 为基解析
// - 会话绑定项目时，只允许切到项目根目录及其子目录；校验通过后持久化到会话
router.post('/chat/cwd', wrap(async (req, res) => {
  const p = String(req.body?.path || '').trim();
  if (!p) return fail(res, 400, '请提供目录路径');

  // 基准目录：会话存量 cwd > 前端传入 base > 默认目录
  let base = AGENT_DEFAULT_CWD;
  const chatId = parseInt(req.body?.chat_id);
  let chatRow = null;
  let projectName = null;
  if (Number.isInteger(chatId) && chatId > 0) {
    chatRow = db.prepare(`
      SELECT c.id, c.cwd, c.project_id, c.remote_id, p.name AS project_name, p.root_path AS project_root
      FROM ai_chats c LEFT JOIN projects p ON p.id = c.project_id WHERE c.id = ?
    `).get(chatId);
    if (!chatRow) return fail(res, 404, '对话不存在');
    if (chatRow.cwd) base = chatRow.cwd;
  }
  if (typeof req.body?.base === 'string' && req.body.base.trim()) base = req.body.base.trim();

  // 远程会话：路径按 posix 拼、目录存在性用 SFTP 查，边界仍是「项目根内」
  if (chatRow && chatRow.remote_id) {
    const hostRow = db.prepare('SELECT * FROM ai_remote_hosts WHERE id = ?').get(chatRow.remote_id);
    if (!hostRow) return fail(res, 404, '该会话所属的远程连接已被删除');
    // 基准目录同样只能认远端路径：前端传来的 base / 库里存的旧值都可能是本机 Windows 路径
    const remoteBase = remoteexec.resolveCwd({
      agent: true, bodyCwd: req.body?.base, chatCwd: chatRow.cwd, projectRoot: chatRow.project_root, host: hostRow,
    });
    const resolved = remoteexec.rj(remoteBase, p);
    const st = await remoteUtil.sftp.stat(hostRow, resolved).catch(() => null);
    if (!st) return fail(res, 400, `远端目录不存在或读不到：${resolved}`);
    if (st.type !== 'dir') return fail(res, 400, `不是目录：${resolved}`);
    if (chatRow.project_root) {
      const root = remoteUtil.posixPath(chatRow.project_root);
      if (resolved !== root && !resolved.startsWith(root + '/')) {
        return fail(res, 400, `项目「${chatRow.project_name}」的会话只能切换到远端项目目录内（项目根：${root}）`);
      }
      projectName = chatRow.project_name;
    }
    db.prepare('UPDATE ai_chats SET cwd = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(resolved, chatRow.id);
    return ok(res, { cwd: resolved, project_name: projectName, remote_id: chatRow.remote_id });
  }

  const resolved = path.resolve(isAbsPath(p) ? p : path.resolve(base, p));
  let st;
  try { st = fs.statSync(resolved); } catch (e) {
    return fail(res, 400, `目录不存在或不可访问：${resolved}`);
  }
  if (!st.isDirectory()) return fail(res, 400, `不是目录：${resolved}`);

  if (chatRow && chatRow.project_root) {
    const root = path.resolve(chatRow.project_root);
    if (!insideRoot(resolved, root)) {
      return fail(res, 400, `项目「${chatRow.project_name}」的会话只能切换到项目目录内（项目根：${root}）`);
    }
    projectName = chatRow.project_name;
  }

  if (chatRow) {
    db.prepare('UPDATE ai_chats SET cwd = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(resolved, chatRow.id);
  }
  ok(res, { cwd: resolved, project_name: projectName });
}));

// ---------- @文件提及：给输入框列目录候选（本地列 fs，远程列 SFTP） ----------
// 只列一层：调用方把「目录部分」传 path、「正在打的文件名前缀」传 q。
// path 允许绝对路径（本地按本机解析、远程按远端解析），也允许相对会话目录 —— 与工具执行同一套基准。
router.get('/fs/ls', wrap(async (req, res) => {
  const chatId = parseInt(req.query?.chat_id) || null;
  const raw = String(req.query?.path || '');
  const q = String(req.query?.q || '').toLowerCase();
  const limit = Math.min(Math.max(parseInt(req.query?.limit) || 80, 1), 300);
  const chatRow = chatId
    ? db.prepare('SELECT c.cwd, c.remote_id, p.root_path AS project_root FROM ai_chats c LEFT JOIN projects p ON p.id = c.project_id WHERE c.id = ?').get(chatId)
    : null;
  const host = chatRow?.remote_id ? remoteHostFor(chatId) : null;
  const keep = (name, isDir) => {
    if (isDir && (name === '.git' || name === 'node_modules')) return true;   // 保留但排在后面，见 sort
    if (!q) return !name.startsWith('.') || name === q;
    return name.toLowerCase().includes(q);
  };
  const rank = (a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1);

  if (host) {
    // 远端：一律 posix，绝不过本地 path.resolve（Windows 上会把 /srv/app 变成 \srv\app）
    const base = remoteUtil.posixPath(chatRow?.cwd || host.default_cwd || host.home || '/');
    const dir = remoteexec.rj(base, raw || '.');
    try {
      const items = await remoteUtil.sftp.list(host, dir);
      const out = items
        .filter((it) => keep(it.name, it.type === 'dir'))
        .map((it) => ({ name: it.name, dir: it.type === 'dir' }))
        .sort(rank)
        .slice(0, limit);
      return ok(res, { path: dir, remote: true, host_id: host.id, items: out });
    } catch (e) {
      return failErr(res, 400, `列不出远端目录 ${dir}`, e);
    }
  }

  const baseLocal = chatRow?.cwd || chatRow?.project_root || AGENT_DEFAULT_CWD;
  const dirLocal = path.resolve(isAbsPath(raw) ? raw : path.resolve(baseLocal, raw || '.'));
  try {
    const names = await fsp.readdir(dirLocal);
    const out = [];
    for (const n of names) {
      if (!keep(n, false)) continue;
      let isDir = false;
      try { isDir = (await fsp.stat(path.join(dirLocal, n))).isDirectory(); } catch (e) { continue; }
      out.push({ name: n, dir: isDir });
    }
    out.sort(rank);
    ok(res, { path: dirLocal, remote: false, items: out.slice(0, limit) });
  } catch (e) {
    failErr(res, 400, `列不出目录 ${dirLocal}`, e);
  }
}));

// ---------- 项目与会话分离 ----------

// 项目列表（含各项目下的会话数）
router.get('/projects', wrap((req, res) => {
  const projects = db.prepare(`
    SELECT p.id, p.name, p.root_path, p.created_at, p.sort_order, p.remote_id,
           (SELECT COUNT(*) FROM ai_chats c WHERE c.project_id = p.id) AS chat_count
    FROM projects p
    ORDER BY p.sort_order ASC, p.created_at ASC, p.id ASC
  `).all();
  ok(res, projects);
}));

// 标准化用户输入的路径：剥离成对引号（复制路径常带引号）、Windows 盘符大写归一、
// path.resolve 消解 ./ ../ 重复斜杠与尾斜杠；中文/空格路径由 fs API 原生支持，无需转义
function normalizeInputPath(p) {
  let s = String(p || '').trim();
  if ((s.startsWith('"') && s.endsWith('"') && s.length > 1) || (s.startsWith("'") && s.endsWith("'") && s.length > 1)) {
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/^([a-zA-Z]):/, (m, d) => `${d.toUpperCase()}:`);
  return path.resolve(s);
}

// 路径相等判断：Windows 文件系统不区分大小写
function samePath(a, b) {
  if (process.platform === 'win32') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function validateProjectRoot(root, excludeId = 0) {
  let st;
  try { st = fs.statSync(root); } catch (e) { return `目录不存在：${root}`; }
  if (!st.isDirectory()) return `不是目录：${root}`;
  try { fs.accessSync(root, fs.constants.W_OK); } catch (e) { return `目录没有写权限：${root}`; }
  const all = db.prepare('SELECT id, root_path FROM projects WHERE id != ?').all(excludeId);
  for (const row of all) {
    if (samePath(path.resolve(row.root_path), root)) {
      return `该目录已被其他项目使用（${row.root_path}）`;
    }
  }
  return null;
}

// 远程项目根目录校验：一个字节都不碰本地 fs —— 用 SFTP 看它存不存在、是不是目录。
// 重名判断按「同一台主机内」比，跨主机的 /srv/app 互不冲突。
async function validateRemoteRoot(host, root, excludeId = 0) {
  if (!root || root === '/') return `远端项目目录要写成绝对路径（如 /srv/${host.name}）`;
  if (root.length > 300) return '远端路径过长';
  try {
    const st = await remoteUtil.sftp.stat(host, root);
    if (st.type !== 'dir') return `远端目标不是目录：${root}`;
  } catch (e) {
    return `远端目录不存在或读不到：${root}（${e.message}）`;
  }
  const dup = db.prepare('SELECT id, root_path FROM projects WHERE remote_id = ? AND id != ?').all(host.id, excludeId);
  for (const row of dup) {
    if (row.root_path === root) return `该远端目录已被其他项目使用（${root}）`;
  }
  return null;
}

// 新建项目 { name, root_path }；带 remote_id 就是远程项目（root_path 是远端绝对路径）
router.post('/projects', wrap(async (req, res) => {
  const name = sanitizeText(req.body?.name, 60);
  if (!name) return fail(res, 400, '项目名称不能为空');
  if (!String(req.body?.root_path || '').trim()) return fail(res, 400, '请提供项目工作目录');
  const remoteId = parseInt(req.body?.remote_id);
  if (Number.isInteger(remoteId) && remoteId > 0) {
    const host = db.prepare('SELECT * FROM ai_remote_hosts WHERE id = ?').get(remoteId);
    if (!host) return fail(res, 404, '远程连接不存在');
    const root = remoteUtil.posixPath(req.body.root_path);
    const err = await validateRemoteRoot(host, root);
    if (err) return fail(res, 400, err);
    const r = db.prepare('INSERT INTO projects (name, root_path, remote_id) VALUES (?, ?, ?)').run(name, root, remoteId);
    return ok(res, { id: Number(r.lastInsertRowid), name, root_path: root, remote_id: remoteId }, '远程项目已创建');
  }
  const root = normalizeInputPath(req.body.root_path);
  const err = validateProjectRoot(root);
  if (err) return fail(res, 400, err);
  const r = db.prepare('INSERT INTO projects (name, root_path) VALUES (?, ?)').run(name, root);
  ok(res, { id: Number(r.lastInsertRowid), name, root_path: root }, '项目已创建');
}));

// 更新项目（改名 / 改工作目录）。远程项目走 SFTP 校验，路径按 posix 归一。
router.put('/projects/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id < 1) return fail(res, 400, '无效的项目ID');
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!row) return fail(res, 404, '项目不存在');
  const name = req.body?.name !== undefined ? sanitizeText(req.body.name, 60) : row.name;
  if (!name) return fail(res, 400, '项目名称不能为空');
  if (row.remote_id) {
    const host = db.prepare('SELECT * FROM ai_remote_hosts WHERE id = ?').get(row.remote_id);
    if (!host) return fail(res, 404, '该项目所属的远程连接已不存在');
    let root = row.root_path;
    if (req.body?.root_path !== undefined) {
      root = remoteUtil.posixPath(req.body.root_path);
      const err = await validateRemoteRoot(host, root, id);
      if (err) return fail(res, 400, err);
    }
    db.prepare('UPDATE projects SET name = ?, root_path = ? WHERE id = ?').run(name, root, id);
    if (root !== row.root_path) {
      // 根目录变了：其下会话的 cwd 若不在新根内，重置为新根（远端路径用前缀判断，别用本地 path 模块）
      const chats = db.prepare('SELECT id, cwd FROM ai_chats WHERE project_id = ?').all(id);
      for (const c of chats) {
        if (c.cwd && c.cwd !== root && !c.cwd.startsWith(root + '/')) db.prepare('UPDATE ai_chats SET cwd = ? WHERE id = ?').run(root, c.id);
      }
    }
    return ok(res, { id, name, root_path: root, remote_id: row.remote_id }, '项目已更新');
  }
  let root = row.root_path;
  if (req.body?.root_path !== undefined) {
    if (!String(req.body.root_path || '').trim()) return fail(res, 400, '请提供项目工作目录');
    root = normalizeInputPath(req.body.root_path);
    const err = validateProjectRoot(root, id);
    if (err) return fail(res, 400, err);
  }
  db.prepare('UPDATE projects SET name = ?, root_path = ? WHERE id = ?').run(name, root, id);
  if (root !== row.root_path) {
    // 根目录变更：其下会话的 cwd 若不在新根内，重置为项目根
    const chats = db.prepare('SELECT id, cwd FROM ai_chats WHERE project_id = ?').all(id);
    for (const c of chats) {
      if (c.cwd && !insideRoot(c.cwd, root)) {
        db.prepare('UPDATE ai_chats SET cwd = ? WHERE id = ?').run(root, c.id);
      }
    }
  }
  ok(res, { id, name, root_path: root }, '项目已更新');
}));

// 删除项目
// 项目下还有会话时：未带 confirm=1 返回 409 + 会话数，由前端确认后带 confirm=1 级联删除（会话+消息）
// 删除前整份快照进回收站（ai_trash），所以回收站里的「恢复」是真能把会话和消息拿回来的
router.delete('/projects/:id', wrap((req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id < 1) return fail(res, 400, '无效的项目ID');
  const row = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(id);
  if (!row) return fail(res, 404, '项目不存在');
  const cnt = db.prepare('SELECT COUNT(*) AS n FROM ai_chats WHERE project_id = ?').get(id).n;
  const confirmed = req.query.confirm === '1' || req.body?.confirm === true;
  if (cnt > 0 && !confirmed) {
    return res.status(409).json({ code: 409, message: `项目「${row.name}」下还有 ${cnt} 个会话`, data: { chat_count: cnt } });
  }
  const trashId = db.transaction(() => trashStore.trashProject(id))();
  ok(res, { removed_chats: cnt, trash_id: trashId }, `项目已删除${cnt ? `（含 ${cnt} 个会话）` : ''}，可在回收站恢复`);
}));

// ---------- 工具 ----------
function validateBaseUrl(url) {
  return typeof url === 'string' && /^https?:\/\//.test(url.trim()) && url.trim().length <= 300;
}

function normalizeBaseUrl(url) {
  return url.trim().replace(/\/+$/, '');
}

function validateHomeUrl(url) {
  if (url === undefined || url === null || url === '') return '';
  const s = String(url).trim();
  if (!/^https?:\/\/\S+$/i.test(s) || s.length > 300) return null;
  return s;
}

// 自定义协议：核心字段必填（不猜、不自动探测，用户填什么就按什么发）；
// 思考/错误/用量路径允许留空（很多上游根本没有这些字段）
const CUSTOM_REQUIRED_FIELDS = ['chat_url', 'method', 'headers', 'body', 'content_path', 'stream_content_path', 'list_url', 'list_path'];
const CUSTOM_OPTIONAL_FIELDS = ['reasoning_path', 'stream_reasoning_path', 'error_path', 'usage_prompt_path', 'usage_completion_path', 'done_value'];
const CUSTOM_DEFAULTS = { method: 'POST', done_value: '[DONE]', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer {{key}}' } };

function validateCustomConfig(raw) {
  let cfg = raw;
  if (typeof cfg === 'string') {
    try { cfg = JSON.parse(cfg); } catch (e) { return { error: '自定义协议配置不是合法 JSON' }; }
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { error: '自定义协议配置必须是 JSON 对象' };
  const out = {};
  for (const k of CUSTOM_REQUIRED_FIELDS) {
    const v = cfg[k];
    if (v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (typeof v === 'object' && !Object.keys(v).length)) {
      return { error: `自定义协议缺少必填字段「${k}」（所有字段都要显式填写，不自动探测）` };
    }
    out[k] = v;
  }
  for (const k of CUSTOM_OPTIONAL_FIELDS) {
    const v = cfg[k];
    out[k] = (v === undefined || v === null) ? (CUSTOM_DEFAULTS[k] ?? '') : v;
  }
  if (!/^(GET|POST|PUT|PATCH)$/i.test(String(out.method))) return { error: '自定义协议的 method 只能是 GET/POST/PUT/PATCH' };
  if (typeof out.headers !== 'object' || Array.isArray(out.headers)) return { error: '自定义协议的 headers 必须是 JSON 对象' };
  if (typeof out.body !== 'object' || Array.isArray(out.body)) return { error: '自定义协议的 body 必须是 JSON 对象模板（值里可用 {{model}} {{messages}} {{prompt}} {{system}} {{stream}} {{temperature}} {{max_tokens}} {{tools}} {{key}} {{base}}）' };
  for (const k of [...CUSTOM_REQUIRED_FIELDS, ...CUSTOM_OPTIONAL_FIELDS]) {
    if (typeof out[k] === 'string' && out[k].length > 300) return { error: `自定义协议字段「${k}」过长（≤300 字符）` };
  }
  return { value: out };
}

function validateProviderBody(body) {
  const name = sanitizeText(body.name, 100);
  if (!name) return { error: '提供商名称不能为空' };
  if (!validateBaseUrl(body.base_url)) return { error: 'BaseURL 格式不正确（需以 http(s):// 开头，截止到 /v1）' };
  if (typeof body.api_key !== 'string' || !body.api_key.trim() || body.api_key.length > 300) {
    return { error: 'API Key 不能为空' };
  }
  const homeUrl = validateHomeUrl(body.home_url);
  if (homeUrl === null) return { error: '官网 URL 格式不正确（需以 http(s):// 开头）' };
  const proxyEnabled = body.proxy_enabled ? 1 : 0;
  let proxyHost = '';
  let proxyPort = 0;
  if (proxyEnabled) {
    proxyHost = sanitizeText(body.proxy_host, 200);
    proxyPort = parseInt(body.proxy_port, 10);
    if (!proxyHost || !Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
      return { error: '启用代理时需填写正确的代理 IP 和端口（1-65535）' };
    }
  }
  // 上游协议：openai（默认）/ anthropic / custom
  const apiStyle = ['openai', 'anthropic', 'custom'].includes(String(body.api_style || '').toLowerCase())
    ? String(body.api_style).toLowerCase() : 'openai';
  // max_tokens 仅对 anthropic 有意义：留空 = 8192（存 NULL），0 = 不发送该参数，其余最小 512
  let maxTokens = null;
  const mtRaw = body.max_tokens;
  if (mtRaw !== undefined && mtRaw !== null && String(mtRaw).trim() !== '') {
    const n = parseInt(mtRaw, 10);
    if (!Number.isInteger(n) || n < 0) return { error: 'max_tokens 需为不小于 0 的整数（0 表示不发送该参数）' };
    if (n > 0 && n < 512) return { error: 'max_tokens 至少 512（若想让上游用默认值请填 0）' };
    maxTokens = n;
  }
  let customJson = '';
  if (apiStyle === 'custom') {
    const c = validateCustomConfig(body.custom);
    if (c.error) return { error: c.error };
    customJson = JSON.stringify(c.value);
  }
  return {
    name,
    base_url: normalizeBaseUrl(body.base_url),
    api_key: body.api_key.trim(),
    home_url: homeUrl || '',
    proxy_enabled: proxyEnabled,
    proxy_host: proxyHost,
    proxy_port: proxyPort,
    api_style: apiStyle,
    max_tokens: maxTokens,
    custom: customJson
  };
}

// ---------- 模型测试引擎 ----------

// 剥离思考过程：<think>...</think> 块、未闭合的 <think> 前缀，以及 delta.reasoning_content 字段（流式解析时已忽略）
function stripThinking(text) {
  let out = String(text || '');
  out = out.replace(/<think>[\s\S]*?<\/think>/gi, '');
  out = out.replace(/<think>[\s\S]*$/i, '');
  return out.trim();
}

// 对单个模型发起流式请求（按提供商协议），返回 { status, reply, error, latency_ms }
async function testModel(model, provider, dispatcher) {
  const started = Date.now();
  const normalize = protocols.createChunkNormalizer(provider);
  try {
    let res = null;
    for (let attempt = 0; ; attempt++) {
      const req = protocols.buildChatRequest(provider, {
        model: model.model_id,
        messages: [{ role: 'user', content: TEST_MESSAGE }],
        stream: true
      });
      res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: JSON.stringify(req.body),
        dispatcher,
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS)
      });
      if (res.status === 429 && attempt < RATE_LIMIT_RETRY) {
        await sleep(2000);
        continue;
      }
      break;
    }

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).substring(0, ERROR_MAX_LEN); } catch (e) { /* 忽略 */ }
      return { status: 'error', error: `HTTP ${res.status}: ${detail || res.statusText}`, latency_ms: null };
    }

    let firstLatency = null;
    let content = '';
    let streamErr = '';
    let rawHead = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // 逐块解析 SSE：首块到达即记录首字延迟；忽略 reasoning_content，仅累计可见 content
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstLatency === null) firstLatency = Date.now() - started;
      const chunk = decoder.decode(value, { stream: true });
      if (rawHead.length < 2000) rawHead += chunk;
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const json = normalize(JSON.parse(payload), payload);
          if (!json) continue;
          // 网关把 404/429/配额等错误包在 200 的 SSE 里下发：必须判为失败
          if (json && json.error) {
            streamErr = String(json.error.message || json.error.code || JSON.stringify(json.error)).substring(0, ERROR_MAX_LEN);
            continue;
          }
          const delta = json.choices?.[0]?.delta;
          if (delta && typeof delta.content === 'string') content += delta.content;
          // delta.reasoning_content 为思考过程，按要求不展示、不计入回复
        } catch (e) { /* 非 JSON 行跳过 */ }
      }
      if (content.length > REPLY_MAX_LEN) break; // 足够判断可用性，提前结束
    }

    const reply = stripThinking(content).trim();
    // 流内错误（200 包裹的 404/429/配额等）优先判失败；失败不记录延迟
    if (streamErr) {
      return { status: 'error', error: `上游错误：${streamErr}`, latency_ms: null };
    }
    // 非 SSE 的 JSON 错误体（HTTP 200 但整包是 error 对象）
    if (!reply) {
      try {
        const asJson = JSON.parse(rawHead.trim());
        if (asJson && asJson.error) {
          return { status: 'error', error: `上游错误：${String(asJson.error.message || asJson.error.code || '').substring(0, ERROR_MAX_LEN)}`, latency_ms: null };
        }
      } catch (e) { /* 不是 JSON，按空回复处理 */ }
    }
    // 空回复（含只有思考没有正文）不算通过，也不记录延迟
    if (!reply) {
      return { status: 'error', error: '模型返回空回复（无可见正文），判定不可用', latency_ms: null };
    }
    return {
      status: 'ok',
      reply: reply.substring(0, REPLY_MAX_LEN),
      latency_ms: firstLatency,
      error: null
    };
  } catch (e) {
    let msg = errDetail(e);
    if (e.name === 'AbortError' || e.code === 'ABORT_ERR' || /timeout|abort/i.test(msg)) {
      msg = `请求超时（${TEST_TIMEOUT_MS / 1000}s）`;
    }
    return { status: 'error', error: msg.substring(0, ERROR_MAX_LEN), latency_ms: null };
  }
}

// 并发池：限制同时请求的模型数量
async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

// 执行测试并覆盖写库；modelIds 为空则测试全部模型
async function runTests(modelIds) {
  const rows = db.prepare(`
    SELECT m.id, m.model_id, m.display_name, m.provider_id,
           p.name AS provider_name, p.base_url, p.api_key,
           p.proxy_enabled, p.proxy_host, p.proxy_port, p.api_style, p.max_tokens, p.custom
    FROM ai_models m JOIN ai_providers p ON m.provider_id = p.id
    WHERE COALESCE(m.disabled, 0) = 0
    ${modelIds ? `AND m.id IN (${modelIds.map(() => '?').join(',')})` : ''}
    ORDER BY m.id
  `).all(...(modelIds || []));

  if (rows.length === 0) return [];

  const dispatcherCache = new Map();
  const getDispatcher = (p) => {
    if (!p.proxy_enabled) return undefined;
    const key = `${p.proxy_host}:${p.proxy_port}`;
    if (!dispatcherCache.has(key)) {
      dispatcherCache.set(key, new ProxyAgent(`http://${p.proxy_host}:${p.proxy_port}`));
    }
    return dispatcherCache.get(key);
  };

  const upsert = db.prepare(`
    INSERT INTO ai_model_results (model_row_id, status, reply, error, latency_ms, tested_at)
    VALUES (@id, @status, @reply, @error, @latency_ms, CURRENT_TIMESTAMP)
    ON CONFLICT(model_row_id) DO UPDATE SET
      status = excluded.status, reply = excluded.reply, error = excluded.error,
      latency_ms = excluded.latency_ms, tested_at = CURRENT_TIMESTAMP
  `);

  const tasks = rows.map(row => async () => {
    const result = await testModel(row, row, getDispatcher(row));
    upsert.run({
      id: row.id,
      status: result.status,
      reply: result.reply || null,
      error: result.error || null,
      latency_ms: result.latency_ms
    });
    console.log(`[ai-test] #${row.id} ${row.display_name}(${row.model_id}) -> ${result.status}${result.latency_ms ? ` ${result.latency_ms}ms` : ''}`);
    return { id: row.id, status: result.status, latency_ms: result.latency_ms, error: result.error };
  });

  return runWithConcurrency(tasks, TEST_CONCURRENCY);
}

// ---------- 管理端：提供商 CRUD ----------

router.get('/providers', wrap((req, res) => {
  const providers = db.prepare(`
    SELECT p.*, (SELECT COUNT(*) FROM ai_models m WHERE m.provider_id = p.id) AS model_count
    FROM ai_providers p ORDER BY p.name COLLATE NOCASE ASC, p.id ASC
  `).all();
  ok(res, providers);
}));

router.post('/providers', wrap((req, res) => {
  const v = validateProviderBody(req.body || {});
  if (v.error) return fail(res, 400, v.error);
  const result = db.prepare(
    'INSERT INTO ai_providers (name, base_url, api_key, home_url, proxy_enabled, proxy_host, proxy_port, api_style, max_tokens, custom) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(v.name, v.base_url, v.api_key, v.home_url, v.proxy_enabled, v.proxy_host, v.proxy_port, v.api_style, v.max_tokens, v.custom);
  ok(res, { id: result.lastInsertRowid }, '创建成功');
}));

router.put('/providers/:id', wrap((req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id < 1) return fail(res, 400, '无效的提供商ID');
  const existing = db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(id);
  if (!existing) return fail(res, 404, '提供商不存在');

  const v = validateProviderBody({ ...existing, ...req.body });
  if (v.error) return fail(res, 400, v.error);
  db.prepare(
    'UPDATE ai_providers SET name = ?, base_url = ?, api_key = ?, home_url = ?, proxy_enabled = ?, proxy_host = ?, proxy_port = ?, api_style = ?, max_tokens = ?, custom = ? WHERE id = ?'
  ).run(v.name, v.base_url, v.api_key, v.home_url, v.proxy_enabled, v.proxy_host, v.proxy_port, v.api_style, v.max_tokens, v.custom, id);
  ok(res, null, '更新成功');
}));

router.delete('/providers/:id', wrap((req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id < 1) return fail(res, 400, '无效的提供商ID');
  const result = db.prepare('DELETE FROM ai_providers WHERE id = ?').run(id);
  if (result.changes === 0) return fail(res, 404, '提供商不存在');
  ok(res, null, '删除成功（其下模型与测试结果已级联删除）');
}));

// ---------- 管理端：模型 CRUD ----------

function validateModelBody(body) {
  const providerId = parseInt(body.provider_id);
  if (!Number.isInteger(providerId) || providerId < 1) return { error: '请选择提供商' };
  const modelId = sanitizeText(body.model_id, 100);
  if (!modelId) return { error: '模型ID不能为空' };
  const displayName = sanitizeText(body.display_name, 100) || modelId;
  const remark = typeof body.remark === 'string' ? body.remark.substring(0, 500) : '';
  // 计价：$ / 1M tokens（输入/输出/缓存读分开计价；缓存命中按缓存价，不重复计费）
  const price = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 10000) / 10000 : 0;
  };
  const maxContext = parseInt(body.max_context);
  const supportsSearch = body.supports_search ? 1 : 0;
  const supportsThinking = body.supports_thinking ? 1 : 0;
  let thinkingLevels = '';
  if (body.thinking_levels) {
    if (Array.isArray(body.thinking_levels)) thinkingLevels = body.thinking_levels.join(',');
    else thinkingLevels = String(body.thinking_levels).substring(0, 200);
  }
  // 工具风格：新建模型默认走 native（只信原生 function calling，不自动降级成文本协议）。
  // 库里那一列的 DEFAULT 仍是 'auto' —— 那是给存量行留的，改默认只影响「以后新增」，
  // 所以必须在这里显式落值，否则老库上 INSERT 不带这列还是会拿到 'auto'。
  const toolStyle = ['auto', 'native', 'text'].includes(String(body.tool_style || '').trim())
    ? String(body.tool_style).trim()
    : 'native';
  return {
    provider_id: providerId, model_id: modelId, display_name: displayName, remark,
    price_in: price(body.price_in), price_out: price(body.price_out), price_cache: price(body.price_cache),
    max_context: Number.isInteger(maxContext) && maxContext > 0 ? maxContext : 0,
    supports_search: supportsSearch,
    supports_thinking: supportsThinking,
    thinking_levels: thinkingLevels,
    tool_style: toolStyle
  };
}

// 管理端模型列表（含提供商全量信息 + 最新测试结果）
router.get('/models', wrap((req, res) => {
  const models = db.prepare(`
    SELECT m.id, m.provider_id, m.model_id, m.display_name, m.remark, m.created_at,
           m.price_in, m.price_out, m.price_cache, m.disabled,
           m.max_context, m.supports_search, m.supports_thinking, m.thinking_levels,
           m.tool_style, m.tool_fail_count, m.thinking_style,
           p.name AS provider_name, p.base_url, p.home_url, p.api_key,
           p.proxy_enabled, p.proxy_host, p.proxy_port, p.api_style,
           p.max_tokens AS provider_max_tokens, p.custom AS provider_custom,
           r.status, r.reply, r.error, r.latency_ms, r.tested_at
    FROM ai_models m
    JOIN ai_providers p ON m.provider_id = p.id
    LEFT JOIN ai_model_results r ON r.model_row_id = m.id
    ORDER BY m.id ASC
  `).all();
  ok(res, models);
}));

router.post('/models', wrap((req, res) => {
  const v = validateModelBody(req.body || {});
  if (v.error) return fail(res, 400, v.error);
  const provider = db.prepare('SELECT id FROM ai_providers WHERE id = ?').get(v.provider_id);
  if (!provider) return fail(res, 404, '提供商不存在');
  try {
    const result = db.prepare(
      'INSERT INTO ai_models (provider_id, model_id, display_name, remark, price_in, price_out, price_cache, max_context, supports_search, supports_thinking, thinking_levels, tool_style) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(v.provider_id, v.model_id, v.display_name, v.remark, v.price_in, v.price_out, v.price_cache, v.max_context, v.supports_search, v.supports_thinking, v.thinking_levels, v.tool_style);
    ok(res, { id: result.lastInsertRowid }, '创建成功');
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) return fail(res, 400, '该提供商下已存在相同的模型ID');
    throw e;
  }
}));

router.put('/models/:id', wrap((req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id < 1) return fail(res, 400, '无效的模型ID');
  const existing = db.prepare('SELECT * FROM ai_models WHERE id = ?').get(id);
  if (!existing) return fail(res, 404, '模型不存在');

  const v = validateModelBody({ ...existing, ...req.body });
  if (v.error) return fail(res, 400, v.error);
  const provider = db.prepare('SELECT id FROM ai_providers WHERE id = ?').get(v.provider_id);
  if (!provider) return fail(res, 404, '提供商不存在');
  try {
    db.prepare('UPDATE ai_models SET provider_id = ?, model_id = ?, display_name = ?, remark = ?, price_in = ?, price_out = ?, price_cache = ?, max_context = ?, supports_search = ?, supports_thinking = ?, thinking_levels = ? WHERE id = ?')
      .run(v.provider_id, v.model_id, v.display_name, v.remark, v.price_in, v.price_out, v.price_cache, v.max_context, v.supports_search, v.supports_thinking, v.thinking_levels, id);
    ok(res, null, '更新成功');
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) return fail(res, 400, '该提供商下已存在相同的模型ID');
    throw e;
  }
}));

router.delete('/models/:id', wrap((req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id < 1) return fail(res, 400, '无效的模型ID');
  const result = db.prepare('DELETE FROM ai_models WHERE id = ?').run(id);
  if (result.changes === 0) return fail(res, 404, '模型不存在');
  ok(res, null, '删除成功');
}));

// 批量删除模型
router.post('/models/batch-delete', wrap((req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || ids.length === 0) return fail(res, 400, '请选择要删除的模型');
  if (ids.length > 100) return fail(res, 400, '单次最多删除 100 个模型');
  const parsed = ids.map(v => parseInt(v)).filter(v => Number.isInteger(v) && v > 0);
  if (parsed.length === 0) return fail(res, 400, '无效的模型ID列表');
  const placeholders = parsed.map(() => '?').join(',');
  const result = db.prepare(`DELETE FROM ai_models WHERE id IN (${placeholders})`).run(...parsed);
  ok(res, { deleted: result.changes }, `已删除 ${result.changes} 个模型`);
}));

// 切换模型禁用状态
router.patch('/models/:id/disabled', wrap((req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id < 1) return fail(res, 400, '无效的模型ID');
  const disabled = req.body?.disabled ? 1 : 0;
  const result = db.prepare('UPDATE ai_models SET disabled = ? WHERE id = ?').run(disabled, id);
  if (result.changes === 0) return fail(res, 404, '模型不存在');
  ok(res, null, disabled ? '已禁用' : '已启用');
}));

// 手动指定模型的工具调用风格（auto 自动探测 / native 仅原生 function calling / text 强制文本 JSON 协议），
// 并可清掉自动学习结果（思考样式 + 文本调用计数），用于「某些模型死活不会用工具」时的纠偏
router.patch('/models/:id/tool-style', wrap((req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id < 1) return fail(res, 400, '无效的模型ID');
  const style = String(req.body?.tool_style || 'auto');
  if (!['auto', 'native', 'text'].includes(style)) return fail(res, 400, '无效的工具风格（auto/native/text）');
  const result = db.prepare('UPDATE ai_models SET tool_style = ?, tool_fail_count = 0 WHERE id = ?').run(style, id);
  if (result.changes === 0) return fail(res, 404, '模型不存在');
  if (req.body?.reset_thinking) {
    db.prepare("UPDATE ai_models SET thinking_style = '' WHERE id = ?").run(id);
    for (const k of [...thinkingStyleCache.keys()]) if (String(k).startsWith(id + '|')) thinkingStyleCache.delete(k);
  }
  ok(res, { tool_style: style }, style === 'text' ? '已设为文本协议：该模型将按 JSON 文本发起工具调用'
    : style === 'native' ? '已设为原生模式：只使用 function calling，不降级'
      : '已设为自动：先试原生，被拒或只写文本时自动降级');
}));

// 批量改工具风格：多选模型后集中定调（一次最多 200 个），语义与单个 PATCH 一致 ——
// 顺带清掉文本调用计数，并可选清掉自动学到的思考样式（换了调用协议，思考参数往往也要重探）
router.post('/models/batch-tool-style', wrap((req, res) => {
  const style = String(req.body?.tool_style || '');
  if (!['auto', 'native', 'text'].includes(style)) return fail(res, 400, '无效的工具风格（auto/native/text）');
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || ids.length === 0) return fail(res, 400, '请选择要修改的模型');
  if (ids.length > 200) return fail(res, 400, '单次最多修改 200 个模型');
  const parsed = [...new Set(ids.map((v) => parseInt(v)).filter((v) => Number.isInteger(v) && v > 0))];
  if (!parsed.length) return fail(res, 400, '无效的模型ID列表');
  const ph = parsed.map(() => '?').join(',');
  const resetThinking = !!req.body?.reset_thinking;
  const r = db.prepare(`UPDATE ai_models SET tool_style = ?, tool_fail_count = 0${resetThinking ? ", thinking_style = ''" : ''} WHERE id IN (${ph})`).run(style, ...parsed);
  if (resetThinking) {
    const set = new Set(parsed.map(String));
    for (const k of [...thinkingStyleCache.keys()]) if (set.has(String(k).split('|')[0])) thinkingStyleCache.delete(k);
  }
  const named = db.prepare(`SELECT model_id FROM ai_models WHERE id IN (${ph}) LIMIT 5`).all(...parsed).map((x) => x.model_id);
  ok(res, { updated: r.changes, style }, `已把 ${r.changes} 个模型改为 ${style}${named.length ? `（如 ${named.slice(0, 3).join('、')}${named.length > 3 ? '…' : ''}）` : ''}`);
}));

// 批量添加模型
router.post('/models/batch', wrap((req, res) => {
  const providerId = parseInt(req.body?.provider_id);
  if (!Number.isInteger(providerId) || providerId < 1) return fail(res, 400, '请选择提供商');
  const provider = db.prepare('SELECT id FROM ai_providers WHERE id = ?').get(providerId);
  if (!provider) return fail(res, 404, '提供商不存在');
  const list = req.body?.models;
  if (!Array.isArray(list) || list.length === 0) return fail(res, 400, '请选择要添加的模型');
  if (list.length > 100) return fail(res, 400, '单次最多添加 100 个模型');
  const existed = new Set(db.prepare('SELECT model_id FROM ai_models WHERE provider_id = ?').all(providerId).map(r => r.model_id));
  let added = 0;
  let skipped = 0;
  const errors = [];
  const insertStmt = db.prepare('INSERT INTO ai_models (provider_id, model_id, display_name, remark, price_in, price_out, price_cache, max_context, supports_search, supports_thinking, thinking_levels, tool_style) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const tx = db.transaction((items) => {
    for (const item of items) {
      const v = validateModelBody({ provider_id: providerId, ...item });
      if (v.error) { errors.push(`${item.model_id || '(空)'}: ${v.error}`); skipped++; continue; }
      if (existed.has(v.model_id)) { errors.push(`${v.model_id}: 已存在`); skipped++; continue; }
      try {
        insertStmt.run(v.provider_id, v.model_id, v.display_name, v.remark, v.price_in, v.price_out, v.price_cache, v.max_context, v.supports_search, v.supports_thinking, v.thinking_levels, v.tool_style);
        existed.add(v.model_id);
        added++;
      } catch (e) {
        if (/UNIQUE/i.test(e.message)) { errors.push(`${v.model_id}: 已存在`); skipped++; }
        else { errors.push(`${v.model_id}: ${e.message}`); skipped++; }
      }
    }
  });
  tx(list);
  ok(res, { added, skipped, errors }, `批量添加完成：成功 ${added} 个，跳过 ${skipped} 个`);
}));

// 拉取提供商的远程模型列表（OpenAI 兼容 /v1/models）
router.get('/providers/:id/remote-models', wrap(async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id < 1) return fail(res, 400, '无效的提供商ID');
  const provider = db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(id);
  if (!provider) return fail(res, 404, '提供商不存在');
  const listReq = protocols.listRequest(provider);
  if (!listReq) return fail(res, 400, '该提供商为自定义协议且未填 list_url，无法拉取模型列表；请手动填写模型 ID');
  const dispatcher = provider.proxy_enabled && provider.proxy_host
    ? new ProxyAgent(`http://${provider.proxy_host}:${provider.proxy_port}`) : undefined;
  const started = Date.now();
  try {
    const resp = await fetch(listReq.url, {
      method: 'GET',
      headers: listReq.headers,
      dispatcher,
      signal: AbortSignal.timeout(15000)
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '').then(t => t.substring(0, 500));
      return fail(res, 502, `拉取失败 HTTP ${resp.status}: ${text || resp.statusText}`);
    }
    const data = await resp.json().catch(() => null);
    if (!data) return fail(res, 502, '返回内容不是有效 JSON');
    // 各协议的列表结构差异交给 protocols.parseModelList（custom 用配置的 list_path）
    const ids = [...new Set(protocols.parseModelList(provider, data))].sort();
    if (!ids.length) return fail(res, 502, `未从返回内容解析出模型列表（协议 ${protocols.styleOf(provider)}${protocols.styleOf(provider) === 'custom' ? '，检查 list_path 是否指对' : ''}）`);
    const latency = Date.now() - started;
    // 标记已存在的模型
    const existed = new Set(db.prepare('SELECT model_id FROM ai_models WHERE provider_id = ?').all(id).map(r => r.model_id));
    const list = ids.map(mid => ({ model_id: mid, existed: existed.has(mid) }));
    ok(res, { list, latency_ms: latency }, `获取到 ${ids.length} 个模型`);
  } catch (e) {
    let msg = errDetail(e);
    if (e.name === 'AbortError' || /timeout|abort/i.test(msg)) msg = '请求超时（15s）';
    return fail(res, 502, `拉取失败: ${msg.substring(0, 300)}`);
  }
}));

// 一键 Ping 所有提供商域名
router.post('/providers/ping', wrap(async (req, res) => {
  const timeoutMs = Math.min(30000, Math.max(1000, parseInt(req.body?.timeout) || 8000));
  const providers = db.prepare('SELECT id, name, base_url, proxy_enabled, proxy_host, proxy_port FROM ai_providers').all();
  if (providers.length === 0) return fail(res, 400, '暂无提供商');
  const results = await Promise.all(providers.map(async (p) => {
    const started = Date.now();
    let targetUrl;
    try {
      const u = new URL(p.base_url);
      targetUrl = u.origin;
    } catch (e) {
      return { id: p.id, name: p.name, base_url: p.base_url, status: 'error', latency_ms: null, error: 'BaseURL 格式错误' };
    }
    const dispatcher = p.proxy_enabled && p.proxy_host
      ? new ProxyAgent(`http://${p.proxy_host}:${p.proxy_port}`) : undefined;
    try {
      const resp = await fetch(targetUrl, {
        method: 'HEAD',
        dispatcher,
        signal: AbortSignal.timeout(timeoutMs)
      });
      const latency = Date.now() - started;
      // 只要能连通（即使 404/405）也算域名可达
      return { id: p.id, name: p.name, base_url: p.base_url, status: 'ok', latency_ms: latency, http_status: resp.status };
    } catch (e) {
      // HEAD 失败，尝试 GET
      try {
        const resp2 = await fetch(targetUrl, {
          method: 'GET',
          dispatcher,
          signal: AbortSignal.timeout(timeoutMs)
        });
        const latency = Date.now() - started;
        return { id: p.id, name: p.name, base_url: p.base_url, status: 'ok', latency_ms: latency, http_status: resp2.status };
      } catch (e2) {
        let msg = e2.message || String(e2);
        if (e2.name === 'AbortError' || /timeout|abort/i.test(msg)) msg = `连接超时（${timeoutMs / 1000}s）`;
        return { id: p.id, name: p.name, base_url: p.base_url, status: 'error', latency_ms: null, error: msg.substring(0, 200) };
      }
    }
  }));
  const okCount = results.filter(r => r.status === 'ok').length;
  ok(res, results, `Ping 完成：${okCount}/${results.length} 可达`);
}));

// ---------- 管理端：可用性测试 ----------

// body: { model_id?: number, model_ids?: number[] } 都不传则测试全部模型
// 支持单测（model_id 或单元素 model_ids）与批量测试选中模型（model_ids）
router.post('/test', wrap(async (req, res) => {
  let modelIds = null;
  if (req.body && req.body.model_ids !== undefined) {
    if (!Array.isArray(req.body.model_ids)) return fail(res, 400, 'model_ids 应为数组');
    const parsed = req.body.model_ids.map(v => parseInt(v)).filter(v => Number.isInteger(v) && v >= 1);
    if (parsed.length === 0) return fail(res, 400, '请提供至少一个有效的模型ID');
    if (parsed.length > 100) return fail(res, 400, '单次最多测试 100 个模型');
    modelIds = parsed;
  } else if (req.body && req.body.model_id !== undefined) {
    const id = parseInt(req.body.model_id);
    if (!Number.isInteger(id) || id < 1) return fail(res, 400, '无效的模型ID');
    modelIds = [id];
  }
  const results = await runTests(modelIds);
  const okCount = results.filter(r => r.status === 'ok').length;
  ok(res, {
    total: results.length,
    available: okCount,
    unavailable: results.length - okCount,
    results
  }, `测试完成：${okCount}/${results.length} 可用`);
}));

// ---------- 公开：可用性状态（所有人可见） ----------
// 所有人可见：提供商名称/官网、模型ID、展示名、备注、可用性、回复、错误、首字延迟、时间
// 仅管理员额外可见：提供商ID、BaseURL、API Key（支持复制）
router.get('/status', wrap((req, res) => {
  const admin = true; // 桌面端 harness：一律管理员
  const models = db.prepare(`
    SELECT m.id, m.model_id, m.display_name, m.remark, m.created_at,
           m.max_context, m.supports_search, m.supports_thinking, m.thinking_levels,
           p.name AS provider_name, p.home_url
          ${admin ? ', m.provider_id, p.base_url, p.api_key' : ''}
          , r.status, r.reply, r.error, r.latency_ms, r.tested_at
    FROM ai_models m
    JOIN ai_providers p ON m.provider_id = p.id
    LEFT JOIN ai_model_results r ON r.model_row_id = m.id
    WHERE COALESCE(m.disabled, 0) = 0
    ORDER BY m.id ASC
  `).all();
  const testedAt = db.prepare('SELECT MAX(tested_at) AS t FROM ai_model_results').get().t;
  ok(res, { is_admin: admin, last_tested_at: testedAt, list: models });
}));

// ---------- 管理端：Playground 快速聊天（流式转发 + 对话持久化） ----------

// 把库中的消息内容（可能含 [[img:token]] 标记）转为 OpenAI 协议格式；
// 含图消息转为 vision content 数组，token 失效则用占位文本，保证上下文始终可用
function buildUpstreamContent(role, content) {
  if (role === 'assistant') return { role, content };
  const matches = [...content.matchAll(/\[\[img:([a-f0-9]+)\]\]/g)];
  if (matches.length === 0) return { role, content };
  const parts = [];
  let last = 0;
  for (const match of matches) {
    const before = content.slice(last, match.index).trim();
    if (before) parts.push({ type: 'text', text: before });
    const img = imageStore.get(match[1]);
    parts.push(img
      ? { type: 'image_url', image_url: { url: img.dataUrl } }
      : { type: 'text', text: '[图片已销毁]' });
    last = match.index + match[0].length;
  }
  const tail = content.slice(last).trim();
  if (tail) parts.push({ type: 'text', text: tail });
  if (parts.length === 1 && parts[0].type === 'text') return { role, content: parts[0].text };
  return { role, content: parts };
}

function stripImageTokens(content) {
  return String(content || '').replace(/\[\[img:[a-f0-9]+\]\]/g, '[图片]');
}

// 旧版 Agent 把工具调用日志以 "[工具调用记录]\n▶ ..." 拼进 assistant 文本尾巴。
// 现在工具已改为独立的 steps(折叠 diff 块),此尾巴属残留垃圾,统一剥离
// (同时应用于消息入库前、载入显示、以及上游上下文,避免污染)。
function stripLegacyToolLog(content) {
  if (typeof content !== 'string') return content;
  const i = content.indexOf('[工具调用记录]');
  if (i === -1) return content;
  return content.slice(0, i).trimEnd();
}

// body: { model_row_id, chat_id?: number|null, content: string, agent?: bool, cwd?: string }
// SSE 返回：{t:'chat',chat_id,title} / {t:'delta',text} / {t:'tool',name,args} /
//          {t:'tool_result',name,output,error} / {t:'note',message} / {t:'done',latency_ms} / {t:'error',message}
// body: { model_row_id?, pool?: [id], chat_id?, content, agent?, cwd?, bypass? }
// SSE 返回：{t:'chat',chat_id,title,user_message_id} / {t:'model',name} / {t:'delta',text} / {t:'reason',text} /
//          {t:'tool',name,args} / {t:'tool_result',name,output,error,open} / {t:'approval',id,level,tool,args} /
//          {t:'note',message} / {t:'done',latency_ms,context_used,context_limit} / {t:'error',message}
router.post('/chat', (req, res) => {
  const rawContent = typeof req.body?.content === 'string' ? req.body.content : '';
  // 继续生成模式：不落新用户消息，把完整上文（含未完成回复）+ 继续指令交给模型，从中断处接着写
  const continueMode = !!(req.body?.continue && req.body?.chat_id);
  if (!continueMode && (!rawContent.trim() || rawContent.length > 8000)) {
    return fail(res, 400, '消息内容不能为空且不超过 8000 字符');
  }
  // 用户消息进入 AI 上下文前同样脱敏（敏感数据表中命中的部分替换为 ***REDACTED***）
  const content = redactSecrets(rawContent);
  // 只有监工下发的命令会带这个；普通用户消息保持空，走原来的插入路径
  const userSpeaker = req.body?.speaker === 'supervisor' ? 'supervisor' : '';
  const agent = !!req.body?.agent;
  const bypass = !!req.body?.bypass;
  // 前端传入本次会话的审批模式（严格/默认/免除）：落到会话行持久化，供审批判定与前端一致
  const requestedApprovalMode = ['strict', 'default', 'exempt'].includes(req.body?.approval_mode) ? req.body.approval_mode : '';
  // 思考档位同理随每次请求带上（界面下拉显示什么就发什么）。以前只认会话行的 thinking_level，
  // 而行只在用户点过下拉时才被 PATCH 写入 → 新会话首轮、以及从没碰过下拉的会话拿到的是空串
  // → normalizeThinkingLevel 判成 mode='default' → 一个思考参数都不发 → 该模型不思考，界面上也就没有思考可展示。
  const requestedThinkingLevel = sanitizeText(req.body?.thinking_level, 20);
  const readonlyMode = !!req.body?.readonly; // 只读模式：AI 仅可查看，不可修改文件/执行命令
  // 实验室开关（前端设置页的开关随请求带上，只影响本次回合，不落库）
  const labs = {
    uncommittedTip: !!(req.body?.labs && req.body.labs.uncommittedTip),
    gitPreview: !!(req.body?.labs && req.body.labs.gitPreview),
  };

  // 模型池：auto 模式客户端按优先级传入，逐个尝试；否则使用单一模型
  let poolIds = [];
  if (Array.isArray(req.body?.pool)) {
    poolIds = req.body.pool.map(x => parseInt(x)).filter(x => Number.isInteger(x) && x > 0);
  }
  const singleId = parseInt(req.body?.model_row_id);
  if (!poolIds.length && Number.isInteger(singleId) && singleId > 0) poolIds = [singleId];
  if (!poolIds.length) return fail(res, 400, '未指定模型');

  const poolRows = poolIds.map(id => db.prepare(`
    SELECT m.id, m.model_id, m.display_name, m.max_context, m.supports_search, m.supports_thinking, m.thinking_levels,
           m.tool_style, m.tool_fail_count, m.thinking_style,
           p.base_url, p.api_key, p.proxy_enabled, p.proxy_host, p.proxy_port,
           p.api_style, p.max_tokens, p.custom
    FROM ai_models m JOIN ai_providers p ON m.provider_id = p.id WHERE m.id = ?
  `).get(id)).filter(Boolean);
  if (!poolRows.length) return fail(res, 404, '模型不存在');

  // 对话归属校验 / 新建对话（新建时可携带 project_id 绑定项目）
  let chatId = parseInt(req.body?.chat_id);
  let chatTitle = null;
  let chatRow = null;
  let project = null;
  let planMode = false;
  if (Number.isInteger(chatId) && chatId > 0) {
    chatRow = db.prepare(`
      SELECT c.id, c.cwd, c.project_id, c.remote_id, c.plan_mode, c.temperature, c.frequency_penalty, c.presence_penalty, c.search_enabled, c.search_strategy, c.thinking_level, c.censored_words, c.context_limit, p.root_path AS project_root
      FROM ai_chats c LEFT JOIN projects p ON p.id = c.project_id
      WHERE c.id = ? AND c.user_id = ?
    `).get(chatId, 1);
    if (!chatRow) return fail(res, 404, '对话不存在');
    planMode = !!chatRow.plan_mode;
  } else {
    chatId = null;
    const pid = parseInt(req.body?.project_id);
    if (Number.isInteger(pid) && pid > 0) {
      project = db.prepare('SELECT id, root_path, remote_id FROM projects WHERE id = ?').get(pid);
      if (!project) return fail(res, 404, '项目不存在，无法创建会话');
    }
    planMode = !!req.body?.plan_mode;
  }

  // 会话工作目录（不修改进程 CWD，仅作为工具执行的基准目录）：
  // 优先级：body.cwd（agent 模式）> 会话存量 cwd > 项目根 > 默认目录
  // 项目会话强制限制：cwd 必须位于项目根内，否则回落到项目根
  let cwd = null;
  const bodyCwd = typeof req.body?.cwd === 'string' ? req.body.cwd.trim() : '';
  // 远程会话的 cwd 是「远端路径」，上面那套本机 fs.statSync / path.resolve 校验一条都不能用：
  // Windows 上 '/home/ker' 会被看成 'D:\home\ker' → 判不存在 → 掉回本机默认目录（装机版里就是
  // resources/server），于是每条远端命令前置的 cd 都失败，整轮工具调用全废（真机踩过）。
  const turnRemoteId = chatRow?.remote_id || project?.remote_id || null;
  if (turnRemoteId) {
    const turnHost = db.prepare('SELECT * FROM ai_remote_hosts WHERE id = ?').get(turnRemoteId);
    if (!turnHost) return fail(res, 400, `这个会话属于远程连接（id=${turnRemoteId}），但连接已被删除。请先删掉这条会话，或重新建连接。`);
    cwd = remoteexec.resolveCwd({
      agent, bodyCwd, chatCwd: chatRow?.cwd, host: turnHost,
      // 已有会话的项目根在 join 出来的 project_root 上，新建时才在 project 里
      projectRoot: project?.root_path || chatRow?.project_root || '',
    });
  } else {
    if (agent && bodyCwd) {
      const p = path.resolve(bodyCwd);
      try { if (fs.statSync(p).isDirectory()) cwd = p; } catch (e) { /* 目录无效则忽略 */ }
    }
    if (!cwd && chatRow?.cwd) {
      try { if (fs.statSync(chatRow.cwd).isDirectory()) cwd = chatRow.cwd; } catch (e) { /* 目录可能已被移走 */ }
    }
    if (project) {
      const root = path.resolve(project.root_path);
      if (!cwd || !insideRoot(cwd, root)) cwd = root;
    } else if (!cwd) {
      cwd = AGENT_DEFAULT_CWD;
    }
  }

  const makeDispatcher = (row) => row.proxy_enabled && row.proxy_host
    ? new ProxyAgent(`http://${row.proxy_host}:${row.proxy_port}`) : undefined;

  // 用量到窗口 80% 就自动压缩。回合开头查一次，工具循环里每个安全边界再查一次
  // ——真正让上下文爆掉的往往是一轮里连开几十个工具，而不是回合之间。
  // 每回合最多压 2 次，避免压缩收益不足时反复触发。返回 true 表示确实压过了，
  // 调用方需要据此重建上游上下文，否则摘要虽然生成了、发出去的还是原始全文。
  let autoCompressCount = 0;
  // 本轮的压缩卡片：一次压缩一张卡（start → done/skipped/failed 就地改同一张），回合结束时随消息落库，
  // 刷新后消息流里仍看得到。别按阶段各推一条 —— 那样重载后会并排出现「进行中」和「已压缩」两张卡。
  const turnCompressSteps = [];
  const maybeAutoCompress = async (modelRow, live) => {
    if (autoCompressCount >= 2 || !chatId) return false;
    const { limit, source } = resolveContextWindow(chatId);
    if (!limit) return false;
    // 口径：以「上一轮上游实测的整包」为锚点（见 chatContextUsage）；工具循环里再拿当前
    // upstreamMsgs + tools 的整包估算取更大值 —— 一口气读几十个文件时锚点还是旧的，会漏判。
    const usage = chatContextUsage(chatId);
    const liveUsed = live && Array.isArray(live.msgs) ? Math.max(usage.used, packageTokens(live.msgs, live.tools)) : usage.used;
    if (liveUsed < limit * 0.8) return false;
    const pct = Math.round(liveUsed / limit * 100);
    if (!modelRow) {
      send({ t: 'note', message: `上下文已达 ${liveUsed}/${limit} tok，但本机没有可用模型来生成摘要，未自动压缩。` });
      return false;
    }
    const from = { chat: '会话设定', model: '模型上限', default: '全局默认' }[source] || source;
    autoCompressCount++;
    // 「先压缩、再回答」要在消息流里看得见（他点名要的）：t:'compress' 走实时渲染，卡片同时进
    // turnCompressSteps 落库，两边是同一张卡的不同阶段。
    const card = { type: 'compress', phase: 'start', used: liveUsed, limit, percent: pct, from };
    turnCompressSteps.push(card);
    send({ t: 'compress', phase: 'start', used: liveUsed, limit, percent: pct, basis: usage.basis, from });
    try {
      const r = await compressChat(chatId, modelRow, makeDispatcher(modelRow), controller.signal);
      if (r.skipped) {
        const m = r.message || '最近交互保留中，没有可压缩的内容';
        Object.assign(card, { phase: 'skipped', message: m });
        send({ t: 'compress', phase: 'skipped', used: liveUsed, limit, percent: pct, message: m });
        return false;
      }
      const after = chatContextUsage(chatId);
      Object.assign(card, { phase: 'done', after: after.used, after_basis: after.basis, chars: r.length, archived: r.archived, summary: r.summary });
      send({ t: 'compress', phase: 'done', used: liveUsed, limit, percent: pct, after: after.used, after_basis: after.basis, chars: r.length, archived: r.archived, summary: r.summary });
      return true;
    } catch (e) {
      const msg = String(e.message || e).substring(0, 160);
      Object.assign(card, { phase: 'failed', message: msg });
      send({ t: 'compress', phase: 'failed', used: liveUsed, limit, percent: pct, message: msg });
      send({ t: 'note', message: `自动压缩失败：${msg}（继续使用原上下文）` });
      return false;
    }
  };

  const controller = new AbortController();
  // 注意：不能监听 req 'close'（请求体读完即触发会误杀上游请求）；
  // res 'close' 且响应未正常结束时 = 客户端断开 → 终止上游与正在运行的命令，并拒绝待审批
  const onAbort = () => {
    controller.abort();
    // 「停止」也要收整棵进程树：只 kill 直接子进程会留下 node/npm 之类的孤儿（procguard 只认本服务登记的 PID）
    if (toolHolder.child) { procguard.killTree(toolHolder.child.pid).catch(() => {}); }
    for (const deny of onAbort.deniedList.splice(0)) deny();
  };
  onAbort.deniedList = [];
  res.on('close', () => { if (!res.writableEnded) onAbort(); });
  const toolHolder = { child: null, pid: null, command: '', manualTimeout: null };
  // 工具执行心跳：长命令运行期间 SSE 完全静默，前端会误判「无输出」；此处定期发送活动信号
  const heartbeatTimer = setInterval(() => {
    if (toolHolder.child) send({ t: 'heartbeat', pid: toolHolder.pid, command: String(toolHolder.command || '').substring(0, 120), elapsed_ms: toolHolder.startedAt ? Date.now() - toolHolder.startedAt : null });
  }, 15000);
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
  controller.signal.addEventListener('abort', () => {
    if (toolHolder.child) { procguard.killTree(toolHolder.child.pid).catch(() => {}); }
  });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const send = (obj) => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    } catch (e) { /* 客户端已断开 */ }
  };

  const insertMsg = db.prepare('INSERT INTO ai_chat_messages (chat_id, role, content) VALUES (?, ?, ?)');
  const insertAssistantMsg = db.prepare('INSERT INTO ai_chat_messages (chat_id, role, content, model_row_id, reasoning, steps_json, unfinished) VALUES (?, ?, ?, ?, ?, ?, ?)');

  (async () => {
    const started = Date.now();
    let fullReply = '';
    let fullReasoning = '';
    let errSent = false;
    let userMsgId = null;
    let turnThinkingLevel = ''; // 本轮生效的思考档位（会话行建好后算出，fetchUpstream 用它而非再读库）
    let continueSynthetic = null; // 继续生成模式：合成继续指令（assistant 半截 + user 继续要求）
    try {
      if (!chatId) {
        chatTitle = stripImageTokens(content).trim().substring(0, 30) || '新对话';
        // 新会话默认上下文窗口（设置页 default_context_limit，0=不限）
        const defCtx = (() => { const n = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'default_context_limit'").get()?.value); return Number.isInteger(n) && n > 0 ? n : 0; })();
        const r = db.prepare('INSERT INTO ai_chats (user_id, model_row_id, title, project_id, cwd, plan_mode, context_limit) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(1, poolRows[0].id, chatTitle, project ? project.id : null, cwd, planMode ? 1 : 0, defCtx);
        chatId = Number(r.lastInsertRowid);
      } else {
        // 已有会话：跟随本次发送的模型与工作目录（项目会话的 cwd 已被 clamp 在项目根内）
        db.prepare('UPDATE ai_chats SET model_row_id = ?, cwd = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(poolRows[0].id, cwd, chatId);
      }
      touchChatStmt.run(chatId);
      if (requestedApprovalMode) setChatApprovalMode(chatId, requestedApprovalMode);
      // 本轮实际生效的思考档位：请求体优先（界面下拉当前显示的），其次会话存量值；
      // 生效值回写会话行，保证「库里存的 = 这轮用的 = 界面显示的」。
      // 新建会话时 chatRow 为 null，所以回写不能挂在 chatRow 上判断。
      const chatThinkLv = chatRow ? String(chatRow.thinking_level || '') : '';
      turnThinkingLevel = requestedThinkingLevel || chatThinkLv;
      if (turnThinkingLevel && turnThinkingLevel !== chatThinkLv) {
        try { db.prepare('UPDATE ai_chats SET thinking_level = ? WHERE id = ?').run(turnThinkingLevel, chatId); } catch (e) { /* 旧库无该列时忽略 */ }
        if (chatRow) chatRow.thinking_level = turnThinkingLevel;
      }
      if (continueMode) {
        // 继续生成：定位最后一条未完成回复（意外中断/手动停止）；找不到则拒绝
        const lastUnfinished = db.prepare(
          "SELECT id, content, reasoning FROM ai_chat_messages WHERE chat_id = ? AND role = 'assistant' AND unfinished = 1 ORDER BY id DESC LIMIT 1"
        ).get(chatId);
        if (!lastUnfinished) {
          send({ t: 'error', message: '没有可继续的未完成回复' });
          errSent = true;
          return;
        }
        // 撤回定位：以该未完成回复前最近的用户消息为准（撤回它将级联删除其后的所有回复）
        const originUser = db.prepare(
          "SELECT id FROM ai_chat_messages WHERE chat_id = ? AND role = 'user' AND id < ? ORDER BY id DESC LIMIT 1"
        ).get(chatId, lastUnfinished.id);
        userMsgId = originUser ? originUser.id : null;
        // 继续指令（不落库）：history 已含未完成回复正文，若它带思考则一并附给模型
        const seenNote = lastUnfinished.reasoning
          ? `\n\n另外，你在生成上面这条回复时的思考过程如下（可能未完成），请一并参考并衔接：\n${lastUnfinished.reasoning}`
          : '';
        continueSynthetic = [
          { role: 'user', content: `你上一次的回复被中断了（上文最后一条 assistant 消息是你已生成的部分${lastUnfinished.reasoning ? '，其思考过程也附在下方' : ''}）。请把全部上文看作你自己的连续输出，从中断处继续：不要重新思考，不要重复已输出的内容，接着写完剩余部分即可。${seenNote}` }
        ];
        db.prepare('UPDATE ai_chat_messages SET unfinished = 0 WHERE id = ?').run(lastUnfinished.id); // 立刻清除标记（再次中断会重新标记）
      } else {
        // 托管：监工替用户下发的命令也是一条 user 消息，打上 speaker 让界面标出「监工」，
        // 用户一眼能分清哪句是自己说的、哪句是监工替自己说的
        const userInsert = userSpeaker
          ? db.prepare('INSERT INTO ai_chat_messages (chat_id, role, content, speaker) VALUES (?, ?, ?, ?)').run(chatId, 'user', content, userSpeaker)
          : insertMsg.run(chatId, 'user', content);
        userMsgId = Number(userInsert.lastInsertRowid);
        send({ t: 'chat', chat_id: chatId, title: chatTitle, user_message_id: Number(userInsert.lastInsertRowid), user_speaker: userSpeaker || undefined });
      }

      // 从库里重建「上文基底」：摘要前缀 + 未归档消息（最新 60 条再正序）。
      // 单独抽出来是因为回合中间自动压缩后，必须用它换掉 upstreamMsgs 里那段旧基底，
      // 否则摘要虽然生成了、发出去的却还是原始全文，压缩等于白做。
      const buildBaseMsgs = () => {
        const meta = db.prepare('SELECT summary FROM ai_chats WHERE id = ?').get(chatId) || {};
        const history = db.prepare(
          "SELECT role, content FROM (SELECT id, role, content FROM ai_chat_messages WHERE chat_id = ? AND archived = 0 ORDER BY id DESC LIMIT 60) ORDER BY id ASC"
        ).all(chatId);
        // 截断后开头若是悬挂的 assistant（它对应的 user 已被截掉），丢弃到最近一条 user 为止，
        // 避免「无 summary 且首条为 assistant」的畸形上下文
        while (history.length && history[0].role !== 'user') history.shift();
        const out = [];
        if (meta.summary) {
          out.push(
            { role: 'user', content: '[此前对话的摘要，供你参考]\n' + meta.summary },
            { role: 'assistant', content: '明白，我已了解之前的对话内容，请继续。' }
          );
        }
        out.push(...history.map(h => buildUpstreamContent(h.role, stripLegacyToolLog(h.content))));
        // 继续生成模式：未完成回复之后追加合成指令（history 已包含到未完成回复为止的全部上文）
        if (continueSynthetic) out.push(...continueSynthetic);
        return out;
      };

      // 上下文窗口：用量达 80% 自动压缩（窗口取自会话设定 / 模型上限 / 全局默认）
      await maybeAutoCompress(poolRows[0]);

      // 上下文：历史摘要前缀 + 未归档消息（取最新 60 条再正序；超长对话旧消息被截断，新消息永远在场）
      const baseMsgs = buildBaseMsgs();

      // 上游请求：429 自动重试；include_usage 设置开启时带 stream_options（用量统计需要）
      const includeUsage = (db.prepare("SELECT value FROM settings WHERE key = 'include_usage'").get()?.value ?? '1') !== '0';
      let thinkOffRequested = false; // 会话设置 off：请求关闭思考；若模型仍输出思考则把思考作为正文（入库进上下文）
      // 言论审查：命中列表中的词汇时终止
      const censoredList = String(chatRow?.censored_words || '').split(/[,，\n;；]+/).map(s => s.trim()).filter(Boolean);
      const hitCensored = (text) => {
        if (!censoredList.length || !text) return null;
        const lower = String(text).toLowerCase();
        for (const w of censoredList) {
          if (lower.includes(String(w).toLowerCase())) return w;
        }
        return null;
      };
      // 用户消息预检
      const userHit = hitCensored(content);
      if (userHit) {
        send({ t: 'error', message: `本轮对话因包含审查词汇“${userHit}”已自动终止` });
        errSent = true;
        fullReply = `[已终止：包含审查词汇“${userHit}”]`;
        insertAssistantMsg.run(chatId, 'assistant', fullReply, poolRows[0].id, '', null);
        touchChatStmt.run(chatId);
        return;
      }
      const fetchUpstream = async (row, body) => {
        let resp = null;
        const payload = { ...body, stream: true };
        if (includeUsage) payload.stream_options = { include_usage: true };
        // 模型配置透传（不传任何联网搜索相关参数：统一不允许）
        const temp = chatRow ? chatRow.temperature : 0.7;
        if (Number.isFinite(temp)) payload.temperature = Number(temp);
        if (chatRow) {
          if (Number.isFinite(chatRow.frequency_penalty)) payload.frequency_penalty = Number(chatRow.frequency_penalty);
          if (Number.isFinite(chatRow.presence_penalty)) payload.presence_penalty = Number(chatRow.presence_penalty);
        }
        // 思考分级：档位取本轮生效值 turnThinkingLevel（请求体 > 会话行；档位词 auto/on/off/minimal/low/medium/high/xhigh，
        // 界面另给 max，归到最高档）。
        // 各家上游参数样式不同（reasoning_effort / thinking{type} / thinking{budget_tokens} /
        // reasoning{effort} / enable_thinking / chat_template_kwargs），按序尝试；
        // 仅当 400 错误体确实点到该参数时才换下一种样式（无关 400 不得误轮转，否则会连累正确参数被剥离），
        // 样式用尽则不带思考参数按模型默认继续。命中后记住该样式，下次直接命中不再轮转。
        const norm = thinking.normalizeThinkingLevel(turnThinkingLevel, row.thinking_levels);
        const eff = norm.effort;
        // Anthropic 只有 thinking:{type,budget_tokens} 一种形状，不参与 OpenAI 系的多样式轮转
        const thinkingVariants = protocols.styleOf(row) === 'anthropic' ? protocols.anthropicVariants(norm) : thinking.variantsFor(norm);
        const variantKey = `${row.id}|${norm.mode}|${eff || ''}`;
        const remembered = thinkingStyleCache.get(variantKey);
        // off：主动发送各家的「关闭思考」参数（逐样式尝试）；全被拒则不带参数（个别默认思考模型关不掉，
        // 由 consumeStream 侧把 reasoning 当正文输出）
        if (norm.mode === 'off') thinkOffRequested = true;
        let variantIdx = thinkingVariants.length ? 0 : -1;
        if (remembered !== undefined && remembered >= 0 && remembered < thinkingVariants.length) variantIdx = remembered;
        if (variantIdx >= 0) Object.assign(payload, thinkingVariants[variantIdx].fields(eff));
        const variantFieldRx = (v) => {
          const keys = Object.keys(v.fields(eff));
          return new RegExp(keys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
        };
        let rlRetry = 0;   // 429 限流重试计数（独立于变体切换，互不挤占）
        let gwRetry = 0;   // 524/504 网关超时重试计数（同参数重试，不切变体）
        let samplingStripped = false; // 已剥离 penalty/temperature（部分模型要求 presence_penalty 恒为 0）
        // 429 最大重试次数可在设置页自定义（rl_retry_max，默认 16）
        const rlMax = (() => { const n = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'rl_retry_max'").get()?.value); return Number.isInteger(n) && n >= 0 ? n : 16; })();
        for (let attempt = 0; attempt < rlMax + 8; attempt++) {
          // 按提供商协议构造真实请求（openai 直通；anthropic/custom 由 protocols 翻译）
          const req = protocols.buildChatRequest(row, payload);
          resp = await fetch(req.url, {
            method: req.method,
            headers: req.headers,
            body: JSON.stringify(req.body),
            dispatcher: makeDispatcher(row),
            signal: controller.signal
          });
          if (resp.status === 429 && rlRetry < rlMax) {
            rlRetry++;
            send({ t: 'note', message: `[${row.display_name}] 上游限流(429)，${rlRetry * 2} 秒后自动重试（${rlRetry}/${rlMax}）…` });
            await sleep(rlRetry * 2000);
            continue;
          }
          // 524/504：代理/网关超时（Cloudflare 等），等待后按原参数重试
          if ((resp.status === 524 || resp.status === 504) && gwRetry < 2) {
            gwRetry++;
            send({ t: 'note', message: `[${row.display_name}] 上游网关超时(${resp.status})，3 秒后重试（${gwRetry}/2）…` });
            await sleep(3000);
            continue;
          }
          if (resp.status === 400) {
            // 读取错误体一次并缓存（供调用方报告；避免二次读取拿到空串）
            if (!resp._errBody) { try { resp._errBody = await resp.text(); } catch (e) { resp._errBody = ''; } }
            const bt = resp._errBody;
            // 1) 采样参数被拒（如 kimi 系 presence_penalty 恒为 0 / temperature 不可用）：剥离后重试
            if (!samplingStripped && /penalt|temperature|sampling/i.test(bt)) {
              samplingStripped = true;
              delete payload.frequency_penalty;
              delete payload.presence_penalty;
              delete payload.temperature;
              send({ t: 'note', message: `[${row.display_name}] 采样参数不受支持（penalty/temperature），已移除后重试…` });
              continue;
            }
            // 2) 思考参数被拒（错误体确实提到该参数名）：换下一种样式；样式用尽后回退为不带思考参数
            if (variantIdx >= 0 && variantIdx < thinkingVariants.length && thinking.isThinkingParamError(bt)) {
              const bad = thinkingVariants[variantIdx];
              for (const k of Object.keys(bad.fields(eff))) delete payload[k];
              variantIdx++;
              if (variantIdx < thinkingVariants.length) {
                send({ t: 'note', message: `[${row.display_name}] 思考参数样式 ${bad.label} 不受支持，尝试 ${thinkingVariants[variantIdx].label}…` });
                Object.assign(payload, thinkingVariants[variantIdx].fields(eff));
              } else {
                thinkingStyleCache.set(variantKey, -1);
                send({ t: 'note', message: norm.mode === 'off'
                  ? `[${row.display_name}] 关闭思考的参数均不受支持，若模型仍输出思考将把思考内容作为正文处理…`
                  : `[${row.display_name}] 思考参数均不受支持，按模型默认模式继续（默认思考的模型仍会输出思考）…` });
              }
              continue;
            }
          }
          if (!resp.ok && !resp._errBody) { try { resp._errBody = await resp.text(); } catch (e) { resp._errBody = ''; } }
          break;
        }
        // 记住本模型可用的思考样式（下次直接命中，不再逐个试错）
        if (resp.ok && variantIdx >= 0 && variantIdx !== remembered) {
          thinkingStyleCache.set(variantKey, variantIdx);
          const label = norm.mode + ':' + (thinkingVariants[variantIdx] ? thinkingVariants[variantIdx].label : 'none');
          if (row.thinking_style !== label) {
            row.thinking_style = label;
            try { db.prepare('UPDATE ai_models SET thinking_style = ? WHERE id = ?').run(label, row.id); } catch (e) { /* 旧库无列时忽略 */ }
          }
        }
        return resp;
      };

      // 解析一条 SSE 流：content 增量转发、reasoning 转发、tool_calls 分片累积、usage 提取
      // providerRow：用于按提供商协议把非 OpenAI 形状的增量归一化（openai 直通，anthropic/custom 由 protocols 翻译）
      // 中断（网络断/流内错误 chunk）时把已生成的 content 与本轮思考挂到 error.partial 上抛出，供上层续接/入库
      const consumeStream = async (resp, providerRow = null) => {
        const normalizeChunk = protocols.createChunkNormalizer(providerRow || { api_style: 'openai' });
        let content = '';
        let usage = null;
        const tcAcc = new Map();
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let firstDeltaTs = 0;
        let lastDeltaTs = 0;
        let roundReasoning = ''; // 本轮思考（区别于跨轮累积的 fullReasoning，续接时携带）
        // 内联思考拆分器：部分模型不走 reasoning_content 字段，而把思考混在正文里（think 类标签或原生特殊 token）
        const splitter = thinking.createReasoningSplitter();
        // 归一化一条增量：kind='reason' 走思考通道，kind='content' 走正文通道
        const emitPiece = (text, isReasoning) => {
          if (!text) return;
          if (isReasoning) {
            if (thinkOffRequested) {
              // 用户要求关闭思考但模型仍输出：思考内容按正文处理（前端直接显示 + 入库进上下文）
              content += text;
              send({ t: 'delta', text });
              return;
            }
            const hit = hitCensored(text);
            if (hit) {
              try { controller.abort(); } catch(e) {}
              const cErr = new Error(`审查终止：包含词汇“${hit}”`);
              cErr.__khCensored = true;
              throw cErr;
            }
            roundReasoning += text;
            fullReasoning += text;
            send({ t: 'reason', text });
            return;
          }
          const hit = hitCensored(text);
          if (hit) {
            try { controller.abort(); } catch(e) {}
            const cErr = new Error(`审查终止：包含词汇“${hit}”`);
            cErr.__khCensored = true;
            throw cErr;
          }
          content += text;
          send({ t: 'delta', text });
        };
        const emitContentDelta = (chunk) => {
          const part = splitter.push(chunk);
          emitPiece(part.content, false);
          emitPiece(part.reasoning, true);
        };
        const attachPartial = (e) => {
          if (e && typeof e === 'object') e.partial = { content, reasoning: roundReasoning, usage };
          return e;
        };
        for (;;) {
          let done, value;
          try {
            ({ done, value } = await reader.read());
          } catch (e) {
            // 用户手动停止（客户端断开）：把已生成的部分内容带回，由上层入库（保留在完整上下文中）
            if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) return { content, tcAcc, usage, reasoning: roundReasoning, aborted: true };
            throw attachPartial(e);
          }
          if (done) break;
          // 纯生成时长统计（首末 SSE 数据字节间隔，不含工具执行时间）
          {
            const now2 = Date.now();
            if (!firstDeltaTs) firstDeltaTs = now2;
            lastDeltaTs = now2;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const json = normalizeChunk(JSON.parse(payload), payload);
              if (!json) continue;
              // 上游在流内下发错误 chunk（如输出长度上限被截断的 terminated 提示）：
              // 抛出中断错误，由上层把已生成内容入库保留上下文并向用户报错
              if (json.error) {
                const upErr = new Error(`上游错误：${json.error.message || JSON.stringify(json.error).substring(0, 200)}`);
                upErr.__khUpstream = true;
                upErr.partial = { content, reasoning: roundReasoning, usage };
                throw upErr;
              }
              const delta = json.choices?.[0]?.delta;
              // 正文：经思考拆分器（内联 think 标签 / 原生 token 会被切到思考通道）
              if (delta && typeof delta.content === 'string' && delta.content) emitContentDelta(delta.content);
              // 独立思考字段：reasoning_content（DeepSeek/Qwen/vLLM 系）或 reasoning（OpenRouter 系）
              const rField = typeof delta?.reasoning_content === 'string' ? delta.reasoning_content
                : (typeof delta?.reasoning === 'string' ? delta.reasoning : '');
              if (rField) emitPiece(rField, true);
              if (delta && Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  const acc = tcAcc.get(idx) || { id: '', name: '', args: '' };
                  if (tc.id) acc.id = tc.id;
                  if (tc.function?.name) acc.name += tc.function.name;
                  if (tc.function?.arguments) acc.args += tc.function.arguments;
                  tcAcc.set(idx, acc);
                  const hit = hitCensored(acc.name + ' ' + acc.args);
                  if (hit) {
                    try { controller.abort(); } catch(e) {}
                    const cErr = new Error(`审查终止：工具调用包含词汇“${hit}”`);
                    cErr.__khCensored = true;
                    throw cErr;
                  }
                }
              }
              if (json.usage && typeof json.usage === 'object') {
                usage = {
                  prompt_tokens: Number(json.usage.prompt_tokens) || 0,
                  completion_tokens: Number(json.usage.completion_tokens) || 0,
                  cached_tokens: Number(json.usage.prompt_tokens_details?.cached_tokens) || 0,
                  reasoning_tokens: Number(json.usage.completion_tokens_details?.reasoning_tokens) || 0
                };
              }
            } catch (e) {
              // 审查终止/上游错误需向上传播（不能被「非 JSON 行跳过」吞掉）
              if (e && (e.__khCensored || e.__khUpstream)) throw e;
              /* 非 JSON 行跳过 */
            }
          }
        }
        // 流结束：把因等待标签完整性而暂存的尾巴落地
        const tail = splitter.flush();
        if (tail.content || tail.reasoning) { emitPiece(tail.content, false); emitPiece(tail.reasoning, true); }
        return { content, tcAcc, usage, genMs: lastDeltaTs > firstDeltaTs ? lastDeltaTs - firstDeltaTs : 0, reasoning: roundReasoning };
      };

      // 用量入库：缓存命中单独记（计费时 cached 按 price_cache，其余输入按 price_in）
      const logUsage = (row, usage) => {
        if (!usage || !row) return;
        try {
          db.prepare('INSERT INTO usage_log (chat_id, project_id, model_row_id, prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(chatId, chatRow?.project_id ?? project?.id ?? null, row.id, usage.prompt_tokens, usage.completion_tokens, usage.cached_tokens, usage.reasoning_tokens);
        } catch (e) { /* 统计失败不影响主流程 */ }
      };

      // 续接指令：向上游模型解释清楚（长度上限截断 + 已附思考/正文 + 从中断处继续）
      const continuePrompt = '你上一次回复因达到单次输出长度上限被中断。上方附上了你已完成的思考过程与已输出的正文。请直接从中断处继续完成回复：不要重新从头思考，不要重复已输出的内容，接着写完剩余部分即可。';

      // 普通流式（单模型，支持池内 failover）
      // 任何中断（手动停止/输出长度上限/网络断开/上游错误 chunk）都带上已生成内容返回，
      // 由主流程入库保留上下文（撤回除外——撤回会删除本轮用户消息，入库前有存在性检查）
      /**
       * 不开 Agent 时该带的那段 AGENTS.md。
       * 修一个老洞：以前只有 Agent 模式会拼系统提示词，纯聊天一条 system 都不发 ——
       * 同一份 AGENTS.md 在 Agent 开 / 关时效果不一样，主人写的「始终中文回答」「不许硬编码密钥」
       * 在关 Agent 时直接消失，看起来就像「这文件没生效」。
       */
      const plainAgentsBlock = async () => {
        const rh = remoteHostFor(chatId);
        const files = rh
          ? await collectAgentsMdRemote(rh, project ? project.root_path : null, cwd)
          : collectAgentsMd(project ? project.root_path : null, cwd);
        return agentsMd.promptBlock(files);
      };

      const streamPlain = async (msgs, rows) => {
        let lastText = '';
        let lastUsage = null;
        let genMsSum = 0;
        let curRow = null;   // catch 里要说清楚是哪个模型断的（row 是 for 里的 const，外面拿不到）
        const block = await plainAgentsBlock().catch(() => '');
        const outMsgs = block ? [{ role: 'system', content: block }, ...msgs] : msgs;
        try {
          for (let mi = 0; mi < rows.length; mi++) {
            const row = rows[mi];
            curRow = row;
            if (mi > 0) send({ t: 'model', id: row.id, name: row.display_name });
            const resp = await fetchUpstream(row, { model: row.model_id, messages: outMsgs });
            if (!resp.ok) {
              const detail = (resp._errBody || await resp.text().catch(() => '')).substring(0, ERROR_MAX_LEN);
              if (mi < rows.length - 1) {
                send({ t: 'note', message: `[${row.display_name}] 请求失败(HTTP ${resp.status}${oneLine(detail, 200) ? '：' + oneLine(detail, 200) : ''})，切换下一个模型…` });
                continue;
              }
              send({ t: 'error', message: `HTTP ${resp.status}: ${detail || resp.statusText}` });
              errSent = true;
              return { text: lastText, used: null, usage: lastUsage, genMs: genMsSum };
            }
            let r0;
            try {
              r0 = await consumeStream(resp, row);
              // 流正常结束但只有思考、没有正文也没有工具调用（部分思考模型的行为）：
              // 自动携带思考追问一轮，让模型基于思考直接产出
              if (!r0.aborted && !String(r0.content || '').trim() && r0.tcAcc.size === 0 && String(r0.reasoning || '').trim()) {
                send({ t: 'note', message: `[${row.display_name}] 本轮只输出了思考没有正文，自动携带思考继续产出…` });
                const nudgeMsgs = [...msgs,
                  { role: 'assistant', content: `[思考过程（已完成）]\n${r0.reasoning}` },
                  { role: 'user', content: '你刚才只完成了思考过程，还没有输出任何正文或发起任何工具调用。上面附有你完整的思考。请基于这些思考直接继续完成任务：该输出正文就输出正文，该调用工具就调用工具，不要再重复思考。' }
                ];
                const respNudge = await fetchUpstream(row, { model: row.model_id, messages: nudgeMsgs });
                if (respNudge.ok) {
                  const rN = await consumeStream(respNudge, row);
                  r0 = {
                    content: rN.content || '',
                    tcAcc: rN.tcAcc,
                    usage: rN.usage || r0.usage,
                    genMs: (r0.genMs || 0) + (rN.genMs || 0),
                    reasoning: ((r0.reasoning || '') + '\n' + (rN.reasoning || '')) || null,
                    aborted: rN.aborted || false
                  };
                }
              }
            } catch (e) {
              // 单次输出长度上限（terminated）：携带已思考/已输出内容自动续写一次
              if (e && e.__khUpstream && /terminated|length|token/i.test(String(e.message)) && e.partial) {
                send({ t: 'note', message: `[${row.display_name}] 单次输出达长度上限，携带已思考内容自动续写…` });
                const carry = [];
                if (e.partial.reasoning) carry.push({ role: 'assistant', content: `[上轮思考过程（达到单次输出长度上限被截断，未完成）]\n${e.partial.reasoning}` });
                if (e.partial.content) carry.push({ role: 'assistant', content: `[上轮已输出正文（被截断）]\n${e.partial.content}` });
                const contMsgs = [...msgs, ...carry, { role: 'user', content: continuePrompt }];
                const resp2 = await fetchUpstream(row, { model: row.model_id, messages: contMsgs });
                if (!resp2.ok) throw e;
                r0 = await consumeStream(resp2, row);
                r0.content = (e.partial.content || '') + (r0.content || '');
              } else {
                throw e;
              }
            }
            logUsage(row, r0.usage);
            if (r0.usage) lastUsage = r0.usage;
            genMsSum += r0.genMs || 0;
            if (r0.aborted) {
              // 手动停止：已生成正文入库；正文为空时把已思考内容并入正文（思考保留进上下文）
              let stopped = r0.content || lastText;
              if (!stopped.trim() && r0.reasoning) stopped = `[思考过程（本轮回复被手动停止，以下为已完成的思考）]\n${r0.reasoning}`;
              return { text: stopped, used: row, usage: lastUsage, genMs: genMsSum, aborted: true };
            }
            if (r0.tcAcc.size === 0) return { text: r0.content, used: row, usage: lastUsage, genMs: genMsSum };
            // 罕见：普通模式收到工具调用，追加提示后按文本处理
            lastText = r0.content;
          }
        } catch (e) {
          if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) {
            return { text: lastText, used: null, usage: lastUsage, genMs: genMsSum, aborted: true };
          }
          // 意外中断（单次输出长度上限/网络断开等）：已生成内容照常入库，同时向用户报错
          errSent = true;
          const why = errDetail(e);
          console.error(`[stream] 普通流中断 · ${curRow ? curRow.display_name : '未知模型'} · ${why}`);
          send({ t: 'error', message: `流式输出中断 · ${curRow ? curRow.display_name + ' · ' : ''}${why}`.substring(0, ERROR_MAX_LEN + 120) });
          // 中断瞬间的部分正文并入；正文为空时把已思考内容并入正文入库（思考因此保留进上下文）
          let rescued = lastText;
          if (e && e.partial) {
            if (e.partial.content) rescued += (rescued ? '\n' : '') + e.partial.content;
            if (!rescued.trim() && e.partial.reasoning) rescued = `[思考过程（回复因单次输出长度上限中断，以下为本轮已完成的思考）]\n${e.partial.reasoning}`;
          }
          return { text: rescued, used: null, usage: lastUsage, genMs: genMsSum, interrupted: true };
        }
        return { text: lastText, used: rows[rows.length - 1], usage: lastUsage, genMs: genMsSum };
      };

      // Agent 工具循环（模型池 failover + 审批门 + 参数校验 + 脱敏 + 任务联动 + 全文本累积）
const runAgent = async (msgs, rows) => {
        const steps = [];
        let allText = '';
        // 远程会话：AGENTS.md 要从远端读、系统提示词要讲清「你在别人的机器上」
        const remoteHost = remoteHostFor(chatId);
        const agentsFiles = remoteHost
          ? await collectAgentsMdRemote(remoteHost, project ? project.root_path : null, cwd)
          : collectAgentsMd(project ? project.root_path : null, cwd);
        // /skills-load 勾选的技能：正文常驻本次会话的系统提示词
        const loadedSkillObjs = (chatId ? getLoadedSkills(chatId) : [])
          .map(n => listSkills().find(s => s.name === n)).filter(Boolean);
        const promptOpts = { projectRoot: project ? project.root_path : null, planMode, agentsFiles, readonlyMode, loadedSkills: loadedSkillObjs, remote: remoteHost };
        const upstreamMsgs = [{ role: 'system', content: agentSystemPrompt(cwd, promptOpts) }, ...msgs];
        // 上游消息里「上文基底」占 1..baseLen（0 是 system），其后才是本轮新增的问答与工具往返。
        // 回合中间压缩时要按这个区间整段替换，所以长度得跟着变。
        let baseLen = msgs.length;
        let usedModel = null;
        const step = (st) => steps.push(st);
        // 多轮 usage 汇总：completion/reasoning 累加；prompt/cached 取最大轮（代表最终上下文）
        const usageAcc = { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, reasoning_tokens: 0, rounds: 0 };
        const accUsage = (u) => {
          if (!u) return;
          usageAcc.rounds++;
          usageAcc.completion_tokens += Number(u.completion_tokens) || 0;
          usageAcc.reasoning_tokens += Number(u.reasoning_tokens) || 0;
          if ((Number(u.prompt_tokens) || 0) >= usageAcc.prompt_tokens) {
            usageAcc.prompt_tokens = Number(u.prompt_tokens) || 0;
            usageAcc.cached_tokens = Number(u.cached_tokens) || 0;
          }
        };
        let genMsSum = 0;
        // 参数校验失败连续计数（防无限重试浪费 token）：同工具连续 3 次校验失败后强制要求换方案
        let invalidStreak = 0;
        const INVALID_STREAK_MAX = 3;
        // terminated 续接只做一次（再断则按 interrupted 落地，保留已生成内容）
        let continuedOnce = false;
        // 思考空转追问只做一次（防思考模型反复只思考不产出）
        let nudgedOnce = false;
        // 上游因非法 tool_call 参数拒包时，自愈重试只做一次
        let toolArgsHealedOnce = false;
        // 无进展保护：同一 (工具+参数) 连续重复次数，达到阈值即打断循环
        let lastCallKey = '';
        let repeatStreak = 0;
        let totalSteps = 0;
        const sysIdx = 0; // upstreamMsgs[0] 恒为 system
        // 用户 /insert 预埋的提示词：取出即清空，一条只注入一次。
        // 主注入点是一批工具结果回喂完之后（feedResultsDone），这里的调用留作兜底：
        // 下一次请求模型前再查一次，覆盖「上一批被中断/没有回喂机会」的情况。
        const injectAtBoundary = () => {
          if (!chatId) return 0;
          const lines = takeInsertBuffer(chatId);
          if (!lines.length) return 0;
          upstreamMsgs.push({
            role: 'user',
            content: '[工具结果回喂时插入提示词_用户输入]\n' + lines.map(l => `- ${l}`).join('\n') +
              '\n（以上是用户在工具中断点临时补充的指示，来自本机界面输入，优先级高于此前你自己制定的计划；请据此调整后续动作，必要时先重排任务再继续）'
          });
          send({ t: 'insert_injected', count: lines.length, items: lines });
          step({ type: 'insert', items: lines });
          return lines.length;
        };
        // 实验室「未提交变更提醒」：回合开始时若工作区脏，往上下文里塞一条界面提醒（不入库，不冒充用户输入）
        let uncommittedChecked = false;
        const remindUncommitted = async () => {
          if (!labs.uncommittedTip || uncommittedChecked) return;
          uncommittedChecked = true;
          // 远程会话要去那台机器上问 git（本机对 /home/ker 跑 git 只会静默失败，等于这个开关对远程无效）
          const tipHost = remoteHostFor(chatId);
          const st = tipHost ? await gitRunRemote(tipHost, cwd, ['status', '--porcelain']) : await gitRun(cwd || process.cwd(), ['status', '--porcelain']);
          if (!st.ok) return;   // 不是仓库或 git 不可用：不打扰
          const lines = String(st.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
          if (!lines.length) return;
          upstreamMsgs.push({
            role: 'user',
            content: '[未提交变更提醒_界面自动注入]\n工作区 ' + (cwd || process.cwd()) + ' 有 ' + lines.length + ' 项未提交变更：\n'
              + lines.slice(0, 20).map(l => '  ' + l).join('\n')
              + (lines.length > 20 ? `\n  …（另有 ${lines.length - 20} 项未列出）` : '')
              + '\n（这不是用户说的话。若这些变更与本次任务无关，忽略即可；若像是你上一轮留下的半成品或被中断的改动，请主动向用户说明并询问要不要提交/继续，禁止自作主张 git commit。）'
          });
          send({ t: 'note', message: `实验室：检测到 ${lines.length} 项未提交变更，已提醒 Agent 评估` });
          step({ type: 'note', message: `未提交变更 ${lines.length} 项，已注入提醒` });
        };
        // ask_user：把问题推给前端横幅，挂起等待用户点选/输入（与审批同一套通道）
        const askCtx = {
          ask: ({ question, options, timeoutMs }) => {
            const qid = crypto.randomBytes(8).toString('hex');
            send({ t: 'question', id: qid, question, options: options || [], chat_id: chatId, timeout_ms: timeoutMs || QUESTION_DEFAULT_TIMEOUT });
            step({ type: 'question', question, options: options || [] });
            return waitQuestion(qid, chatId, timeoutMs, onAbort.deniedList);
          }
        };
        if (chatId) {
          activeHolders.set(chatId, toolHolder);
          // 子智能体的进度要顺着父会话这条流出来，这里把 send 交给宿主注册表
          subagentSenders.set(chatId, send);
          releaseQuestionsForChat(chatId);
        }
        const withTextProtocol = (on) => {
          const base = agentSystemPrompt(cwd, promptOpts);
          upstreamMsgs[sysIdx] = { role: 'system', content: on ? base + '\n\n' + texttool.textToolPrompt(allToolSchemas()) : base };
        };
        // 模型池逐个失败时，最后那句「所有模型均请求失败」不能只甩一句概括——
        // 记下最后一次失败的原因，让用户在错误条上直接看到是上游 401 / 超时 / 不支持工具哪种。
        let poolFail = '';
        // 任何中断（手动停止/输出长度上限/网络断开/审查终止）都带上已生成内容返回，
        // 由主流程入库保留上下文（撤回除外——撤回删除本轮用户消息，入库前有存在性检查）
        try {
        for (let mi = 0; mi < rows.length; mi++) {
          const row = rows[mi];
          if (mi > 0) send({ t: 'model', id: row.id, name: row.display_name });
          usedModel = row;
          // 工具调用风格：native 仅原生 function calling；text 强制文本 JSON 协议；
          // auto 先原生，上游拒绝 tools 参数时自动降级为文本协议（多数便宜/新模型走这条路）
          let textMode = String(row.tool_style || 'auto') === 'text';
          withTextProtocol(textMode);
          let failed = false;
          for (let iter = 0; !failed; iter++) {
            if (++totalSteps > AGENT_MAX_STEPS) {
              send({ t: 'note', message: `已达 Agent 步数上限（${AGENT_MAX_STEPS}），停止继续调用工具。可拆成多条消息继续。` });
              step({ type: 'note', message: `已达 Agent 步数上限（${AGENT_MAX_STEPS}）` });
              return { reply: allText + `\n\n[已达 Agent 步数上限 ${AGENT_MAX_STEPS}，任务未继续]`, steps, used: row, usage: usageAcc.rounds ? usageAcc : null, genMs: genMsSum };
            }
            // 安全边界：本轮不是第一次请求模型（说明上一轮的工具有结果要回喂），先交付用户预埋提示词
            if (iter > 0) {
              injectAtBoundary();
              // 一轮里连开几十个工具时，上下文是在回合中间爆掉的，这里补一道
              if (await maybeAutoCompress(row, { msgs: upstreamMsgs, tools: textMode ? null : activeAgentTools() })) {
                const rebuilt = buildBaseMsgs();
                upstreamMsgs.splice(1, baseLen, ...rebuilt);
                baseLen = rebuilt.length;
                step({ type: 'note', message: `已按新摘要重建上游上下文（基底 ${rebuilt.length} 条）` });
              }
            } else await remindUncommitted();   // 实验室：回合开头提醒一次未提交变更
            const body = { model: row.model_id, messages: upstreamMsgs };
            if (!textMode) body.tools = activeAgentTools();
            const resp = await fetchUpstream(row, body);
            if (!resp.ok) {
              const errBody = resp._errBody || await resp.text().catch(() => '');
              // 上游因为「assistant 的 tool_call 参数不是合法 JSON」拒绝整包：
              // 这类错误光靠降级/换模型治不好（毒消息还在 upstreamMsgs 里），
              // 所以上次旧版能重试、新版直接中断。这里就地修参数再发一次，同一模型同一协议。
              if (isToolArgsError(resp.status, errBody) && !toolArgsHealedOnce) {
                toolArgsHealedOnce = true;
                const fixed = sanitizeUpstreamToolCalls(upstreamMsgs);
                send({ t: 'note', message: `[${row.display_name}] 上游拒绝了一处非法的工具调用参数（不是合法 JSON），已就地修复 ${fixed} 处后重试…` });
                step({ type: 'note', message: `上游拒绝工具调用参数，修复 ${fixed} 处后重试` });
                continue;
              }
              // 上游拒绝 tools 参数 → 降级为文本工具协议，同一模型重试（不换模型、不报错）
              if (!textMode && String(row.tool_style || 'auto') !== 'native' && resp.status === 400 && /tool/i.test(errBody)) {
                textMode = true;
                withTextProtocol(true);
                persistToolStyle(row, 'text');
                send({ t: 'note', message: `[${row.display_name}] 不接受原生工具参数，改用文本工具调用协议继续…` });
                step({ type: 'note', message: `[${row.display_name}] 不接受原生工具参数，改用文本工具调用协议继续` });
                continue;
              }
              if (iter === 0 && resp.status === 400 && /tool/i.test(errBody)) {
                send({ t: 'note', message: `[${row.display_name}] 不支持工具调用 · ${oneLine(errBody, 160)}` });
                step({ type: 'note', message: `[${row.display_name}] 不支持工具调用：${oneLine(errBody, 160)}` });
              }
              if (mi < rows.length - 1) {
                const why = `[${row.display_name}] Agent 请求失败(HTTP ${resp.status}${oneLine(errBody, 200) ? '：' + oneLine(errBody, 200) : ''})，切换下一个模型…`;
                poolFail = `[${row.display_name}] HTTP ${resp.status}：${oneLine(errBody, 200) || '上游无错误正文'}`;
                console.error(`[agent] 模型池换人 · ${why}`.substring(0, 1200));
                send({ t: 'note', message: why });
                step({ type: 'note', message: why });
                failed = true;
                break;
              }
              send({ t: 'error', message: `HTTP ${resp.status}: ${oneLine(errBody, ERROR_MAX_LEN) || resp.statusText}` });
              errSent = true;
              return { reply: allText, steps, used: row, usage: usageAcc.rounds ? usageAcc : null, genMs: genMsSum, errorSent: true };
            }
            let r0;
            try {
              r0 = await consumeStream(resp, row);
            } catch (e) {
              // 单次输出长度上限（terminated）：把截断的思考/正文作为上文塞进 upstreamMsgs，
              // 向模型解释清楚后续接（continue 本轮循环重新请求）；只续接一次
              if (e && e.__khUpstream && /terminated|length|token/i.test(String(e.message)) && e.partial && !continuedOnce) {
                continuedOnce = true;
                send({ t: 'note', message: `[${row.display_name}] 单次输出达长度上限，携带已思考内容自动续写…` });
                step({ type: 'note', message: `[${row.display_name}] 单次输出达长度上限，携带已思考内容自动续写` });
                if (e.partial.reasoning) upstreamMsgs.push({ role: 'assistant', content: `[上轮思考过程（达到单次输出长度上限被截断，未完成）]\n${e.partial.reasoning}` });
                if (e.partial.content) {
                  allText += (allText ? '\n' : '') + e.partial.content;
                  upstreamMsgs.push({ role: 'assistant', content: `[上轮已输出正文（被截断）]\n${e.partial.content}` });
                }
                upstreamMsgs.push({ role: 'user', content: continuePrompt });
                continue;
              }
              throw e;
            }
            logUsage(row, r0.usage);
            accUsage(r0.usage);
            genMsSum += r0.genMs || 0;
            if (r0.aborted) {
              // 用户手动停止：把本轮已生成的部分内容累积后返回，由上层入库（保留在完整上下文中）
              // 正文为空时把已思考内容并入正文（思考保留进上下文）
              if (r0.content) {
                allText += (allText ? '\n' : '') + r0.content;
              } else if (!allText.trim() && r0.reasoning) {
                allText = `[思考过程（本轮回复被手动停止，以下为已完成的思考）]\n${r0.reasoning}`;
              }
              return { reply: allText, steps, used: row, usage: usageAcc.rounds ? usageAcc : null, genMs: genMsSum, aborted: true };
            }
            // Plan 模式：<plan> 建任务、<task-status> 同步状态；标签从正文中剥离（不污染上下文）
            // 文本协议模式：抽取正文里的 JSON 调用块并剔除；
            // 原生模式下也抽取一次——弱模型常把调用"写"成正文而没发起 tool_call（此时仅接受已知工具名，避免误执行示例代码）
            let textCalls = [];
            {
              const known = textMode ? null : Object.keys(allToolSchemas());
              const ex = texttool.extractTextCalls(r0.content || '', known);
              if (ex.calls.length) {
                textCalls = ex.calls;
                r0.content = texttool.stripExtractedCalls(r0.content || '', ex.ranges);
                if (!textMode) {
                  // 该模型倾向用文本表达调用：累计两次后记为文本协议模型，下次直接走文本通道
                  if (noteTextAttempt(row)) {
                    send({ t: 'note', message: `[${row.display_name}] 已记录为文本协议模型，后续 Agent 调用将直接按文本协议发起` });
                  }
                }
              }
            }
            if (r0.content) {
              const { text: cleaned, changed } = parseTaskTags(r0.content, chatId);
              allText += (allText ? '\n' : '') + cleaned;
              if (changed) send({ t: 'tasks', tasks: getTasks(chatId) });
            }

            // 原生 tool_calls 优先；原生为空但正文里写出了调用块（弱模型常见）→ 照样执行
            let calls = [...r0.tcAcc.values()].map((tc, i) => ({
              id: tc.id || `call_${iter}_${i}`,
              name: tc.name,
              rawArgs: tc.args || '{}'
            }));
            const fromText = textCalls.length > 0 && calls.length === 0;
            if (fromText) calls = textCalls.map((c, i) => ({ id: `text_${iter}_${i}`, name: c.name, rawArgs: JSON.stringify(c.args || {}) }));

            if (calls.length === 0) {
              // 只有思考、没有正文也没有工具调用（部分思考模型的行为）：
              // 把思考塞进 upstreamMsgs 追问一轮（只一次），让模型基于思考直接产出
              if (!String(r0.content || '').trim() && !allText.trim() && String(r0.reasoning || '').trim() && !nudgedOnce) {
                nudgedOnce = true;
                send({ t: 'note', message: `[${row.display_name}] 本轮只输出了思考没有正文，自动携带思考继续产出…` });
                step({ type: 'note', message: `[${row.display_name}] 本轮只输出了思考没有正文，自动携带思考继续产出` });
                upstreamMsgs.push({ role: 'assistant', content: `[思考过程（已完成）]\n${r0.reasoning}` });
                upstreamMsgs.push({ role: 'user', content: '你刚才只完成了思考过程，还没有输出任何正文或发起任何工具调用。上面附有你完整的思考。请基于这些思考直接继续完成任务：该输出正文就输出正文，该调用工具就调用工具，不要再重复思考。' });
                continue;
              }
              // 「只描述了操作、没有发起工具调用」：不再追问「请真正调用」，也不再据此切换文本协议。
              // 模型说「我来读一下 x」而本轮没开炮，就是它本轮的终态；再拿一句话去逼一轮只会多烧一次上下文，
              // 往往换来同样的描述（弱模型尤其如此）。真要救它请用「模型管理 → 工具风格 = text」。
              return { reply: allText, steps, used: row, usage: usageAcc.rounds ? usageAcc : null, genMs: genMsSum };
            }
            if (fromText) {
              send({ t: 'note', message: `[${row.display_name}] 从正文中识别到文本形式的工具调用，已代为执行` });
              step({ type: 'note', message: `[${row.display_name}] 从正文中识别到文本形式的工具调用，已代为执行` });
            }
            const cleanText = (r0.content || '').replace(/<task-status\b[^>]*\/>\s?/g, '').replace(/<plan>[\s\S]*?<\/plan>/g, '').trim();
            if (textMode) {
              upstreamMsgs.push({ role: 'assistant', content: thinking.scrubNativeTokens(cleanText) || '(发起工具调用)' });
            } else {
              upstreamMsgs.push({ role: 'assistant', content: cleanText, tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: safeArgsJson(c.rawArgs) } })) });
            }
            // 结果回喂：原生模式走 role:'tool'；文本模式没有该通道，用用户消息承载
            const feedResult = (call, text) => {
              if (textMode) upstreamMsgs.push({ role: 'user', content: texttool.textToolResultMessage(call.name, { output: text }) });
              else upstreamMsgs.push({ role: 'tool', tool_call_id: call.id, content: text });
            };
            // 一批工具结果回喂完，立刻把用户 /insert 预埋的提示词塞进上下文（第三十九轮定的时机）。
            // 为什么是「一整批之后」而不是「每一条结果之后」：原生协议要求 assistant 的每个 tool_call
            // 都要有对应的 tool 消息回应完，才能出现别的角色 —— 夹在两条 tool 中间会被上游 400 拒包。
            const feedResultsDone = () => { injectAtBoundary(); };
            // 并发快道：同一批调用全是无副作用的只读工具时并行执行（read/list/grep/glob/web_fetch 与
            // 后台任务、记忆的只读查询），结果按原顺序回喂。有任何一项不满足（含参数不合法）就回落到
            // 下面的串行路径，让既有的校验/审批/打断逻辑原样处理。
            // 外部 API 接口不参与并发：它们按次扣分且有 QPS 限制。
            const CONCURRENT_SAFE = new Set(['read_file', 'list_dir', 'grep', 'glob', 'web_fetch', 'load_skill', 'use_skill',
              'background_status', 'background_list', 'memory_read', 'memory_list']);
            if (calls.length > 1) {
              const pre = [];
              let allSafe = true;
              for (const call of calls) {
                const nm = call.name || '';
                let ar = null;
                try { ar = JSON.parse(call.rawArgs || '{}'); } catch (e) { allSafe = false; break; }
                if (!CONCURRENT_SAFE.has(nm) || !ar || typeof ar !== 'object' || Array.isArray(ar) || validateToolArgs(nm, ar)) { allSafe = false; break; }
                pre.push({ call, nm, ar });
              }
              if (allSafe) {
                invalidStreak = 0;
                for (const p of pre) { send({ t: 'tool', name: p.nm, args: p.ar }); step({ type: 'tool', name: p.nm, args: p.ar }); }
                send({ t: 'note', message: `${pre.length} 个只读调用并发执行中…` });
                const results = await Promise.all(pre.map(p => execTool(p.nm, p.ar, cwd, toolHolder,
                  project ? project.root_path : null, readonlyMode, effectiveApprovalMode(chatId), chatId, askCtx)));
                for (let i = 0; i < pre.length; i++) {
                  const result = results[i] && typeof results[i] === 'object' ? results[i] : { error: '并发执行未返回结果' };
                  if (result.output) result.output = redactSecrets(result.output);
                  if (result.error) result.error = redactSecrets(result.error);
                  send({ t: 'tool_result', name: pre[i].nm, output: result.output || null, error: result.error || null, open: false, diff: null, path: result.path || null, new_file: false, undo_id: null });
                  step({ type: 'result', name: pre[i].nm, output: result.output || null, error: result.error || null, open: false });
                  feedResult(pre[i].call, ((result.output || '') + (result.error ? '\n[错误] ' + result.error : '')) || '(无输出)');
                }
                feedResultsDone();
                await sleep(250);
                continue;
              }
            }
            for (const call of calls) {
              const name = call.name || '';
              // 1) 非法 JSON：先自动修复，仍失败则把错误作为 tool_result 交给 AI 反思重试
              let args = null;
              let parseErr = null;
              try { args = JSON.parse(call.rawArgs || '{}'); } catch (e) {
                try { args = JSON.parse(repairJson(call.rawArgs || '{}')); }
                catch (e2) { parseErr = `工具调用参数不是合法 JSON（${String(e2.message).substring(0, 80)}）。请重新发起调用，确保 arguments 是标准 JSON 对象。`; }
              }
              if (args === null || typeof args !== 'object' || Array.isArray(args)) {
                parseErr = parseErr || '工具调用参数必须是一个 JSON 对象。请重新发起调用。';
              }
              // 2) 严格参数校验（捏造参数名/缺参/类型错误 → 明确提示正确 schema）
              const invalid = parseErr || validateToolArgs(name, args || {});
              if (invalid) {
                invalidStreak++;
                const stopNote = invalidStreak >= INVALID_STREAK_MAX ? `（已连续 ${invalidStreak} 次校验失败，不要再重试此调用，请改用其他方案或向用户说明）` : '';
                const msgText = invalid + stopNote;
                send({ t: 'tool', name, args: { _raw: String(call.rawArgs || '').substring(0, 200) } });
                step({ type: 'tool', name, args: { _raw: String(call.rawArgs || '').substring(0, 200) } });
                send({ t: 'tool_result', name, output: null, error: msgText, open: true });
                step({ type: 'result', name, output: null, error: msgText, open: true });
                feedResult(call, msgText);
                continue;
              }
              invalidStreak = 0;
              // 无进展保护：同一调用连续重复 3 次直接打断（模型陷入自循环）
              const callKey = name + '|' + JSON.stringify(args);
              repeatStreak = callKey === lastCallKey ? repeatStreak + 1 : 1;
              lastCallKey = callKey;
              if (repeatStreak >= 3) {
                const msgText = `检测到重复调用同一操作（${name}）已连续 ${repeatStreak} 次，系统已打断本次任务以避免无意义循环。`;
                send({ t: 'tool', name, args });
                send({ t: 'tool_result', name, output: null, error: msgText, open: true });
                step({ type: 'tool', name, args });
                step({ type: 'result', name, output: null, error: msgText, open: true });
                allText += (allText ? '\n' : '') + `\n[已打断：${name} 重复调用 ${repeatStreak} 次]`;
                return { reply: allText, steps, used: row, usage: usageAcc.rounds ? usageAcc : null, genMs: genMsSum };
              }
              send({ t: 'tool', name, args });
              step({ type: 'tool', name, args });

              // 审批门:越界/敏感/危险操作需要用户裁决(bypass 自动放行；「始终允许」过的目标直接放行)
              const approvalTarget = (() => {
                if (name === 'run_command') return { kind: 'cmd', value: String(args.command || '') };
                if (args && typeof args.path === 'string') return { kind: 'path', value: path.resolve(cwd, args.path) };
                return null;
              })();
              const alwaysOk = approvalTarget && isAlwaysAllowed(chatId, approvalTarget.kind === 'path' ? 'path' : 'cmd', approvalTarget.value);
              // 权限规则与审批模式判定：黑名单永远优先于「始终允许」（否则被禁的命令一旦点过始终允许就永久放行）
              const dec = decideApproval2(chatId, name, args, cwd, project ? project.root_path : null, bypass || alwaysOk);
              // 黑名单命中：不执行、不审批，直接把拒绝原因回给 AI 换方案
              if (dec.denied) {
                send({ t: 'tool_result', name, output: null, error: dec.denied, open: true, path: null, new_file: false });
                step({ type: 'result', name, output: null, error: dec.denied, open: true });
                feedResult(call, dec.denied);
                continue;
              }
              let result;
              if (dec.need) {
                const approvalId = crypto.randomBytes(8).toString('hex');
                send({ t: 'approval', id: approvalId, level: dec.level, tool: name, args, reason: dec.reason, target: approvalTarget, chat_id: chatId, is_high: dec.isHigh, mode: effectiveApprovalMode(chatId) });
                const decision = await waitApproval(approvalId, onAbort.deniedList);
                if (!decision.allow) {
                  const msgText = decision.timeout ? '审批超时,用户未响应,操作被拒绝' : '用户拒绝执行该操作。请尊重用户决定,不要重复尝试。';
                  const deniedPath = (name === 'write_file' || name === 'edit_file') ? path.resolve(cwd, String(args.path || '')) : null;
                  send({ t: 'tool_result', name, output: null, error: msgText, open: true, diff: null, path: deniedPath, new_file: false });
                  step({ type: 'result', name, output: null, error: msgText, open: true, diff: null, path: deniedPath, new_file: false });
                  feedResult(call, msgText);
                  continue;
                }
                // 审批恢复后不在这里插提示词：这批 tool_call 还没全部回喂完，插进去就是「两条 tool 消息之间
                // 夹一条 user」，原生协议会直接 400 拒包。统一交给本批结束时的 feedResultsDone()。
              }
              // 前台命令开始执行：通知前端点亮「判定超时」按钮（结束时置 null）
              if (name === 'run_command') send({ t: 'cmd_running', command: String(args.command || '').substring(0, 200) });
              result = await execTool(name, args, cwd, toolHolder, project ? project.root_path : null, readonlyMode, effectiveApprovalMode(chatId), chatId, askCtx);
              if (name === 'run_command') send({ t: 'cmd_running', command: null });
              // 敏感数据脱敏：工具输出进入 AI 上下文（前端展示/入库/上游）前统一处理（AI 生成的代码不脱敏）
              if (result.output) result.output = redactSecrets(result.output);
              if (result.error) result.error = redactSecrets(result.error);
              // 言论审查：工具输出命中则终止
              const hitTool = hitCensored((result.output || '') + ' ' + (result.error || ''));
              if (hitTool) {
                send({ t: 'error', message: `本轮对话因工具输出包含审查词汇“${hitTool}”已自动终止` });
                try { controller.abort(); } catch(e) {}
                throw new Error(`审查终止：${hitTool}`);
              }
              // ReAct 反思提示：失败时引导 AI 自查；无能为力的错误（权限/不存在）禁止反复重试
              if (result.error) {
                result.error += isFatalToolError(name, args, result.error)
                  ? '\n[系统提示] 该错误为环境/资源问题，重试无法解决。请调整方案（换路径/换方法），或如实向用户说明并继续其余任务。'
                  : '\n[系统提示] 请先反思失败原因（参数是否正确、路径是否存在），修正后重试；若连续失败请更换方案。';
                // 任务联动兜底：工具失败 → 当前 doing 的任务自动标 failed + 错误摘要（用户不看日志也知道卡在哪）
                markDoingTaskFailed(chatId, `${name}: ${String(result.error).substring(0, 120)}`);
              }
              send({
                t: 'tool_result',
                name,
                output: result.output || null,
                error: result.error || null,
                open: false,
                diff: (result.diff && result.diff.length) ? result.diff : null,
                path: result.path || null,
                new_file: result.new_file || false,
                undo_id: result.undo_id || null
              });
              step({
                type: 'result',
                name,
                output: result.output || null,
                error: result.error || null,
                open: false,
                diff: (result.diff && result.diff.length) ? result.diff : null,
                path: result.path || null,
                new_file: result.new_file || false,
                undo_id: result.undo_id || null
              });
              // 回传给 AI 的工具结果不截断：完整上下文（自动压缩兜底）
              const echoText = ((result.output || '') + (result.error ? '\n[错误] ' + result.error : '')) || '(无输出)';
              feedResult(call, echoText);
            }
            feedResultsDone();
            await sleep(250);
          }
          if (failed) continue;
          return { reply: allText, steps, used: row };
        }
        // 全部模型失败
        send({ t: 'error', message: `模型池中所有模型均请求失败${poolFail ? '（最后一个：' + poolFail + '）' : ''}`.substring(0, ERROR_MAX_LEN + 100) });
        errSent = true;
        return { reply: allText, steps, used: null, usage: usageAcc.rounds ? usageAcc : null, genMs: genMsSum, errorSent: true };
        } catch (e) {
          if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) {
            return { reply: allText, steps, used: usedModel, usage: usageAcc.rounds ? usageAcc : null, genMs: genMsSum, aborted: true };
          }
          // 意外中断（单次输出长度上限“terminated”/网络断开/审查终止等）：
          // 已生成的全部文本与步骤照常入库保留上下文，同时向用户报错
          errSent = true;
          const why = errDetail(e);
          console.error(`[stream] Agent 流中断 · ${usedModel ? usedModel.display_name : '未知模型'} · ${why}`);
          send({ t: 'error', message: `流式输出中断 · ${usedModel ? usedModel.display_name + ' · ' : ''}${why}`.substring(0, ERROR_MAX_LEN + 120) });
          // 中断瞬间的部分正文并入；正文为空时把已思考内容并入正文入库（思考因此保留进上下文）
          if (e && e.partial && e.partial.content) allText += (allText ? '\n' : '') + e.partial.content;
          if (!allText.trim() && e && e.partial && e.partial.reasoning) {
            allText = `[思考过程（回复因单次输出长度上限中断，以下为本轮已完成的思考）]\n${e.partial.reasoning}`;
          }
          return { reply: allText, steps, used: usedModel, usage: usageAcc.rounds ? usageAcc : null, genMs: genMsSum, interrupted: true };
        }
      };

      let agentSteps = [];
      let usedModelRow = poolRows[0].id;
      let turnUsage = null;
      let turnGenMs = 0;
      let turnUnfinished = false; // 中断/停止的本轮 → 入库标记未完成（前端显示「继续生成」按钮）
      if (agent) {
        const r = await runAgent(baseMsgs, poolRows);
        agentSteps = r.steps || [];
        if (r.used) usedModelRow = r.used.id;
        turnUsage = r.usage || null;
        turnGenMs = r.genMs || 0;
        if (r.aborted || r.interrupted) turnUnfinished = true;
        if (r.fallback) {
          const pr = await streamPlain(baseMsgs, poolRows);
          fullReply = pr.text;
          fullReasoning = pr.reasoning || fullReasoning;
          if (pr.used) usedModelRow = pr.used.id;
          if (pr.failed) errSent = true;
          if (pr.usage) turnUsage = pr.usage;
          turnGenMs += pr.genMs || 0;
          if (pr.aborted || pr.interrupted) turnUnfinished = true;
        } else if (r.errorSent) {
          errSent = true;
          fullReply = r.reply || '';
        } else {
          fullReply = r.reply || '';
        }
      } else {
        const pr = await streamPlain(baseMsgs, poolRows);
        fullReply = pr.text;
        fullReasoning = pr.reasoning || fullReasoning;
        if (pr.used) usedModelRow = pr.used.id;
        if (pr.failed) errSent = true;
        if (pr.usage) turnUsage = pr.usage;
        turnGenMs = pr.genMs || 0;
        if (pr.aborted || pr.interrupted) turnUnfinished = true;
      }

      // 本轮用户消息仍存在才入库：撤回会删除本轮用户消息（含其后的停止消息），避免孤儿回复残留进上下文
      const userMsgExists = !!(userMsgId && db.prepare('SELECT 1 FROM ai_chat_messages WHERE id = ? AND chat_id = ?').get(userMsgId, chatId));
      if (fullReply.trim() && userMsgExists) {
        // 入库前统一解析任务标签（幂等；runAgent 流中已实时处理过，普通模式在此处理）
        const fin = parseTaskTags(stripLegacyToolLog(fullReply), chatId);
        if (fin.changed) send({ t: 'tasks', tasks: getTasks(chatId) });
        const allSteps = [...turnCompressSteps, ...agentSteps];
        insertAssistantMsg.run(chatId, 'assistant', fin.text.substring(0, 50000), usedModelRow, (fullReasoning || '').substring(0, 20000) || null, allSteps.length ? JSON.stringify(allSteps) : null, turnUnfinished ? 1 : 0);
        touchChatStmt.run(chatId);
      }
      // 校准上下文锚点：本轮上游实测的 prompt+completion 就是「下一轮整包」的底数，
      // 之后新增的正文才按估算补 —— 没有这一步，用量与压缩判定永远停在正文口径（低估一个数量级）。
      recordContextAnchor(chatId, turnUsage);
      // 对话响应正常 → 该模型自动标为「可用」并更新首字延迟（异常模型回复成功后自动转正常）
      if (!errSent && !turnUnfinished && fullReply.trim() && usedModelRow) {
        // 首字延迟：以本轮纯生成时长作为参考延迟（turnGenMs 为首末 SSE 数据间隔之和，
        // 不含工具执行/429 重试时间），更接近实际首字响应速度
        const genLatency = turnGenMs || (Date.now() - started);
        db.prepare(`
          INSERT INTO ai_model_results (model_row_id, status, reply, error, latency_ms, tested_at)
          VALUES (?, ?, NULL, NULL, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(model_row_id) DO UPDATE SET
            status = excluded.status, reply = excluded.reply, error = excluded.error,
            latency_ms = excluded.latency_ms, tested_at = CURRENT_TIMESTAMP
        `).run(usedModelRow, 'ok', genLatency);
      }
      if (!errSent) {
        const usage = chatContextUsage(chatId);
        // usage 为上游返回的真实 token 数（agent 多轮已汇总：completion 累加、prompt/cached 取最大轮）
        // gen_ms 为纯生成时长（首末 SSE 数据间隔之和，不含工具执行时间），前端据此算精确 tok/s
        send({ t: 'done', latency_ms: Date.now() - started, context_used: usage.used, context_limit: usage.limit, tasks: getTasks(chatId), usage: turnUsage, gen_ms: turnGenMs });
      }
    } catch (e) {
      const userMsgExists2 = !!(userMsgId && db.prepare('SELECT 1 FROM ai_chat_messages WHERE id = ? AND chat_id = ?').get(userMsgId, chatId));
      if (fullReply.trim() && userMsgExists2) {
        try {
          insertAssistantMsg.run(chatId, 'assistant', stripLegacyToolLog(fullReply).substring(0, 50000), poolRows[0].id, (fullReasoning || '').substring(0, 20000) || null, null);
          touchChatStmt.run(chatId);
        } catch (e2) { /* 忽略 */ }
      }
      let msg = errDetail(e);
      if (e.name === 'AbortError' || e.code === 'ABORT_ERR') {
        msg = req.destroyed ? '已取消' : '请求超时';
      } else if (/timeout|timed out|ETIMEDOUT/i.test(msg)) {
        // 超时也把底层原因留着（UND_ERR_BODY_TIMEOUT 之类），只加个能一眼看懂的头
        msg = `请求超时：${msg}`;
      }
      send({ t: 'error', message: String(msg).substring(0, ERROR_MAX_LEN) });
    } finally {
      clearInterval(heartbeatTimer);
      if (chatId && activeHolders.get(chatId) === toolHolder) activeHolders.delete(chatId);
      if (chatId && subagentSenders.get(chatId) === send) subagentSenders.delete(chatId);
      // 本轮结束：本会话仍挂着的提问一律按「未回答」放行，不留孤儿 Promise
      for (const [, q] of [...pendingQuestions.entries()]) {
        if (q.chatId === chatId) q.resolve({ answered: false, cancelled: true });
      }
      res.end();
    }
  })();
});

// ---------- 管理端：对话管理（仅本人） ----------

// 当前用户的全部对话（模型已解耦：一个对话可跨多个模型；可选按模型过滤）
// 返回含 project_id（NULL = 顶层自由会话），前端按项目分组展示
router.get('/chats', wrap((req, res) => {
  const modelRowId = parseInt(req.query.model_row_id);
  const hasFilter = Number.isInteger(modelRowId) && modelRowId > 0;
  const chats = db.prepare(`
    SELECT c.id, c.title, c.created_at, c.updated_at, c.context_limit, c.project_id, c.cwd, c.plan_mode, c.approval_mode, c.sort_order, c.remote_id,
           LENGTH(c.summary) AS summary_length,
           (SELECT COUNT(*) FROM ai_chat_messages msg WHERE msg.chat_id = c.id) AS message_count,
           (SELECT GROUP_CONCAT(DISTINCT am.display_name) FROM ai_chat_messages msg
              LEFT JOIN ai_models am ON msg.model_row_id = am.id
              WHERE msg.chat_id = c.id AND msg.model_row_id IS NOT NULL) AS models_used
    FROM ai_chats c
    WHERE c.user_id = ? ${hasFilter ? 'AND c.model_row_id = ?' : ''}
    ORDER BY c.sort_order ASC, c.updated_at DESC, c.id DESC
    LIMIT 500
  `).all(...(hasFilter ? [1, modelRowId] : [1]));
  ok(res, chats);
}));

// 会话/项目拖动排序：{ ids: [按新顺序的 id 列表] }
router.post('/chats/reorder', wrap((req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(x => parseInt(x)).filter(Number.isInteger) : [];
  if (!ids.length) return fail(res, 400, '无效的排序列表');
  const upd = db.prepare('UPDATE ai_chats SET sort_order = ? WHERE id = ?');
  const tx = db.transaction(() => { for (let i = 0; i < ids.length; i++) upd.run(i, ids[i]); });
  tx();
  ok(res, null, '会话顺序已保存');
}));

router.post('/projects/reorder', wrap((req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(x => parseInt(x)).filter(Number.isInteger) : [];
  if (!ids.length) return fail(res, 400, '无效的排序列表');
  const upd = db.prepare('UPDATE projects SET sort_order = ? WHERE id = ?');
  const tx = db.transaction(() => { for (let i = 0; i < ids.length; i++) upd.run(i, ids[i]); });
  tx();
  ok(res, null, '项目顺序已保存');
}));

// 更新会话配置（会话级模型 / 上下文窗口）body: { model_row_id?, context_limit?, temperature?, frequency_penalty?, presence_penalty?, thinking_level?, censored_words? }
router.patch('/chats/:id/settings', wrap((req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id < 1) return fail(res, 400, '无效的对话ID');
  const chat = db.prepare('SELECT id FROM ai_chats WHERE id = ?').get(id);
  if (!chat) return fail(res, 404, '对话不存在');
  const updates = [];
  const params = [];
  if (req.body?.model_row_id !== undefined) {
    const mid = parseInt(req.body.model_row_id);
    if (Number.isInteger(mid) && mid > 0) {
      if (!db.prepare('SELECT id FROM ai_models WHERE id = ?').get(mid)) return fail(res, 404, '模型不存在');
      updates.push('model_row_id = ?');
      params.push(mid);
    }
  }
  if (req.body?.context_limit !== undefined) {
    const lim = parseInt(req.body.context_limit);
    if (Number.isInteger(lim) && lim >= 0 && lim <= 1000000) {
      updates.push('context_limit = ?');
      params.push(lim);
    }
  }
  if (req.body?.temperature !== undefined) {
    const t = Number(req.body.temperature);
    if (Number.isFinite(t) && t >= 0 && t <= 2) {
      updates.push('temperature = ?');
      params.push(t);
    }
  }
  if (req.body?.frequency_penalty !== undefined) {
    const v = Number(req.body.frequency_penalty);
    if (Number.isFinite(v) && v >= -2 && v <= 2) {
      updates.push('frequency_penalty = ?');
      params.push(v);
    }
  }
  if (req.body?.presence_penalty !== undefined) {
    const v = Number(req.body.presence_penalty);
    if (Number.isFinite(v) && v >= -2 && v <= 2) {
      updates.push('presence_penalty = ?');
      params.push(v);
    }
  }
  if (req.body?.thinking_level !== undefined) {
    const lv = sanitizeText(req.body.thinking_level, 20);
    updates.push('thinking_level = ?');
    params.push(lv);
  }
  if (req.body?.censored_words !== undefined) {
    const cw = typeof req.body.censored_words === 'string' ? req.body.censored_words.substring(0, 2000) : '';
    updates.push('censored_words = ?');
    params.push(cw);
  }
  if (req.body?.plan_mode !== undefined) {
    updates.push('plan_mode = ?');
    params.push(req.body?.plan_mode ? 1 : 0);
  }
  if (req.body?.title !== undefined) {
    const t = String(req.body.title || '').replace(/[\u0000-\u001f<>]/g, '').trim().substring(0, 60);
    if (!t) return fail(res, 400, '会话名称不能为空');
    updates.push('title = ?');
    params.push(t);
  }
  if (!updates.length) return ok(res, null);
  params.push(id);
  db.prepare(`UPDATE ai_chats SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...params);
  ok(res, null, '会话配置已保存');
}));

// 自动获取当前模型最大上下文并填入
router.post('/chats/:id/fetch-max-context', wrap(async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id < 1) return fail(res, 400, '无效的对话ID');
  const row = db.prepare(`
    SELECT c.id, c.model_row_id, m.model_id, m.max_context, p.base_url, p.api_key, p.proxy_enabled, p.proxy_host, p.proxy_port,
           p.api_style, p.max_tokens, p.custom
    FROM ai_chats c JOIN ai_models m ON m.id = c.model_row_id JOIN ai_providers p ON p.id = m.provider_id
    WHERE c.id = ?
  `).get(id);
  if (!row) return fail(res, 404, '对话或模型不存在');
  // 若库中已有 max_context，直接使用
  if (row.max_context && row.max_context > 0) {
    db.prepare('UPDATE ai_chats SET context_limit = ? WHERE id = ?').run(row.max_context, id);
    return ok(res, { max_context: row.max_context }, `已填入最大上下文 ${row.max_context}`);
  }
  // 尝试从上游模型列表拉（openai/anthropic/custom 各自的端点与鉴权由 protocols 决定）
  const listReq = protocols.listRequest(row);
  if (!listReq) return fail(res, 400, '该提供商为自定义协议且未配置 list_url，请手动填入最大上下文');
  const dispatcher = row.proxy_enabled && row.proxy_host ? new ProxyAgent(`http://${row.proxy_host}:${row.proxy_port}`) : undefined;
  try {
    const resp = await fetch(listReq.url, {
      method: 'GET',
      headers: listReq.headers,
      dispatcher,
      signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '').then(s => s.substring(0, 300));
      return fail(res, 502, `上游返回 HTTP ${resp.status}: ${t}`);
    }
    const data = await resp.json().catch(() => null);
    if (!data) return fail(res, 502, '上游返回非 JSON');
    let list = [];
    if (Array.isArray(data.data)) list = data.data;
    else if (Array.isArray(data)) list = data;
    else if (Array.isArray(data.models)) list = data.models;
    const found = list.find(x => (x.id || x.name) === row.model_id);
    const mc = found ? (found.context_length || found.max_context || found.context_window || found.max_input_tokens || found.max_tokens || found.contextLength) : null;
    const maxCtx = parseInt(mc);
    if (Number.isInteger(maxCtx) && maxCtx > 0) {
      db.prepare('UPDATE ai_models SET max_context = ? WHERE id = ?').run(maxCtx, row.model_row_id);
      db.prepare('UPDATE ai_chats SET context_limit = ? WHERE id = ?').run(maxCtx, id);
      return ok(res, { max_context: maxCtx }, `已获取并填入最大上下文 ${maxCtx}`);
    }
    return fail(res, 404, '上游未返回该模型的最大上下文，请手动填入');
  } catch (e) {
    let msg = errDetail(e);
    if (e.name === 'AbortError' || /timeout|abort/i.test(msg)) msg = '请求超时';
    return fail(res, 502, `获取失败: ${msg.substring(0, 200)}`);
  }
}));

// 任务列表（Plan 模式面板；手动改状态用 PATCH）
router.get('/tasks', wrap((req, res) => {
  const chatId = parseInt(req.query.chat_id);
  if (!Number.isInteger(chatId) || chatId < 1) return fail(res, 400, '无效的对话ID');
  ok(res, getTasks(chatId));
}));

router.patch('/tasks/:id', wrap((req, res) => {
  const id = parseInt(req.params.id);
  const status = String(req.body?.status || '');
  if (!Number.isInteger(id) || id < 1) return fail(res, 400, '无效的任务ID');
  if (!['pending', 'doing', 'done', 'failed'].includes(status)) return fail(res, 400, '无效的状态');
  const r = db.prepare('UPDATE tasks SET status = ?, error_summary = ? WHERE id = ?').run(status, status === 'failed' ? String(req.body?.error_summary || '（手动标记）').substring(0, 300) : '', id);
  if (r.changes === 0) return fail(res, 404, '任务不存在');
  const t = db.prepare('SELECT chat_id FROM tasks WHERE id = ?').get(id);
  ok(res, t ? getTasks(t.chat_id) : []);
}));

// 显式创建空会话（前端可命名；创建后即出现在左栏，首条消息发送时复用该会话）
router.post('/chats', wrap(async (req, res) => {
  const title = String(req.body?.title || '').trim().substring(0, 60) || '新会话';
  let projectId = null;
  let remoteId = null;
  let cwd = AGENT_DEFAULT_CWD;
  const pid = parseInt(req.body?.project_id);
  if (Number.isInteger(pid) && pid > 0) {
    const project = db.prepare('SELECT id, root_path, remote_id FROM projects WHERE id = ?').get(pid);
    if (!project) return fail(res, 404, '项目不存在');
    projectId = project.id;
    if (project.remote_id) {
      // 远程项目：会话直接继承主机归属，cwd 就是远端路径（不能过 path.resolve）
      remoteId = project.remote_id;
      cwd = project.root_path;
    } else {
      cwd = path.resolve(project.root_path); // 项目会话初始 cwd = 项目根
    }
  }
  const modelRowId = parseInt(req.body?.model_row_id);
  if (!(Number.isInteger(modelRowId) && modelRowId > 0)) return fail(res, 400, '未指定模型');
  if (!db.prepare('SELECT id FROM ai_models WHERE id = ?').get(modelRowId)) return fail(res, 404, '模型不存在');
  // 不挂项目的「远端自由会话」：直接指定 remote_id，cwd 用那台机器的起始目录（没填就用家目录）
  if (!remoteId && Number.isInteger(parseInt(req.body?.remote_id)) && parseInt(req.body.remote_id) > 0) {
    const host = db.prepare('SELECT * FROM ai_remote_hosts WHERE id = ?').get(parseInt(req.body.remote_id));
    if (!host) return fail(res, 404, '远程连接不存在');
    remoteId = host.id;
    cwd = remoteUtil.posixPath(host.default_cwd || host.home || '/');
  }
  // 新会话默认上下文窗口（设置页 default_context_limit，0=不限）
  const defCtx = (() => { const n = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'default_context_limit'").get()?.value); return Number.isInteger(n) && n > 0 ? n : 0; })();
  const r = db.prepare('INSERT INTO ai_chats (user_id, model_row_id, title, project_id, cwd, plan_mode, context_limit, remote_id) VALUES (?, ?, ?, ?, ?, 0, ?, ?)')
    .run(1, modelRowId, title, projectId, cwd, defCtx, remoteId);
  const chat = db.prepare('SELECT id, title, project_id, model_row_id, remote_id FROM ai_chats WHERE id = ?').get(Number(r.lastInsertRowid));
  ok(res, chat);
}));

// 载入对话（含全部消息；用户消息中的图片标记由前端渲染）
router.get('/chats/:id', wrap((req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id < 1) return fail(res, 400, '无效的对话ID');
  const chat = db.prepare(`
    SELECT c.id, c.title, c.model_row_id, c.created_at, c.updated_at, c.context_limit,
           c.project_id, c.cwd, c.plan_mode, c.remote_id,
           c.temperature, c.frequency_penalty, c.presence_penalty, c.search_enabled, c.search_strategy, c.thinking_level, c.censored_words,
           LENGTH(c.summary) AS summary_length, m.display_name AS model_name
    FROM ai_chats c JOIN ai_models m ON c.model_row_id = m.id
    WHERE c.id = ? AND c.user_id = ?
  `).get(id, 1);
  if (!chat) return fail(res, 404, '对话不存在');
  const messages = db.prepare(`
    SELECT msg.id, msg.role, msg.content, msg.reasoning, msg.steps_json, msg.unfinished, msg.created_at, msg.speaker, am.display_name AS model_name
    FROM ai_chat_messages msg LEFT JOIN ai_models am ON msg.model_row_id = am.id
    WHERE msg.chat_id = ? ORDER BY msg.id ASC
  `).all(id);
  // 旧版消息 content 尾巴烧着 "[工具调用记录]\n▶ ...",剥离后仅保留 AI 正文,
  // 工具调用均以 steps 呈现(新版)或不再展示(旧版)
  for (const m of messages) {
    if (m.role === 'assistant') m.content = stripLegacyToolLog(m.content);
    if (typeof m.steps_json === 'string' && m.steps_json) {
      try { m.steps = JSON.parse(m.steps_json); } catch (e) { m.steps = null; }
    }
    delete m.steps_json;
  }
  ok(res, { chat, messages, usage: chatContextUsage(id), tasks: getTasks(id) });
}));

// 删除对话（连同消息与任务先快照进回收站，再真删 —— 这样「恢复」才有东西可恢复）
router.delete('/chats/:id', wrap((req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id < 1) return fail(res, 400, '无效的对话ID');
  const trashId = db.transaction(() => trashStore.trashChat(id))();
  if (!trashId) return fail(res, 404, '对话不存在');
  ok(res, { trash_id: trashId }, '删除成功，可在回收站恢复');
}));

/* ---------- 回收站（会话 / 项目） ---------- */
router.get('/trash', wrap((req, res) => ok(res, { items: trashStore.list(), stats: trashStore.stats() })));

router.post('/trash/:id/restore', wrap((req, res) => {
  try {
    const r = trashStore.restore(req.params.id);
    if (r.already) return ok(res, r, '这一条之前已经恢复过了');
    const bits = [];
    if (r.kind === 'project') bits.push(`项目「${r.title}」及其 ${r.chats.length} 个会话`);
    else bits.push(`会话「${r.title}」`);
    if (r.messages) bits.push(`${r.messages} 条消息`);
    const tail = [
      r.modelChanged ? '原模型已被删除，已改用现存的模型' : '',
      r.remoteDropped ? '原远程连接已删除，已改为普通会话' : '',
    ].filter(Boolean);
    ok(res, r, `已恢复 ${bits.join('、')}${tail.length ? `（${tail.join('；')}）` : ''}`);
  } catch (e) {
    failErr(res, 500, '恢复失败', e);
  }
}));

router.delete('/trash/:id', wrap((req, res) => {
  try {
    trashStore.remove(req.params.id);
    ok(res, null, '已永久删除');
  } catch (e) {
    failErr(res, 404, '永久删除失败', e);
  }
}));

router.delete('/trash', wrap((req, res) => ok(res, { removed: trashStore.clear() }, '回收站已清空')));

// ---------- 敏感数据表管理 ----------
router.get('/secrets', wrap((req, res) => {
  ok(res, db.prepare('SELECT id, pattern, label, created_at FROM secrets ORDER BY id ASC').all());
}));

router.post('/secrets', wrap((req, res) => {
  const pattern = String(req.body?.pattern || '').trim();
  if (!pattern || pattern.length > 500) return fail(res, 400, '匹配规则不能为空且不超过 500 字符');
  try { new RegExp(pattern); } catch (e) { return fail(res, 400, `无效的正则表达式：${e.message}`); }
  const r = db.prepare('INSERT INTO secrets (pattern, label) VALUES (?, ?)').run(pattern, sanitizeText(req.body?.label, 100));
  secretsCache.at = 0;
  ok(res, { id: Number(r.lastInsertRowid) }, '脱敏规则已添加（对工具输出即时生效）');
}));

router.delete('/secrets/:id', wrap((req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id < 1) return fail(res, 400, '无效的ID');
  const r = db.prepare('DELETE FROM secrets WHERE id = ?').run(id);
  if (r.changes === 0) return fail(res, 404, '规则不存在');
  secretsCache.at = 0;
  ok(res, null, '已删除');
}));

// ---------- AGENTS.md 预检（新建会话/切换项目时前端调用） ----------
router.get('/agents-md', wrap((req, res) => {
  const pid = parseInt(req.query.project_id);
  let projectRoot = null;
  if (Number.isInteger(pid) && pid > 0) {
    projectRoot = db.prepare('SELECT root_path FROM projects WHERE id = ?').get(pid)?.root_path || null;
  }
  const files = collectAgentsMd(projectRoot, typeof req.query.cwd === 'string' ? req.query.cwd : '');
  ok(res, {
    files: files.map(f => ({ scope: f.scope, path: f.path, tokens: f.tokens, chars: (f.content || '').length, skipped: f.skipped || null })),
    total_tokens: files.reduce((s, f) => s + (f.tokens || 0), 0)
  });
}));

// ---------- 编辑 AGENTS.md（设置页的「全局提示词」+ 项目右键的「编辑系统提示词」） ----------
// 只认两种目标：scope=global（固定 ~/.kharness）或 project_id（库里的 root_path）。
// **绝不接受前端传目录** —— 这台服务没有鉴权，能指目录就等于能往任意路径写文件。
// 远程项目走 SFTP 读写那台机器上的那一份（与注入时读的是同一个文件）。
function agentsTargetOf(req) {
  const pid = parseInt(req.query?.project_id ?? req.body?.project_id);
  const scope = String(req.query?.scope ?? req.body?.scope ?? '').trim();
  if (Number.isInteger(pid) && pid > 0) {
    const p = db.prepare('SELECT id, name, root_path, remote_id FROM projects WHERE id = ?').get(pid);
    if (!p) return { error: '项目不存在' };
    if (!p.root_path) return { error: '这个项目还没设工作目录，没有可编辑的提示词文件' };
    const hostRow = p.remote_id ? db.prepare('SELECT * FROM ai_remote_hosts WHERE id = ?').get(p.remote_id) : null;
    if (p.remote_id && !hostRow) return { error: '这个项目挂那台连接已经不在了，先重新绑定目录' };
    return { project: p, host: hostRow || null, dir: p.root_path };
  }
  if (scope === 'global') return { global: true, dir: agentsMd.globalDir() };
  return { error: '要说清楚改哪一份：scope=global 或 project_id' };
}

function agentsShape(file, content, host) {
  return {
    path: file,
    name: path.basename(file),
    host: host ? `${host.username}@${host.host}:${host.port}` : '',
    exists: content !== null,
    content: content || '',
    bytes: Buffer.byteLength(content || '', 'utf8'),
    tokens: agentsMd.estimateTokens(content || ''),
  };
}

router.get('/agents-file', wrap(async (req, res) => {
  const t = agentsTargetOf(req);
  if (t.error) return fail(res, 400, t.error);
  if (!t.dir) return fail(res, 400, '目标目录是空的');
  if (t.host) {
    // 远程：两种名字都探一遍，取先存在的那个；都没有就按 AGENTS.md 新建
    for (const name of agentsMd.NAMES) {
      const p = remoteUtil.posixPath(`${String(t.dir).replace(/\/+$/, '')}/${name}`);
      try {
        const buf = await remoteUtil.sftp.readFile(t.host, p);
        return ok(res, agentsShape(p, buf.toString('utf8').substring(0, agentsMd.AGENTS_MD_MAX_BYTES), t.host));
      } catch (e) { /* 这份没有，试下一个名字 */ }
    }
    return ok(res, agentsShape(remoteUtil.posixPath(`${String(t.dir).replace(/\/+$/, '')}/${agentsMd.NAMES[0]}`), null, t.host));
  }
  const file = agentsMd.resolveAgentsFile(t.dir, { create: !!t.global });
  if (!file) return fail(res, 400, `概括：项目目录不在了；详情：${t.dir}`);
  const r = agentsMd.read(file);
  return ok(res, agentsShape(file, r.exists ? r.content : null, null));
}));

router.put('/agents-file', wrap(async (req, res) => {
  const t = agentsTargetOf(req);
  if (t.error) return fail(res, 400, t.error);
  const content = String(req.body?.content ?? '');
  if (Buffer.byteLength(content, 'utf8') > agentsMd.AGENTS_MD_MAX_BYTES) {
    return fail(res, 400, `概括：内容太大；详情：${Math.round(Buffer.byteLength(content, 'utf8') / 1024)}KB，上限 200KB`);
  }
  if (t.host) {
    let file = '';
    for (const name of agentsMd.NAMES) {
      const p = remoteUtil.posixPath(`${String(t.dir).replace(/\/+$/, '')}/${name}`);
      try { await remoteUtil.sftp.stat(t.host, p); file = p; break; } catch (e) { /* 不存在 */ }
    }
    if (!file) file = remoteUtil.posixPath(`${String(t.dir).replace(/\/+$/, '')}/${agentsMd.NAMES[0]}`);
    try {
      await remoteUtil.sftp.writeFile(t.host, file, content);
    } catch (e) {
      return failErr(res, 500, `远端写入失败：${file}`, e);
    }
    return ok(res, agentsShape(file, content, t.host), '已保存到远端');
  }
  const file = agentsMd.resolveAgentsFile(t.dir, { create: !!t.global });
  if (!file) return fail(res, 400, `概括：项目目录不在了；详情：${t.dir}`);
  try {
    agentsMd.write(file, content);
  } catch (e) {
    return failErr(res, 500, `写入失败：${file}`, e);
  }
  return ok(res, agentsShape(file, content, null), '已保存');
}));

// ---------- 用量统计 ----------
// 汇总：每日 token/费用 + 按模型聚合 + 总计；费用 = (prompt-cached)/1M*price_in + cached/1M*price_cache + completion/1M*price_out
router.get('/usage/summary', wrap((req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
  const prices = db.prepare('SELECT id, display_name, price_in, price_out, price_cache FROM ai_models').all();
  const priceMap = new Map(prices.map(p => [p.id, p]));
  const rows = db.prepare(`
    SELECT DATE(created_at) AS day, model_row_id,
           SUM(prompt_tokens) AS prompt, SUM(completion_tokens) AS completion,
           SUM(cached_tokens) AS cached
    FROM usage_log
    WHERE created_at >= DATETIME('now', 'localtime', ?)
    GROUP BY DATE(created_at), model_row_id
    ORDER BY day ASC
  `).all(`-${days} days`);

  const costOf = (r) => {
    const p = priceMap.get(r.model_row_id);
    if (!p) return 0;
    const cin = Number(p.price_in) || 0, cout = Number(p.price_out) || 0, cch = Number(p.price_cache) || 0;
    const cached = Math.min(r.cached, r.prompt);
    return ((r.prompt - cached) / 1e6) * cin + (cached / 1e6) * cch + (r.completion / 1e6) * cout;
  };

  const daily = new Map();
  const byModel = new Map();
  let total = { prompt: 0, completion: 0, cached: 0, cost: 0 };
  for (const r of rows) {
    const cost = costOf(r);
    const d = daily.get(r.day) || { day: r.day, prompt: 0, completion: 0, cached: 0, cost: 0 };
    d.prompt += r.prompt; d.completion += r.completion; d.cached += r.cached; d.cost += cost;
    daily.set(r.day, d);
    const m = byModel.get(r.model_row_id) || { model_row_id: r.model_row_id, name: priceMap.get(r.model_row_id)?.display_name || '(已删除模型)', prompt: 0, completion: 0, cached: 0, cost: 0, calls: 0 };
    m.prompt += r.prompt; m.completion += r.completion; m.cached += r.cached; m.cost += cost; m.calls++;
    byModel.set(r.model_row_id, m);
    total.prompt += r.prompt; total.completion += r.completion; total.cached += r.cached; total.cost += cost;
  }
  ok(res, {
    days,
    daily: [...daily.values()],
    models: [...byModel.values()].sort((a, b) => b.cost - a.cost),
    total: { ...total, cost: Math.round(total.cost * 10000) / 10000 },
    has_prices: prices.some(p => (Number(p.price_in) || 0) + (Number(p.price_out) || 0) > 0)
  });
}));

// ---------- 技能管理（自定义技能导入/删除） ----------
router.get('/skills', wrap((req, res) => {
  ok(res, listSkills().map(s => ({ name: s.name, description: s.description, custom: !!s.custom, body_len: s.body.length, body: s.body })));
}));

router.post('/skills', wrap((req, res) => {
  const raw = String(req.body?.content || '');
  if (!raw.trim()) return fail(res, 400, '技能内容不能为空');
  if (raw.length > 200 * 1024) return fail(res, 400, '技能文件过大（上限 200KB）');
  // 名字由用户在导入弹窗里定（默认给去掉 .md 后缀的文件名），这里只负责把它夹成安全文件名
  const wanted = String(req.body?.name || req.body?.filename || '').trim().replace(/\.md$/i, '');
  const safe = wanted.replace(/[^\w\u4e00-\u9fff.-]/g, '_').replace(/^[._]+/, '').substring(0, 60);
  if (!safe) return fail(res, 400, '技能名要用字母、数字或中文，别以 . _ 开头');
  const file = path.join(SKILLS_CUSTOM_DIR, `${safe}.md`);
  if (!path.resolve(file).startsWith(path.resolve(SKILLS_CUSTOM_DIR))) return fail(res, 400, '非法文件名');
  const exists = fs.existsSync(file);
  if (exists && req.body?.overwrite !== true) {
    return res.status(409).json({ code: 409, message: `已有一个叫「${safe}」的自定义技能，换个名字或确认覆盖`, data: { exists: true } });
  }
  fs.mkdirSync(SKILLS_CUSTOM_DIR, { recursive: true });
  fs.writeFileSync(file, raw, 'utf8');
  const parsed = parseSkillFile(file, raw);
  ok(res, { name: parsed.name, file, overwrote: exists }, exists ? `技能「${parsed.name}」已覆盖导入` : `技能「${parsed.name}」已导入`);
}));

router.delete('/skills/:name', wrap((req, res) => {
  const name = String(req.params.name || '').replace(/[^\w\u4e00-\u9fff.-]/g, '_');
  const file = path.join(SKILLS_CUSTOM_DIR, `${name}.md`);
  if (!file.startsWith(SKILLS_CUSTOM_DIR) || !fs.existsSync(file)) return fail(res, 404, '自定义技能不存在（内置技能不可删除）');
  fs.unlinkSync(file);
  ok(res, null, '已删除');
}));

// ---------- 轨迹检索（Tracing 搜索） ----------
// GET /trace/search?q=&type=all|user|assistant|tool|skill&model=&regex=0|1
// q 可空：只按分类/模型筛选；有关键词时做文本匹配（关键词或正则）
router.get('/trace/search', wrap((req, res) => {
  const q = String(req.query.q || '').trim();
  const type = String(req.query.type || 'all');
  const useRegex = req.query.regex === '1';
  const modelFilter = String(req.query.model || '').trim().toLowerCase();
  let matcher = null;
  if (q) {
    if (useRegex) {
      try { matcher = new RegExp(q, 'i'); } catch (e) { return fail(res, 400, `无效的正则表达式：${e.message}`); }
    } else {
      matcher = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
  }
  if (!q && type === 'all' && !modelFilter) return fail(res, 400, '请输入关键词，或选择分类/模型进行筛选');
  const rows = db.prepare(`
    SELECT msg.id, msg.chat_id, msg.role, msg.content, msg.reasoning, msg.steps_json,
           msg.model_row_id, msg.created_at, c.title, c.project_id,
           am.display_name AS model_name
    FROM ai_chat_messages msg
    JOIN ai_chats c ON c.id = msg.chat_id
    LEFT JOIN ai_models am ON msg.model_row_id = am.id
    ORDER BY msg.id DESC
    LIMIT 2000
  `).all();
  const results = [];
  const snippet = (text, m) => {
    const s = String(text || '').replace(/\s+/g, ' ');
    if (!m) return s.substring(0, 180) + (s.length > 180 ? '…' : '');
    const start = Math.max(0, (m.index || 0) - 40);
    return (start > 0 ? '…' : '') + s.substring(start, start + 180) + (start + 180 < s.length ? '…' : '');
  };
  for (const r of rows) {
    if (modelFilter && !fuzzyMatchServer(String(r.model_name || ''), modelFilter)) continue;
    let hit = null;
    if ((type === 'all' || type === 'user') && r.role === 'user') {
      const plain = r.content.replace(/\[\[img:[a-f0-9]+\]\]/g, '[图片]');
      let m = matcher ? matcher.exec(plain) : true;
      if (!m && matcher && !useRegex) {
        // 模糊回退：原查询作为普通文本做模糊匹配
        const qPlain = String(q).replace(/[.*+?^${}()|[\]\\]/g, '');
        if (qPlain && fuzzyMatchServer(plain, qPlain)) m = { index: plain.toLowerCase().indexOf(qPlain.toLowerCase().slice(0, 3)) >= 0 ? plain.toLowerCase().indexOf(qPlain.toLowerCase().slice(0, 3)) : 0 } ;
      }
      if (m) hit = { field: '用户消息', snippet: snippet(plain, m === true ? null : m) };
    }
    if (!hit && (type === 'all' || type === 'assistant') && r.role === 'assistant') {
      let m = matcher ? matcher.exec(r.content || '') : true;
      if (!m && matcher && !useRegex) {
        const qPlain = String(q).replace(/[.*+?^${}()|[\]\\]/g, '');
        if (qPlain && fuzzyMatchServer(r.content || '', qPlain)) m = { index: 0 };
      }
      if (m) hit = { field: 'AI 回复', snippet: snippet(r.content, m === true ? null : m) };
    }
    if (!hit && r.reasoning && type === 'all') {
      let m = matcher ? matcher.exec(r.reasoning) : true;
      if (!m && matcher && !useRegex) {
        const qPlain = String(q).replace(/[.*+?^${}()|[\]\\]/g, '');
        if (qPlain && fuzzyMatchServer(r.reasoning, qPlain)) m = { index: 0 };
      }
      if (m) hit = { field: '思维链', snippet: snippet(r.reasoning, m === true ? null : m) };
    }
    if (!hit && (type === 'all' || type === 'tool' || type === 'skill') && r.steps_json) {
      let steps = null;
      try { steps = JSON.parse(r.steps_json); } catch (e) { steps = null; }
      if (Array.isArray(steps)) {
        for (const st of steps) {
          if (st.type !== 'tool' && st.type !== 'result') continue;
          if (type === 'skill' && !/skill/i.test(st.name || '')) continue;
          const blob = `${st.name || ''} ${JSON.stringify(st.args || '')} ${st.output || ''} ${st.error || ''} ${st.path || ''} ${st.undone ? '[已撤销] ' + (st.undo_note || '') : ''}`;
          const m = matcher ? matcher.exec(blob) : true;
          if (m) {
            hit = { field: `工具 ${st.name || ''}`.trim(), snippet: snippet(blob, m === true ? null : m) };
            break;
          }
        }
      }
    }
    if (hit) {
      results.push({
        chat_id: r.chat_id, msg_id: r.id, title: r.title || '未命名会话', project_id: r.project_id,
        role: r.role, model_name: r.model_name || '', created_at: r.created_at,
        field: hit.field, snippet: hit.snippet
      });
      if (results.length >= 60) break;
    }
  }
  ok(res, results);
}));

// ---------- 小鲸鱼挂件（自 DSH 插件移植；纯互动挂件：无余额/计费功能，仅保存外观与互动配置） ----------

const WHALE_CONFIG_SETTING = 'whale_widget'; // 挂件配置 JSON（大小/音效/音量/气泡/避让滚动条）

function readWhaleConfig() {
  try {
    const cfg = JSON.parse((db.prepare('SELECT value FROM settings WHERE key = ?').get(WHALE_CONFIG_SETTING)?.value || '').trim() || '{}');
    return (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) ? cfg : {};
  } catch (e) { return {}; }
}

// 挂件配置读取
router.get('/whale/config', wrap(async (req, res) => {
  ok(res, readWhaleConfig());
}));

// 挂件配置写入（白名单字段；大小 0.6–2.5 / 音量 0–1 / enabled 总开关在「设置 → 外观」里）
router.put('/whale/config', wrap(async (req, res) => {
  const b = req.body || {};
  const next = { ...readWhaleConfig() };
  if (typeof b.scale === 'number' && isFinite(b.scale)) next.scale = Math.min(2.5, Math.max(0.6, b.scale));
  if (typeof b.enabled === 'boolean') next.enabled = b.enabled;
  if (typeof b.sound === 'boolean') next.sound = b.sound;
  if (typeof b.vol === 'number' && isFinite(b.vol)) next.vol = Math.min(1, Math.max(0, b.vol));
  if (b.soundSet === 'duck' || b.soundSet === 'fx1') next.soundSet = b.soundSet;
  if (typeof b.bubbleOn === 'boolean') next.bubbleOn = b.bubbleOn;
  if (typeof b.scrollGapOn === 'boolean') next.scrollGapOn = b.scrollGapOn;
  if (typeof b.scrollGapPx === 'number' && isFinite(b.scrollGapPx)) next.scrollGapPx = Math.max(0, Math.round(b.scrollGapPx));
  next.updatedAt = new Date().toISOString();
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP")
    .run(WHALE_CONFIG_SETTING, JSON.stringify(next));
  ok(res, next);
}));

// ---------- 可视化 Git（工作区） ----------
function gitRun(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: cwd || process.cwd(), timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: (stderr || err.message || '').trim() });
      else resolve({ ok: true, stdout: String(stdout || '').trim() });
    });
  });
}

// 远程会话的 Git 必须在那台机器上跑：本机拿 /srv/app 去 execFile('git') 只会误报「不是仓库」，
// 更糟的情况是本机恰好有个同名相对路径，把提交/推送做错了地方。
async function gitRunRemote(host, cwd, args) {
  const cmd = `git ${args.map((a) => remoteUtil.shellQuote(String(a))).join(' ')}`;
  const r = await remoteUtil.runRemoteCommand(host, cwd ? `cd ${remoteUtil.shellQuote(cwd)} && (${cmd})` : cmd, { timeoutMs: 60000 });
  if (r.error) return { ok: false, error: r.error };
  const out = String(r.output || '');
  const m = /\n?\[退出码 -?\d+\]\s*$/.exec(out);
  let body = (m ? out.slice(0, m.index) : out).trim();
  if (body === '(无输出)') body = '';
  return m ? { ok: false, error: body || m[0].trim() } : { ok: true, stdout: body };
}

/** 这一枪打在哪台机器上：请求带 chat_id 且那条会话属于远程连接 → 远端；否则维持本机行为 */
function gitAt(req, args) {
  const body = req.body || {};
  const host = body.chat_id ? remoteUtil.hostForChat(body.chat_id) : null;
  return host ? gitRunRemote(host, body.path, args) : gitRun(body.path, args);
}

router.post('/git/status', wrap(async (req, res) => {
  const st = await gitAt(req, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!st.ok) {
    // 非 git 仓库：静默返回，前端据此隐藏 Git 功能
    return ok(res, { branch: null, branches: [], dirty: [], is_repo: false });
  }
  const br = await gitAt(req, ['branch', '--format=%(refname:short)']);
  const porcelain = await gitAt(req, ['status', '--porcelain']);
  ok(res, {
    is_repo: true,
    branch: st.stdout,
    branches: br.stdout ? br.stdout.split('\n').filter(Boolean) : [],
    dirty: porcelain.stdout ? porcelain.stdout.split('\n').filter(Boolean) : [],
  });
}));

router.post('/git/checkout', wrap(async (req, res) => {
  const branch = String(req.body?.branch || '').trim();
  if (!branch) return fail(res, 400, '缺少分支名');
  const r = await gitAt(req, ['checkout', branch]);
  if (!r.ok) return fail(res, 400, r.error || '切换失败');
  ok(res, { branch });
}));

router.post('/git/commit', wrap(async (req, res) => {
  const message = String(req.body?.message || '').trim() || 'update';
  const add = await gitAt(req, ['add', '-A']);
  if (!add.ok) return fail(res, 400, add.error || 'git add 失败');
  // 一键提交最容易把本地数据带出去：暂存区里出现密钥库 / 日志 / 撤销快照就中止，交回用户决定
  const staged = await gitAt(req, ['diff', '--cached', '--name-only']);
  const risky = String(staged.stdout || '').split('\n').map(s => s.trim()).filter(p =>
    /(^|\/)kh\.db(-wal|-shm)?$/.test(p) || /(^|\/)\.kh-undo\//.test(p) || /\.log$/i.test(p) || /(^|\/)\.env$/.test(p)
  );
  if (risky.length) {
    await gitAt(req, ['reset', '--quiet']);
    return fail(res, 400, `已中止提交：暂存区含本地数据（${risky.slice(0, 5).join('、')}${risky.length > 5 ? ' 等' : ''}）。请先加入 .gitignore 再提交。`);
  }
  const r = await gitAt(req, ['commit', '-m', message]);
  if (!r.ok && !/nothing to commit/i.test(r.error || '')) return fail(res, 400, r.error || '提交失败');
  ok(res, { message }, r.ok ? '已提交' : '无变更可提交');
}));

router.post('/git/push', wrap(async (req, res) => {
  const r = await gitAt(req, ['push']);
  if (!r.ok) return fail(res, 400, r.error || '推送失败');
  ok(res, { output: r.stdout });
}));

// 工作区变更预览（实验室「Git 版本预览」用）：只读，不代为提交
router.post('/git/changes', wrap(async (req, res) => {
  const st = await gitAt(req, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (!st.ok) return ok(res, { is_repo: false, branch: null, files: [], stat: '' });
  const br = await gitAt(req, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const stat = await gitAt(req, ['diff', '--stat', '--', '.']);
  // 注意：gitRun 会对 stdout 整体 trim，首行行首那个「未暂存」空格会被吃掉，
  // 所以不能按固定列切，得用正则解析「状态 + 空格 + 路径」
  const files = String(st.stdout || '').split('\n').map((l) => l.replace(/\s+$/g, '')).filter(Boolean).slice(0, 300).map((l) => {
    const m = /^\s*(\S{1,2})\s+(.*)$/.exec(l);
    return m ? { status: m[1], path: m[2] } : { status: '?', path: l };
  });
  ok(res, {
    is_repo: true,
    branch: br.ok ? br.stdout : null,
    files,
    stat: stat.ok ? stat.stdout : '',
    truncated: files.length >= 300,
  });
}));

// 在资源管理器中定位（前端「在资源管理器中打开」菜单用）：只接受本机已存在的路径，不写任何东西
router.post('/reveal', wrap((req, res) => {
  const raw = String(req.body?.path || '').trim();
  if (!raw) return fail(res, 400, '请提供路径');
  const abs = path.resolve(raw);
  if (!fs.existsSync(abs)) return fail(res, 404, '路径不存在');
  if (process.platform !== 'win32') return fail(res, 400, '仅支持 Windows 资源管理器');
  try {
    const { spawn } = require('child_process');
    spawn('explorer.exe', ['/select,' + abs], { detached: true, stdio: 'ignore' }).unref();
  } catch (e) {
    return failErr(res, 500, '在资源管理器中打开失败', e);
  }
  ok(res, { path: abs }, '已在资源管理器中打开');
}));

// ---------- 后台任务面板（右栏「后台」页；与 background_list 工具同一数据源） ----------
router.get('/background', wrap((req, res) => {
  const bg = require('../utils/bg');
  const rows = [...bg.tasks.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((t) => ({
      id: t.id,
      pid: t.pid,
      command: t.command,
      cwd: t.cwd,
      log: t.log,
      state: t.state,
      exit: t.exitCode,
      bytes: t.bytes,
      runtime_ms: Date.now() - t.startedAt,
      tail: (t.tail || []).slice(-20).join('\n'),
    }));
  ok(res, { tasks: rows });
}));

router.post('/background/kill', wrap(async (req, res) => {
  const bg = require('../utils/bg');
  const id = String(req.body?.id || '').trim();
  if (!id) return fail(res, 400, '缺少任务 id');
  const r = await bg.kill(id);
  if (r.error) return fail(res, 404, r.error);
  ok(res, null, r.output || '已请求终止');
}));

module.exports = router;
