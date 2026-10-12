/**
 * 流式光标只该有一个，并且坐在**最后一个他看得懂的字**后面（#232 + 第七十七轮）。
 * 症状是他报的两件，方向相反：
 * - #232：说完一段话去调工具，工具返回值栏上方还挂着一根光标，正文末尾又有一根（两根）。
 * - 第七十七轮：同一形状下他报「圆形光标没了」—— 因为当时判据换成了「最后一个条目是不是正文」，
 *   Agent 模式一整段工具执行期间一个光标都不显示。
 * 收敛后的口径：光标跟着「最后一条正文条目」，条目是工具卡时不许冒第二根。
 * 这条测试先把「几根光标、坐在哪儿」变成读数，再决定往哪儿修 —— 光读模板看不出来，
 * 因为模板里 caret 的判据单看永远只有一位成立。
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

  it('说完话再调工具：光标跟着那段正文的末尾，工具卡上不许有光标', async () => {
    const { host, tl, unmount } = await mountBusy([{ kind: 'text', text: '先说一段话' }]);
    // 和真流式一样往同一个数组上追加（store 里是 timeline.push，不是换数组引用）
    tl.value.push({ kind: 'step', type: 'tool', name: 'read_file', args: { path: 'a.txt' } });
    await nextTick();
    tl.value.push({ kind: 'step', type: 'result', name: 'read_file', output: '内容…' });
    await nextTick();
    // 第七十七轮口径：工具执行期间这一轮还在跑，最后一个字仍是正文末尾那个「话」，光标要跟过去。
    const firstBody = host.querySelector('.body-wrap .body');
    expect(firstBody.querySelector('.caret-dot')).toBeTruthy();
    // #232 那半句仍然成立：只有一根，工具卡那栏不冒第二根。
    expect(carets(host)).toBe(1);
    expect(host.querySelector('.step .caret-dot, .result .caret-dot')).toBeNull();
    unmount();
  });

  it('只在思考 / 上来就调工具，一段正文都还没有：不放光标（那行 phase 表示在跑）', async () => {
    const { host, unmount } = await mountBusy([
      { kind: 'reason', text: '让我先想想' },
      { kind: 'step', type: 'tool', name: 'read_file', args: { path: 'a.txt' } },
    ]);
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
