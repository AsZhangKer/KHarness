/**
 * 第七十三轮：会话隔离 —— 「后台那条会话的流」不许改屏幕上这一格。
 *
 * chatStore 里用量、任务清单、子智能体、运行中的命令、首字与速度都只有**一份**内存槽，
 * 而切走会话时那条流并不会停（这是设计）。以前 handleEvent 写这些槽位时不分对象，于是：
 *   ② 「压缩后上下文百分比不动」= 压完那张卡写的是压缩**前**的 used，再加上后台会话的 usage 帧补刀；
 *   ① 「切项目再切回，自由会话的工作目录被同化」= openChat 两趟 GET 错身而过，谁后回来谁覆盖；
 *   以及 plan 清单 / 子智能体 / ask_user 提问横幅 / 发送队列 的同族串台。
 *
 * 这里两头都锁：灌事件序列看屏幕上那几格动不动（含「正对着这条会话时必须照常动」的反向用例，
 * 免得把修法做成「什么都不写」），再用源码级断言钉住两处接线（请求体不再带过期 cwd、openChat 有序号守卫）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../src/api', () => ({
  aiApi: new Proxy({}, { get: () => () => Promise.resolve(null) }),
  settingsApi: { getAll: () => Promise.resolve({}), update: () => Promise.resolve({}), appInfo: () => Promise.resolve({}) },
}));
vi.mock('../src/stores/toast', () => ({ toast: () => {} }));
vi.mock('../src/features/chat/chatStream', () => ({
  openChatStream: () => ({ abort() {}, done: new Promise(() => {}) }),
  openPressStream: () => ({ abort() {}, done: Promise.resolve() }),
}));

const { useChatStore } = await import('../src/features/chat/chatStore');
const fs = require('node:fs');
const path = require('node:path');
const SRC = fs.readFileSync(path.resolve(__dirname, '../src/features/chat/chatStore.js'), 'utf8');

const VIEWED = 7;      // 屏幕上正在看的会话
const BACK = 99;       // 后台还在跑的另一条会话

function newReply() {
  return { role: 'assistant', content: '', reasoning: '', steps: [], timeline: null, usage: null, model_name: '', unfinished: false };
}

const store = useChatStore();
const s = store.state;

/** 把界面摆成「正在看 VIEWED，后台那条是 BACK 的流」，并给屏幕那几格放可辨认的哨兵值 */
function reset() {
  s.chatId = VIEWED;
  s.messages = [newReply()];
  s.models = [{ id: 11, display_name: 'A' }, { id: 22, display_name: 'B' }];
  s.modelIdx = 0;
  s.contextUsed = 111;
  s.contextLimit = 2000;
  s.tasks = [{ id: 1, title: '屏幕上这条会话的任务' }];
  s.subagents = {};
  s.runningCmd = null;
  s.firstTokenMs = 0;
  s.streamTokens = 0;
  s.tokPerSec = 0;
  s.latencyMs = 0;
  s.usage = {};
  s.insertItems = [{ text: '待注入的一条' }];
  s.questions = {};
  s.approvals = [];
  s.queue = [];
  s.busyChats = {};
  s.msgBuf = {};
}
const back = () => ({ chatId: BACK });
const here = () => ({ chatId: VIEWED });

describe('后台会话的流：屏幕上那一格不动', () => {
  beforeEach(reset);

  it('usage 帧带着别条会话的用量过来时，百分比与窗口都不动', () => {
    store.handleEvent({ t: 'usage', used: 9999, limit: 8000 }, newReply(), back());
    expect(s.contextUsed).toBe(111);
    expect(s.contextLimit).toBe(2000);
  });

  it('tasks 帧不动侧栏 plan 清单（切回那条会话时由它自己的桶补回来）', () => {
    store.handleEvent({ t: 'tasks', tasks: [{ id: 9, title: '后台那条会话的任务' }] }, newReply(), back());
    expect(s.tasks.map((x) => x.id)).toEqual([1]);
  });

  it('subagent 帧不进正在看的这一栏，但按会话留在自己的桶里', () => {
    const r = newReply();
    store.handleEvent({ t: 'subagent', id: 'sa1', phase: 'start', name: '后台的子智能体', task: '查东西' }, r, back());
    expect(s.subagents.sa1).toBe(undefined);
    // 人切到那条后台会话 → 它自己那份桶才是这一栏的内容（以前是所有会话共用一份，越用越乱）
    s.chatId = BACK;
    store.handleEvent({ t: 'subagent', id: 'sa1', phase: 'tool', tool: 'grep' }, r, back());
    expect(s.subagents.sa1.name).toBe('后台的子智能体');
    expect(s.subagents.sa1.iter).toBe(1);
  });

  it('cmd_running / heartbeat 不会把「判定超时」那颗键点亮到别人身上', () => {
    store.handleEvent({ t: 'cmd_running', command: 'npm run build' }, newReply(), back());
    expect(s.runningCmd).toBe(null);
    store.handleEvent({ t: 'heartbeat', command: 'npm run build', pid: 4321, elapsed_ms: 5000 }, newReply(), back());
    expect(s.runningCmd).toBe(null);
  });

  it('done 帧收尾时不动屏幕上的首字 / 速度 / 用量 / 运行命令', () => {
    store.handleEvent({ t: 'done', latency_ms: 7777, ttft_ms: 6666, gen_ms: 1000, context_used: 8888,
      context_limit: 9999, usage: { prompt_tokens: 50, completion_tokens: 7 }, tasks: [] }, newReply(), back());
    expect(s.latencyMs).toBe(0);
    expect(s.firstTokenMs).toBe(0);
    expect(s.tokPerSec).toBe(0);
    expect(s.contextUsed).toBe(111);
    expect(s.contextLimit).toBe(2000);
    expect(s.runningCmd).toBe(null);
  });

  it('delta 不推屏幕那条的速度与首字（后台吐字不算在本场头上）', async () => {
    const r = newReply();
    store.handleEvent({ t: 'delta', text: '后台会话的一大段输出内容' }, r, back());
    expect(s.streamTokens).toBe(0);
    expect(s.firstTokenMs).toBe(0);
    // 但正文一个字都没丢：它仍写进这条流自己那条回复里（流式合并有 30ms 的缓冲，等一下再验）
    await new Promise((res) => setTimeout(res, 60));
    expect(r.content).toContain('后台会话的一大段输出内容');
  });

  it('insert_injected 不清掉正在看这条会话的待注入条', () => {
    store.handleEvent({ t: 'insert_injected', count: 2 }, newReply(), back());
    expect(s.insertItems.length).toBe(1);
  });

  it('后台会话问的 ask_user 不顶掉屏幕上那条的提问横幅', () => {
    store.handleEvent({ t: 'question', id: 'qb', question: '后台的问题', options: [] }, newReply(), back());
    expect(store.currentQuestion.value).toBe(null);
    store.handleEvent({ t: 'question', id: 'qv', question: '当前这条的问题', options: [] }, newReply(), here());
    expect(store.currentQuestion.value?.id).toBe('qv');
    // 后台那条仍在它自己的桶里，切回去才显示
    expect(s.questions[BACK]?.id).toBe('qb');
  });

  it('后台那条新建会话拿到 id 时，不把人正看着的会话抢走', () => {
    store.handleEvent({ t: 'chat', chat_id: BACK, title: '后台新建的' }, newReply(), { chatId: null });
    expect(s.chatId).toBe(VIEWED);
  });

  it('审批与回收站这类「归属」按流自己的会话记，不按屏幕上那格', () => {
    store.handleEvent({ t: 'approval', id: 'ap1', tool: 'edit_file', args: {}, reason: '改文件', level: 'high', chat_id: undefined }, newReply(), back());
    expect(s.approvals[0].chat_id).toBe(BACK);
    // 正在看的不是 BACK → 这条不该出现在屏幕上
    expect(store.currentApprovals.value.length).toBe(0);
  });
});

describe('正对着这条会话时：一切都照旧写（防止修成「什么都不动」）', () => {
  beforeEach(reset);

  it('usage / tasks / subagent / cmd_running / delta / done 都照常落到界面', () => {
    const r = newReply();
    store.handleEvent({ t: 'usage', used: 900, limit: 4000 }, r, here());
    expect(s.contextUsed).toBe(900);
    expect(s.contextLimit).toBe(4000);
    store.handleEvent({ t: 'tasks', tasks: [{ id: 5, title: 't' }] }, r, here());
    expect(s.tasks.map((x) => x.id)).toEqual([5]);
    store.handleEvent({ t: 'subagent', id: 'sa', phase: 'start', name: '甲', task: '查' }, r, here());
    expect(s.subagents.sa.phase).toBe('start');
    store.handleEvent({ t: 'cmd_running', command: 'ping' }, r, here());
    expect(s.runningCmd.command).toBe('ping');
    r._startedAt = Date.now() - 300;
    store.handleEvent({ t: 'delta', text: '一段正文输出' }, r, here());
    expect(s.streamTokens).toBeGreaterThan(0);
    expect(s.firstTokenMs).toBeGreaterThan(0);
    store.handleEvent({ t: 'done', latency_ms: 1200, ttft_ms: 321, gen_ms: 600, context_used: 1500,
      context_limit: 4000, usage: { prompt_tokens: 900, completion_tokens: 30 }, tasks: [] }, r, here());
    expect(s.firstTokenMs).toBeGreaterThanOrEqual(250);   // 客户端「按下发送→首包」那一份，done 不许再用服务端 ttft 盖掉
    expect(s.tokPerSec).toBeCloseTo(50, 0);
    expect(s.contextUsed).toBe(1500);
    expect(s.runningCmd).toBe(null);
  });

  it('不传 ctx（单测直接灌事件、或调用方没带归属）时按「正在看的就是这条」处理', () => {
    store.handleEvent({ t: 'usage', used: 777, limit: 2000 }, newReply());
    expect(s.contextUsed).toBe(777);
  });
});

describe('压缩那一格：压完显示的是压缩后的占用', () => {
  beforeEach(reset);

  it('start 帧写压缩前的量，done 帧写 after（不是 used）', () => {
    const r = newReply();
    store.handleEvent({ t: 'compress', phase: 'start', used: 3800, limit: 4000, percent: 95 }, r, here());
    expect(s.contextUsed).toBe(3800);
    // 关键：done 帧里 used 仍是压缩前那个大数，after 才是压完的实际占用。
    // 以前只取 used → 「压完百分比一动不动，看着像压了个空的」（他第七十三轮 ②）
    store.handleEvent({ t: 'compress', phase: 'done', used: 3800, limit: 4000, after: 195, archived: 22 }, r, here());
    expect(s.contextUsed).toBe(195);
    expect(r.steps[0].phase).toBe('done');
    expect(r.steps[0].after).toBe(195);
  });

  it('done 没带 after（旧后端）时退回 used，不把那一格写成 0', () => {
    store.handleEvent({ t: 'compress', phase: 'done', used: 3800, limit: 4000 }, newReply(), here());
    expect(s.contextUsed).toBe(3800);
  });

  it('后台那条会话压完了，屏幕上这条的百分比不动', () => {
    store.handleEvent({ t: 'compress', phase: 'done', used: 3800, limit: 4000, after: 195 }, newReply(), back());
    expect(s.contextUsed).toBe(111);
  });
});

describe('队列按会话分桶：切走时不许把话发到别处', () => {
  beforeEach(reset);

  it('queued 只数正在看这条会话的', () => {
    s.queue = [{ text: '给 7 的', chatId: VIEWED }, { text: '给 99 的', chatId: BACK }, { text: '新会话的', chatId: 'tmp' }];
    expect(store.queued.value.map((q) => q.text)).toEqual(['给 7 的']);
  });

  it('发送队列里每一项都带归属（收尾才敢只对号倒货）', () => {
    expect(SRC).toMatch(/state\.queue\.push\(\{ text, chatId: busyId \}\)/);
    expect(SRC).toMatch(/const i = state\.queue\.findIndex\(\(q\) => \(q\.chatId \|\| 'tmp'\) === key\)/);
  });
});

describe('接线：切会话与发请求不再带着别人那份', () => {
  it('openChat 有序号守卫，两趟 GET 错身而过时只让最后那次落地', () => {
    expect(SRC).toMatch(/const seq = \+\+openSeq;/);
    expect(SRC).toMatch(/const res = await aiApi\.getChat\(id\);\s*\n\s*if \(seq !== openSeq\) return;/);
    expect(SRC).toMatch(/await Promise\.all\(\[loadChatMeta\(id\), refreshTasks\(id\)\]\);\s*\n\s*if \(seq !== openSeq\) return;/);
  });

  it('已有会话的请求体不再带界面上那份 cwd（会话行是唯一事实源）', () => {
    expect(SRC).toMatch(/cwd: state\.chatId \? undefined : \(state\.cwd \|\| undefined\)/);
  });

  it('send 把这条流的归属交给 handleEvent', () => {
    expect(SRC).toMatch(/const ctx = \{ chatId: state\.chatId \|\| null \};/);
    expect(SRC).toMatch(/onEvent: \(evt\) => handleEvent\(evt, live, ctx\)/);
  });

  it('handleEvent 里那几格全局状态都过了 here()（不是无条件写）', () => {
    // 用量、任务、运行命令、待注入、子智能体各一处（子智能体走桶 + 镜像）
    expect(SRC).toMatch(/if \(Number\(evt\.used\) > 0\) state\.contextUsed = Number\(evt\.used\);/);
    expect((SRC.match(/if \(here\(\)\)/g) || []).length).toBeGreaterThanOrEqual(5);
    expect(SRC).toMatch(/if \(here\(\)\) state\.subagents = \{ \.\.\.bucket \};/);
    expect(SRC).toMatch(/tasksByChat\[tk\] = evt\.tasks \|\| \[\];/);
  });

  it('切会话时把「本场流」那几个槽换成这条会话自己的', () => {
    expect(SRC).toMatch(/state\.subagents = \{ \.\.\.\(subagentsByChat\[id\] \|\| \{\}\) \};/);
    // 首字 / 速度不再清零，改成镜像目标会话那一桶（第七十七轮续3：清零会让切回正在生成的那条时拿旧锚点重记成整段墙钟）
    expect(SRC).toMatch(/mirrorPerf\(\);\s*\n\s*state\.lastEventAt = Date\.now\(\);/);
  });
});
