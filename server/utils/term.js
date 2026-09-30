/**
 * 终端会话层：本地用 node-pty（真 ConPTY），远程用 SSH 的 shell 通道（远端 sshd 分配 PTY）。
 * 两边对上都是同一套接口：open / write / resize / kill / 一条 SSE 输出流。
 *
 * 为什么输出走 SSE、输入走 POST，而不是 WebSocket：这个服务已有的流式通道全是 SSE
 * （聊天、托管、侧栏），再加一个 upgrade 路径要多一套心跳与鉴权假设；本地回环上
 * 「按键 POST + 前端 16ms 合批」的延迟完全够用，代码却只有一条通路。
 *
 * 三条刻意的选择：
 * 1) 每个会话留一段环形输出（默认 200KB）：刷新页面、切走再切回来，看到的是同一场 shell，
 *    而不是一个空白的新 shell —— 用户会以为终端被吃了。
 * 2) node-pty 装不上时本地终端明确报「不可用」，远端终端照常工作（它不依赖 node-pty），
 *    绝不用 child_process 的管道假扮 PTY —— 那种终端 vim/top 一开就散架，比没有更误导。
 * 3) 断开超过 10 分钟才回收：切会话、合上抽屉都不该杀掉正在跑构建的 shell。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db } = require('../database');
const remote = require('./remote');
const procguard = require('./procguard');

const IS_WIN = process.platform === 'win32';
const MAX_BUFFER = 200 * 1024;
const IDLE_KILL_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 12;

let pty = null;
let ptyError = '';
try {
  pty = require('node-pty');
} catch (e) {
  pty = null;
  ptyError = String(e && e.message ? e.message : e).split('\n')[0];
}

/**
 * 把 node-pty 那个必崩的 fork 短路掉。
 *
 * 装机版 desktop.log 里反复刷的 `Error: AttachConsole failed`（栈顶 conpty_console_list_agent.js）
 * 就是它：legacy ConPTY 实现（useConptyDll=false，我们的默认）在 kill() 时要 fork 一个子进程，
 * 由它 AttachConsole 到目标 shell 去列进程树。可我们的后端是 Electron 拉起的**无控制台**进程，
 * AttachConsole 注定失败 —— 子进程当场抛一屏栈，主进程还要空等 5 秒超时才回退成「只杀 shell」。
 *
 * 换 conpty.dll 那条实现实测更糟：PowerShell 起来就退出码 1、一个字节输出都拿不到
 * （见 _tmp_ssh/test_conpty_dll.js 的 dll / legacy 两种跑法）。所以留 legacy，只把这个
 * 列树步骤短路成「只认 shell 自己那个 PID」；整棵进程树改由 procguard.killTree 在关 pty
 * 之前用 taskkill /T /F 收（带镜像复核，比它可靠，也不会往 stderr 扔栈）。
 */
function tameConptyConsoleList() {
  if (!IS_WIN || !pty) return;
  try {
    const Agent = require('node-pty/lib/windowsPtyAgent').WindowsPtyAgent;
    if (!Agent || Agent.prototype.__khConsoleListTamed) return;
    Agent.prototype._getConsoleProcessList = function () {
      return Promise.resolve([this._innerPid]);
    };
    Agent.prototype.__khConsoleListTamed = true;
  } catch (e) {
    // 短路失败不影响开终端，只是关终端时日志会照旧刷栈，所以只记一行不抛
    console.error('[term] node-pty 的 console-list 没能短路：', String(e && e.message || e));
  }
}
tameConptyConsoleList();

const sessions = new Map();   // id -> session

function which(cmd) {
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync(IS_WIN ? 'where' : 'which', [cmd], { encoding: 'utf8', windowsHide: true, timeout: 4000 });
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    return first || '';
  } catch (e) {
    return '';
  }
}

/** 设置里选的默认 Shell（'' = 系统默认） */
function settingShell() {
  try { return (db.prepare("SELECT value FROM settings WHERE key = 'agent_shell'").get()?.value || '').trim(); }
  catch (e) { return ''; }
}

function getSetting(key) {
  try { return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value; }
  catch (e) { return undefined; }
}

/**
 * 终端自己的设置：自定义终端列表（settings.term_custom）。
 * 字体与字号只影响 xterm 怎么画，存在前端 localStorage 里，服务端用不着。
 */
function customTerminals() {
  try {
    const raw = getSetting('term_custom');
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => x && x.name && x.exe) : [];
  } catch (e) { return []; }
}

function saveCustomTerminals(list) {
  const clean = (Array.isArray(list) ? list : [])
    .slice(0, 20)
    .map((x) => ({ id: String(x.id || ('t' + crypto.randomBytes(4).toString('hex'))), name: String(x.name || '').substring(0, 40), exe: expandVars(String(x.exe || '')).substring(0, 500) }))
    .filter((x) => x.name && x.exe);
  try {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('term_custom', JSON.stringify(clean));
  } catch (e) { /* 存不下也不影响本次返回 */ }
  return clean;
}

/** %USERPROFILE%\a\cmd.exe 这种写法要能展开（用户从资源管理器复制的路径常带变量） */
function expandVars(p) {
  return String(p || '').replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, k) => process.env[k] || m).trim();
}

/**
 * 可选的本地终端类型。detected=false 的项前端会置灰（点了也没用），
 * 「跟随设置」这一项就是用户要的「本地时默认用设置中的终端」。
 */
function localShells() {
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const out = [];
  out.push({ id: 'auto', label: '跟随设置里的终端', file: settingShell() || (IS_WIN ? (process.env.COMSPEC || path.join(sysRoot, 'System32\\cmd.exe')) : (process.env.SHELL || '/bin/bash')), detected: true });
  if (IS_WIN) {
    out.push({ id: 'cmd', label: 'CMD', file: process.env.COMSPEC || path.join(sysRoot, 'System32\\cmd.exe'), detected: fs.existsSync(process.env.COMSPEC || path.join(sysRoot, 'System32\\cmd.exe')) });
    const ps5 = path.join(sysRoot, 'System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    out.push({ id: 'powershell', label: 'PowerShell 5', file: ps5, detected: fs.existsSync(ps5) });
    out.push({ id: 'pwsh', label: 'PowerShell 7', file: which('pwsh') || which('pwsh.exe'), detected: !!which('pwsh') });
    const bash = [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'), which('bash')]
      .find((p) => p && fs.existsSync(p));
    out.push({ id: 'gitbash', label: 'Git Bash', file: bash || '', detected: !!bash });
    out.push({ id: 'wsl', label: 'WSL', file: which('wsl') || which('wsl.exe'), detected: !!which('wsl') });
  } else {
    for (const [id, label, bin] of [['bash', 'Bash', 'bash'], ['zsh', 'Zsh', 'zsh'], ['sh', 'Sh', '/bin/sh']]) {
      const f = which(bin) || (fs.existsSync(bin) ? bin : '');
      out.push({ id, label, file: f, detected: !!f });
    }
  }
  for (const c of customTerminals()) {
    // 名字就照用户填的显示（列表顺序已经在系统终端后面，再加个「自定义」后缀只是噪声）
    out.push({ id: c.id, label: c.name, file: c.exe, detected: !!c.exe && fs.existsSync(c.exe), custom: true });
  }
  return out;
}

/**
 * 注册表里的值名是「按字重/字型」一条一条给的（"Consolas Bold Italic"、"Arial 粗体"…），
 * 直接塞进下拉框会把同一个家族拆成四五条。这里只剥字重/斜体这类描述词。
 * 注意不能顺手剥 mono / text / display 这种：JetBrains Mono、DejaVu Sans Mono、Cascadia Mono
 * 被剥掉尾巴就不是同一个家族了，终端字体恰恰最容易踩到。
 */
const STYLE_TAIL = /\s+(bold|italic|oblique|light|extralight|ultralight|thin|hairline|regular|normal|medium|semibold|demibold|extrabold|ultrabold|black|heavy|condensed|narrow|extended|grade|static|dynamic|\d{3})$/i;
const STYLE_TAIL_CN = /\s*(粗体|斜体|细体|常规|标准|中黑|半粗|超粗|黑体|轻体)$/i;
function familyName(raw) {
  let s = String(raw || '').replace(/\s*\((?:TrueType|OpenType|Type ?1)[^)]*\)\s*[;；]?\s*$/i, '').trim();
  for (let i = 0; i < 4; i++) {
    const next = s.replace(STYLE_TAIL, '').replace(STYLE_TAIL_CN, '').trim();
    if (!next || next === s) break;
    s = next;
  }
  return s;
}

/**
 * 系统里装了哪些字体。xterm 只认字体名，字体得由本机提供，所以这份列表从系统读：
 * Windows 读注册表的 Fonts 键（机器 + 用户），Linux 用 fc-list。拿不到就回一份常见等宽兜底，
 * 前端那个下拉允许直接输入，不会因为列表不全而卡住。
 */
function fonts() {
  const set = new Set();
  try {
    if (IS_WIN) {
      const { execFileSync } = require('child_process');
      const decode = (buf) => {
        const utf8 = buf.toString('utf8');
        if (!utf8.includes('\uFFFD')) return utf8;
        // 中文 Windows 上 reg.exe 输出的是 ANSI（GBK）：按 UTF-8 解会糊掉中文字体名，退回 GBK 再解一次
        try { return new TextDecoder('gbk').decode(buf); } catch (e) { return utf8; }
      };
      for (const hive of ['HKLM', 'HKCU']) {
        let text = '';
        try {
          text = decode(execFileSync('reg', ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts`],
            { windowsHide: true, timeout: 6000, maxBuffer: 8 * 1024 * 1024 }));
        } catch (e) { continue; }
        for (const line of text.split(/\r?\n/)) {
          const m = line.trim().match(/^([^ ].*?)\s+REG_[A-Z]+\s/);
          if (!m) continue;
          // 注册表值名形如 "Arial (TrueType)"，也有字体写成 "... (TrueType);"（BIZ 那套就是），
          // 尾巴上的分号与字型词都得去掉，否则下拉里既出现带括号的怪名字、又同一个家族排四五条
          const name = familyName(m[1]);
          if (name) set.add(name);
        }
      }
    } else {
      const { execFileSync } = require('child_process');
      const text = execFileSync('fc-list', [':', 'family'], { encoding: 'utf8', timeout: 6000 });
      for (const line of text.split(/\r?\n/)) for (const fam of line.split(',')) if (fam.trim()) set.add(fam.trim());
    }
  } catch (e) { /* 拿不到字体表不影响终端本身 */ }
  for (const f of ['Consolas', 'Cascadia Code', 'JetBrains Mono', 'Fira Code', 'Menlo', 'Monaco', 'DejaVu Sans Mono', 'Courier New', 'Microsoft YaHei Mono', 'Sarasa Mono SC', 'Noto Sans Mono CJK SC', 'WenQuanYi Micro Hei Mono', 'Liberation Mono']) set.add(f);
  return [...set].sort((a, b) => a.localeCompare(b));
}

function shellFileFor(shellId) {
  const list = localShells();
  const hit = list.find((s) => s.id === (shellId || 'auto')) || list[0];
  return hit;
}

function push(s, chunk) {
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
  s.bytes += buf.length;
  s.chunks.push(buf);
  let total = s.chunks.reduce((n, c) => n + c.length, 0);
  while (total > MAX_BUFFER && s.chunks.length > 1) {
    const drop = s.chunks.shift();
    total -= drop.length;
  }
  for (const res of s.subs) {
    try { res.write(`data: ${JSON.stringify({ t: 'out', data: buf.toString('base64') })}\n\n`); } catch (e) { /* 客户端走了 */ }
  }
}

function emit(s, obj) {
  for (const res of s.subs) {
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) { /* 同上 */ }
  }
}

function touch(s) {
  s.lastSeen = Date.now();
}

function kill(id, note) {
  const s = sessions.get(String(id));
  if (!s) return false;
  sessions.delete(String(id));
  s.alive = false;
  // 顺序有讲究：趁 shell 还活着先 taskkill /T 收整棵树（树关系是挂在活进程上的），
  // 完事再关 pty 句柄。反过来做的话父进程一没，/T 就找不到那些子进程了。
  const pid = s.proc && s.proc.pid;
  const closePty = () => { try { if (s.proc && s.proc.kill) s.proc.kill(); } catch (e) { /* 已退 */ } };
  if (pid) {
    procguard.killTree(pid).then(closePty).catch(closePty);
    // killTree 走不到（比如镜像复核没过）时也不能把 pty 一直挂着：1.5 秒兜底关掉
    setTimeout(closePty, 1500);
  } else {
    closePty();
  }
  try { if (s.stream && s.stream.end) s.stream.end(); } catch (e) { /* 已退 */ }
  emit(s, { t: 'exit', code: s.exitCode == null ? null : s.exitCode, note: note || '' });
  for (const res of s.subs) { try { res.end(); } catch (e) { /* 收尾 */ } }
  s.subs.clear();
  return true;
}

function shutdownAll() {
  for (const id of [...sessions.keys()]) kill(id, '服务退出');
}

function list() {
  return [...sessions.values()].map((s) => ({
    id: s.id, title: s.title, kind: s.kind, shell: s.shellLabel, host: s.hostName || '',
    cwd: s.cwd || '', alive: s.alive, exit_code: s.exitCode, bytes: s.bytes, clients: s.subs.size,
  }));
}

/**
 * 开一个终端会话。
 * kind=local：shell 可以是 localShells() 里的 id（auto/cmd/pwsh/gitbash…）
 * kind=remote：host_id 指定用哪条 SSH 连接，PTY 在远端
 */
async function open(opts = {}) {
  if (sessions.size >= MAX_SESSIONS) throw new Error(`终端会话最多同时 ${MAX_SESSIONS} 个，先关掉几个再开`);
  const id = crypto.randomBytes(6).toString('hex');
  const cols = Math.min(Math.max(parseInt(opts.cols) || 100, 20), 400);
  const rows = Math.min(Math.max(parseInt(opts.rows) || 28, 6), 120);
  const s = {
    id, kind: opts.kind === 'remote' ? 'remote' : 'local', chunks: [], bytes: 0, subs: new Set(),
    alive: true, exitCode: null, lastSeen: Date.now(), cwd: String(opts.cwd || ''), title: '',
    proc: null, stream: null, shellLabel: '', hostName: '',
  };

  if (s.kind === 'remote') {
    const host = db.prepare('SELECT * FROM ai_remote_hosts WHERE id = ?').get(Number(opts.host_id));
    if (!host) throw new Error('远程连接不存在');
    s.hostName = `${host.username}@${host.host}`;
    s.shellLabel = 'SSH';
    s.title = host.name;
    const stream = await remote.openShell(host, { cols, rows });
    s.stream = stream;
    stream.on('data', (c) => push(s, c));
    stream.stderr && stream.stderr.on('data', (c) => push(s, c));
    stream.on('close', (code) => { s.exitCode = typeof code === 'number' ? code : null; s.alive = false; emit(s, { t: 'exit', code: s.exitCode }); });
    stream.on('error', (e) => { s.alive = false; emit(s, { t: 'exit', code: null, note: remote.describeError(e) }); });
    sessions.set(id, s);
    return s;
  }

  if (!pty) throw new Error(`本机终端不可用（node-pty 没装好：${ptyError || '未知原因'}）。远端终端不受影响。`);
  const hit = shellFileFor(opts.shell);
  if (!hit.detected || !hit.file) throw new Error(`没找到 ${hit.label}，换一个终端类型`);
  s.shellLabel = hit.label;
  s.title = hit.label;
  const cwd = s.cwd && fs.existsSync(s.cwd) ? s.cwd : process.cwd();
  const shellArgs = hit.id === 'gitbash' || hit.id === 'bash' || hit.id === 'zsh' ? [] : [];
  const proc = pty.spawn(hit.file, shellArgs, {
    name: 'xterm-256color', cols, rows, cwd,
    env: Object.assign({}, process.env, { TERM: 'xterm-256color', COLORTERM: 'truecolor' }),
  });
  s.proc = proc;
  // 登记给 procguard：关标签时要靠它 taskkill /T 收掉 shell 下面起的子进程（node-pty 自己那套见文件头）
  try { procguard.claim(proc.pid, path.basename(hit.file), `terminal:${id}`); } catch (e) { /* 登记不上就退回只杀 shell */ }
  proc.onData((d) => push(s, d));
  proc.onExit((e) => {
    s.exitCode = e.exitCode; s.alive = false;
    try { procguard.release(proc.pid); } catch (err) { /* 已释放 */ }
    emit(s, { t: 'exit', code: e.exitCode });
  });
  sessions.set(id, s);
  return s;
}

/** 改标签名（用户在 tty 标签上右键「改名」）；空标题不覆盖原值 */
function setTitle(id, title) {
  const s = sessions.get(String(id));
  if (!s) return false;
  const t = String(title || '').replace(/[\r\n]/g, ' ').trim().substring(0, 40);
  if (t) s.title = t;
  touch(s);
  return true;
}

/** 终端输出里全是 CSI/OSC 控制序列，导出成日志前要剥掉 */
function stripAnsi(text) {
  return String(text || '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')      // OSC … BEL/ST
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[P\^\]_][^\x1b]*(\x1b\\)?/g, '')         // DCS/SOS/SCI/PM/APC
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, '')             // CSI
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[@-Z\\-_]/g, '')                          // 单字符转义
    .replace(/\r\n/g, '\n')                                 // 终端用 CR LF，日志留 LF
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

/** 会话当前的输出文本（环形缓冲里的部分，最多 200KB）；clean=false 时保留原始转义 */
function dump(id, clean = true) {
  const s = sessions.get(String(id));
  if (!s) return null;
  const raw = Buffer.concat(s.chunks).toString('utf8');
  return clean ? stripAnsi(raw) : raw;
}

/**
 * 归档：把这份日志落到数据目录 .kh-term/ 下，再丢进系统回收站，然后关掉这个 tty。
 * 用户要的「归档」不是留一堆没人看的文件，而是「内容还能捞回来，但标签别占着」——
 * 回收站就是本机最顺手的捞回入口。
 * 目录跟着数据目录走：装机版装在 Program Files 时程序根目录只读，写不进去。
 */
async function archive(id) {
  const s = sessions.get(String(id));
  if (!s) throw new Error('终端会话不存在（可能已经被回收）');
  const text = dump(id) || '';
  if (!text.trim()) throw new Error('这个终端还没有输出，没什么可归档的');
  const dir = path.join(require('../config').DATA_DIR, '.kh-term');
  fs.mkdirSync(dir, { recursive: true });
  const safe = (s.title || s.kind || 'term').replace(/[\\/:*?"<>|]/g, '_').substring(0, 30);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const file = path.join(dir, `${safe}-${stamp}.log.txt`);
  fs.writeFileSync(file, text, 'utf8');
  let where = file;
  try {
    const recycle = require('./recycle');
    await recycle.moveToRecycle(file);
    where = '回收站';
  } catch (e) {
    where = file;   // 回收站 API 失败也别把内容丢了：文件留在 .kh-term/ 里
  }
  kill(id, '已归档');
  return { file, where, bytes: Buffer.byteLength(text, 'utf8') };
}

function write(id, data) {
  const s = sessions.get(String(id));
  if (!s || !s.alive) return false;
  touch(s);
  const text = Buffer.from(String(data || ''), 'base64').toString('utf8');
  if (s.proc) s.proc.write(text);
  else if (s.stream) s.stream.write(text);
  return true;
}

function resize(id, cols, rows) {
  const s = sessions.get(String(id));
  if (!s || !s.alive) return false;
  touch(s);
  const c = Math.min(Math.max(parseInt(cols) || 100, 20), 400);
  const r = Math.min(Math.max(parseInt(rows) || 28, 6), 120);
  try {
    if (s.proc) s.proc.resize(c, r);
    else if (s.stream && s.stream.setWindow) s.stream.setWindow(r, c, 0, 0);
  } catch (e) { /* 窗口还没来得及建好，下一次再试 */ }
  return true;
}

/** 挂一条 SSE：先把缓冲的尾巴补上（刷新页面看到的是同一场 shell），再跟直播 */
function attach(id, res) {
  const s = sessions.get(String(id));
  if (!s) return false;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`data: ${JSON.stringify({ t: 'hello', id: s.id, replay_bytes: s.bytes, alive: s.alive })}\n\n`);
  if (s.chunks.length) {
    res.write(`data: ${JSON.stringify({ t: 'out', data: Buffer.concat(s.chunks).toString('base64') })}\n\n`);
  }
  if (!s.alive) {
    res.write(`data: ${JSON.stringify({ t: 'exit', code: s.exitCode })}\n\n`);
    res.end();
    return true;
  }
  s.subs.add(res);
  touch(s);
  res.on('close', () => { s.subs.delete(res); touch(s); });
  return true;
}

// 没人看太久的 shell 回收；正在跑的构建一般活不过这个窗口，用户切回来就该是新会话了
const reaper = setInterval(() => {
  const now = Date.now();
  for (const s of [...sessions.values()]) {
    if (!s.alive) { if (now - s.lastSeen > 60000) kill(s.id, '已退出'); continue; }
    if (s.subs.size === 0 && now - s.lastSeen > IDLE_KILL_MS) kill(s.id, '超过 10 分钟无人查看，已回收');
  }
}, 60000);
if (reaper.unref) reaper.unref();

// SSE 心跳：中间层（或浏览器自己的空闲判定）不会把长连接掐了
setInterval(() => {
  for (const s of sessions.values()) {
    for (const res of s.subs) { try { res.write(': ping\n\n'); } catch (e) { s.subs.delete(res); } }
  }
}, 15000).unref();

module.exports = {
  open, write, resize, kill, attach, list, localShells, shellFileFor, shutdownAll,
  fonts, customTerminals, saveCustomTerminals, setTitle, dump, archive,
  info: () => ({ pty: !!pty, ptyError, max: MAX_SESSIONS }),
};
