// 上游请求的代理层（提供商上的「代理」标记 → 真正建 ProxyAgent）
//
// 原来这个判断在 9 个地方各抄了一遍（聊天、压缩、跑分、拉模型列表、ping、侧栏、子智能体、监工、托管），
// 要加「全局禁用代理」这个开关就得改 9 处，很容易漏 —— 漏掉的那条路会偷偷继续走代理。
// 现在统一收在这里，并且多一个能力：**代理连不上时自动退回直连**（见 isProxyConnectError）。
const { db } = require('../database');

let cachedDisabled = null;
let cachedAt = 0;

/**
 * 「禁用全局代理设定」开关（设置 → 常规）。读一次缓存 5 秒：
 * 每条消息都要判一次，而这是同一张表里的同一个值，没必要每条请求都查。
 */
function proxyGloballyDisabled() {
  if (cachedDisabled !== null && Date.now() - cachedAt < 5000) return cachedDisabled;
  let v = '0';
  try { v = (db.prepare("SELECT value FROM settings WHERE key = 'proxy_disabled'").get() || {}).value || '0'; } catch (e) { v = '0'; }
  cachedDisabled = String(v).trim() === '1';
  cachedAt = Date.now();
  return cachedDisabled;
}

function cacheBust() { cachedAt = 0; cachedDisabled = null; }

/** 该提供商这次请求该用哪个 dispatcher；返回 undefined = 直连 */
function proxyFor(row) {
  if (!row || !row.proxy_enabled || !row.proxy_host) return undefined;
  if (proxyGloballyDisabled()) return undefined;
  try {
    const { ProxyAgent } = require('undici');
    const port = row.proxy_port || 7890;
    return new ProxyAgent(`http://${row.proxy_host}:${port}`);
  } catch (e) {
    return undefined;
  }
}

/**
 * 「像是代理连不上」的连接级错误：代理没开 / 端口不对 / 代理挂了。
 * 只认这几类，别的（HTTP 4xx、超时、DNS 解析不到目标站）不在此列 —— 那些退直连也救不了，
 * 白重发一次反而把 20 秒超时又拖一遍。
 */
function isProxyConnectError(e) {
  const s = String((e && (e.message || e.code)) || '') + ' ' + String(e && e.cause && (e.cause.code || e.cause.message) || '');
  return /ECONNREFUSED|ECONNRESET|UND_ERR_CONNECT|UND_ERR_SOCKET|EHOSTUNREACH|ENETUNREACH|connect proxy|proxy connection|Socks5|socks/i.test(s);
}

/**
 * 一次性的「走代理，代理连不上就直连」请求：拉模型列表 / ping 这类单发请求用它。
 * 聊天主循环不走这里 —— 它有自己的重试循环，且直连决定要一直保持（见 routes/ai.js fetchUpstream 的 directOnly）。
 * onFallback 在真的退回直连时回调一次，调用方拿去给 UI 发提示。
 */
async function fetchViaProxy(row, url, opts = {}, onFallback = null) {
  const { fetch } = require('undici');
  const dispatcher = proxyFor(row);
  if (!dispatcher) return { resp: await fetch(url, opts), fellBack: false };
  try {
    return { resp: await fetch(url, { ...opts, dispatcher }), fellBack: false };
  } catch (e) {
    if (!isProxyConnectError(e)) throw e;
    if (onFallback) onFallback();
    const rest = { ...opts };
    delete rest.dispatcher;
    return { resp: await fetch(url, rest), fellBack: true };
  }
}

module.exports = { proxyFor, proxyGloballyDisabled, isProxyConnectError, fetchViaProxy, cacheBust };
