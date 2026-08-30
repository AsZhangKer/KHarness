const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { exec, execFile } = require('child_process');
const multer = require('multer');
const { fetch, ProxyAgent } = require('undici');
const { db } = require('../database');
const { ok, fail, wrap } = require('../utils/respond');
const { sanitizeText } = require('../utils/sanitize');

const router = express.Router();

// 对话活跃时间更新（模块级，供多处使用）
const touchChatStmt = db.prepare('UPDATE ai_chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?');

// ---------- 常量 ----------
const TEST_MESSAGE = '测试可用性，可用则回复"pass"，不需要其他多余文本。';
const TEST_TIMEOUT_MS = 30 * 1000;
const TEST_CONCURRENCY = 5;      // 同时测试的模型数上限
const REPLY_MAX_LEN = 2000;
const ERROR_MAX_LEN = 500;
const CHAT_TIMEOUT_MS = 120 * 1000;
const AGENT_DEFAULT_CWD = path.join(__dirname, '..', '..'); // 默认为 KHarness 项目根目录
const RATE_LIMIT_RETRY = 2;      // 上游 429 自动重试次数
// 说明：按需求已去掉工具/技能的执行超时限制，用户可随时点「停止」终止（会终止正在运行的命令）

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- 平台 / Shell ----------
const os = require('os');
const IS_WIN = process.platform === 'win32';

// 当前 Agent Shell（settings 表 agent_shell；空 = 系统默认）
function getShellSetting() {
  return (db.prepare("SELECT value FROM settings WHERE key = 'agent_shell'").get()?.value || '').trim();
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

// ---------- OOBE 首次启动向导 ----------
// 状态存 settings 表（oobe_done / oobe_platform），全浏览器生效而非仅本机浏览器
router.get('/oobe', wrap((req, res) => {
  const get = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;
  ok(res, {
    done: get('oobe_done') === '1',
    platform: get('oobe_platform') || (IS_WIN ? 'windows' : 'linux'),
    actual: IS_WIN ? 'windows' : 'linux',
    providers_count: db.prepare('SELECT COUNT(*) AS n FROM ai_providers').get().n,
    models_count: db.prepare('SELECT COUNT(*) AS n FROM ai_models').get().n
  });
}));

// 完成向导：skip 仅表示“跳过提供商/模型导入”，其余步骤照常保存
router.post('/oobe/finish', wrap((req, res) => {
  const b = req.body || {};
  const skipProvider = !!b.skip;
  const platform = b.platform === 'linux' ? 'linux' : 'windows';
  const setSetting = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP");

  let providerId = null;
  if (!skipProvider) {
    const pv = validateProviderBody(b.provider || {});
    if (pv.error) return fail(res, 400, pv.error);
    const models = Array.isArray(b.models) ? b.models.filter(m => m && String(m.model_id || '').trim()) : [];
    if (!models.length) return fail(res, 400, '至少需要导入一个模型');

    const insModel = db.prepare("INSERT INTO ai_models (provider_id, model_id, display_name, remark, price_in, price_out, price_cache, max_context, supports_search, supports_thinking, thinking_levels) VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, 0, '')");
    const tx = db.transaction(() => {
      const r = db.prepare("INSERT INTO ai_providers (name, base_url, api_key, home_url, proxy_enabled, proxy_host, proxy_port) VALUES (?, ?, ?, '', 0, '', 0)")
        .run(pv.name, pv.base_url, pv.api_key);
      providerId = Number(r.lastInsertRowid);
      for (const m of models) {
        const v = validateModelBody({ provider_id: providerId, model_id: m.model_id, display_name: m.display_name || m.model_id });
        if (v.error) throw new Error(v.error);
        insModel.run(providerId, v.model_id, v.display_name, v.remark || '');
      }
    });
    try { tx(); } catch (e) {
      if (/UNIQUE/i.test(e.message)) return fail(res, 400, '该提供商下已存在相同的模型ID');
      return fail(res, 500, `初始化失败：${String(e.message).substring(0, 200)}`);
    }
  }

  // Shell 默认值：仅当所选平台与实际运行平台一致时才写入（避免在 Windows 上写入 /bin/bash 导致命令无法执行）
  if (platform === (IS_WIN ? 'windows' : 'linux')) {
    setSetting.run('agent_shell', platform === 'linux' ? '/bin/bash' : '');
  }
  setSetting.run('shell_confirmed', '1');
  setSetting.run('oobe_platform', platform);
  setSetting.run('oobe_done', '1');
  ok(res, { provider_id: providerId }, skipProvider ? '初始设置完成（暂未配置 API）' : '初始设置完成');
}));

// 重新运行 OOBE（设置页入口）：仅重置标记，不清除已有数据
router.post('/oobe/reset', wrap((req, res) => {
  db.prepare("UPDATE settings SET value = '0', updated_at = CURRENT_TIMESTAMP WHERE key = 'oobe_done'").run();
  ok(res, null, '已重置，刷新页面后重新进入初始设置向导');
}));

// 首次启动探测：返回平台候选 shell 列表（前端弹窗用；missing 标记本机未检测到）
router.get('/shell', wrap(async (req, res) => {
  const current = getShellSetting();
  let candidates;
  if (IS_WIN) {
    const winCandidates = [
      { value: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', label: 'PowerShell 5（系统自带）' },
      { value: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', label: 'PowerShell 7（推荐）' },
      { value: 'C:\\Windows\\System32\\cmd.exe', label: 'cmd（传统）' },
      { value: 'C:\\Windows\\System32\\bash.exe', label: 'WSL Bash（默认路径）' },
      { value: 'C:\\Program Files\\Git\\bin\\bash.exe', label: 'Git Bash（默认路径）' }
    ];
    candidates = winCandidates.map(c => ({ ...c, missing: !fs.existsSync(c.value) }));
  } else {
    candidates = [
      { value: '/bin/bash', label: 'bash（推荐）' },
      { value: '/bin/zsh', label: 'zsh' },
      { value: '/bin/sh', label: 'sh（POSIX）' }
    ].map(c => ({ ...c, missing: !fs.existsSync(c.value) }));
  }
  ok(res, { platform: process.platform, current, candidates, is_set: !!current, confirmed: db.prepare("SELECT value FROM settings WHERE key = 'shell_confirmed'").get()?.value === '1' });
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

// 按所选 Shell 的调用格式执行命令：
// bash/zsh/sh → <shell> -c <cmd>；pwsh/powershell → -NoProfile -Command <cmd>；cmd/默认 → 系统默认 exec
function runShellCommand(command, cwd, holder) {
  const shellSetting = getShellSetting();
  if (!shellSetting) {
    return new Promise((resolve) => {
      // encoding:'buffer' 拿原始字节，按内容自适配解码（GBK 控制台 ↔ UTF-8）
      const child = exec(command, { cwd, maxBuffer: 4 * 1024 * 1024, encoding: 'buffer' }, (err, stdout, stderr) => {
        holder.child = null;
        if (err && !stdout && !stderr) return resolve({ error: String(err.message).substring(0, 4000) });
        const out = [stdout, stderr].filter(Boolean).map(decodeConsoleOutput).join('\n[stderr]\n');
        resolve({ output: (out || '(无输出)').substring(0, 4000) });
      });
      holder.child = child;
    });
  }
  const base = path.basename(shellSetting).toLowerCase();
  let args;
  if (/\.bash$|^bash|zsh|^sh(\.exe)?$|wsl/.test(base)) args = ['-c', command];
  else if (/pwsh|powershell/.test(base)) args = ['-NoProfile', '-Command', command];
  else args = ['/d', '/s', '/c', command]; // cmd.exe
  return new Promise((resolve) => {
    const child = execFile(shellSetting, args, { cwd, maxBuffer: 4 * 1024 * 1024, encoding: 'buffer', windowsHide: true }, (err, stdout, stderr) => {
      holder.child = null;
      if (err && !stdout && !stderr) return resolve({ error: String(err.message).substring(0, 4000) });
      const out = [stdout, stderr].filter(Boolean).map(decodeConsoleOutput).join('\n[stderr]\n');
      resolve({ output: (out || '(无输出)').substring(0, 4000) });
    });
    holder.child = child;
  });
}

// ---------- AGENTS.md / AGENT.md 静态上下文（哈希缓存 + 热加载） ----------
// 支持两种文件名：AGENTS.md（推荐，兼容 OpenCode）与 AGENT.md（单数别名），前者优先
// 位置优先级（叠加注入）：
//   1. 全局：~/.kharness/AGENTS.md 或 ~/.kharness/AGENT.md（所有会话生效）
//   2. 项目：<项目根>/AGENTS.md 或 <项目根>/AGENT.md（仅项目会话，覆盖全局）
//   3. 自由会话：<当前工作目录>/AGENTS.md 或 AGENT.md（自由会话按 cwd 就近）
// 格式：纯 Markdown 文本，无强制 frontmatter；首行可为 `# 标题`，正文为长期记忆/规范/技能说明
// 刷新：每次调用模型前重读并校验 SHA-256，200KB 上限，超限跳过并提示
const AGENTS_MD_MAX_BYTES = 200 * 1024;
const agentsMdCache = new Map(); // file -> { hash, content, skipped }

function loadAgentsMd(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    if (st.size > AGENTS_MD_MAX_BYTES) return { content: '', skipped: `文件过大（${Math.round(st.size / 1024)}KB，上限 200KB，已跳过）` };
    const content = fs.readFileSync(file, 'utf8');
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    const cached = agentsMdCache.get(file);
    if (cached && cached.hash === hash) return { ...cached, fresh: true };
    const entry = { hash, content };
    agentsMdCache.set(file, entry);
    return entry;
  } catch (e) {
    return null;
  }
}

function loadAgentsMdWithFallback(dir) {
  const p1 = path.join(dir, 'AGENTS.md');
  const p2 = path.join(dir, 'AGENT.md');
  const r1 = loadAgentsMd(p1);
  if (r1) return { file: p1, data: r1 };
  const r2 = loadAgentsMd(p2);
  if (r2) return { file: p2, data: r2 };
  return null;
}

// 估算 token（粗估：CJK 字符 1:1，其余约 4 字符 1 token）
function estimateTokens(text) {
  const s = String(text || '');
  const cjk = (s.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) || []).length;
  return Math.ceil(cjk + (s.length - cjk) / 4);
}

// 收集某会话适用的 AGENTS.md：全局兜底 + 项目根（项目会话）/ 工作目录（自由会话）
function collectAgentsMd(projectRoot, cwd) {
  const globalDir = path.join(os.homedir(), '.kharness');
  const scopedDir = projectRoot ? projectRoot : (cwd || AGENT_DEFAULT_CWD);
  const files = [];
  const g = loadAgentsMdWithFallback(globalDir);
  if (g) files.push({ scope: '全局', path: g.file, ...g.data, tokens: estimateTokens(g.data.content) });
  const s = loadAgentsMdWithFallback(scopedDir);
  if (s && s.file !== (g ? g.file : null)) {
    files.push({ scope: projectRoot ? '项目' : '目录', path: s.file, ...s.data, tokens: estimateTokens(s.data.content) });
  }
  return files;
}

// ---------- 敏感数据脱敏（只脱"进入 AI 上下文"的数据；AI 输出的代码绝不脱敏） ----------
let secretsCache = { at: 0, list: [] };
function getSecretPatterns() {
  const now = Date.now();
  if (now - secretsCache.at > 5000) {
    secretsCache = {
      at: now,
      list: db.prepare('SELECT id, pattern FROM secrets ORDER BY id ASC').all()
        .map(r => {
          try { return { id: r.id, re: new RegExp(r.pattern, 'g') }; }
          catch (e) { return { id: r.id, re: null, bad: r.pattern }; }
        })
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

// ---------- 自定义技能（server/agent-skills-custom/，遵循 opencode frontmatter 规范） ----------
const SKILLS_CUSTOM_DIR = path.join(__dirname, 'agent-skills-custom');

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

function checkApproval(name, args, cwd, projectRoot = null) {
  const target = String(args?.path || '');
  if (name === 'read_file' || name === 'write_file' || name === 'edit_file' || name === 'list_dir' || name === 'search_files' || name === 'find_files') {
    // 项目会话：文件工具由 guardTargetPath 硬边界统一处理（拒绝时作为 tool_result 让 AI 反思），不走人工审批
    if (projectRoot) return null;
    const p = path.resolve(cwd, target || '.');
    // 对原始输入与 resolve 结果都做检测（跨平台：Windows 盘符路径在 Linux 上 resolve 后会被当相对路径拼接）
    const probe = target || p;
    if (SENSITIVE_DIRS.test(p) || SENSITIVE_DIRS_WIN.test(p) || SENSITIVE_DIRS.test(probe) || SENSITIVE_DIRS_WIN.test(probe)) {
      return { level: 'red', reason: `访问系统敏感目录：${p}` };
    }
    if (!p.startsWith(cwd + path.sep) && p !== cwd) return { level: 'orange', reason: `访问工作目录之外的路径：${p}（当前目录 ${cwd}）` };
    return null;
  }
  if (name === 'run_command') {
    const cmd = String(args?.command || '');
    if (/\b(sudo|su)\b/.test(cmd)) return { level: 'red', reason: '命令请求管理员(sudo/su)权限' };
    if (DANGEROUS_CMD.test(cmd)) return { level: 'red', reason: '命令包含潜在危险操作（删除/格式化/关机/杀进程等）' };
    if (SENSITIVE_DIRS.test(cmd) || SENSITIVE_DIRS_WIN.test(cmd)) return { level: 'red', reason: '命令涉及系统敏感目录' };
    // 命令中出现的绝对路径若在工作目录之外 → 橙色审批
    const absHits = cmd.match(/(?:^|[\s'"(=])((?:\/[\w.\-+]+)+)/g) || [];
    for (const hit of absHits) {
      const p = hit.trim().replace(/^['"(=]/, '');
      if (SENSITIVE_DIRS.test(p)) return { level: 'red', reason: `命令涉及系统敏感目录：${p}` };
      if (p.startsWith('/') && p !== cwd && !p.startsWith(cwd + '/') && !p.startsWith('/tmp/') && !p.startsWith('/usr/bin/env') && !/\/(bin|usr\/bin)\//.test(p)) {
        return { level: 'orange', reason: `命令涉及工作目录之外的路径：${p}` };
      }
    }
    return null;
  }
  return null;
}

// 审批等待：挂起工具执行，等待前端用户裁决
const pendingApprovals = new Map();

function waitApproval(id, deniedList) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingApprovals.has(id)) {
        pendingApprovals.delete(id);
        resolve({ allow: false, timeout: true });
      }
    }, 5 * 60 * 1000);
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

// 审批裁决端点（前端批准/拒绝）
router.post('/chat/approve', wrap((req, res) => {
  const id = String(req.body?.id || '');
  const resolver = pendingApprovals.get(id);
  if (!resolver) return fail(res, 404, '审批请求不存在或已过期');
  resolver(!!req.body?.allow);
  ok(res, null, req.body?.allow ? '已批准' : '已拒绝');
}));

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
  const del = db.prepare('DELETE FROM ai_chat_messages WHERE chat_id = ? AND id >= ?').run(chatId, messageId);
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
    custom: file.includes('agent-skills-custom')
  };
}

function listSkills() {
  const out = [];
  for (const dir of [SKILLS_DIR, SKILLS_CUSTOM_DIR]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.md')) continue;
        try { out.push(parseSkillFile(path.join(dir, f), fs.readFileSync(path.join(dir, f), 'utf8'))); } catch (e) { /* 单文件损坏跳过 */ }
      }
    } catch (e) { /* 目录不存在跳过 */ }
  }
  return out;
}

const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: '在服务器上以 shell 执行命令（30 秒超时，输出截断）。工作目录由会话 /dir 决定。',
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
      description: '读取服务器上的文本文件（相对路径基于当前工作目录，自动识别 UTF-8/GBK 编码，返回完整内容；超大文件仅保留前 100000 字符）',
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
      description: '创建新文件,或覆盖已有文件(会替换整个文件内容)。适合创建新文件或整体重写;局部小改请用 edit_file。',
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
      name: 'search_files',
      description: '按正则表达式递归搜索目录下所有文本文件的内容，返回「文件:行号: 匹配行」列表。自动跳过 node_modules/.git/dist 等目录和二进制文件。查代码、找关键字优先用本工具，比在 shell 里敲 grep/findstr 更快更稳。',
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
      name: 'find_files',
      description: '按通配符模式递归查找文件并返回路径列表。支持 **（跨目录）、*（文件名内）、?（单字符）、{a,b}（多选一）。pattern 不含 / 时匹配任意层级的文件名。定位文件比 list_dir 逐层翻更快。',
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
  }
];

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
const TOOL_SCHEMAS = {
  run_command: { command: { type: 'string', required: true, desc: '要执行的 shell 命令' } },
  read_file: { path: { type: 'string', required: true, desc: '文件路径' } },
  write_file: { path: { type: 'string', required: true, desc: '文件路径' }, content: { type: 'string', required: true, desc: '完整文件内容' } },
  edit_file: { path: { type: 'string', required: true, desc: '文件路径' }, old_text: { type: 'string', required: true, desc: '要替换的原文（唯一匹配）' }, new_text: { type: 'string', required: true, desc: '替换后的新内容' } },
  list_dir: { path: { type: 'string', required: false, desc: '目录路径，默认当前目录' } },
  search_files: { pattern: { type: 'string', required: true, desc: '正则表达式' }, path: { type: 'string', required: false, desc: '搜索的起始目录，默认当前目录' }, include: { type: 'string', required: false, desc: '文件名过滤，如 *.js、*.{ts,vue}' } },
  find_files: { pattern: { type: 'string', required: true, desc: '通配符模式，如 **/*.ts、package.json' }, path: { type: 'string', required: false, desc: '查找的起始目录，默认当前目录' } },
  web_fetch: { url: { type: 'string', required: true, desc: '完整的 http/https 地址' } },
  load_skill: { name: { type: 'string', required: true, desc: '技能名称' } },
  use_skill: { name: { type: 'string', required: true, desc: '技能名称' } }
};

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

// 返回 null = 通过；返回 string = 给 AI 的校验错误（作为 tool_result 触发反思重试）
function validateToolArgs(name, args) {
  const schema = TOOL_SCHEMAS[name];
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
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.venv', 'venv', '__pycache__', '.idea', '.vscode']);

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

async function execTool(name, args, cwd, holder = { child: null }, projectRoot = null) {
  // 文件类工具：先过路径安全防护
  if (name === 'read_file' || name === 'write_file' || name === 'edit_file' || name === 'list_dir' || name === 'search_files' || name === 'find_files') {
    const guard = await guardTargetPath(name === 'search_files' || name === 'find_files' ? (args?.path || '.') : args?.path, cwd, projectRoot);
    if (guard) return guard;
  }
  try {
    switch (name) {
      case 'run_command': {
        // 无超时限制：用户可通过「停止」按钮终止（abort 时 SIGKILL）；Shell 由设置决定
        return await runShellCommand(String(args.command || ''), cwd, holder);
      }
      case 'read_file': {
        const p = path.resolve(cwd, String(args.path || ''));
        const d = decodeTextSmart(await fsp.readFile(p));
        // 按需求放开长度限制；仅保留超大文件安全网，防止意外读入超大日志打爆上下文
        if (d.length > 100000) return { output: d.substring(0, 100000) + `\n…(内容过长，已截断，共 ${d.length} 字符)` };
        return { output: d || '(空文件)' };
      }
      case 'write_file': {
        const p = path.resolve(cwd, String(args.path || ''));
        const content = String(args.content ?? '');
        let prev = null;
        try { prev = decodeTextSmart(await fsp.readFile(p)); } catch (e) {/* 不存在=新建 */}
        await fsp.writeFile(p, content);
        const diff = prev === null ? buildNewFileDiff(content) : buildFileDiff(prev, content);
        return {
          output: `已${prev === null ? '创建' : '覆盖'} ${p}(${content.length} 字符)`,
          diff, path: p, new_file: prev === null
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
        // 在原文件上统计匹配数,再仅替换首次(唯一)出现
        const firstIdx = prev.indexOf(oldText);
        if (firstIdx === -1) {
          return { error: `edit_file:未找到要替换的原文(请先 read_file 确认内容一致)`, path: p };
        }
        if (prev.indexOf(oldText, firstIdx + oldText.length) !== -1) {
          return { error: `edit_file:原文出现多次,匹配不唯一,未做任何修改,请用 read_file 确认并给出更长的唯一片段`, path: p };
        }
        const next = prev.slice(0, firstIdx) + newText + prev.slice(firstIdx + oldText.length);
        await fsp.writeFile(p, next);
        return {
          output: `已编辑 ${p}`,
          diff: buildFileDiff(prev, next),
          path: p,
          new_file: false
        };
      }
      case 'list_dir': {
        const p = path.resolve(cwd, String(args.path || '.'));
        const list = await fsp.readdir(p, { withFileTypes: true });
        const out = list.map(e => (e.isDirectory() ? e.name + '/' : e.name)).join('\n');
        return { output: (out || '(空目录)').substring(0, 20000) };
      }
      case 'search_files': {
        const base = path.resolve(cwd, String(args.path || '.'));
        const st = await fsp.stat(base).catch(() => null);
        if (!st || !st.isDirectory()) return { error: `search_files:目录不存在:${base}`, path: base };
        let rx;
        try { rx = new RegExp(String(args.pattern || ''), 'i'); }
        catch (e) { return { error: `search_files:正则无效:${e.message}`, path: base }; }
        const incRx = args.include ? globToRx(String(args.include)) : null;
        const entries = await fsp.readdir(base, { recursive: true, withFileTypes: true });
        const lines = [];
        let hitCount = 0;
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
              hitCount++;
              if (lines.length < 200) lines.push(`${rel}:${i + 1}: ${ls[i].trim().substring(0, 300)}`);
            } else if (isSimplePattern && fuzzyMatchServer(ls[i], plainPattern)) {
              hitCount++;
              if (lines.length < 200) lines.push(`${rel}:${i + 1}: ${ls[i].trim().substring(0, 300)} (模糊)`);
            } else continue;
          }
        }
        let out = lines.join('\n') || '(无匹配)';
        if (hitCount > lines.length) out += `\n…(共 ${hitCount} 处匹配,仅显示前 ${lines.length} 条,建议缩小范围或加 include 过滤)`;
        return { output: out.substring(0, 30000) };
      }
      case 'find_files': {
        const base = path.resolve(cwd, String(args.path || '.'));
        const st = await fsp.stat(base).catch(() => null);
        if (!st || !st.isDirectory()) return { error: `find_files:目录不存在:${base}`, path: base };
        const pat = String(args.pattern || '').trim();
        if (!pat) return { error: 'find_files:pattern 不能为空', path: base };
        const rx = globToRx(pat);
        const nameOnly = !pat.includes('/'); // 不含 / 的模式按“任意层级下的文件名”匹配
        const entries = await fsp.readdir(base, { recursive: true, withFileTypes: true });
        const out = [];
        for (const ent of entries) {
          if (!ent.isFile()) continue;
          const full = path.join(ent.parentPath || ent.path, ent.name);
          const rel = path.relative(base, full).split(path.sep).join('/');
          if (rel.split('/').some(seg => SKIP_DIRS.has(seg))) continue;
          if (nameOnly ? rx.test(ent.name) : rx.test(rel)) out.push(rel);
          if (out.length >= 300) break;
        }
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
        if (out.length >= 300) output += '\n…(结果过多,已截断至 300 条,请缩小查找范围)';
        return { output: output.substring(0, 30000) };
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
          if (!resp.ok) return { error: `web_fetch:HTTP ${resp.status} ${ctype}`, output: raw.substring(0, 2000) || null };
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
          if (text.length > 20000) text = text.substring(0, 20000) + `\n…(内容过长,已截断,共 ${text.length} 字符)`;
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
  const { projectRoot, planMode, agentsFiles } = opts;
  const shell = getShellSetting() || (IS_WIN ? 'cmd.exe（系统默认）' : process.env.SHELL || 'bash');
  const platformNote = IS_WIN
    ? '运行平台：Windows。命令需符合当前 Shell 语法；路径分隔符为 \\，含空格路径需加引号。'
    : '运行平台：Linux/macOS。使用 POSIX 命令语法。';
  const skills = listSkills();
  const lines = [
    '你是运行在本机 KHarness 中的开发运维助手，可以通过工具直接操作这台机器（主人本人使用）。',
    `当前工作目录：${cwd}（用户可用 /dir 指令切换，仅影响工具执行；相对路径一律基于该目录解析）。`,
    platformNote,
    `当前 Shell：${shell}（run_command 将使用它执行命令）。`,
    '使用工具的规则：',
    '- 执行命令前先想清楚必要性；绝不执行毁灭性命令（如 rm -rf /）；改代码前先读文件确认现状',
    '- 找文件用 find_files(通配符)、搜内容用 search_files(正则,自动跳过 node_modules/.git)、查网页/文档用 web_fetch；这些专用工具优先于在 shell 里敲 grep/findstr/ls 组合',
    '- run_command 的命令输出有截断，需要精确长输出时改用 head/tail/grep 等组合',
    '- 修改已有文件优先用 edit_file(只替换唯一匹配片段,改动会以彩色 diff 反馈给用户);新建文件或整体重写才用 write_file',
    '- 工具调用参数必须严格按 schema 命名（例如路径参数是 path，不是 folder/dir/filepath）',
    '- 需要执行命令、读写文件、列出目录等实际操作时，必须调用对应的工具函数完成，禁止只用文字描述操作过程或假装已执行'
  ];
  if (projectRoot) {
    lines.push(`- 本会话绑定项目，项目根目录：${projectRoot}。所有文件操作与命令的工作目录都被限制在该目录内，越界访问会被安全策略直接拒绝，请始终使用项目内路径。`);
  }
  // 技能惰性加载：system prompt 只给名字清单，详情由 load_skill 按需取回，避免撑爆上下文
  lines.push(skills.length
    ? `- 可用技能（${skills.length} 个）：${skills.map(s => s.name).join('、')}。技能详情不在此展开；执行对应专项任务（部署/重启/git/数据库等）前，先调用 load_skill(name) 获取完整说明再行动。用户消息中的 @技能名 表示用户要求你加载该技能。`
    : '- 当前无可用技能');
  // AGENTS.md 长期记忆（哈希校验热加载；全局兜底 + 项目/目录覆盖叠加）
  const loaded = agentsFiles || collectAgentsMd(projectRoot, cwd);
  const usable = loaded.filter(f => f.content);
  if (usable.length) {
    lines.push('', '[长期记忆：以下内容来自 AGENTS.md 文件（全局配置 + 项目/目录配置，就近覆盖），是项目背景、编码规范与业务约定，必须遵守]');
    for (const f of usable) lines.push(`<<AGENTS.md：${f.scope}（${f.path}）>>\n${f.content}`);
  }
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
  return lines.join('\n');
}

// ---------- 对话压缩（/press、/context、自动压缩共用） ----------

// 用当前模型把可读上下文压缩为摘要：写入 ai_chats.summary，被压缩消息归档（保留最近 2 条不归档）
async function compressChat(chatId, modelRow, dispatcher, signal, send = null) {
  const chat = db.prepare('SELECT summary FROM ai_chats WHERE id = ?').get(chatId);
  const rows = db.prepare(
    "SELECT id, role, content FROM ai_chat_messages WHERE chat_id = ? AND archived = 0 ORDER BY id ASC"
  ).all(chatId);
  // 保留最近 2 条（最近一次交互）不归档，保证当前话题连续
  const keep = Math.min(2, rows.length);
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

  const resp = await fetch(`${modelRow.base_url}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${modelRow.api_key}` },
    body: JSON.stringify({
      model: modelRow.model_id,
      messages: [{ role: 'user', content: prompt }],
      stream: false
    }),
    dispatcher,
    signal
  });
  if (!resp.ok) {
    const detail = (await resp.text().catch(() => '')).substring(0, 200);
    throw new Error(`压缩请求失败 HTTP ${resp.status}: ${detail}`);
  }
  const data = await resp.json();
  const summary = stripThinking(data.choices?.[0]?.message?.content || '').substring(0, 8000);
  if (!summary.trim()) throw new Error('压缩结果为空');

  db.prepare('UPDATE ai_chats SET summary = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(summary, chatId);
  const archive = db.prepare('UPDATE ai_chat_messages SET archived = 1 WHERE id = ?');
  db.transaction(ids => { for (const id of ids) archive.run(id); })(toCompress.map(r => r.id));
  return { skipped: false, length: summary.length };
}

function chatContextUsage(chatId) {
  const chat = db.prepare('SELECT context_limit FROM ai_chats WHERE id = ?').get(chatId);
  // 压缩后从 0 重新统计：仅计入未归档消息，摘要不计入
  const used = db.prepare(
    "SELECT COALESCE(SUM(LENGTH(content)), 0) AS n FROM ai_chat_messages WHERE chat_id = ? AND archived = 0"
  ).get(chatId).n;
  return {
    used,
    limit: chat.context_limit || 0
  };
}

// 手动压缩（/press 指令）
router.post('/chat/press', wrap(async (req, res) => {
  const chatId = parseInt(req.body?.chat_id);
  const modelRowId = parseInt(req.body?.model_row_id);
  if (!Number.isInteger(chatId) || chatId < 1) return fail(res, 400, '无效的对话ID');
  const chat = db.prepare('SELECT id FROM ai_chats WHERE id = ? AND user_id = ?').get(chatId, 1);
  if (!chat) return fail(res, 404, '对话不存在');
  const modelRow = db.prepare(`
    SELECT m.model_id, p.base_url, p.api_key, p.proxy_enabled, p.proxy_host, p.proxy_port
    FROM ai_models m JOIN ai_providers p ON m.provider_id = p.id WHERE m.id = ?
  `).get(Number.isInteger(modelRowId) && modelRowId > 0 ? modelRowId : 0);
  if (!modelRow) return fail(res, 400, '请先选择一个模型用于压缩');
  const dispatcher = modelRow.proxy_enabled && modelRow.proxy_host
    ? new ProxyAgent(`http://${modelRow.proxy_host}:${modelRow.proxy_port}`) : undefined;
  try {
    const r = await compressChat(chatId, { ...modelRow, base_url: modelRow.base_url }, dispatcher, AbortSignal.timeout(90 * 1000));
    if (r.skipped) return ok(res, { length: r.length, skipped: true }, '没有可压缩的对话内容');
    ok(res, { length: r.length }, `压缩完成，摘要 ${r.length} 字符`);
  } catch (e) {
    fail(res, 502, e.message || '压缩失败');
  }
}));

// 设定上下文窗口并立即压缩（/context 指令）
router.post('/chat/context', wrap(async (req, res) => {
  const chatId = parseInt(req.body?.chat_id);
  const limit = parseInt(req.body?.limit);
  const modelRowId = parseInt(req.body?.model_row_id);
  if (!Number.isInteger(chatId) || chatId < 1) return fail(res, 400, '无效的对话ID');
  if (!Number.isInteger(limit) || limit < 1000 || limit > 1000000) {
    return fail(res, 400, '上下文窗口需为 1000 ~ 1000000 的整数（字符数）');
  }
  const chat = db.prepare('SELECT id FROM ai_chats WHERE id = ? AND user_id = ?').get(chatId, 1);
  if (!chat) return fail(res, 404, '对话不存在');
  db.prepare('UPDATE ai_chats SET context_limit = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(limit, chatId);

  const modelRow = db.prepare(`
    SELECT m.model_id, p.base_url, p.api_key, p.proxy_enabled, p.proxy_host, p.proxy_port
    FROM ai_models m JOIN ai_providers p ON m.provider_id = p.id WHERE m.id = ?
  `).get(Number.isInteger(modelRowId) && modelRowId > 0 ? modelRowId : 0);
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
      SELECT c.id, c.cwd, c.project_id, p.name AS project_name, p.root_path AS project_root
      FROM ai_chats c LEFT JOIN projects p ON p.id = c.project_id WHERE c.id = ?
    `).get(chatId);
    if (!chatRow) return fail(res, 404, '对话不存在');
    if (chatRow.cwd) base = chatRow.cwd;
  }
  if (typeof req.body?.base === 'string' && req.body.base.trim()) base = req.body.base.trim();

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

// ---------- 项目与会话分离 ----------

// 项目列表（含各项目下的会话数）
router.get('/projects', wrap((req, res) => {
  const projects = db.prepare(`
    SELECT p.id, p.name, p.root_path, p.created_at,
           (SELECT COUNT(*) FROM ai_chats c WHERE c.project_id = p.id) AS chat_count
    FROM projects p
    ORDER BY p.created_at ASC, p.id ASC
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

// 新建项目 { name, root_path }
router.post('/projects', wrap((req, res) => {
  const name = sanitizeText(req.body?.name, 60);
  if (!name) return fail(res, 400, '项目名称不能为空');
  if (!String(req.body?.root_path || '').trim()) return fail(res, 400, '请提供项目工作目录');
  const root = normalizeInputPath(req.body.root_path);
  const err = validateProjectRoot(root);
  if (err) return fail(res, 400, err);
  const r = db.prepare('INSERT INTO projects (name, root_path) VALUES (?, ?)').run(name, root);
  ok(res, { id: Number(r.lastInsertRowid), name, root_path: root }, '项目已创建');
}));

// 更新项目（改名 / 改工作目录）
router.put('/projects/:id', wrap((req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id < 1) return fail(res, 400, '无效的项目ID');
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!row) return fail(res, 404, '项目不存在');
  const name = req.body?.name !== undefined ? sanitizeText(req.body.name, 60) : row.name;
  if (!name) return fail(res, 400, '项目名称不能为空');
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
  const del = db.transaction(() => {
    db.prepare('DELETE FROM ai_chat_messages WHERE chat_id IN (SELECT id FROM ai_chats WHERE project_id = ?)').run(id);
    db.prepare('DELETE FROM ai_chats WHERE project_id = ?').run(id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  });
  del();
  ok(res, { removed_chats: cnt }, `项目已删除${cnt ? `（含 ${cnt} 个会话）` : ''}`);
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
  return {
    name,
    base_url: normalizeBaseUrl(body.base_url),
    api_key: body.api_key.trim(),
    home_url: homeUrl || '',
    proxy_enabled: proxyEnabled,
    proxy_host: proxyHost,
    proxy_port: proxyPort
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

// 对单个模型发起 OpenAI 协议流式请求，返回 { status, reply, error, latency_ms }
async function testModel(model, provider, dispatcher) {
  const started = Date.now();
  try {
    let res = null;
    for (let attempt = 0; ; attempt++) {
      res = await fetch(`${provider.base_url}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${provider.api_key}`
        },
        body: JSON.stringify({
          model: model.model_id,
          messages: [{ role: 'user', content: TEST_MESSAGE }],
          stream: true
        }),
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
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // 逐块解析 SSE：首块到达即记录首字延迟；忽略 reasoning_content，仅累计可见 content
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstLatency === null) firstLatency = Date.now() - started;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta;
          if (delta && typeof delta.content === 'string') content += delta.content;
          // delta.reasoning_content 为思考过程，按要求不展示、不计入回复
        } catch (e) { /* 非 JSON 行跳过 */ }
      }
      if (content.length > REPLY_MAX_LEN) break; // 足够判断可用性，提前结束
    }

    const reply = stripThinking(content);
    return {
      status: 'ok',
      reply: (reply || '(模型返回了空回复)').substring(0, REPLY_MAX_LEN),
      latency_ms: firstLatency,
      error: null
    };
  } catch (e) {
    let msg = e.message || String(e);
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
           p.proxy_enabled, p.proxy_host, p.proxy_port
    FROM ai_models m JOIN ai_providers p ON m.provider_id = p.id
    ${modelIds ? `WHERE m.id IN (${modelIds.map(() => '?').join(',')})` : ''}
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
    'INSERT INTO ai_providers (name, base_url, api_key, home_url, proxy_enabled, proxy_host, proxy_port) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(v.name, v.base_url, v.api_key, v.home_url, v.proxy_enabled, v.proxy_host, v.proxy_port);
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
    'UPDATE ai_providers SET name = ?, base_url = ?, api_key = ?, home_url = ?, proxy_enabled = ?, proxy_host = ?, proxy_port = ? WHERE id = ?'
  ).run(v.name, v.base_url, v.api_key, v.home_url, v.proxy_enabled, v.proxy_host, v.proxy_port, id);
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
  return {
    provider_id: providerId, model_id: modelId, display_name: displayName, remark,
    price_in: price(body.price_in), price_out: price(body.price_out), price_cache: price(body.price_cache),
    max_context: Number.isInteger(maxContext) && maxContext > 0 ? maxContext : 0,
    supports_search: supportsSearch,
    supports_thinking: supportsThinking,
    thinking_levels: thinkingLevels
  };
}

// 管理端模型列表（含提供商全量信息 + 最新测试结果）
router.get('/models', wrap((req, res) => {
  const models = db.prepare(`
    SELECT m.id, m.provider_id, m.model_id, m.display_name, m.remark, m.created_at,
           m.price_in, m.price_out, m.price_cache, m.disabled,
           m.max_context, m.supports_search, m.supports_thinking, m.thinking_levels,
           p.name AS provider_name, p.base_url, p.home_url, p.api_key,
           p.proxy_enabled, p.proxy_host, p.proxy_port,
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
      'INSERT INTO ai_models (provider_id, model_id, display_name, remark, price_in, price_out, price_cache, max_context, supports_search, supports_thinking, thinking_levels) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(v.provider_id, v.model_id, v.display_name, v.remark, v.price_in, v.price_out, v.price_cache, v.max_context, v.supports_search, v.supports_thinking, v.thinking_levels);
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
  const insertStmt = db.prepare('INSERT INTO ai_models (provider_id, model_id, display_name, remark, price_in, price_out, price_cache, max_context, supports_search, supports_thinking, thinking_levels) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const tx = db.transaction((items) => {
    for (const item of items) {
      const v = validateModelBody({ provider_id: providerId, ...item });
      if (v.error) { errors.push(`${item.model_id || '(空)'}: ${v.error}`); skipped++; continue; }
      if (existed.has(v.model_id)) { errors.push(`${v.model_id}: 已存在`); skipped++; continue; }
      try {
        insertStmt.run(v.provider_id, v.model_id, v.display_name, v.remark, v.price_in, v.price_out, v.price_cache, v.max_context, v.supports_search, v.supports_thinking, v.thinking_levels);
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
  const baseUrl = String(provider.base_url || '').replace(/\/+$/, '');
  const url = baseUrl + '/models';
  const dispatcher = provider.proxy_enabled && provider.proxy_host
    ? new ProxyAgent(`http://${provider.proxy_host}:${provider.proxy_port}`) : undefined;
  const started = Date.now();
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${provider.api_key}`,
        'Content-Type': 'application/json'
      },
      dispatcher,
      signal: AbortSignal.timeout(15000)
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '').then(t => t.substring(0, 500));
      return fail(res, 502, `拉取失败 HTTP ${resp.status}: ${text || resp.statusText}`);
    }
    const data = await resp.json().catch(() => null);
    if (!data) return fail(res, 502, '返回内容不是有效 JSON');
    // OpenAI 兼容：{ data: [{id}], object: "list" } 或直接数组
    let ids = [];
    if (Array.isArray(data.data)) ids = data.data.map(x => x.id || x.name || '').filter(Boolean);
    else if (Array.isArray(data)) ids = data.map(x => x.id || x.name || '').filter(Boolean);
    else if (Array.isArray(data.models)) ids = data.models.map(x => x.id || x.name || '').filter(Boolean);
    ids = [...new Set(ids)].sort();
    const latency = Date.now() - started;
    // 标记已存在的模型
    const existed = new Set(db.prepare('SELECT model_id FROM ai_models WHERE provider_id = ?').all(id).map(r => r.model_id));
    const list = ids.map(mid => ({ model_id: mid, existed: existed.has(mid) }));
    ok(res, { list, latency_ms: latency }, `获取到 ${ids.length} 个模型`);
  } catch (e) {
    let msg = e.message || String(e);
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

// body: { model_id?: number } 不传则测试全部模型
router.post('/test', wrap(async (req, res) => {
  let modelIds = null;
  if (req.body && req.body.model_id !== undefined) {
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
  if (!rawContent.trim() || rawContent.length > 8000) {
    return fail(res, 400, '消息内容不能为空且不超过 8000 字符');
  }
  // 用户消息进入 AI 上下文前同样脱敏（敏感数据表中命中的部分替换为 ***REDACTED***）
  const content = redactSecrets(rawContent);
  const agent = !!req.body?.agent;
  const bypass = !!req.body?.bypass;

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
           p.base_url, p.api_key, p.proxy_enabled, p.proxy_host, p.proxy_port
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
      SELECT c.id, c.cwd, c.project_id, c.plan_mode, c.temperature, c.frequency_penalty, c.presence_penalty, c.search_enabled, c.search_strategy, c.thinking_level, c.censored_words, c.context_limit, p.root_path AS project_root
      FROM ai_chats c LEFT JOIN projects p ON p.id = c.project_id
      WHERE c.id = ? AND c.user_id = ?
    `).get(chatId, 1);
    if (!chatRow) return fail(res, 404, '对话不存在');
    planMode = !!chatRow.plan_mode;
  } else {
    chatId = null;
    const pid = parseInt(req.body?.project_id);
    if (Number.isInteger(pid) && pid > 0) {
      project = db.prepare('SELECT id, root_path FROM projects WHERE id = ?').get(pid);
      if (!project) return fail(res, 404, '项目不存在，无法创建会话');
    }
    planMode = !!req.body?.plan_mode;
  }

  // 会话工作目录（不修改进程 CWD，仅作为工具执行的基准目录）：
  // 优先级：body.cwd（agent 模式）> 会话存量 cwd > 项目根 > 默认目录
  // 项目会话强制限制：cwd 必须位于项目根内，否则回落到项目根
  let cwd = null;
  const bodyCwd = typeof req.body?.cwd === 'string' ? req.body.cwd.trim() : '';
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

  const makeDispatcher = (row) => row.proxy_enabled && row.proxy_host
    ? new ProxyAgent(`http://${row.proxy_host}:${row.proxy_port}`) : undefined;

  const controller = new AbortController();
  // 注意：不能监听 req 'close'（请求体读完即触发会误杀上游请求）；
  // res 'close' 且响应未正常结束时 = 客户端断开 → 终止上游与正在运行的命令，并拒绝待审批
  const onAbort = () => {
    controller.abort();
    if (toolHolder.child) { try { toolHolder.child.kill('SIGKILL'); } catch (e) { /* 忽略 */ } }
    for (const deny of onAbort.deniedList.splice(0)) deny();
  };
  onAbort.deniedList = [];
  res.on('close', () => { if (!res.writableEnded) onAbort(); });
  const toolHolder = { child: null };
  controller.signal.addEventListener('abort', () => {
    if (toolHolder.child) { try { toolHolder.child.kill('SIGKILL'); } catch (e) { /* 忽略 */ } }
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
  const insertAssistantMsg = db.prepare('INSERT INTO ai_chat_messages (chat_id, role, content, model_row_id, reasoning, steps_json) VALUES (?, ?, ?, ?, ?, ?)');

  (async () => {
    const started = Date.now();
    let fullReply = '';
    let fullReasoning = '';
    let errSent = false;
    try {
      if (!chatId) {
        chatTitle = stripImageTokens(content).trim().substring(0, 30) || '新对话';
        const r = db.prepare('INSERT INTO ai_chats (user_id, model_row_id, title, project_id, cwd, plan_mode) VALUES (?, ?, ?, ?, ?, ?)')
          .run(1, poolRows[0].id, chatTitle, project ? project.id : null, cwd, planMode ? 1 : 0);
        chatId = Number(r.lastInsertRowid);
      } else {
        // 已有会话：跟随本次发送的模型与工作目录（项目会话的 cwd 已被 clamp 在项目根内）
        db.prepare('UPDATE ai_chats SET model_row_id = ?, cwd = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(poolRows[0].id, cwd, chatId);
      }
      touchChatStmt.run(chatId);
      const userInsert = insertMsg.run(chatId, 'user', content);
      send({ t: 'chat', chat_id: chatId, title: chatTitle, user_message_id: Number(userInsert.lastInsertRowid) });

      // 上下文窗口：用量达 80% 自动压缩
      const chatMeta = db.prepare('SELECT summary, context_limit FROM ai_chats WHERE id = ?').get(chatId);
      if (chatMeta.context_limit > 0) {
        const usage0 = chatContextUsage(chatId);
        if (usage0.used >= chatMeta.context_limit * 0.8) {
          send({ t: 'note', message: `上下文用量 ${usage0.used}/${usage0.limit} 已达 80%，自动压缩中…` });
          try {
            const r = await compressChat(chatId, poolRows[0], makeDispatcher(poolRows[0]), controller.signal);
            send({ t: 'note', message: `自动压缩完成，摘要 ${r.length} 字符` });
          } catch (e) {
            send({ t: 'note', message: `自动压缩失败：${String(e.message).substring(0, 120)}（继续使用原上下文）` });
          }
        }
      }

      // 上下文：历史摘要前缀 + 未归档消息
      const chatMeta2 = db.prepare('SELECT summary FROM ai_chats WHERE id = ?').get(chatId);
      const history = db.prepare(
        "SELECT role, content FROM ai_chat_messages WHERE chat_id = ? AND archived = 0 ORDER BY id ASC LIMIT 60"
      ).all(chatId);
      const baseMsgs = [];
      if (chatMeta2.summary) {
        baseMsgs.push(
          { role: 'user', content: '[此前对话的摘要，供你参考]\n' + chatMeta2.summary },
          { role: 'assistant', content: '明白，我已了解之前的对话内容，请继续。' }
        );
      }
      baseMsgs.push(...history.map(h => buildUpstreamContent(h.role, stripLegacyToolLog(h.content))));

      // 上游请求：429 自动重试；include_usage 设置开启时带 stream_options（用量统计需要）
      const includeUsage = (db.prepare("SELECT value FROM settings WHERE key = 'include_usage'").get()?.value ?? '1') !== '0';
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
        // 模型配置透传
        const temp = chatRow ? chatRow.temperature : 0.7;
        if (Number.isFinite(temp)) payload.temperature = Number(temp);
        if (chatRow) {
          if (Number.isFinite(chatRow.frequency_penalty)) payload.frequency_penalty = Number(chatRow.frequency_penalty);
          if (Number.isFinite(chatRow.presence_penalty)) payload.presence_penalty = Number(chatRow.presence_penalty);
          if (chatRow.search_enabled && row.supports_search) {
            payload.enable_search = true;
            payload.web_search = true;
            // 阿里云等：search_options.search_strategy
            payload.search_options = { search_strategy: chatRow.search_strategy || 'turbo' };
            // 注意：OpenAI Responses API 的 web_search 是 /v1/responses 的 tools 格式，
            // chat/completions 的 tools 仅支持 function 类型，混入 web_search 会导致
            // "tools[9].function: missing field `parameters`" 400 错误，故不再向 tools 追加
          }
          if (chatRow.thinking_level && row.supports_thinking) {
            payload.reasoning_effort = chatRow.thinking_level;
            payload.thinking = { type: chatRow.thinking_level };
            // 兼容不同厂商的大小写
            payload.reasoning = { effort: chatRow.thinking_level };
          }
        }
        for (let attempt = 0; ; attempt++) {
          resp = await fetch(`${row.base_url}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${row.api_key}` },
            body: JSON.stringify(payload),
            dispatcher: makeDispatcher(row),
            signal: controller.signal
          });
          if (resp.status === 429 && attempt < RATE_LIMIT_RETRY) {
            send({ t: 'note', message: `[${row.display_name}] 上游限流(429)，${(attempt + 1) * 2} 秒后自动重试…` });
            await sleep((attempt + 1) * 2000);
            continue;
          }
          // 搜索回退：若开启搜索但上游不支持（400），自动去掉搜索重试一次
          if (resp.status === 400 && payload.enable_search && attempt === 0) {
            send({ t: 'note', message: `[${row.display_name}] 搜索不受支持，自动回退为普通对话…` });
            delete payload.enable_search;
            delete payload.web_search;
            delete payload.search_options;
            continue;
          }
          break;
        }
        return resp;
      };

      // 解析一条 SSE 流：content 增量转发、reasoning 转发、tool_calls 分片累积、usage 提取
      const consumeStream = async (resp) => {
        let content = '';
        let usage = null;
        const tcAcc = new Map();
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const json = JSON.parse(payload);
              const delta = json.choices?.[0]?.delta;
              if (delta && typeof delta.content === 'string' && delta.content) {
                const hit = hitCensored(delta.content);
                if (hit) {
                  try { controller.abort(); } catch(e) {}
                  throw new Error(`审查终止：包含词汇“${hit}”`);
                }
                content += delta.content;
                send({ t: 'delta', text: delta.content });
              }
              if (delta && typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
                const hit = hitCensored(delta.reasoning_content);
                if (hit) {
                  try { controller.abort(); } catch(e) {}
                  throw new Error(`审查终止：包含词汇“${hit}”`);
                }
                fullReasoning += delta.reasoning_content;
                send({ t: 'reason', text: delta.reasoning_content });
              }
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
                    throw new Error(`审查终止：工具调用包含词汇“${hit}”`);
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
            } catch (e) { /* 非 JSON 行跳过 */ }
          }
        }
        return { content, tcAcc, usage };
      };

      // 用量入库：缓存命中单独记（计费时 cached 按 price_cache，其余输入按 price_in）
      const logUsage = (row, usage) => {
        if (!usage || !row) return;
        try {
          db.prepare('INSERT INTO usage_log (chat_id, project_id, model_row_id, prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(chatId, chatRow?.project_id ?? project?.id ?? null, row.id, usage.prompt_tokens, usage.completion_tokens, usage.cached_tokens, usage.reasoning_tokens);
        } catch (e) { /* 统计失败不影响主流程 */ }
      };

      // 普通流式（单模型，支持池内 failover）
      const streamPlain = async (msgs, rows) => {
        let lastText = '';
        for (let mi = 0; mi < rows.length; mi++) {
          const row = rows[mi];
          if (mi > 0) send({ t: 'model', id: row.id, name: row.display_name });
          const resp = await fetchUpstream(row, { model: row.model_id, messages: msgs });
          if (!resp.ok) {
            const detail = (await resp.text().catch(() => '')).substring(0, ERROR_MAX_LEN);
            if (mi < rows.length - 1) {
              send({ t: 'note', message: `[${row.display_name}] 请求失败(HTTP ${resp.status})，切换下一个模型…` });
              continue;
            }
            send({ t: 'error', message: `HTTP ${resp.status}: ${detail || resp.statusText}` });
            errSent = true;
            return { text: lastText, used: null };
          }
          const { content, tcAcc, usage } = await consumeStream(resp);
          logUsage(row, usage);
          if (tcAcc.size === 0) return { text: content, used: row };
          // 罕见：普通模式收到工具调用，追加提示后按文本处理
          lastText = content;
        }
        return { text: lastText, used: rows[rows.length - 1] };
      };

      // Agent 工具循环（模型池 failover + 审批门 + 参数校验 + 脱敏 + 任务联动 + 全文本累积）
const runAgent = async (msgs, rows) => {
        const steps = [];
        let allText = '';
        const agentsFiles = collectAgentsMd(project ? project.root_path : null, cwd);
        const upstreamMsgs = [{ role: 'system', content: agentSystemPrompt(cwd, { projectRoot: project ? project.root_path : null, planMode, agentsFiles }) }, ...msgs];
        let usedModel = null;
        const step = (st) => steps.push(st);
        // 参数校验失败连续计数（防无限重试浪费 token）：同工具连续 3 次校验失败后强制要求换方案
        let invalidStreak = 0;
        const INVALID_STREAK_MAX = 3;
        for (let mi = 0; mi < rows.length; mi++) {
          const row = rows[mi];
          if (mi > 0) send({ t: 'model', id: row.id, name: row.display_name });
          usedModel = row;
          let failed = false;
          for (let iter = 0; !failed; iter++) {
            const resp = await fetchUpstream(row, { model: row.model_id, messages: upstreamMsgs, tools: AGENT_TOOLS });
            if (!resp.ok) {
              const errBody = await resp.text().catch(() => '');
              if (iter === 0 && resp.status === 400 && /tool/i.test(errBody)) {
                send({ t: 'note', message: `[${row.display_name}] 不支持工具调用` });
                step({ type: 'note', message: `[${row.display_name}] 不支持工具调用` });
              }
              if (mi < rows.length - 1) {
                send({ t: 'note', message: `[${row.display_name}] Agent 请求失败(HTTP ${resp.status}),切换下一个模型...` });
                step({ type: 'note', message: `[${row.display_name}] Agent 请求失败(HTTP ${resp.status}),切换下一个模型...` });
                failed = true;
                break;
              }
              send({ t: 'error', message: `HTTP ${resp.status}: ${errBody.substring(0, ERROR_MAX_LEN)}` });
              errSent = true;
              return { reply: allText, steps, used: row, errorSent: true };
            }
            const { content, tcAcc, usage } = await consumeStream(resp);
            logUsage(row, usage);
            // Plan 模式：<plan> 建任务、<task-status> 同步状态；标签从正文中剥离（不污染上下文）
            if (content) {
              const { text: cleaned, changed } = parseTaskTags(content, chatId);
              allText += (allText ? '\n' : '') + cleaned;
              if (changed) send({ t: 'tasks', tasks: getTasks(chatId) });
            }

            if (tcAcc.size === 0) {
              return { reply: allText, steps, used: row };
            }

            const calls = [...tcAcc.values()].map((tc, i) => ({
              id: tc.id || `call_${iter}_${i}`,
              type: 'function',
              function: { name: tc.name, arguments: tc.args || '{}' }
            }));
            upstreamMsgs.push({ role: 'assistant', content: (content || '').replace(/<task-status\b[^>]*\/>\s?/g, '').replace(/<plan>[\s\S]*?<\/plan>/g, '').trim(), tool_calls: calls });
            for (const call of calls) {
              const name = call.function.name || '';
              // 1) 非法 JSON：先自动修复，仍失败则把错误作为 tool_result 交给 AI 反思重试
              let args = null;
              let parseErr = null;
              try { args = JSON.parse(call.function.arguments || '{}'); } catch (e) {
                try { args = JSON.parse(repairJson(call.function.arguments || '{}')); }
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
                send({ t: 'tool', name, args: { _raw: String(call.function.arguments || '').substring(0, 200) } });
                step({ type: 'tool', name, args: { _raw: String(call.function.arguments || '').substring(0, 200) } });
                send({ t: 'tool_result', name, output: null, error: msgText, open: true });
                step({ type: 'result', name, output: null, error: msgText, open: true });
                upstreamMsgs.push({ role: 'tool', tool_call_id: call.id, content: msgText });
                continue;
              }
              invalidStreak = 0;
              send({ t: 'tool', name, args });
              step({ type: 'tool', name, args });

              // 审批门:越界/敏感/危险操作需要用户裁决(bypass 自动放行)
              const check = bypass ? null : checkApproval(name, args, cwd, project ? project.root_path : null);
              let result;
              if (check) {
                const approvalId = crypto.randomBytes(8).toString('hex');
                send({ t: 'approval', id: approvalId, level: check.level, tool: name, args, reason: check.reason });
                const decision = await waitApproval(approvalId, onAbort.deniedList);
                if (!decision.allow) {
                  const msgText = decision.timeout ? '审批超时,用户未响应,操作被拒绝' : '用户拒绝执行该操作。请尊重用户决定,不要重复尝试。';
                  const deniedPath = (name === 'write_file' || name === 'edit_file') ? path.resolve(cwd, String(args.path || '')) : null;
                  send({ t: 'tool_result', name, output: null, error: msgText, open: true, diff: null, path: deniedPath, new_file: false });
                  step({ type: 'result', name, output: null, error: msgText, open: true, diff: null, path: deniedPath, new_file: false });
                  upstreamMsgs.push({ role: 'tool', tool_call_id: call.id, content: msgText });
                  continue;
                }
              }
              result = await execTool(name, args, cwd, toolHolder, project ? project.root_path : null);
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
                new_file: result.new_file || false
              });
              step({
                type: 'result',
                name,
                output: result.output || null,
                error: result.error || null,
                open: false,
                diff: (result.diff && result.diff.length) ? result.diff : null,
                path: result.path || null,
                new_file: result.new_file || false
              });
              // 回传给 AI 的工具结果：read_file 不截断（上下文即上限），其余工具仍保留 4000 字符防 token 浪费
              const echoCap = name === 'read_file' ? 100000 : 4000;
              const echoText = ((result.output || '') + (result.error ? '\n[错误] ' + result.error : '')).substring(0, echoCap) || '(无输出)';
              upstreamMsgs.push({ role: 'tool', tool_call_id: call.id, content: echoText });
            }
            await sleep(250);
          }
          if (failed) continue;
          return { reply: allText, steps, used: row };
        }
        // 全部模型失败
        send({ t: 'error', message: '模型池中所有模型均请求失败' });
        errSent = true;
        return { reply: allText, steps, used: null, errorSent: true };
      };

      let agentSteps = [];
      let usedModelRow = poolRows[0].id;
      if (agent) {
        const r = await runAgent(baseMsgs, poolRows);
        agentSteps = r.steps || [];
        if (r.used) usedModelRow = r.used.id;
        if (r.fallback) {
          const pr = await streamPlain(baseMsgs, poolRows);
          fullReply = pr.text;
          fullReasoning = pr.reasoning || fullReasoning;
          if (pr.used) usedModelRow = pr.used.id;
          if (pr.failed) errSent = true;
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
      }

      if (fullReply.trim()) {
        // 入库前统一解析任务标签（幂等；runAgent 流中已实时处理过，普通模式在此处理）
        const fin = parseTaskTags(stripLegacyToolLog(fullReply), chatId);
        if (fin.changed) send({ t: 'tasks', tasks: getTasks(chatId) });
        insertAssistantMsg.run(chatId, 'assistant', fin.text.substring(0, 50000), usedModelRow, (fullReasoning || '').substring(0, 20000) || null, agentSteps.length ? JSON.stringify(agentSteps) : null);
        touchChatStmt.run(chatId);
      }
      if (!errSent) {
        const usage = chatContextUsage(chatId);
        send({ t: 'done', latency_ms: Date.now() - started, context_used: usage.used, context_limit: usage.limit, tasks: getTasks(chatId) });
      }
    } catch (e) {
      if (fullReply.trim()) {
        try {
          insertAssistantMsg.run(chatId, 'assistant', stripLegacyToolLog(fullReply).substring(0, 50000), poolRows[0].id, (fullReasoning || '').substring(0, 20000) || null, null);
          touchChatStmt.run(chatId);
        } catch (e2) { /* 忽略 */ }
      }let msg = e.message || String(e);
      if (e.name === 'AbortError' || e.code === 'ABORT_ERR' || /timeout|abort/i.test(msg)) {
        msg = req.destroyed ? '已取消' : '请求超时';
      }
      send({ t: 'error', message: String(msg).substring(0, ERROR_MAX_LEN) });
    } finally {
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
    SELECT c.id, c.title, c.created_at, c.updated_at, c.context_limit, c.project_id, c.cwd, c.plan_mode,
           LENGTH(c.summary) AS summary_length,
           (SELECT COUNT(*) FROM ai_chat_messages msg WHERE msg.chat_id = c.id) AS message_count,
           (SELECT GROUP_CONCAT(DISTINCT am.display_name) FROM ai_chat_messages msg
              LEFT JOIN ai_models am ON msg.model_row_id = am.id
              WHERE msg.chat_id = c.id AND msg.model_row_id IS NOT NULL) AS models_used
    FROM ai_chats c
    WHERE c.user_id = ? ${hasFilter ? 'AND c.model_row_id = ?' : ''}
    ORDER BY c.updated_at DESC, c.id DESC
    LIMIT 500
  `).all(...(hasFilter ? [1, modelRowId] : [1]));
  ok(res, chats);
}));

// 更新会话配置（会话级模型 / 上下文窗口）body: { model_row_id?, context_limit?, temperature?, frequency_penalty?, presence_penalty?, search_enabled?, thinking_level?, censored_words? }
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
  if (req.body?.search_enabled !== undefined) {
    updates.push('search_enabled = ?');
    params.push(req.body.search_enabled ? 1 : 0);
  }
  if (req.body?.search_strategy !== undefined) {
    const s = String(req.body.search_strategy).trim().substring(0, 20);
    if (['turbo', 'max'].includes(s)) {
      updates.push('search_strategy = ?');
      params.push(s);
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
    SELECT c.id, c.model_row_id, m.model_id, m.max_context, p.base_url, p.api_key, p.proxy_enabled, p.proxy_host, p.proxy_port
    FROM ai_chats c JOIN ai_models m ON m.id = c.model_row_id JOIN ai_providers p ON p.id = m.provider_id
    WHERE c.id = ?
  `).get(id);
  if (!row) return fail(res, 404, '对话或模型不存在');
  // 若库中已有 max_context，直接使用
  if (row.max_context && row.max_context > 0) {
    db.prepare('UPDATE ai_chats SET context_limit = ? WHERE id = ?').run(row.max_context, id);
    return ok(res, { max_context: row.max_context }, `已填入最大上下文 ${row.max_context}`);
  }
  // 尝试从上游 /models 拉取
  const baseUrl = String(row.base_url || '').replace(/\/+$/, '');
  const url = baseUrl + '/models';
  const dispatcher = row.proxy_enabled && row.proxy_host ? new ProxyAgent(`http://${row.proxy_host}:${row.proxy_port}`) : undefined;
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${row.api_key}`, 'Content-Type': 'application/json' },
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
    const mc = found ? (found.context_length || found.max_context || found.context_window || found.max_tokens || found.contextLength) : null;
    const maxCtx = parseInt(mc);
    if (Number.isInteger(maxCtx) && maxCtx > 0) {
      db.prepare('UPDATE ai_models SET max_context = ? WHERE id = ?').run(maxCtx, row.model_row_id);
      db.prepare('UPDATE ai_chats SET context_limit = ? WHERE id = ?').run(maxCtx, id);
      return ok(res, { max_context: maxCtx }, `已获取并填入最大上下文 ${maxCtx}`);
    }
    return fail(res, 404, '上游未返回该模型的最大上下文，请手动填入');
  } catch (e) {
    let msg = e.message || String(e);
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
  let cwd = AGENT_DEFAULT_CWD;
  const pid = parseInt(req.body?.project_id);
  if (Number.isInteger(pid) && pid > 0) {
    const project = db.prepare('SELECT id, root_path FROM projects WHERE id = ?').get(pid);
    if (!project) return fail(res, 404, '项目不存在');
    projectId = project.id;
    cwd = path.resolve(project.root_path); // 项目会话初始 cwd = 项目根
  }
  const modelRowId = parseInt(req.body?.model_row_id);
  if (!(Number.isInteger(modelRowId) && modelRowId > 0)) return fail(res, 400, '未指定模型');
  if (!db.prepare('SELECT id FROM ai_models WHERE id = ?').get(modelRowId)) return fail(res, 404, '模型不存在');
  const r = db.prepare('INSERT INTO ai_chats (user_id, model_row_id, title, project_id, cwd, plan_mode) VALUES (?, ?, ?, ?, ?, 0)')
    .run(1, modelRowId, title, projectId, cwd);
  const chat = db.prepare('SELECT id, title, project_id, model_row_id FROM ai_chats WHERE id = ?').get(Number(r.lastInsertRowid));
  ok(res, chat);
}));

// 载入对话（含全部消息；用户消息中的图片标记由前端渲染）
router.get('/chats/:id', wrap((req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id < 1) return fail(res, 400, '无效的对话ID');
  const chat = db.prepare(`
    SELECT c.id, c.title, c.model_row_id, c.created_at, c.updated_at, c.context_limit,
           c.project_id, c.cwd, c.plan_mode,
           c.temperature, c.frequency_penalty, c.presence_penalty, c.search_enabled, c.search_strategy, c.thinking_level, c.censored_words,
           LENGTH(c.summary) AS summary_length, m.display_name AS model_name
    FROM ai_chats c JOIN ai_models m ON c.model_row_id = m.id
    WHERE c.id = ? AND c.user_id = ?
  `).get(id, 1);
  if (!chat) return fail(res, 404, '对话不存在');
  const messages = db.prepare(`
    SELECT msg.id, msg.role, msg.content, msg.reasoning, msg.steps_json, msg.created_at, am.display_name AS model_name
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

// 删除对话（级联删除消息）
router.delete('/chats/:id', wrap((req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id < 1) return fail(res, 400, '无效的对话ID');
  const result = db.prepare('DELETE FROM ai_chats WHERE id = ? AND user_id = ?').run(id, 1);
  if (result.changes === 0) return fail(res, 404, '对话不存在');
  ok(res, null, '删除成功');
}));

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
  const filename = String(req.body?.filename || '').trim().replace(/[^\w\u4e00-\u9fff.-]/g, '_');
  if (!raw.trim()) return fail(res, 400, '技能内容不能为空');
  if (raw.length > 200 * 1024) return fail(res, 400, '技能文件过大（上限 200KB）');
  const name = (filename || 'skill').replace(/\.md$/i, '');
  const file = path.join(SKILLS_CUSTOM_DIR, `${name}.md`);
  if (!file.startsWith(SKILLS_CUSTOM_DIR)) return fail(res, 400, '非法文件名');
  fs.mkdirSync(SKILLS_CUSTOM_DIR, { recursive: true });
  fs.writeFileSync(file, raw, 'utf8');
  const parsed = parseSkillFile(file, raw);
  ok(res, { name: parsed.name, file }, `技能「${parsed.name}」已导入`);
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
          const blob = `${st.name || ''} ${JSON.stringify(st.args || '')} ${st.output || ''} ${st.error || ''}`;
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

// 挂件配置写入（白名单字段；大小 0.6–2.5 / 音量 0–1）
router.put('/whale/config', wrap(async (req, res) => {
  const b = req.body || {};
  const next = { ...readWhaleConfig() };
  if (typeof b.scale === 'number' && isFinite(b.scale)) next.scale = Math.min(2.5, Math.max(0.6, b.scale));
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

module.exports = router;
