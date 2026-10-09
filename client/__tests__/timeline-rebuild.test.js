/**
 * ④ 重进会话后「工具卡堆在顶部、尾部 markdown 不渲染」（#241）。
 *
 * 库里以前只有 content / reasoning / steps 三份，交错顺序全丢了：重建时先把所有 steps 推完、
 * 最后把整段 content 挂到尾部 —— 于是流式时看到的「说一段、干一件、再说一段」变成
 * 「四张工具卡 + 底下两大段文字」，而且段与段之间只剩一个换行，marked 把它们当同一段的续行，
 * 尾部的 ## 列表 代码块就渲染不出来。
 * 现在服务端把每段正文作为 {type:'text'} 存进 steps（数组本身就是顺序），重建按它穿插；
 * 老消息没有 text 条目时仍退回旧摆法（不能把历史弄成空白）。
 */
import { describe, it, expect } from 'vitest';
import { createApp, h } from 'vue';
import ChatMessage from '../src/features/chat/ChatMessage.vue';

function mount(props) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp({
    render: () => h(ChatMessage, { role: 'assistant', msgId: 1, index: 0, ...props }),
  });
  app.mount(host);
  return { host, app };
}

const SEG_STEPS = [
  { type: 'text', text: '先说第一段' },
  { type: 'result', name: 'grep', output: '命中若干行' },
  { type: 'text', text: '## 小节标题\n收尾第二段' },
];

describe('按 steps 里的 text 条目重建交错顺序', () => {
  it('正文插在工具卡之间，不是全堆在尾部', () => {
    const { host, app } = mount({
      busy: false, steps: SEG_STEPS, timeline: null,
      content: '先说第一段\n\n## 小节标题\n收尾第二段', reasoning: '',
    });
    const seq = [...host.querySelectorAll('.body-wrap, .step')].map((el) => (el.classList.contains('body-wrap') ? 'text' : 'step'));
    expect(seq).toEqual(['text', 'step', 'text']);
    expect(host.querySelector('.body-wrap').textContent).toContain('先说第一段');
    app.unmount(); host.remove();
  });

  it('每段单独过一次 marked：尾部那段的小节标题真的成了 <h2>', () => {
    const { host, app } = mount({
      busy: false, steps: SEG_STEPS, timeline: null,
      content: '先说第一段\n\n## 小节标题\n收尾第二段', reasoning: '',
    });
    const last = [...host.querySelectorAll('.body-wrap')].at(-1);
    expect(last.querySelector('h2')).toBeTruthy();
    expect(last.textContent).toContain('收尾第二段');
    // 两段正文不能糊成一块（一块就意味着段间的 \n 把标题吃掉了）
    expect(host.querySelectorAll('.body-wrap').length).toBe(2);
    app.unmount(); host.remove();
  });

  it('text 条目不会变成一张步骤卡', () => {
    const { host, app } = mount({ busy: false, steps: SEG_STEPS, timeline: null, content: '', reasoning: '' });
    expect(host.querySelectorAll('.step').length).toBe(1);   // 只有 grep 那张
    app.unmount(); host.remove();
  });

  it('老消息（steps 里没有 text 条目）退回旧摆法：正文整段挂在尾部', () => {
    const { host, app } = mount({
      busy: false,
      steps: [{ type: 'result', name: 'read_file', output: '内容' }],
      timeline: null,
      content: '以前只存了一份正文', reasoning: '',
    });
    const seq = [...host.querySelectorAll('.body-wrap, .step')].map((el) => (el.classList.contains('body-wrap') ? 'text' : 'step'));
    expect(seq).toEqual(['step', 'text']);
    expect(host.querySelector('.body-wrap').textContent).toContain('以前只存了一份正文');
    app.unmount(); host.remove();
  });
});
