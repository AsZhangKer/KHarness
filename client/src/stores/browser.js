// 内置浏览器的界面状态。动作本身在 BrowserPanel 里执行，这里只放"给人看的那部分"：
// 这一栏开没开、AI 正在做什么、当前页面是什么。
import { reactive } from 'vue';

const PIN_KEY = 'kh.browser_pin';
const AUTO_HIDE_MS = 20000;

const state = reactive({
  // 没有外壳就没有 <webview>，网页端只能显示说明，不做假象
  supported: typeof window !== 'undefined' && !!(window.khDesktop && window.khDesktop.isDesktop),
  open: false,
  // 页面被搬去独立窗口了：侧栏那一整列此时不渲染（ChatPage 认这个标志），
  // 还原时强制展开（见下面 onBview 那段）
  detached: false,
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

/** AI 调用浏览器工具时（SSE 的 tool 事件）叫一下：把栏亮出来并重置自动收起计时。
 *  quiet=true 给「跟这一栏无关」的动作（全屏截取拍的是整块屏幕，不需要把浏览器栏弹出来）：
 *  只记「上一步做了什么」，不展开、也不重新计时收起。 */
function noteAction(name, args, quiet) {
  state.lastAction = String(name || '').replace(/^browser_/, '');
  state.lastArgs = args ? String(args).slice(0, 60) : '';
  state.lastAt = Date.now();
  if (quiet) return;
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

/**
 * 独立窗口的开与合由主进程报信（那边是唯一真相），这一份 store 必须比面板活得久：
 * 独立期间侧栏面板整个不挂载，没人监听就没人知道该把它放回来。
 *
 * 还原时一律把栏展开，而不是恢复"独立之前的开合状态"：他刚在那一栏上操作完，
 * 收起来只会变成「侧边悬着一块没有地址栏的裸网页」—— 那种状态谁都救不回来。
 */
if (state.supported && typeof window.khDesktop.onBview === 'function') {
  window.khDesktop.onBview((ev) => {
    if (!ev || typeof ev.detached !== 'boolean') return;
    if (ev.detached === state.detached) return;
    state.detached = ev.detached;
    if (ev.detached) state.open = false;
    else {
      state.open = true;
      scheduleHide();
    }
  });
}

/**
 * 对一次账：主进程那边到底是不是独立状态。
 * 事件是会漏的（正好在整页刷新/切页时还原，那条 detached=false 就没人收到），
 * 漏了的后果是侧栏不再渲染、而原生视图还挂在侧边 —— 只剩一块没有边框的裸网页。
 * 所以启动后与每次窗口重新拿到焦点时都主动问一遍。
 */
let reconciling = false;
async function reconcile() {
  if (!state.supported || reconciling) return;
  reconciling = true;
  try {
    const s = await window.khDesktop.bview({ op: 'state' });
    const detached = !!(s && s.detached);
    if (detached !== state.detached) {
      state.detached = detached;
      state.open = !detached;
    }
  } catch (e) {
    // 视图压根还没建（回的是「内置浏览器还没创建」）：那必然不是独立状态
    if (state.detached) state.detached = false;
  } finally {
    reconciling = false;
  }
}

if (state.supported) {
  setTimeout(reconcile, 800);
  window.addEventListener('focus', () => { reconcile(); });
}

export const browserStore = { state, noteAction, markWorking, setAddr, logError, toggle, collapse, expand, setPinned, reconcile };
