// 托管模式（监工）：用户在右栏「监工」里把任务交给**监督者模型**，由它拆计划、把命令一条条
// 下发给**主智能体**（就是会话里那个正常工作的 Agent）、自己用只读工具和内置浏览器验收，
// 全绿才调 project_done 收工。监工替用户说话，用户随时能插话改要求。
//
// 监工的「手」只有一双：`task_assign` 走进程内 HTTP 自调 POST /api/ai/chat ——
// 那个 600 行的主循环处理器不该被拆成两半复用，而且自调能让审批、撤销、轨迹、
// 上下文压缩这些现成机制一行不改地生效；事件再原样转发回监工那条 SSE，
// 前端据此在主会话里画出「监工下发的命令」和「主智能体的正常回复」。
//
// 角色边界（拍板口径）：
//   监工 —— 只读文件类 + 内置浏览器全套（点击不改文件，算它的「亲眼核对」）+ 四个专属工具；
//           拿不到 write_file / edit_file / run_command / delete_*，尝试即被拒。
//   主智能体 —— 会话自己的模型与完整工具面，审批仍走会话的模式（托管不改成免审批）。
'use strict';

const { db } = require('../database');
const path = require('path');
const fs = require('fs');
const { DATA_DIR } = require('../config');
const sidebar = require('./sidebar');
const agentsMd = require('./agentsmd');
const toolgate = require('./toolgate');

let host = null;
function setHost(h) { host = h; }

const LIMITS = {
  supervisorMaxSteps: 60,     // 监工一次对话最多请求几轮（长任务里一轮只干一件事，24 轮根本不够）
  historyChars: 60000,
  toolResultChars: 12000,
  reportChars: 8000,
};

/**
 * 护栏取值：设置页里可以调（hosted_* 三个键），调大的意义是让它在更野的方向上跑。
 * 每一项撞上都是「停下来跟用户说清楚」，不是静默继续。
 */
function settingNumber(key, dflt) {
  try {
    const v = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : dflt;
  } catch (e) { return dflt; }
}

function guardrails() {
  return {
    maxTasks: settingNumber('hosted_max_tasks', 20),
    maxFixRounds: settingNumber('hosted_max_fix_rounds', 3),
    wallClockMs: settingNumber('hosted_max_minutes', 45) * 60 * 1000,
    supSteps: settingNumber('hosted_sup_steps', LIMITS.supervisorMaxSteps),
  };
}

// 监督者能用的内置只读工具；浏览器那 16 个从 toolgate 里取（它们是 builtin 类）
const SUP_BUILTINS = new Set(['read_file', 'list_dir', 'grep', 'glob', 'web_fetch', 'web_search', 'memory_read']);
// 明确不给监督者的（就算它幻觉出来也在 execAsSupervisor 里被拒）
const SUP_DENY = new Set(['write_file', 'edit_file', 'delete_file', 'delete_dir', 'create_dir', 'rename_file',
  'run_command', 'run_background', 'background_kill', 'memory_write', 'agent_spawn', 'agent_run', 'agent_start']);
const BROWSER_PREFIX = 'browser_';

// 托管专属工具：只在这条循环里存在，不进 toolgate，普通主模型看不到
const HOSTED_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'task_assign',
      description: '把一条具体指令下发给**主智能体**（会话里那个正常工作的 Agent，它会写文件、跑命令、开浏览器）。**阻塞**：调用后一直等到那一轮跑完，返回它的原话与改动清单。一次只交代一件事，写清楚「做什么、产物落在哪个路径、怎样算好」，不要派「把整个项目做完」。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '这条指令的短标题（30 字内，会显示在计划里）' },
          detail: { type: 'string', description: '给主智能体的完整指令：目标、约束、涉及的文件路径、验收口径' },
          acceptance: { type: 'string', description: '你怎么核对它做完了（可留空，留空则你自己读产物判断）' },
        },
        required: ['title', 'detail'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'supervise_run',
      description: '按项目根 kh.checks.md 跑一轮确定性验收（驱动内置浏览器逐条断言）。返回 { total, passed, failed, cases:[{name,ok,checks,shot}] }。清单里没有的用例先别硬跑，可用 plan_write 让你写的断言进清单。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'plan_write',
      description: '把计划落成项目根的 kh.plan.md（覆盖写），并同步到界面「计划」页的任务清单。每条一行：`- [ ] 标题 | 验收: 断言或核对方式`。改计划时整份重写，不要追加重复条目。',
      parameters: {
        type: 'object',
        properties: { items: { type: 'array', items: { type: 'string' }, description: '任务标题列表（顺序即执行顺序）' } },
        required: ['items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'project_done',
      description: '宣布整个项目完工并结束本轮托管。这是**唯一出口**：不调它就一直干下去。'
        + '有两条硬规矩：项目里存在 kh.checks.md 时，必须先跑 supervise_run 且最新一轮全绿，否则本工具会被拒；'
        + '没有清单时必须在 evidence 里写清你亲自核对过什么（看了哪个页面 / 读了哪个文件 / 比对了什么），空口收工会被拒。',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '给用户看的交付说明（100-300 字）' },
          evidence: { type: 'string', description: '你亲自核对过什么：跑过的断言结果 / 看过的页面 / 读过的文件路径' },
        },
        required: ['summary'],
      },
    },
  },
];

const SUP_SYS = (cwd, workerModel, plan, agentsBlock) => [
  '你是 KHarness 的**监工**（监督者）。用户把一整个任务交给你，你不亲自改代码 —— 你负责想清楚、拆任务、派活、验收、向用户交代。',
  '',
  plan ? `当前计划与完成度（新的一场开始时你并不记得上次做到哪，一切以这份和 kh.plan.md 为准）：\n${plan}\n` : '',
  '你手上的工具：',
  `- 读与查：read_file / list_dir / grep / glob / web_fetch / web_search / memory_read（工作目录 ${cwd}）`,
  '- 内置浏览器全套：browser_open / browser_snapshot / browser_text / browser_click / browser_type / browser_wait_for / browser_console / browser_screenshot …… 这是你「亲眼核对产物」的手段，前端做得对不对你自己开页面看。',
  `- 派活：task_assign（主智能体：${workerModel}）。它是你唯一的手，能写文件跑命令，但只会做你交代的那一件事；它说的每句话用户都看得见。`,
  '- 验收：supervise_run（跑 kh.checks.md 的确定性断言）；plan_write（把计划落到 kh.plan.md 和界面任务清单）。',
  '- 出口：project_done（宣布完工，不调它就会一直干下去）。',
  '',
  '硬性边界：',
  '- 你没有 write_file / edit_file / run_command / delete_*，任何改动都必须经 task_assign 下发给主智能体。',
  '- 用户随时会插话改要求。插话的内容优先于你原来的计划，该重排就重排。',
  '- 不许「大概做完了」就收工：能验证的一律先验证（开页面、跑断言、读文件），验证过再下判断。',
  '- 主智能体的回话只是**它的说法**，不是事实。关键产物要自己核对一遍。',
  '- 出口是 project_done，但它有闸门：项目里有 kh.checks.md 就必须先 supervise_run 跑到全绿；没有清单就必须在 evidence 里写清你亲自核对过什么。被拒就照它说的补。',
  `- 护栏：最多派 ${guardrails().maxTasks} 条子任务、同一条返修 ${guardrails().maxFixRounds} 轮、整场 ${Math.round(guardrails().wallClockMs / 60000)} 分钟。撞线后别再硬试，把现状和缺的东西讲给用户。`,
  '- 每次动手前先写一句话说你接下来要做什么、为什么 —— 用户是看着这句话了解进度的，光调工具他什么都不知道。',
  '',
  '说话规矩：中文；向用户汇报时讲结论和证据，不复述工具日志；下发命令时把目标、路径、验收口径写清楚，别写「按前面说的做」。',
  // AGENTS.md（全局 + 项目）：监工向用户交代、写 kh.checks.md 与命令给工作者，都得守同一份规矩。
  // 工作者走的是主聊天路，那边本来就注入了。
  agentsBlock ? `\n${agentsBlock}` : '',
].join('\n');

/* ---------------- 表 ---------------- */

function ensureTables() {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS ai_hosted_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      goal TEXT NOT NULL DEFAULT '',
      supervisor_model INTEGER,
      worker_model INTEGER,
      status TEXT NOT NULL DEFAULT 'running',
      steps INTEGER DEFAULT 0,
      tasks_assigned INTEGER DEFAULT 0,
      fix_rounds INTEGER DEFAULT 0,
      tokens INTEGER DEFAULT 0,
      report_path TEXT NOT NULL DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`).run();
  } catch (e) { /* 建表失败按空处理 */ }
}

/* ---------------- 消息落库（同一条会话，靠 speaker 分角色） ---------------- */

function appendChatMessage(chatId, role, content, speaker, extra = {}) {
  try {
    const r = db.prepare(`INSERT INTO ai_chat_messages (chat_id, role, content, speaker, model_row_id, reasoning, steps_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(chatId, role, String(content || '').substring(0, 60000), speaker || 'worker',
        extra.model_row_id || null, extra.reasoning || null, extra.steps_json || '[]');
    return Number(r.lastInsertRowid);
  } catch (e) { return 0; }
}

/** 给模型看的会话历史：把 speaker 标出来，否则监工分不清哪句是它自己说的 */
function loadHistory(chatId, limitChars) {
  let rows = [];
  try {
    rows = db.prepare('SELECT role, content, speaker FROM ai_chat_messages WHERE chat_id = ? AND (archived IS NULL OR archived = 0) ORDER BY id ASC').all(chatId);
  } catch (e) { return []; }
  const picked = [];
  let acc = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    acc += (rows[i].content || '').length;
    if (acc > limitChars && picked.length) break;
    picked.unshift(rows[i]);
  }
  return picked.map((m) => {
    // 监工自己下发的命令也是一条 user 消息（带 speaker），不标出来它会分不清「用户说的」和「我说的」
    if (m.role === 'user') {
      return m.speaker === 'supervisor'
        ? { role: 'user', content: `【这是你自己此前下发的指令】\n${m.content}` }
        : { role: 'user', content: m.content };
    }
    const who = m.speaker === 'supervisor' ? '【监工（你）】' : '【主智能体】';
    return { role: 'assistant', content: `${who}\n${m.content}` };
  });
}

function chatScope(chatId) {
  const row = db.prepare(`SELECT c.id, c.cwd, c.model_row_id, c.approval_mode, p.root_path
    FROM ai_chats c LEFT JOIN projects p ON p.id = c.project_id WHERE c.id = ?`).get(Number(chatId));
  if (!row) return { error: '会话不存在' };
  return {
    row,
    cwd: String(row.cwd || host?.defaultCwd || process.cwd()),
    projectRoot: String(row.root_path || ''),
  };
}

function resolveModelRow(hint, fallbackRowId) {
  const key = String(hint ?? '').trim();
  if (key) {
    const r = db.prepare('SELECT m.id AS row_id, m.model_id, m.display_name, p.base_url, p.api_key, p.proxy_enabled, p.proxy_host, p.proxy_port, p.api_style, p.max_tokens, p.custom FROM ai_models m JOIN ai_providers p ON m.provider_id = p.id WHERE m.id = ? OR m.model_id = ? OR m.display_name = ? ORDER BY m.id ASC LIMIT 1')
      .get(Number(key) || -1, key, key);
    if (r) return { row: r };
    return { error: `找不到模型「${key}」` };
  }
  if (fallbackRowId) {
    const r = db.prepare('SELECT m.id AS row_id, m.model_id, m.display_name, p.base_url, p.api_key, p.proxy_enabled, p.proxy_host, p.proxy_port, p.api_style, p.max_tokens, p.custom FROM ai_models m JOIN ai_providers p ON m.provider_id = p.id WHERE m.id = ?').get(fallbackRowId);
    if (r) return { row: r };
  }
  const r = db.prepare('SELECT m.id AS row_id, m.model_id, m.display_name, p.base_url, p.api_key, p.proxy_enabled, p.proxy_host, p.proxy_port, p.api_style, p.max_tokens, p.custom FROM ai_models m JOIN ai_providers p ON m.provider_id = p.id ORDER BY m.id ASC LIMIT 1').get();
  return r ? { row: r } : { error: '本机没有可用模型' };
}

/* ---------------- 工具面 ---------------- */

function supTools() {
  const builtins = (host?.builtinToolDefs ? host.builtinToolDefs(SUP_BUILTINS) : []).filter((t) => SUP_BUILTINS.has(t.function?.name));
  let gated = [];
  try {
    gated = toolgate.definitions().filter((t) => {
      const n = t.function?.name || '';
      return n.startsWith(BROWSER_PREFIX) || SUP_BUILTINS.has(n);
    });
  } catch (e) { gated = []; }
  return builtins.concat(gated, HOSTED_TOOLS);
}

function resultText(res) {
  if (!res || typeof res !== 'object') return String(res ?? '');
  if (res.error) return `错误：${res.error}`;
  const parts = [];
  if (res.output !== undefined) parts.push(String(res.output));
  if (Array.isArray(res.diff)) parts.push(`[diff ${res.diff.length} 行]`);
  return parts.join('\n') || '(无输出)';
}

function cap(s, n) {
  const t = String(s ?? '');
  return t.length > n ? t.substring(0, n) + `\n…(共 ${t.length} 字，已截断)` : t;
}

/** 监工侧执行：白名单兜第二层（第一层是它根本拿不到那些工具的 schema） */
async function execAsSupervisor(name, args, cwd) {
  const real = host?.resolveToolName ? host.resolveToolName(name) : name;
  if (SUP_DENY.has(real)) return { error: `监工不能执行 ${real}：你没有任何改动能力。要改东西就 task_assign 下发给主智能体。` };
  const okTool = SUP_BUILTINS.has(real) || real.startsWith(BROWSER_PREFIX);
  if (!okTool) return { error: `监工没有工具「${real}」。可用：${[...SUP_BUILTINS].join(' / ')} 与 browser_* 。改动请走 task_assign。` };
  if (!host?.execTool) return { error: '托管宿主未就绪（host 未注入）' };
  try {
    // 审批模式给 exempt：监工这一侧全是读和看页面，不产生改动
    return await host.execTool(real, args || {}, cwd, { child: null }, cwd || null, false, 'exempt', null, {});
  } catch (e) {
    return { error: `工具 ${real} 执行异常：${String(e?.message || e).substring(0, 200)}` };
  }
}

/* ---------------- 监工的手：交棒给主智能体（不在服务端等它跑完） ---------------- */

/**
 * 派活 = **结束监工这一轮**，把命令交回前端，由前端以正常用户消息发给主智能体。
 *
 * 为什么不再在服务端自调 /api/ai/chat 等它跑完（上一版那么干，两个后果都很糟）：
 *   1) 一跑就是几分钟，那条 SSE 一直挂着，界面上「停止」和主会话的停止按钮各管一段，
 *      用户按哪个都停不干净；
 *   2) 主会话被一个「用户看不见来源」的请求占着，用户这时候想说话就发不进去（互相调不动）。
 * 交棒之后每一段都是普通的、可单独停止的回合：监工说话 → 交棒 → 主智能体正常干活 →
 * 跑完前端再回叫监工（relay），如此往复，直到它调 project_done。
 */
function buildCommand(title, args) {
  return `【监工指令 · ${title}】\n${String(args.detail || '').trim()}`
    + `\n\n（验收口径：${args.acceptance || '做完请说明你改了什么、产物在哪、怎么验证'}。做完直接回话，不要反问用户。）`;
}

/* ---------------- 托管专属工具的实现 ---------------- */


function writePlan(ctx, items) {
  const list = (Array.isArray(items) ? items : []).map((s) => String(s || '').trim()).filter(Boolean).slice(0, 40);
  if (!list.length) return { error: 'items 为空：给我一份能执行的标题列表。' };
  const file = require('path').join(ctx.cwd, 'kh.plan.md');
  let wrote = '';
  try {
    const body = `# 施工计划（监工维护）\n\n${list.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n`;
    require('fs').writeFileSync(file, body, 'utf8');
    wrote = file;
  } catch (e) { wrote = `（写 ${file} 失败：${e.message}）`; }
  // 同步到界面「计划」页：整表换掉，避免历史条目越堆越长。
  // 标题带 ✅ / [x] / 已完成 前缀的按 done 落库，监工靠重写计划来表示进度（不再单开一个改状态的接口）
  try {
    db.prepare('DELETE FROM tasks WHERE chat_id = ?').run(ctx.chatId);
    const ins = db.prepare('INSERT INTO tasks (chat_id, content, status, seq) VALUES (?, ?, ?, ?)');
    list.forEach((t, i) => {
      const doneFlag = /^(✅|\[[xX]\]|完成|已 ?done)/.test(t);
      ins.run(ctx.chatId, t.replace(/^(✅|\[[xX]\])\s*/, '').substring(0, 200), doneFlag ? 'done' : 'pending', i);
    });
  } catch (e) { /* 任务表写不进去也不影响计划文件 */ }
  ctx.emit({ t: 'plan', items: list, file });
  return { output: `计划已落盘：${wrote}\n界面「计划」页同步了 ${list.length} 条。做完一条就再调一次 plan_write 把它的标题前加 ✅（或换掉整份列表）。` };
}

async function runChecks(ctx) {
  const supervisor = require('./supervisor');
  const r = await supervisor.run({
    projectRoot: ctx.projectRoot || ctx.cwd, cwd: ctx.cwd,
    modelRowId: null, diagnose: false,
    onEvent: (e) => { if (e.t === 'case_done') ctx.emit({ t: 'supervise_case', name: e.name, ok: e.ok, shot: e.shot || '' }); },
    shouldStop: () => !!ctx.signal?.aborted,
  });
  if (r.error) return { error: r.error };
  ctx.lastSupervise = { total: r.total, passed: r.passed, failed: r.failed, report: r.report, at: Date.now() };
  return { output: JSON.stringify({ total: r.total, passed: r.passed, failed: r.failed, report: r.report, cases: (r.cases || []).map((c) => ({ name: c.name, ok: c.ok, bad: (c.checks || []).filter((k) => !k.ok).map((k) => `${k.kind}${k.detail ? '：' + k.detail.split('\n')[0] : ''}`), shot: c.shot || '' })) }) };
}

/** 派活之前过一遍护栏；返回一句话原因 = 拦下，null = 放行 */
function checkGuards(ctx) {
  const g = guardrails();
  const tasks = (ctx.baseTasks || 0) + ctx.tasks;
  const fix = (ctx.baseFix || 0) + ctx.fixRounds;
  if (tasks >= g.maxTasks) return `这场托管已派满 ${tasks} 条子任务（护栏上限 ${g.maxTasks}）。请调 project_done 收尾或把剩余部分说清楚让用户决定是否继续。`;
  if (fix >= g.maxFixRounds) return `同一条任务已经反复返修 ${fix} 轮（护栏上限 ${g.maxFixRounds}）。别再试了，把卡在哪、需要什么告诉用户。`;
  if (Date.now() - ctx.startedAt > g.wallClockMs) return `这一场已跑超过 ${Math.round(g.wallClockMs / 60000)} 分钟（护栏上限）。请收尾并向用户汇报现状。`;
  return null;
}

/** 计划条目的状态：按标题 loosely 匹配（监工重写计划时措辞常有小出入），匹配不到就落在第一条未完成上 */
function markTask(chatId, title, status, errorSummary) {
  try {
    const rows = db.prepare('SELECT id, content, status FROM tasks WHERE chat_id = ? ORDER BY seq ASC, id ASC').all(chatId);
    if (!rows.length) return;
    const norm = (s) => String(s || '').replace(/[\s|｜:：。.,，、]/g, '').toLowerCase();
    const key = norm(title);
    let hit = rows.find((r) => norm(r.content).includes(key) && key) || rows.find((r) => r.status !== 'done' && r.status !== 'failed');
    if (!hit) return;
    db.prepare('UPDATE tasks SET status = ?, error_summary = ? WHERE id = ?')
      .run(status, String(errorSummary || '').substring(0, 300), hit.id);
    const all = db.prepare('SELECT id, content, status, error_summary FROM tasks WHERE chat_id = ? ORDER BY seq ASC, id ASC').all(chatId);
    ctx.emit({ t: 'tasks', tasks: all });
  } catch (e) { /* 计划页刷新失败不影响执行 */ }
}

/** 当前计划的一行式快照：开场就塞进监工的上下文，省得它拿「上次做到哪」全靠猜 */
function planSnapshot(chatId) {
  try {
    const rows = db.prepare('SELECT content, status FROM tasks WHERE chat_id = ? ORDER BY seq ASC, id ASC').all(chatId);
    if (!rows.length) return '';
    const mark = { done: '✅', failed: '❌', doing: '⏳', pending: '⬜' };
    const left = rows.filter((r) => r.status !== 'done').length;
    // 标题里可能还带着监工写的 ✅ 前缀，去掉再上标记，免得出现「✅ ✅」
    return `${rows.map((r) => `${mark[r.status] || '⬜'} ${String(r.content).replace(/^(✅|❌|⏳|⬜)\s*/, '')}`).join('\n')}\n—— 还剩 ${left} 条未完成`;
  } catch (e) { return ''; }
}

/**
 * 出口闸门（拍板：混合验收）：
 *  - 项目里有 kh.checks.md：必须这一场跑过 supervise_run 且最新一轮全绿，否则拒绝收工；
 *  - 没有清单：至少要它写清「你亲自核对过什么」，空口收工不接受。
 */
function deliveryGate(ctx, args) {
  // 带着「失败」条目收工不算完工：要么修好，要么用 plan_write 把计划改成实际情况
  let bad = [];
  try {
    bad = db.prepare("SELECT content FROM tasks WHERE chat_id = ? AND status = 'failed'").all(ctx.chatId);
  } catch (e) { bad = []; }
  if (bad.length) {
    return { error: `计划里还有 ${bad.length} 条是失败状态：${bad.map((b) => String(b.content).slice(0, 24)).join('；')}。`
      + '要么重新下发把它做掉，要么调 plan_write 更新计划反映实际情况，不能带着失败条目收工。' };
  }
  let hasChecks = false;
  try {
    const checks = require('./checks');
    const info = checks.load({ projectRoot: ctx.projectRoot, cwd: ctx.cwd });
    hasChecks = !!(info.exists && info.cases.length);
  } catch (e) { hasChecks = false; }
  if (hasChecks) {
    if (!ctx.lastSupervise) return { error: '项目里有 kh.checks.md，先跑一次 supervise_run 再收工。' };
    if (ctx.lastSupervise.failed > 0) return { error: `最新一轮验收还有 ${ctx.lastSupervise.failed}/${ctx.lastSupervise.total} 条没过，先修完或向用户说明为什么可以放过。` };
    return {};
  }
  if (!String(args.evidence || '').trim()) return { error: '没有验收清单可跑。要在 evidence 里写清你亲自核对过什么（看了哪个页面 / 读了哪个文件 / 比对了什么），不能空口收工。' };
  return {};
}

/** 交付报告：这场托管干了什么、每条任务的结果、验收数据、花了多少 */
function writeReport(ctx, runId, meta) {
  const dir = path.join(DATA_DIR, 'hosted');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* 建目录失败就不落盘 */ }
  const d = new Date(ctx.startedAt);
  const stamp = d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + String(d.getMilliseconds()).padStart(3, '0');
  const file = path.join(dir, `run-${stamp}-${runId}.md`);
  let tasks = [];
  try { tasks = db.prepare('SELECT content, status, error_summary FROM tasks WHERE chat_id = ? ORDER BY seq ASC').all(ctx.chatId); } catch (e) { tasks = []; }
  const lines = [
    '# 托管交付报告',
    '',
    `- 会话：#${ctx.chatId}　工作目录：\`${ctx.cwd}\``,
    `- 目标：${String(meta.goal || '').replace(/\n/g, ' ').slice(0, 300)}`,
    `- 时间：${d.toLocaleString('zh-CN')}　耗时 ${((Date.now() - ctx.startedAt) / 1000).toFixed(0)}s`,
    `- 子任务：${ctx.tasks} 条（返修 ${ctx.fixRounds} 轮）　状态：${meta.status}`,
    `- 模型：监工 ${meta.supervisor || '?'} / 主智能体 ${meta.worker || '?'}　tokens：入 ${meta.usage?.prompt_tokens || 0} 出 ${meta.usage?.completion_tokens || 0}`,
    '',
    '## 计划与结果',
    '',
  ];
  if (!tasks.length) lines.push('（这场没有落计划条目）');
  for (const t of tasks) {
    const mark = t.status === 'done' ? '✅' : t.status === 'failed' ? '❌' : t.status === 'doing' ? '⏳' : '⬜';
    lines.push(`- ${mark} ${t.content}${t.error_summary ? ` — ${t.error_summary}` : ''}`);
  }
  if (ctx.log.length) {
    lines.push('', '## 每条子任务的回报', '');
    for (const one of ctx.log) {
      lines.push(`### ${one.title}`, '', cap(one.report, 1500), '', `改动：${one.changed.join('、') || '（未标）'}`, '');
    }
  }
  if (ctx.lastSupervise) {
    lines.push('', '## 最后一次验收', '', `- ${ctx.lastSupervise.passed}/${ctx.lastSupervise.total} 通过，${ctx.lastSupervise.failed} 未过`,
      `- 清单报告：\`${ctx.lastSupervise.report || '—'}\``);
  }
  if (meta.finished) lines.push('', '## 监工的交付说明', '', meta.finished.summary, '', `核对依据：${meta.finished.evidence || '（未提供）'}`);
  try { fs.writeFileSync(file, lines.join('\n'), 'utf8'); return file; } catch (e) { return ''; }
}

/* ---------------- 一轮托管：监工说话 → 派活 → 再说话 ---------------- */

/**
 * @param {object} p { chatId, content, supervisorModel, workerModel, port, onEvent, signal }
 * 事件（都带 speaker）：
 *   supervisor —— 监工自己：delta / tool / tool_result / note
 *   其它：handoff（派出去的命令，本轮即结束）/ plan / tasks / supervise_case / report / done / error
 * 主智能体的那一轮不在这里走：前端拿到 handoff 后用普通 /chat 发出去，跑完再带 relay=true 回叫。
 */
async function runTurn({ chatId, content, supervisorModel, workerModel, relay = false, onEvent = () => {}, signal } = {}) {
  ensureTables();
  const emit = (e) => { try { onEvent(e); } catch (err) { /* 流断了不影响跑 */ } };
  const scope = chatScope(chatId);
  if (scope.error) { emit({ t: 'error', message: scope.error }); return { error: scope.error }; }
  const cwd = scope.cwd;
  const q = String(content ?? '').trim();
  if (!q && !relay) { emit({ t: 'error', message: '要监工做什么？说清楚目标。' }); return { error: '空任务' }; }

  const sup = resolveModelRow(supervisorModel, scope.row.model_row_id);
  if (sup.error) { emit({ t: 'error', message: sup.error }); return { error: sup.error }; }
  const supRow = sup.row;
  const approvalMode = host?.effectiveApprovalMode ? host.effectiveApprovalMode(Number(chatId)) : 'default';

  // 交棒回叫（relay）：主智能体刚跑完，用户没说话，所以不落新的 user 行，
  // 只在上下文里补一句「该你接着判断了」—— 它的回话本来就在历史里，不用重复搬。
  if (q && !relay) appendChatMessage(Number(chatId), 'user', q, 'user');
  const plan0 = planSnapshot(Number(chatId));
  const messages = [
    {
      role: 'system',
      content: SUP_SYS(
        cwd,
        resolveModelRow(workerModel, scope.row.model_row_id).row?.model_id || '（跟随会话）',
        plan0,
        agentsMd.promptBlock(agentsMd.collect(scope.projectRoot, cwd))
      ),
    },
    ...loadHistory(Number(chatId), LIMITS.historyChars),
  ];
  if (relay) {
    messages.push({
      role: 'user',
      content: `【工作者回话已收到，见上面最后一条 assistant 消息】现在轮到你：先核对它的产物（read_file / 内置浏览器亲眼看一下），\n`
        + `对得上就 plan_write 标完成并派下一条 task_assign；对不上就再派一条修。全部做完才 project_done。`,
    });
  }
  const tools = supTools();
  const ctx = {
    chatId: Number(chatId), cwd, projectRoot: scope.projectRoot, scope, emit, signal,
    approvalMode, workerHint: workerModel,
    tasks: 0, fixRounds: 0, seen: {}, log: [], lastSupervise: null, startedAt: Date.now(),
  };
  // 一场托管 = 一行记录。回叫（relay）不算新开一场，接着上一次「交棒中」的那行往下记，
  // 否则跑完六步会留下六条记录，历史页根本看不出是同一件事。
  let runId = 0;
  if (relay) {
    const prev = db.prepare("SELECT id FROM ai_hosted_runs WHERE chat_id = ? AND status = 'handoff' ORDER BY id DESC LIMIT 1").get(ctx.chatId);
    if (prev) runId = prev.id;
  }
  if (!runId) {
    runId = Number(db.prepare(`INSERT INTO ai_hosted_runs (chat_id, goal, supervisor_model, worker_model, status) VALUES (?, ?, ?, ?, 'running')`)
      .run(ctx.chatId, (q || '（交棒回叫）').substring(0, 400), supRow.row_id, Number(workerModel) || scope.row.model_row_id || null).lastInsertRowid);
  } else {
    db.prepare("UPDATE ai_hosted_runs SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(runId);
  }
  // 护栏要按「整场」算：回叫的每一轮 ctx.tasks 都从 0 重新开始，只看它等于没有护栏
  const baseRun = db.prepare('SELECT tasks_assigned, fix_rounds FROM ai_hosted_runs WHERE id = ?').get(runId) || {};
  ctx.baseTasks = baseRun.tasks_assigned || 0;
  ctx.baseFix = baseRun.fix_rounds || 0;

  let supText = '';
  let usage = null;
  let finished = null;
  let handoff = null;               // 这一轮派出去的活：交棒给前端，本轮立刻结束
  let stall = 0;                    // 连续几轮「只汇报不干活」
  const maxStall = 2;               // 交棒模式下不用催太狠：一轮不派活就该结束了
  const maxSteps = guardrails().supSteps;
  const notes = [];

  let iter = 0;
  let noted = '';
  for (; iter < maxSteps; iter += 1) {
    if (signal?.aborted) break;
    const r = await sidebar.streamOnce({
      modelRow: supRow, messages, tools, signal,
      onDelta: (d) => { supText += d; emit({ t: 'delta', speaker: 'supervisor', text: d }); },
      // 工具名是逐字流出来的，每个增量都会回调一次 —— 只在换了名字时记一条，否则面板全是重复 chip
      onToolName: (n) => { if (n && n !== noted) { noted = n; emit({ t: 'note', speaker: 'supervisor', message: `监工正在准备调用 ${n}` }); } },
    }).catch((e) => ({ error: String(e?.message || e).substring(0, 300) }));
    if (r.error) {
      if (supText) break;
      emit({ t: 'error', message: `监工第 ${iter + 1} 步请求失败：${r.error}` });
      patchRun(runId, { status: 'failed' });
      return { error: r.error };
    }
    if (r.usage) usage = sidebar.mergeUsage(usage, r.usage);
    if (r.content && !supText) supText = r.content;
    if (!r.toolCalls?.length) {
      // 监工最容易犯的错：核对完一条就停下来汇报，等用户催下一句。
      // 托管的语义是「干到 project_done 为止」，所以没完工就自己催它继续 ——
      // 关键是别催两次就放弃：长任务里它每做完一步都想停下来（__Test/1 就是这么停在第 3 步前）。
      const snap = planSnapshot(ctx.chatId);
      if (!finished && stall < maxStall && !signal?.aborted) {
        stall += 1;
        messages.push({ role: 'assistant', content: r.content || '' });
        messages.push({
          role: 'user',
          content: snap.includes('还剩 0 条未完成')
            ? '计划里没有未完成项了。请自己抽查核对（开页面 / 读文件），确认没问题就调 project_done 收工；发现漏了什么就补一条 task_assign。不要只回一句话就停。'
            : `还没完工，计划现状：\n${snap}\n继续 task_assign 把下一条做掉并验收。确实做不下去了就调 project_done 说明卡在哪，不要只回一句话就停。`,
        });
        emit({ t: 'note', speaker: 'supervisor', message: `监工停下来汇报，自动催它继续（第 ${stall} 次）` });
        continue;
      }
      break;
    }
    stall = 0;

    messages.push({
      role: 'assistant', content: r.content || '',
      tool_calls: r.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } })),
    });

    for (const c of r.toolCalls) {
      if (signal?.aborted) break;
      const name = c.name;
      const args = c.args || {};
      emit({ t: 'tool', speaker: 'supervisor', name, args });
      let res;
      if (name === 'task_assign') {
        const title = String(args.title || '').trim().substring(0, 60) || '未命名子任务';
        // 护栏先于派活：撞线就不再给它加新的主会话回合，让它去收尾或向用户说明
        const stop = checkGuards(ctx);
        if (stop) {
          res = { error: stop };
          emit({ t: 'note', speaker: 'supervisor', message: `护栏拦下：${stop}` });
        } else {
          ctx.tasks += 1;
          ctx.seen[title] = (ctx.seen[title] || 0) + 1;
          if (ctx.seen[title] > 1) ctx.fixRounds += 1;
          const command = buildCommand(title, args);
          markTask(ctx.chatId, title, 'doing');
          // 交棒：这一轮到此为止，命令交回前端发给主智能体；它跑完前端再回叫监工
          handoff = { title, command };
          res = { output: `已下发「${title}」。这一轮到此结束，等主智能体跑完我会带着它的回话再叫你。` };
          emit({ t: 'handoff', title, command });
        }
      } else if (name === 'plan_write') {
        res = writePlan(ctx, args.items);
      } else if (name === 'supervise_run') {
        emit({ t: 'note', text: '监工在跑验收清单…' });
        res = await runChecks(ctx);
      } else if (name === 'project_done') {
        const gate = deliveryGate(ctx, args);
        if (gate.error) {
          res = { error: gate.error };
          emit({ t: 'note', speaker: 'supervisor', message: '出口被拦：' + gate.error.substring(0, 120) });
        } else {
          finished = { summary: String(args.summary || '').substring(0, 2000), evidence: String(args.evidence || '').substring(0, 2000) };
          res = { output: '已记录完工。' };
        }
      } else {
        res = await execAsSupervisor(name, args, cwd);
      }
      const text = cap(res?.error ? `错误：${res.error}` : (res?.output || '(无输出)'), LIMITS.toolResultChars);
      emit({ t: 'tool_result', speaker: 'supervisor', name, ok: !res?.error, preview: text.substring(0, 400) });
      notes.push({ type: 'result', name, ok: !res?.error, preview: text.substring(0, 600) });
      messages.push({ role: 'tool', tool_call_id: c.id, content: text });
      if (finished || handoff) break;
    }
    if (finished || handoff) break;
  }

  const status = finished ? 'done' : handoff ? 'handoff' : signal?.aborted ? 'stopped' : iter >= maxSteps ? 'out_of_steps' : 'stopped_early';
  if (!finished && !handoff) {
    // 既没交棒也没完工：必须在监工这段话里说清楚还剩什么 —— 否则用户只看到半截汇报
    const snap = planSnapshot(ctx.chatId);
    const why = status === 'out_of_steps' ? `到轮数上限（${maxSteps} 轮）` : status === 'stopped' ? '被停止' : '连着几轮只汇报不派活';
    supText = ((supText || '监工这一场没有产出正文。')
      + `\n\n（这一场没走到 project_done：${why}。${snap ? `未完成项：\n${snap}` : '计划里还没有条目，可让它 plan_write 重排后再继续'}。在监工面板里回一句「继续」即可接着做。）`);
    emit({ t: 'note', speaker: 'supervisor', message: `这一场没完工：${why}` });
  }

  // 监工这一轮的正文落库（主智能体的回复由 /chat 自己落，不重复写）。
  // 它经常只顾着调工具、一个字不说 —— 那样界面上「监工」就像没开口，
  // 所以没正文时拿 project_done 的交付说明顶上，至少用户看得到它做了什么。
  if (!supText.trim() && finished) supText = String(finished.summary || '').trim();
  if (supText.trim()) appendChatMessage(ctx.chatId, 'assistant', supText, 'supervisor', { model_row_id: supRow.row_id, steps_json: JSON.stringify(notes.slice(-120)) });
  logUsage(supRow, usage);

  const report = writeReport(ctx, runId, {
    goal: q, status, finished, usage,
    supervisor: supRow.model_id, worker: resolveModelRow(workerModel, scope.row.model_row_id).row?.model_id || supRow.model_id,
  });
  // 计数按「场」累加：回叫的那几轮各自从 0 开始，直接写会把前面派掉的活抹掉
  const prevRun = db.prepare('SELECT tasks_assigned, fix_rounds, tokens FROM ai_hosted_runs WHERE id = ?').get(runId) || {};
  const addTokens = (usage?.prompt_tokens || 0) + (usage?.completion_tokens || 0);
  patchRun(runId, {
    status, steps: iter,
    tasks_assigned: (prevRun.tasks_assigned || 0) + ctx.tasks,
    fix_rounds: (prevRun.fix_rounds || 0) + ctx.fixRounds,
    tokens: (prevRun.tokens || 0) + addTokens,
    report_path: report,
  });
  if (finished) {
    emit({ t: 'report', path: report, tasks: ctx.tasks });
    try { require('./notify').notify(`托管完工：${String(q || scope.row.title || '').replace(/\s+/g, ' ').slice(0, 24)}`, report ? `交付报告：${report}` : '（报告没写出来）'); } catch (e) { /* 通知失败不算事 */ }
  }
  const out = { run_id: runId, status, stopped: !!signal?.aborted, done: !!finished, handoff: handoff || null, finished, report, tasks: ctx.tasks, text: supText, usage };
  emit({ t: 'done', ...out });
  return out;
}

function patchRun(id, fields) {
  const keys = Object.keys(fields).filter((k) => ['status', 'steps', 'tasks_assigned', 'fix_rounds', 'tokens', 'report_path'].includes(k));
  if (!keys.length) return;
  try {
    db.prepare(`UPDATE ai_hosted_runs SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(...keys.map((k) => fields[k]), id);
  } catch (e) { /* 记账失败不影响跑 */ }
}

function logUsage(row, usage) {
  if (!row || !usage) return;
  try {
    db.prepare('INSERT INTO usage_log (chat_id, project_id, model_row_id, prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens) VALUES (?, NULL, ?, ?, ?, ?, 0)')
      .run(null, row.row_id, usage.prompt_tokens || 0, usage.completion_tokens || 0, usage.cached_tokens || 0);
  } catch (e) { /* 忽略 */ }
}

module.exports = {
  setHost, ensureTables, runTurn, chatScope, resolveModelRow,
  SUP_BUILTINS, SUP_DENY, HOSTED_TOOLS, LIMITS,
  // 出口闸门 / 护栏 / 报告这几块纯逻辑不依赖模型，自测直接调它们（不花额度）
  _internal: { deliveryGate, checkGuards, writeReport, markTask, guardrails },
};

