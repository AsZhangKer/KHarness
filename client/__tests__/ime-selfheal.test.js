/**
 * 输入法合成「卡死」自愈的护栏（第八十四轮）。
 *
 * 背景：`el.composing` 是 Vue vModelText 挂在元素上的私有标记，由 compositionstart 置 true、
 * 只有 compositionend/change 才清。任何让 compositionend 丢失的事（窗口失焦、系统通知抢焦点、
 * 桌面壳 before-input-event 抢掉一个组合键……）都会把它永久卡在 true —— 那个框此后
 * **打字没反应、粘贴照旧、只能重启**，且**与语言无关**（标记在元素上，英文同样进不去），
 * 这正是他报的「只在打包版桌面端、多在模型管理页」那个症状。
 *
 * 这里钉两件事：
 *   ① 真合成中绝不能误伤（isComposing=true / keyCode 229 时一个字都不许动）；
 *   ② 卡死状态下，用户按下的第一个键就完成自愈，且这一下**不会丢**（capture 先清标记，
 *      浏览器插字产生的 input 紧跟着就能进 v-model）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installImeSelfHeal, uninstallImeSelfHeal } from '../src/utils/ime';

/** 复刻 vModelText 挂在元素上的那道门：合成中的 input 事件一律忽略 */
function mountModeledInput() {
  const el = document.createElement('input');
  document.body.appendChild(el);
  el.composing = false;
  const model = { v: '' };
  el.addEventListener('compositionstart', (e) => { e.target.composing = true; });
  el.addEventListener('compositionend', (e) => { e.target.composing = false; });
  el.addEventListener('input', (e) => { if (e.target.composing) return; model.v = e.target.value; });
  el.focus();
  return { el, model };
}

function fire(el, type, init = {}) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  for (const [k, v] of Object.entries(init)) {
    try { Object.defineProperty(ev, k, { value: v, configurable: true }); } catch (e) { /* 忽略 */ }
  }
  el.dispatchEvent(ev);
  return ev;
}

function pressKey(el, { key = 'a', isComposing = false, keyCode = 65 } = {}) {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'isComposing', { value: isComposing, configurable: true });
  Object.defineProperty(ev, 'keyCode', { value: keyCode, configurable: true });
  el.dispatchEvent(ev);
  return ev;
}

describe('输入法合成卡死自愈', () => {
  let off = null;
  let healed = [];

  beforeEach(() => {
    healed = [];
    off = installImeSelfHeal({ onHeal: (t, l) => healed.push({ t, l }) });
  });
  afterEach(() => {
    if (off) off();
    uninstallImeSelfHeal();
    document.body.innerHTML = '';
  });

  it('真合成中一个字都不碰（isComposing=true）', () => {
    const { el } = mountModeledInput();
    fire(el, 'compositionstart');
    expect(el.composing).toBe(true);

    pressKey(el, { key: 'a', isComposing: true, keyCode: 229 });
    expect(el.composing).toBe(true);      // 标记保留：这是输入法自己的合成
    expect(healed.length).toBe(0);
  });

  it('卡死状态：浏览器说合成早结束了、标记还在 → 第一个按键当场自愈且这一下不丢', () => {
    const { el, model } = mountModeledInput();
    fire(el, 'compositionstart');         // 合成开始
    // ……compositionend 永远没来（窗口失焦/被抢键），标记卡在 true
    expect(el.composing).toBe(true);
    expect(healed.length).toBe(0);        // 只是卡着，还没人碰它

    // 用户按下第一个键 → capture 阶段自愈
    pressKey(el, { key: 'd', isComposing: false, keyCode: 68 });
    expect(el.composing).toBe(false);
    expect(healed.length).toBe(1);
    expect(healed[0].t).toContain('已自愈');

    // 紧接着浏览器插字产生的 input 正常进模型（这一下没丢）
    el.value = 'abcd';
    fire(el, 'input');
    expect(model.v).toBe('abcd');
  });

  it('keyCode 229（旧内核在合成期间只给这个值）同样不碰', () => {
    const { el } = mountModeledInput();
    fire(el, 'compositionstart');
    pressKey(el, { key: 'Process', isComposing: false, keyCode: 229 });
    expect(el.composing).toBe(true);
    expect(healed.length).toBe(0);
  });

  it('窗口失焦时把卡住的标记清掉（失焦那一刻合成必然已中断）', () => {
    const { el } = mountModeledInput();
    fire(el, 'compositionstart');
    expect(el.composing).toBe(true);

    window.dispatchEvent(new Event('blur'));
    expect(el.composing).toBe(false);
    expect(healed.length).toBe(1);
    expect(healed[0].t).toContain('window-blur');
  });

  it('正常走完 compositionend 的不会被当成卡死（零副作用）', () => {
    const { el, model } = mountModeledInput();
    fire(el, 'compositionstart');
    el.value = '登录';
    fire(el, 'compositionend');           // 正常收尾：Vue 的处理器会清标记
    expect(el.composing).toBe(false);

    pressKey(el, { key: 'a', isComposing: false, keyCode: 65 });
    expect(healed.length).toBe(0);        // 没动过手

    el.value = '登录a';
    fire(el, 'input');
    expect(model.v).toBe('登录a');
  });

  it('没有 keydown 的输入路径（右键粘贴/拖放）也自愈：input 到达时标记还卡着', () => {
    const { el, model } = mountModeledInput();
    fire(el, 'compositionstart');         // 卡住（compositionend 永远没来）
    expect(el.composing).toBe(true);

    // 鼠标右键粘贴：不经过任何 keydown，直接来一个 input（浏览器说不在合成）
    el.value = '粘贴进来的字';
    const ev = new Event('input', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'isComposing', { value: false, configurable: true });
    el.dispatchEvent(ev);

    // window 的 capture 先跑（清了标记），所以这一次输入不丢、原样进模型
    expect(el.composing).toBe(false);
    expect(model.v).toBe('粘贴进来的字');
    expect(healed.length).toBe(1);
    expect(healed[0].t).toContain('input');
  });

  it('真合成的 input（isComposing=true）绝不碰', () => {
    const { el } = mountModeledInput();
    fire(el, 'compositionstart');
    const ev = new Event('input', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'isComposing', { value: true, configurable: true });
    el.dispatchEvent(ev);
    expect(el.composing).toBe(true);      // 预编辑文本，标记必须留着
    expect(healed.length).toBe(0);
  });

  it('幂等：重复安装只绑一份，卸载后不再介入', () => {
    const off2 = installImeSelfHeal({ onHeal: (t, l) => healed.push({ t, l }) });
    const { el } = mountModeledInput();
    fire(el, 'compositionstart');
    healVia(el);
    expect(healed.length).toBe(1);        // 只一条，说明没绑两份

    off2();
    uninstallImeSelfHeal();
    fire(el, 'compositionstart');
    el.composing = true;
    pressKey(el, { key: 'x', isComposing: false, keyCode: 88 });
    expect(el.composing).toBe(true);      // 卸载后不介入
    expect(healed.length).toBe(1);
  });
});

/** 触发一次自愈（走 keydown 那条路），供幂等用例复用 */
function healVia(el) {
  pressKey(el, { key: 'z', isComposing: false, keyCode: 90 });
}
