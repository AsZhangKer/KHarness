/**
 * #253「工具调用自动折叠勾选无效果」。
 *
 * 先说清坏在哪：这个开关一路是通的（设置页 → uiPrefs.toolCollapse → 服务端 tool_call_collapse，
 * 白名单与默认值都在），唯一的消费者是 ChatMessage 的折叠组判据。但流式跑出来的时间线长这样：
 *   思考, 调用, 结果, 思考, 调用, 结果, 思考, 调用, 结果
 * （chatStore 每换一次产物就 push 一条新 reason，见 tailReason 那套走法）
 * 而判组要求「严格连排」，于是每一段都只有 1 步、`len < 2` 永不成立；
 * 反过来重进会话那条路是从 steps 重建的（思考不插在中间），组反倒成立 ——
 * 他看到的就是「刚跑完那会儿不折，重开这个会话才折」，等于勾了没反应。
 *
 * 修法口径是他拍的：**流式不折，只折历史**（busy 那道闸保留），但历史那一轮当场就要折得起来，
 * 且展开后能收回去（以前点开回不来）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createApp, h, nextTick, ref } from 'vue';
import ChatMessage from '../src/features/chat/ChatMessage.vue';
import { uiPrefs } from '../src/stores/prefs';

let mounted = [];

function mountMsg(props) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const tl = ref(props.timeline || []);
  const app = createApp({
    render: () => h(ChatMessage, { role: 'assistant', msgId: 1, index: 0, ...props, timeline: tl.value }),
  });
  app.mount(host);
  mounted.push({ host, app });
  return { host, tl };
}

afterEach(() => {
  for (const m of mounted.splice(0)) { m.app.unmount(); m.host.remove(); }
  uiPrefs.state.toolCollapse = false;
});

const cards = (host) => [...host.querySelectorAll('.step')].filter((el) => !el.classList.contains('fold'));
const foldRow = (host) => host.querySelector('.step.fold');

/** 一次工具调用 = 一条被 hide 的调用行 + 一条结果卡（配对循环的真实形状） */
const stepPair = (n) => [
  { kind: 'step', type: 'tool', name: 'grep', args: { pattern: n }, hide: true },
  { kind: 'step', type: 'result', name: 'grep', output: `结果 ${n}` },
];
/** 流式跑出来的形状：每两次调用之间都夹一段思考 */
const liveShape = (times) => {
  const tl = [];
  for (let i = 0; i < times; i++) {
    tl.push({ kind: 'reason', text: `想第 ${i} 步` });
    tl.push(...stepPair(i));
  }
  tl.push({ kind: 'text', text: '最后给出的结论' });
  return tl;
};

describe('工具调用自动折叠：流式跑完那一轮当场就该折', () => {
  it('勾上 + 回合结束：夹着思考的三次调用收成一行「3 步工具调用」，卡片不进 DOM', () => {
    uiPrefs.state.toolCollapse = true;
    const { host } = mountMsg({ busy: false, timeline: liveShape(3) });
    expect(foldRow(host)).toBeTruthy();
    expect(foldRow(host).textContent).toContain('3 步工具调用');
    expect(cards(host)).toHaveLength(0);
    // 思考段与正文不许跟着折进去：它们不是「动手」，藏了就把这轮想了什么全丢了
    expect(host.querySelectorAll('.reason')).toHaveLength(3);
    expect(host.querySelector('.body-wrap')).toBeTruthy();
  });

  it('不勾：逐张显示，一行都不冒（这条就是"勾与不勾必须看得出区别"的另一半）', () => {
    uiPrefs.state.toolCollapse = false;
    const { host } = mountMsg({ busy: false, timeline: liveShape(3) });
    expect(foldRow(host)).toBeFalsy();
    expect(cards(host)).toHaveLength(3);
  });

  it('流式期间永不折（他拍的口径：流式不折，只折历史）', () => {
    uiPrefs.state.toolCollapse = true;
    const { host } = mountMsg({ busy: true, timeline: liveShape(3) });
    expect(foldRow(host)).toBeFalsy();
    expect(cards(host)).toHaveLength(3);
  });

  it('note 不打断组、也不算进步数（三次调用中间夹一条限流提示 → 还是 3 步）', () => {
    uiPrefs.state.toolCollapse = true;
    const tl = liveShape(3);
    tl.splice(5, 0, { kind: 'step', type: 'note', message: '429 限流，重试中' });
    const { host } = mountMsg({ busy: false, timeline: tl });
    expect(foldRow(host).textContent).toContain('3 步工具调用');
    expect(host.querySelector('.step-note')).toBeTruthy();   // note 自己照常显示
  });

  it('只有一步不成组（收成一行反而更难看）', () => {
    uiPrefs.state.toolCollapse = true;
    const { host } = mountMsg({ busy: false, timeline: liveShape(1) });
    expect(foldRow(host)).toBeFalsy();
    expect(cards(host)).toHaveLength(1);
  });

  it('展开 → 卡片回来且组尾有「收起」；再点收起 → 又收成那一行', async () => {
    uiPrefs.state.toolCollapse = true;
    const { host } = mountMsg({ busy: false, timeline: liveShape(3) });
    foldRow(host).click();
    await nextTick();
    expect(foldRow(host)).toBeFalsy();
    expect(cards(host)).toHaveLength(3);
    const tail = cards(host)[2];
    const btn = [...tail.querySelectorAll('.link-btn')].find((b) => b.textContent.trim() === '收起');
    expect(btn, '组尾那张卡上该有「收起」').toBeTruthy();
    btn.click();
    await nextTick();
    expect(foldRow(host)).toBeTruthy();
    expect(cards(host)).toHaveLength(0);
  });
});
