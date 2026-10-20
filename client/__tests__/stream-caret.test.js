/**
 * 流式光标只该有一个，并且坐在**最后一个他看得懂的字**后面（#232 + 第七十七轮）。
 * 症状是他报的两件，方向相反：
 * - #232：说完一段话去调工具，工具返回值栏上方还挂着一根光标，正文末尾又有一根（两根）。
 * - 第七十七轮：同一形状下他报「圆形光标没了」—— 因为当时判据换成了「最后一个条目是不是正文」，
 *   Agent 模式一整段工具执行期间一个光标都不显示。
 * 第七十七轮曾收敛成「光标跟着最后一条正文条目」；**第八十三轮他重新拍过口径**：
 * 看「最后一个可见条目」—— 正文就挂正文末尾，思考就挂进思考框（折叠则看不见），
 * 工具卡/note/压缩卡则**一枚都不放**（那时模型在干活、不在写字，由 .phase 那行表示在跑）。
 * 就是他现在还重申的这条：光标不该粘在「已经说完的那句话」末尾不动。
 * 本文件按第八十三轮口径钉；第七十七轮的两条旧断言已在当轮就地改掉。
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

  it('说完话再调工具：光标退场（第八十三轮口径：模型在干活、不在写字）', async () => {
    const { host, tl, unmount } = await mountBusy([{ kind: 'text', text: '先说一段话' }]);
    expect(carets(host)).toBe(1);
    // 和真流式一样往同一个数组上追加（store 里是 timeline.push，不是换数组引用）
    tl.value.push({ kind: 'step', type: 'tool', name: 'read_file', args: { path: 'a.txt' } });
    await nextTick();
    tl.value.push({ kind: 'step', type: 'result', name: 'read_file', output: '内容…' });
    await nextTick();
    /* 第八十三轮他重新拍的口径：尾部一旦落成工具卡/note/压缩卡，光标就**退场**，
       由下面那行 .phase 表示「在跑」。第七十七轮曾要求「跟到上面那段正文末尾」，
       而他实际看到的就是那枚粘在已经说完的话后面、一直不动的圆点 —— 他报的「光标会卡在那」。 */
    expect(carets(host)).toBe(0);
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
