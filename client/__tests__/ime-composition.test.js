/**
 * IME 合成期间被 preventDefault 打断，会让 v-model 永久失聪（第六十二轮 ⑥ 的根因证明 + 护栏）。
 *
 * 链条（全部对着 node_modules/@vue/runtime-dom 的实现跑，不是猜）：
 *   v-model 的 input 处理器第一行是 `if (e.target.composing) return;`
 *   compositionstart 把 el.composing 置 true；只有 compositionend（或 change）才清掉
 *   `@keydown.enter.prevent` 编译成 withKeys(withModifiers(fn,['prevent']),['enter'])，
 *   而 withKeys 只看 event.key、不看合成状态 → 候选词没上屏时按 Enter 也被 preventDefault
 *   → 浏览器补不回 compositionend → el.composing 永远 true → 这个框之后打字/粘贴都不再更新模型
 * 表现就是他说的那个怪症：能点进去、没有竖线光标、打字没反应、粘贴能出字、只有重启能解。
 */
import { describe, it, expect } from 'vitest';
import { createApp, h, nextTick, withModifiers, withKeys } from 'vue';
import { imeKey, isImeComposing } from '../src/utils/ime';

function mountInput(onKeydown) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const model = { v: '' };
  const app = createApp({
    render: () => h('input', {
      value: model.v,
      // 复刻 vModelText 的那道门：合成中的 input 事件一律忽略（生产里由 Vue 自己挂）
      onCompositionstart: (e) => { e.target.composing = true; },
      onCompositionend: (e) => { e.target.composing = false; },
      onInput: (e) => { if (e.target.composing) return; model.v = e.target.value; },
      onKeydown,
    }),
  });
  app.mount(host);
  return { el: host.querySelector('input'), model, app, host };
}

function startComposition(el) {
  el.dispatchEvent(new CompositionEvent('compositionstart'));
}
function pressEnter(el, composing) {
  const ev = new KeyboardEvent('keydown', { key: 'Enter', keyCode: composing ? 229 : 13, isComposing: composing, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
}

describe('IME 合成与按键拦截', () => {
  it('老写法：合成中的 Enter 被 preventDefault，之后打字不再更新模型（这就是那个"只能重启"）', () => {
    const calls = [];
    const { el, model, app, host } = mountInput(
      // 与模板里 @keydown.enter.prevent="fn" 编译出来的包装完全同一顺序
      withKeys(withModifiers(() => { calls.push(1); }, ['prevent']), ['enter'])
    );
    startComposition(el);
    const ev = pressEnter(el, true);
    expect(ev.defaultPrevented).toBe(true);          // .prevent 在处理器之前就跑掉了
    expect(el.composing).toBe(true);                  // 合成没被收尾，标记卡住

    el.value = '登录接口';
    el.dispatchEvent(new Event('input'));
    expect(model.v).toBe('');                         // 打字/粘贴都进不了模型
    expect(calls.length).toBe(1);                     // 而且动作还被真执行了一次（搜索框半句话就查）

    app.unmount(); host.remove();
  });

  it('imeKey：合成中原样交给浏览器，不 preventDefault、不执行动作', () => {
    const calls = [];
    const { el, model, app, host } = mountInput(imeKey('enter', () => { calls.push(1); }));
    startComposition(el);
    const ev = pressEnter(el, true);
    expect(ev.defaultPrevented).toBe(false);
    expect(calls.length).toBe(0);

    // 合成结束后同一个处理器正常工作
    el.dispatchEvent(new CompositionEvent('compositionend'));
    const ev2 = pressEnter(el, false);
    expect(ev2.defaultPrevented).toBe(true);
    expect(calls.length).toBe(1);

    // 期间照常打字
    el.value = '登录接口';
    el.dispatchEvent(new Event('input'));
    expect(model.v).toBe('登录接口');
    app.unmount(); host.remove();
  });

  it('isImeComposing 认三种浏览器的说法（isComposing / keyCode 229 / 元素上的 composing）', () => {
    expect(isImeComposing({ isComposing: true })).toBe(true);
    expect(isImeComposing({ keyCode: 229 })).toBe(true);
    expect(isImeComposing({ target: { composing: true } })).toBe(true);
    expect(isImeComposing({ key: 'Enter', target: { composing: false } })).toBe(false);
    expect(isImeComposing(null)).toBe(false);
  });
});
