/**
 * 公式与图表出图（#221）。
 *
 * 这条测的是「挂上消息之后到底出不出图」：markdown.test.js 已经管住了容器形状和回落文本，
 * 但容器对、渲染器没被调用（或者签名算错、nextTick 时机不对）也是白搭 —— 那正好是用户看得到、
 * 单测看不见的那一段。mermaid 在 jsdom 里本来就画不出来（没有 SVG 度量），
 * 所以这里对它的要求刻意放低：不许画成空白，源码必须一直在。
 */
import { describe, it, expect } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import ChatMessage from '../src/features/chat/ChatMessage.vue';

async function mountMsg(content) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp({
    render: () => h(ChatMessage, { role: 'assistant', content, busy: false, msgId: 1, index: 0 }),
  });
  app.mount(host);
  // 渲染器是 onMounted 之后动态 import 进来的，给几轮微任务 + 一点真实时间等它落地
  for (let i = 0; i < 12; i++) {
    await nextTick();
    await new Promise((r) => setTimeout(r, 25));
  }
  return { host, unmount: () => { app.unmount(); host.remove(); } };
}

describe('公式渲染', () => {
  it('行内 $…$ 出图，块级 $$…$$ 也出图', async () => {
    const { host, unmount } = await mountMsg(
      '质能方程 $E=mc^2$ 很有名。\n\n$$\\int_0^1 x\\,dx = \\frac{1}{2}$$\n'
    );
    expect(host.querySelector('.md-math .katex')).toBeTruthy();
    const block = host.querySelector('.md-math-block');
    expect(block && block.querySelector('.katex')).toBeTruthy();
    unmount();
  });

  it('坏公式不许把字吞掉：出不了图就留原文', async () => {
    const { host, unmount } = await mountMsg('这里写坏了 $\\frac{1}{$ 应该还能看见原文');
    expect(host.textContent).toContain('\\frac{1}{');
    unmount();
  });

  it('mermaid 块在画不出来时仍然显示源码，而不是一块空白', async () => {
    const { host, unmount } = await mountMsg('```mermaid\ngraph TD; A[开始]-->B[结束];\n```\n');
    const box = host.querySelector('.md-mermaid');
    expect(box).toBeTruthy();
    expect(box.querySelector('pre.md-mermaid-src').textContent).toContain('graph TD');
    expect(box.textContent.trim().length).toBeGreaterThan(0);
    unmount();
  });

  it('代码块里的 $ 不会被当公式（渲染后代码原样）', async () => {
    const { host, unmount } = await mountMsg('```bash\necho "$HOME/dist"\n```\n');
    expect(host.textContent).toContain('$HOME/dist');
    expect(host.querySelector('.md-math')).toBeFalsy();
    unmount();
  });
});
