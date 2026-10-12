/**
 * 第七十四轮 ⑤：右栏「本轮输入 / 输出 / 缓存 / 思考」这四格不再一刷新就没。
 *
 * 以前这四格只活在 SSE done 帧写进内存的那一份上：刷新页面、切走再切回，openChat 拿回来的是
 * 上下文口径那份 {used, limit}，四格于是归零，而且从来没有「上一轮的结果」可看。
 * 现在回合末把 {prompt,completion,cached,reasoning,rounds} 随 assistant 消息落库（usage_json 列），
 * openChat 从消息里倒查（syncTurnUsage），标签按「这条会话此刻在不在跑」本轮/上轮两面说。
 *
 * 两头都验：store 那一头量倒查出来的数，界面这一头挂真组件读那四行文字。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import ChatDock from '../src/features/chat/ChatDock.vue';

const CHAT = 42;

const { fx } = vi.hoisted(() => ({
  fx: {
    messages: [],
    usage: { used: 9000, limit: 200000 },
    chat: { id: 42, title: 't', cwd: 'D:/work', model_row_id: 3, approval_mode: '' },
  },
}));

vi.mock('../src/api', () => ({
  aiApi: new Proxy({}, {
    get: (t, k) => () => Promise.resolve(
      k === 'getChat' ? { chat: fx.chat, messages: fx.messages, tasks: [], usage: fx.usage }
        : k === 'getProjects' ? []
          : k === 'getChats' ? []
            : k === 'getChatSettings' ? fx.chat
              : k === 'getBackground' ? { tasks: [], hidden: 0 }
                : k === 'getTasks' ? []
                  : null
    ),
  }),
  settingsApi: { getAll: () => Promise.resolve({}), update: () => Promise.resolve({}), appInfo: () => Promise.resolve({}) },
}));
vi.mock('../src/stores/toast', () => ({ toast: () => {} }));
vi.mock('../src/features/chat/chatStream', () => ({
  openChatStream: () => ({ abort() {}, done: new Promise(() => {}) }),
  openPressStream: () => ({ abort() {}, done: Promise.resolve() }),
}));

const { useChatStore } = await import('../src/features/chat/chatStore');

const store = useChatStore();
const s = store.state;

const TURN = { prompt_tokens: 940, completion_tokens: 320, cached_tokens: 180, reasoning_tokens: 60, rounds: 2 };

beforeEach(() => {
  fx.messages = [
    { id: 1, role: 'user', content: '第一轮问话', reasoning: null, steps: [] },
    { id: 2, role: 'assistant', content: '第一轮回答', reasoning: '', steps: [], usage: TURN },
  ];
  s.chatId = CHAT;
  s.busyChats = {};
  s.usage = {};
  s.messages = [];
  s.msgBuf = {};
});

describe('从落库的消息里倒查本轮明细', () => {
  it('openChat 之后四格有数（不再是刷新一次就归零）', async () => {
    await store.openChat(CHAT);
    expect(s.usage).toMatchObject(TURN);
    // 上下文口径那份是另一件事：used/limit 走 contextUsed/contextLimit，不许串到这四格
    expect(s.contextUsed).toBe(9000);
    expect(s.contextLimit).toBe(200000);
  });

  it('取的是最近一条带 usage 的回复（上一轮的值不能来自更早那次）', async () => {
    fx.messages = [
      ...fx.messages,
      { id: 3, role: 'user', content: '再来', reasoning: null, steps: [] },
      { id: 4, role: 'assistant', content: '第二轮', reasoning: '', steps: [], usage: { ...TURN, prompt_tokens: 2000, rounds: 1 } },
    ];
    await store.openChat(CHAT);
    expect(s.usage.prompt_tokens).toBe(2000);
    expect(s.usage.rounds).toBe(1);
  });

  it('整条会话都没有 usage（这次改动之前的老数据）就是空，不编一个数出来', async () => {
    fx.messages = [{ id: 2, role: 'assistant', content: '老数据', reasoning: '', steps: [] }];
    await store.openChat(CHAT);
    expect(s.usage).toEqual({});
  });
});

describe('右栏那四行字', () => {
  async function mountDock() {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createApp({
      render: () => h(ChatDock, {
        tasks: [], history: [], files: [], usage: s.usage, cwd: 'D:/work',
        contextUsed: s.contextUsed, contextLimit: s.contextLimit,
      }),
    });
    app.mount(host);
    await nextTick();
    await nextTick();
    return { host, unmount: () => { app.unmount(); host.remove(); } };
  }
  const rows = (host) => [...host.querySelectorAll('.row')].map((r) => r.textContent.replace(/\s+/g, ' ').trim());

  it('空闲时说的是「上轮」，数字来自落库的那一份', async () => {
    await store.openChat(CHAT);
    const { host, unmount } = await mountDock();
    const rs = rows(host);
    expect(rs.some((r) => r.startsWith('上轮输入') && r.includes('940 tok'))).toBe(true);
    expect(rs.some((r) => r.startsWith('上轮输出') && r.includes('320 tok'))).toBe(true);
    expect(rs.some((r) => r.includes('缓存') && r.includes('180 tok'))).toBe(true);
    expect(rs.some((r) => r.includes('思考') && r.includes('60 tok'))).toBe(true);
    unmount();
  });

  it('这条会话正在跑时改口说「本轮」', async () => {
    await store.openChat(CHAT);
    s.busyChats = { [CHAT]: true };
    const { host, unmount } = await mountDock();
    const rs = rows(host);
    expect(rs.some((r) => r.startsWith('本轮输入'))).toBe(true);
    expect(rs.some((r) => r.startsWith('上轮输入'))).toBe(false);
    s.busyChats = {};
    unmount();
  });

  it('没有落库明细时四格是 0 tok，而不是把上下文那一份（9000）当成输入', async () => {
    fx.messages = [{ id: 2, role: 'assistant', content: '老数据', reasoning: '', steps: [] }];
    await store.openChat(CHAT);
    const { host, unmount } = await mountDock();
    const rs = rows(host);
    expect(rs.some((r) => r.includes('输入') && r.includes('9000'))).toBe(false);
    expect(rs.some((r) => r.startsWith('上轮输入') && r.includes('0 tok'))).toBe(true);
    unmount();
  });
});
