/**
 * 「思考默认展开」这条设置在流式期间也必须说话（#252）。
 *
 * 以前的展开条件是 `busy || item.open || prefs.reasonOpen` —— 第一项把 busy 排在最前，
 * 于是没勾选也照样在模型思考的那一刻整段摊开（他报的「勾不勾都是自动展开」）。
 * 现在按他定的口径：流式期间也只显示一行标题（带转圈），内容照收、照入库、照进上下文，
 * 想细看自己点开。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import ChatMessage from '../src/features/chat/ChatMessage.vue';
import { uiPrefs } from '../src/stores/prefs';

let hosts = [];
afterEach(() => { for (const x of hosts.splice(0)) x.host.remove(); uiPrefs.state.reasonOpen = false; });

function mount({ busy, text = '在想先做什么，再做什么。' }) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const timeline = [{ kind: 'reason', text }];
  const app = createApp({
    render: () => h(ChatMessage, {
      role: 'assistant', busy, content: '', reasoning: text, steps: [], timeline,
      usage: null, model_name: '', msgId: 1, index: 0,
    }),
  });
  app.mount(host);
  hosts.push({ host, app });
  return host;
}

describe('思考卡：默认折叠，流式期间也不摊开', () => {
  it('没勾选 + 正在流式 → 折叠，但标题在动（说明还在收）', async () => {
    uiPrefs.state.reasonOpen = false;
    const host = mount({ busy: true });
    await nextTick();
    const d = host.querySelector('details.reason');
    expect(d).toBeTruthy();
    expect(d.open).toBe(false);
    expect(d.querySelector('summary').textContent).toContain('思考中');
    expect(d.querySelector('summary .fa-spin')).toBeTruthy();
  });

  it('折叠不等于没收到：整段思考文本仍在 DOM 里（只是看不见）', async () => {
    uiPrefs.state.reasonOpen = false;
    const host = mount({ busy: true });
    await nextTick();
    expect(host.querySelector('details.reason pre').textContent).toContain('在想先做什么');
  });

  it('勾上「思考默认展开」→ 流式期间就摊开', async () => {
    uiPrefs.state.reasonOpen = true;
    const host = mount({ busy: true });
    await nextTick();
    expect(host.querySelector('details.reason').open).toBe(true);
  });

  it('回合跑完（busy=false）标题回到「思考过程」，仍然折叠', async () => {
    uiPrefs.state.reasonOpen = false;
    const host = mount({ busy: false });
    await nextTick();
    const sum = host.querySelector('details.reason summary');
    expect(sum.textContent).toContain('思考过程');
    expect(sum.textContent).not.toContain('思考中');
    expect(host.querySelector('details.reason').open).toBe(false);
  });
});
