<template>
  <div v-if="!st.supported" class="browser-col" :class="{ open: st.open }">
    <header class="bc-head">
      <span class="t"><i class="fas fa-globe"></i> 浏览器</span>
      <button class="icon-btn" type="button" title="收起" @click="store.collapse()"><i class="fas fa-xmark"></i></button>
    </header>
    <div class="bc-notice">
      <p>内置浏览器只在 <b>桌面端</b> 可用。</p>
      <p class="muted">在浏览器标签页里，由于跨域，页面
        <code>X-Frame-Options</code> 无法抓取，无法获得DOM信息</p>
      <p class="muted">用 <code>npm run desktop</code> 打开桌面端即可。</p>
    </div>
  </div>

  <div v-else ref="colEl" class="browser-col" :class="{ open: st.open, working: st.working }">
    <header class="bc-head">
      <span class="t"><i class="fas fa-globe"></i> 内嵌浏览器</span>
      <span v-if="st.working" class="busy"><i class="fas fa-circle-notch fa-spin"></i> 智能体正在操作</span>
      <span v-else-if="st.lastAction" class="idle" :title="st.lastArgs">上一步：{{ st.lastAction }}</span>
      <button
        class="icon-btn pin-btn"
        type="button"
        :class="{ on: st.pinned }"
        :aria-pressed="st.pinned ? 'true' : 'false'"
        :title="st.pinned ? '已固定' : '固定浏览器边栏(默认无操作20s收起)'"
        @click="togglePin"
      ><i class="fas fa-thumbtack"></i></button>
      <button class="icon-btn" type="button" title="收起" @click="store.collapse()"><i class="fas fa-xmark"></i></button>
    </header>

    <div class="bc-bar">
      <button class="icon-btn sm" type="button" :disabled="!st.canBack" @click="go(-1)"><i class="fas fa-arrow-left"></i></button>
      <button class="icon-btn sm" type="button" :disabled="!st.canForward" @click="go(1)"><i class="fas fa-arrow-right"></i></button>
      <button class="icon-btn sm" type="button" @click="reload()"><i class="fas fa-rotate-right"></i></button>
      <input class="k-input mono addr" v-model="addrInput" placeholder="输入域名、IP地址……" @keydown.enter.prevent="navFromBox()" />
      <button class="icon-btn sm" type="button" title="第三方浏览器打开……" @click="openExternal()"><i class="fas fa-arrow-up-right-from-square"></i></button>
    </div>

    <!--
      真正的页面不在这里：它是主进程里的一个 BrowserView，被摆在这块「洞」的位置上。
      为什么不用 <webview>：guest 视口要靠渲染进程同步元素尺寸，实测 Electron 33
      在应用里怎么调都停在默认 300×150（页面只画出一条 150px 的带子）；
      BrowserView 由主进程 setBounds 直接给边界，视口/截图/CDP 输入都对得上。
    -->
    <div ref="holeEl" class="bc-hole"></div>
    <div v-if="overlay" class="bc-overlay">{{ overlay }}</div>

    <footer class="bc-foot">
      <span class="muted ellip" :title="st.url">{{ st.title || st.url || '空白页' }}</span>
      <span v-if="st.errors.length" class="errs" :title="st.errors.join('\n')"><i class="fas fa-triangle-exclamation"></i> {{ st.errors.length }}</span>
      <span v-if="!viewportOk" class="errs" title="guest 页面视口刷新失败，请收起栏再展开重试">视口未就绪</span>
      <span class="muted">{{ online ? '在线' : '未连接' }} · 队列 {{ queued }}</span>
    </footer>
  </div>

  <button v-if="st.supported && !st.open" class="bc-edge" type="button" title="展开浏览器边栏" @click="store.expand()">
    <i class="fas fa-globe"></i>
  </button>
</template>

<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { aiApi } from '../../api';
import { browserStore as store } from '../../stores/browser';
import { toast } from '../../stores/toast';

const st = store.state;
const holeEl = ref(null);
const colEl = ref(null);
const addrInput = ref('');
const overlay = ref('');
const online = ref(false);
const queued = ref(0);
const viewportOk = ref(true);
const settleWhy = ref('');   // 没能就位时给模型看的原因

let stopped = false;
let statusTimer = null;
let ro = null;
let offEvents = null;
let idleWaiters = [];
let viewReady = false;   // 主进程那边那个 BrowserView 建好了没

/** 和主进程说话；那边用 { error } 表示失败，这里统一抛出去 */
async function bv(msg) {
  const r = await window.khDesktop.bview(msg);
  if (r && r.error) throw new Error(r.error);
  return r || {};
}

/** 洞在窗口里的位置（CSS px = Electron 的 DIP，主进程那边直接用） */
function holeBounds() {
  const el = holeEl.value;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 40 || r.height < 40) return null;
  return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
}

/** 第一次用到才建视图；之后每次用到都把窗口带回前台（挡住时点击与截图都会失效） */
async function ensureView() {
  const bounds = holeBounds();
  if (!bounds) throw new Error('浏览器栏无法正确渲染');
  if (!viewReady) {
    applyState(await bv({ op: 'create', bounds }));
    viewReady = true;
  } else {
    await bv({ op: 'bounds', bounds });
    await bv({ op: 'focus' }).catch(() => {});
  }
  return bounds;
}

/**
 * 把原生视图的位置/可见性对齐这一栏的状态。
 * 收起时即使自己不知道有没有视图也要发 hide：主进程那边可能还留着
 * 上一次页面加载留下的视图（渲染层重载后这边是全新的，viewReady 已经丢了），
 * 不发就会一直悬浮在界面上。
 */
async function syncBounds() {
  if (!st.open) { await bv({ op: 'hide' }).catch(() => {}); return; }
  if (!viewReady) return;
  const bounds = holeBounds();
  if (!bounds) return;
  await bv({ op: 'bounds', bounds }).catch(() => {});
}

function applyState(s) {
  if (!s) return;
  if (typeof s.url === 'string') st.url = s.url;
  if (typeof s.title === 'string') st.title = s.title;
  if (s.canBack !== undefined) st.canBack = !!s.canBack;
  if (s.canForward !== undefined) st.canForward = !!s.canForward;
  addrInput.value = st.url && st.url !== 'about:blank' ? st.url : '';
}

function guestId() { return 'bview'; }

async function execJs(expr) {
  const r = await bv({ op: 'exec', code: expr });
  return r.result;
}

/**
 * executeJavaScript 在 guest 正在换页时会吐 Electron 的序列化错误
 * （`GUEST_VIEW_MANAGER_CALL` / `An object could not be cloned`），
 * 有时是 reject、有时把错误当字符串 resolve 回来。两种都当失败重试一次。
 * 另外：guest 里返回 Promise 不会被 await，所以异步等待一律放宿主侧轮询。
 */
async function execJsSafe(expr, tries = 3) {
  let lastErr = null;
  for (let i = 0; i < tries; i += 1) {
    try {
      const v = await execJs(expr);
      if (typeof v === 'string' && /could not be cloned|GUEST_VIEW_MANAGER_CALL/i.test(v)) {
        lastErr = new Error(v);
      } else {
        return v;
      }
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw lastErr || new Error('页面内脚本执行失败');
}

/** 页面实际拿到的视口（和洞的尺寸比对用） */
async function guestBox() {
  let inner = { iw: 0, ih: 0 };
  let err = '';
  try {
    inner = JSON.parse(await execJsSafe('JSON.stringify({iw:innerWidth,ih:innerHeight})'));
  } catch (e) {
    err = String((e && e.message) || e);   // 读不到视口时，把原因留给上层说
  }
  const b = holeBounds();
  return { hw: b ? b.width : 0, hh: b ? b.height : 0, iw: inner.iw || 0, ih: inner.ih || 0, err };
}

/**
 * 动手之前保证：这一栏展开着、视图已经建好并摆在洞上、页面视口和洞一致。
 * 视口不对时一切都废（坐标算成 0、截图只有一条带子），
 * 所以宁可多等几秒，也不要回给模型一个「成功但什么也没发生」的结果。
 */
async function settleForAction() {
  if (!st.open) store.expand();
  await nextTick();
  try {
    if (!viewReady) await ensureView();
    else await syncBounds();
  } catch (e) {
    settleWhy.value = String((e && e.message) || e);
    flash(settleWhy.value);
    return false;
  }
  const deadline = Date.now() + 5000;
  for (;;) {
    const b = await guestBox();
    if (b.iw > 40 && b.ih > 40 && Math.abs(b.ih - b.hh) <= 8 && Math.abs(b.iw - b.hw) <= 8) {
      viewportOk.value = true;
      settleWhy.value = '';
      return true;
    }
    if (Date.now() > deadline) {
      viewportOk.value = false;
      settleWhy.value = `视口错误（页面 ${b.iw}×${b.ih}，栏位 ${b.hw}×${b.hh}）${b.err ? '：' + b.err : ''}`;
      flash(settleWhy.value);
      return false;
    }
    await syncBounds();
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function cdp(method, params) {
  const r = await window.khDesktop.cdp(guestId(), method, params);
  if (r && r.error) throw new Error(r.error);
  return r && r.result;
}

function flash(msg) {
  overlay.value = msg;
  setTimeout(() => { if (overlay.value === msg) overlay.value = ''; }, 2600);
}

/** 等主进程那边报来「加载完了」（did-stop-loading），超时也放行；再给 300ms 画首屏 */
function waitIdle(ms = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      idleWaiters = idleWaiters.filter((f) => f !== finish);
      setTimeout(resolve, 300);
    };
    idleWaiters.push(finish);
    setTimeout(finish, ms);
  });
}

async function nav(url) {
  const raw = String(url || '').trim();
  if (!raw) throw new Error('url 不能为空');
  const full = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  if (!/^https?:\/\//i.test(full)) throw new Error('只允许 http/https 地址');
  await ensureView();
  await bv({ op: 'nav', url: full });
  await waitIdle();
  return full;
}

async function go(dir) {
  if (!viewReady) return;
  if (dir < 0 && st.canBack) applyState(await bv({ op: 'back' }));
  else if (dir > 0 && st.canForward) applyState(await bv({ op: 'forward' }));
  await waitIdle(8000);
}

async function reload(hard) {
  if (!viewReady) return;
  await bv({ op: 'reload', hard: !!hard }).catch(() => {});
  await waitIdle(8000);
}

function navFromBox() {
  nav(addrInput.value).catch((e) => flash(e.message));
}

function openExternal() {
  if (st.url && st.url !== 'about:blank') window.open(st.url, '_blank');
}

/**
 * 钉住 / 取消钉住。这颗图钉只影响一件事：AI 停手 20 秒后这一栏会不会自己收起，
 * 平时点了看不出差别，所以除了按钮自身变色，再补一句 toast 把「管的是什么」说清楚。
 */
function togglePin() {
  const on = !st.pinned;
  store.setPinned(on);
  toast(on ? '已固定浏览器边栏：不再自动收起' : '已取消固定：20s无操作自动收起', 'info', 2200);
}

/* ---------------- 给 guest 页面用的脚本与真实输入 ---------------- */

/** 给可交互元素编号并抓结构；编号写进 data-kh-ref，后续 click/type 用它定位 */
const SNAP_JS = `(() => {
  const SEL = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=textbox],[role=checkbox],[role=radio],[onclick],summary,[contenteditable=true]';
  const out = [];
  const keep = new Set();
  let n = 0;
  for (const el of document.querySelectorAll(SEL)) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) continue;
    if (r.width < 2 || r.height < 2) continue;
    n += 1;
    el.setAttribute('data-kh-ref', String(n));
    keep.add(String(n));
    const name = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder')
      || el.getAttribute('title') || el.getAttribute('alt') || '').replace(/\\s+/g, ' ').trim().slice(0, 90);
    out.push({
      ref: n,
      tag: el.tagName.toLowerCase(),
      type: (el.type || '').toLowerCase(),
      role: el.getAttribute('role') || '',
      name,
      href: el.href ? String(el.href).slice(0, 140) : '',
      off: (r.top < 0 || r.bottom > innerHeight),
    });
    if (out.length >= (window.__khLimit || 150)) break;
  }
  for (const el of document.querySelectorAll('[data-kh-ref]')) {
    if (!keep.has(el.getAttribute('data-kh-ref'))) el.removeAttribute('data-kh-ref');
  }
  return JSON.stringify({ url: location.href, title: document.title, total: out.length, elements: out });
})()`;

/** 定位一个 ref/选择器 → 滚到视口中间并回坐标（坐标交给 CDP 打真实点击） */
function locateJs(ref, selector, index) {
  return `(() => {
    const ref = ${JSON.stringify(String(ref || ''))};
    const sel = ${JSON.stringify(String(selector || ''))};
    const idx = ${Number(index) || 0};
    let el = null;
    if (ref) el = document.querySelector('[data-kh-ref="' + ref + '"]');
    if (!el && sel) { const list = document.querySelectorAll(sel); el = list[idx]; }
    if (!el) return JSON.stringify({ error: ref ? ('编号 ' + ref + ' 已失效，请重新 browser_snapshot') : ('选择器没命中元素：' + sel) });
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    el.focus();
    return JSON.stringify({
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      w: r.width,
      h: r.height,
      tag: el.tagName.toLowerCase(),
      href: el.href ? String(el.href) : '',
      inView: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
      ref: el.getAttribute('data-kh-ref') || '',
      name: (el.innerText || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
    });
  })()`;
}

/**
 * 定位 + 量坐标。scrollIntoView 之后立刻量有时拿到旧位置，
 * 量到零尺寸就再等一轮 —— 真拿不到尺寸宁可报错，也别往 (0,0) 上点。
 */
async function locate(ref, selector, index) {
  let loc = JSON.parse(await execJsSafe(locateJs(ref, selector, index)));
  for (let i = 0; i < 3 && !loc.error && (loc.w < 1 || loc.h < 1); i += 1) {
    await new Promise((r) => setTimeout(r, 200));
    loc = JSON.parse(await execJsSafe(locateJs(ref, selector, index)));
  }
  if (!loc.error && (loc.w < 1 || loc.h < 1)) {
    loc.error = `编号 ${ref || selector} 对应的元素没有实际尺寸（隐藏或已失效），请重新 browser_snapshot 换一个`;
  }
  return loc;
}

async function clickAt(x, y) {
  const p = { x: Math.round(x), y: Math.round(y), button: 'left' };
  await cdp('Input.dispatchMouseEvent', { ...p, type: 'mouseMoved' });
  // buttons 是位掩码：不给的话 Chromium 可能把这一下当成没有按下的移动事件
  await cdp('Input.dispatchMouseEvent', { ...p, type: 'mousePressed', buttons: 1, clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { ...p, type: 'mouseReleased', buttons: 0, clickCount: 1 });
}

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13 },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
};

async function pressKey(key) {
  const k = KEYS[key] || { key, code: key, vk: 0 };
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

function ok(text) { return { text: String(text) }; }
function bad(error) { return { error: String(error) }; }

/**
 * 在 guest 里装一个小工具，省得每段脚本重复写 ref/选择器兜底。
 * 注意末尾的 `return 1`：executeJavaScript 会把完成值序列化回宿主，
 * 裸赋值语句的完成值是那个函数本身，Electron 会直接报
 * 「An object could not be cloned」—— 这个坑踩过一次。
 */
const PICK_INSTALL = `(() => {
  window.__khPick = (ref, sel) => {
    if (ref) { const e = document.querySelector('[data-kh-ref="' + ref + '"]'); if (e) return e; }
    if (sel) { const list = document.querySelectorAll(sel); if (list.length) return list[0]; }
    return null;
  };
  return 1;
})()`;

async function pick(ref, sel) {
  await execJsSafe(PICK_INSTALL);
  return execJsSafe(`(() => { const e = window.__khPick(${JSON.stringify(String(ref || ''))}, ${JSON.stringify(String(sel || ''))}); return e ? 'found' : 'missing'; })()`);
}

const ACTIONS = {
  async browser_open(a) {
    const url = await nav(a.url);
    return ok(`已打开 ${url}\n标题：${st.title || '（无）'}\n页面就在右侧「浏览器」栏，用户可以直接上手点。`);
  },
  async browser_navigate(a) {
    const url = await nav(a.url);
    return ok(`已跳转到 ${url}\n标题：${st.title || '（无）'}`);
  },
  async browser_back() {
    await go(-1);
    if (!st.url || st.url === 'about:blank') return ok('已退到空白页：这已经是本栏里的第一条记录，再退没有了');
    return ok(`已后退，当前 ${st.url}`);
  },
  async browser_forward() { await go(1); return ok(`已前进，当前 ${st.url}`); },
  async browser_reload(a) {
    const hard = a && (a.hard === true || a.hard === 'true');
    await reload(hard);
    return ok(`已刷新 ${st.url}`);
  },
  async browser_snapshot(a) {
    const limit = Number(a && a.limit) > 0 ? Number(a.limit) : 150;
    // 同样要包 IIFE：裸赋值的完成值会被 Electron 当成不可序列化对象
    await execJsSafe(`(() => { window.__khLimit = ${limit}; return 1; })()`);
    const s = JSON.parse(await execJsSafe(SNAP_JS));
    const lines = s.elements.map((e) => {
      const bits = [`[${e.ref}] ${e.tag}${e.type ? ':' + e.type : ''}${e.role ? '/' + e.role : ''}`];
      if (e.name) bits.push(`"${e.name}"`);
      if (e.href) bits.push(`→ ${e.href}`);
      if (e.off) bits.push('(不在视口内)');
      return bits.join(' ');
    });
    return ok(`URL: ${s.url}\n标题: ${s.title}\n可交互元素 ${s.total} 个（click/type 用 ref 编号）\n${lines.join('\n')}`);
  },
  async browser_text(a) {
    const ref = String((a && a.ref) || '');
    const sel = String((a && a.selector) || '');
    const expr = (ref || sel)
      ? `(() => { const e = window.__khPick(${JSON.stringify(ref)}, ${JSON.stringify(sel)}); return e ? (e.innerText || e.value || '') : '找不到元素'; })()`
      : 'document.body.innerText';
    await execJsSafe(PICK_INSTALL);
    return ok(String(await execJsSafe(expr)).replace(/\n{3,}/g, '\n\n').slice(0, 12000));
  },
  async browser_click(a) {
    const loc = await locate(a.ref, a.selector, a.index);
    if (loc.error) return bad(loc.error);
    const href0 = String(await execJsSafe('location.href').catch(() => st.url));
    await clickAt(loc.x, loc.y);
    await new Promise((r) => setTimeout(r, 400));
    let how = '真实鼠标';
    const href1 = String(await execJsSafe('location.href').catch(() => href0));
    // 链接没跳走：多半是这一下没落到页面上（窗口没焦点等）。只对 <a> 兜底，
    // 按钮不能补点第二下 —— 那会把「切换」类的操作又点回去。
    if (href1 === href0 && loc.tag === 'a' && loc.href) {
      const ref = String(a.ref || '');
      const sel = String(a.selector || '');
      await execJsSafe(PICK_INSTALL);
      const hit = await execJsSafe(`(() => { const e = window.__khPick(${JSON.stringify(ref)}, ${JSON.stringify(sel)}); if (!e) return 'missing'; e.click(); return 'clicked'; })()`);
      if (hit === 'clicked') {
        how = '脚本兜底（真实鼠标没让链接跳转）';
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    return ok(`已点击 ${loc.tag} "${loc.name || a.selector || ('ref ' + a.ref)}"（${how}，坐标 ${Math.round(loc.x)},${Math.round(loc.y)}${loc.inView ? '' : '，元素原本在视口外'}`
      + `）${href1 === href0 && loc.tag !== 'a' ? '\n（地址没变；按钮类点击看不出有没有生效，用 browser_snapshot 核对结果）' : ''}\n当前 ${st.url}`);
  },
  async browser_type(a) {
    const loc = await locate(a.ref, a.selector, a.index);
    if (loc.error) return bad(loc.error);
    const ref = String(a.ref || '');
    const sel = String(a.selector || '');
    if (await pick(ref, sel) === 'found') {
      await execJsSafe(`(() => { const e = window.__khPick(${JSON.stringify(ref)}, ${JSON.stringify(sel)}); if (e && 'value' in e) e.value = ''; return 1; })()`);
    }
    await cdp('Input.insertText', { text: String(a.text ?? '') });
    if (a.submit === true || a.submit === 'true') await pressKey('Enter');
    await new Promise((r) => setTimeout(r, 250));
    return ok(`已输入 ${String(a.text ?? '').length} 个字符到 ${loc.tag}${a.submit ? ' 并回车' : ''}`);
  },
};

Object.assign(ACTIONS, {
  async browser_press(a) {
    if (!a.key) return bad('key 必填');
    await pressKey(String(a.key));
    return ok(`已按键 ${a.key}`);
  },
  async browser_scroll(a) {
    const dir = String((a && a.direction) || 'down');
    const amt = Number(a && a.amount) || 800;
    const cmd = dir === 'top' ? 'scrollTo(0,0)'
      : dir === 'bottom' ? 'scrollTo(0, document.body.scrollHeight)'
      : `scrollBy(0, ${dir === 'up' ? -Math.abs(amt) : Math.abs(amt)})`;
    await execJsSafe(`(() => { ${cmd}; return 1; })()`);
    return ok(`滚动后 scrollTop=${Math.round(await execJsSafe('window.scrollY'))}`);
  },
  async browser_select(a) {
    const ref = String(a.ref || '');
    const sel = String(a.selector || '');
    await execJsSafe(PICK_INSTALL);
    const done = await execJsSafe(`(() => {
      const e = window.__khPick(${JSON.stringify(ref)}, ${JSON.stringify(sel)});
      if (!e) return '找不到元素（ref 可能已失效，重新 snapshot）';
      if (e.tagName !== 'SELECT') return '那个元素不是 select';
      e.value = ${JSON.stringify(String(a.value ?? ''))};
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    })()`);
    return done === 'ok' ? ok(`已选择 ${a.value}`) : bad(done);
  },
  /**
   * 等待一律在宿主侧轮询：guest 里返回 Promise 不会被 executeJavaScript await，
   * 会撞上 Electron 的对象序列化错误。
   */
  async browser_wait_for(a) {
    const sel = String((a && a.selector) || '');
    const want = String((a && a.text) || '');
    // 默认 8 秒而不是 20 秒：监工跑清单时「元素没出现」是常态分支，等满 20 秒一轮清单就跑不动了
    const budget = Math.min(Math.max(Number(a && a.timeout_ms) || 8000, 500), 20000);
    const deadline = Date.now() + budget;
    if (sel) {
      while (Date.now() < deadline) {
        const hit = await execJsSafe(`(() => !!document.querySelector(${JSON.stringify(sel)}))()`).catch(() => false);
        if (hit) return ok(`出现：${sel}`);
        await new Promise((r) => setTimeout(r, 250));
      }
      return bad(`等超时（${Math.round(budget / 1000)}s）：没出现 ${sel}`);
    }
    if (want) {
      while (Date.now() < deadline) {
        const hit = await execJsSafe(`(() => !!(document.body && document.body.innerText.includes(${JSON.stringify(want)})))()`).catch(() => false);
        if (hit) return ok(`出现文本：${want}`);
        await new Promise((r) => setTimeout(r, 300));
      }
      return bad(`等超时（${Math.round(budget / 1000)}s）：正文里没有「${want}」`);
    }
    const ms = Math.min(Number(a && a.ms) || 1000, 15000);
    await new Promise((r) => setTimeout(r, ms));
    return ok(`已等待 ${ms}ms`);
  },
  async browser_console(a) {
    const errs = st.errors.slice();
    if (a && (a.clear === true || a.clear === 'true')) st.errors.splice(0, st.errors.length);
    return ok(errs.length ? `${errs.length} 条：\n- ${errs.join('\n- ')}` : '没有控制台报错');
  },
  async browser_screenshot() {
    const b = await guestBox();
    if (b.hw < 40 || b.iw < 40) return bad('浏览器栏还没展开，抓不到画面');
    const r = await window.khDesktop.screenshot(guestId(), false);
    if (r && r.error) return bad(r.error);
    return ok(`已截图（视口 ${b.iw}×${b.ih}）：${r.result.file}（${r.result.bytes} 字节）`);
  },
  async browser_close() {
    await bv({ op: 'nav', url: 'about:blank' });
    return ok('已回到空白页');
  },
});

/** 长轮询取动作 → 执行 → 回填。失败也要回填，否则服务端白等 90 秒超时 */
async function runLoop() {
  while (!stopped) {
    let action = null;
    try {
      action = await aiApi.browserPoll();
      online.value = true;
    } catch (e) {
      online.value = false;
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    if (!action || stopped) continue;
    const fn = ACTIONS[action.name];
    store.markWorking(true);
    store.noteAction(action.name, JSON.stringify(action.args || {}));
    let payload;
    try {
      // 先保证这一栏展开、视图就位。视口不对时坐标全是 0，
      // 与其回一个「成功但什么都没发生」，不如直说没执行
      if (!(await settleForAction())) {
        payload = bad(`浏览器栏没能就位：${settleWhy.value || '视图或视口没准备好'}，这个动作没有执行`);
      } else {
        const run = fn ? fn(action.args || {}) : Promise.resolve(bad(`窗口不认识这个动作：${action.name}`));
        // 万一 guest 卡死（executeJavaScript 永不返回），也不能把整个轮询循环拖住
        payload = await Promise.race([
          run,
          new Promise((r) => setTimeout(() => r(bad('这个动作在窗口里执行超过 80 秒没返回，已放弃')), 80000)),
        ]);
      }
    } catch (e) {
      payload = bad(String((e && e.message) || e));
    }
    store.markWorking(false);
    try { await aiApi.browserReport({ id: action.id, result: payload }); } catch (e) { /* 回填不上就让服务端超时 */ }
  }
}

/** 主进程转来的视图事件：更新界面状态，并唤醒等加载的 waitIdle */
function onBviewEvent(ev) {
  if (!ev) return;
  applyState(ev);
  if (ev.type === 'console' && ev.message) store.logError(ev.message);
  if (ev.type === 'idle') {
    const waiters = idleWaiters.splice(0);
    waiters.forEach((f) => f());
  }
}

let boundsTimer = null;
function onLayoutChange() {
  // 拖动窗口时观察器会连着触发，攒一下再挪（每次都是两趟 IPC）
  if (boundsTimer) return;
  boundsTimer = setTimeout(() => {
    boundsTimer = null;
    syncBounds().catch(() => {});
  }, 80);
}

onMounted(() => {
  if (st.supported) {
    runLoop();
    if (window.khDesktop.onBview) offEvents = window.khDesktop.onBview(onBviewEvent);
    if (typeof ResizeObserver !== 'undefined' && colEl.value) {
      // 这一栏或整页布局变了 → 把原生视图挪到新的洞位
      ro = new ResizeObserver(() => onLayoutChange());
      ro.observe(colEl.value);
    }
    window.addEventListener('resize', onLayoutChange);
    // 挂载先对一次账：栏是收起的就顺手把上一次留下的视图收掉
    syncBounds().catch(() => {});
  }
  statusTimer = setInterval(async () => {
    try {
      const s = await aiApi.browserStatus();
      queued.value = s ? s.queued : 0;
    } catch (e) { /* 服务没起来时静默 */ }
  }, 5000);
});

// 收起时藏掉原生视图（它盖在网页上面，不藏就浮在聊天区上）；展开时对齐位置，
// 顺手把视图建起来，用户也能自己拿这一栏当浏览器用
watch(() => st.open, async (v) => {
  await nextTick();
  if (v && !viewReady) ensureView().catch(() => {});
  syncBounds().catch(() => {});
});

onBeforeUnmount(() => {
  stopped = true;
  if (statusTimer) clearInterval(statusTimer);
  if (ro) ro.disconnect();
  if (boundsTimer) clearTimeout(boundsTimer);
  if (offEvents) offEvents();
  window.removeEventListener('resize', onLayoutChange);
  // 离开聊天页就把视图收掉，免得原生层浮在别的页面上
  if (viewReady) bv({ op: 'destroy' }).catch(() => {});
  viewReady = false;
});
</script>

<style scoped>
/*
 * 布局全部用绝对定位；页面本体是主进程的 BrowserView，摆在 .bc-hole 这块位置上面。
 * 这块洞只负责占位与量尺寸（holeBounds()），不渲染任何网页内容。
 */
.browser-col {
  position: relative;
  width: 420px;
  height: 100%;
  flex-shrink: 0;
  overflow: hidden;
  background: var(--bg-elev);
  border-left: 1px solid var(--border-soft);
  transition: width var(--dur) var(--ease), border-left-width var(--dur) var(--ease);
}
/* 收起 = 宽度收到 0（走上面那条过渡）。
   以前是 position:absolute + left:100%「滑到窗口外」，硬跳一步没有动画；
   仍然不能用 display:none —— 原生视图的洞量不到尺寸，guest 会拿不到视口。
   现在 0 宽时 holeBounds() 拿不到尺寸，syncBounds 自己会把视图收掉。 */
.browser-col:not(.open) {
  width: 0;
  border-left-width: 0;
  pointer-events: none;
}
.bc-head {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 46px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border-soft);
  font-size: 13px;
  font-weight: 600;
}
.bc-head .t { display: inline-flex; align-items: center; gap: 6px; }
.bc-head .busy { font-size: 11px; color: var(--accent); font-weight: 400; }
.bc-head .idle { font-size: 11px; color: var(--text-3); font-weight: 400; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bc-bar {
  position: absolute;
  top: 46px;
  left: 0;
  right: 0;
  height: 48px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border-soft);
}
.bc-bar .addr { flex: 1; min-width: 0; padding: 4px 8px; font-size: 12px; }
/* 主进程的 BrowserView 浮在这块洞上：头部 46 + 地址栏 48，底栏 28 */
.bc-hole { position: absolute; top: 94px; right: 0; bottom: 28px; left: 0; background: #fff; }
.bc-notice {
  position: absolute;
  top: 46px;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 16px;
  overflow: auto;
  background: var(--bg-elev);
  font-size: 13px;
}
.bc-overlay {
  position: absolute;
  z-index: 3;
  left: 12px;
  right: 12px;
  bottom: 40px;
  padding: 6px 10px;
  border-radius: var(--radius-xs);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 12px;
}
.bc-foot {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 28px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  border-top: 1px solid var(--border-soft);
  font-size: 11px;
}
.bc-foot .ellip { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bc-foot .errs { color: var(--warn); }
.browser-col.working { box-shadow: inset 0 0 0 1px var(--accent); }
.icon-btn.sm { width: 26px; height: 26px; font-size: 12px; }
.icon-btn.on { color: var(--accent); }
/* 图钉：没钉时斜着、灰着；钉上了才摆正、涂上主题色并垫一层底 —— 状态一眼分得清 */
.pin-btn { width: 26px; height: 26px; font-size: 12px; }
.pin-btn i {
  color: var(--text-3);
  transform: rotate(-45deg);
  transition: transform .18s var(--ease), color .18s;
}
.pin-btn:hover i { color: var(--text-2); }
.pin-btn.on { background: var(--bg-hover); border-radius: 8px; }
.pin-btn.on i { color: var(--accent); transform: rotate(0deg); }
.bc-edge {
  position: fixed;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  z-index: 40;
  width: 26px;
  height: 54px;
  border: 1px solid var(--border);
  border-right: 0;
  border-radius: var(--radius-sm) 0 0 var(--radius-sm);
  background: var(--surface-pop);
  color: var(--text-2);
}
.bc-edge:hover { color: var(--text); border-color: var(--border-strong); }
</style>



