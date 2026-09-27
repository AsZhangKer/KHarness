// 统一响应助手与异步路由包装器

/**
 * 把一个异常拆成人能看的详细原因：NameError｜errno｜syscall｜HTTP 状态｜消息，
 * 再顺 cause / errors（undici 的 fetch failed、AggregateError 的 all）往下一层。
 * routes/ai.js 里流式报错用的就是同一套逻辑，收在这儿给大家用。
 */
function errDetail(e, max = 600) {
  if (e == null) return '未知错误';
  if (typeof e !== 'object') return String(e).substring(0, max);
  const bits = [];
  const push = (v) => { const s = String(v ?? '').trim(); if (s && !bits.includes(s)) bits.push(s); };
  // 一个错误对象能说的都说了：Name / Node 的字符串 code（ENOENT…）/ ssh2 的数字 code 与 level /
  // errno / syscall / HTTP status / message。SFTP 那句光秃秃的 "Failure" 单独看等于没说，
  // 配上 code=4（SSH_FX_FAILURE）才知道是服务端拒绝而不是通道断了。
  const one = (o) => {
    push(o.name && o.name !== 'Error' ? o.name : '');
    push(o.level ? `level=${o.level}` : '');
    if (o.code != null) push(typeof o.code === 'number' ? `code=${o.code}` : String(o.code));
    if (o.errno != null && String(o.errno) !== String(o.code)) push(`errno=${o.errno}`);
    push(o.syscall ? `syscall=${o.syscall}` : '');
    push(o.status ? `HTTP ${o.status}` : (o.statusCode ? `HTTP ${o.statusCode}` : ''));
    push(o.message);
  };
  const walk = (c, depth) => {
    if (!c || depth > 3) return;
    if (typeof c !== 'object') { push(c); return; }
    one(c);
    walk(c.cause, depth + 1);
    if (Array.isArray(c.errors)) for (const item of c.errors.slice(0, 2)) walk(item, depth + 1);
  };
  one(e);
  walk(e.cause, 1);
  if (Array.isArray(e.errors)) for (const item of e.errors.slice(0, 2)) walk(item, 1);
  const joined = bits.join('｜');
  return (joined || String(e)).substring(0, max);
}

/** 概括 + 详情拼成一句：详情为空时只剩概括 */
function errMessage(summary, e, max = 700) {
  const s = String(summary || '').trim();
  if (!e) return s;
  const detail = errDetail(e);
  if (!detail || s.includes(detail)) return s;
  return `${s}：${detail}`.substring(0, max);
}

function ok(res, data = null, message = 'success') {
  res.json({ code: 200, message, data });
}

function fail(res, status, message, detail = '') {
  const body = { code: status, message };
  // detail 单独一份给 toast 这类「只显示概括」的位置用：界面可以用 message 显示全句，
  // 或用 summary + detail 分开显示/复制，不必拿字符串去猜哪段是原因。
  const d = String(detail || '').trim();
  const m = String(message || '');
  body.detail = d;
  body.summary = d && m.endsWith(`：${d}`) ? m.slice(0, m.length - d.length - 1) : m;
  res.status(status).json(body);
}

/** 失败但要把异常细节带上（本机服务，不存在把内部错误泄露给外人的问题） */
function failErr(res, status, summary, e) {
  const detail = errDetail(e);
  fail(res, status, errMessage(summary, e), detail);
}

// 包装 async 路由处理器，异常统一抛给全局错误中间件
function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = { ok, fail, failErr, wrap, errDetail, errMessage };
