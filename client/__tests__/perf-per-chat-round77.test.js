/**
 * 第七十七轮续3：首字 / tok/s 这两格**按会话分桶**之后的行为锁。
 *
 * 他报的三条，_tmp_kh77/speed_crosschat_probe.js 在真机上量到的原形状是：
 *   ① 后台那条会话的 done 把模块级 speedFinalized 钉住 → 屏幕上这条还在流，速度格 2.4 秒里只出 1 个值（冻结）；
 *   ② done 帧拿服务端 ttft_ms 覆盖客户端实测 → 口径变成「后端发请求→首包」，比「按下发送→首包」少一段（实测 8ms 对 39ms）；
 *   ③ 切会话把 firstTokenMs 清 0，切回正在生成的那条时又拿「按下发送」的锚点重记 → 首字成了整段墙钟（实测 2.6s，真值 38ms）。
 * ①② 这里用行为用例锁住（灌事件 + 走假时钟），③ 是 openChat 里那两行清零，用源码断言锁。
 *
 * 首字口径（他拍的）：按下发送 → 上游第一个包（思考/正文/工具调用谁先到算谁），记一次就不再改。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
const SRC = fs.readFileSync(path.resolve(__dirname, '../src/features/chat/chatStore.js'), 'utf8');

const VIEWED_BASE = 7;      // 屏幕上正在看的
const BACK_BASE = 99;       // 后台还在跑的
let V = VIEWED_BASE;
let B = BACK_BASE;
const here = () => ({ chatId: V });
const back = () => ({ chatId: B });

const store = useChatStore();
const s = store.state;

function newReply(startedMsAgo) {
  return {
    role: 'assistant', content: '', reasoning: '', steps: [], timeline: null,
    usage: null, model_name: '', unfinished: false, _startedAt: Date.now() - startedMsAgo,
  };
}

/** 每条用例换一对新 id：perfByChat 是模块级的桶，用同一个 id 会把上一条用例的读数带进来 */
let caseNo = 0;
function reset() {
  caseNo += 1;
  V = VIEWED_BASE + caseNo * 10;
  B = BACK_BASE + caseNo * 10;
  s.chatId = V;
  s.messages = [];
  s.firstTokenMs = 0;
  s.tokPerSec = 0;
  s.streamTokens = 0;
  s.latencyMs = 0;
  s.usage = {};
  s.tasks = [];
  s.subagents = {};
  s.queue = [];
  s.busyChats = {};
  s.msgBuf = {};
}

describe('首字 / tok/s 按会话分桶', () => {
  beforeEach(() => { reset(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('② 服务端 ttft_ms 不再覆盖客户端实测的首字（只在没量到时兜底）', () => {
    const r = newReply(300);
    store.handleEvent({ t: 'delta', text: '第一段正文' }, r, here());
    const clientSide = s.firstTokenMs;
    expect(clientSide).toBeGreaterThan(250);
    store.handleEvent({ t: 'done', latency_ms: 1200, ttft_ms: 42, gen_ms: 600, usage: { prompt_tokens: 900, completion_tokens: 30 } }, r, here());
    // 服务端那个 42ms 的起点是「后端把请求发出去」，少了按下发送到后端这一段 —— 不许拿它盖掉实测值
    expect(s.firstTokenMs).toBe(clientSide);
  });

  it('② 接回别人的流（没有 _startedAt 锚点）时才用服务端 ttft_ms 兜底', () => {
    const r = newReply(0);
    delete r._startedAt;
    store.handleEvent({ t: 'delta', text: '半路接上的一段' }, r, here());
    expect(s.firstTokenMs).toBe(0);            // 没锚点什么都不写，不许写 0.0s 那种坏读数
    store.handleEvent({ t: 'done', ttft_ms: 512, gen_ms: 600, usage: { completion_tokens: 30 } }, r, here());
    expect(s.firstTokenMs).toBe(512);
  });

  it('① 后台那条会话 done 了，屏幕上这条的速度照样每 0.2 秒往下刷', async () => {
    s.busyChats = { [V]: true, [B]: true };
    const rHere = newReply(50);
    const rBack = newReply(50);
    // 起表（watch 在下一个微任务里跑）+ 先让屏幕上这条攒够窗口
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 20; i++) {
      store.handleEvent({ t: 'delta', text: '第' + i + '段还在写的正文，够长才有 token 增量。' }, rHere, here());
      store.handleEvent({ t: 'delta', text: '后台那条也在写' + i }, rBack, back());
      await vi.advanceTimersByTimeAsync(200);
    }
    const before = s.tokPerSec;
    expect(before).toBeGreaterThan(0);
    // 后台收工（旧版就是这一步把全局 speedFinalized 钉住，屏幕上这条当场冻死）
    store.handleEvent({ t: 'done', ttft_ms: 40, gen_ms: 900, usage: { completion_tokens: 20 } }, rBack, back());
    expect(s.busyChats[B]).toBe(true);      // 这条流自己收尾，busy 由发起方清，不该动到屏幕上这条
    for (let i = 0; i < 12; i++) {
      store.handleEvent({ t: 'delta', text: '后台都收工了这一段还在继续写' + i + '，字越多增量越大。' }, rHere, here());
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(s.tokPerSec).toBeGreaterThan(0);
    expect(s.tokPerSec).not.toBe(before);      // 还在动 = 没冻结
  });

  it('屏幕上这条空闲、后台那条在流时，切回去不该看到速度停在 0', async () => {
    // 旧版表是跟着 state.busy（屏幕上这条）开/停的：看着空闲会话时后台那一桶根本不采样
    s.chatId = V + 500;                            // 屏幕上看一条没在跑的会话
    s.busyChats = { [B]: true };
    await vi.advanceTimersByTimeAsync(0);
    const rBack = newReply(60);
    for (let i = 0; i < 16; i++) {
      store.handleEvent({ t: 'delta', text: '后台这条一直在写' + i + '，一直写。' }, rBack, back());
      await vi.advanceTimersByTimeAsync(200);
    }
    s.chatId = V;                          // 桶还留着，切回来只是换个镜像
    store.handleEvent({ t: 'delta', text: '这条也终于开始写了一点' }, newReply(20), here());
    expect(s.firstTokenMs).toBeGreaterThan(0);  // 屏幕上这条自己的首字，没被后台那份污染
  });
});

describe('接线守门（不许改回模块级单份）', () => {
  it('首字 / 速度 / 生成时段都住在 perfByChat 那一桶里，模块级旧变量不许回来', () => {
    expect(SRC).toMatch(/const perfByChat = \{\};/);
    for (const dead of ['let speedFinalized', 'let speedSamples', 'let genSegStart', 'let genAccumMs']) {
      expect(SRC, dead + ' 又回来了：那正是「后台 done 冻结前台」的形状').not.toMatch(new RegExp(dead.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });

  it('③ 切会话不再把首字与已产出清零，而是换成目标会话那一桶', () => {
    const open = SRC.slice(SRC.indexOf('async function openChat'), SRC.indexOf('async function openChat') + 2200);
    expect(open).toMatch(/mirrorPerf\(\);/);
    expect(open).not.toMatch(/state\.firstTokenMs = 0;/);
    expect(open).not.toMatch(/state\.streamTokens = 0;/);
  });

  it('表跟着「有没有任何一条会话在跑」开停，不再盯屏幕上这一条的 busy', () => {
    expect(SRC).toMatch(/watch\(\(\) => Object\.keys\(state\.busyChats\)\.length/);
    expect(SRC).not.toMatch(/watch\(\(\) => state\.busy, \(b\) => \{/);
  });

  it('新建会话首轮拿到 id 时那一桶跟着搬（否则界面两格掉回空桶）', () => {
    expect(SRC).toMatch(/movePerf\(prevId, nextId\);/);
  });
});
