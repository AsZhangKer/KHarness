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
 *
 * 文件末尾还有一道**兜底自愈**（`installImeSelfHeal`）：上面这套治的是「别去打断合成」，
 * 而丢了 compositionend 的路径不止一条、且大多不在页面里（窗口失焦、通知抢焦点、桌面壳的
 * before-input-event……），所以再加一层「发现标记与浏览器自述矛盾就当场清掉」。
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

/** 同上，但不抢默认行为（给「Esc 清空搜索框」这类从来没写 .prevent 的地方用：只求别在合成中触发） */
export function imeGuard(key, fn) {
  const want = String(key).toLowerCase();
  return (e) => {
    const got = e.key === ' ' ? 'space' : String(e.key || '').toLowerCase();
    if (got !== want) return;
    if (isImeComposing(e)) return;
    fn(e);
  };
}

/* ============================================================================
 * 合成卡死的自愈（兜底那一道）
 *
 * 上面那一套是「别去打断合成」——治的是我们能看见的那些抢键点。但 `compositionend`
 * 丢掉的路径不止一条，而且大多不在页面里：窗口失焦、系统通知抢焦点、桌面壳的
 * `before-input-event` 直接 preventDefault 掉一个组合键、输入法被系统级切换……
 * 这些一旦发生，`el.composing` 就永久停在 true，那个框此后**打字没反应、粘贴照旧、
 * 只能重启**——正是他报的「只出现在打包版桌面端、多在模型管理页」那个症状。
 *
 * 所以再加一道兜底：**只要发现标记与浏览器自述矛盾就当场清掉它**。
 * 判据只有一条，而且不可能误伤真合成——
 *   `el.composing === true`（Vue 说还在合成）
 *   且 `e.isComposing !== true` 且 `e.keyCode !== 229`（浏览器说早就结束了）
 * 真合成中这两个来源必然一致（都 true），只有丢了 compositionend 才会拧着。
 * 清掉时照 Vue 自己 `onCompositionEnd` 的写法补发一次 input（runtime-dom 里就是
 * 「清标记 + dispatchEvent('input')」两件事），好让 DOM 里已上屏的字与框架状态对齐。
 *
 * 用户按下的**第一个**键就完成自愈：capture 阶段先清标记，紧接着浏览器插字产生的
 * input 事件就能正常进 v-model，所以那一下不会丢。
 * ========================================================================== */

/** 正在合成的元素（compositionstart 进、compositionend 出）。元素脱离文档后仍留在集合里，无害 */
const composingEls = new Set();
let healInstalled = false;
let healSink = null;
let onCompStartRef = null;
let onCompEndRef = null;
let onKeyDownRef = null;
let onInputRef = null;
let onProbeRef = null;
let onBlurRef = null;
let onFocusRef = null;
let onVisRef = null;
let probeAt = 0;      // 焦点探针的节流时间戳（5 秒内最多记一条，免得刷屏）

function elDesc(el) {
  if (!el) return '(null)';
  try {
    const tag = String(el.tagName || '').toLowerCase();
    const cls = typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean).slice(0, 3).join('.') : '';
    const ph = el.getAttribute ? (el.getAttribute('placeholder') || '') : '';
    return `${tag}${cls ? '.' + cls : ''}${ph ? `[${String(ph).slice(0, 24)}]` : ''}`;
  } catch (e) { return '(unreadable)'; }
}

function report(text, level = 'warn') {
  try { if (healSink) healSink(text, level); } catch (e) { /* 记录失败不影响自愈 */ }
}

/** 把卡住的标记清掉；返回是否真的动了手。语义与 Vue 的 onCompositionEnd 一致 */
function healEl(el, why, extra = '') {
  if (!el || el.composing !== true) return false;
  el.composing = false;
  composingEls.delete(el);
  try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) { /* 元素已脱离文档 */ }
  report(`输入框合成标记卡死，已自愈（${why}）：${elDesc(el)}${extra ? ' ｜ ' + extra : ''}`);
  return true;
}

function healAll(why) {
  let n = 0;
  for (const el of Array.from(composingEls)) if (healEl(el, why)) n++;
  // 集合之外也可能有残留（比如本模块装上之前就开始的合成）：顺手看一眼活动元素
  const a = typeof document !== 'undefined' ? document.activeElement : null;
  if (a && a.composing === true && healEl(a, why)) n++;
  return n;
}

/**
 * 装上自愈。幂等，返回卸载函数。
 * @param {{ onHeal?: (text: string, level: string) => void }} opts onHeal 用于把自愈事件写进调试日志（只给开发版传）
 */
export function installImeSelfHeal(opts = {}) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  if (opts.onHeal) healSink = opts.onHeal;
  if (healInstalled) return uninstallImeSelfHeal;
  healInstalled = true;

  onCompStartRef = (e) => { if (e.target) composingEls.add(e.target); };
  onCompEndRef = (e) => { if (e.target) composingEls.delete(e.target); };
  // 浏览器说早就不在合成了、标记却还在 → 这就是丢了 compositionend
  onKeyDownRef = (e) => {
    const el = e.target;
    if (!el || el.composing !== true) return;
    if (e.isComposing === true || e.keyCode === 229) return;   // 真合成，别碰
    healEl(el, 'keydown', `key=${e.key}`);
  };
  onBlurRef = () => { healAll('window-blur'); };
  onFocusRef = () => { healAll('window-focus'); };
  onVisRef = () => { if (document.hidden) healAll('document-hidden'); };
  /* input 事件的 capture 那道闸：判据与 keydown 完全相同（标记 true 而浏览器说没在合成），
     但它能盖住「没有 keydown 的输入路径」—— 鼠标右键粘贴、拖放、输入法直接提交。
     在这一层清掉标记，紧接着冒泡到元素上时 v-model 的处理器就看到 composing=false，本次输入不丢。 */
  onInputRef = (e) => {
    const el = e.target;
    if (!el || el.composing !== true) return;
    if (e.isComposing === true) return;
    healEl(el, 'input', 'no-keydown-path');
  };
  /* 诊断：按键落在「不是输入框」的地方。他报的是「点了输入框、有白框、却打不进字」，
     若日志里出现这条，说明焦点其实不在输入框（那是另一条根因，不是合成卡死）。
     只在开发版记（没给 onHeal 就整体跳过），且 5 秒内最多一条，免得刷屏。 */
  onProbeRef = (e) => {
    if (!healSink) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (!k || k.length !== 1) return;                 // 只关心可打印字符
    if (e.isComposing) return;                        // 合成中，正常
    const ae = document.activeElement;
    const editable = !!(ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable));
    if (editable) return;                             // 焦点在输入框：正常路径，不记
    const now = Date.now();
    if (now - probeAt < 5000) return;
    probeAt = now;
    report(`打字时焦点不在任何输入框上（按键不会进输入框）：key=${k} ｜ activeElement=${elDesc(ae)}`, 'info');
  };

  document.addEventListener('compositionstart', onCompStartRef, true);
  document.addEventListener('compositionend', onCompEndRef, true);
  window.addEventListener('keydown', onKeyDownRef, true);
  window.addEventListener('input', onInputRef, true);
  window.addEventListener('keydown', onProbeRef, true);
  window.addEventListener('blur', onBlurRef);
  window.addEventListener('focus', onFocusRef);
  document.addEventListener('visibilitychange', onVisRef);
  return uninstallImeSelfHeal;
}

export function uninstallImeSelfHeal() {
  if (!healInstalled) return;
  healInstalled = false;
  composingEls.clear();
  if (onCompStartRef) document.removeEventListener('compositionstart', onCompStartRef, true);
  if (onCompEndRef) document.removeEventListener('compositionend', onCompEndRef, true);
  if (onKeyDownRef) window.removeEventListener('keydown', onKeyDownRef, true);
  if (onInputRef) window.removeEventListener('input', onInputRef, true);
  if (onProbeRef) window.removeEventListener('keydown', onProbeRef, true);
  if (onBlurRef) window.removeEventListener('blur', onBlurRef);
  if (onFocusRef) window.removeEventListener('focus', onFocusRef);
  if (onVisRef) document.removeEventListener('visibilitychange', onVisRef);
}
