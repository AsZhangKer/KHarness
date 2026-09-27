// 侧栏提问（Sidebar AI）：主 Agent 正在跑活的时候，另开一条**只读**的小对话问问题，
// 不占用主会话的上下文，也不打断主会话。
//
// 与子智能体（subagent.js）的关系：同一套「嵌套 ReAct + 复用 execTool」的路子，
// 但边界更紧、形态不同 ——
//   1) 工具白名单只有 read_file / list_dir / grep / glob / web_fetch。
//      写文件、执行命令、后台任务、ask_user、技能加载、扩展工具、MCP 工具一律不进清单。
//   2) 可读范围**硬锁在工作目录内**：把 cwd 当作 projectRoot 传给 execTool，
//      复用 guardTargetPath 的 realpath 校验，`../` 与符号链接逃逸都过不去。
//      （子智能体没有这一条：自由会话下它能读到 cwd 外面去。）
//   3) 形态是多轮对话：线程与消息落库，流式出字，随时可停。
'use strict';

const { db } = require('../database');
const protocols = require('./protocols');
const agentsMd = require('./agentsmd');

/** 侧栏用的 AGENTS.md 段：只按工作目录就近取（侧栏没有「项目根」这个概念） */
function agentsBlockFor(cwd) {
  const block = agentsMd.promptBlock(agentsMd.collect('', cwd));
  return block ? `\n\n${block}` : '';
}

// routes/ai.js 启动时注入；本模块绝不反向 require ai.js（会成环）
let host = null;
function setHost(h) { host = h; }

const TOOL_ALLOW = new Set(['read_file', 'list_dir', 'grep', 'glob', 'web_fetch']);

const LIMITS = {
  maxSteps: 12,          // 一次提问最多请求模型几轮
  historyChars: 60000,   // 带给模型的历史长度上限
  toolResultChars: 12000,
  questionChars: 6000,
  titleChars: 30,
};

/* ---------------- 表 ---------------- */

function ensureTables() {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS ai_sidebar_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT '',
      cwd TEXT NOT NULL DEFAULT '',
      model_row_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`).run();
    db.prepare(`CREATE TABLE IF NOT EXISTS ai_sidebar_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content TEXT NOT NULL,
      steps_json TEXT NOT NULL DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (thread_id) REFERENCES ai_sidebar_threads(id) ON DELETE CASCADE
    )`).run();
  } catch (e) { /* 建表失败时上层按空处理 */ }
}

/* ---------------- 线程与消息 ---------------- */

function listThreads(limit = 50) {
  ensureTables();
  try {
    return db.prepare(`
      SELECT t.id, t.title, t.cwd, t.model_row_id, t.created_at, t.updated_at,
             (SELECT COUNT(*) FROM ai_sidebar_messages m WHERE m.thread_id = t.id) AS msg_count,
             (SELECT m.content FROM ai_sidebar_messages m WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_message
      FROM ai_sidebar_threads t ORDER BY t.updated_at DESC, t.id DESC LIMIT ?
    `).all(limit).map((t) => ({
      ...t,
      last_message: String(t.last_message || '').substring(0, 80),
      model_name: t.model_row_id ? (db.prepare('SELECT display_name FROM ai_models WHERE id = ?').get(t.model_row_id)?.display_name || '') : '',
    }));
  } catch (e) { return []; }
}

function threadWithMessages(id) {
  ensureTables();
  const t = db.prepare('SELECT * FROM ai_sidebar_threads WHERE id = ?').get(Number(id));
  if (!t) return { error: '侧栏会话不存在' };
  let messages = [];
  try {
    messages = db.prepare('SELECT id, role, content, steps_json, created_at FROM ai_sidebar_messages WHERE thread_id = ? ORDER BY id ASC').all(t.id)
      .map((m) => {
        let steps = [];
        try { steps = JSON.parse(m.steps_json || '[]'); } catch (e) { steps = []; }
        return { id: m.id, role: m.role, content: m.content, steps, created_at: m.created_at };
      });
  } catch (e) { messages = []; }
  return { thread: t, messages };
}

function createThread({ title, cwd, modelRowId } = {}) {
  ensureTables();
  const t = String(title || '').trim().substring(0, LIMITS.titleChars) || '新提问';
  const root = String(cwd || host?.defaultCwd || process.cwd());
  const r = db.prepare('INSERT INTO ai_sidebar_threads (title, cwd, model_row_id) VALUES (?, ?, ?)')
    .run(t, root, Number(modelRowId) > 0 ? Number(modelRowId) : null);
  return { id: Number(r.lastInsertRowid), title: t, cwd: root, model_row_id: Number(modelRowId) || null };
}

function touchThread(id, fields = {}) {
  const set = ['updated_at = CURRENT_TIMESTAMP'];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!['title', 'cwd', 'model_row_id'].includes(k)) continue;
    set.push(`${k} = ?`);
    vals.push(v);
  }
  try { db.prepare(`UPDATE ai_sidebar_threads SET ${set.join(', ')} WHERE id = ?`).run(...vals, Number(id)); } catch (e) { /* 忽略 */ }
}

function renameThread(id, title) {
  const t = String(title || '').trim().substring(0, LIMITS.titleChars);
  if (!t) return { error: '标题不能为空' };
  touchThread(id, { title: t });
  return { ok: true };
}

function deleteThread(id) {
  ensureTables();
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return { error: '缺少 thread_id' };
  try {
    db.prepare('DELETE FROM ai_sidebar_messages WHERE thread_id = ?').run(n);
    db.prepare('DELETE FROM ai_sidebar_threads WHERE id = ?').run(n);
  } catch (e) { return { error: `删除失败：${e.message}` }; }
  return { ok: true };
}

function appendMessage(threadId, role, content, steps) {
  try {
    const r = db.prepare('INSERT INTO ai_sidebar_messages (thread_id, role, content, steps_json) VALUES (?, ?, ?, ?)')
      .run(Number(threadId), role, String(content || '').substring(0, 50000), steps ? JSON.stringify(steps.slice(-120)) : '[]');
    return Number(r.lastInsertRowid);
  } catch (e) { return 0; }
}

/* ---------------- 模型 ---------------- */

const MODEL_SELECT = `
  SELECT m.id AS row_id, m.model_id, m.display_name,
         p.base_url, p.api_key, p.proxy_enabled, p.proxy_host, p.proxy_port,
         p.api_style, p.max_tokens, p.custom
  FROM ai_models m JOIN ai_providers p ON m.provider_id = p.id
`;

function resolveModel(hint, thread) {
  const key = String(hint ?? '').trim();
  if (key) {
    const row = db.prepare(MODEL_SELECT + ' WHERE m.id = ? OR m.model_id = ? OR m.display_name = ? ORDER BY m.id ASC LIMIT 1')
      .get(Number(key) || -1, key, key);
    if (row) return { row };
    return { error: `找不到模型「${key}」，到「模型」页确认它还在。` };
  }
  if (thread?.model_row_id) {
    const row = db.prepare(MODEL_SELECT + ' WHERE m.id = ?').get(thread.model_row_id);
    if (row) return { row };
  }
  const row = db.prepare(MODEL_SELECT + ' ORDER BY m.id ASC LIMIT 1').get();
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

/* ---------------- 提示词与工具 ---------------- */

const SYS_PROMPT = (cwd) => [
  '你是 KHarness 界面右侧「侧栏提问」里的助手。用户在这里问问题，通常是因为主 Agent 正在干活，' +
  '他不想打断主任务，也不想把这个问题塞进主会话的上下文。',
  '',
  '能力边界（硬性，尝试越界只会被拒绝）：',
  `- 只能读工作目录 ${cwd} 以内的文件：read_file / list_dir / grep / glob。越出该目录（含 .. 与符号链接）会被直接拒绝。`,
  '- 可以抓网页：web_fetch。',
  '- 没有写文件、删文件、执行命令、起后台任务的能力；也没有技能、扩展工具、MCP 工具；不能向用户提问，也不能派子智能体。',
  '- 需要改动时不要绕路硬试，直接说清「该改哪个文件、改成什么」，让用户交给主 Agent 执行。',
  '',
  '回答纪律：',
  '- 短、直给。先答结论，再给依据（引用代码时给 路径:行号 和必要片段，不要整文件粘贴）。',
  '- 不确定就说不确定以及缺什么；绝不编造文件内容或行号。',
  '- 用中文回答，除非用户用别的语言。',
].join('\n');

function toolDefs() {
  if (!host?.builtinToolDefs) return [];
  return host.builtinToolDefs(TOOL_ALLOW).filter((t) => TOOL_ALLOW.has(t.function?.name));
}

function resultText(res) {
  if (!res || typeof res !== 'object') return String(res ?? '');
  if (res.error) return `错误：${res.error}`;
  const parts = [];
  if (res.output !== undefined) parts.push(String(res.output));
  return parts.join('\n') || '(无输出)';
}

function cap(s, n) {
  const t = String(s ?? '');
  return t.length > n ? t.substring(0, n) + `\n…(共 ${t.length} 字，已截断)` : t;
}

/**
 * 侧栏的工具执行：白名单 + 硬锁工作目录。
 * 把 cwd 当 projectRoot 传给 execTool，guardTargetPath 就会用 realpath 校验
 * 目标必须落在 cwd 内，`../` 和符号链接逃逸一起挡掉；readonlyMode 再兜一层。
 */
async function execGuarded(rawName, args, cwd) {
  const name = host?.resolveToolName ? host.resolveToolName(rawName) : rawName;
  if (!TOOL_ALLOW.has(name)) {
    return { error: `侧栏提问是只读的，没有工具「${rawName}」。可用：read_file / list_dir / grep / glob / web_fetch。需要改动请把结论写清楚，交给主 Agent 执行。` };
  }
  if (!host?.execTool) return { error: '侧栏宿主未就绪（host 未注入）' };
  try {
    const res = await host.execTool(name, args || {}, cwd, null, cwd, true, 'exempt', null, {});
    // 越界提示借用了「项目会话」那套措辞（guardTargetPath 里写死的），
    // 对侧栏来说会让人误会，这里换成侧栏自己的说法，语义不变
    if (res && res.error && res.error.includes('项目会话只能操作项目目录内的路径')) {
      res.error = res.error
        .replace('项目会话只能操作项目目录内的路径', '侧栏提问只能读工作目录内的文件')
        .replace('不得通过符号链接或 .. 越出项目', '不得通过符号链接或 .. 越出工作目录')
        .replace('请始终使用项目内路径', '请改用工作目录内的路径');
    }
    return res;
  } catch (e) {
    return { error: `工具 ${name} 执行异常：${String(e?.message || e).substring(0, 200)}` };
  }
}

/* ---------------- 流式调用一次模型 ---------------- */

async function streamOnce({ modelRow, messages, tools, signal, onDelta, onToolName }) {
  const req = protocols.buildChatRequest(modelRow, {
    model: modelRow.model_id, messages, tools: tools.length ? tools : undefined, stream: true,
  });
  const resp = await fetch(req.url, {
    method: req.method, headers: req.headers, body: JSON.stringify(req.body),
    dispatcher: makeDispatcher(modelRow), signal,
  });
  if (!resp.ok) {
    const detail = (await resp.text().catch(() => '')).substring(0, 300);
    return { error: `HTTP ${resp.status}: ${detail}` };
  }
  const normalizeChunk = protocols.createChunkNormalizer(modelRow);
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let usage = null;
  const tcAcc = new Map();

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let json = null;
      try { json = normalizeChunk(JSON.parse(payload), payload); } catch (e) { continue; }
      if (!json) continue;
      if (json.error) return { error: `上游错误：${json.error.message || String(JSON.stringify(json.error)).substring(0, 200)}`, content };
      const delta = json.choices?.[0]?.delta;
      if (delta && typeof delta.content === 'string' && delta.content) {
        content += delta.content;
        if (onDelta) onDelta(delta.content);
      }
      if (delta && Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const acc = tcAcc.get(idx) || { id: '', name: '', args: '' };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name += tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
          tcAcc.set(idx, acc);
          if (onToolName) onToolName(acc.name);
        }
      }
      if (json.usage && typeof json.usage === 'object') {
        usage = {
          prompt_tokens: Number(json.usage.prompt_tokens) || 0,
          completion_tokens: Number(json.usage.completion_tokens) || 0,
          cached_tokens: Number(json.usage.prompt_tokens_details?.cached_tokens) || 0,
        };
      }
    }
  }

  const toolCalls = [...tcAcc.values()].filter((c) => c.name).map((c) => ({
    id: c.id || ('call_' + Math.random().toString(36).slice(2, 10)),
    name: c.name,
    args: (() => { try { return JSON.parse(c.args || '{}'); } catch (e) { return {}; } })(),
  }));
  return { content, toolCalls, usage };
}

/* ---------------- 一轮提问 ---------------- */

/**
 * 在侧栏线程里问一句。onEvent 收到 { t: 'delta'|'tool'|'tool_result'|'note'|'done'|'error', ... }。
 * signal 由上层在客户端断开时 abort。
 */
async function runTurn({ threadId, content, model, cwd, onEvent = () => {}, signal } = {}) {
  ensureTables();
  const emit = (e) => { try { onEvent(e); } catch (err) { /* 流已关 */ } };
  const q = String(content ?? '').trim();
  if (!q) return { error: '问题不能为空' };
  if (q.length > LIMITS.questionChars) return { error: `问题太长（上限 ${LIMITS.questionChars} 字）` };

  let thread = null;
  if (Number(threadId) > 0) thread = db.prepare('SELECT * FROM ai_sidebar_threads WHERE id = ?').get(Number(threadId));
  if (!thread) {
    const c = createThread({ title: q.substring(0, LIMITS.titleChars), cwd, modelRowId: Number(model) || null });
    thread = db.prepare('SELECT * FROM ai_sidebar_threads WHERE id = ?').get(c.id);
  }
  const root = String(cwd || thread.cwd || host?.defaultCwd || process.cwd());
  if (cwd && cwd !== thread.cwd) touchThread(thread.id, { cwd: root });

  const modelRes = resolveModel(model, thread);
  if (modelRes.error) { emit({ t: 'error', message: modelRes.error }); return { error: modelRes.error }; }
  const modelRow = modelRes.row;
  touchThread(thread.id, { model_row_id: modelRow.row_id });

  appendMessage(thread.id, 'user', q);
  emit({ t: 'chat', thread_id: thread.id, title: thread.title || q.substring(0, LIMITS.titleChars), model: modelRow.model_id, cwd: root });

  // 历史：从最新往回攒，超上限就丢掉更早的（整条丢，不截半句）
  const history = db.prepare('SELECT role, content FROM ai_sidebar_messages WHERE thread_id = ? ORDER BY id ASC').all(thread.id);
  const picked = [];
  let acc = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    acc += (history[i].content || '').length;
    if (acc > LIMITS.historyChars && picked.length) break;
    picked.unshift(history[i]);
  }

  const messages = [
    // 侧栏提问也是用户会看见的对话，得听同一份 AGENTS.md（语言 / 编码规矩）。
    // 侧栏线程全在本机（没有远程这条路），所以直接按工作目录就近取。
    { role: 'system', content: SYS_PROMPT(root) + agentsBlockFor(root) },
    ...picked.map((m) => ({ role: m.role, content: m.content })),
  ];
  const tools = toolDefs();
  const steps = [];
  let finalText = '';
  let usageTotal = null;

  for (let iter = 0; iter < LIMITS.maxSteps; iter += 1) {
    if (signal?.aborted) break;
    const r = await streamOnce({
      modelRow, messages, tools, signal,
      onDelta: (d) => emit({ t: 'delta', text: d }),
    }).catch((e) => {
      const msg = signal?.aborted || String(e?.name || '') === 'AbortError' ? '已取消' : String(e?.message || e).substring(0, 300);
      return { error: msg };
    });
    if (!r) break;
    if (r.error) {
      if (finalText) break;                       // 已经有正文：保住它，别整个失败
      emit({ t: 'error', message: `第 ${iter + 1} 步请求失败：${r.error}` });
      return { error: r.error, thread_id: thread.id };
    }
    if (r.usage) usageTotal = mergeUsage(usageTotal, r.usage);
    if (r.content) finalText = finalText ? finalText + r.content : r.content;
    if (!r.toolCalls.length) break;

    messages.push({
      role: 'assistant',
      content: r.content || '',
      tool_calls: r.toolCalls.map((c) => ({
        id: c.id, type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
      })),
    });
    for (const c of r.toolCalls) {
      if (signal?.aborted) break;
      emit({ t: 'tool', name: c.name, args: c.args });
      steps.push({ type: 'tool', name: c.name, args: c.args });
      const res = await execGuarded(c.name, c.args, root);
      const text = cap(resultText(res), LIMITS.toolResultChars);
      emit({ t: 'tool_result', name: c.name, ok: !res?.error, preview: text.substring(0, 400) });
      steps.push({ type: 'result', name: c.name, ok: !res?.error, preview: text.substring(0, 600) });
      messages.push({ role: 'tool', tool_call_id: c.id, content: text });
    }
  }

  if (!finalText.trim()) {
    finalText = signal?.aborted ? '（已停止，没有产出回答）' : '（这一轮没有产出正文）';
  }
  const msgId = appendMessage(thread.id, 'assistant', finalText, steps);
  touchThread(thread.id);
  logUsage(modelRow, usageTotal);
  const done = { t: 'done', thread_id: thread.id, message_id: msgId, steps: steps.length / 2, stopped: !!signal?.aborted };
  emit(done);
  return { thread_id: thread.id, message_id: msgId, text: finalText, usage: usageTotal, stopped: !!signal?.aborted };
}

function mergeUsage(a, b) {
  if (!a) return b;
  if (!b) return a;
  const g = (o, k) => Number(o?.[k] || 0);
  return {
    prompt_tokens: g(a, 'prompt_tokens') + g(b, 'prompt_tokens'),
    completion_tokens: g(a, 'completion_tokens') + g(b, 'completion_tokens'),
    cached_tokens: g(a, 'cached_tokens') + g(b, 'cached_tokens'),
  };
}

// 用量入账：侧栏没有 chat_id，记 null，费用统计仍然能看到这一路花了多少
function logUsage(row, usage) {
  if (!row || !usage) return;
  try {
    db.prepare('INSERT INTO usage_log (chat_id, project_id, model_row_id, prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens) VALUES (?, NULL, ?, ?, ?, ?, 0)')
      .run(null, row.row_id, usage.prompt_tokens, usage.completion_tokens, usage.cached_tokens);
  } catch (e) { /* 记账失败不影响回答 */ }
}

module.exports = {
  setHost, ensureTables,
  listThreads, threadWithMessages, createThread, renameThread, deleteThread,
  runTurn, TOOL_ALLOW, LIMITS,
  // 托管模式（orchestrator.js）复用这两个纯函数，免得第三份流式解析实现漂在一旁
  streamOnce, mergeUsage,
};
