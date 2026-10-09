/**
 * ③ 一段思考被截成两段 + ⑤ note 被当成工具调用（#243 / #238）。
 *
 * 两条同一个来源：服务端每遇 429 限流 / 超时 / 参数重试都发一条 note（server/routes/ai.js 的重试分支），
 * 而前端「任何非 delta/reason 的事件都先封口」，于是：
 *   - note 一插进来，同一段思考就被切成两张「思考过程」卡；
 *   - note 和工具卡同属 kind:'step'，折叠组按 step 连排成组 → 「N 步工具调用」把 note 也数进去。
 * 这两条都得从 store 的事件分发那一层验，组件里看不出来。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import { useChatStore } from '../src/features/chat/chatStore';
import ChatMessage from '../src/features/chat/ChatMessage.vue';
import { uiPrefs } from '../src/stores/prefs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mkReply = () => ({
  role: 'assistant', content: '', reasoning: '', steps: [], timeline: [], usage: null, model_name: '', unfinished: false,
});
const reasons = (tl) => tl.filter((x) => x.kind === 'reason');

let hosts = [];
afterEach(() => { for (const x of hosts.splice(0)) x.host.remove(); uiPrefs.state.toolCollapse = false; });

describe('思考不被过程提示切断', () => {
  it('reason → note → reason 仍是同一段思考（note 留在原位）', async () => {
    const store = useChatStore();
    const r = mkReply();
    store.handleEvent({ t: 'reason', text: '先想一半' }, r);
    store.handleEvent({ t: 'note', message: '上游 429，第 2 次重试' }, r);
    store.handleEvent({ t: 'reason', text: '，接着想完' }, r);
    await sleep(40);   // 增量是攒 30ms 再落地的（#231），最后一段得等它 flush
    expect(reasons(r.timeline).length).toBe(1);
    expect(reasons(r.timeline)[0].text).toBe('先想一半，接着想完');
    expect(r.reasoning).toBe('先想一半，接着想完');
    expect(r.timeline[1].type).toBe('note');
    expect(r.timeline[1].message).toContain('429');
  });

  it('工具卡是真的换段：它前后的思考该分成两段', async () => {
    const store = useChatStore();
    const r = mkReply();
    store.handleEvent({ t: 'reason', text: '第一段思考' }, r);
    store.handleEvent({ t: 'tool', name: 'read_file', args: { path: 'a.txt' }, call_id: 'c1' }, r);
    store.handleEvent({ t: 'reason', text: '第二段思考' }, r);
    await sleep(40);
    expect(reasons(r.timeline).length).toBe(2);
    expect(reasons(r.timeline).map((x) => x.text)).toEqual(['第一段思考', '第二段思考']);
  });
});

describe('note 不计入工具调用', () => {
  /* 两次真调用（调用行会被配对循环 hide 掉，只剩结果行可见）+ 一条 note。
     修好之后：一组「2 步工具调用」，note 单独显示、不进步数。
     修之前有两处错：① note 被当成一步（虚报成 3 步）；② 被 hide 的调用行把连排段打断，
     结果 [调用,结果,调用,结果] 这种最常见形状根本成不了组 —— 折叠形同虚设。
     step 条目必须带 ref：ChatMessage 的 timeline computed 对 props.timeline 是按 ref 展开的。 */
  const step = (o) => ({ kind: 'step', ref: o, ...o });
  const tl = [
    step({ type: 'tool', name: 'grep', args: {} }),
    step({ type: 'result', name: 'grep', output: 'x' }),
    step({ type: 'tool', name: 'read_file', args: {} }),
    step({ type: 'result', name: 'read_file', output: 'y' }),
    step({ type: 'note', message: '上游限流，重试中' }),
  ];

  function mount(timeline) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createApp({
      render: () => h(ChatMessage, { role: 'assistant', busy: false, timeline, msgId: 1, index: 0 }),
    });
    app.mount(host);
    hosts.push({ host, app });
    return { host, app };
  }

  it('两次调用合成一组「2 步工具调用」，note 不进步数', async () => {
    uiPrefs.state.toolCollapse = true;
    const { host } = mount(tl);
    await nextTick();
    const heads = [...host.querySelectorAll('.step.fold')];
    expect(heads.length).toBe(1);
    expect(heads[0].textContent).toContain('2 步工具调用');
    expect(heads[0].textContent).not.toContain('3 步');
    expect(heads[0].textContent).not.toContain('4 步');
  });

  it('note 自己仍然照常显示（不计步 ≠ 不显示）', async () => {
    uiPrefs.state.toolCollapse = true;
    const { host } = mount(tl);
    await nextTick();
    const notes = [...host.querySelectorAll('.step-note')];
    expect(notes.some((el) => el.textContent.includes('上游限流'))).toBe(true);
  });
});
