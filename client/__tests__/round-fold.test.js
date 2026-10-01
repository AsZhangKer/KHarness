/**
 * 长回合向上折叠（#231 第二条）。
 * 他要的是「某一轮太长时，折掉它**上面**那些，最近几段一直留在眼前」——
 * 方向反了就等于把刚吐出来的结论藏起来；流式时更要跟着长，否则读一段就得手动下翻一次。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createApp, h, nextTick, ref } from 'vue';
import ChatMessage from '../src/features/chat/ChatMessage.vue';
import { uiPrefs } from '../src/stores/prefs';

const ROUND_KEEP = 14;   // 和 ChatMessage 里那个常量对齐：改那里要改这里

let mounted = [];

/** timeline 用 ref 包着：真流式就是往同一个数组上 push，测试要复现同一套响应 */
function mountMsg(props) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const tl = ref(props.timeline || []);
  const app = createApp({
    render: () => h(ChatMessage, { role: 'assistant', msgId: 1, index: 0, ...props, timeline: tl.value }),
  });
  app.mount(host);
  mounted.push({ host, app });
  return { host, app, tl };
}

afterEach(() => {
  for (const m of mounted.splice(0)) { m.app.unmount(); m.host.remove(); }
  uiPrefs.state.toolCollapse = false;
});

/** 折起来的段根本不进 DOM（v-if），所以「在不在 DOM 里」就是「渲没渲染」 */
const rendered = (host) => [...host.querySelectorAll('.reason, .step, .body-wrap')];
const visible = (host) => rendered(host).filter((el) => el.style.display !== 'none');
const texts = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ kind: 'text', text: `第 ${from + i} 段` }));

describe('长回合向上折叠', () => {
  it('不足 ROUND_KEEP 段：不折，也不冒按钮', () => {
    const { host } = mountMsg({ busy: false, timeline: texts(ROUND_KEEP) });
    expect(host.querySelector('.fold-top')).toBeFalsy();
    expect(visible(host).length).toBe(ROUND_KEEP);
  });

  it('超了：折掉上面那些，只留最近 ROUND_KEEP 段，按钮报出藏了几段', () => {
    const tl = texts(ROUND_KEEP + 6);
    const { host } = mountMsg({ busy: false, timeline: tl });
    expect(host.querySelector('.fold-top').textContent).toContain('6 段');
    const vis = visible(host);
    expect(vis.length).toBe(ROUND_KEEP);
    // 折起来的那些根本不在 DOM 里（v-if，不是 v-show）—— 否则「收起」就白收了
    expect(rendered(host).length).toBe(ROUND_KEEP);
    expect(host.textContent).not.toContain('第 0 段');
    // 留下的必须是最后那些：结论不能藏起来
    expect(vis[0].textContent).toContain(`第 ${tl.length - ROUND_KEEP} 段`);
    expect(vis.at(-1).textContent).toContain(`第 ${tl.length - 1} 段`);
  });

  it('流式中边长边折：带光标的最新那段永远看得见', async () => {
    const { host, tl } = mountMsg({ busy: true, timeline: texts(ROUND_KEEP) });
    expect(host.querySelector('.fold-top')).toBeFalsy();
    for (let i = ROUND_KEEP; i < ROUND_KEEP + 5; i++) tl.value.push({ kind: 'text', text: `第 ${i} 段` });
    await nextTick();
    expect(host.querySelector('.fold-top').textContent).toContain('5 段');
    const last = visible(host).at(-1);
    expect(last.querySelector('.caret-dot')).toBeTruthy();
    expect(last.textContent).toContain(`第 ${tl.value.length - 1} 段`);
  });

  it('点了按钮全摊开，按钮自己消失', async () => {
    const { host } = mountMsg({ busy: false, timeline: texts(ROUND_KEEP + 6) });
    host.querySelector('.fold-top').click();
    await nextTick();
    expect(host.querySelector('.fold-top')).toBeFalsy();
    expect(visible(host).length).toBe(ROUND_KEEP + 6);
  });

  it('折叠组和界线跨界时不能只藏头：头还在，整组收成一行', () => {
    uiPrefs.state.toolCollapse = true;
    const steps = Array.from({ length: 6 }, (_, i) => ({ kind: 'step', type: 'result', name: 'grep', output: `结果 ${i}` }));
    // 组头下标 2 < foldFrom(=4)，成员跨过界线：只藏头会让整组凭空消失
    const tl = [{ kind: 'text', text: '开头' }, { kind: 'text', text: '第二段' }, ...steps, ...texts(10, 100)];
    expect(tl.length).toBe(18);
    const { host } = mountMsg({ busy: false, timeline: tl });
    const head = host.querySelector('.step.fold');
    expect(head).toBeTruthy();
    expect(head.style.display).not.toBe('none');
    expect(head.textContent).toContain('6 步工具调用');
  });
});
