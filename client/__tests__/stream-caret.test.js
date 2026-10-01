/**
 * 流式光标只该有一个（#232）。
 * 症状是他报的：说完一段话去调工具，工具返回值栏上方还挂着一根光标，正文末尾又有一根。
 * 这条测试先把「几根光标」变成读数，再决定往哪儿修 —— 光读模板看不出来，
 * 因为模板里 caret 的判据（i === timeline.length - 1）单看永远只有一位成立。
 */
import { describe, it, expect } from 'vitest';
import { createApp, h, nextTick, ref } from 'vue';
import ChatMessage from '../src/features/chat/ChatMessage.vue';

function carets(host) {
  return host.querySelectorAll('.caret-dot').length;
}

async function mountBusy(timeline) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const tl = ref(timeline);
  let vm;
  const app = createApp({
    render: () => h(ChatMessage, { role: 'assistant', busy: true, timeline: tl.value, msgId: 1, index: 0 }),
  });
  vm = app.mount(host);
  await nextTick();
  return { host, tl, app, vm, unmount: () => { app.unmount(); host.remove(); } };
}

describe('流式光标', () => {
  it('纯正文流式：只有一根光标，在正文末尾', async () => {
    const { host, unmount } = await mountBusy([{ kind: 'text', text: '先说一段话' }]);
    expect(carets(host)).toBe(1);
    unmount();
  });

  it('说完话再调工具：光标不许留在正文里（此刻最后一项是工具卡，正文应当没有光标）', async () => {
    const { host, tl, unmount } = await mountBusy([{ kind: 'text', text: '先说一段话' }]);
    // 和真流式一样往同一个数组上追加（store 里是 timeline.push，不是换数组引用）
    tl.value.push({ kind: 'step', type: 'tool', name: 'read_file', args: { path: 'a.txt' } });
    await nextTick();
    tl.value.push({ kind: 'step', type: 'result', name: 'read_file', output: '内容…' });
    await nextTick();
    const firstBody = host.querySelector('.body-wrap .body');
    expect(firstBody.querySelector('.caret-dot')).toBeFalsy();
    expect(carets(host)).toBe(0);
    unmount();
  });

  it('工具之后又输出正文：光标只在最新那段正文末尾', async () => {
    const { host, unmount } = await mountBusy([
      { kind: 'text', text: '先说一段话' },
      { kind: 'step', type: 'result', name: 'read_file', output: '内容…' },
      { kind: 'text', text: '读完之后再说一段' },
    ]);
    expect(carets(host)).toBe(1);
    const bodies = [...host.querySelectorAll('.body-wrap .body')];
    expect(bodies.length).toBe(2);
    expect(bodies[0].querySelector('.caret-dot')).toBeFalsy();
    expect(bodies[1].querySelector('.caret-dot')).toBeTruthy();
    unmount();
  });

  it('不忙了：一根都不剩', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createApp({
      render: () => h(ChatMessage, {
        role: 'assistant',
        busy: false,
        timeline: [{ kind: 'text', text: '一段话' }, { kind: 'step', type: 'result', name: 'grep', output: 'x' }],
        msgId: 1,
        index: 0,
      }),
    });
    app.mount(host);
    await nextTick();
    expect(carets(host)).toBe(0);
    app.unmount();
    host.remove();
  });
});
