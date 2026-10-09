/**
 * ① 手动压缩的进度要看得见（#242）。
 *
 * 以前 /press 和右栏那颗按钮发的是普通 JSON 请求：一次摘要十几到几十秒，这期间界面上一无所有、
 * 按钮连 disabled 都没有。服务端改成 SSE 之后，这一条验的是**前端那一头**：
 *   - 按下就必须在消息流尾部出现一张进行中的压缩卡（转圈 + 当前用量），而不是等请求返回；
 *   - 卡片阶段变化必须真的渲染出来（推进响应式数组的那个原始对象是不会触发更新的，
 *     所以 pressChat 用 card() 每次从数组里重取引用 —— 这条用例就是它的回归闸）；
 *   - 跑完/失败都要把按钮解锁（pressing 复位），且压完的用量直接生效。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createApp, h, nextTick } from 'vue';

let pressHandlers = null;
let pressBodies = [];
vi.mock('../src/features/chat/chatStream', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    openPressStream: (body, handlers) => {
      pressBodies.push(body);
      pressHandlers = handlers;
      return { abort() {}, done: Promise.resolve() };
    },
  };
});
vi.mock('../src/api', () => ({
  aiApi: new Proxy({}, { get: () => () => Promise.resolve(null) }),
}));

const { useChatStore } = await import('../src/features/chat/chatStore');
const { default: ChatMessage } = await import('../src/features/chat/ChatMessage.vue');

const hosts = [];
afterEach(() => { for (const x of hosts.splice(0)) x.host.remove(); pressHandlers = null; pressBodies = []; });

function mountSteps(steps) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp({
    render: () => h(ChatMessage, {
      role: 'assistant', busy: false, content: '', reasoning: '', steps, timeline: null,
      usage: null, model_name: '', msgId: null, index: 0,
    }),
  });
  app.mount(host);
  hosts.push({ host, app });
  return host;
}

const noteText = (host) => [...host.querySelectorAll('.step-note')].map((el) => el.textContent.trim()).join(' | ');

function freshStore() {
  const store = useChatStore();
  store.state.chatId = 7;
  store.state.messages = [];
  store.state.busyChats = {};
  store.state.pressing = false;
  store.state.contextUsed = 3200;
  store.state.contextLimit = 200000;
  return store;
}

describe('手动压缩：按下就有进度', () => {
  it('pressChat 立刻插一张进行中的压缩卡并带上当前用量', () => {
    const store = freshStore();
    store.pressChat();
    expect(store.state.pressing).toBe(true);
    const card = store.state.messages[store.state.messages.length - 1]?.steps?.[0];
    expect(card?.type).toBe('compress');
    expect(card?.phase).toBe('start');
    expect(card?.used).toBe(3200);
    expect(pressBodies[0]).toMatchObject({ chat_id: 7 });
  });

  it('进行中：卡片写「正在压缩上下文」，不谎称已达 80%（手动按的没有那条线）', async () => {
    const store = freshStore();
    store.pressChat();
    const host = mountSteps(store.state.messages[store.state.messages.length - 1].steps);
    pressHandlers.onEvent({ t: 'compress', phase: 'start', manual: true, used: 3200, limit: 200000, percent: 2, from: '模型上限' });
    await nextTick();
    const txt = noteText(host);
    expect(txt).toContain('正在压缩上下文');
    expect(txt).toContain('3.2k/200.0k');
    expect(txt).toContain('窗口来自模型上限');
    expect(txt).not.toContain('80%');
    expect(host.querySelector('.fa-spin')).toBeTruthy();
  });

  it('服务端推进 done → 同一张卡就地变成「已压缩：归档 N 条」（不是新插一条、也不是不动）', async () => {
    const store = freshStore();
    store.pressChat();
    const host = mountSteps(store.state.messages[store.state.messages.length - 1].steps);
    pressHandlers.onEvent({ t: 'compress', phase: 'start', manual: true, used: 3200, limit: 200000, percent: 2 });
    await nextTick();
    expect(noteText(host)).toContain('正在压缩上下文');
    pressHandlers.onEvent({
      t: 'compress', phase: 'done', manual: true, used: 3200, limit: 200000, percent: 2,
      after: 940, after_basis: 'body+overhead', chars: 480, archived: 12, summary: '（摘要）',
    });
    await nextTick();
    const txt = noteText(host);
    expect(txt).toContain('已压缩：归档 12 条消息、摘要 480 字');
    expect(txt).toContain('3.2k → 940');
    expect(txt).not.toContain('正在压缩');
    expect(host.querySelectorAll('.step-note').length).toBe(1);
  });

  it('跑完解锁按钮并把压缩后的用量直接写进状态', async () => {
    const store = freshStore();
    store.pressChat();
    pressHandlers.onEvent({ t: 'compress', phase: 'done', manual: true, used: 3200, limit: 200000, after: 940, chars: 480, archived: 12 });
    pressHandlers.onDone();
    await nextTick();
    expect(store.state.pressing).toBe(false);
    expect(store.state.contextUsed).toBe(940);
  });

  it('失败也要解锁并把原因落到卡片上（不能永远转圈）', async () => {
    const store = freshStore();
    store.pressChat();
    // 抓引用而不是事后从 messages 里找：onDone 会 openChat 重拉会话，那张本地压缩卡本来就该消失
    const card = store.state.messages[store.state.messages.length - 1].steps[0];
    pressHandlers.onEvent({ t: 'compress', phase: 'failed', manual: true, used: 3200, limit: 200000, message: '压缩请求失败 HTTP 500' });
    expect(card.phase).toBe('failed');
    expect(card.message).toContain('HTTP 500');
    pressHandlers.onDone();
    await nextTick();
    expect(store.state.pressing).toBe(false);
  });

  it('压缩进行中再点第二次不会插第二张卡（按钮 disabled 之外的兜底）', () => {
    const store = freshStore();
    store.pressChat();
    store.pressChat();
    store.pressChat();
    expect(store.state.messages.length).toBe(1);
    expect(pressBodies.length).toBe(1);
  });

  it('自动压缩那张卡的 80% 措辞没被顺手改坏', () => {
    const host = mountSteps([{ type: 'compress', name: '压缩上下文', phase: 'start', used: 170000, limit: 200000, percent: 85, from: '模型上限' }]);
    const txt = noteText(host);
    expect(txt).toContain('已达 80% → 先压缩再回答');
    expect(txt).toContain('窗口来自模型上限');
    expect(txt).not.toContain('正在压缩上下文');
  });
});
