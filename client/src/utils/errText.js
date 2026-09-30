/**
 * 报错文案统一出口：任何异常都拆成「概括」和「详情」两段。
 *
 * 为什么要拆：界面各处对报错的容纳能力差很远 —— toast 只有一行、弹窗刻意不刷屏，
 * 而内联的错误条、结果区有地方放整段原因。以前所有地方都只显示同一句粗略概括
 * （「操作失败」「读不了：Failure」），出问题时得回去翻日志。
 * 现在：有地方的直接显示 full，toast 与弹窗显示 summary，点一下复制 summary + detail 两行。
 *
 * 服务端（server/utils/respond.js）在错误信封里同时回了 message（概括：详情）、summary、detail，
 * 这里优先用它，拿不到时才退回客户端自己拼。
 */
import { toast } from '../stores/toast';
import { logErr, errLogText } from './errlog';

function firstLine(s, max = 160) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.substring(0, max) + '…' : t;
}

/** 从 axios 风格的异常里取服务端错误信封（{ code, message, summary, detail }） */
function envelope(e) {
  const d = e?.response?.data;
  if (d && typeof d === 'object' && !d.data && (d.message || d.detail || d.summary)) return d;
  const bd = e?.data;      // 少数地方直接拿到 fetch/流式响应体
  if (bd && typeof bd === 'object' && (bd.message || bd.detail || bd.summary)) return bd;
  return null;
}

/**
 * @param e        异常（axios / Error / 字符串都行）
 * @param fallback 拿不到任何信息时的概括
 * @returns {{summary:string, detail:string, full:string}} full 是给人看的那一句（概括：详情）
 */
export function describeErr(e, fallback = '操作失败') {
  const env = envelope(e);
  if (env) {
    const detail = String(env.detail || '').trim();
    const message = String(env.message || '').trim();
    const summary = firstLine(env.summary || (detail && message.endsWith(`：${detail}`) ? message.slice(0, message.length - detail.length - 1) : message) || fallback);
    return { summary, detail, full: detail ? (message || `${summary}：${detail}`) : summary };
  }
  // 客户端自己的异常：调用方给的概括负责「哪儿失败了」，异常原文负责「为什么」。
  // toast 只显示前者，后者进详情 —— 这正是要的效果（以前两者混在一行或干脆丢掉详情）。
  if (typeof e === 'string') {
    const t = firstLine(e);
    return { summary: t, detail: '', full: t };
  }
  const raw = String(e?.message || e || '').replace(/\s+/g, ' ').trim();
  const summary = firstLine(fallback || raw) || '操作失败';
  const detail = (String(e?.stack || raw).trim()).substring(0, 1200);
  return { summary, detail, full: detail ? `${summary}：${firstLine(raw, 500)}` : summary };
}

/** 只要一句完整文案的地方（内联错误条、结果区）用这个 */
export function errFull(e, fallback = '操作失败') {
  return describeErr(e, fallback).full;
}

/**
 * 异常链：一个「失败」常常是套起来的（AxiosError ← TypeError: fetch failed ← ECONNREFUSED），
 * 只报最外面那层等于没报。逐层把 name + message 拉出来，最多 5 层防环。
 */
function causeChain(e) {
  const out = [];
  let cur = e;
  const seen = new Set();
  while (cur && out.length < 5 && !seen.has(cur)) {
    seen.add(cur);
    if (typeof cur === 'string') { out.push(cur); break; }
    const name = cur.name && cur.name !== 'Error' ? `${cur.name}: ` : '';
    const msg = String(cur.message || cur.code || '').trim();
    if (msg) out.push(`${name}${msg}`);
    // AggregateError（Promise.allSettled 一类）与 cause 都算「下一层」
    cur = cur.cause || (Array.isArray(cur.errors) && cur.errors.length ? cur.errors[0] : null);
  }
  return out;
}

/**
 * 复制用的全量报告。
 *
 * 主人的口径：「弹窗报错可以简写，但点击复制要复制全，包括日志、初始报错问题等」。
 * 所以界面上仍是一句概括，复制走的是这份：时间 / 页面 / 位置 / 请求与状态 / 概括 / 详情 /
 * 完整异常链 / 堆栈前几帧 / 最近若干条客户端日志。
 *
 * @param ctx { where, request, status, code } —— 调用方知道的上下文，能给的都给
 */
export function errReport(e, fallback = '操作失败', ctx = {}) {
  const { summary, detail } = describeErr(e, fallback);
  const lines = [];
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  lines.push(`【KHarness 报错】${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`);
  lines.push(`页面：${location.pathname}${location.search}`);
  if (ctx.where) lines.push(`位置：${ctx.where}`);
  if (ctx.request) lines.push(`请求：${ctx.request}`);
  if (ctx.status != null || ctx.code != null) {
    lines.push(`状态：HTTP ${ctx.status == null ? '?' : ctx.status}${ctx.code != null ? ` · code=${ctx.code}` : ''}`);
  }
  lines.push(`概括：${summary}`);
  lines.push(`详情：${detail || '（没有额外详情）'}`);
  const chain = causeChain(e);
  if (chain.length > 1) {
    lines.push('异常链：');
    chain.forEach((c, i) => lines.push(`  ${i + 1}. ${firstLine(c, 400)}`));
  }
  const stack = String((e && e.stack) || '');
  const frames = stack.split('\n').filter((l) => /^\s+at /.test(l)).slice(0, 4);
  if (frames.length) {
    lines.push('堆栈：');
    frames.forEach((f) => lines.push(`  ${f.trim()}`));
  }
  const log = errLogText(10);
  if (log) {
    lines.push('—— 最近日志（客户端台账，最新在最后）——');
    lines.push(log);
  }
  return lines.join('\n');
}

/**
 * 报错进 toast 的统一入口：一句话概括显示，技术原因与全量报告挂在 toast 上（点击复制整份）。
 * 各处原来写的是 toast(response.data.message || '保存失败') —— 那等于把整段
 * 详情糊在一行里，或者直接吞掉详情只留「保存失败」，两头都不好看。
 * 同时把这一条记进客户端台账：后面任何一条报错复制时都能带上「前面还发生了什么」。
 */
export function toastErr(e, fallback = '操作失败', duration = 3500, ctx = {}) {
  const { summary, detail } = describeErr(e, fallback);
  logErr({ kind: 'error', where: ctx.where || ctx.request || '', summary, detail });
  toast(summary, 'error', duration, detail, errReport(e, fallback, ctx));
}

/** 复制用：只给「概括 + 详情」两行的轻量版（内联错误条那种没有上下文的场合） */
export function errCopyText(e, fallback = '操作失败') {
  const { summary, detail } = describeErr(e, fallback);
  return detail ? `${summary}\n${detail}` : summary;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    // Electron 里没授予剪贴板权限时退回 execCommand，至少不是「点了没反应」
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e2) {
      return false;
    }
  }
}
