// 权限规则引擎 + 命令行 token 解析
// 规则三类（命令 / 路径 / 关键词，另加工具名）× 两表（黑名单直接拒绝、白名单免审批）
// 同时提供「命令中的真实路径」提取：把 /c、/y、/Force 这类开关与 /etc/passwd、C:\Windows 这类路径分开
const fs = require('fs');
const path = require('path');
const { db } = require('../database');

const KINDS = ['command', 'path', 'keyword', 'tool'];
const LISTS = ['black', 'white'];
const MATCHES = ['exact', 'prefix', 'regex', 'contains'];

let cache = null;

function reload() { cache = null; }

function rules() {
  if (cache) return cache;
  try {
    cache = db.prepare('SELECT * FROM perm_rules WHERE enabled = 1 ORDER BY id ASC').all();
  } catch (e) {
    cache = [];
  }
  return cache;
}

const normPath = (p) => {
  let s = String(p || '');
  try { s = path.resolve(s); } catch (e) { /* 保持原样 */ }
  s = s.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
};

function matchOne(rule, value, kind) {
  const target = String(value ?? '');
  const pat = String(rule.pattern ?? '');
  if (!pat) return false;
  if (rule.match === 'regex') {
    try { return new RegExp(pat, 'i').test(target); } catch (e) { return false; }
  }
  if (kind === 'path' || rule.kind === 'path') {
    const a = normPath(target);
    const b = normPath(pat);
    if (rule.match === 'exact') return a === b;
    if (rule.match === 'prefix') return a === b || a.startsWith(b + path.sep) || a.startsWith(b + '/');
    return a.includes(b.replace(/^[A-Za-z]:/, '')) || target.toLowerCase().includes(pat.toLowerCase());
  }
  const hay = target.toLowerCase();
  const needle = pat.toLowerCase();
  if (rule.match === 'exact') return hay === needle;
  if (rule.match === 'prefix') return hay.startsWith(needle);
  return hay.includes(needle);
}

// 命令规则里 exact/prefix 针对「命令名」（第一个 token），contains/regex 针对整条命令
function commandSubject(cmd) {
  const toks = splitArgs(cmd);
  return toks.length ? toks[0] : String(cmd || '').trim();
}

// ---------- 命令行 token 切分（识别引号与转义；Windows 反斜杠路径不作转义处理） ----------
function splitArgs(cmd) {
  const s = String(cmd || '');
  const out = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '\\' && q === '"' && s[i + 1] !== undefined && !/[A-Za-z0-9_\\/.-]/.test(s[i + 1])) { cur += s[++i]; continue; }
      if (ch === q) { q = null; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    // 仅对引号/空格做反斜杠转义，避免把 D:\Windows 里的 \W 当成转义序列吃掉
    if (ch === '\\' && /["'\s]/.test(s[i + 1] || '')) { cur += s[++i]; continue; }
    if (/\s|[;&|]/.test(ch)) {
      if (cur) { out.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

// POSIX 根下常见一级目录；用于区分 /etc（路径）与 /c（Windows 开关）
const POSIX_ROOTS = new Set([
  'etc', 'usr', 'var', 'home', 'root', 'tmp', 'opt', 'bin', 'sbin', 'lib', 'lib64',
  'proc', 'sys', 'dev', 'boot', 'mnt', 'media', 'srv', 'run', 'snap', 'usrlocal', 'share'
]);

function looksLikePathToken(tok) {
  const t = String(tok || '');
  if (!t) return false;
  if (/^https?:\/\//i.test(t) || /^[a-z]+:\/\//i.test(t)) return false; // URL
  if (/^[A-Za-z]:[\\/]/.test(t)) return true;                            // Windows 盘符路径
  if (/^~[\\/]/.test(t)) return true;                                    // 家目录
  if (/^\\\\/.test(t)) return true;                                      // UNC
  if (!t.startsWith('/')) return false;
  if (t === '/') return true;
  if (t.startsWith('//')) return false;                                  // 注释/协议残留
  const body = t.slice(1);
  const segs = body.split(/[\\/]+/).filter(Boolean);
  if (!segs.length) return true;
  const first = segs[0];
  // 开关形态：/c、/y、/Force、/p:、/nologo=1 —— 单段、纯字母（可带尾部 : 或 = 值）
  const switchLike = /^[A-Za-z][A-Za-z0-9._-]*(?::=.*)?$|^[A-Za-z][A-Za-z0-9._-]*[:=]/.test(body);
  if (segs.length === 1) {
    if (POSIX_ROOTS.has(first)) return true;
    if (switchLike) return false;
    try { if (fs.existsSync(path.posix.join('/', first))) return true; } catch (e) { /* ignore */ }
    // 多字母且含大小写混排（/NoProfile）判为开关；纯小写短词（/etc）留作路径
    return false;
  }
  // 多段路径：/usr/bin/env、/a/b/c.txt —— 首段是开关字母时仍视为开关（如 /c:/x 已排除）
  if (segs.length === 2 && /^[A-Za-z]$/.test(first) && process.platform === 'win32') return false;
  return true;
}

// 从命令中提取「真实绝对路径」集合（供审批与权限规则共同使用）
function extractPaths(cmd) {
  const out = [];
  for (const tok of splitArgs(cmd)) {
    // 去掉 --C:\x / =/abs 这类引导符后再判定
    const probe = tok.replace(/^[-/=]{1,2}(?=[A-Za-z]:[\\/])/, '');
    if (!looksLikePathToken(probe)) continue;
    out.push(probe);
  }
  return out;
}

// ---------- 判定 ----------
// ctx: { tool, command?, paths: [已解析绝对路径], keywords: [参数文本...] }
// 返回 { verdict: 'deny'|'allow'|null, rule?, hits: [] }
function evaluate(ctx) {
  const list = rules();
  const hits = [];
  for (const r of list) {
    let hit = false;
    if (r.kind === 'tool') {
      hit = matchOne(r, ctx.tool, 'tool');
    } else if (r.kind === 'command') {
      if (!ctx.command) continue;
      if (r.match === 'exact' || r.match === 'prefix') hit = matchOne({ ...r }, commandSubject(ctx.command), 'command');
      else hit = matchOne(r, ctx.command, 'command');
    } else if (r.kind === 'path') {
      for (const p of ctx.paths || []) { if (matchOne(r, p, 'path')) { hit = true; break; } }
    } else if (r.kind === 'keyword') {
      const bag = (ctx.keywords || []).join('\n') + (ctx.command ? '\n' + ctx.command : '');
      hit = matchOne(r, bag, 'keyword');
    }
    if (!hit) continue;
    hits.push(r);
    if (r.list === 'black') return { verdict: 'deny', rule: r, hits };
    if (r.list === 'white') return { verdict: 'allow', rule: r, hits };
  }
  return { verdict: null, hits };
}

function validateRule(body) {
  const kind = String(body?.kind || '');
  const list = String(body?.list || 'black');
  const match = String(body?.match || 'contains');
  const pattern = String(body?.pattern || '').trim();
  if (!KINDS.includes(kind)) return { error: `规则类型无效（${KINDS.join('/')}）` };
  if (!LISTS.includes(list)) return { error: '名单类型无效（black/white）' };
  if (!MATCHES.includes(match)) return { error: `匹配方式无效（${MATCHES.join('/')}）` };
  if (!pattern) return { error: '规则内容不能为空' };
  if (pattern.length > 500) return { error: '规则内容过长（≤500 字符）' };
  if (match === 'regex') { try { new RegExp(pattern); } catch (e) { return { error: `正则表达式无效：${e.message}` }; } }
  return { value: { kind, list, match, pattern, note: String(body?.note || '').substring(0, 200), enabled: body?.enabled === 0 ? 0 : 1 } };
}

// 供设置页「试跑」：给定工具/命令/路径，返回命中结果
function test({ tool, command, paths, keywords }) {
  const allPaths = [...(paths || [])];
  if (command) {
    for (const p of extractPaths(command)) {
      try { allPaths.push(path.resolve(p)); } catch (e) { allPaths.push(p); }
    }
  }
  const ev = evaluate({ tool: tool || '', command: command || '', paths: allPaths, keywords: keywords || [] });
  return { verdict: ev.verdict, rule: ev.rule || null, paths: allPaths };
}

module.exports = {
  KINDS, LISTS, MATCHES,
  reload, rules, evaluate, validateRule, test,
  splitArgs, extractPaths, looksLikePathToken, commandSubject, normPath
};
