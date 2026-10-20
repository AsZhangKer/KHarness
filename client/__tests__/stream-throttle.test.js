/**
 * 流式落地的节流（#251）。
 *
 * 他报的「模型回复时或者文本过长时整个程序会变得很卡」是同一件事的两个尺度：
 * 流式那一段每落一批就要把整段正文重新过一遍 marked + DOMPurify + hljs，
 * 段落越长单次越贵，而固定 30ms 的间隔等于把主线程占满。
 * 这里钉两条：
 *   ① 一批只让 streamTick 动一次（它是「重渲染 + 跟着滚」的驱动源）
 *   ② 正文越长，落地间隔越长（自适应），但最终一定会落地
 */
import { describe, it, expect } from 'vitest';
import { useChatStore } from '../src/features/chat/chatStore';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mkReply = () => ({
  role: 'assistant', content: '', reasoning: '', steps: [], timeline: [], usage: null, model_name: '', unfinished: false,
});

describe('流式落地节流', () => {
  it('一批里落多段，streamTick 只 +1（以前按段各加一次，批里有几段就白渲染几遍）', async () => {
    const store = useChatStore();
    const r = mkReply();
    const before = store.state.streamTick;
    store.handleEvent({ t: 'delta', text: '正文甲' }, r);
    store.handleEvent({ t: 'reason', text: '思考' }, r);
    store.handleEvent({ t: 'delta', text: '正文乙' }, r);
    await sleep(60);
    expect(store.state.streamTick - before).toBe(1);
    expect(r.timeline.map((x) => x.kind)).toEqual(['text', 'reason', 'text']);
  });

  it('正文很长时落地被推迟（30ms 档 → 更慢的档），但最终一定落地', async () => {
    const store = useChatStore();
    const r = mkReply();
    r.content = 'x'.repeat(25000);      // > 20000：落到最慢那档
    store.handleEvent({ t: 'delta', text: '最后一句' }, r);
    await sleep(60);
    // 60ms 时还没落地 —— 短会话此时早就落了（30ms 档）
    expect(r.timeline.length).toBe(0);
    await sleep(150);
    expect(r.timeline.length).toBe(1);
    expect(r.timeline[0].text).toBe('最后一句');
  });

  it('短会话仍然是「快档」：60ms 内已经看得见字（别为了性能把短回复也拖慢）', async () => {
    const store = useChatStore();
    const r = mkReply();
    store.handleEvent({ t: 'delta', text: '短回复' }, r);
    await sleep(60);
    expect(r.timeline.length).toBe(1);
  });

  it('上一批很贵时自动降频（用实测耗时兜底，不靠猜文本长度）', async () => {
    const store = useChatStore();
    const r = mkReply();
    // 假装上一批的渲染花了 200ms
    r._flushCost = 200;
    store.handleEvent({ t: 'delta', text: '一个字' }, r);
    await sleep(60);
    expect(r.timeline.length).toBe(0);   // 间隔被抬到 ~300ms 上限附近
    await sleep(320);
    expect(r.timeline.length).toBe(1);
  });
});
