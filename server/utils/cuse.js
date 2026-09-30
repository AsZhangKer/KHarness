// Computer Use 引擎路由：把「操作这台电脑」的 cu_* 工具落到两条引擎之一上。
//
//   netwright（上位，需用户自装）—— 后台 UIA 操作，不抢鼠标，.NET/WinUI 应用最准。
//   coords（兜底，随包发）—— PowerShell 守护进程走 user32 SendInput + UIA-lite，
//            任何 Windows 软件都能点，代价是会抢鼠标、按屏幕物理像素坐标操作。
//
// 为什么要一个常驻 PowerShell 进程而不是每次动作起一个：一次 powershell 冷启动 ~300ms，
// 一次动作再截屏再等就没人受得了；常驻进程把 Add-Type 的编译成本只付一次，
// stdin/stdout 行 JSON 收发，动作延迟回到个位毫秒。
//
// 权限口径（全部落在 ai.js 的审批判定里，这里只提供 hasGrant / isHighPrivilege 需要的信息）：
//   用户批准某个进程/窗口 = 该目标内后续所有动作都免审批；
//   免除审批模式下也必须先手动放行一次目标；
//   「全部开放」开启后整屏截图和一切操作免审批（危险，重启后弹窗提醒）。
const { spawn, execFile, execFileSync } = require('child_process');
const readline = require('readline');
const path = require('path');
const fs = require('fs');
const os = require('os');
const toolgate = require('./toolgate');
const inapp = require('./inapp');
const perms = require('./permissions');   // 预置黑名单后要 reload，否则规则缓存不认新条目
const { db } = require('../database');

const DAEMON_SCRIPT = path.join(__dirname, 'cudaemon.ps1');
const DAEMON_START_TIMEOUT = 15000;   // PowerShell 冷启动 + Add-Type 编译
const DAEMON_CALL_TIMEOUT = 20000;
const NETWRIGHT_ID = '__netwright__';

/**
 * 这一整组工具只有 Windows 有底层支撑：坐标引擎是常驻 PowerShell（user32 SendInput +
 * System.Windows.Automation），netwright 也是 .NET 的 Windows 桌面自动化。
 * Linux/macOS 上不是「降级能用」，是**根本没有那条路**，所以：
 * 守护进程不起、netwright 不探、每个工具直接给拒绝理由、实验室开关不给打开。
 * 判定只在这一个常量上，别散到各处各判一次。
 */
const SUPPORTED = process.platform === 'win32';
const NOT_SUPPORTED = 'Computer Use 目前只在 Windows 上可用：坐标引擎依赖 PowerShell + Win32 SendInput + UIA，'
  + '上位引擎 netwright 也是 Windows 桌面自动化。Linux / macOS 版本里这组工具不会工作，'
  + '请改用文件、命令、浏览器、SSH 这些跨平台工具完成同样的事。';
function supported() { return SUPPORTED; }

function getSetting(key, def) {
  try {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return r && r.value != null ? r.value : (def === undefined ? '' : def);
  } catch (e) { return def === undefined ? '' : def; }
}
function setSetting(key, val) {
  try {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP')
      .run(key, String(val));
    return true;
  } catch (e) { return false; }
}
function boolSetting(key) { return getSetting(key, '0') === '1'; }

// 引擎偏好：auto = 装了 netwright 就用它、必要时降级；coords 强制坐标；netwright 强制上位。
function enginePref() {
  const v = getSetting('computer_engine', 'auto');
  return (v === 'coords' || v === 'netwright') ? v : 'auto';
}

/* ============================ 授权（进程/窗口粒度） ============================ */

function ensureGrantTable() {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS cu_grants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL DEFAULT 0,
      pid INTEGER,
      exe TEXT,
      title TEXT,
      scope TEXT NOT NULL DEFAULT 'process',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`).run();
  } catch (e) { /* 表不可用按无授权处理 */ }
}

// 一条授权描述「哪个目标被放行」。三选一即可：pid / exe / title（title 作子串匹配）。
// 为什么允许 exe 粒度：进程会重启换 pid，用 exe 才能「放行记事本一次，之后新开也认」。
function grantMatchesWindow(g, w) {
  if (!g || !w) return false;
  if (g.pid != null && Number(g.pid) === Number(w.pid)) return true;
  if (g.exe && String(w.exe || '').toLowerCase() === String(g.exe).toLowerCase()) return true;
  if (g.title && String(w.title || '').toLowerCase().includes(String(g.title).toLowerCase())) return true;
  return false;
}

function grantsFor(chatId) {
  ensureGrantTable();
  try {
    return db.prepare('SELECT * FROM cu_grants WHERE chat_id = ? OR chat_id = 0 ORDER BY id DESC').all(Number(chatId) || 0);
  } catch (e) { return []; }
}

function hasGrant(chatId, win) {
  if (isOpenAll()) return true;
  if (!win) return false;
  return grantsFor(chatId).some((g) => grantMatchesWindow(g, win));
}

function addGrant(chatId, t) {
  ensureGrantTable();
  const pid = Number(t.pid) || null;
  const exe = t.exe ? String(t.exe).slice(0, 200) : null;
  const title = t.title ? String(t.title).slice(0, 200) : null;
  if (!pid && !exe && !title) return { error: '授权目标至少要给出 pid、exe 或 title 之一' };
  try {
    db.prepare('INSERT INTO cu_grants (chat_id, pid, exe, title, scope) VALUES (?, ?, ?, ?, ?)')
      .run(Number(chatId) || 0, pid, exe, title, t.scope || 'process');
    return { ok: true };
  } catch (e) { return { error: String((e && e.message) || e) }; }
}

function removeGrant(id) {
  ensureGrantTable();
  try { db.prepare('DELETE FROM cu_grants WHERE id = ?').run(Number(id)); return { ok: true }; }
  catch (e) { return { error: String((e && e.message) || e) }; }
}

// 急停：清空所有授权（跨会话），记一条时间戳供 UI 显示「已急停」。
function emergencyStop(reason) {
  ensureGrantTable();
  try { db.prepare('DELETE FROM cu_grants').run(); } catch (e) { /* 忽略 */ }
  setSetting('cu_last_stop_ts', String(Date.now()));
  setSetting('cu_last_stop_reason', String(reason || ''));
  // 急停同时把「全部开放」关掉：这是用户按下急停最直接的含义——立刻收回一切自动放行。
  setSetting('computer_open_all', '0');
  applyHotkeyToDaemon();   // 让守护进程也进入待命（钩子仍在，但授权已空）
  broadcastStop();          // 手动急停也要推给其它开着的面板，和快捷键按下同一条通知路径
  return { ok: true, stopped_at: Date.now(), reason: reason || '' };
}

function isOpenAll() { return boolSetting('computer_open_all'); }
function isEnabled() { return boolSetting('computer_use_enabled'); }

/* ============================ PowerShell 守护进程 ============================ */

let daemon = null;   // { child, rl, nextId, pending:Map, ready, startErr }
// 重启限流：一分钟窗口内最多重开 3 次，超过就不再管（界面会显示「坐标引擎没在跑」）。
let restarts = { n: 0, since: 0 };
function armDaemonRestart() {
  const now = Date.now();
  if (now - restarts.since > 60000) restarts = { n: 0, since: now };
  if (restarts.n >= 3) return;
  restarts.n++;
  setTimeout(() => {
    if (daemonAlive()) return;
    spawnDaemon();
    applyHotkeyToDaemon();   // 钩子跟着进程一起没了，重开之后必须重新装
  }, 1500);
}

function spawnDaemon() {
  if (daemon && daemon.child && !daemon.child.killed) return daemon;
  if (!SUPPORTED) {
    // Linux/macOS：不要去 spawn powershell.exe（那会留下一条谁也看不懂的 ENOENT）
    daemon = { child: null, ready: false, startErr: NOT_SUPPORTED };
    return daemon;
  }
  if (!fs.existsSync(DAEMON_SCRIPT)) {
    daemon = { child: null, ready: false, startErr: `找不到坐标引擎脚本 ${DAEMON_SCRIPT}` };
    return daemon;
  }
  const child = spawn('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', DAEMON_SCRIPT],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const s = { child, rl: null, nextId: 1, pending: new Map(), ready: false, startErr: '', stderrTail: '' };
  daemon = s;
  s.rl = readline.createInterface({ input: child.stdout });
  s.rl.on('line', (line) => {
    const t = String(line || '').trim();
    if (!t || t[0] !== '{') return;
    let msg; try { msg = JSON.parse(t); } catch (e) { return; }
    if (msg.ev === 'hotkey') { emergencyStop('hotkey'); broadcastStop(); return; }
    if (msg.ev === 'bye') { for (const w of s.pending.values()) w.reject(new Error('坐标引擎已退出')); s.pending.clear(); return; }
    const w = s.pending.get(msg.id);
    if (!w) return;
    clearTimeout(w.timer);
    s.pending.delete(msg.id);
    if (msg.ok) w.resolve(msg.data);
    else w.reject(new Error(msg.error || '坐标引擎返回失败'));
  });
  child.stderr.on('data', (b) => { s.stderrTail = (s.stderrTail + b.toString('utf8')).slice(-1200); });
  child.on('exit', (code) => {
    s.ready = false;
    for (const w of s.pending.values()) { clearTimeout(w.timer); w.reject(new Error(`坐标引擎进程退出 code=${code}`)); }
    s.pending.clear();
    if (daemon === s) daemon = null;
    // 急停快捷键就挂在这个进程里：它一死，用户按什么键都停不下来，所以开关还开着就把它重开。
    // 但要设上限：万一这台机器上 powershell 起来就退（组策略 / 安装损坏），无脑重启会把 CPU 吃满。
    if (isEnabled() && getSetting('computer_hotkey', '')) armDaemonRestart();
  });
  return s;
}

// 行 JSON 协议：一个 id 对应一次往返。ready 之前所有请求先并发跑 ping 探活。
function daemonCall(cmd, args, timeoutMs = DAEMON_CALL_TIMEOUT) {
  const s = spawnDaemon();
  if (!s || !s.child) return Promise.reject(new Error(s && s.startErr || '坐标引擎不可用'));
  const id = s.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      s.pending.delete(id);
      reject(new Error(`坐标引擎 ${cmd} 超时 ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    s.pending.set(id, { resolve, reject, timer });
    try { s.child.stdin.write(JSON.stringify({ id, cmd, args: args || {} }) + '\n'); }
    catch (e) { clearTimeout(timer); s.pending.delete(id); reject(e); }
  });
}

function daemonAlive() { return !!(daemon && daemon.child && !daemon.child.killed); }

/* ============================ netwright（上位引擎，可选） ============================ */

const net = { status: 'unknown', error: '', tools: [], child: null, rl: null, nextId: 1, pending: new Map(), serverInfo: null, via: '' };

/**
 * dotnet 全局工具在 Windows 上的真实落盘形状（本机实测）：
 *   ~/.dotnet/tools/netwright.cmd                 ← PATH 上只有这个转发脚本
 *   ~/.dotnet/tools/.store/netwright/2.0.0/netwright.win-x64/2.0.0/tools/any/win-x64/netwright.exe ← 真身
 * 而 Node 直接 spawn 一个 .cmd 在打了安全补丁的版本上是 EINVAL；`which netwright`（git bash）
 * 也不认 .cmd 后缀 —— 所以第一版探测「找了 netwright / dnx 两个名字」全部落空。
 * 探测该做的事是**把那个 exe 挖出来**，而不是猜命令名。
 */
function resolveShimToExe(cmdPath) {
  try {
    const txt = fs.readFileSync(cmdPath, 'utf8');
    const m = /"([^"]*netwright\.exe)"/i.exec(txt);
    if (!m) return null;
    let p = m[1].replace(/^%~dp0/i, path.dirname(cmdPath) + path.sep);
    if (p.includes('%')) return null;                 // 还有没认出来的变量：不猜
    const fix = p.replace(/\//g, path.sep);
    return fs.existsSync(fix) ? fix : null;
  } catch (e) { return null; }
}

function findStoreExe(root) {
  // .store 下面版本号/rid 好几层，限定深度，别拿去扫整个盘
  const hits = [];
  const step = (dir, depth) => {
    if (depth > 6 || hits.length) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) step(p, depth + 1);
      else if (/^netwright\.exe$/i.test(ent.name)) hits.push(p);
    }
  };
  step(root, 0);
  return hits;
}

function netwrightCandidates() {
  const found = [];
  // ① PATH 上问一行：必须用 where.exe（它认 PATHEXT，PowerShell/Node 起的进程都走这套）
  try {
    const out = execFileSync('where.exe', ['netwright'], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of String(out || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      if (/\.exe$/i.test(line)) { if (fs.existsSync(line)) found.push(line); continue; }
      const real = resolveShimToExe(line);
      if (real) found.push(real);
    }
  } catch (e) { /* PATH 上没有，继续翻固定目录 */ }
  // ② 全局工具目录（DOTNET_TOOLS 可改）
  const toolDir = process.env.DOTNET_TOOLS || path.join(process.env.USERPROFILE || os.homedir(), '.dotnet', 'tools');
  const shim = path.join(toolDir, 'netwright.cmd');
  if (fs.existsSync(shim)) { const real = resolveShimToExe(shim); if (real) found.push(real); }
  const exes = findStoreExe(path.join(toolDir, '.store', 'netwright'));
  for (const e of exes) found.push(e);
  return [...new Set(found)];
}

// netwright 的 MCP 握手：spawn 后发 initialize，成功即认为装了。
// 不复用 mcp.js：那层会把 server 的 15 个工具 register 进 toolgate，直接透出给模型，
// 而这里要的是「只暴露我们自定义的 cu_* 名字」，所以自带一个极简 stdio 客户端。
function netwrightProbe(cb) {
  // 已经在跑就别再探测一遍：点「重新检测」会反复进来，每次都 spawn 一个新的 netwright，
  // 上一个 net.child 被直接盖掉就成了杀不掉的孤儿（它带着 UIA 连接，占着目标应用）。
  if (netLive()) { if (cb) cb(true); return; }
  if (!SUPPORTED) { net.status = 'unsupported'; net.error = NOT_SUPPORTED; if (cb) cb(false); return; }
  if (net.child) { try { net.child.kill(); } catch (e) { /* 已退出 */ } net.child = null; net.rl = null; }
  net.status = 'unknown';
  // 挖到的 exe 逐个试，最后再退到 `dnx Netwright --yes`（dotnet-scope 跑，慢但不用找路径）
  const specs = netwrightCandidates().map((exe) => ({ file: exe, args: [], label: exe }));
  specs.push({ file: 'dnx', args: ['Netwright', '--yes'], label: 'dnx Netwright --yes' });
  let i = 0;
  const tried = [];
  function next() {
    if (i >= specs.length) {
      net.status = 'absent';
      net.error = `没找到 netwright（试过：${tried.join(' | ')}）。将全程使用坐标引擎。想启用上位引擎：dotnet tool install -g Netwright`;
      return cb(false);
    }
    const spec = specs[i++];
    tried.push(path.basename(spec.label));
    let child;
    try {
      child = spawn(spec.file, spec.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { return next(); }
    let settled = false;
    const rl = readline.createInterface({ input: child.stdout });
    const kill = () => { try { child.kill(); } catch (e) { /* 忽略 */ } try { rl.close(); } catch (e) { /* 忽略 */ } };
    // exe 的握手本机实测 179ms；dnx 要现场解析/编译，给到 20 秒才不误杀
    const limit = spec.file === 'dnx' ? 20000 : 8000;
    const fail = (why) => { if (settled) return; settled = true; net.lastError = why; kill(); next(); };
    child.on('error', () => fail('spawn 失败'));
    child.on('exit', () => fail('进程提前退出'));
    const send = (obj) => { try { child.stdin.write(JSON.stringify(obj) + '\n'); } catch (e) { /* 忽略 */ } };
    const to = setTimeout(() => fail(`握手超时 ${limit}ms`), limit);
    rl.on('line', (line) => {
      if (net.status === 'live' && net.rl === rl) return netOnLine(line);
      const t = String(line || '').trim();
      if (!t || t[0] !== '{') return;
      let m; try { m = JSON.parse(t); } catch (e) { return; }
      if (m.id === 1) {
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      } else if (m.id === 2) {
        if (settled) return;
        settled = true;
        clearTimeout(to);
        net.status = 'live';
        net.error = '';
        net.via = spec.label;
        net.child = child; net.rl = rl;
        net.serverInfo = (m.result && m.result.serverInfo) || null;
        net.tools = ((m.result && m.result.tools) || []).map((x) => x.name);
        net.pending.clear();
        setSetting('computer_netwright_present', '1');
        cb(true);
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'KHarness', version: '1.0.0' } } });
  }
  next();
}

function netLive() { return net.status === 'live' && net.child && !net.child.killed; }

function netCall(tool, args, timeoutMs = 60000) {
  if (!netLive()) return Promise.reject(new Error('netwright 不在线'));
  const id = net.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { net.pending.delete(id); reject(new Error(`netwright ${tool} 超时`)); }, timeoutMs);
    net.pending.set(id, { resolve, reject, timer, tool });
    try { net.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: args || {} } }) + '\n'); }
    catch (e) { clearTimeout(timer); net.pending.delete(id); reject(e); }
  });
}

function netOnLine(line) {
  const t = String(line || '').trim();
  if (!t || t[0] !== '{') return;
  let m; try { m = JSON.parse(t); } catch (e) { return; }
  if (m.id == null) return;
  const w = net.pending.get(m.id);
  if (!w) return;
  clearTimeout(w.timer);
  net.pending.delete(m.id);
  if (m.error) w.reject(new Error(m.error.message || JSON.stringify(m.error).slice(0, 300)));
  // MCP 里「工具自己失败」不走 JSON-RPC 的 error，而是 result.isError=true + 文本里带错误码。
  // 不判这一层的话，STALE_REF / NEEDS_FOREGROUND / NO_APP 会被当成调用成功原样喂给模型，
  // 于是既不会重试也不会降级到坐标引擎（实测 netwright 的错误码就写在 content.text 里）。
  else if (m.result && m.result.isError) w.reject(new Error(flattenNetResult(m.result) || `netwright ${w.tool || ''} 执行失败`));
  else w.resolve(flattenNetResult(m.result));
}

function flattenNetResult(r) {
  if (!r) return '';
  if (Array.isArray(r.content)) return r.content.map((c) => (c && c.text) ? c.text : (c && c.type === 'image' ? '[图片]' : '')).join('\n');
  return String(r.text || JSON.stringify(r).slice(0, 500));
}

// 只有「netwright 压根管不了这个目标」才降级，判据用它文档里的错误码（TOOLS_REFERENCE 的 Error codes）。
// 只标这一个目标，不翻转全局。注意不要拿 STALE_REF / AMBIGUOUS_SELECTOR / ELEMENT_NOT_FOUND
// 这类「模型参数用错了」当降级依据 —— 那会把一个好端端的目标永久打成坐标模式。
const DEGRADE_RE = /NOT_ALLOWED|APP_NOT_RESPONDING|not a \.NET|unsupported|no ui automation|cannot be automated|does not expose/i;
const degradedTargets = new Map();   // targetKey -> reason
function targetKey(t) { return String((t && (t.hwnd || t.pid || t.exe || t.title)) || 'global'); }

/* ============================ 坐标引擎的高层动作 ============================ */

async function resolveTargetWindow(t) {
  // 有 hwnd 直接用；否则按 pid/exe/title 找前台或第一个匹配窗口。
  const list = await daemonCall('windows');
  const wins = (list && list.list) || [];
  let hit = null;
  if (t && t.hwnd) hit = wins.find((w) => Number(w.hwnd) === Number(t.hwnd)) || null;
  if (!hit && t && t.pid) hit = wins.find((w) => Number(w.pid) === Number(t.pid)) || null;
  if (!hit && t && t.exe) hit = wins.find((w) => String(w.exe || '').toLowerCase() === String(t.exe).toLowerCase()) || null;
  if (!hit && t && t.title) hit = wins.find((w) => String(w.title || '').toLowerCase().includes(String(t.title).toLowerCase())) || null;
  if (!hit) hit = wins.find((w) => w.foreground) || null;
  // 只给了 hwnd 的目标补上 pid/exe：授权是按 pid/exe 记的（hwnd 每次开窗口都变），
  // netwright 也必须有 pid 才能 attach。不补就会「同一窗口放行过还要再问一次」。
  if (hit && t) {
    if (!t.pid && hit.pid) t.pid = Number(hit.pid);
    if (!t.exe && hit.exe) t.exe = String(hit.exe);
  }
  return hit;
}

/* ============================ 工具定义 ============================ */

// 只读类：cu_status / cu_windows / cu_snapshot / cu_find / cu_screenshot（截图仍算高权限，见 isHighPrivilege）
// 修改类：cu_click / cu_drag / cu_type / cu_key / cu_scroll / cu_activate / cu_close_window / cu_launch
// provider/category 固定，方便设置页与轨迹卡归类；hide 让 toolgate 不在「工具」页列出它们。
const GROUP = { kind: 'builtin', provider: 'Computer Use', category: '电脑操作', source: 'netwright / PowerShell 坐标引擎', doc: '—', cost: '不消耗积分', hide: true };

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function parseTarget(args) {
  const t = {};
  if (args.hwnd) t.hwnd = num(args.hwnd, 0);
  if (args.pid) t.pid = num(args.pid, 0);
  if (args.exe) t.exe = String(args.exe);
  if (args.title) t.title = String(args.title);
  return t;
}

// netwright 的一切操作都要求先有 Target App（desktop_app action=attach|launch），参数名是 `process`
// （它接受 pid、进程名或窗口标题片段，不是 `pid`）。不先挂就调 snapshot/click 会拿回 NO_APP。
const attachedPids = new Set();
async function ensureAttached(t) {
  const pid = Number(t && t.pid) || 0;
  if (!pid) return null;                       // 没给 pid：让 netwright 用它当前挂着的那个
  if (attachedPids.has(pid)) return null;      // 挂过就别每次动作重挂
  try {
    await netCall('desktop_app', { action: 'attach', process: String(pid) });
    attachedPids.add(pid);
    return null;
  } catch (e) {
    const msg = String((e && e.message) || e);
    // 挂不上多半就是它管不了这个进程（非 .NET / 进程已退出 / 不在 --allow 名单里）
    if (/NO_APP|NOT_ALLOWED|not a \.NET|unsupported|exited|attach/i.test(msg)) {
      degradedTargets.set(targetKey(t), `attach 失败：${msg.slice(0, 200)}`);
      return { degraded: true, why: msg };
    }
    return { error: msg };
  }
}

function netUsable(t) {
  return enginePref() !== 'coords' && netLive() && !degradedTargets.has(targetKey(t));
}

/**
 * ref 属于哪个引擎就回哪个引擎。
 * netwright 的 ref 来自它的 desktop_snapshot，坐标引擎的 ref 来自守护进程的 UIA 遍历，
 * 两套编号毫无关系 —— 拿 netwright 快照里的 e17 去点坐标引擎，只会得到一句 stale ref。
 * 所以记下「这个目标上一次快照出自谁」，ref 类动作按它路由。
 */
const lastSnapshotEngine = new Map();   // targetKey -> 'netwright' | 'coords'
function rememberSnapshot(t, via) { lastSnapshotEngine.set(targetKey(t), via); }

function engineForRef(t) {
  const last = lastSnapshotEngine.get(targetKey(t));
  if (last === 'coords') return 'coords';
  if (last === 'netwright') return 'netwright';
  return netUsable(t) ? 'netwright' : 'coords';
}

const NEEDS_FOREGROUND_RE = /NEEDS_FOREGROUND|foreground/i;

// 调 netwright 一个工具；NEEDS_FOREGROUND 按它文档的说法带 foreground:true 重试一次（那是它自己的真鼠标路径）。
// 失败时返回 {error} / {degraded}，成功返回 {output}，调用方据此决定要不要落到坐标。
async function netTry(tool, args, t) {
  if (!netUsable(t)) return { skip: true };
  const at = await ensureAttached(t);
  if (at && at.degraded) return { degraded: true, why: at.why };
  if (at && at.error) return { error: at.error };
  try {
    return { output: await netCall(tool, args) };
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (NEEDS_FOREGROUND_RE.test(msg) && args && args.foreground !== true) {
      try { return { output: await netCall(tool, { ...args, foreground: true }), foreground: true }; }
      catch (e2) { return { error: String((e2 && e2.message) || e2) }; }
    }
    if (DEGRADE_RE.test(msg)) {
      degradedTargets.set(targetKey(t), msg.slice(0, 200));
      return { degraded: true, why: msg };
    }
    if (/STALE_REF|ELEMENT_NOT_FOUND|AMBIGUOUS_SELECTOR|INVALID_SELECTOR|NOT_ACTIONABLE|NOT_SUPPORTED|EXPECTATION_FAILED/i.test(msg)) {
      return { error: msg };     // 用法错误，不是引擎不行：不降级，原话回给模型改参数
    }
    return { error: msg };
  }
}

// 统一入口：wantNet=false 时直接走坐标（例如 cu_click 只给了 x/y，netwright 压根没有坐标点击）。
// 「上一次快照出自哪个引擎」只由 cu_snapshot / cu_find 自己记，这里不记 —— click 不产 ref。
async function withEngine(tool, args, coordsFn, t, wantNet = true) {
  if (wantNet) {
    const r = await netTry(tool, args, t);
    if (r.output !== undefined) return { via: 'netwright', output: r.output, note: r.foreground ? '（netwright 用了一次前台真鼠标，之后它会把焦点还给原位）' : '' };
    if (r.degraded) { const out = await coordsFn(); return { via: 'coords', output: out, note: `netwright 管不了这个目标，已改用坐标引擎：${String(r.why).slice(0, 140)}` }; }
    if (r.error) { const out = await coordsFn(); return { via: 'coords', output: out, note: `netwright 失败已走坐标兜底：${String(r.error).slice(0, 160)}` }; }
  }
  const out = await coordsFn();
  return { via: 'coords', output: out };
}

function annotate(via, note) {
  const tag = via === 'netwright' ? '[引擎:netwright 后台UIA]' : '[引擎:坐标 user32]';
  return `${tag}${note ? ` ${note}` : ''}`;
}

/**
 * 拼 netwright 的 Selector（语法见 docs/TOOLS_REFERENCE.md 的 Concepts 一节）：
 *   #automationId | role "精确名" | role ~"子串" | element 表示任意角色
 * 我们的 cu_find 给的是 name/control/automation_id 三个散装字段，这里翻成它的写法。
 */
function netSelector(args) {
  const auto = String(args.automation_id || '').trim();
  if (auto) return `#${auto.replace(/^#/, '')}`;
  const role = String(args.control || '').trim().toLowerCase();
  const name = String(args.name || '').trim();
  if (role && name) return `${role} ~"${name}"`;
  if (role) return role;
  if (name) return `element ~"${name}"`;
  return '';
}

// 给了 hwnd / title 的目标先补出 pid：netwright 是按进程 attach 的，
// 拿不到 pid 就只能用它「上一次挂着的那个应用」，那会让 cu_snapshot(hwnd=A) 返回 B 的界面。
async function enrichTarget(t) {
  if (t.pid || t.exe) return t;
  if (!t.hwnd && !t.title) return t;
  try { await resolveTargetWindow(t); } catch (e) { /* 坐标引擎不在：让 netwright 用它当前的目标 */ }
  return t;
}

const TOOLS = {
  cu_status: {
    ...GROUP, label: '环境状态',
    description: [
      '看当前 Computer Use 能用什么：引擎在线情况（netwright 上位 / 坐标兜底）、屏幕布局、鼠标位置、已放行目标、是否「全部开放」、急停是否按过。',
      '每次开始操作电脑前先调这个，别假设 netwright 在。坐标引擎会抢鼠标，动作前先 cu_screenshot 看清楚再点。'
    ].join(' '),
    testHint: '无需参数',
    params: {},
    run: async () => {
      const st = { enabled: isEnabled(), netwright: { status: net.status, error: net.error, tools: net.tools.length, via: net.via }, engine_pref: enginePref(), open_all: isOpenAll(), daemon: daemonAlive(), degraded: [...degradedTargets.entries()].map(([k, v]) => `${k}:${v}`) };
      try { const d = await daemonCall('displays'); st.displays = d.list; st.cursor = d.cursor; st.virtual = d.virtual; }
      catch (e) { st.daemon_error = String((e && e.message) || e); }
      try { st.grants = grantsFor(0).map((g) => ({ id: g.id, pid: g.pid, exe: g.exe, title: g.title })); } catch (e) { /* 忽略 */ }
      try { const hk = await daemonCall('hotkey_state'); st.hotkey_active = hk.active; } catch (e) { /* 忽略 */ }
      st.last_stop = getSetting('cu_last_stop_ts', '') || '';
      return { output: JSON.stringify(st, null, 2) };
    },
  },

  cu_windows: {
    ...GROUP, label: '列窗口',
    description: '列出屏幕上所有可见顶层窗口（hwnd/pid/exe/title/矩形/是否前台）。要操作某个应用先在这里定位它的 hwnd 或 pid。坐标都是屏幕物理像素。',
    testHint: '无需参数',
    params: {},
    run: async () => {
      try { const r = await daemonCall('windows'); return { output: JSON.stringify(r, null, 2) }; }
      catch (e) { return { error: `列窗口失败：${String((e && e.message) || e)}` }; }
    },
  },

  cu_snapshot: {
    ...GROUP, label: '读界面结构',
    description: '把目标窗口的 UI 读成带 ref 的紧凑文本（有 UIA 就用 UIA，控件名/坐标/状态都在）。\n'
      + 'ref（e7 这种）在一次会话里对该元素保持稳定，点它用 cu_click(ref=e7)，别自己数坐标。'
      + '窗口没有 UIA 树时会报错，那就改用 cu_screenshot 看像素。',
    testArg: 'hwnd', testHint: '留空=前台窗口',
    params: {
      hwnd: { type: 'number', required: false, desc: '窗口 hwnd（来自 cu_windows）；留空用前台窗口' },
      pid: { type: 'number', required: false, desc: '目标进程 pid：netwright 要先挂到进程上，能给就给（也用于授权匹配）' },
      exe: { type: 'string', required: false, desc: '目标 exe 名（授权匹配用）' },
      max_nodes: { type: 'number', required: false, desc: '最多读多少个元素（默认 260）' },
    },
    run: async (args, ctx) => {
      const t = parseTarget(args);
      try {
        await enrichTarget(t);
        const r = await withEngine('desktop_snapshot', {}, async () => {
          const w = t.hwnd ? { hwnd: t.hwnd } : await resolveTargetWindow(t);
          return daemonCall('snapshot', { hwnd: w ? w.hwnd : 0, max_nodes: num(args.max_nodes, 260) });
        }, t);
        rememberSnapshot(t, r.via);
        const body = r.via === 'netwright' ? r.output : (r.output && r.output.text) || '';
        return { output: `${body}\n${annotate(r.via, r.note)}` };
      } catch (e) { return { error: `读界面失败：${String((e && e.message) || e)}` }; }
    },
  },

  cu_find: {
    ...GROUP, label: '找元素',
    description: '在目标窗口里按 名称(name)/控件类型(control)/automation_id 找元素，返回带 ref 和点击坐标的清单。比翻整份 snapshot 快。',
    testArg: 'name', testHint: '确定',
    params: {
      name: { type: 'string', required: false, desc: '元素名称子串（不分大小写）' },
      control: { type: 'string', required: false, desc: '控件类型：button/edit/text/combobox/checkbox 等' },
      automation_id: { type: 'string', required: false, desc: '精确 AutomationId' },
      hwnd: { type: 'number', required: false, desc: '窗口 hwnd；留空用前台窗口' },
    },
    run: async (args) => {
      const t = parseTarget(args);
      try {
        await enrichTarget(t);
        const sel = netSelector(args);
        // netwright 的 desktop_find 只吃 selector（required）：一个条件都没给就没法问它，直接走坐标引擎
        const r = await withEngine('desktop_find', { selector: sel }, async () => {
          const w = t.hwnd ? { hwnd: t.hwnd } : await resolveTargetWindow(t);
          return daemonCall('find', { hwnd: w ? w.hwnd : 0, name: args.name || '', control: args.control || '', automation_id: args.automation_id || '' });
        }, t, !!sel);
        rememberSnapshot(t, r.via);
        const body = r.via === 'netwright' ? r.output : JSON.stringify((r.output && r.output.list) || [], null, 2);
        return { output: `${body}\n${annotate(r.via, r.note)}` };
      } catch (e) { return { error: `找元素失败：${String((e && e.message) || e)}` }; }
    },
  },

  cu_screenshot: {
    ...GROUP, label: '整屏截图',
    description: '截整块屏幕（屏幕上开着什么都在图里），多模态模型会直接看到这张图。高权限：默认一截图一审批；开了「全部开放」才免审批。'
      + '坐标引擎模式下要看清像素再点时用这个。不传 display 截鼠标所在屏；多屏时结果里列出每块屏序号与分辨率。'
      + '两条固定规则：图会按用户设的上限缩放后再送出；**整段对话里只有最近一张图真的发给模型**，更早的会显示成「[过期的图片]」——'
      + '所以每步动作后重新截一张，别指望回看旧图。',
    params: { display: { type: 'number', required: false, desc: '显示器序号（0=主屏）；留空取鼠标所在那块' } },
    run: async (args) => {
      try {
        const r = await inapp.call('screen_capture', { display: args.display }, 30000);
        if (r && r.error) {
          // inapp 那条错误原文讲的是「内置浏览器栏」，可 cu_screenshot 跟那一栏毫无关系，
          // 原样贴给模型只会让它去点浏览器栏。这里换成 Computer Use 的说法，保留同一个判据。
          return { error: `整屏截图取不到画面：需要 KHarness 桌面端开着（截屏由桌面外壳执行，网页端没有这条通道）。原始原因：${r.error}` };
        }
        return { output: (r && (r.text || r.output)) || '已截图', image_file: r && r.image_file };
      } catch (e) { return { error: `截图失败：${String((e && e.message) || e)}` }; }
    },
  },

  cu_click: {
    ...GROUP, label: '点击',
    description: '点击目标界面元素。优先传 ref（来自 cu_snapshot/cu_find），它按元素中心点；没有 UIA 时才传 x/y 屏幕坐标。'
      + 'button=left|right|middle，dbl=true 双击。坐标引擎模式下这会真的移动并操作系统鼠标，会抢走用户的鼠标。',
    testArg: 'ref', testHint: 'e7',
    params: {
      ref: { type: 'string', required: false, desc: '元素 ref（来自上一次 snapshot/find）' },
      x: { type: 'number', required: false, desc: '屏幕 X 物理像素（无 ref 时必填）' },
      y: { type: 'number', required: false, desc: '屏幕 Y 物理像素（无 ref 时必填）' },
      button: { type: 'string', required: false, desc: 'left(默认)/right/middle' },
      dbl: { type: 'boolean', required: false, desc: '"true" 双击' },
      hwnd: { type: 'number', required: false, desc: '目标窗口 hwnd（用于 netwright 定位与授权匹配）' },
      pid: { type: 'number', required: false, desc: '目标进程 pid（授权匹配用）' },
      exe: { type: 'string', required: false, desc: '目标 exe 名（授权匹配用）' },
    },
    run: async (args) => {
      const t = parseTarget(args);
      const ref = String(args.ref || '').trim().replace(/^\[|\]$/g, '');   // 快照里显示 [e7]，传 target 要裸 e7
      const dbl = String(args.dbl) === 'true';
      const button = args.button || 'left';
      // netwright 没有坐标点击：只给了 x/y 就必须走坐标引擎；给了 ref 则回「上一次快照的那个引擎」
      const wantNet = !!ref && engineForRef(t) === 'netwright';
      try {
        const r = await withEngine('desktop_click', { target: ref, button, double_click: dbl }, async () => {
          const a = { button, dbl };
          if (ref) a.ref = ref; else { a.x = num(args.x, -1); a.y = num(args.y, -1); }
          return daemonCall('click', a);
        }, t, wantNet);
        const d = r.via === 'netwright' ? r.output : `点 (${r.output.x},${r.output.y}) ${r.output.button}${r.output.dbl ? ' 双击' : ''}`;
        return { output: `${d}\n${annotate(r.via, r.note)}` };
      } catch (e) { return { error: `点击失败：${String((e && e.message) || e)}（若报 STALE_REF / stale ref，重新 cu_snapshot 取新 ref）` }; }
    },
  },

  cu_drag: {
    ...GROUP, label: '拖拽',
    description: '从 (x1,y1) 拖到 (x2,y2)，全是屏幕物理像素。滑块、选区、移动窗口都用它。会真的操作系统鼠标。',
    params: {
      x1: { type: 'number', required: true, desc: '起点 X' },
      y1: { type: 'number', required: true, desc: '起点 Y' },
      x2: { type: 'number', required: true, desc: '终点 X' },
      y2: { type: 'number', required: true, desc: '终点 Y' },
    },
    run: async (args) => {
      try { const r = await daemonCall('drag', { x1: num(args.x1, 0), y1: num(args.y1, 0), x2: num(args.x2, 0), y2: num(args.y2, 0) }); return { output: `拖拽 (${r.from_x},${r.from_y})→(${r.to_x},${r.to_y})` }; }
      catch (e) { return { error: `拖拽失败：${String((e && e.message) || e)}` }; }
    },
  },

  cu_type: {
    ...GROUP, label: '输入文字',
    description: '输入文本（支持中文）。给 ref（来自 cu_snapshot/cu_find）就写进那个控件——netwright 在线时走 UIA 的值模式，'
      + '不碰鼠标也不抢焦点；只给文本时写进当前焦点控件（坐标引擎，真的敲键）。press_enter="true" 输入完回车。',
    testArg: 'text', testHint: '你好',
    params: {
      text: { type: 'string', required: true, desc: '要输入的文本' },
      ref: { type: 'string', required: false, desc: '目标控件 ref（强烈建议给，避免点错地方）' },
      press_enter: { type: 'boolean', required: false, desc: '"true" 结尾按回车' },
      pid: { type: 'number', required: false, desc: '目标进程 pid（授权匹配用）' },
      exe: { type: 'string', required: false, desc: '目标 exe 名（授权匹配用）' },
    },
    run: async (args) => {
      const t = parseTarget(args);
      const ref = String(args.ref || '').trim().replace(/^\[|\]$/g, '');
      const wantNet = !!ref && engineForRef(t) === 'netwright';
      try {
        const r = await withEngine('desktop_type', { target: ref, text: String(args.text || '') }, async () =>
          daemonCall('type', { text: String(args.text || ''), press_enter: String(args.press_enter) === 'true' }), t, wantNet);
        const d = r.via === 'netwright' ? r.output : `已输入 ${r.chars} 个字符`;
        return { output: `${d}\n${annotate(r.via, r.note)}` };
      } catch (e) { return { error: `输入失败：${String((e && e.message) || e)}` }; }
    },
  },

  cu_key: {
    ...GROUP, label: '快捷键',
    description: '按一个键或组合键，用 + 连接，如 ctrl+s、alt+tab、ctrl+shift+esc、enter。修饰名可用 ctrl/alt/shift/win，功能名可用 esc/tab/enter/space/backspace/delete/insert/home/end/pageup/pagedown/up/down/left/right/prtsc/f1..f24。'
      + '给 ref 会先把焦点放到那个元素上。按键一律要走真键盘。',
    testArg: 'combo', testHint: 'ctrl+a',
    params: {
      combo: { type: 'string', required: true, desc: '组合键，如 ctrl+s' },
      ref: { type: 'string', required: false, desc: '先聚焦这个元素再按键' },
      pid: { type: 'number', required: false, desc: '目标进程 pid（授权匹配用）' },
      exe: { type: 'string', required: false, desc: '目标 exe 名（授权匹配用）' },
    },
    run: async (args) => {
      const t = parseTarget(args);
      const ref = String(args.ref || '').trim().replace(/^\[|\]$/g, '');
      // netwright 的 desktop_press_key 参数是 keys（不是 combo），且 foreground 必须 true
      const wantNet = !!ref && engineForRef(t) === 'netwright';
      try {
        const r = await withEngine('desktop_press_key', { keys: String(args.combo || ''), target: ref || undefined, foreground: true }, async () =>
          daemonCall('key', { combo: String(args.combo || '') }), t, wantNet);
        const d = r.via === 'netwright' ? r.output : `已按 ${r.combo}`;
        return { output: `${d}\n${annotate(r.via, r.note)}` };
      } catch (e) { return { error: `按键失败：${String((e && e.message) || e)}` }; }
    },
  },

  cu_scroll: {
    ...GROUP, label: '滚动',
    description: '滚动。给 ref（一个可滚动容器或里面的元素）走 netwright/UIA，不动鼠标；'
      + '否则在 (x,y) 处滚轮：dir=down(默认)/up，amount=格数（默认 3）。坐标那种会先把鼠标移到该点，抢用户鼠标。',
    params: {
      ref: { type: 'string', required: false, desc: '可滚动的元素 ref（优先给）' },
      x: { type: 'number', required: false, desc: '滚动位置 X（无 ref 时必填）' },
      y: { type: 'number', required: false, desc: '滚动位置 Y（无 ref 时必填）' },
      dir: { type: 'string', required: false, desc: 'down/up/left/right' },
      amount: { type: 'number', required: false, desc: '格数（坐标模式）' },
      pid: { type: 'number', required: false, desc: '目标进程 pid（授权匹配用）' },
      exe: { type: 'string', required: false, desc: '目标 exe 名（授权匹配用）' },
    },
    run: async (args) => {
      const t = parseTarget(args);
      const ref = String(args.ref || '').trim().replace(/^\[|\]$/g, '');
      const wantNet = !!ref && engineForRef(t) === 'netwright';
      if (!ref && (num(args.x, -1) < 0 || num(args.y, -1) < 0)) return { error: 'cu_scroll 要么给 ref，要么给 x 和 y' };
      try {
        const r = await withEngine('desktop_scroll', {
          target: ref, direction: args.dir || 'down',
          // netwright 的 amount 只有 small|page 两档，按要滚的格数就近选
          amount: num(args.amount, 3) >= 6 ? 'page' : 'small',
        }, async () => daemonCall('scroll', { x: num(args.x, 0), y: num(args.y, 0), dir: args.dir || 'down', amount: num(args.amount, 3) }), t, wantNet);
        const d = r.via === 'netwright' ? r.output : `在 (${r.x},${r.y}) 向${r.dir === 'up' ? '上' : '下'}滚了 ${r.amount} 格`;
        return { output: `${d}\n${annotate(r.via, r.note)}` };
      } catch (e) { return { error: `滚动失败：${String((e && e.message) || e)}` }; }
    },
  },

  cu_activate: {
    ...GROUP, label: '切到前台',
    description: '把某窗口激活到前台（最小化的会还原）。坐标引擎里很多动作要求目标在前台，操作前先激活它。',
    testArg: 'hwnd', testHint: '',
    params: {
      hwnd: { type: 'number', required: true, desc: '窗口 hwnd' },
      pid: { type: 'number', required: false, desc: '目标进程 pid（授权匹配用）' },
      exe: { type: 'string', required: false, desc: '目标 exe 名（授权匹配用）' },
    },
    // 这一条固定走 Win32：netwright 的 desktop_window 要的是它的 Ref/窗口选择器，不是裸 hwnd，
    // 而我们手上就是 EnumWindows 给的 hwnd —— 用它自己的路径最准，也不牺牲任何东西（激活本来就要动前台）。
    run: async (args) => {
      try {
        const r = await daemonCall('activate', { hwnd: num(args.hwnd, 0) });
        return { output: `${r.ok ? `已激活 ${r.window ? r.window.title : ''}` : `激活可能被系统挡住（前台锁），当前前台=${r.window ? r.window.title : '?'}`}\n${annotate('coords')}` };
      } catch (e) { return { error: `激活失败：${String((e && e.message) || e)}` }; }
    },
  },

  cu_close_window: {
    ...GROUP, label: '关闭窗口',
    description: '向窗口发 WM_CLOSE（等价点关闭按钮，会走应用自己的关闭逻辑，可能弹保存提示）。破坏性操作。',
    testArg: 'hwnd', testHint: '',
    params: { hwnd: { type: 'number', required: true, desc: '窗口 hwnd' } },
    run: async (args) => {
      try { const r = await daemonCall('close_window', { hwnd: num(args.hwnd, 0) }); return { output: `已对 ${r.window ? r.window.title : args.hwnd} 发送关闭` }; }
      catch (e) { return { error: `关闭窗口失败：${String((e && e.message) || e)}` }; }
    },
  },

  cu_launch: {
    ...GROUP, label: '启动程序',
    description: '启动一个程序（可执行文件名或绝对路径）。**netwright 在线时优先由它启动** —— 那样它立刻有了 Target App，'
      + '后面的 snapshot/click 都能走不抢鼠标的后台路径；netwright 不在就用系统 start 启动，再用 cu_windows 定位窗口。',
    testArg: 'command', testHint: 'notepad',
    params: { command: { type: 'string', required: true, desc: '可执行名或完整路径' }, args: { type: 'string', required: false, desc: '传给程序的参数' } },
    run: async (args) => {
      const cmd = String(args.command || '').trim();
      if (!cmd) return { error: 'command 不能为空' };
      // netwright 的 launch 接受 path（exe）或 project（csproj），且 args 是字符串
      if (netLive() && enginePref() !== 'coords') {
        const r = await netTry('desktop_app', { action: 'launch', path: cmd, args: String(args.args || '') }, {});
        // 成了就到此为止：netwright 现在手上有 Target App，后续动作能走不抢鼠标的后台路径
        if (r.output !== undefined) return { output: `${r.output}\n${annotate('netwright', r.note)}` };
        // 失败不硬拦：很多程序根本不是 .NET 应用，那就用普通方式拉起来交给坐标引擎
      }
      return new Promise((resolve) => {
        // 用 start 让系统解析关联名/PATH，和人在开始菜单点一下一致
        execFile('cmd.exe', ['/d', '/s', '/c', 'start', '', cmd, ...(args.args ? [String(args.args)] : [])], { windowsHide: true }, (err) => {
          if (err) resolve({ error: `启动失败：${String(err.message || err)}` });
          else resolve({ output: `已请求启动 ${cmd}（稍后用 cu_windows 定位它的窗口）\n${annotate('coords')}` });
        });
      });
    },
  },

  cu_request_access: {
    ...GROUP, label: '申请操作授权',
    description: '申请放行某个进程/窗口以便后续动作免审批。给出 pid 或 exe 或 title 之一（AI 从 cu_windows 拿）。'
      + '用户批准后，对该目标的一切操作在本会话内不再逐次询问；免除审批模式下也必须先经这一次放行。',
    testArg: 'exe', testHint: 'notepad.exe',
    params: {
      pid: { type: 'number', required: false, desc: '进程 id' },
      exe: { type: 'string', required: false, desc: 'exe 文件名，如 notepad.exe' },
      title: { type: 'string', required: false, desc: '窗口标题子串' },
    },
    run: async (args, ctx) => {
      const r = addGrant(ctx && ctx.chatId, { pid: args.pid, exe: args.exe, title: args.title });
      return r.error ? { error: r.error } : { output: `已登记授权（pid=${args.pid || '-'} exe=${args.exe || '-'} title=${args.title || '-'}）` };
    },
  },
};

for (const k of Object.keys(TOOLS)) TOOLS[k].defaultOn = false;

/**
 * Computer Use 只允许「主对话循环」这一条路进来。
 * 原因不是设计偏好，是实测出来的洞：侧栏（utils/sidebar.js）和托管（utils/orchestrator.js）
 * 是直接 host.execTool(..., 'exempt', null, {}) 的 —— 它们不经过 decideApproval2，
 * 于是审批门、当场放行、授权登记全都被绕过，chatId 还是 null（连授权表都查不到）。
 * 只读模式能挡下改动类工具，但 cu_screenshot / cu_snapshot 算「读」，会就这么放过去。
 * 所以这里在工具层再兜一道：拿不到主循环给的放行标记就拒绝执行，任何宿主都一样。
 */
const NEED_MAIN_LOOP = 'Computer Use 的工具只能在主对话里调用（那边有审批卡，会当场问你放行哪个进程/窗口）。'
  + '侧栏提问、托管、子智能体这些嵌套执行路径没有审批通道，系统一律不给用。请把需要操作电脑的那步放回主对话里做。';
for (const k of Object.keys(TOOLS)) {
  const inner = TOOLS[k].run;
  TOOLS[k].run = async (args, ctx = {}) => {
    // 平台闸门在「谁能调用」之前：不是 Windows 就连门都不必问，直接给结论
    if (!SUPPORTED) return { error: NOT_SUPPORTED };
    if (!ctx || !ctx.cuMainLoop) return { error: NEED_MAIN_LOOP };
    return inner(args, ctx);
  };
}

toolgate.register(TOOLS);
const NAMES = Object.keys(TOOLS);

// 实验室「Computer Use」开关：一键启用/停用整组工具（写 ai_tools.enabled）。
function setGroupEnabled(on) {
  // 不给在非 Windows 上打开一个注定不会工作的开关：界面那颗开关点了没反应是最难猜的坏法
  if (on && !SUPPORTED) return { ok: false, enabled: false, error: NOT_SUPPORTED };
  setSetting('computer_use_enabled', on ? '1' : '0');
  for (const n of NAMES) {
    try { toolgate.upsert(n, !!on, toolgate.configOf(n)); } catch (e) { /* 忽略 */ }
  }
  // 停用只关开关，不杀守护进程/netwright：冷启动要一两秒，下次开还得重来。
  if (on) { seedBlacklist(); spawnDaemon(); applyHotkeyToDaemon(); if (net.status === 'unknown') netwrightProbe(() => {}); }
  return { ok: true, enabled: !!on };
}

// 急停快捷键：spec 形如 ctrl+alt+q / xbutton1；空串=取消。落库并即时下发给守护进程。
function setHotkey(spec) {
  const s = String(spec || '').trim();
  setSetting('computer_hotkey', s);
  return applyHotkeyToDaemon();
}
function applyHotkeyToDaemon() {
  const spec = getSetting('computer_hotkey', '');
  if (!daemonAlive()) return Promise.resolve({ ok: true, note: '坐标引擎未运行，快捷键将在引擎起来时生效' });
  return daemonCall('hotkey', { spec }).then((r) => ({ ok: true, result: r }))
    .catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
}

// 急停后推给前端一条事件（前端通过 /api/ai/computer/events 长轮询取，见 routes）。
const stopEvents = [];
function broadcastStop() {
  stopEvents.push({ ts: Date.now(), reason: 'hotkey' });
  while (stopEvents.length > 20) stopEvents.shift();
}
function drainStops(since) {
  const out = stopEvents.filter((e) => e.ts > (since || 0));
  return { events: out, latest: stopEvents.length ? stopEvents[stopEvents.length - 1].ts : (since || 0) };
}

function detectNetwright(cb) { netwrightProbe((ok) => cb && cb(ok)); }

// 引擎摘要（设置页/面板显示用）
function state(chatId) {
  return {
    supported: SUPPORTED,
    support_note: SUPPORTED ? '' : NOT_SUPPORTED,
    platform: process.platform,
    enabled: isEnabled(),
    open_all: isOpenAll(),
    engine_pref: enginePref(),
    netwright: { status: net.status, error: net.error, tools: net.tools.length, via: net.via },
    daemon: daemonAlive(),
    grants: (() => { try { return grantsFor(chatId).map((g) => ({ id: g.id, pid: g.pid, exe: g.exe, title: g.title, scope: g.scope })); } catch (e) { return []; } })(),
    hotkey: getSetting('computer_hotkey', ''),
    last_stop_ts: getSetting('cu_last_stop_ts', ''),
    last_stop_reason: getSetting('cu_last_stop_reason', ''),
    tool_names: NAMES,
  };
}

// 目标描述（审批卡要显示 AI 想操作哪个进程/窗口）
function describeTarget(args) {
  const t = parseTarget(args);
  if (t.hwnd) return { kind: 'hwnd', value: String(t.hwnd), label: `窗口 hwnd ${t.hwnd}` };
  if (t.pid) return { kind: 'pid', value: String(t.pid), label: `进程 pid ${t.pid}` };
  if (t.exe) return { kind: 'exe', value: String(t.exe), label: `程序 ${t.exe}` };
  if (t.title) return { kind: 'title', value: String(t.title), label: `窗口标题含「${t.title}」` };
  return { kind: 'global', value: '', label: '整台电脑（前台任意窗口）' };
}

const CU_TOOLS = new Set(NAMES);
function isCuTool(name) { return CU_TOOLS.has(name); }

// 只读的电脑观察工具（不动鼠标/不改状态）：仍需一次放行才能免审批，但读操作本身不破坏。
const CU_READ = new Set(['cu_status', 'cu_windows']);
// 会改动目标或抢鼠标的动作：首次接触某目标要人工放行。
const CU_MUTATE = new Set(['cu_click', 'cu_drag', 'cu_type', 'cu_key', 'cu_scroll', 'cu_activate', 'cu_close_window', 'cu_launch']);
// 读某窗口 UIA 结构：绑目标，首次接触同样要放行一次（之后同目标免审批）。
const CU_TARGET_READ = new Set(['cu_snapshot', 'cu_find']);

function hasTargetFields(t) { return !!(t.hwnd || t.pid || t.exe || t.title); }

/**
 * 审批前置判定（异步：可能要用守护进程把 hwnd 解析成 pid/exe 再比对授权）。
 * 返回：
 *   {pass:true}          —— 已授权或「全部开放」，直接放行（任何审批模式都免问，黑名单仍优先）。
 *   {need:true,reason}   —— 需要人工当场放行（红色，免除模式也拦）。批准后应调 recordApproval 登记授权。
 *   null                 —— 非 cu 工具，交回常规判定。
 */
async function resolveGate(chatId, name, args) {
  if (!isCuTool(name)) return null;
  if (isOpenAll()) return { pass: true };
  if (CU_READ.has(name)) return { pass: true };   // 环境状态/列窗口不针对具体目标，直接可看
  const t = parseTarget(args || {});
  // 整屏截图：用户口径是「一截图一审批，开全部开放才免」，且它拍的是整块屏（目标授权覆盖不了）。
  if (name === 'cu_screenshot') {
    return { need: true, reason: '整屏截图会拍到屏幕上的一切（含 KHarness 之外的窗口）。默认每次都要你确认；要免审批请在设置里开「全部开放」（危险）。', screen: true };
  }
  // cu_launch / cu_request_access 之外都要求目标；无目标描述时按前台窗口，需放行。
  const win = hasTargetFields(t) ? await safeResolve(t) : null;
  if (win && hasGrant(chatId, win)) return { pass: true };
  // 授权按 pid/exe 存：AI 传了 exe/pid 且能直接命中已有授权也放行
  if (hasTargetFields(t)) {
    const direct = grantsFor(chatId).some((g) => grantMatchesWindow(g, { pid: t.pid, exe: t.exe, title: t.title }));
    if (direct) return { pass: true };
  }
  const label = (win && win.title) ? `窗口「${win.title}」(${win.exe || 'pid ' + win.pid})` : describeTarget(args || {}).label;
  const kind = CU_TARGET_READ.has(name) ? '读取' : '操作';
  return { need: true, reason: `首次${kind}目标 ${label}。批准后该进程/窗口在本会话内的后续操作不再逐次询问。`, targetWin: win || null, t };
}

async function safeResolve(t) {
  try { return await resolveTargetWindow(t); } catch (e) { return null; }
}

// 用户批准后登记授权：优先按 pid+exe（最稳，重启换 hwnd 也认），退而求其次按给出的字段。
async function recordApproval(chatId, name, args) {
  if (!isCuTool(name)) return { ok: false };
  if (name === 'cu_screenshot' || name === 'cu_launch' || CU_READ.has(name)) return { ok: false, note: '该动作不登记目标授权' };
  const t = parseTarget(args || {});
  const win = await safeResolve(t);
  if (win && (win.pid || win.exe)) return addGrant(chatId, { pid: win.pid, exe: win.exe, title: win.title });
  if (hasTargetFields(t)) return addGrant(chatId, t);
  return { ok: false, note: '没能确定授权目标' };
}

// 服务退出必须把两个子进程带走：Windows 上 child.kill() 只到直接子进程，
// dnx 起的 netwright 会留在外面（和 mcp.js 里 taskkill /T 同一个原因）。
function killTree(pid) {
  if (!pid) return;
  try { execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {}); } catch (e) { /* 已退出 */ }
}
function shutdownAll() {
  try {
    if (daemon && daemon.child) { const pid = daemon.child.pid; try { daemon.child.stdin.write('{"cmd":"shutdown"}\n'); daemon.child.stdin.end(); } catch (e) { /* 忽略 */ } killTree(pid); }
  } catch (e) { /* 忽略 */ }
  try {
    if (net.child) { const pid = net.child.pid; try { net.child.kill(); } catch (e) { /* 忽略 */ } killTree(pid); net.child = null; net.status = 'off'; }
  } catch (e) { /* 忽略 */ }
}

// 供权限黑名单比对：把 cu 目标字段摊成 keywords（exe=..、title=..）
function subjects(args) {
  const t = parseTarget(args || {});
  const kw = [];
  if (t.exe) kw.push(`exe=${t.exe}`);
  if (t.title) kw.push(`title=${t.title}`);
  if (t.pid) kw.push(`pid=${t.pid}`);
  if (t.hwnd) kw.push(`hwnd=${t.hwnd}`);
  if (args && args.command) kw.push(`launch=${String(args.command)}`);
  return kw;
}

// 预置黑名单：首次启用 Computer Use 时写入，用户可在「设置 → 权限」里自行增删。
// 为什么要预置：让 AI 能操作任意软件的同时，任务管理器/注册表/终端这类入口必须默认封死 ——
// 「操作 cmd.exe 窗口」等于给 run_command 开了个不经过命令审批的后门。
const SEEDED = [
  ['exe=taskmgr.exe', '任务管理器（Computer Use 预置）'],
  ['exe=regedit.exe', '注册表编辑器（Computer Use 预置）'],
  ['exe=cmd.exe', '命令提示符窗口（Computer Use 预置：否则等于绕过命令审批）'],
  ['exe=powershell.exe', 'PowerShell 窗口（Computer Use 预置：否则等于绕过命令审批）'],
  ['exe=pwsh.exe', 'PowerShell 7 窗口（Computer Use 预置：否则等于绕过命令审批）'],
  ['exe=wt.exe', 'Windows 终端（Computer Use 预置：否则等于绕过命令审批）'],
  ['exe=mmc.exe', '微软管理控制台：服务/磁盘/组策略都走它（Computer Use 预置）'],
];
function seedBlacklist() {
  try {
    const ins = db.prepare('INSERT INTO perm_rules (kind, list, pattern, match, enabled, note) VALUES (?, ?, ?, ?, 1, ?)');
    const have = new Set(db.prepare("SELECT pattern FROM perm_rules WHERE kind = 'keyword'").all().map(r => String(r.pattern).toLowerCase()));
    let added = 0;
    for (const [pat, note] of SEEDED) {
      if (have.has(pat.toLowerCase())) continue;
      ins.run('keyword', 'black', pat, 'contains', note);
      added++;
    }
    if (added) perms.reload();
    return added;
  } catch (e) { return 0; }
}

// 给系统提示词的 Computer Use 使用纪律（只有启用时才加）。
function promptNotes() {
  // 库里可能带着从 Windows 那边导入的「已启用」标记，System Prompt 不能照念 —— 否则模型会当真去调这组工具
  if (!SUPPORTED || !isEnabled()) return '';
  return [
    '',
    '[Computer Use（操作这台电脑）已启用]',
    '- 顺序：cu_status 看引擎 → cu_windows 定位目标窗口 → cu_snapshot 读界面（有 UIA 就用 ref）→ 再 cu_click/cu_type/cu_key 动作 → 需要时用 cu_screenshot 复核。',
    '- 能拿 ref 就别猜坐标：ref 按元素中心点，抗布局变化；只有目标不暴露 UIA 时才按截图像素点。',
    '- 坐标引擎会真的移动并点击系统鼠标，用户此刻不能用电脑；一次只做一步，做完确认，不要连环盲点。',
    '- 首次操作某个进程/窗口需要用户当场放行（批准后同目标在本会话内不再询问）。被拒绝就停下解释，不要换个目标绕过去。',
    '- 别用 Computer Use 做本来有专门工具能做的事（读写文件、跑命令、上网查资料都有独立工具）。',
  ].join('\n');
}

// 总开关开着就先把坐标引擎和急停快捷键拉起来。
// 不等第一次动作才起：快捷键是「出事了立刻停手」的东西，它必须在 AI 动手之前就已经按得下去。
function bootArm() {
  if (!SUPPORTED || !isEnabled()) return;
  spawnDaemon();
  if (getSetting('computer_hotkey', '')) applyHotkeyToDaemon();
}

module.exports = {
  NAMES, TOOLS, isCuTool, describeTarget, resolveGate, recordApproval, subjects,
  CU_MUTATE, promptNotes, seedBlacklist, bootArm,
  isEnabled, isOpenAll, setGroupEnabled, setHotkey, state, detectNetwright, netLive,
  supported, NOT_SUPPORTED,
  hasGrant, addGrant, removeGrant, grantsFor, emergencyStop, drainStops,
  daemonCall, daemonAlive, shutdownAll, applyHotkeyToDaemon,
  ensureGrantTable, getSetting, setSetting, targetKey,
};
