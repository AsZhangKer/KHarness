/**
 * ① 审批/问答卡过期之后必须跟着退场（#258）+ ⑤ 重试耗尽的标记（#262）。
 *
 * 他实测的那串报错：审批卡挂在那儿不动，点哪颗键都是 404「审批请求不存在或已过期」，
 * 而且卡片一条不减 —— 因为服务端到点自己按拒绝处理并删了挂起项，却没告诉前端；
 * 前端又是「请求成功才出队」。这条用例钉住修好的三点：
 *   1) 收到 approval_expired / question_expired 就按 id 出队；
 *   2) 点下去撞上 404 时卡片照样出队，只说一句 toast，不再抛出去弹全量报错窗；
 *   3) 错误事件上的 retry_exhausted 与「吐出过字才算未完成」落到回复对象上。
 *
 * 注意：流必须吊着不结束 —— done 一 resolve，store 就把「一个字的没吐」的空回复剪掉，
 * 那时 onEvent 改的就已经是条孤儿对象，测了个寂寞。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const calls = [];
const toasts = [];
let handlers = null;
let finishStream = null;      // 手动放行 openChatStream 的 done
let approveFails = null;      // 设成 { response: { status: 404 } } 就模拟「已过期」

vi.mock('../src/api', () => ({
  aiApi: new Proxy({}, {
    get: (_t, key) => (...args) => {
      const name = String(key);
      calls.push([name, ...args]);
      if ((name === 'approve' || name === 'answerQuestion') && approveFails) return Promise.reject(approveFails);
      return Promise.resolve(null);
    },
  }),
  settingsApi: { getAll: () => Promise.resolve({}), update: () => Promise.resolve({}), appInfo: () => Promise.resolve({}) },
}));
vi.mock('../src/stores/toast', () => ({
  toast: (msg, kind, ms) => toasts.push([msg, kind, ms]),
}));
vi.mock('../src/features/chat/chatStream', () => ({
  openChatStream: (_body, h) => {
    handlers = h;
    const d = {};
    d.promise = new Promise((r) => { finishStream = r; });
    return { abort() {}, done: d.promise };
  },
  openPressStream: () => ({ abort() {}, done: Promise.resolve() }),
}));

const { useChatStore } = await import('../src/features/chat/chatStore');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let chatIdSeq = 0;
/** 起一轮：send() 不 await（它要等在途流上）。上一轮的流先放掉并等它收尾，
 *  否则那条空回复的清理动作会漏到下一个用例里，把刚推进 messages 的回复剪成孤儿。 */
async function startRound(store) {
  if (finishStream) { const f = finishStream; finishStream = null; f(); await sleep(50); }
  store.state.chatId = ++chatIdSeq;
  store.state.messages = [];
  store.state.busyChats = {};
  store.state.approvals = [];
  store.state.questions = {};
  store.state.models = [{ id: 91, model_id: 'mock-1', display_name: '假模型' }];
  store.state.modelIdx = 0;
  store.send('按给你的参数办事').catch(() => {});   // 假接口到处返回 null，收尾的错不该变成未处理拒绝把 worker 拖崩
  return { reply: () => store.state.messages[store.state.messages.length - 1] };
}

afterEach(async () => {
  calls.length = 0; toasts.length = 0; handlers = null; approveFails = null;
  if (finishStream) { const f = finishStream; finishStream = null; f(); await sleep(30); }
});

describe('审批卡过期退场', () => {
  it('approval_expired 到了就按 id 出队（不是留着让人点出 404）', async () => {
    const store = useChatStore();
    await startRound(store);
    handlers.onEvent({ t: 'approval', id: 'a1', tool: 'edit_file', args: {}, reason: '改文件', level: 'high', chat_id: store.state.chatId });
    handlers.onEvent({ t: 'approval', id: 'a2', tool: 'run_command', args: {}, reason: '跑命令', level: 'high', chat_id: store.state.chatId });
    expect(store.state.approvals.map((a) => a.id)).toEqual(['a1', 'a2']);
    handlers.onEvent({ t: 'approval_expired', id: 'a1' });
    expect(store.state.approvals.map((a) => a.id)).toEqual(['a2']);
  });

  it('点已过期审批回 404：卡片出队 + 一句 toast，不再抛错弹全量报告', async () => {
    const store = useChatStore();
    await startRound(store);
    handlers.onEvent({ t: 'approval', id: 'gone', tool: 'edit_file', args: {}, reason: '改文件', level: 'high', chat_id: store.state.chatId });
    approveFails = { response: { status: 404 }, message: '审批请求不存在或已过期' };
    let threw = null;
    try { await store.decideApproval(true); } catch (e) { threw = e; }
    expect(threw).toBe(null);
    expect(store.state.approvals.length).toBe(0);
    expect(toasts.some((t) => /超时|已结束/.test(String(t[0])))).toBe(true);
    // 走 silent：请求得带上「别由拦截器刷 toast」，否则一次 404 一版含堆栈的报错窗
    const ap = calls.find((c) => c[0] === 'approve');
    expect(ap[2]).toBe(true);
  });

  it('正常批准（非 404）仍旧出队，且不误报超时', async () => {
    const store = useChatStore();
    await startRound(store);
    handlers.onEvent({ t: 'approval', id: 'live', tool: 'edit_file', args: {}, reason: '改文件', level: 'high', chat_id: store.state.chatId });
    await store.decideApproval(true);
    expect(store.state.approvals.length).toBe(0);
    expect(toasts.some((t) => /超时|已结束/.test(String(t[0])))).toBe(false);
  });
});

describe('问答卡过期退场', () => {
  it('question_expired 到了就把横幅清掉', async () => {
    const store = useChatStore();
    await startRound(store);
    handlers.onEvent({ t: 'question', id: 'q1', question: '要哪个方案？', options: ['甲', '乙'], chat_id: store.state.chatId });
    expect(store.currentQuestion.value?.id).toBe('q1');
    handlers.onEvent({ t: 'question_expired', id: 'q1' });
    expect(store.currentQuestion.value).toBe(null);
  });

  it('回答一个已结束的提问：404 只 toast，横幅照样收', async () => {
    const store = useChatStore();
    await startRound(store);
    handlers.onEvent({ t: 'question', id: 'q2', question: '要哪个方案？', options: [], chat_id: store.state.chatId });
    approveFails = { response: { status: 404 }, message: '该提问已结束或已超时' };
    let threw = null;
    try { await store.answerQuestion({ text: '甲' }); } catch (e) { threw = e; }
    expect(threw).toBe(null);
    expect(store.currentQuestion.value).toBe(null);
    expect(toasts.some((t) => /提问已超时|已结束/.test(String(t[0])))).toBe(true);
  });
});

describe('错误事件上的重试标记', () => {
  it('retry_exhausted 记到回复上；一个字没出时不标未完成（那时「继续」没锚点可接）', async () => {
    const store = useChatStore();
    const { reply } = await startRound(store);
    handlers.onEvent({ t: 'error', message: '（HTTP 503 已自动重试 16 次仍不可用）HTTP 503: Service Unavailable', retry_exhausted: true });
    expect(reply().role).toBe('assistant');
    expect(String(reply().errorText)).toContain('已自动重试 16 次');
    expect(reply().retryExhausted).toBe(true);
    expect(!!reply().unfinished).toBe(false);
  });

  it('吐出过字之后才断的：标未完成 → 下方留「继续生成」', async () => {
    const store = useChatStore();
    const { reply } = await startRound(store);
    handlers.onEvent({ t: 'delta', text: '已经写了一半' });
    await sleep(60);        // 流式增量有 30ms 的合并窗口，等它真落到 content 上
    handlers.onEvent({ t: 'error', message: '流式输出中断' });
    expect(String(reply().content)).toContain('已经写了');
    expect(reply().unfinished).toBe(true);
  });
});
