/**
 * 第七十五轮 ②③④ 的前端那一半：
 *   ③ 点子智能体那张卡要能弹出「它到底跑了什么」，弹窗长得像主聊天窗但没有发送框；
 *   ④ 主会话一停，它派出去的分身立刻标成已停止（并向服务端补那一枪）；
 *   ② 分身的结论落库成一条会话消息时，屏幕上这条会话得同步看得见（否则「模型读得到、人看不见」）。
 *
 * 都挂真组件/真 store 量，不看源码猜。两个已知夹具坑照抄了：
 *   · KModal 是 Teleport + Transition → 内容挂在 document.body 上，不在挂载点里；退场节点会滞留，afterEach 要清；
 *   · 切会话必须走 openChat（分身清单的镜像是在那里按会话还原的），手工改 state.chatId 不算切会话。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, h, nextTick } from 'vue';

const { detailBox, calls } = vi.hoisted(() => ({
  detailBox: { v: null },
  calls: { killChat: [], killOne: [], detailGets: 0 },
}));

vi.mock('../src/api', () => ({
  aiApi: new Proxy({}, {
    get: (t, k) => (...a) => {
      if (k === 'getSubagent') { calls.detailGets++; return Promise.resolve(detailBox.v); }
      if (k === 'killSubagentsByChat') { calls.killChat.push(a[0]); return Promise.resolve({ killed: ['sa-x'] }); }
      if (k === 'killSubagent') { calls.killOne.push(a[0]); return Promise.resolve({ message: '已请求停止' }); }
      if (k === 'getChat') return Promise.resolve({ chat: {}, messages: [], tasks: [], usage: {} });
      return Promise.resolve(k === 'getProjects' || k === 'getChats' || k === 'getTasks' ? [] : null);
    },
  }),
  settingsApi: { getAll: () => Promise.resolve({}), update: () => Promise.resolve({}), appInfo: () => Promise.resolve({}) },
}));
vi.mock('../src/stores/toast', () => ({ toast: () => {} }));
vi.mock('../src/features/chat/chatStream', () => ({
  openChatStream: () => ({ abort() {}, done: new Promise(() => {}) }),
  openPressStream: () => ({ abort() {}, done: Promise.resolve() }),
}));

const { useChatStore } = await import('../src/features/chat/chatStore');
const ChatMessage = (await import('../src/features/chat/ChatMessage.vue')).default;
const SubagentStepsModal = (await import('../src/features/chat/SubagentStepsModal.vue')).default;

const store = useChatStore();
const s = store.state;

const alive = [];
async function mount(Comp, props, extra = {}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp({ render: () => h(Comp, { ...props, ...extra }) });
  app.mount(host);
  for (let i = 0; i < 8; i++) { await nextTick(); await new Promise((r) => setTimeout(r, 20)); }
  const unmount = () => { app.unmount(); host.remove(); };
  alive.push(unmount);
  // Teleport 的内容不在 host 里，两棵子树一起看才算挂上
  return { host, all: () => document.body.textContent, unmount };
}

beforeEach(() => {
  calls.killChat.length = 0;
  calls.killOne.length = 0;
  calls.detailGets = 0;
  detailBox.v = null;
  s.chatId = 42;
  s.messages = [{ role: 'assistant', content: '', reasoning: '', steps: [], timeline: null, usage: null, model_name: '' }];
  s.subagents = {};
  s.busyChats = {};
  s.queue = [];
});

afterEach(() => {
  // 断言失败时用例自己走不到 unmount：漏下来的实例带着 1.5s 轮询继续活着，
  // 下一个用例就会数到它的调用（这次就假红了一回）
  while (alive.length) { try { alive.pop()(); } catch (e) { /* 已卸 */ } }
  // KModal 退场的节点会留在 body 上，不清就是下一个用例查到上一扇
  document.body.innerHTML = '';
});

describe('③ 卡片可点 + 步骤弹窗', () => {
  it('带 subagentId 的那条 note 卡：有「查看步骤」那颗键，整行也可点', async () => {
    const emitted = [];
    const { host, unmount } = await mount(ChatMessage, {
      role: 'assistant', content: '', busy: false, msgId: 1, index: 0,
      steps: [{ type: 'note', subagentId: 'sa-demo', message: '派出子智能体「survey」（只读）：查一下登录' }],
    }, { onOpenSubagent: (id) => emitted.push(id) });
    expect(host.textContent).toContain('查看步骤');
    const note = host.querySelector('.step-note');
    expect(note.classList.contains('clickable')).toBe(true);
    note.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();
    expect(emitted).toEqual(['sa-demo']);
    unmount();
  });

  it('普通的 note 卡不该变可点（别把每条提示都做成入口）', async () => {
    const { host, unmount } = await mount(ChatMessage, {
      role: 'assistant', content: '', busy: false, msgId: 1, index: 0,
      steps: [{ type: 'note', message: '只是一条过程提示' }],
    });
    expect(host.querySelector('.step-note').classList.contains('clickable')).toBe(false);
    expect(host.textContent).not.toContain('查看步骤');
    unmount();
  });

  it('弹窗把 steps 摊开给人看：正文与工具调用都在，而且没有发送消息的地方', async () => {
    detailBox.v = {
      id: 'sa-demo', name: 'survey', status: 'running', model_id: 'm', iter: 2, task: '查登录逻辑',
      steps: [
        { type: 'text', text: '先看路由。' },
        { type: 'tool', name: 'grep', args: { pattern: 'login' } },
        { type: 'result', name: 'grep', output: '命中 3 处' },
      ],
    };
    const { all, unmount } = await mount(SubagentStepsModal, { id: 'sa-demo', name: 'survey', chatId: 42 });
    const body = document.body;
    const text = all();
    expect(text).toContain('子智能体 survey · 执行步骤');
    expect(text).toContain('查登录逻辑');
    expect(text).toContain('grep');
    expect(text).toContain('先看路由。');
    expect(text).toContain('pattern=login');
    expect(text).toContain('运行中');
    // 「像主聊天窗，但没有发送消息按钮」：没有输入框、没有发送键
    expect(body.querySelector('textarea')).toBeFalsy();
    expect(text).not.toContain('发送');
    unmount();
  });

  it('跑完后结论全文摊在窗尾（第七十七轮：气泡没了，这里就得看得见）', async () => {
    detailBox.v = {
      id: 'sa-end', name: 'survey', status: 'done', model_id: 'm', iter: 3, task: '查登录逻辑',
      steps: [{ type: 'text', text: '先看路由。' }, { type: 'tool', name: 'grep', args: { pattern: 'login' } }],
      result: '结论在最后一行：登录走的是 session 表。',
    };
    const { all, unmount } = await mount(SubagentStepsModal, { id: 'sa-end', name: 'survey', chatId: 42 });
    const body = document.body;
    expect(all()).toContain('交回的结论');
    expect(all()).toContain('登录走的是 session 表。');
    const stream = body.querySelector('.ss-stream');
    const fin = body.querySelector('.ss-final-body');
    expect(stream && fin).toBeTruthy();
    // 「放结尾」：结论块必须排在轨迹流之后
    expect(!!(stream.compareDocumentPosition(fin) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    unmount();
  });

  it('还在跑时不显示结论块（它还没交回任何东西）', async () => {
    detailBox.v = { id: 'sa-run', name: 'k', status: 'running', steps: [{ type: 'text', text: '正在查。' }], result: '' };
    const { unmount } = await mount(SubagentStepsModal, { id: 'sa-run', name: 'k', chatId: 42 });
    expect(document.body.querySelector('.ss-final-body')).toBeFalsy();
    unmount();
  });

  it('关掉弹窗就不该继续轮那份 detail（定时器要跟着停）', async () => {
    detailBox.v = { id: 'sa-keep', name: 'k', status: 'running', steps: [], iter: 0, task: 't' };
    const { unmount } = await mount(SubagentStepsModal, { id: 'sa-keep', name: 'k', chatId: 42 });
    await new Promise((r) => setTimeout(r, 300));
    const atClose = calls.detailGets;
    unmount();
    await new Promise((r) => setTimeout(r, 2400));   // 比 1.5s 的轮询周期长，还在轮就一定看得见
    expect(calls.detailGets).toBe(atClose);
  });
});

describe('④ 主会话停止 → 本会话的分身跟着停', () => {
  const at = (id) => ({ chatId: id });
  function seedRunning() {
    store.handleEvent({ t: 'subagent', phase: 'start', id: 'sa-1', name: 'survey', task: '查一下' }, s.messages[0], at(42));
    store.handleEvent({ t: 'subagent', phase: 'tool', id: 'sa-1', tool: 'grep', args: { pattern: 'x' } }, s.messages[0], at(42));
  }

  it('stop() 立刻把界面标成已停止，并向服务端补一枪 kill-chat', () => {
    seedRunning();
    expect(s.subagents['sa-1'].phase).toBe('tool');
    store.stop();
    expect(s.subagents['sa-1'].phase).toBe('killed');
    expect(calls.killChat).toEqual([42]);
  });

  it('没选中会话时不补这一枪（别拿 tmp 去杀别人的分身）', () => {
    s.chatId = null;
    store.stop();
    expect(calls.killChat).toEqual([]);
  });

  it('别的会话停止时，只动它自己的分身', async () => {
    seedRunning();
    s.chatId = 99;
    store.handleEvent({ t: 'subagent', phase: 'start', id: 'sa-bg', name: '别条会话的', task: 't' }, s.messages[0], at(99));
    store.stop();
    expect(calls.killChat).toEqual([99]);
    await store.openChat(42);
    expect(s.subagents['sa-bg']).toBeFalsy();          // 切回 42 这一栏里不该出现别人的分身
    expect(s.subagents['sa-1'].phase).toBe('tool');     // 42 的分身没被 99 那一下改动
  });
});

describe('② 结论不再凭空长出一个气泡（第七十七轮他的口径：像工具返回一样直接交回 AI）', () => {
  it('done 事件一条消息都不许多，只在轨迹里留一条可点的 note', () => {
    store.handleEvent({ t: 'subagent', phase: 'start', id: 'sa-1', name: 'survey', task: '查一下' }, s.messages[0], { chatId: 42 });
    const n0 = s.messages.length;
    const reply = s.messages[0];
    const steps0 = (reply.steps || []).length;
    store.handleEvent({ t: 'subagent', phase: 'done', id: 'sa-1', name: 'survey', result: '结论全文' }, reply, { chatId: 42 });
    expect(s.messages.length).toBe(n0);
    expect(reply.steps.length).toBe(steps0 + 1);
    expect(reply.steps[reply.steps.length - 1].subagentId).toBe('sa-1');
  });

  it('就算旧帧里还带 injected，也不再上屏（服务端已经不发这个字段了）', () => {
    const n0 = s.messages.length;
    store.handleEvent({ t: 'subagent', phase: 'done', id: 'sa-3', name: 'survey', result: '结论全文', injected: '【子智能体 survey · 已完成】\n结论全文' }, s.messages[0], { chatId: 42 });
    expect(s.messages.length).toBe(n0);
    expect(s.messages.some((m) => m.speaker === 'subagent')).toBe(false);
  });

  it('后台会话的结论不许出现在屏幕上这条会话里', () => {
    const n0 = s.messages.length;
    store.handleEvent({ t: 'subagent', phase: 'done', id: 'sa-bg', name: '别条会话的', result: 'x' }, s.messages[0], { chatId: 777 });
    expect(s.messages.length).toBe(n0);
  });
});
