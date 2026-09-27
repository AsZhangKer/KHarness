// 子智能体（SubAgent）：主 Agent 可以派一个「只读的小分身」去干一段独立的活，
// 拿回结论而不是拿回一堆中间过程，避免把主会话的上下文和步数预算吃光。
//
// 实现取向：不新起进程、不重写工具层。子智能体是同进程内的一个嵌套 ReAct 循环，
// 工具执行复用 routes/ai.js 注入进来的 host.exec（即 execTool），因此路径防护、
// 编码自适配、脱敏、权限黑名单这些机制自动全部生效。
//
// 安全边界（默认，且是硬约束）：
//   1) 工具走白名单：只有查看类（read_file / list_dir / grep / glob / web_fetch / load_skill）
//      和只读的扩展工具可用；写文件、跑命令、起后台任务一律不注册进子智能体的工具清单。
//   2) 不可递归：agent_* 本身不在白名单里，子智能体没法再往下派。
//   3) 有步数上限、超时和并发上限，防止一次派发把额度烧穿。
'use strict';

const { db } = require('../database');
const agentsMd = require('./agentsmd');
const crypto = require('crypto');

// routes/ai.js 在启动时注入；本模块绝不反向 require ai.js（会成环）
let host = null;
function setHost(h) { host = h; }

// 子智能体可见的内置工具（严格只读）
const BUILTIN_ALLOW = new Set(['read_file', 'list_dir', 'grep', 'glob', 'web_fetch', 'load_skill']);
// 扩展工具里排除掉的（会改东西 / 会递归 / 会起进程 / 会问用户）
const GATE_DENY = new Set([
  'run_background', 'background_kill', 'memory_write', 'ask_user',
]);
const isGateDenied = (n) => GATE_DENY.has(n) || n.startsWith('agent_');

const LIMITS = {
  maxSteps: 24,        // 单个子智能体最多请求模型多少次
  timeoutMs: 600000,   // 10 分钟
  maxParallel: 2,      // 同时在跑的子智能体数
  resultChars: 8000,   // 回喂给主 Agent 的结论长度上限
  taskChars: 6000,
};

function ensureTable() {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS ai_subagents (
      id TEXT PRIMARY KEY,
      parent_chat_id INTEGER,
      name TEXT NOT NULL DEFAULT '',
      task TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queued',
      model_id TEXT NOT NULL DEFAULT '',
      cwd TEXT NOT NULL DEFAULT '',
      iter INTEGER NOT NULL DEFAULT 0,
      result TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      steps_json TEXT NOT NULL DEFAULT '[]',
      usage_json TEXT NOT NULL DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      finished_at DATETIME
    )`).run();
  } catch (e) { /* 建表失败时上层按空处理 */ }
}

// 运行中的句柄：id -> { controller, promise, deniedList }
const live = new Map();

function rowOf(id) {
  ensureTable();
  try { return db.prepare('SELECT * FROM ai_subagents WHERE id = ?').get(id) || null; }
  catch (e) { return null; }
}

function allRows(limit = 100) {
  ensureTable();
  try {
    return db.prepare('SELECT * FROM ai_subagents ORDER BY created_at DESC, id DESC LIMIT ?').all(limit);
  } catch (e) { return []; }
}

function patch(id, fields) {
  ensureTable();
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const set = keys.map(k => `${k} = ?`).join(', ');
  const vals = keys.map(k => fields[k]);
  try {
    db.prepare(`UPDATE ai_subagents SET ${set}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...vals, id);
  } catch (e) { /* 单次写失败不影响主流程 */ }
}

function runningCount() {
  return [...live.values()].filter(h => h.status === 'running').length;
}

function slug(raw, fallback) {
  const s = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-').replace(/^-|-$/g, '');
  return (s || fallback || 'agent').substring(0, 40);
}

function newId(name) {
  return 'sa-' + slug(name, 'agent').replace(/[^a-z0-9_-]/g, '').substring(0, 16) + '-' + crypto.randomBytes(3).toString('hex');
}

// ---------- 模型与请求 ----------
const MODEL_SELECT = `
  SELECT m.id AS row_id, m.model_id, m.display_name,
         p.base_url, p.api_key, p.proxy_enabled, p.proxy_host, p.proxy_port,
         p.api_style, p.max_tokens, p.custom
  FROM ai_models m JOIN ai_providers p ON m.provider_id = p.id
`;

/** 父会话所属项目的根目录（自由会话/查不到就回空串，让 collect 退回按 cwd 就近取） */
function projectRootOfChat(chatId) {
  if (!chatId) return '';
  try {
    const r = db.prepare(`SELECT p.root_path AS r FROM ai_chats c LEFT JOIN projects p ON p.id = c.project_id WHERE c.id = ?`).get(chatId);
    return String(r?.r || '');
  } catch (e) { return ''; }
}

// 解析模型：支持按 model_id 或行 id 指定；不指定就用主会话正在用的那个
function resolveModel(hint, parentChatId) {
  ensureTable();
  let row = null;
  const key = String(hint ?? '').trim();
  if (key) {
    row = db.prepare(MODEL_SELECT + ' WHERE m.model_id = ? OR m.id = ? OR m.display_name = ? ORDER BY m.id ASC LIMIT 1')
      .get(key, Number(key) || -1, key);
    if (!row) return { error: `找不到模型「${key}」。用 host 侧的模型清单里的 model_id；不填就沿用主会话的模型。` };
  }
  if (!row && parentChatId) {
    const c = db.prepare('SELECT model_row_id FROM ai_chats WHERE id = ?').get(parentChatId);
    if (c?.model_row_id) row = db.prepare(MODEL_SELECT + ' WHERE m.id = ?').get(c.model_row_id);
  }
  if (!row) row = db.prepare(MODEL_SELECT + ' ORDER BY m.id ASC LIMIT 1').get();
  if (!row) return { error: '本机没有可用模型，请先到「模型」页添加提供商与模型。' };
  return { row };
}

function makeDispatcher(row) {
  if (!row.proxy_enabled || !row.proxy_host) return undefined;
  try {
    const { ProxyAgent } = require('undici');
    return new ProxyAgent(`http://${row.proxy_host}:${row.proxy_port}`);
  } catch (e) { return undefined; }
}

const SYS_PROMPT = [
  '你是 KHarness 主 Agent 派出来的**子智能体**，只做被交代的这一件事，做完就收工。',
  '',
  '硬约束：',
  '- 你只有**只读**能力：能读文件、列目录、grep/glob 搜索、抓网页、加载技能。',
  '- 你不能写文件、不能删文件、不能执行命令、不能起后台任务——这些工具没有注册给你，尝试也只会拿到拒绝信息。',
  '- 需要改动时不要硬试，把「该改哪里、改成什么」写进结论里交回给主 Agent，由它决定和执行。',
  '- 你无法向用户提问，也不要试图再派子智能体。',
  '',
  '输出纪律：',
  '- 你的回复会被原样交回主 Agent，所以只给**结论**：关键事实、文件路径、行号、代码片段、判断依据。',
  '- 不要复述任务、不要写「我将/我已完成」这类过程话、不要输出完整文件内容，引用代码时给 路径:行号 和必要片段。',
  '- 拿不到答案就直说拿不到以及为什么，不要编。',
].join('\n');

// ---------- 一次子智能体运行 ----------
function buildToolList(modelRow) {
  const builtins = (host?.builtinToolDefs ? host.builtinToolDefs(BUILTIN_ALLOW) : [])
    .filter(t => BUILTIN_ALLOW.has(t.function?.name));
  let gated = [];
  try {
    const toolgate = require('./toolgate');
    gated = toolgate.definitions().filter(t => !isGateDenied(t.function?.name));
  } catch (e) { gated = []; }
  return builtins.concat(gated);
}

function toolText(res) {
  if (!res || typeof res !== 'object') return String(res ?? '');
  if (res.error) return `错误：${res.error}`;
  const parts = [];
  if (res.output !== undefined) parts.push(String(res.output));
  if (res.diff) parts.push(`[diff ${res.diff.length} 行]`);
  return parts.join('\n') || '(无输出)';
}

async function callOnce({ modelRow, messages, tools, signal }) {
  const protocols = require('./protocols');
  const req = protocols.buildChatRequest(modelRow, {
    model: modelRow.model_id, messages, tools: tools.length ? tools : undefined, stream: false,
  });
  const resp = await fetch(req.url, {
    method: req.method, headers: req.headers, body: JSON.stringify(req.body),
    dispatcher: makeDispatcher(modelRow), signal,
  });
  if (!resp.ok) {
    const detail = (await resp.text().catch(() => '')).substring(0, 300);
    return { error: `HTTP ${resp.status}: ${detail}` };
  }
  const data = await resp.json();
  const norm = protocols.normalizeReply(modelRow, data);
  const msg = norm?.choices?.[0]?.message || {};
  const red = (s) => (host?.redact ? host.redact(s) : String(s ?? ''));
  const content = red(msg.content || '');
  const toolCalls = (msg.tool_calls || []).map(c => ({
    id: c.id || ('call_' + crypto.randomBytes(4).toString('hex')),
    name: c.function?.name || '',
    args: (() => { try { return JSON.parse(c.function?.arguments || '{}'); } catch (e) { return {}; } })(),
  }));
  return { content, toolCalls, usage: norm.usage || null };
}

function capText(s, n) {
  const t = String(s ?? '');
  return t.length > n ? t.substring(0, n) + `\n…(共 ${t.length} 字，已截断)` : t;
}

function mergeUsage(a, b) {
  if (!a) return b;
  if (!b) return a;
  const g = (o, k) => Number(o?.[k] || 0);
  return {
    prompt_tokens: g(a, 'prompt_tokens') + g(b, 'prompt_tokens'),
    completion_tokens: g(a, 'completion_tokens') + g(b, 'completion_tokens'),
    total_tokens: g(a, 'total_tokens') + g(b, 'total_tokens'),
  };
}

// 把进度转成主会话 SSE 上的一条 subagent 事件（host 没有通道时静默丢弃）
function emit(id, phase, payload) {
  let chat_id = null;
  try { chat_id = rowOf(id)?.parent_chat_id || null; } catch (e) { /* 记录可能已被删 */ }
  try { host?.emitSubagent?.(Object.assign({ id, phase, chat_id }, payload)); } catch (e) { /* 进度丢了不影响执行 */ }
}

function finish(id, status, result, error) {
  patch(id, {
    status, result, error,
    finished_at: new Date().toISOString().replace('T', ' ').substring(0, 19),
  });
  const h = live.get(id);
  if (h) h.status = status;
  emit(id, status === 'done' ? 'done' : 'failed', { result: String(result || '').slice(0, 400), error });
}

/** 跑一个子智能体直到出结论（或被停 / 超时 / 到步数上限） */
async function drive(id) {
  const rec = rowOf(id);
  if (!rec) return { error: `子智能体 ${id} 不存在` };
  const handle = live.get(id);
  if (!handle) return { error: `子智能体 ${id} 未在运行` };

  const model = resolveModel(rec.model_id, rec.parent_chat_id);
  if (model.error) { finish(id, 'failed', '', model.error); return { error: model.error }; }
  const modelRow = model.row;
  const tools = buildToolList(modelRow);
  // 子智能体是在项目里替主 Agent 查东西的人，项目/全局的 AGENTS.md 规矩它也得守。
  // 项目根按父会话查（cwd 可能只是项目里的一个子目录，只按 cwd 就近取会漏掉项目那份）。
  const agentsBlock = agentsMd.promptBlock(agentsMd.collect(projectRootOfChat(rec.parent_chat_id), rec.cwd));
  const messages = [{ role: 'system', content: SYS_PROMPT + (agentsBlock ? `\n\n${agentsBlock}` : '') }, { role: 'user', content: rec.task }];
  const steps = [];
  let usage = null;
  let final = '';

  patch(id, { status: 'running', model_id: modelRow.model_id });
  handle.status = 'running';
  emit(id, 'start', { name: rec.name, model: modelRow.model_id, task: rec.task.slice(0, 160) });
  const timer = setTimeout(() => { try { handle.controller.abort(); } catch (e) {} }, LIMITS.timeoutMs);

  try {
    for (let i = 0; i < LIMITS.maxSteps; i++) {
      if (handle.status === 'killed') break;
      patch(id, { iter: i + 1 });
      const r = await callOnce({ modelRow, messages, tools, signal: handle.controller.signal });
      if (r.error) {
        const msg = `第 ${i + 1} 步请求失败：${r.error}`;
        finish(id, 'failed', final, msg);
        return { error: msg };
      }
      if (r.usage) usage = mergeUsage(usage, r.usage);
      if (!r.toolCalls.length) { final = (r.content || '').trim(); break; }

      messages.push({
        role: 'assistant',
        content: r.content || '',
        tool_calls: r.toolCalls.map(c => ({
          id: c.id, type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
        })),
      });
      for (const c of r.toolCalls) {
        if (handle.status === 'killed') break;
        emit(id, 'tool', { tool: c.name, args: c.args });
        steps.push({ type: 'tool', name: c.name, args: c.args });
        const res = await runTool(c, rec);
        const text = capText(toolText(res), 12000);
        steps.push({ type: 'result', name: c.name, output: res?.output ? text : undefined, error: res?.error || undefined });
        patch(id, { steps_json: JSON.stringify(steps.slice(-200)) });
        messages.push({ role: 'tool', tool_call_id: c.id, content: text });
      }
      if (i === LIMITS.maxSteps - 1) final = '（已达子智能体步数上限）\n' + (r.content || '');
    }
  } catch (e) {
    const killed = handle.status === 'killed' || String(e?.name || '') === 'AbortError';
    const msg = killed ? '被停止或超时' : String(e?.message || e).substring(0, 300);
    finish(id, killed ? 'killed' : 'failed', final, msg);
    return { error: msg, killed };
  } finally {
    clearTimeout(timer);
    live.delete(id);
  }

  if (!final) final = '（子智能体没有产出结论就被中断了）';
  const capped = capText(final, LIMITS.resultChars);
  patch(id, { usage_json: usage ? JSON.stringify(usage) : '' });
  finish(id, 'done', capped, '');
  return { result: capped, usage };
}

function toolText(res) {
  if (!res || typeof res !== 'object') return String(res ?? '');
  if (res.error) return `错误：${res.error}`;
  const parts = [];
  if (res.output !== undefined) parts.push(String(res.output));
  if (Array.isArray(res.diff)) parts.push(`[diff ${res.diff.length} 行]`);
  return parts.join('\n') || '(无输出)';
}

// 子智能体的工具执行：一律带 readonlyMode，写类工具在 execTool 里就被挡下
const MUTATING_BUILTINS = new Set([
  'run_command', 'write_file', 'edit_file', 'delete_file', 'delete_dir', 'create_dir', 'rename_file',
]);
async function runTool(call, rec) {
  if (!host?.execTool) return { error: '子智能体宿主未就绪（host 未注入）' };
  // 先解析别名再判定：否则将来给某个写工具加了别名，就能绕过下面的白名单
  const name = (host.resolveToolName ? host.resolveToolName(call.name) : call.name);
  if (name.startsWith('agent_')) {
    return { error: `子智能体不能再派子智能体（${name} 被拒绝）。需要更多人手请把任务拆清后由主 Agent 安排。` };
  }
  if (MUTATING_BUILTINS.has(name)) {
    return { error: `子智能体是只读的，没有 ${name}。把「该改哪里、改成什么」写进结论交回主 Agent，由它执行。` };
  }
  if (GATE_DENY.has(name)) {
    return { error: `子智能体不允许使用工具 ${name}。需要改动或长任务的话，写进结论交回主 Agent。` };
  }
  if (!BUILTIN_ALLOW.has(name)) {
    // 非内置白名单：只允许「已启用的扩展工具」
    let known = false;
    try { const tg = require('./toolgate'); known = tg.isEnabled(name); } catch (e) { known = false; }
    if (!known) return { error: `子智能体没有工具「${name}」。可用：read_file / list_dir / grep / glob / web_fetch / load_skill 与已启用的只读扩展工具。` };
  }
  try {
    return await host.execTool(name, call.args || {}, rec.cwd, null, null, true, 'exempt', rec.parent_chat_id, {});
  } catch (e) {
    return { error: `工具 ${name} 执行异常：${String(e?.message || e).substring(0, 200)}` };
  }
}

// ---------- 对外 API（工具层与右栏面板共用） ----------

function create({ name, task, model, cwd, chatId }) {
  ensureTable();
  const body = String(task ?? '').trim();
  if (!body) return { error: 'task 不能为空：说清楚要子智能体查什么、产出什么。' };
  if (runningCount() >= LIMITS.maxParallel) {
    return { error: `同时在跑的子智能体已达上限（${LIMITS.maxParallel} 个）。等其中一个结束再派，或改用 agent_run 串行执行。` };
  }
  const id = newId(name);
  const taskCap = body.length > LIMITS.taskChars ? body.substring(0, LIMITS.taskChars) + '\n…(任务过长已截断)' : body;
  db.prepare(`INSERT INTO ai_subagents (id, parent_chat_id, name, task, status, model_id, cwd)
    VALUES (?, ?, ?, ?, 'queued', ?, ?)`)
    .run(id, chatId || null, slug(name, 'agent'), taskCap, String(model ?? '').trim(), String(cwd || host?.defaultCwd || process.cwd()));
  return { id };
}

function start(id) {
  const rec = rowOf(id);
  if (!rec) return { error: `子智能体 ${id} 不存在` };
  if (live.has(id)) return { error: `子智能体 ${id} 已经在跑了` };
  const handle = { controller: new AbortController(), status: 'queued' };
  live.set(id, handle);
  const p = drive(id);
  handle.promise = p;
  return { ok: true, promise: p, name: rec.name };
}

/** 异步派发：立刻返回 id，主 Agent 可以继续干别的，之后用 agent_wait 收结果 */
function spawn(opts) {
  const c = create(opts);
  if (c.error) return c;
  const s = start(c.id);
  if (s.error) { remove(c.id); return s; }
  return { id: c.id, name: rowOf(c.id)?.name || '' };
}

/** 同步执行：派出去并等它出结论（最常用） */
async function runSync(opts, waitMs) {
  const c = create(opts);
  if (c.error) return c;
  const s = start(c.id);
  if (s.error) { remove(c.id); return s; }
  const cap = Math.min(Number(waitMs) || LIMITS.timeoutMs, LIMITS.timeoutMs);
  const winner = await Promise.race([
    s.promise.then(r => ({ kind: 'done', r })),
    new Promise(res => setTimeout(() => res({ kind: 'timeout' }), cap)),
  ]);
  if (winner.kind === 'timeout') {
    return { pending: true, id: c.id, message: `子智能体 ${c.id} 还在跑（已等 ${Math.round(cap / 1000)} 秒）。用 agent_wait("${c.id}") 继续等，或 agent_kill("${c.id}") 停掉。` };
  }
  const rec = rowOf(c.id) || {};
  if (winner.r?.error) return { id: c.id, error: winner.r.error, status: rec.status };
  return { id: c.id, name: rec.name, status: rec.status, result: winner.r?.result || rec.result || '' };
}

/** 等一个已派发的子智能体出结果 */
async function wait(id, timeoutMs) {
  ensureTable();
  const rec = rowOf(id);
  if (!rec) return { error: `子智能体 ${id} 不存在。用 agent_list 看有哪些。` };
  const cap = Math.min(Number(timeoutMs) || 120000, LIMITS.timeoutMs);
  const deadline = Date.now() + cap;
  while (Date.now() < deadline) {
    const cur = rowOf(id);
    if (cur && ['done', 'failed', 'killed'].includes(cur.status)) {
      return {
        id, name: cur.name, status: cur.status,
        result: cur.status === 'done' ? cur.result : '',
        error: cur.error || undefined,
      };
    }
    await new Promise(r => setTimeout(r, 700));
  }
  const now = rowOf(id);
  return { pending: true, id, status: now?.status || 'running', iter: now?.iter || 0, message: `等了 ${Math.round(cap / 1000)} 秒还没结束（已跑 ${now?.iter || 0} 步）。再等用 agent_wait("${id}")。` };
}

function list(chatId) {
  ensureTable();
  const rows = allRows(200);
  const scoped = chatId ? rows.filter(r => r.parent_chat_id === chatId) : rows;
  return scoped.map(r => ({
    id: r.id, name: r.name, status: r.status, model: r.model_id,
    task: r.task.length > 120 ? r.task.slice(0, 120) + '…' : r.task,
    iter: r.iter, created_at: r.created_at, finished_at: r.finished_at,
    running: live.has(r.id),
    result_preview: r.result ? r.result.slice(0, 160) : '',
    error: r.error || '',
    steps: (() => { try { return JSON.parse(r.steps_json || '[]').length; } catch (e) { return 0; } })(),
  }));
}

function detail(id) {
  const r = rowOf(id);
  if (!r) return { error: `子智能体 ${id} 不存在` };
  let steps = [];
  try { steps = JSON.parse(r.steps_json || '[]'); } catch (e) { steps = []; }
  return Object.assign({}, r, { running: live.has(id), steps });
}

function kill(id) {
  const h = live.get(id);
  const rec = rowOf(id);
  if (!rec) return { error: `子智能体 ${id} 不存在` };
  if (!h) return { ok: true, already: true, message: `子智能体 ${id} 已经结束了（状态 ${rec.status}），无需停止。` };
  h.status = 'killed';
  try { h.controller.abort(); } catch (e) { /* 已结束 */ }
  patch(id, { status: 'killed', error: '用户或主 Agent 主动停止' });
  return { ok: true, message: `已请求停止子智能体 ${id}` };
}

function remove(id) {
  ensureTable();
  kill(id);
  try { db.prepare('DELETE FROM ai_subagents WHERE id = ?').run(id); } catch (e) { /* 忽略 */ }
  live.delete(id);
  return { ok: true, message: `已删除子智能体 ${id} 的记录` };
}

/** 给主 Agent 的汇报文本 */
function report(r) {
  if (r.error) return `子智能体失败：${r.error}`;
  if (r.pending) return r.message;
  const head = `【子智能体 ${r.name || r.id} · ${r.status}】`;
  return `${head}\n${r.result || '(无结论)'}`;
}

module.exports = {
  setHost, ensureTable,
  create, start, spawn, runSync, wait, list, detail, kill, remove, report,
  BUILTIN_ALLOW, LIMITS,
};
