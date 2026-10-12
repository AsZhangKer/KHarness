// Plan 模式的计划任务工具层。
//
// 为什么不进 toolgate：这批工具只在「会话开了 Plan 模式」时挂载（见 routes/ai.js 的
// activeAgentTools(planMode)），开关由会话决定而不是用户决定，出现在设置→工具里只会是个
// 永远勾不动的死项。
//
// 为什么改成工具（第七十六轮）：原来唯一的写库入口是正文标签协议 parseTaskTags，
// 实测有四种静默失效 —— 全角引号、status 不在 doing/done/failed 白名单、idx 从 0 起、
// idx 比表里行数大（模型中途重发过 <plan> 就会整体错位）。四种都是「标签照常被剥掉、
// 库里一个字没改」，模型拿不到任何回执，用户只看到「有时候怎么都改不动」。
// 工具返回值就是回执：每次写库都把当前 seq 列表原样吐回去，编号永远不用猜。
const { db } = require('../database');

const MAX_ITEMS = 50;
const MAX_CONTENT = 500;
const STATUSES = ['pending', 'doing', 'done', 'failed'];

function listTasks(chatId) {
  const c = Number(chatId);
  if (!Number.isInteger(c) || c < 1) return [];
  return db.prepare('SELECT id, content, status, error_summary, seq FROM tasks WHERE chat_id = ? ORDER BY seq ASC, id ASC').all(c);
}

/** 整表重建（seq = 传入顺序，状态一律 pending）。返回写入条数。 */
function applyPlan(chatId, items) {
  const c = Number(chatId);
  if (!Number.isInteger(c) || c < 1) return { error: '当前对话还没有会话 ID（新会话首条消息发送前无法建计划），请先发出消息再调本工具。' };
  // 行首编号/项目符号一律剥掉：中文模型很爱写「3）丙」这种全角括号，光认 ASCII 的 ")" 会漏
  const list = (Array.isArray(items) ? items : String(items || '').split('\n'))
    .map((l) => String(l == null ? '' : l).trim().replace(/^[-*•]\s*/, '').replace(/^\d+[.、)）]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, MAX_ITEMS);
  if (!list.length) return { error: '没有解析到任何任务条目。items 每行一条、不要写编号，例如："读取配置\\n修改端口\\n重启服务"。' };
  db.prepare('DELETE FROM tasks WHERE chat_id = ?').run(c);
  const ins = db.prepare('INSERT INTO tasks (chat_id, content, status, seq) VALUES (?, ?, ?, ?)');
  db.transaction(() => {
    list.forEach((content, i) => ins.run(c, content.substring(0, MAX_CONTENT), 'pending', i + 1));
  })();
  return { tasks: listTasks(c), count: list.length };
}

/**
 * 按 seq 改状态。找不到就明确报错并列出可用编号 —— 正文协议那版这里是静默 no-op，
 * 也正是「怎么改都不动」的根源。
 */
function setTaskStatus(chatId, seq, status, errorSummary) {
  const c = Number(chatId);
  if (!Number.isInteger(c) || c < 1) return { error: '当前对话还没有会话 ID，无法更新任务状态。' };
  const n = Number(seq);
  if (!Number.isInteger(n) || n < 1) return { error: `seq 要是从 1 开始的整数（收到 ${JSON.stringify(seq)}）。当前列表：${render(listTasks(c)) || '（空，先调 plan_write 建计划）'}` };
  const st = String(status || '').trim().toLowerCase();
  if (!STATUSES.includes(st)) return { error: `status 只能是 ${STATUSES.join('/')}（收到 "${status}"）。当前列表：${render(listTasks(c))}` };
  const row = db.prepare('SELECT id FROM tasks WHERE chat_id = ? AND seq = ?').get(c, n);
  if (!row) return { error: `编号 ${n} 在当前计划里不存在（共 ${listTasks(c).length} 条）。当前列表：${render(listTasks(c)) || '（空，先调 plan_write 建计划）'}` };
  db.prepare('UPDATE tasks SET status = ?, error_summary = ? WHERE id = ?')
    .run(st, st === 'failed' ? String(errorSummary || '（未提供失败原因）').substring(0, 300) : '', row.id);
  return { tasks: listTasks(c), updated: n };
}

/** 回给模型的文本：带编号的整张表，模型下次调用直接照这个编号来。 */
function render(tasks) {
  return (tasks || []).map((t) => `${t.seq}. [${t.status}] ${t.content}${t.error_summary ? `（${t.error_summary}）` : ''}`).join('\n');
}

const PLAN_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'plan_write',
      description: '建立或重排本会话的计划任务列表（右侧「计划」面板就是这张表）。接到需要多步完成的任务先调它，一条一步，控制在 15 条以内。注意：这是整表重建，重建后所有条目的状态回到未开始，所以只在这次计划真的变了时用；逐条推进进度用 plan_update。',
      parameters: {
        type: 'object',
        properties: {
          items: { type: 'string', description: '任务条目，每行一条，不要写编号（如 "读取配置文件\\n改端口为 8317\\n重启服务"）' }
        },
        required: ['items']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'plan_update',
      description: '把计划里的某一条改成当前状态。开始做某项前置 doing，做完置 done，做不下去置 failed 并在 error 里写清卡在哪（用户不看日志也能懂）。每完成一项就同步，不要等全部做完再一次性汇报。返回文本里的编号就是下次要用的 seq。',
      parameters: {
        type: 'object',
        properties: {
          seq: { type: 'string', description: '任务编号，从 1 开始，取 plan_write / plan_list 返回里行首的那个数字' },
          status: { type: 'string', description: 'pending / doing / done / failed' },
          error: { type: 'string', description: '仅 status=failed 时填：一句话说明失败原因或卡点' }
        },
        required: ['seq', 'status']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'plan_list',
      description: '读取本会话当前的计划任务列表（含每条的编号与状态）。不确定列表现在长什么样、或要确认编号时调它，不要凭记忆猜 seq。',
      parameters: { type: 'object', properties: {} }
    }
  }
];

// 与内置 TOOL_SCHEMAS 同构，供 validateToolArgs 与文本协议说明用
const PLAN_SCHEMAS = {
  plan_write: { items: { type: 'string', required: true, desc: '任务条目，每行一条，不要编号' } },
  plan_update: {
    seq: { type: 'string', required: true, desc: '任务编号，从 1 开始' },
    status: { type: 'string', required: true, desc: 'pending / doing / done / failed' },
    error: { type: 'string', required: false, desc: 'status=failed 时的失败原因摘要' }
  },
  plan_list: {}
};

const PLAN_NAMES = new Set(PLAN_TOOLS.map((t) => t.function.name));

async function exec(name, args, ctx = {}) {
  const chatId = ctx.chatId;
  if (name === 'plan_write') {
    const r = applyPlan(chatId, args?.items);
    if (r.error) return { error: r.error };
    return { output: `计划已写入右侧「计划」面板，共 ${r.count} 条：\n${render(r.tasks)}\n\n开始做某条前先调 plan_update 置 doing，做完置 done。要改计划内容才再次调用 plan_write（会重建整表、状态全部回到未开始）。` };
  }
  if (name === 'plan_update') {
    const r = setTaskStatus(chatId, args?.seq, args?.status, args?.error);
    if (r.error) return { error: r.error };
    return { output: `第 ${r.updated} 条已置 ${args.status}。当前列表：\n${render(r.tasks)}` };
  }
  if (name === 'plan_list') {
    const t = listTasks(chatId);
    if (!t.length) return { output: '当前会话还没有计划任务。需要多步执行时先调 plan_write 建一份。' };
    return { output: render(t) };
  }
  return { error: `未知的计划工具：${name}` };
}

module.exports = { PLAN_TOOLS, PLAN_SCHEMAS, PLAN_NAMES, exec, listTasks, applyPlan, setTaskStatus, render, STATUSES };
