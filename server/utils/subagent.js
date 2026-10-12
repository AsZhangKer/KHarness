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
//   3) 只有超时与「按会话」的并发上限；**不设步数上限、不截断文本**（第七十五轮他定的）——
//      跑飞的兜底靠超时、主会话停止时的连带 kill，以及工具自身（read_file/grep）已有的分页上限。
'use strict';

const { db } = require('../database');
const proxylayer = require('./proxy');
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
  timeoutMs: 600000,       // 10 分钟：唯一的时间兜底，跑飞的子智能体不能永远烧额度
};

/* 并发上限挪到「选项 → 设置 → 常规 → 子智能体并发上限」（键 subagent_max_parallel）。
   第七十五轮它是写死的 4，他要按机器情况调；0 = 不限。
   每次派发现读一次（一条 SQLite 查询），改完不用重启，也和后台任务那些设置项一个口径。 */
const DEFAULT_MAX_PARALLEL = 5;
function maxParallelPerChat() {
  try {
    const v = db.prepare('SELECT value FROM settings WHERE key = ?').get('subagent_max_parallel')?.value;
    if (v === undefined || v === null || v === '') return DEFAULT_MAX_PARALLEL;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? n : DEFAULT_MAX_PARALLEL;
  } catch (e) { return DEFAULT_MAX_PARALLEL; }   // 老库连这一行都还没种过
}

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
      finished_at DATETIME,
      delivered INTEGER NOT NULL DEFAULT 0
    )`).run();
    // 老库补这一列：这张表由本文件的 ensureTable 管（不在 database.js 的迁移清单里），
    // 所以新增列只能在这里补；duplicate column 就是「已经有了」，属于正常路径
    try { db.prepare('ALTER TABLE ai_subagents ADD COLUMN delivered INTEGER NOT NULL DEFAULT 0').run(); } catch (e) { /* 已有 */ }
  } catch (e) { /* 建表失败时上层按空处理 */ }
}

// 运行中的句柄：id -> { controller, promise, status, chatId }
const live = new Map();
// 当场等结果的消费者（agent_wait）：id -> 计数。有人等着拿结论时就不再往会话里补一条重复的汇报消息
const waiting = new Map();

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

/**
 * 轨迹全量落库（不再只留最后 200 条）：弹窗要看的就是这份，一步都不该少。
 * 单条工具结果也不截断了 —— 主 Agent 那边本来就有 read_file/grep 自己的分页上限。
 */
function saveSteps(id, steps) {
  patch(id, { steps_json: JSON.stringify(steps) });
}

/**
 * 在跑的子智能体数量。传 chatId 就只数这条会话派出去的 —— 以前数的是全局，
 * 于是 A 会话占满两颗就把 B 会话的派发也挡了（和后台任务那一族同一个形状）。
 */
function runningCount(chatId) {
  const c = Number(chatId) || null;
  // 按「还在 live 里」数，不按 status==='running'：连着派两颗时同一拍里都还是 queued，
  // 只数 running 会让上限形同虚设
  return [...live.values()].filter((h) => !c || Number(h.chatId) === c).length;
}

/** 当场等这份结果的人拿走了它：finish 时就不再往会话里补一条汇报消息 */
function takeDelivery(id) {
  const n = waiting.get(String(id)) || 0;
  if (n <= 0) return false;
  if (n === 1) waiting.delete(String(id));
  else waiting.set(String(id), n - 1);
  return true;
}
function noteWaiting(id) { waiting.set(String(id), (waiting.get(String(id)) || 0) + 1); }
function undoWaiting(id) { const n = (waiting.get(String(id)) || 0) - 1; if (n <= 0) waiting.delete(String(id)); else waiting.set(String(id), n); }

function slug(raw, fallback) {
  const s = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-').replace(/^-|-$/g, '');
  return (s || fallback || 'agent').substring(0, 40);
}

function newId(name) {
  return 'sa-' + slug(name, 'agent').replace(/[^a-z0-9_-]/g, '').substring(0, 16) + '-' + crypto.randomBytes(3).toString('hex');
}

/**
 * 名称不许为空（第七十六轮定的侧栏卡片只显名称）：模型没起名字就从任务第一行摘一段。
 * 以前空名一律落成 "agent"，一个会话里派几路就全叫 agent，卡片上根本分不出是哪一路。
 */
function deriveName(name, task) {
  const n = String(name || '').trim();
  if (n) return slug(n, 'agent');
  const first = String(task || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
  return slug(first, 'agent');
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
  return proxylayer.proxyFor(row);
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

/**
 * 子智能体跑完怎么把结论交回主 Agent（第七十七轮他改的口径）。
 *
 * 以前是往会话里插一条 `role:'user' + speaker:'subagent'` 的消息 —— 下一轮上文确实带得上，
 * 但那等于「替用户说了一句模型没听过的话」，界面上还多出一个凭空的气泡。
 * 现在按他说的做：像工具返回值一样直接交回，不占消息表。
 * 落库只记状态与结论（`ai_subagents`），另用 `delivered` 标记「有没有已经交回过」；
 * 由 routes/ai.js 在构建上文时把没交回的那些拼成一条回执给模型（界面不画）。
 * 有人（agent_wait）正当场等这份结果，就算已交回，不再重复补。
 */
function notifyParent(id) {
  const rec = rowOf(id);
  // 当场被 agent_wait 取走、或这路根本没有归属（没有会话来消费这份交回）→ 直接标已交回，不进待交回队列
  if (takeDelivery(id) || !Number(rec?.parent_chat_id)) markDelivered(id);
}

function markDelivered(id) {
  try { db.prepare('UPDATE ai_subagents SET delivered = 1 WHERE id = ?').run(String(id)); } catch (e) { /* 旧库无列 */ }
}

/**
 * 取出「这条会话已结束、但还没交回过」的子智能体结论，并把它们标成交回过（一次消费一次生效）。
 * routes/ai.js 在两处用它：构建跨轮上文时、以及本轮工具结果回喂完的安全边界 ——
 * 交回的形状是一条工具回执式的合成消息，不落 `ai_chat_messages`，所以界面上没有气泡。
 */
function takeDeliveries(chatId) {
  const c = Number(chatId);
  if (!Number.isInteger(c) || c < 1) return '';
  ensureTable();
  let rows = [];
  try {
    rows = db.prepare(
      "SELECT id, name, status, result, error FROM ai_subagents WHERE parent_chat_id = ? AND delivered = 0 AND status IN ('done','failed','killed') ORDER BY id ASC"
    ).all(c);
  } catch (e) { return ''; }
  if (!rows.length) return '';
  for (const r of rows) markDelivered(r.id);
  const one = (r) => {
    const label = r.status === 'done' ? '已完成' : r.status === 'killed' ? '被停止' : '失败';
    return `【子智能体 ${r.name || r.id} ${label}】(id=${r.id})\n${(r.status === 'done' ? (r.result || '(无结论)') : (r.error || '未产出结论'))}`;
  };
  return '[子智能体交回的返回]\n' + rows.map(one).join('\n\n').substring(0, 60000) +
    '\n（以上是你在上一轮派出去的分身交回的返回，不是用户说的话。要继续用就把结论并进你接下来的动作，不要重复派发同一件事。）';
}

function finish(id, status, result, error) {
  patch(id, {
    status, result, error,
    finished_at: new Date().toISOString().replace('T', ' ').substring(0, 19),
  });
  const h = live.get(id);
  if (h) h.status = status;
  notifyParent(id);
  // result 原样带过去（不再截 400 字）：正把它显示在卡片上的那个人要看全文
  emit(id, status === 'done' ? 'done' : status === 'killed' ? 'killed' : 'failed', { result, error });
}

/** 跑一个子智能体直到出结论（或被停 / 超时）。没有步数上限：它想查几轮就查几轮 */
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
  emit(id, 'start', { name: rec.name, model: modelRow.model_id, task: rec.task });
  const timer = setTimeout(() => { try { handle.controller.abort(); } catch (e) {} }, LIMITS.timeoutMs);

  try {
    for (let i = 0; ; i++) {
      if (handle.status === 'killed') break;
      patch(id, { iter: i + 1 });
      const r = await callOnce({ modelRow, messages, tools, signal: handle.controller.signal });
      if (r.error) {
        const msg = `第 ${i + 1} 步请求失败：${r.error}`;
        saveSteps(id, steps);
        finish(id, 'failed', final, msg);
        return { error: msg };
      }
      if (r.usage) usage = mergeUsage(usage, r.usage);
      // 正文也要进轨迹：弹窗要看的就是「它这一轮说了什么、跑了哪些工具」，
      // 只存工具名的话翻回去等于只看得到一串名字（他第七十五轮点名的缺口）
      if (r.content) steps.push({ type: 'text', text: r.content });
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
        const text = toolText(res);
        steps.push({ type: 'result', name: c.name, output: res?.output ? text : undefined, error: res?.error || undefined });
        saveSteps(id, steps);
        messages.push({ role: 'tool', tool_call_id: c.id, content: text });
      }
    }
  } catch (e) {
    const killed = handle.status === 'killed' || String(e?.name || '') === 'AbortError';
    const msg = killed ? '被停止或超时' : String(e?.message || e).substring(0, 300);
    saveSteps(id, steps);
    finish(id, killed ? 'killed' : 'failed', final, msg);
    return { error: msg, killed };
  } finally {
    clearTimeout(timer);
    live.delete(id);
  }

  // 循环是「被停止」主动 break 出来的：这条路必须落在 killed 上，不能顺着走到下面报成 done
  // （以前 kill 写了 killed，循环自己退出来又把它改写成「已完成」，界面上就变成「停掉了但说它跑完了」）
  if (handle.status === 'killed') {
    saveSteps(id, steps);
    finish(id, 'killed', final, '被停止或超时');
    return { error: '被停止或超时', killed: true };
  }

  if (!final) final = '（子智能体没有产出结论就被中断了）';
  // 最后那段正文后面不会再有工具调用，也就没人再写轨迹 —— 收尾必须补一次，
  // 否则弹窗翻回去看不到「它最后说了什么」（测试里那 30 vs 31 段就是这么露出来的）
  saveSteps(id, steps);
  patch(id, { usage_json: usage ? JSON.stringify(usage) : '' });
  finish(id, 'done', final, '');
  return { result: final, usage };
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
  const c = Number(chatId) || null;
  const cap = maxParallelPerChat();
  if (c && cap > 0 && runningCount(c) >= cap) {
    return { error: `本会话同时在跑的子智能体已达上限（${cap} 个，可在「设置 → 常规 → 子智能体并发上限」调整，0 = 不限）。等其中一个结束再派，或用 agent_kill 停掉不要的那路。` };
  }
  const finalName = deriveName(name, body);
  const id = newId(finalName);
  db.prepare(`INSERT INTO ai_subagents (id, parent_chat_id, name, task, status, model_id, cwd)
    VALUES (?, ?, ?, ?, 'queued', ?, ?)`)
    .run(id, c, finalName, body, String(model ?? '').trim(), String(cwd || host?.defaultCwd || process.cwd()));
  return { id };
}

function start(id) {
  const rec = rowOf(id);
  if (!rec) return { error: `子智能体 ${id} 不存在` };
  if (live.has(id)) return { error: `子智能体 ${id} 已经在跑了` };
  const handle = { controller: new AbortController(), status: 'queued', chatId: Number(rec.parent_chat_id) || null };
  live.set(id, handle);
  const p = drive(id);
  handle.promise = p;
  return { ok: true, promise: p, name: rec.name };
}

/** 异步派发：立刻返回 id，主 Agent 可以继续干别的；结束时结论会自己回到会话里 */
function spawn(opts) {
  const c = create(opts);
  if (c.error) return c;
  const s = start(c.id);
  if (s.error) { remove(c.id); return s; }
  return { id: c.id, name: rowOf(c.id)?.name || '' };
}

/**
 * 等一个已派发的子智能体出结果。
 * 这一路是「当场就要」，所以标记一下：结论由这次调用拿走，finish 就不再往会话里补一条重复汇报。
 */
async function wait(id, timeoutMs) {
  ensureTable();
  const rec = rowOf(id);
  if (!rec) return { error: `子智能体 ${id} 不存在。用 agent_list 看有哪些。` };
  const cap = Math.min(Number(timeoutMs) || 120000, LIMITS.timeoutMs);
  const already = ['done', 'failed', 'killed'].includes(rec.status);
  if (!already) noteWaiting(id);
  try {
    const deadline = Date.now() + cap;
    while (Date.now() < deadline) {
      const cur = rowOf(id);
      if (cur && ['done', 'failed', 'killed'].includes(cur.status)) {
        if (!already) takeDelivery(id);
        return {
          id, name: cur.name, status: cur.status,
          result: cur.status === 'done' ? cur.result : '',
          error: cur.error || undefined,
        };
      }
      await new Promise(r => setTimeout(r, 700));
    }
  } finally {
    if (!already) undoWaiting(id);
  }
  const now = rowOf(id);
  return { pending: true, id, status: now?.status || 'running', iter: now?.iter || 0, message: `等了 ${Math.round(cap / 1000)} 秒还没结束（已跑 ${now?.iter || 0} 步）。再等用 agent_wait("${id}")；它结束时结论也会自己回到本会话。` };
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

/** 归属：无主记录（试跑那类没带会话）谁都看得见管得了；有主的只认起它的那条会话 */
function ownedBy(rec, chatId) {
  if (!rec) return false;
  const owner = Number(rec.parent_chat_id) || null;
  const c = Number(chatId) || null;
  return !c || !owner || owner === c;
}

function kill(id, chatId) {
  const rec = rowOf(id);
  if (!rec) return { error: `子智能体 ${id} 不存在` };
  if (!ownedBy(rec, chatId)) {
    return { error: `子智能体「${id}」不是本会话派出去的（它属于会话 ${rec.parent_chat_id}）。子智能体按会话隔离：本会话的清单里没有它，也停不了它。` };
  }
  const h = live.get(id);
  if (!h) return { ok: true, already: true, message: `子智能体 ${id} 已经结束了（状态 ${rec.status}），无需停止。` };
  h.status = 'killed';
  try { h.controller.abort(); } catch (e) { /* 已结束 */ }
  patch(id, { status: 'killed', error: '用户或主 Agent 主动停止' });
  return { ok: true, message: `已请求停止子智能体 ${id}` };
}

/**
 * 主会话被停止时连带把自己的子智能体全部中止（他第七十五轮要的那条）。
 * 以前父回合的 abort 完全不碰这张 live 表：上游流断了，工具还在替它跑、还在烧额度。
 * 只按 parent_chat_id 挑，别的会话的一颗都不动。
 */
function killChat(chatId) {
  const c = Number(chatId) || null;
  if (!c) return { killed: [] };
  const ids = [...live.entries()].filter(([, h]) => Number(h.chatId) === c).map(([id]) => id);
  for (const id of ids) kill(id, c);
  return { killed: ids };
}

function remove(id, chatId) {
  ensureTable();
  const rec = rowOf(id);
  if (rec && !ownedBy(rec, chatId)) {
    return { error: `子智能体「${id}」不属于本会话，删不掉（它属于会话 ${rec.parent_chat_id}）。` };
  }
  kill(id, chatId);
  try { db.prepare('DELETE FROM ai_subagents WHERE id = ?').run(id); } catch (e) { /* 忽略 */ }
  live.delete(id);
  return { ok: true, message: `已删除子智能体 ${id} 的记录` };
}

module.exports = {
  setHost, ensureTable,
  create, start, spawn, wait, list, detail, kill, killChat, remove,
  BUILTIN_ALLOW, LIMITS, maxParallelPerChat, DEFAULT_MAX_PARALLEL, takeDeliveries,
};
