/**
 * 渲染开销读数（#231）。
 *
 * 为什么测这个：这一轮装机版在流式与切页时卡，我在会话里量不到长任务（浏览器自动化和
 * Electron 调试口这会话都被权限闸拦了），所以先把「唯一能确定的成本源」量成硬数：
 * 模板里 `renderMarkdown(item.text)` 是每次重渲染、每个文本条目都全量跑一遍 marked+DOMPurify+hljs。
 * 于是「一次增量」的代价 = 本轮条目数 × 单条渲染耗时 —— 会话越长越贵，这和他说的「上下文长了才卡」对得上。
 *
 * 这个文件同时是改前读数和改后断言：优化（按条目缓存渲染结果）之后，
 * 30 次增量不该再打满 300 次 renderMarkdown。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp, h, nextTick, ref } from 'vue';

const counters = vi.hoisted(() => ({ markdown: 0, chars: 0 }));

vi.mock('../src/utils/format', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    renderMarkdown: (text) => {
      counters.markdown += 1;
      counters.chars += String(text || '').length;
      return actual.renderMarkdown(text);
    },
  };
});

const ChatMessage = (await import('../src/features/chat/ChatMessage.vue')).default;
const { clearMarkdownCache } = await import('../src/utils/mdcache');

const SENTENCE = '这一段是模型给出的实现说明，里面带了 `code`、列表和一段代码块，用来贴近真实回复。';
function longText(k) {
  return `#### 第 ${k} 步说明\n\n${SENTENCE.repeat(30)}\n\n\`\`\`js\nconst a = ${k};\nconsole.log(a);\n\`\`\`\n`;
}

function mountTimeline(items, busy = false) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const tl = ref(items.slice());
  const app = createApp({
    render: () => h(ChatMessage, { role: 'assistant', busy, timeline: tl.value, msgId: 1, index: 0 }),
  });
  app.mount(host);
  return { host, tl, app, unmount: () => { app.unmount(); host.remove(); } };
}

beforeEach(() => { counters.markdown = 0; counters.chars = 0; clearMarkdownCache(); });

describe('渲染开销读数', () => {
  it('单条长回复渲染一次的实测耗时（打印读数，不设阈值：机器快慢不一）', async () => {
    const t0 = performance.now();
    const { host, unmount } = await mountTimeline([{ kind: 'text', text: longText(1) }]);
    const one = performance.now() - t0;
    expect(host.querySelector('.body md, .body')).toBeTruthy();
    console.log(`  [读数] 挂载 1 条长回复（${longText(1).length} 字）：${one.toFixed(1)}ms，renderMarkdown 调用 ${counters.markdown} 次`);
    unmount();
  });

  it('30 次流式增量：每来一个字节就把整轮所有条目重算一遍（这是要治的那件事）', async () => {
    const items = [];
    for (let i = 0; i < 10; i++) {
      items.push({ kind: 'step', type: 'result', name: 'read_file', output: 'x'.repeat(200) });
      items.push({ kind: 'text', text: longText(i) });
    }
    const { host, tl, unmount } = mountTimeline(items, true);
    await nextTick();
    const baseline = counters.markdown;
    // 只在最后一条正文上追加增量（前面的条目内容一字未变）
    for (let n = 0; n < 30; n++) {
      tl.value[tl.value.length - 1].text += '又长了一点。';
      await nextTick();
    }
    const perDelta = (counters.markdown - baseline) / 30;
    console.log(`  [读数] 30 次增量共调用 renderMarkdown ${counters.markdown - baseline} 次：平均每次增量重算 ${perDelta.toFixed(1)} 个条目（本轮文本条目 10 个）`);
    // 先证明这一轮真的重渲染了（不然这条读数就是假的）。
    // 注意别用 .body-wrap:last-of-type —— :last-of-type 看的是「同类标签最后一个 div」，不是最后一个 .body-wrap。
    const bodies = [...host.querySelectorAll('.body-wrap .body')];
    expect(bodies[bodies.length - 1].textContent).toContain('又长了一点');
    // 改后期望：一次增量只该重算真正变了的那一条（± 首帧抖动），不是整轮 10 条
    expect(perDelta).toBeLessThanOrEqual(1.5);
    unmount();
  });

  it('整屏历史重渲染（切回主页那条路）：条目数直接乘进耗时', async () => {
    const msgs = [];
    for (let i = 0; i < 20; i++) msgs.push(longText(i));
    const t0 = performance.now();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createApp({
      render: () => h('div', {}, msgs.map((m, i) => h(ChatMessage, { role: 'assistant', busy: false, timeline: [{ kind: 'text', text: m }], msgId: i, index: i, key: i }))),
    });
    app.mount(host);
    const ms = performance.now() - t0;
    console.log(`  [读数] 20 条长回复整屏渲染：${ms.toFixed(1)}ms，renderMarkdown ${counters.markdown} 次，合计 ${counters.chars} 字`);
    expect(counters.markdown).toBe(20);
    app.unmount();
    host.remove();
  });
});
