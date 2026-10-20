/**
 * #251 思考与正文的交错顺序。
 *
 * 他报的两个症状：「思考给前后两段连续的正文强行分开」「思考也会被正文强行分开」。
 * 三处根因，这里逐个钉死：
 *   A/B 前端 30ms 缓冲：以前按 kind 分两个桶、落地时固定「先正文后思考」。
 *       只要一个窗口里同时落了两种块，屏幕上的顺序就被改写，而且
 *       「T1 思考 T2」里的 T1/T2 被思考卡隔开后**再也合不回去**（tlAppendText 只并紧邻同类）。
 *   C   后端拆分器：同一 chunk 里的交替被聚合成两个串（服务端测试里钉）。
 *   D   重进会话：steps 里没有 reason 段时，整块 reasoning 被顶到最前面。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createApp, h } from 'vue';
import { useChatStore } from '../src/features/chat/chatStore';
import ChatMessage from '../src/features/chat/ChatMessage.vue';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mkReply = () => ({
  role: 'assistant', content: '', reasoning: '', steps: [], timeline: [], usage: null, model_name: '', unfinished: false,
});
const seq = (tl) => tl.map((x) => (x.kind === 'step' ? 'step:' + x.type : x.kind));

let hosts = [];
afterEach(() => { for (const x of hosts.splice(0)) x.host.remove(); });

describe('30ms 窗口里正文与思考的落地顺序', () => {
  it('思考先到、正文后到 —— 不许被重排成「正文在前」', async () => {
    const store = useChatStore();
    const r = mkReply();
    store.handleEvent({ t: 'reason', text: '先想一段' }, r);
    store.handleEvent({ t: 'delta', text: '再答一句' }, r);
    await sleep(40);
    // 修之前这里是 ['text','reason']：同一窗口里固定正文先落，顺序被改写
    expect(seq(r.timeline)).toEqual(['reason', 'text']);
    expect(r.timeline[0].text).toBe('先想一段');
    expect(r.timeline[1].text).toBe('再答一句');
  });

  it('思考 → 正文 → 思考：第二段思考独立成卡，不被并进第一段、也不被正文吃掉', async () => {
    const store = useChatStore();
    const r = mkReply();
    store.handleEvent({ t: 'reason', text: '第一段思考' }, r);
    store.handleEvent({ t: 'delta', text: '一句正文' }, r);
    store.handleEvent({ t: 'reason', text: '第二段思考' }, r);
    await sleep(40);
    expect(seq(r.timeline)).toEqual(['reason', 'text', 'reason']);
    expect(r.timeline[2].text).toBe('第二段思考');
  });

  it('正文 → 思考 → 正文：两段正文各自成段（中间真的隔着思考），不是被思考劈开的同一段', async () => {
    const store = useChatStore();
    const r = mkReply();
    store.handleEvent({ t: 'delta', text: '前半句，' }, r);
    store.handleEvent({ t: 'reason', text: '停下来想想' }, r);
    store.handleEvent({ t: 'delta', text: '后半句。' }, r);
    await sleep(40);
    expect(seq(r.timeline)).toEqual(['text', 'reason', 'text']);
    expect(r.timeline[0].text).toBe('前半句，');
    expect(r.timeline[2].text).toBe('后半句。');
    expect(r.content).toBe('前半句，后半句。');
  });

  it('同一类的连续块仍然合并成一段（缓冲改成队列不能把合并弄丢）', async () => {
    const store = useChatStore();
    const r = mkReply();
    store.handleEvent({ t: 'delta', text: '第一块' }, r);
    store.handleEvent({ t: 'delta', text: '第二块' }, r);
    store.handleEvent({ t: 'really-notchunk' }, r);   // 非增量事件强制 flush
    await sleep(40);
    expect(seq(r.timeline)).toEqual(['text']);
    expect(r.timeline[0].text).toBe('第一块第二块');
  });
});

describe('重进会话按 steps 顺序还原交错', () => {
  const mount = (props) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createApp({ render: () => h(ChatMessage, { role: 'assistant', msgId: 1, index: 0, ...props }) });
    app.mount(host);
    hosts.push({ host, app });
    return host;
  };
  // .body-wrap = 正文段；.reason = 思考卡（details）
  const rendered = (host) => [...host.querySelectorAll('.body-wrap, .reason, .step')]
    .map((el) => (el.classList.contains('body-wrap') ? 'text' : (el.classList.contains('reason') ? 'reason' : 'step')));

  it('steps 里有 reason 段时，按 steps 数组顺序还原（不再把整块思考顶到最前）', () => {
    const host = mount({
      busy: false, timeline: null, reasoning: '整块思考（应当被忽略）',
      steps: [
        { type: 'reason', text: '第一段思考' },
        { type: 'text', text: '第一段正文' },
        { type: 'reason', text: '第二段思考' },
        { type: 'text', text: '第二段正文' },
      ],
      content: '第一段正文\n\n第二段正文',
    });
    expect(rendered(host)).toEqual(['reason', 'text', 'reason', 'text']);
    expect(host.querySelector('.reason').textContent).toContain('第一段思考');
  });

  it('老消息（steps 里没有 reason 段）仍用整块 reasoning 兜底，顶在最前', () => {
    const host = mount({
      busy: false, timeline: null, reasoning: '老消息的整块思考',
      steps: [{ type: 'text', text: '正文' }],
      content: '正文',
    });
    expect(rendered(host)).toEqual(['reason', 'text']);
  });
});
