/**
 * 压缩进行中不许把消息直接发出去（他第八十二轮报的「为什么压缩中还能发消息」）。
 *
 * 为什么这算 bug 而不是体验问题：/press 那一条 HTTP 在改这条会话的上下文 —— 旧消息 archived=1、
 * 摘要与锚点重写；同一时刻发出去的那一轮手里攥的还是**压缩前那份整包**，回合结束却按压缩后的锚点记账。
 * 两边各记各的，屏幕上那个数就和模型真吃进去的东西彻底脱节。
 *
 * 口径与「生成中」一致：这句话进队列，压完自动补发（不是报错、也不是吞掉）。
 * 服务端另有第二道闸（liveTurnChats / pressingChats 互斥，回 409），这个文件锁的是前端这一头。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let chatStreams = [];
let pressCalls = [];
let pressHandlers = null;

vi.mock('../src/features/chat/chatStream', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    openChatStream: (body) => { chatStreams.push(body); return { abort() {}, done: Promise.resolve() }; },
    openPressStream: (body, handlers) => { pressCalls.push(body); pressHandlers = handlers; return { abort() {}, done: Promise.resolve() }; },
  };
});
// 替身一律回 []：send 走到底会调 refreshTree/getTasks 那一串，它们只接受数组，
// 回 {} 会在替身里就炸掉（那是一条与本用例无关的假失败）。
vi.mock('../src/api', () => {
  const any = () => () => Promise.resolve([]);
  return { aiApi: new Proxy({}, { get: any }), settingsApi: new Proxy({}, { get: any }) };
});

const { useChatStore } = await import('../src/features/chat/chatStore');
const { running } = await import('../src/stores/running');

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('压缩占用这条会话', () => {
  const store = useChatStore();
  const s = store.state;

  beforeEach(() => {
    chatStreams = []; pressCalls = []; pressHandlers = null;
    s.chatId = 7;
    s.models = [{ id: 5, display_name: '假模型' }];
    s.modelIdx = 0;
    s.queue = [];
    s.messages = [];
    s.busyChats = {};
    s.pressing = false;
    s.pressingChatId = 0;
  });

  it('按下压缩后再发消息：这句话进队列，一条流都不发', async () => {
    store.pressChat(5);
    expect(s.pressing).toBe(true);
    await store.send('压缩期间打的这句');
    expect(chatStreams).toHaveLength(0);
    expect(s.queue.map((q) => q.text)).toEqual(['压缩期间打的这句']);
  });

  it('压缩收尾后队列里那句自动发出（不是留在队列里等人再按一次）', async () => {
    store.pressChat(5);
    await store.send('压完再发');
    expect(chatStreams).toHaveLength(0);
    pressHandlers.onEvent({ t: 'compress', phase: 'start', used: 9000, limit: 10000, percent: 90 });
    pressHandlers.onEvent({ t: 'compress', phase: 'done', used: 9000, after: 1200, limit: 10000, chars: 300, archived: 6 });
    pressHandlers.onDone();
    await tick(); await tick();
    expect(chatStreams.map((b) => b.content)).toEqual(['压完再发']);
    expect(s.pressing).toBe(false);
  });

  it('别条会话的压缩不挡这条会话发送（占用要对号）', async () => {
    s.pressing = true;
    s.pressingChatId = 8;          // 压缩的是 8，人正看着 7
    await store.send('这条照发');
    expect(chatStreams).toHaveLength(1);
  });

  it('关闭确认要的那份计数：流与压缩都算，闲下来归零', async () => {
    expect(running.count).toBe(0);
    store.pressChat(5);
    await tick();
    expect(running.count).toBe(1);   // 只有压缩在跑
    pressHandlers.onEvent({ t: 'compress', phase: 'skipped', message: '没东西可压' });
    pressHandlers.onDone();
    await tick();
    expect(running.count).toBe(0);
  });
});
