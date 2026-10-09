/**
 * ⑧ 待注入提示词要能单条删除（#249）。
 *
 * 以前侧栏只有一把「清空」，写错一条就得把整堆丢掉。后端补了 DELETE /chats/:id/insert/:index，
 * 这条用例守住前端那半边：按 index 删、并且**以服务端回的那份列表为准**
 * （前端自己 splice 会在并发注入/别的窗口改过时错位）。
 */
import { describe, it, expect, vi } from 'vitest';

let chatIdSeq = 0;
const calls = [];
vi.mock('../src/api', () => ({
  aiApi: {
    getChat: () => Promise.resolve(null),
    addInsert: (chatId, text) => { calls.push(['add', chatId, text]); return Promise.resolve({ items: [text] }); },
    clearInsert: (chatId) => { calls.push(['clear', chatId]); return Promise.resolve({ items: [] }); },
    removeInsert: (chatId, index) => {
      calls.push(['remove', chatId, index]);
      return Promise.resolve({ items: ['甲', '丙'], removed: '乙' });
    },
  },
  settingsApi: { getAll: () => Promise.resolve({}), update: () => Promise.resolve({}), appInfo: () => Promise.resolve({}) },
}));
vi.mock('../src/features/chat/chatStream', () => ({
  openChatStream: () => ({ abort() {}, done: Promise.resolve() }),
  openPressStream: () => ({ abort() {}, done: Promise.resolve() }),
}));

const { useChatStore } = await import('../src/features/chat/chatStore');

describe('待注入提示词单条删除', () => {
  it('按 index 调接口，列表用服务端回的那份', async () => {
    const store = useChatStore();
    const id = ++chatIdSeq;
    store.state.chatId = id;
    store.state.insertItems = ['甲', '乙', '丙'];
    await store.removeInsert(1);
    expect(calls.some((c) => c[0] === 'remove' && c[1] === id && c[2] === 1)).toBe(true);
    expect(store.state.insertItems).toEqual(['甲', '丙']);
  });

  it('没有会话时直接返回，不发请求', async () => {
    const store = useChatStore();
    store.state.chatId = null;
    const before = calls.length;
    await store.removeInsert(0);
    expect(calls.length).toBe(before);
  });
});
