// 内置浏览器的界面状态。动作本身在 BrowserPanel 里执行，这里只放"给人看的那部分"：
// 这一栏开没开、AI 正在做什么、当前页面是什么。
import { reactive } from 'vue';

const PIN_KEY = 'kh.browser_pin';
const AUTO_HIDE_MS = 20000;

const state = reactive({
  // 没有外壳就没有 <webview>，网页端只能显示说明，不做假象
  supported: typeof window !== 'undefined' && !!(window.khDesktop && window.khDesktop.isDesktop),
  open: false,
  pinned: localStorage.getItem(PIN_KEY) === '1',
  working: false,
  lastAction: '',
  lastArgs: '',
  lastAt: 0,
  url: '',
  title: '',
  canBack: false,
  canForward: false,
  errors: [],
});

let hideTimer = null;

function scheduleHide() {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!state.pinned) state.open = false;
  }, AUTO_HIDE_MS);
}

/** AI 调用浏览器工具时（SSE 的 tool 事件）叫一下：把栏亮出来并重置自动收起计时 */
function noteAction(name, args) {
  state.lastAction = String(name || '').replace(/^browser_/, '');
  state.lastArgs = args ? String(args).slice(0, 60) : '';
  state.lastAt = Date.now();
  state.open = true;
  scheduleHide();
}

function markWorking(v) {
  state.working = !!v;
  if (!v) scheduleHide();
}

function setAddr({ url, title, canBack, canForward }) {
  if (url !== undefined) state.url = url;
  if (title !== undefined) state.title = title;
  if (canBack !== undefined) state.canBack = !!canBack;
  if (canForward !== undefined) state.canForward = !!canForward;
}

function logError(line) {
  state.errors.push(String(line).slice(0, 300));
  if (state.errors.length > 50) state.errors.shift();
}

function toggle() {
  state.open = !state.open;
  if (state.open) scheduleHide();
}

function collapse() {
  state.open = false;
}

function expand() {
  state.open = true;
  scheduleHide();
}

function setPinned(v) {
  state.pinned = !!v;
  try { localStorage.setItem(PIN_KEY, state.pinned ? '1' : '0'); } catch (e) { /* 存不上就算了 */ }
}

export const browserStore = { state, noteAction, markWorking, setAddr, logError, toggle, collapse, expand, setPinned };
