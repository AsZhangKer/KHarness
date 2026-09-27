/**
 * 底部终端抽屉的状态：会话列表 + 每个会话一套自己的 xterm。
 *
 * 两条从坑里爬出来的规矩：
 * 1) 每个会话有自己独立的 DOM 容器，切换标签只改显示、不改挂载。
 *    早先所有会话共用一个容器、切一次就 innerHTML='' 再 open() 一次，结果是
 *    屏幕上是上一个会话的残影、xterm 的内部缓冲却已经是这一个的 —— 又串又花。
 * 2) xterm 实例与 EventSource 放在模块级的普通 Map 里（不进 reactive）——
 *    把它们塞进响应式对象会让 Vue 去代理整个终端对象，xterm 内部大量读写会明显掉帧。
 *
 * 输出流每个会话一条、常驻（不只当前标签）：后台标签也要继续收，切回来不用重放，
 * 服务端「10 分钟无人看就回收」的判定也就符合直觉了（抽屉开着等于有人在看）。
 *
 * 输入走 POST + 16ms 合批：一次按键一个请求在本地回环上没问题，但按住退格会打出上百个请求，
 * 攒一下再发既跟手又不刷日志。
 */
import { reactive, watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { aiApi } from '../../api';
import { toast } from '../../stores/toast';
import { toastErr } from '../../utils/errText';
import { uiPrefs } from '../../stores/prefs';

const state = reactive({
  open: false,
  height: 300,
  sessions: [],          // [{id,title,kind,shell,host,alive}]
  activeId: '',
  options: null,         // /term/options 的结果
  fonts: null,           // 系统字体列表（第一次打开设置面板时懒加载）
  loading: false,
  menu: null,            // 标签右键菜单 { id, x, y }
  settings: false,       // 设置弹层
});

/**
 * 字体/字号存在服务端 settings（走 uiPrefs）里，不放 localStorage。
 * 桌面端每次启动拿到的端口都可能不一样，而 localStorage 按 origin 分家、origin 里带端口 ——
 * 存那里的东西每启动一次就回一次默认值，用户看到的就是「终端设置根本没记住」。
 * 服务端那份只管字体能不能 spawn，画成什么样归这里这两个值。
 */
const prefs = uiPrefs.state;

// 启动时 uiPrefs 往往还没回来说话，值到了再把浮窗高度对过去
watch(() => prefs.termHeight, (v) => { if (v) state.height = v; }, { immediate: true });

const terms = new Map();   // id -> { term, fit, el, host, es, pending, timer, ro, opened }

const b64 = (s) => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};
const unb64 = (s) => {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};

function fontFace() {
  return prefs.termFont || 'Consolas, Cascadia Mono, Menlo, DejaVu Sans Mono, monospace';
}

async function loadOptions(force = false) {
  if (state.options && !force) return state.options;
  try {
    state.options = await aiApi.termOptions();
  } catch (e) {
    state.options = { pty_ok: false, shells: [], hosts: [], max: 0, elevate_ok: false, admin_default: false };
  }
  return state.options;
}

async function refreshList() {
  try {
    const rows = (await aiApi.termList()) || [];
    state.sessions = rows;
    if (state.activeId && !rows.some((r) => r.id === state.activeId)) state.activeId = rows[0]?.id || '';
    // 后端把会话回收了就把本地的 xterm 与流一起清掉，不然切回去是块死屏幕
    for (const id of [...terms.keys()]) {
      if (!rows.some((r) => r.id === id)) destroy(id);
    }
  } catch (e) { /* 列表拿不到不影响已开的终端 */ }
}

function makeEntry(id) {
  const term = new Terminal({
    convertEol: false,
    cursorBlink: true,
    scrollback: 4000,
    theme: { background: 'transparent' },
    fontFamily: fontFace(),
    fontSize: prefs.termSize,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const el = document.createElement('div');
  el.style.cssText = 'position:absolute;inset:0;';
  const entry = { term, fit, el, host: null, es: null, pending: '', timer: null, ro: null, opened: false };
  term.onData((d) => queueInput(id, d));
  terms.set(id, entry);
  return entry;
}

/**
 * 把这个会话的 xterm 挂到它自己的容器上（TerminalDock 里 v-for 出来的那一个）。
 * open 只发生一次；再切回来只是换个父节点，不是从头来过。
 */
function mount(id, hostEl) {
  if (!id || !hostEl) return null;
  let entry = terms.get(id);
  if (!entry) entry = makeEntry(id);
  if (entry.host !== hostEl) {
    if (entry.el.parentNode && entry.el.parentNode !== hostEl) entry.el.parentNode.removeChild(entry.el);
    hostEl.appendChild(entry.el);
    entry.host = hostEl;
  }
  if (!entry.opened) {
    entry.term.open(entry.el);
    entry.opened = true;
    // 隐藏时量出来是 0，fit 会算出没用的行列数；等有尺寸了（切回来 / 拖高 / 窗口变化）再 fit
    if (typeof ResizeObserver !== 'undefined') {
      entry.ro = new ResizeObserver(() => {
        const r = entry.el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) return;
        fitEntry(id);
      });
      entry.ro.observe(entry.el);
    }
    fitEntry(id);
  }
  stream(id);
  return entry;
}

function fitEntry(id) {
  const entry = terms.get(id);
  if (!entry || !entry.opened) return;
  try { entry.fit.fit(); } catch (e) { return; /* 还没布局完，等 ResizeObserver 再试 */ }
  const { cols, rows } = entry.term;
  if (cols && rows) aiApi.termResize(id, { cols, rows }).catch(() => {});
}

function queueInput(id, data) {
  const entry = terms.get(id);
  if (!entry) return;
  entry.pending += data;
  if (entry.timer) return;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    const payload = entry.pending;
    entry.pending = '';
    if (payload) aiApi.termInput(id, { data: b64(payload) }).catch(() => {});
  }, 16);
}

/** 挂上这条会话的输出流（EventSource 直连，不经 axios）。每个会话一条，常驻 */
function stream(id) {
  const entry = terms.get(id);
  if (!entry || entry.es) return;
  const es = new EventSource(`/api/ai/term/${id}/stream`);
  entry.es = es;
  es.onmessage = (ev) => {
    let m = null;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (!m) return;
    if (m.t === 'out') entry.term.write(unb64(m.data));
    else if (m.t === 'exit') {
      entry.term.write(`\r\n\x1b[33m── 终端进程已退出${m.code == null ? '' : `（退出码 ${m.code}）`}，右键标签可归档或关掉 ──\x1b[0m\r\n`);
      const s = state.sessions.find((x) => x.id === id);
      if (s) s.alive = false;
      es.close();
      entry.es = null;
    }
  };
  es.onerror = () => { /* EventSource 自己会重连；后端会话没了会直接 404 结束 */ };
}

/**
 * 字体/字号是全局的，改一次所有在开的终端都得跟上 ——
 * 原来这里只动了当前标签，其它标签要等切过去、下次挂载才换脸。
 */
function applyFont() {
  uiPrefs.save({ termFont: prefs.termFont, termSize: prefs.termSize });
}

// 值从哪里变的都无所谓（面板改的、启动时服务端回来的），一律把活终端刷一遍
watch(() => [prefs.termFont, prefs.termSize], () => {
  for (const [id, entry] of terms.entries()) {
    if (!entry.opened) continue;
    entry.term.options.fontFamily = fontFace();
    entry.term.options.fontSize = prefs.termSize;
    fitEntry(id);
  }
});

async function loadFonts() {
  if (state.fonts) return state.fonts;
  try {
    const r = await aiApi.termFonts();
    state.fonts = r?.fonts || [];
  } catch (e) {
    state.fonts = [];
  }
  return state.fonts;
}

async function openSession({ kind = 'local', shell = 'auto', host_id = 0, cwd = '' } = {}) {
  state.loading = true;
  try {
    // 字体/字号在服务端：第一个终端建起来之前先拿到，免得用默认值画一屏再抖一下
    await uiPrefs.load();
    const entry0 = terms.get(state.activeId);
    const cols = entry0?.term?.cols || 100;
    const rows = entry0?.term?.rows || 26;
    const r = await aiApi.termOpen({ kind, shell, host_id, cwd, cols, rows });
    if (!r?.id) return null;
    await refreshList();
    state.open = true;
    state.activeId = r.id;
    toast(`已打开 ${r.title || '终端'}`, 'success');
    return r;
  } catch (e) {
    toastErr(e, '终端开不起来');
    return null;
  } finally {
    state.loading = false;
  }
}

/**
 * 按当前会话是本地还是远程，开一个「初始终端」。
 * 本地用设置页里填的那个 Shell（服务端 shell=auto 就是解析成它），远程用这个会话挂的那台机器。
 */
async function openDefault({ remoteHost = null, cwd = '' } = {}) {
  if (remoteHost) {
    return openSession({ kind: 'remote', host_id: remoteHost.id, cwd: remoteHost.default_cwd || remoteHost.home || '' });
  }
  return openSession({ kind: 'local', shell: 'auto', cwd: cwd && !cwd.startsWith('/') ? cwd : '' });
}

async function renameSession(id, title) {
  const t = String(title || '').trim();
  if (!t) return false;
  try {
    await aiApi.termTitle(id, t);
    const s = state.sessions.find((x) => x.id === id);
    if (s) s.title = t;
    return true;
  } catch (e) {
    toastErr(e, '改名失败');
    return false;
  }
}

/** 导出内容：拿服务端那份（已剥掉 ANSI 的）文本，在浏览器侧落盘 */
async function exportSession(id) {
  try {
    const r = await aiApi.termDump(id);
    const text = r?.text || '';
    if (!text.trim()) { toast('这个终端还没有输出', 'warn'); return; }
    const s = state.sessions.find((x) => x.id === id);
    const name = `term-${String(s?.title || id).replace(/[\\/:*?"<>|\s]/g, '_')}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast(`已导出 ${name}`, 'success');
  } catch (e) {
    toastErr(e, '导出失败');
  }
}

/**
 * 归档：日志进系统回收站 + 关掉这个 tty（服务端一次做完，中途掉线也不会留下半个状态）。
 * 归档不是留档 —— 用户要的是「内容还能捞回来，但标签别占着」，回收站就是本机最顺手的捞回入口。
 */
async function archiveSession(id) {
  try {
    await aiApi.termArchive(id);
    destroy(id);
    await refreshList();
    // 东西在哪、tty 关了都由服务端那两条 toast 说，这里不再叠一句
  } catch (e) {
    toastErr(e, '归档失败');
  }
}

async function closeSession(id) {
  try { await aiApi.termClose(id); } catch (e) { /* 后端已经收了就算了 */ }
  destroy(id);
  await refreshList();
}

function destroy(id) {
  const entry = terms.get(id);
  if (!entry) return;
  if (entry.es) { try { entry.es.close(); } catch (e) { /* 收尾 */ } }
  if (entry.timer) clearTimeout(entry.timer);
  if (entry.ro) { try { entry.ro.disconnect(); } catch (e) { /* 收尾 */ } }
  if (entry.el?.parentNode) { try { entry.el.parentNode.removeChild(entry.el); } catch (e) { /* 已经不在 DOM 里 */ } }
  try { entry.term.dispose(); } catch (e) { /* 已销毁 */ }
  terms.delete(id);
}

function select(id) {
  state.activeId = id;
  // 容器刚从 0 尺寸变成有尺寸，RO 一般会跑；同一帧里错过就主动补一次
  fitEntry(id);
}

function fitActive() {
  fitEntry(state.activeId);
}

/** 拖完上边缘的把手：把浮窗高度落到服务端（和字体同一个道理，localStorage 靠不住） */
function saveHeight() {
  uiPrefs.save({ termHeight: state.height });
}

function openMenu(id, x, y) {
  state.menu = { id, x, y };
}

function closeMenu() {
  state.menu = null;
}

function toggle(force) {
  state.open = force === undefined ? !state.open : !!force;
  if (state.open) {
    loadOptions();
    refreshList();
  } else {
    state.menu = null;
    state.settings = false;
  }
}

export const terminalStore = {
  state, prefs, loadOptions, loadFonts, refreshList, mount, stream, fitActive, fitEntry, applyFont,
  openSession, openDefault, renameSession, exportSession, archiveSession, closeSession,
  select, toggle, destroy, openMenu, closeMenu, saveHeight,
  has: (id) => terms.has(id),
};
