// MCP 客户端层：把外部 MCP server 的能力并进 toolgate，让 Agent 像用内置工具一样用它们。
//
// 为什么这么切：MCP.md 讲的是一个通用 Client + Registry + 权限中间件；KHarness 已经有
// toolgate 这条工具总线（注册表 / 开关 / schema / 提示词 / 分发），所以这里只做「协议 + 连接」，
// 工具一旦 discover 出来就 register 进 toolgate，其余链路（原生 function calling、文本协议回退、
// 审批、用量统计、设置页卡片）全部白拿，不另起一套。
//
// 两种 transport：
//   stdio —— 换行分帧的 JSON-RPC 2.0（MCP 标准），子进程随 server 起，退出时杀整棵进程树
//   http  —— Streamable HTTP：POST 到 url，响应可能是 application/json 也可能是 SSE，都要吃下
// 老的 HTTP+SSE 双端点 transport（2024-11-05）暂未实现；要用就走 stdio 或 npx 的 mcp-proxy。
const { spawn, execFile } = require('child_process');
const readline = require('readline');
const { URL } = require('url');
const { db } = require('../database');
const toolgate = require('./toolgate');

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'KHarness', version: '1.0.0' };
const INIT_TIMEOUT_MS = 20000;
const LIST_TIMEOUT_MS = 20000;
const CALL_TIMEOUT_MS = 120000;
const RESULT_CAP = 24000;          // 单个工具结果回喂模型的字符上限
const ERR_CAP = 400;

/** id -> 连接实例：{ row, child, rl, pending, nextId, tools, status, error, sessionId } */
const live = new Map();

function ensureTable() {
  db.prepare(`CREATE TABLE IF NOT EXISTS ai_mcp_servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    transport TEXT NOT NULL DEFAULT 'stdio',
    command TEXT DEFAULT '',
    args TEXT DEFAULT '[]',
    url TEXT DEFAULT '',
    env TEXT DEFAULT '{}',
    cwd TEXT DEFAULT '',
    headers TEXT DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 0,
    status TEXT DEFAULT 'off',
    last_error TEXT DEFAULT '',
    tools TEXT DEFAULT '[]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`).run();
}

function rows() {
  ensureTable();
  return db.prepare('SELECT * FROM ai_mcp_servers ORDER BY id ASC').all();
}

function rowOf(id) {
  ensureTable();
  return db.prepare('SELECT * FROM ai_mcp_servers WHERE id = ?').get(Number(id)) || null;
}

function parseJson(text, fallback) {
  try { const v = JSON.parse(String(text ?? '')); return v ?? fallback; } catch (e) { return fallback; }
}

/* ---------------- JSON-RPC ---------------- */

function send(s, msg) {
  if (s.transport === 'http') return httpPost(s, msg);
  if (!s.child || !s.child.stdin || s.child.stdin.destroyed) return Promise.reject(new Error('MCP 子进程已退出'));
  return new Promise((res, rej) => {
    try { s.child.stdin.write(JSON.stringify(msg) + '\n', () => res()); } catch (e) { rej(e); }
  });
}

function request(s, method, params, timeoutMs) {
  const id = s.nextId++;
  const msg = { jsonrpc: '2.0', id, method, params };
  // HTTP 是请求-响应成对的，不需要 pending 表；stdio 才要按 id 等异帧回来
  if (s.transport === 'http') {
    return Promise.race([
      httpPost(s, msg).then((env) => {
        if (!env) return null;
        if (env.error) throw new Error(`${method}: ${env.error.message || JSON.stringify(env.error).slice(0, ERR_CAP)}`);
        return env.result;
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`${method} 超时 ${Math.round(timeoutMs / 1000)}s`)), timeoutMs)),
    ]);
  }
  const p = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      s.pending.delete(id);
      reject(new Error(`${method} 超时 ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    s.pending.set(id, { resolve, reject, timer, method });
  });
  send(s, msg).catch((e) => {
    const w = s.pending.get(id);
    if (w) { clearTimeout(w.timer); s.pending.delete(id); w.reject(e); }
  });
  return p;
}

function notify(s, method, params) {
  return send(s, { jsonrpc: '2.0', method, params }).catch(() => {});
}

/** 子进程吐出的一行：按 id 找回挂起的请求；通知和未知 id 直接丢 */
function onMessage(s, raw) {
  const line = String(raw || '').trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }        // 有些 server 会往 stdout 打日志，忽略
  if (msg.id === undefined || msg.id === null) return;
  const w = s.pending.get(msg.id);
  if (!w) return;
  clearTimeout(w.timer);
  s.pending.delete(msg.id);
  if (msg.error) w.reject(new Error(`${w.method}: ${msg.error.message || JSON.stringify(msg.error).slice(0, ERR_CAP)}`));
  else w.resolve(msg.result);
}

/* ---------------- transport ---------------- */

/** Windows 上 npx / *.cmd 不能直接 spawn（ENOENT），得套一层 cmd */
function resolveSpawn(command, args) {
  const cmd = String(command || '').trim();
  const needsShell = /\b(npx|npm|yarn|pnpm|node\.cmd)$/i.test(cmd) || /\.cmd$/i.test(cmd) || /\.bat$/i.test(cmd);
  if (process.platform === 'win32' && needsShell) {
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', cmd, ...args] };
  }
  return { file: cmd, args };
}

function spawnStdio(row) {
  const args = parseJson(row.args, []);
  const env = parseJson(row.env, {});
  const { file, args: argv } = resolveSpawn(row.command, Array.isArray(args) ? args.map(String) : []);
  const child = spawn(file, argv, {
    cwd: row.cwd || undefined,
    env: { ...process.env, ...(env && typeof env === 'object' ? env : {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return child;
}

async function httpPost(s, msg) {
  const { fetch } = require('undici');
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(s.headers || {}),
  };
  if (s.sessionId) headers['mcp-session-id'] = s.sessionId;
  const isNotification = msg.id === undefined;
  const res = await fetch(s.row.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(msg),
    signal: isNotification ? undefined : AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const sid = res.headers.get('mcp-session-id');
  if (sid) s.sessionId = sid;
  if (!res.ok) throw new Error(`HTTP ${res.status} ${String(res.statusText || '').slice(0, 120)}`);
  if (isNotification) return null;
  const ctype = String(res.headers.get('content-type') || '');
  if (!ctype.includes('text/event-stream')) return (await res.json());
  // SSE：把所有 data: 行收下来，找带本请求 id 的那条
  const text = await res.text();
  for (const block of text.split(/\r?\n\r?\n/)) {
    const dataLine = block.split(/\r?\n/).find((l) => l.startsWith('data:'));
    if (!dataLine) continue;
    let payload;
    try { payload = JSON.parse(dataLine.slice(5).trim()); } catch (e) { continue; }
    if (payload && String(payload.id) === String(msg.id)) return payload;
  }
  throw new Error('SSE 响应里没有匹配的响应帧');
}

/* ---------------- 命名与注册 ---------------- */

/** MCP server 名 → 工具名前缀。上游 function calling 只收 [A-Za-z0-9_-]，且总长 ≤64 */
function slug(text, fallback) {
  const s = String(text || fallback || 'server').trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (s || fallback || 'server').slice(0, 20);
}

function toolNameFor(prefix, mcpToolName, taken) {
  const tail = String(mcpToolName || 'tool').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40);
  let name = `mcp__${prefix}__${tail}`;
  // 与别的 server 撞名时补 id，保证注册表里的键唯一
  for (let i = 2; taken.has(name) && i < 50; i++) name = `mcp__${prefix}__${tail}_${i}`;
  if (name.length > 64) name = name.slice(0, 64);
  return name;
}

/**
 * 把 MCP 的 inputSchema 整理成能直接塞给上游的 parameters。
 * 只去 `$schema`：不少实现会带 draft-07 的地址，而 OpenAI/Anthropic 的参数校验器对未知关键字
 * 宽严不一（实测有直接报 400 的），去掉不影响语义。
 */
function cleanSchema(raw) {
  const s = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const out = {};
  for (const [k, v] of Object.entries(s)) if (k !== '$schema') out[k] = v;
  if (out.type !== 'object') {
    // 少数 server 给的是无类型/联合类型；上游要求 object，包一层
    return { type: 'object', properties: out.properties && typeof out.properties === 'object' ? out.properties : {}, required: Array.isArray(out.required) ? out.required : [] };
  }
  return out;
}

/** 把 tools/list 的结果并进 toolgate；先摘掉该 server 上一次注册的工具 */
function syncTools(s, list) {
  toolgate.unregister(s.toolNames || []);
  const prefix = slug(s.row.name, `s${s.row.id}`);
  const taken = new Set(toolgate.order);
  const names = [];
  const defs = {};
  for (const t of list || []) {
    if (!t || !t.name) continue;
    const name = toolNameFor(prefix, t.name, taken);
    taken.add(name);
    names.push(name);
    defs[name] = {
      kind: 'mcp',
      provider: s.row.name,
      category: 'MCP',
      label: (t.annotations && t.annotations.title) || t.name,
      source: `MCP server「${s.row.name}」`,
      doc: '—',
      cost: '取决于该 MCP server',
      description: String(t.description || `${t.name}（MCP 工具，无描述）`),
      // MCP 的 inputSchema 本来就是 JSON Schema，原样交给上游（只剔掉 $schema）
      nativeSchema: cleanSchema(t.inputSchema),
      rawInputSchema: t.inputSchema || null,
      params: {},
      annotations: t.annotations || null,
      mcp: true,
      mcpServerId: s.row.id,
      mcpToolName: t.name,
      testArg: Object.keys(((t.inputSchema || {}).properties) || {})[0] || '',
      // 第三方能力默认关，要用户在设置里显开；只读工具也一样，别偷偷挂上去
      defaultOn: false,
      run: (args, ctx) => callTool(s.row.id, t.name, args, ctx),
    };
  }
  if (Object.keys(defs).length) toolgate.register(defs);
  s.toolNames = names;
  return names;
}

/* ---------------- 结果整形 ---------------- */

function capText(s) {
  const t = String(s ?? '');
  return t.length > RESULT_CAP ? t.slice(0, RESULT_CAP) + `\n…（已截断，共 ${t.length} 字符）` : t;
}

/** MCP 的 content[] 拍平成给模型看的文本；二进制内容只报存在，不塞 base64 */
function flattenResult(result) {
  const parts = Array.isArray(result && result.content) ? result.content : [];
  const lines = [];
  for (const p of parts) {
    if (!p || typeof p !== 'object') { lines.push(String(p)); continue; }
    if (p.type === 'text') { lines.push(String(p.text ?? '')); continue; }
    if (p.type === 'image' || p.type === 'audio') { lines.push(`[${p.type} ${p.mimeType || ''} 未渲染]`); continue; }
    if (p.type === 'resource') {
      const r = p.resource || {};
      lines.push(String(r.text ?? `[资源 ${r.uri || ''} 非文本]`));
      continue;
    }
    if (p.type === 'resource_link') { lines.push(`[资源 ${p.uri || p.name || ''}]`); continue; }
    lines.push(JSON.stringify(p));
  }
  // 很多 server 会同时回 text 和 structuredContent（同一份内容两种表示），
  // 两份都给模型就是白烧 token —— 有文本就只给文本。
  if (!lines.length && result && result.structuredContent !== undefined) lines.push(JSON.stringify(result.structuredContent));
  if (!lines.length && result && result.output !== undefined) lines.push(typeof result.output === 'string' ? result.output : JSON.stringify(result.output));
  return capText(lines.join('\n').trim());
}

/* ---------------- 连接生命周期 ---------------- */

function setStatus(row, status, error) {
  ensureTable();
  db.prepare("UPDATE ai_mcp_servers SET status = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(status, String(error || '').slice(0, 800), row.id);
}

async function connect(row) {
  disconnect(row.id, { keepTools: false });
  const transport = String(row.transport || 'stdio');
  const s = {
    row, transport, pending: new Map(), nextId: 1, toolNames: [],
    status: 'connecting', error: '', sessionId: '', headers: parseJson(row.headers, {}) || {},
    child: null, rl: null, stderrTail: '',
  };
  if (transport === 'stdio') {
    if (!String(row.command || '').trim()) throw new Error('stdio 方式必须填 command');
    s.child = spawnStdio(row);
    s.rl = readline.createInterface({ input: s.child.stdout });
    s.rl.on('line', (line) => onMessage(s, line));
    s.child.stderr.on('data', (b) => { s.stderrTail = (s.stderrTail + String(b)).slice(-2000); });
    s.child.on('exit', (code, sig) => {
      const why = `MCP 子进程退出 code=${code} signal=${sig}${s.stderrTail ? ' | ' + s.stderrTail.slice(-260) : ''}`;
      for (const w of s.pending.values()) { clearTimeout(w.timer); w.reject(new Error(why)); }
      s.pending.clear();
      toolgate.unregister(s.toolNames);
      setStatus(row, 'dead', why);
      live.delete(row.id);
      s.child = null;
    });
    s.child.on('error', (e) => {
      setStatus(row, 'error', e.message);
      toolgate.unregister(s.toolNames);
      live.delete(row.id);
    });
  } else if (transport === 'http') {
    if (!/^https?:\/\//i.test(String(row.url || ''))) throw new Error('http 方式必须填 http(s) 地址');
  } else {
    throw new Error(`不支持的 transport：${transport}（可选 stdio / http）`);
  }

  let listed;
  let info;
  // 先挂进 live，握手失败时 disconnect 才找得到它、能把子进程收干净
  live.set(row.id, s);
  try {
    info = await request(s, 'initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    }, INIT_TIMEOUT_MS);
    await notify(s, 'notifications/initialized', {});
    listed = await request(s, 'tools/list', {}, LIST_TIMEOUT_MS);
  } catch (e) {
    // 握手失败：先把原因落到库里（设置页要靠 status + last_error 显示红字），再断开收子进程
    const why = String((e && e.message) || e).slice(0, 400);
    try { setStatus(row, 'error', why); } catch (e2) { /* 写库失败不掩盖原错 */ }
    disconnect(row.id);
    throw e;
  }
  s.serverInfo = info && info.serverInfo ? info.serverInfo : null;
  const names = syncTools(s, (listed && listed.tools) || []);
  // live.set 已在握手前做过（见上），这里只把状态改成可用
  s.status = 'live';
  ensureTable();
  db.prepare("UPDATE ai_mcp_servers SET status = 'live', last_error = '', tools = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(JSON.stringify(((listed && listed.tools) || []).map(t => ({ name: t.name, title: (t.annotations || {}).title || '', desc: String(t.description || '').slice(0, 200), read_only: !!(t.annotations && t.annotations.readOnlyHint), destructive: !!(t.annotations && t.annotations.destructiveHint) }))), row.id);
  return { tools: names, serverInfo: s.serverInfo };
}

function disconnect(id, opts = {}) {
  const s = live.get(Number(id));
  if (!s) return;
  live.delete(Number(id));
  if (!opts.keepTools) { toolgate.unregister(s.toolNames); s.toolNames = []; }
  if (s.rl) { try { s.rl.close(); } catch (e) { /* 忽略 */ } s.rl = null; }
  if (s.child && !s.child.killed) {
    const pid = s.child.pid;
    try { s.child.kill(); } catch (e) { /* 已退出 */ }
    // Windows 上 kill 只到直接子进程，npx 起的 node 会留在外面，必须杀整棵树
    if (process.platform === 'win32' && pid) {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {});
    }
    s.child = null;
  }
  for (const w of s.pending.values()) { clearTimeout(w.timer); w.reject(new Error('MCP 连接已关闭')); }
  s.pending.clear();
}

async function callTool(id, mcpToolName, args) {
  const s = live.get(Number(id));
  if (!s || s.status !== 'live') {
    const row = rowOf(id);
    return { error: `MCP server「${row ? row.name : id}」当前没连上。到设置 → MCP 服务器里重连，或让它在启动时自动连接。` };
  }
  try {
    const result = await request(s, 'tools/call', { name: mcpToolName, arguments: args && typeof args === 'object' ? args : {} }, CALL_TIMEOUT_MS);
    if (result && result.isError) {
      return { error: `MCP 工具 ${mcpToolName} 执行失败：${flattenResult(result) || '未给出原因'}` };
    }
    const text = flattenResult(result);
    return { output: text || '(该工具没有返回内容)' };
  } catch (e) {
    return { error: `调用 MCP 工具 ${mcpToolName} 失败：${String((e && e.message) || e).slice(0, 400)}` };
  }
}

/** 服务启动时把所有 enabled 的 server 拉起来；单个失败不影响其它，也不阻塞启动 */
async function connectAll() {
  ensureTable();
  const list = rows().filter((r) => r.enabled);
  const out = [];
  for (const r of list) {
    try { out.push({ id: r.id, name: r.name, ...(await connect(r)) }); } catch (e) {
      setStatus(r, 'error', (e && e.message) || String(e));
      out.push({ id: r.id, name: r.name, error: String((e && e.message) || e).slice(0, 300) });
    }
  }
  return out;
}

function shutdownAll() {
  for (const id of [...live.keys()]) disconnect(id);
}

/* ---------------- 给设置页 / REST 用 ---------------- */

function listForUi() {
  ensureTable();
  return rows().map((r) => ({
    ...r,
    args: parseJson(r.args, []),
    env: parseJson(r.env, {}),
    headers: parseJson(r.headers, {}),
    tools: parseJson(r.tools, []),
    connected: live.has(r.id),
    server_info: (live.get(r.id) || {}).serverInfo || null,
  }));
}

function normalizeBody(body = {}) {
  const name = String(body.name || '').trim().slice(0, 40);
  if (!name) return { error: '名称不能为空' };
  const transport = ['stdio', 'http'].includes(String(body.transport)) ? String(body.transport) : 'stdio';
  let args = body.args;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch (e) { args = args.split(/\s+/).filter(Boolean); } }
  if (!Array.isArray(args)) args = [];
  const clean = (o) => (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  return {
    name,
    transport,
    command: String(body.command || '').trim().slice(0, 300),
    args: JSON.stringify(args.map(String).slice(0, 24)),
    url: String(body.url || '').trim().slice(0, 400),
    env: JSON.stringify(clean(body.env)),
    cwd: String(body.cwd || '').trim().slice(0, 300),
    headers: JSON.stringify(clean(body.headers)),
    enabled: body.enabled === undefined ? 0 : (body.enabled ? 1 : 0),
  };
}

function create(body) {
  const v = normalizeBody(body);
  if (v.error) return v;
  ensureTable();
  try {
    const r = db.prepare(`INSERT INTO ai_mcp_servers (name, transport, command, args, url, env, cwd, headers, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(v.name, v.transport, v.command, v.args, v.url, v.env, v.cwd, v.headers, v.enabled);
    return { id: Number(r.lastInsertRowid), row: rowOf(r.lastInsertRowid) };
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) return { error: `名称「${v.name}」已存在` };
    return { error: String((e && e.message) || e) };
  }
}

function update(id, body) {
  const cur = rowOf(id);
  if (!cur) return { error: '没有这个 MCP server' };
  const v = normalizeBody({ ...cur, args: parseJson(cur.args, []), env: parseJson(cur.env, {}), headers: parseJson(cur.headers, {}), ...body });
  if (v.error) return v;
  db.prepare(`UPDATE ai_mcp_servers SET name=?, transport=?, command=?, args=?, url=?, env=?, cwd=?, headers=?, enabled=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(v.name, v.transport, v.command, v.args, v.url, v.env, v.cwd, v.headers, v.enabled, cur.id);
  return { row: rowOf(cur.id) };
}

function remove(id) {
  const cur = rowOf(id);
  if (!cur) return { error: '没有这个 MCP server' };
  disconnect(cur.id);
  toolgate.unregister(namesOfServer(cur.id));
  db.prepare('DELETE FROM ai_mcp_servers WHERE id = ?').run(cur.id);
  // 开关行留着无害（ai_tools 以工具名为键），但已从注册表摘掉，不会再挂给模型
  return { message: `已删除 MCP server「${cur.name}」` };
}

/** 该 server 目前注册在 toolgate 里的工具名（重连/删除时要用） */
function namesOfServer(id) {
  const s = live.get(Number(id));
  if (s) return s.toolNames.slice();
  return toolgate.order.filter((n) => (toolgate.registry.get(n) || {}).mcpServerId === Number(id));
}

module.exports = {
  ensureTable, rows, rowOf, listForUi, create, update, remove,
  connect, disconnect, connectAll, shutdownAll, callTool, namesOfServer,
  live, slug, toolNameFor, cleanSchema, flattenResult,
};
