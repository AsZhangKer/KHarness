/**
 * 中文输入法（IME）安全的按键处理。
 *
 * 为什么需要这个文件（他报的「输入框能点进去、没有竖线光标、打字没反应、粘贴能出字，只能重启」）：
 * Vue 的 `@keydown.enter.prevent` 编译成 `withKeys(withModifiers(fn, ['prevent']), ['enter'])` ——
 * **`.prevent` 是在进我们的函数之前就跑的**（withModifiers 先调 event.preventDefault() 才 call fn），
 * 所以在处理器里 `return` 也拦不住它。而 `withKeys` 只按 `event.key` 过滤，压根不看合成状态。
 * 于是候选词还没上屏时按下 Enter：preventDefault 打断了这次合成，浏览器不再补发 compositionend，
 * v-model 在元素上记的那个 `composing` 标记就永远停在 true（见 runtime-dom 的 vModelText：
 * `if (e.target.composing) return;`）—— 这个框此后**每一次 input 事件都被 v-model 忽略**：
 * 打字看不见（后续按键被当成还没结束的预编辑文本）、粘贴能看见字（DOM 变了）但模型不更新，
 * 只有换页或重启才解 —— 和「难复现、多见于框最多的模型管理页」完全对得上。
 *
 * 用法：`@keydown="imeKey('enter', () => send())"`。默认不吞键（合成中原样交给浏览器），
 * 只有真的按下滑标键、且不在合成中，才 preventDefault 再执行动作。
 */
export function isImeComposing(e) {
  if (!e) return false;
  // keyCode 229 = 「未映射按键」，Safari/旧 Chromium 在合成期间只给这个值，不带 isComposing
  if (e.isComposing || e.keyCode === 229) return true;
  const el = e.target;
  return !!(el && el.composing === true);
}

export function imeKey(key, fn) {
  const want = String(key).toLowerCase();
  return (e) => {
    const got = e.key === ' ' ? 'space' : String(e.key || '').toLowerCase();
    if (got !== want) return;
    if (isImeComposing(e)) return;   // 合成中：这一下是给输入法用的，不许抢
    e.preventDefault();
    fn(e);
  };
}

/** 同上，但不抢默认行为（给「Esc 清空搜索框」这类原本就没写 .prevent 的地方用：只求别在合成中触发） */
export function imeGuard(key, fn) {
  const want = String(key).toLowerCase();
  return (e) => {
    const got = e.key === ' ' ? 'space' : String(e.key || '').toLowerCase();
    if (got !== want) return;
    if (isImeComposing(e)) return;
    fn(e);
  };
}
