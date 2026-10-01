/**
 * 折叠到底省不省渲染（#231 的追问：「既然都收起来了还是很卡，是不是收起的那些也照样加载了？」）
 *
 * 这条测的就是那句质问：v-show 只是 display:none，节点照样建、markdown 照样跑一遍
 * marked + DOMPurify + hljs —— 收起来不等于没加载。所以先量「一轮 30 段」到底打了几次 renderMarkdown：
 * 期望是留在眼前那 14 段，不是 30 段；点「展开更早的 N 段」才把剩下的补齐。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp, h, nextTick, ref } from 'vue';

const counters = vi.hoisted(() => ({ markdown: 0 }));

vi.mock('../src/utils/format', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    renderMarkdown: (text) => {
      counters.markdown += 1;
      return actual.renderMarkdown(text);
    },
  };
});

const ChatMessage = (await import('../src/features/chat/ChatMessage.vue')).default;
const { clearMarkdownCache } = await import('../src/utils/mdcache');

const ROUND_KEEP = 14;   // 与 ChatMessage 里的常量对齐
const TOTAL = 30;

function para(k) {
  return `#### 第 ${k} 段\n\n这一段是模型给出的实现说明，用来贴近真实回复，长度够长才看得出成本。\n\n\`\`\`js\nconst a = ${k};\nconsole.log(a);\n\`\`\`\n`;
}

beforeEach(() => { counters.markdown = 0; clearMarkdownCache(); });

describe('折叠不该把渲染也省掉这件事', () => {
  it('一轮 30 段：只渲染留在眼前的 14 段，其余等用户点展开', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const tl = ref(Array.from({ length: TOTAL }, (_, i) => ({ kind: 'text', text: para(i) })));
    const app = createApp({
      render: () => h(ChatMessage, { role: 'assistant', busy: false, timeline: tl.value, msgId: 1, index: 0 }),
    });
    app.mount(host);
    await nextTick();
    console.log(`  [读数] 折叠态挂载 ${TOTAL} 段：renderMarkdown ${counters.markdown} 次`);
    expect(counters.markdown).toBe(ROUND_KEEP);

    counters.markdown = 0;
    host.querySelector('.fold-top').click();
    await nextTick();
    console.log(`  [读数] 点「展开更早的 ${TOTAL - ROUND_KEEP} 段」之后：renderMarkdown ${counters.markdown} 次`);
    expect(counters.markdown).toBe(TOTAL - ROUND_KEEP);
    expect([...host.querySelectorAll('.body-wrap')].filter((el) => el.style.display === 'none').length).toBe(0);

    app.unmount();
    host.remove();
  });
});
