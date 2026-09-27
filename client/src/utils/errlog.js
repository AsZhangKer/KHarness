/**
 * 客户端报错台账（环形缓冲）：给「点击复制报错」当附件用。
 *
 * 为什么要它：主人要的口径是「弹窗上可以只写一句概括，但复制走的内容要全 —— 包括日志、
 * 最初的报错」。一条链式失败（比如 SSE 断了 → 前端报「流式输出中断」→ 点复制只有一句
 * 概括）最缺的就是「前面还发生了什么」。这里按时间留最近几十条，复制时整段附上。
 *
 * 只存内存、不落盘：重启即清，避免把带密钥的上游响应体留在磁盘上。
 */
const MAX = 60;
const items = [];
let installed = false;

function now() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * @param entry { kind, summary, detail, where }
 * kind：error（报错）/ net（请求失败）/ sse（流式事件）/ ui（用户操作）/ log（普通日志）
 */
export function logErr(entry = {}) {
  items.push({ at: now(), kind: String(entry.kind || 'log'), summary: String(entry.summary || '').slice(0, 300), detail: String(entry.detail || '').slice(0, 1500), where: String(entry.where || '').slice(0, 120) });
  if (items.length > MAX) items.splice(0, items.length - MAX);
}

export function recentErrs(n = 10) {
  return items.slice(-n);
}

/** 复制用的纯文本版：一行一条，最新的在最后 */
export function errLogText(n = 10) {
  return recentErrs(n).map((x) => `${x.at} [${x.kind}]${x.where ? ' ' + x.where + ' ·' : ''} ${x.summary}${x.detail ? ' ｜ ' + x.detail.replace(/\s+/g, ' ') : ''}`).join('\n');
}

export function errLogSize() {
  return items.length;
}

export function clearErrLog() {
  items.length = 0;
}

/**
 * 兜住没人接的异常：未捕获错误、Promise 拒绝、以及 console.error。
 * console.error 也记是因为很多库（xterm、vue 自己）只往控制台喊，不抛异常，
 * 出问题时那行字恰恰是唯一线索。
 */
export function installErrLog() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (ev) => {
    logErr({
      kind: 'error',
      where: 'window.onerror',
      summary: String(ev?.message || '未捕获异常').slice(0, 200),
      detail: String(ev?.error?.stack || ev?.filename || '') + (ev?.lineno ? `:${ev.lineno}` : ''),
    });
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev?.reason;
    logErr({
      kind: 'error',
      where: 'unhandledrejection',
      summary: String((r && r.message) || r || '未处理的 Promise 拒绝').slice(0, 200),
      detail: String((r && r.stack) || ''),
    });
  });
  // 控制台只留最近这些，别把自己撑爆；原始输出照常打到 DevTools
  const orig = console.error;
  console.error = function (...args) {
    try {
      logErr({
        kind: 'console',
        where: 'console.error',
        summary: args.map((a) => (typeof a === 'string' ? a : String((a && a.message) || a))).join(' ').slice(0, 200),
        detail: String((args.find((a) => a && a.stack) || {}).stack || ''),
      });
    } catch (e) { /* 记账失败绝不能把真正的报错也吃掉 */ }
    return orig.apply(console, args);
  };
}
