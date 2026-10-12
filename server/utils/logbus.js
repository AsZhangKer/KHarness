/**
 * 进程内日志总线（第六十四轮「调试」板块的数据源）。
 *
 * 后台日志原本只有一个去处：外壳把子进程 stdout 逐行 appendFile 进 desktop.log。
 * 那既读不到（界面没有通道），也不能过滤、不能实时，出事只能靠「点击复制报错」里那 60 条客户端台账。
 * 这里补一份内存环形缓冲：console 的三个级别、每个进来的 HTTP 请求、每次打给上游的请求都往里落，
 * 界面上的日志悬浮窗通过 SSE 实时看。
 *
 * 只存内存、不落盘：这一份里有真实的上游响应体与密钥片段，磁盘上多一份拷贝不合适；
 * 要历史仍然有 desktop.log（console 钩子照样往原处打）。
 */
const MAX = 2000;
const lines = [];
const subs = new Set();
let seq = 0;
let consoleHooked = false;

function now() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 一行日志。tag：op（后端输出）/ http（进来的请求）/ up（打给上游）/ web（客户端自己报的） */
function push({ level = 'info', tag = 'op', text = '', ms = 0 } = {}) {
  const line = { id: ++seq, at: now(), level, tag, text: String(text).slice(0, 800), ms: Math.round(Number(ms) || 0) };
  lines.push(line);
  if (lines.length > MAX) lines.splice(0, lines.length - MAX);
  for (const send of [...subs]) { try { send(line); } catch (e) { /* 那头断了，下面 close 里摘 */ } }
  return line;
}

/** 订阅实时行，返回取消函数；快照交出去（悬浮窗一打开就得有历史） */
function subscribe(send, snapshotSize = MAX) {
  subs.add(send);
  for (const line of lines.slice(-snapshotSize)) { try { send(line); } catch (e) { break; } }
  return () => subs.delete(send);
}

function snapshot(n = MAX) {
  return lines.slice(-n);
}

function clear() {
  lines.length = 0;
  push({ level: 'info', tag: 'op', text: '（日志已清空）' });
}

function size() { return lines.length; }

/**
 * 劫持 console：原样再打一遍（stdout 不能断，desktop.log 与 `npm start` 的终端输出全靠它），
 * 同时落一份进环形缓冲。
 * 参数按原样拼成一行 —— 后端到处是 `console.log('[mcp]', name, obj)`，
 * 只取第一个参数会把关键的那半截丢掉。
 */
function hookConsole() {
  if (consoleHooked) return;
  consoleHooked = true;
  const fmt = (args) => args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return `${a.message}｜${String((a.cause && (a.cause.message || a.cause.code)) || '')}`;
    try { return JSON.stringify(a); } catch (e) { return String(a); }
  }).join(' ');
  const wrapOne = (key, level) => {
    const orig = console[key];
    console[key] = (...args) => {
      try { orig.apply(console, args); } catch (e) { /* 原输出炸了也不该带走钩子 */ }
      // 钩子自己不许再走 console，否则一条日志无限递归
      try { push({ level, tag: 'op', text: fmt(args) }); } catch (e) { /* 记不上就算了 */ }
    };
  };
  wrapOne('log', 'info');
  wrapOne('info', 'info');
  wrapOne('warn', 'warn');
  wrapOne('error', 'error');
}

/** 上游那一趟：状态码 / 耗时 / 失败原因，提供商与模型带上，密钥一律不进 */
function upstream({ provider = '', model = '', url = '', status = 0, ms = 0, error = '' }) {
  const host = (() => { try { return new URL(String(url || '')).host; } catch (e) { return String(url || '').slice(0, 60); } })();
  const label = [provider, model].filter(Boolean).join(' · ') || host;
  if (error) return push({ level: 'error', tag: 'up', ms, text: `上游 ${label}（${host}）失败：${String(error).slice(0, 200)}` });
  const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
  return push({ level, tag: 'up', ms, text: `上游 ${label}（${host}）→ HTTP ${status}` });
}

module.exports = { push, subscribe, snapshot, clear, size, hookConsole, upstream, MAX };
