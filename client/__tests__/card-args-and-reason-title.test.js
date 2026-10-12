/**
 * 第七十四轮 ⑥⑦：卡片上的两件事 —— 「思考中」只标还在输出的那一段，工具卡要看得见实际请求内容。
 *
 * ⑥ 的病灶是判据用错了级别：`busy` 是「这条会话有流在跑」，一轮里可以交错出好几段思考
 * （思考→工具→再思考→正文），老代码把它们全标成「思考中…」，只有整回合结束才一起变「思考过程」。
 * ⑦ 的病灶不是没数据：SSE 的 t:'tool' 帧与落库的 steps 都带 args，
 * 是前端把「调用行 + 结果行」配对成一张卡时把调用行整条 hide 掉，命令原文跟着一起消失
 * —— 表现就是「只看到 run_command 和 ls 的输出，看不到跑的是 ls」。
 *
 * 都用真挂载的 ChatMessage 量（只看源码等于没验）。
 */
import { describe, it, expect } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import ChatMessage from '../src/features/chat/ChatMessage.vue';

async function mountWith(props) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp({
    render: () => h(ChatMessage, { role: 'assistant', content: '', busy: false, msgId: 1, index: 0, ...props }),
  });
  app.mount(host);
  for (let i = 0; i < 6; i++) { await nextTick(); await new Promise((r) => setTimeout(r, 20)); }
  return { host, unmount: () => { app.unmount(); host.remove(); } };
}
const titles = (host) => [...host.querySelectorAll('.reason summary')].map((s) => s.textContent.trim());

describe('⑥ 思考卡标题按「这一段」判', () => {
  // 一段思考 → 一次工具调用 → 又一段思考；流还在跑
  const tl = [
    { kind: 'reason', text: '先看目录结构' },
    { kind: 'step', type: 'tool', name: 'run_command', args: { command: 'ls' } },
    { kind: 'step', type: 'result', name: 'run_command', output: 'a.txt' },
    { kind: 'reason', text: '那就读第一个' },
  ];

  it('跑动中：更早的那段思考已经是「思考过程」，只有尾部这段还在「思考中」', async () => {
    const { host, unmount } = await mountWith({ timeline: tl, busy: true });
    const t = titles(host);
    expect(t.length).toBe(2);
    expect(t[0]).toContain('思考过程');
    expect(t[1]).toContain('思考中');
    unmount();
  });

  it('交棒给正文之后，尾部那段也不再是「思考中」', async () => {
    const { host, unmount } = await mountWith({ timeline: [...tl, { kind: 'text', text: '结论是这个。' }], busy: true });
    expect(titles(host).filter((x) => x.includes('思考中')).length).toBe(0);
    unmount();
  });

  it('回合结束（busy=false）时两段都是「思考过程」', async () => {
    const { host, unmount } = await mountWith({ timeline: tl, busy: false });
    const t = titles(host);
    expect(t.length).toBe(2);
    expect(t.every((x) => x.includes('思考过程'))).toBe(true);
    unmount();
  });

  it('历史重建那条路（只有 reasoning 字段）不该出现「思考中」', async () => {
    const { host, unmount } = await mountWith({ reasoning: '当时想过这些', busy: true });
    expect(titles(host).join('|')).toContain('思考过程');
    unmount();
  });
});

describe('⑦ 工具卡看得见实际请求内容', () => {
  it('调用行与结果行并成一张卡后，命令原文还在（run_command 看得见 ls）', async () => {
    const steps = [
      { type: 'tool', name: 'run_command', args: { command: 'ls -la /tmp' } },
      { type: 'result', name: 'run_command', output: 'total 0' },
    ];
    const { host, unmount } = await mountWith({ steps });
    const head = host.querySelector('.step .step-head');
    expect(head.textContent).toContain('run_command');
    expect(head.querySelector('.args') && head.querySelector('.args').textContent).toContain('ls -la /tmp');
    unmount();
  });

  it('刷新之后（走落库的 steps）同样看得见', async () => {
    // 上面那条走的是同一份 steps，这里换一个工具确认不是硬编码给 run_command：
    // 网址类给 URL，grep 类给 pattern
    const { host, unmount } = await mountWith({
      steps: [
        { type: 'tool', name: 'grep', args: { pattern: 'kh73', path: 'D:\\proj' } },
        { type: 'result', name: 'grep', output: '命中 3 处' },
      ],
    });
    const args = host.querySelector('.step .step-head .args');
    expect(args.textContent).toContain('pattern=kh73');
    expect(host.querySelector('.step .step-head').textContent).toContain('D:\\proj');   // 路径仍在原来的位置
    unmount();
  });

  it('正文类参数（write_file 的 content）不塞进这一行，卡片不会被几千字撑爆', async () => {
    const { host, unmount } = await mountWith({
      steps: [
        { type: 'tool', name: 'write_file', args: { path: 'D:\\a.txt', content: 'X'.repeat(500) } },
        { type: 'result', name: 'write_file', path: 'D:\\a.txt', output: 'ok', new_file: true },
      ],
    });
    const head = host.querySelector('.step .step-head');
    expect(head.textContent).not.toContain('XXXX');
    unmount();
  });
});
