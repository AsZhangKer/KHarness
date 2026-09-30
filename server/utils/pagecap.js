// 长文本进上下文前的「预算 + 落盘 + 续取」层。
//
// 为什么要有这一层：网页正文（web_fetch / browser_text）是上下文暴涨最快的那一路，
// 一篇百科正文一次能灌进来三万 tok。而工具的返回**不回灌跨轮上文**，所以真正撑爆的是
// 「同一轮里连着读几个大页面」。解法不是砍成一小段让它看不全，而是：
//   预算内 → 原样返回；超预算 → 全文落盘，只回前 N 字 + 「还剩多少、怎么接着取」。
// 截断必须可发现、可续取，否则模型会拿残缺内容当全量下结论（这条沿用 glob/run_command 的 capNote 语式）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('../config');
const { estimateTokens } = require('./agentsmd');

const CACHE_DIR = path.join(DATA_DIR, 'web-cache');
// 单段返回的默认预算（字符）。8000 字 ≈ 中文 4800 tok / 英文 2000 tok 量级，
// 一轮里读五六个大页面也不会把窗口吃掉一半。
const DEFAULT_CAP = 8000;
const CACHE_TTL_MS = 30 * 60 * 1000;   // 续取用的缓存留 30 分钟，过期就重新抓

function keyOf(prefix, id) {
  return path.join(CACHE_DIR, crypto.createHash('sha1').update(String(prefix) + '|' + String(id)).digest('hex').slice(0, 32) + '.txt');
}

function writeCache(prefix, id, text) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const f = keyOf(prefix, id);
    fs.writeFileSync(f, String(text || ''), 'utf8');
    return f;
  } catch (e) {
    return null;   // 落盘失败不影响主流程，只是不能续取
  }
}

function readCache(prefix, id) {
  try {
    const f = keyOf(prefix, id);
    const st = fs.statSync(f);
    if (Date.now() - st.mtimeMs > CACHE_TTL_MS) return null;
    return { file: f, text: fs.readFileSync(f, 'utf8') };
  } catch (e) {
    return null;
  }
}

/**
 * 按预算切一段。offset 是**字符偏移**，续取时原样传回来即可。
 * 返回 { text, note, offset, next, total, more, file }，note 为空表示没截断。
 */
function windowOf(full, { offset = 0, cap = DEFAULT_CAP, prefix = 'page', key = '', keepCache = true } = {}) {
  const all = String(full || '');
  const start = Math.max(0, Math.min(Number(offset) || 0, all.length));
  const slice = all.slice(start, start + cap);
  const next = start + slice.length;
  const more = next < all.length;
  let file = '';
  if (more && keepCache) file = writeCache(prefix, key || all.slice(0, 400), all);
  const tokens = Math.round(estimateTokens(slice));
  let note = '';
  if (start > 0 || more) {
    note = `\n…（本段第 ${start + 1}–${next} 字，全文 ${all.length} 字、约 ${Math.round(estimateTokens(all))} tok`
      + (more ? `，还剩 ${all.length - next} 字：把 offset=${next} 传回来继续取` : '，已到末尾');
    if (file) note += `；全文已存 ${file}`;
    note += '）';
  }
  return { text: slice + note, raw: slice, note, offset: start, next, total: all.length, more, file, tokens };
}

module.exports = { CACHE_DIR, DEFAULT_CAP, CACHE_TTL_MS, estimateTokens, windowOf, writeCache, readCache, keyOf };
