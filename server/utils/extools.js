// 内置增强工具（走 toolgate 开关，与外部 API 接口同一张设置卡；默认全部关闭）
// 后台任务 4 个 + 长期记忆 3 个 + ask_user 1 个。
// 与 run_command 的区别：后台任务异步于 AI 主循环，不阻塞对话；记忆跨会话跨项目。
// ask_user 的挂起通道由调用方通过 ctx.ask 注入（见 routes/ai.js 的 runAgent）；
// 拿不到通道时（如设置页试跑）返回明确说明，而不是静默卡住。
const bg = require('./bg');
const bgremote = require('./bgremote');
const remote = require('./remote');
const memory = require('./memory');
const subagent = require('./subagent');
const toolgate = require('./toolgate');

function parseOptions(raw) {
  if (Array.isArray(raw)) return raw.map(x => String(x).trim()).filter(Boolean);
  const s = String(raw ?? '').trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try { const j = JSON.parse(s); if (Array.isArray(j)) return j.map(x => String(x).trim()).filter(Boolean); } catch (e) { /* 按普通文本继续 */ }
  }
  // 分隔符含半角逗号：模型最常写成 "A, B, C"，不拆就会渲染成一个按钮
  return s.split(/[\n；;，,、|]+/).map(x => x.replace(/^\s*[-*\d.、)\]]+\s*/, '').trim()).filter(Boolean).slice(0, 8);
}

/**
 * 后台任务落在哪台机器上跑：远程会话 → 那台远端主机；本机会话 → 本机。
 * 三种返回：{local:true} / {host:row} / {error} —— 会话挂在已删除的连接上时要说清楚，
 * 不能悄悄退化成在本机跑（那样端口、产物、环境全在错的地方）。
 */
function bgTarget(ctx) {
  const id = Number(ctx && ctx.chatId);
  if (!Number.isInteger(id) || id < 1) return { local: true };
  let rid;
  try {
    const { db } = require('../database');
    rid = db.prepare('SELECT remote_id FROM ai_chats WHERE id = ?').get(id)?.remote_id;
    if (!rid) return { local: true };
    const host = db.prepare('SELECT * FROM ai_remote_hosts WHERE id = ?').get(rid);
    return host ? { host } : { error: `这个会话属于远程连接（id=${rid}），但连接已被删除，无法执行后台任务。` };
  } catch (e) {
    return { local: true };   // 表还没迁移的老库：当本机
  }
}

const TOOLS = {
  run_background: {
    kind: 'builtin', provider: '内置增强', category: '后台任务',
    label: '启动后台任务',
    source: '本机 child_process（异步 spawn）/ 远程会话起在远端',
    doc: '—',
    cost: '不消耗积分',
    testArg: 'command',
    testHint: 'node -e "setInterval(()=>console.log(Date.now()),5000)"',
    description: [
      '启动不需要等它跑完的长任务（dev server、watch、定时脚本、大仓构建）。立刻返回 handle，不阻塞你继续干活。',
      '需要拿到命令结果再往下走时用 run_command；只是「让它跑起来」时用本工具。',
      '用 background_status(handle) 查输出，background_kill(handle) 停掉。',
      '远程会话里这个任务起在远端机器上（不是本机）：日志在远端 ~/.kh-bg/，端口也占在远端。'
    ].join(' '),
    params: {
      command: { type: 'string', required: true, desc: '要后台运行的完整命令（按设置里选定的 Shell 解释）' },
      cwd: { type: 'string', required: false, desc: '工作目录，默认当前会话目录' }
    },
    configFields: [],
    run: async (args, ctx = {}) => {
      const target = bgTarget(ctx);
      if (target.error) return { error: target.error };
      if (target.host) {
        const r = await bgremote.start(target.host, String(args?.command || ''), args?.cwd ? String(args.cwd) : ctx.cwd);
        if (r.error) return { error: r.error };
        return {
          output: `远端后台任务已启动（跑在 ${target.host.username}@${target.host.host}，不是本机）。\nhandle：${r.id}\n远端 PID：${r.pid}\n工作目录：${r.cwd}\nShell：${r.shell}\n远端日志：${r.log}\n` +
            '命令在远端异步运行，不会阻塞你；需要看输出用 background_status("' + r.id + '")，停止用 background_kill("' + r.id + '")。\n' +
            '注意：远端没有本机的进程树回收器，kill 只对这个 PID 发 TERM/KILL，它 fork 出来的子进程可能要另外收尾。'
        };
      }
      const r = bg.start(String(args?.command || ''), args?.cwd ? String(args.cwd) : undefined);
      if (r.error) return { error: r.error };
      return {
        output: `后台任务已启动。\nhandle：${r.id}\nPID：${r.pid}\nShell：${r.shell}\n日志：${r.log}\n` +
          '命令在后台异步运行，不会阻塞你；需要看输出用 background_status("' + r.id + '")，停止用 background_kill("' + r.id + '")。'
      };
    }
  },

  background_status: {
    kind: 'builtin', provider: '内置增强', category: '后台任务',
    label: '查后台任务状态',
    source: '本机后台任务注册表 / 远端 kill -0 + tail',
    doc: '—',
    cost: '不消耗积分',
    testArg: 'handle',
    testHint: '（先 run_background 起一个，再把它返回的 handle 填进来）',
    description: '查某个后台任务是否在跑、退出码、运行时长与输出尾部（只回最后 N 行，不给全量）。要知道具体某个任务时用这个；想知道全部任务用 background_list。',
    params: {
      handle: { type: 'string', required: true, desc: 'run_background 返回的 handle（形如 bg-xxxx）' },
      tail: { type: 'string', required: false, desc: '返回输出尾部行数，默认 100，最多 400' }
    },
    configFields: [{ key: 'tail_lines', label: '默认尾部行数', type: 'number', def: 100, min: 10, max: 400 }],
    run: async (args, ctx = {}) => {
      const cfg = toolgate.configOf('background_status');
      if (bgremote.owns(args?.handle)) {
        const host = bgremote.hostOf(args?.handle);
        if (!host) return { error: 'background_status:这个远端任务所属的连接已被删除，查不了了。' };
        return bgremote.status(host, args?.handle, args?.tail || cfg.tail_lines);
      }
      return bg.status(args?.handle, args?.tail || cfg.tail_lines);
    }
  },

  background_list: {
    kind: 'builtin', provider: '内置增强', category: '后台任务',
    label: '列出全部后台任务',
    source: '本机后台任务注册表 / 远端 ps',
    doc: '—',
    cost: '不消耗积分',
    testArg: '',
    testHint: '无需参数，直接点试跑',
    description: '列出当前所有后台任务及其状态（运行中/已退出/已终止）、PID、运行时长与命令。忘了 handle、或想知道还有哪些进程在跑时用这个，不要拿 status 挨个猜。远程会话下列的是那台机器上的远端任务。',
    params: {},
    configFields: [],
    run: async (args, ctx = {}) => {
      const target = bgTarget(ctx);
      if (target.error) return { error: target.error };
      if (target.host) {
        const r = await bgremote.list(target.host);
        const localN = bg.tasks.size;
        return localN ? { output: `${r.output}\n\n（另有 ${localN} 个本机后台任务，与本会话所在的远端机器无关；要管它们在本机会话里查）` } : r;
      }
      return bg.list()
    }
  },

  background_kill: {
    kind: 'builtin', provider: '内置增强', category: '后台任务',
    label: '终止后台任务',
    source: '本机 child_process（进程树回收）/ 远端 TERM+KILL',
    doc: '—',
    cost: '不消耗积分',
    testArg: 'handle',
    testHint: '（填 run_background 返回的 handle）',
    description: '终止指定后台任务并回收它派生的整棵进程树。只能终止本服务启动的任务（防误杀系统进程）。端口被自己起的 dev server 占住时用这个，别去 kill 陌生 PID。',
    params: { handle: { type: 'string', required: true, desc: '要终止的后台任务 handle' } },
    configFields: [],
    run: async (args, ctx = {}) => {
      if (bgremote.owns(args?.handle)) {
        const host = bgremote.hostOf(args?.handle);
        if (!host) return { error: 'background_kill:这个远端任务所属的连接已被删除，杀不了了。' };
        return bgremote.kill(host, args?.handle);
      }
      return bg.kill(args?.handle)
    }
  },

  ask_user: {
    kind: 'builtin', provider: '内置增强', category: '交互',
    label: '向用户提问',
    source: '本机（复用审批挂起通道）',
    doc: '—',
    cost: '不消耗积分',
    testArg: 'question',
    testHint: '你想先做哪一件：A 修 bug / B 加功能',
    description: [
      '遇到必须由用户决定、且不同选择会导致完全不同实现的问题时，用这个工具正式提问（会弹横幅让用户点选或自己输入）。',
      '不要用它问"你确定吗"这种确认句，也不要拿它代替在正文里说明；一轮里尽量少问，能合理默认就默认并写明假设。',
      '用户也可以取消不回答；取消或超时后你要自己选一条合理路径继续，并说明理由。'
    ].join(' '),
    params: {
      question: { type: 'string', required: true, desc: '要问用户的问题，一句话问清（含必要背景）' },
      options: { type: 'string', required: false, desc: '候选项，2~8 个，用换行或逗号分隔（用户界面会渲染成可点按钮，并始终额外提供自由输入框）' }
    },
    configFields: [{ key: 'timeout_minutes', label: '等待用户回答超时（分钟）', type: 'number', def: 10, min: 1, max: 30 }],
    run: async (args, ctx = {}) => {
      const question = String(args?.question || '').trim();
      if (!question) return { error: 'ask_user:question 不能为空' };
      const options = parseOptions(args?.options);
      if (typeof ctx.ask !== 'function') {
        return { error: 'ask_user:当前调用通道不可用（该工具只在 Agent 会话流里有效）。请直接把问题写在回复正文里问用户。' };
      }
      const cfg = toolgate.configOf('ask_user');
      const minutes = Math.min(Math.max(Number(cfg.timeout_minutes) || 10, 1), 30);
      const r = await ctx.ask({ question, options, timeoutMs: minutes * 60000 });
      if (!r || !r.answered) {
        const why = r && r.cancelled ? '用户点击了「取消」，明确表示不回答' : `用户在 ${minutes} 分钟内未回答`;
        return { output: `${why}。请基于现有信息选择最合理的一种做法继续，并在回复里说明你替他做了哪个假设。` };
      }
      return { output: `用户回答：${r.answer}` };
    }
  },

  memory_write: {
    kind: 'builtin', provider: '内置增强', category: '长期记忆',
    label: '写长期记忆',
    source: '本机 SQLite（ai_memories，跨项目共享）',
    doc: '—',
    cost: '不消耗积分',
    testArg: 'name',
    testHint: 'coding-style',
    description: '把值得跨会话记住的事实写进长期记忆：用户偏好、沟通习惯、环境约束、踩过的坑与原因。name 用 kebab-case 短名（如 coding-style、preferred-lang、deploy-host），正文只写一条主题、别混装，同名会覆盖。不要记能从代码/git 直接看到的东西，也不要记只在本次任务里有效的临时状态。',
    params: {
      name: { type: 'string', required: true, desc: '检索名，kebab-case 短名，如 coding-style、preferred-lang' },
      content: { type: 'string', required: true, desc: `记忆正文，单条 ≤ ${memory.MAX_CONTENT} 字，一个主题` }
    },
    configFields: [],
    run: async (args) => memory.write(args?.name, args?.content)
  },

  memory_read: {
    kind: 'builtin', provider: '内置增强', category: '长期记忆',
    label: '读长期记忆',
    source: '本机 SQLite（ai_memories）',
    doc: '—',
    cost: '不消耗积分',
    testArg: 'name',
    testHint: 'coding-style',
    description: '按名字取回一条长期记忆的正文。名字不确定时先 memory_list，别凭印象猜；用户让你"按之前的约定来"而你不记得约定内容时，先查记忆再动手。',
    params: { name: { type: 'string', required: true, desc: '记忆名（kebab-case，与写入时一致，大小写与空格会被归一）' } },
    configFields: [],
    run: async (args) => memory.read(args?.name)
  },

  memory_list: {
    kind: 'builtin', provider: '内置增强', category: '长期记忆',
    label: '列出长期记忆',
    source: '本机 SQLite（ai_memories）',
    doc: '—',
    cost: '不消耗积分',
    testArg: '',
    testHint: '无需参数，直接点试跑',
    description: '列出所有长期记忆的名字、字数与更新时间（不含正文）。读记忆前先调用它确认名字。',
    params: {},
    configFields: [],
    run: async () => memory.list()
  },

  // ---------- 子智能体 ----------
  agent_run: {
    kind: 'builtin', provider: '内置增强', category: '子智能体',
    label: '派子智能体并等结果',
    source: '同进程嵌套 Agent 循环',
    doc: '—',
    cost: '消耗一次完整子会话的 token',
    testArg: 'task',
    testHint: '统计 client/src 下 .vue 文件的行数排名前 5，只给结论',
    description: [
      '把一个边界清楚的调查任务交给一个只读的子智能体去做，等它返回结论。适合：读大目录/多文件找东西、通读一份长文档、交叉复核你刚写的代码——这些活会把你的上下文和步数吃光，交给分身更划算。',
      '子智能体没有写文件、删文件、执行命令的能力；需要改动时它会把「改哪里、改成什么」写进结论，由你执行。',
      'task 要写清：查什么、产出什么格式、结论给谁看。它看不到本会话的历史，必要背景要在 task 里交代。',
      '要并行派多个用 agent_spawn + agent_wait；只想立刻收工不等结果用 agent_spawn。'
    ].join('\n'),
    params: {
      task: { type: 'string', required: true, desc: '交给子智能体的任务描述（自包含，含必要背景与期望产出格式）' },
      name: { type: 'string', required: false, desc: '给这个子智能体起的短名，便于之后引用（如 survey-auth）' },
      model: { type: 'string', required: false, desc: '指定模型的 model_id；不填沿用本会话当前模型' },
      cwd: { type: 'string', required: false, desc: '子智能体的工作目录，默认本会话目录' }
    },
    configFields: [],
    run: async (args, ctx) => {
      const r = await subagent.runSync({
        name: args?.name, task: args?.task, model: args?.model, cwd: args?.cwd, chatId: ctx?.chatId,
      });
      if (r.error) return { error: r.error };
      return { output: subagent.report(r) };
    }
  },

  agent_spawn: {
    kind: 'builtin', provider: '内置增强', category: '子智能体',
    label: '异步派发子智能体',
    source: '同进程嵌套 Agent 循环',
    doc: '—',
    cost: '消耗一次完整子会话的 token',
    testArg: 'task',
    testHint: '列出 server/utils 下每个模块的职责，一句话一个',
    description: '派一个只读子智能体但不等结果，立刻返回它的 id。你可以继续干活，之后用 agent_wait(id) 收结论。适合同时铺开两三路调查。',
    params: {
      task: { type: 'string', required: true, desc: '任务描述（自包含）' },
      name: { type: 'string', required: false, desc: '短名，便于引用' },
      model: { type: 'string', required: false, desc: '指定 model_id' },
      cwd: { type: 'string', required: false, desc: '工作目录' }
    },
    configFields: [],
    run: async (args, ctx) => {
      const r = subagent.spawn({ name: args?.name, task: args?.task, model: args?.model, cwd: args?.cwd, chatId: ctx?.chatId });
      if (r.error) return { error: r.error };
      return { output: `子智能体已派出。\nid：${r.id}\n名称：${r.name}\n继续做别的事，需要结果时用 agent_wait("${r.id}")，中途要停用 agent_kill("${r.id}")。` };
    }
  },

  agent_wait: {
    kind: 'builtin', provider: '内置增强', category: '子智能体',
    label: '收子智能体的结果',
    source: '本机子智能体注册表',
    doc: '—',
    cost: '不额外消耗',
    testArg: 'agent_id',
    testHint: '（先 agent_spawn 一个，把返回的 id 填进来）',
    description: '等一个已派出的子智能体结束并拿回它的结论。超时不会杀掉它，只返回「还在跑、已跑几步」。',
    params: {
      agent_id: { type: 'string', required: true, desc: 'agent_spawn / agent_run 返回的 id（形如 sa-xxxx）' },
      timeout_seconds: { type: 'number', required: false, desc: '最多等多少秒，默认 120' }
    },
    configFields: [],
    run: async (args) => {
      const sec = Number(args?.timeout_seconds);
      const r = await subagent.wait(args?.agent_id, Number.isFinite(sec) && sec > 0 ? sec * 1000 : undefined);
      if (r.error) return { error: r.error };
      if (r.pending) return { output: r.message };
      return { output: subagent.report(r) };
    }
  },

  agent_list: {
    kind: 'builtin', provider: '内置增强', category: '子智能体',
    label: '列出子智能体',
    source: '本机子智能体注册表',
    doc: '—',
    cost: '不消耗积分',
    testArg: '',
    testHint: '无需参数，直接点试跑',
    description: '列出本会话派过哪些子智能体：名字、状态、已跑步数、结论摘要。忘了 id、或想知道哪路调查还在跑时用。',
    params: {},
    configFields: [],
    run: async (args, ctx) => {
      const rows = subagent.list(ctx?.chatId || null);
      if (!rows.length) return { output: '本会话还没有派过子智能体。要独立调查一段活时用 agent_run（等结果）或 agent_spawn（不等）。' };
      const lines = rows.map(r => `- ${r.id}  ${r.name}  [${r.status}]  已 ${r.iter} 步 / ${r.steps} 条工具记录${r.result_preview ? `  → ${r.result_preview.slice(0, 60)}…` : ''}${r.error ? `  错误：${r.error.slice(0, 60)}` : ''}`);
      return { output: `共 ${rows.length} 个子智能体：\n${lines.join('\n')}\n\n收结果用 agent_wait(id)，停用 agent_kill(id)，删记录用 agent_delete(id)。` };
    }
  },

  agent_kill: {
    kind: 'builtin', provider: '内置增强', category: '子智能体',
    label: '停止子智能体',
    source: '本机子智能体注册表',
    doc: '—',
    cost: '不消耗积分',
    testArg: 'agent_id',
    testHint: 'sa-xxxx',
    description: '停掉一个还在跑的子智能体（中断它对模型的请求）。方向错了、任务发重了、或已经不需要这个结果时用。',
    params: { agent_id: { type: 'string', required: true, desc: '子智能体 id' } },
    configFields: [],
    run: async (args) => {
      const r = subagent.kill(args?.agent_id);
      return r.error ? { error: r.error } : { output: r.message };
    }
  },

  agent_delete: {
    kind: 'builtin', provider: '内置增强', category: '子智能体',
    label: '删除子智能体记录',
    source: '本机 SQLite（ai_subagents）',
    doc: '—',
    cost: '不消耗积分',
    testArg: 'agent_id',
    testHint: 'sa-xxxx',
    description: '删掉一个子智能体的记录（会先停掉在跑的）。清理用；已结束的条目不会自己消失。',
    params: { agent_id: { type: 'string', required: true, desc: '子智能体 id' } },
    configFields: [],
    run: async (args) => {
      const r = subagent.remove(args?.agent_id);
      return r.error ? { error: r.error } : { output: r.message };
    }
  }
};

const NAMES = Object.keys(TOOLS);

// 内置增强工具：后台任务 / 长期记忆 / ask_user —— 默认开启（可在设置关闭）
for (const k of Object.keys(TOOLS)) TOOLS[k].defaultOn = true;
// 子智能体 6 个例外：每一次派发都是一整轮独立会话，会真金白银吃额度，默认关
for (const k of Object.keys(TOOLS)) if (k.startsWith('agent_')) TOOLS[k].defaultOn = false;
toolgate.register(TOOLS);

module.exports = { TOOLS, NAMES, parseOptions };
