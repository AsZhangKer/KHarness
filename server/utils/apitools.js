// 外部 API 工具注册表：把桌面《API文档》里实测过的接口做成 AI 可调用的工具
// 每个工具默认关闭，需在「设置 → 外部 API 工具」里手动启用；启用后才注入工具列表与系统提示词
// 注册表是数据驱动的：新增工具只需往 TOOLS 里加一条（含 schema / 配置项 / run 实现）
// 各工具的 run 都按文档里的「实测坑点」写：不发送无效参数、不信任回显、错误体形态逐家适配
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { fetch } = require('undici');
const toolgate = require('./toolgate');
// 持久化与开关状态由 toolgate 统一托管，这里只取两个读函数
const configOf = (name) => toolgate.configOf(name);
const noteCall = (name) => toolgate.noteCall(name);

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = path.join(__dirname, '..', 'data');
const UAPI = 'https://uapis.cn';
const XJL = 'https://api.xunjinlu.fun';

// ============================================================
// 通用助手：请求、错误体解析、缓存、格式化
// ============================================================

// 同一站内至少 5 种错误体：{code,message} / {code,error} / {details,error} / {error} / {code:数字,message}
function errText(d) {
  if (!d) return '';
  if (typeof d === 'string') return d;
  const code = typeof d.code === 'string' ? `[${d.code}] ` : '';
  const details = d.details && typeof d.details === 'object' ? (d.details.message || '') : '';
  return (code + String(d.message || d.error || details || '').trim()).trim();
}

function apiUrl(base, params) {
  const parts = [];
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`); // 空格编成 %20，不用 +（worldtime 会把 + 解成空格）
  }
  return parts.length ? base + (base.includes('?') ? '&' : '?') + parts.join('&') : base;
}

// opts: { label, url, method, json, form:{body,contentType}, headers, timeoutMs }
async function httpCall(opts) {
  const timeoutMs = Math.max(3000, Number(opts.timeoutMs) || 20000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers = Object.assign({ accept: 'application/json' }, opts.headers || {});
  let body = opts.body;
  if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
  if (opts.form) { headers['Content-Type'] = opts.form.contentType; body = opts.form.body; }
  let resp;
  let text = '';
  try {
    resp = await fetch(opts.url, { method: opts.method || 'GET', headers, body, signal: ctrl.signal, redirect: 'follow' });
    text = await resp.text();
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) {
      return { error: `${opts.label}:请求超时（${Math.round(timeoutMs / 1000)} 秒），上游可能正在抓取目标或排队`, timedOut: true };
    }
    return { error: `${opts.label}:${String(e.message || e).substring(0, 200)}` };
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  let isJson = false;
  try { data = JSON.parse(text); isJson = true; } catch (e) { /* 非 JSON（如 413 的 nginx 页）由调用方处理 */ }
  if (!resp.ok) {
    const detail = isJson ? errText(data) : text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return { error: `${opts.label}:HTTP ${resp.status}${detail ? ' ' + String(detail).substring(0, 240) : ''}`, status: resp.status, data, text };
  }
  return { status: resp.status, data, text, headers: resp.headers };
}

function timeoutSeconds(cfg, def) {
  const n = Number(cfg && cfg.timeout_seconds);
  return (Number.isFinite(n) && n >= 3 ? n : def) * 1000;
}

function hkey(name, o) { return crypto.createHash('sha1').update(name + '|' + JSON.stringify(o)).digest('hex'); }

function cachedRun(name, keyObj, minutes, produce) {
  const cached = cacheGet(hkey(name, keyObj), minutes);
  if (cached) return Promise.resolve({ output: cached + `\n（以上来自本地缓存（${minutes} 分钟内未重复请求），未消耗积分）` });
  return Promise.resolve(produce()).then(r => {
    if (r && r.output) cacheSet(hkey(name, keyObj), r.output, minutes);
    return r;
  });
}

function cleanUrlish(s) {
  let t = String(s || '').trim().replace(/^["'<]+|["'>]+$/g, '');
  if (!t) return '';
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(t)) t = 'https://' + t; // 服务端不会自动补协议
  return t;
}

function httpsUrl(s) { return String(s || '').replace(/^http:\/\//, 'https://'); }

function cleanText(s, max) {
  let t = String(s || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
  const cap = max || 320;
  if (t.length > cap) t = t.substring(0, cap) + '…';
  return t;
}

// front-matter 正文只留有用部分
function cleanFull(s) {
  let t = String(s || '').replace(/^---[\s\S]*?---\s*/, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (t.length > 3000) t = t.substring(0, 3000) + '\n…（正文已截断）';
  return t;
}

function trunc(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.substring(0, n) + '…' : t;
}

// 只输出非 null/undefined 行；显式传空串表示一个空行
function out(...lines) { return lines.filter(l => l !== null && l !== undefined).join('\n'); }
function f(label, v) { return (v === null || v === undefined || v === '') ? null : `${label}：${v}`; }
function arr(v) { return Array.isArray(v) ? v : []; }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
// "29.0" / "47%" / "高温 27℃" / 17 → 数字
function numFrom(v) {
  if (typeof v === 'number') return v;
  const m = String(v == null ? '' : v).match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function fmtCn(unixSec) { // 秒 → 北京时间文本（B站/中国天气类字段均为北京时间）
  const n = Number(unixSec);
  if (!Number.isFinite(n) || n <= 0) return '';
  return new Date(n * 1000 + 8 * 3600000).toISOString().substring(0, 16).replace('T', ' ');
}
function fmtIso(s) { return s ? String(s).replace('T', ' ').substring(0, 16) : ''; }
function fmtDur(sec) {
  const n = Number(sec) || 0;
  const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), s = n % 60;
  return h ? `${h}小时${m}分` : `${m}:${String(s).padStart(2, '0')}`;
}
function fmtBytes(b) {
  const n = Number(b) || 0;
  if (n > 1048576) return (n / 1048576).toFixed(1) + 'MB';
  if (n > 1024) return (n / 1024).toFixed(1) + 'KB';
  return n + 'B';
}
function offsetLabel(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n)) return '';
  const sign = n < 0 ? '-' : '+';
  const a = Math.abs(n);
  const h = Math.floor(a / 3600), m = Math.round((a % 3600) / 60);
  return `UTC${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
function yesNo(v) { return v ? '是' : '否'; }

// multipart/form-data：手工拼边界，避免 undici 版本差异导致的 FormData 实例判定失败
function multipart(fields) {
  const b = '----KhArness' + crypto.randomBytes(10).toString('hex');
  const parts = [];
  for (const fl of fields) {
    const disp = `form-data; name="${fl.name}"` + (fl.filename ? `; filename="${fl.filename.replace(/"/g, '')}"` : '');
    parts.push(Buffer.from(`--${b}\r\nContent-Disposition: ${disp}\r\n` + (fl.filename ? 'Content-Type: application/octet-stream\r\n' : '') + '\r\n', 'utf8'));
    parts.push(Buffer.isBuffer(fl.value) ? fl.value : Buffer.from(String(fl.value), 'utf8'));
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from(`--${b}--\r\n`, 'utf8'));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${b}` };
}

// 本地图片路径：仅当用户在配置里显式允许，且 realpath 后仍在项目根内
async function safeLocalPath(raw) {
  const p = path.resolve(String(raw || ''));
  const real = await fsp.realpath(p);
  const root = await fsp.realpath(PROJECT_ROOT);
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error('路径越出项目根目录，已拒绝读取');
  const st = await fsp.stat(real);
  if (!st.isFile()) throw new Error('目标不是文件');
  return { file: real, size: st.size, name: path.basename(real) };
}

// 简易节流（QQ 查询这类 2 次/分钟的接口用）：返回需要等待的秒数，0 表示可以调用
const rateState = new Map();
function rateWait(name, seconds) {
  const now = Date.now();
  const hit = rateState.get(name);
  if (hit && now - hit < seconds * 1000) return Math.ceil((seconds * 1000 - (now - hit)) / 1000);
  return 0;
}
function rateMark(name) { rateState.set(name, Date.now()); }

// ---------- 结果缓存（服务端大多不缓存，本地按参数键缓存以省积分） ----------
const cache = new Map(); // key -> { at, text }
function cacheGet(key, minutes) {
  if (!minutes) return null;
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > minutes * 60000) { cache.delete(key); return null; }
  return hit.text;
}
function cacheSet(key, text, minutes) {
  if (!minutes) return;
  if (cache.size > 400) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  cache.set(key, { at: Date.now(), text });
}

// ============================================================
// SearXNG（自建）· 聚合网页搜索
// 文档：SearXNG API 接入文档 v1.0（2026-09-23）；下列行为均为对本机 192.168.1.100:18888 实测所得
//   · 全引擎聚合一次 20s 左右（多数引擎超时），限定 engines=bing 约 0.4s → 默认只走 bing
//   · timeout_limit 能把等待时间压到指定秒数（实测 6s 给 14 条）
//   · pageno=2 / time_range=week|month 在实测中直接返回 0 条（不报错），所以不暴露给模型
//   · 显式传 categories（哪怕是默认 general）会让 engines 限定失效：0.4s → 20s，故 general 不发
//   · q 里的 site: / filetype: 操作符不被引擎采纳（与不带时结果域完全相同），所以不暴露
//   · format 不在 settings.yml 的 formats 里时返回 HTML 而不是错误 → 必须自己判 JSON
//   · 未声明的引擎会进 unresponsive_engines，用来解释「为什么只有这么几条」
// ============================================================
const SEARX_DEFAULT = 'http://127.0.0.1:18888';

async function runWebSearch(args) {
  const cfg = configOf('web_search');
  const query = String(args?.query || '').trim();
  if (!query) return { error: 'web_search:query 不能为空' };

  let want = parseInt(args?.max_results);
  if (!Number.isInteger(want) || want < 1) want = Number(cfg.default_max_results) || 8;
  want = Math.min(want, 25);

  const base = String(cfg.base_url || SEARX_DEFAULT).replace(/\/+$/, '');
  const language = String(args?.language || cfg.language || 'zh-CN').trim();
  const categories = String(args?.categories || cfg.categories || 'general').trim();
  const engines = String(args?.engines || cfg.default_engines || 'bing').trim();
  let safesearch = parseInt(cfg.safesearch);
  if (!Number.isInteger(safesearch) || safesearch < 0 || safesearch > 2) safesearch = 1;
  let tLimit = Number(cfg.timeout_limit) || 12;
  tLimit = Math.min(Math.max(tLimit, 3), 30);

  const params = { q: query, format: 'json', language, engines, safesearch, timeout_limit: tLimit };
  // 实测大坑：一旦显式传 categories（哪怕就是默认的 general），engines 限定就失效，
  // 会去跑该分类下的全部引擎 —— 0.4s 变 20s、8 个引擎超时。所以 general 一律不发。
  if (categories && categories.toLowerCase() !== 'general') params.categories = categories;
  const cacheKey = hkey('web_search', params);
  const cacheMinutes = Number(cfg.cache_minutes) || 0;
  const cached = cacheGet(cacheKey, cacheMinutes);
  if (cached) return { output: cached + '\n（以上为本地缓存结果，未重复请求）' };

  const r = await httpCall({
    label: 'web_search', url: apiUrl(`${base}/search`, params), method: 'GET',
    timeoutMs: (tLimit + 8) * 1000
  });
  if (r.error) {
    if (r.status === 429) return { error: 'web_search:SearXNG 限流（limiter 已开启，同一 IP 高频会被拒 429）。请降低调用频率或把自己 IP 加进 limiter.toml 的 pass_ip。' };
    return { error: r.error + `（服务地址 ${base}；若 SearXNG 容器没起来会是这种连接错误）` };
  }
  const data = r.data;
  if (!data || typeof data !== 'object' || !Array.isArray(data.results)) {
    // format=json 没在 settings.yml 的 search.formats 里声明时，上游会当网页返回 HTML
    return { error: `web_search:返回不是 JSON（多半是 settings.yml 的 search.formats 里没写 json）。前 200 字：${String(r.text || '').replace(/\s+/g, ' ').substring(0, 200)}` };
  }
  noteCall('web_search');
  const raw = arr(data.results);
  const dead = arr(data.unresponsive_engines).map(x => Array.isArray(x) ? `${x[0]}(${x[1]})` : String(x));
  if (!raw.length) {
    return { output: `搜索「${query}」返回 0 条结果（引擎：${engines}${dead.length ? `；无响应引擎：${dead.slice(0, 6).join('、')}` : ''}）。可换关键词或放宽 engines 重试一次。` };
  }

  // SearXNG 的 results 不按 score 稳定降序，且多引擎会给出重复 URL → 本地按 score 重排 + URL 去重 + 截取
  const seen = new Set();
  const items = raw.slice()
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
    .filter(x => { const u = String(x.url || ''); if (!u || seen.has(u)) return false; seen.add(u); return true; })
    .slice(0, want);

  const lines = [`搜索「${query}」（SearXNG，引擎 ${engines}，语言 ${language}）：上游给 ${raw.length} 条${data.number_of_results ? `（估算总数 ${data.number_of_results}）` : ''}，去重取前 ${items.length} 条。`];
  items.forEach((x, i) => {
    let dom = '';
    try { dom = new URL(x.url).hostname.replace(/^www\./, ''); } catch (e) { dom = ''; }
    const meta = [dom, x.engine, x.publishedDate ? String(x.publishedDate).substring(0, 10) : null, x.score != null ? `score ${x.score}` : null].filter(Boolean).join(' · ');
    lines.push('', `${i + 1}. ${cleanText(x.title, 160)}`, `   ${String(x.url || '')}`, meta ? `   ${meta}` : null, cleanText(x.content || x.snippet, 320) ? `   ${cleanText(x.content || x.snippet, 320)}` : null);
  });
  const answers = arr(data.answers);
  const infoboxes = arr(data.infoboxes);
  if (answers.length) lines.push('', `直接答案：${cleanText(JSON.stringify(answers[0]), 300)}`);
  else if (infoboxes.length) lines.push('', `信息框：${cleanText(String(infoboxes[0].content || infoboxes[0].infobox || ''), 300)}`);
  if (dead.length) lines.push('', `本次无响应/被跳过的引擎：${dead.slice(0, 8).join('、')}（结果偏少通常是它们造成的，不是「网上没有」）`);
  lines.push('', '（注：本接口实测翻页 pageno≥2 与 time_range 都会返回 0 条，别尝试翻页；要某条正文用 web_fetch 打开它的 URL。想扩大来源可传 engines，如 "bing,google"，但会慢很多。）');
  const o = lines.filter(x => x !== null).join('\n');
  cacheSet(cacheKey, o, cacheMinutes);
  return { output: o };
}

// ============================================================
// UApi · Minecraft 版本 / Mod 搜索
// ============================================================
async function runMcVersion() {
  const cfg = configOf('mc_version');
  return cachedRun('mc_version', {}, Number(cfg.cache_minutes) || 0, async () => {
    const r = await httpCall({ label: 'mc_version', url: `${UAPI}/api/v1/game/minecraft/version`, timeoutMs: timeoutSeconds(cfg, 15) });
    if (r.error) return { error: r.error };
    const d = r.data || {};
    noteCall('mc_version');
    const same = d.release && d.snapshot && d.release === d.snapshot;
    return {
      output: out(
        'Minecraft 最新版本（数据源为上游 Mojang）：',
        f('最新正式版 release', `${d.release || '—'}${d.release_time ? `（发布 ${fmtIso(d.release_time)} UTC）` : ''}`),
        same ? '最新快照号与正式版相同：这是刚发正式版时的正常现象，不是"下一个开发版"' : f('最新快照 snapshot', `${d.snapshot || '—'}${d.snapshot_time ? `（发布 ${fmtIso(d.snapshot_time)} UTC）` : ''}`),
        '',
        '注意：版本号是不透明字符串（如 26.3、1.21.10），1.21.10 在 MC 排序里小于 1.21.9，禁止按数值或 semver 比较；需要判断更新请比对历史版本号字符串。',
        '该接口在 HTTP 层禁用缓存（no-store），重复问同一件事靠本工具的本地缓存省积分。要全量版本表请用 web_fetch 取 Mojang 的 version_manifest_v2.json。'
      )
    };
  });
}

const MOD_TYPES = ['mod', 'plugin'];
async function runMcMods(args) {
  const cfg = configOf('mc_mods');
  const query = String(args?.query || args?.q || '').trim();
  if (!query) return { error: 'mc_mods:query 不能为空（缺少它会直接 400）' };
  const source = ['all', 'modrinth', 'spigotmc'].includes(String(args?.source || '').trim().toLowerCase()) ? String(args.source).trim().toLowerCase() : 'all';
  let type = String(args?.type || '').trim().toLowerCase();
  let droppedType = '';
  if (type && !MOD_TYPES.includes(type)) { droppedType = type; type = ''; } // 未知 type 会静默返回空结果，白白花 2 积分
  let limit = parseInt(args?.limit);
  if (!Number.isInteger(limit) || limit < 1) limit = Number(cfg.default_limit) || 10;
  limit = Math.min(limit, 50);
  const enrich = /^(false|0|no|否)$/i.test(String(args?.enrich ?? '')) ? false : !!cfg.enrich_default;

  const params = { query, source, limit, enrich };
  if (type) params.type = type;
  return cachedRun('mc_mods', params, Number(cfg.cache_minutes) || 0, async () => {
    const r = await httpCall({ label: 'mc_mods', url: apiUrl(`${UAPI}/api/v1/game/minecraft/mods`, params), timeoutMs: timeoutSeconds(cfg, 25) });
    if (r.error) return { error: r.error };
    const d = r.data || {};
    noteCall('mc_mods');
    // results / sources 是 null 而不是 []
    const results = arr(d.results);
    const srcs = arr(d.sources).map(s => (typeof s === 'string' ? s : `${s && s.name}:${s && s.result_count}`)).join(' ');
    if (!results.length) {
      return {
        output: out(
          `Minecraft 资源搜索「${query}」${type ? `（type=${type}）` : ''}：total=${d.total ?? 0}，无结果。`,
          srcs ? `来源：${srcs}` : null,
          droppedType ? `提示：你传的 type=${droppedType} 不是 mod/plugin，服务端对未知取值会静默返回空结果——这次很可能是这个原因，去掉 type 重试比换关键词有效。` : null,
          '若确认无结果，可换英文名或更短的关键词再试一次（每次 2 积分，别连着试）。'
        )
      };
    }
    const seen = new Set();
    const rows = results.filter(x => {
      const k = String(x.name || '').toLowerCase();
      if (!k || seen.has(k)) return false; // SpigotMC 会给同名重复项
      seen.add(k);
      return true;
    }).slice(0, limit);
    const lines = [`Minecraft 资源搜索「${query}」：total=${d.total ?? results.length}，去重后取 ${rows.length} 条${type ? `（type=${type}）` : ''}。`];
    rows.forEach((x, i) => {
      const gv = arr(x.game_versions);
      lines.push('', `${i + 1}. ${trunc(x.name, 90)} [${x.source || '?'}${x.project_type ? '/' + x.project_type : ''}]`,
        `   ${x.page_url || '（无 page_url）'}`,
        x.download_url ? `   下载：${x.download_url}` : null,
        `   ${[x.author ? `作者 ${x.author}` : null, x.downloads != null ? `下载 ${x.downloads}` : null,
          gv.length ? `支持版本 ${gv.slice(0, 6).join(',')}${gv.length > 6 ? `…共${gv.length}个` : ''}` : null,
          arr(x.categories).length ? `标签 ${arr(x.categories).join('/')}` : null].filter(Boolean).join(' · ')}`,
        x.description ? `   ${cleanText(x.description, 200)}` : null);
    });
    lines.push('', '说明：project_type 与服务端 type 不保证一致，需要按类型过滤时请在结果里自行判断；icon 字段常缺失，未列出。');
    return { output: lines.filter(x => x !== null).join('\n') };
  });
}

// ============================================================
// UApi · 世界时间
// ============================================================
// 裸名多词城市服务端一律 404（IANA 名带大洲前缀，无法从城市名推导），内置几个常见写法
const ZONE_ALIASES = {
  'new york': 'America/New_York', 'los angeles': 'America/Los_Angeles', 'chicago': 'America/Chicago',
  'boston': 'America/New_York', 'washington': 'America/New_York', 'hong kong': 'Asia/Hong_Kong',
  'ho chi minh': 'Asia/Ho_Chi_Minh', 'buenos aires': 'America/Argentina/Buenos_Aires',
  'kolkata': 'Asia/Kolkata', 'new delhi': 'Asia/Kolkata', 'sao paulo': 'America/Sao_Paulo',
  'urumqi': 'Asia/Urumqi'
};

async function runWorldTime(args) {
  const cfg = configOf('world_time');
  let city = String(args?.city || args?.timezone || '').trim();
  if (!city) return { error: 'world_time:city 不能为空（缺失或空串都会 400）' };
  if (/[^\x00-\x7f]/.test(city)) return { error: `world_time:不支持中文城市名（「${city}」会 404）。请改用 IANA 时区名，如 Asia/Shanghai、America/New_York、Europe/London。` };
  city = city.replace(/\s+/g, '_'); // 空格永不自动转换，且 query 里的 + 会被解成空格
  const alias = ZONE_ALIASES[city.replace(/_/g, ' ').toLowerCase()];
  if (alias && !city.includes('/')) city = alias;
  return cachedRun('world_time', { city }, Number(cfg.cache_minutes) || 0, async () => {
    const r = await httpCall({ label: 'world_time', url: apiUrl(`${UAPI}/api/v1/misc/worldtime`, { city }), timeoutMs: timeoutSeconds(cfg, 15) });
    if (r.error) {
      if (/HTTP 404/.test(r.error)) {
        return { error: `world_time:时区「${city}」不存在（TIMEZONE_NOT_FOUND）。完整形如 Continent/City 且大小写敏感（Asia/Shanghai 可以，asia/shanghai 不行）；多词城市用下划线（America/New_York）；UTC/GMT 需全大写。常见城市裸名（Shanghai、Tokyo、London）可用但列表不全。` };
      }
      return { error: r.error };
    }
    const d = r.data || {};
    noteCall('world_time');
    const offSec = num(d.offset_seconds);
    const unix = num(d.timestamp_unix);
    const utcIso = unix ? new Date(unix * 1000).toISOString().replace('T', ' ').substring(0, 16) + ' UTC' : '';
    return {
      output: out(
        `${d.timezone || city} 当前时间：${d.datetime || '—'}（${d.weekday || ''}）`,
        `UTC 偏移：${offsetLabel(offSec)}${offSec != null ? `（offset_seconds=${offSec}）` : ''}`,
        utcIso ? `同一时刻的 UTC：${utcIso}（timestamp_unix=${unix}）` : null,
        `与北京时间（UTC+8）相差：${offSec != null ? (offSec / 3600 - 8) + ' 小时' : '—'}`,
        '',
        `接口原样回显 query=${d.query}；datetime 不带时区后缀，别 new Date() 它；offset_string 会丢掉分钟位（印度显示 UTC5 实为 UTC+05:30），本输出已按 offset_seconds 重算。该接口免费。`
      )
    };
  });
}

// ============================================================
// UApi · WHOIS
// ============================================================
function normalizeDomain(raw) {
  let t = String(raw || '').trim().toLowerCase();
  if (!t) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(t)) { try { t = new URL(t).hostname; } catch (e) { return ''; } }
  else t = t.split('/')[0].split('?')[0].trim();
  t = t.replace(/\.+$/, '');
  if (t.startsWith('www.')) t = t.substring(4);
  return /^[a-z0-9\u00e0-\u00ff][a-z0-9\u00e0-\u00ff-]*(\.[a-z0-9\u00e0-\u00ff-]+)+$/.test(t) ? t : '';
}

const UNREG_RE = /(^|\n)\s*(no match|not found|no data found|the domain .* is free|available for registration|no object found|status: 0)/i;

async function runWhois(args) {
  const cfg = configOf('whois_query');
  const domain = normalizeDomain(args?.domain);
  if (!domain) return { error: `whois_query:域名不合法：「${trunc(args?.domain, 60)}」。请填写注册域名（如 example.com，不要带协议、路径或空格）。本地校验不通过不花积分，服务端不校验、会照样计费并慢到十几秒。` };
  const fmtArg = String(args?.format || '').trim().toLowerCase();
  const wantJson = fmtArg ? !/^(text|raw|原文|false|0|no)$/.test(fmtArg) : !!cfg.prefer_json;
  return cachedRun('whois_query', { domain, wantJson }, Number(cfg.cache_minutes) || 0, async () => {
    // 服务端缓存键只看 domain，不含 format：先查 json，拿不到结构化再按需查 text 也是同一份缓存
    const r = await httpCall({
      label: 'whois_query',
      url: apiUrl(`${UAPI}/api/v1/network/whois`, Object.assign({ domain }, wantJson ? { format: 'json' } : {})),
      timeoutMs: timeoutSeconds(cfg, 45)
    });
    if (r.error) return { error: r.error };
    noteCall('whois_query');
    const w = (r.data || {}).whois;
    if (typeof w === 'string' || !w || typeof w !== 'object') {
      const text = typeof w === 'string' ? w : JSON.stringify(r.data || {});
      const unreg = UNREG_RE.test(text);
      return {
        output: out(
          `域名 ${domain} WHOIS（原文${wantJson ? '，服务端未能结构化为 JSON' : ''}）：`,
          unreg ? `判定：未注册 / 无匹配记录（这是一个结果，不是错误；本次仍计 2 积分）` : null,
          '',
          trunc(text.replace(/%([^\n]{0,200})/g, '$1'), cfg.raw_chars || 2600)
        )
      };
    }
    const dm = w.domain || {};
    const g = k => (w[k] && typeof w[k] === 'object' ? w[k] : null);
    const reg = g('registrar'); const res = g('registrant'); const tech = g('technical');
    const dates = [
      f('创建 created_date', fmtIso(dm.created_date)),
      f('更新 updated_date', fmtIso(dm.updated_date)),
      f('到期 expiration_date', fmtIso(dm.expiration_date)) + (dm.expiration_date ? '（UTC）' : '')
    ];
    return {
      output: out(
        `域名 ${dm.domain || domain} 的 WHOIS 信息：`,
        ...dates,
        f('注册状态 status', arr(dm.status).join(' | ') || ''),
        f('域名服务器', arr(dm.name_servers).join(', ')),
        f('whois 服务器', dm.whois_server),
        dm.dnssec != null ? f('DNSSEC', yesNo(dm.dnssec)) : null,
        reg ? f('注册商', [reg.name, reg.id && `(ID ${reg.id})`, reg.referral_url].filter(Boolean).join(' ')) : null,
        reg && (reg.phone || reg.email) ? `注册商联系：${[reg.phone, reg.email].filter(Boolean).join(' ')}` : null,
        res ? `注册人/机构：${[res.organization, res.country].filter(Boolean).join('，') || '（隐私保护，未给出）'}` : null,
        tech && tech.email ? `技术联系：${tech.email}` : null,
        '',
        dm.punycode && dm.punycode !== dm.domain ? `IDN punycode：${dm.punycode}` : null,
        '已忽略 *_date_in_time 冗余键；REDACTED / Statutory Masking 一类占位符表示注册人信息被隐私保护遮蔽，不是真实姓名。'
      )
    };
  });
}

// ============================================================
// UApi · GitHub 仓库
// ============================================================
async function runGithubRepo(args) {
  const cfg = configOf('github_repo');
  const raw = String(args?.repo || args?.github_repo || '').trim();
  const m = raw.match(/github\.com\/([^/]+\/[^/]+)/i);
  let repo = (m ? m[1] : raw).replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    return { error: `github_repo:repo 格式应为 owner/repo（收到「${trunc(raw, 60)}」）。本地格式校验不通过不花积分；仓库不存在或无权访问时是 404 且照样扣 2 积分，别拿它探测私有库。` };
  }
  return cachedRun('github_repo', { repo }, Number(cfg.cache_minutes) || 0, async () => {
    const r = await httpCall({ label: 'github_repo', url: apiUrl(`${UAPI}/api/v1/github/repo`, { repo }), timeoutMs: timeoutSeconds(cfg, 30) });
    if (r.error) {
      if (/HTTP 404/.test(r.error)) return { error: `github_repo:仓库不存在或不可访问（REPOSITORY_NOT_FOUND）：${repo}。私有仓库与不存在的仓库返回同一个 404，本次仍扣 2 积分。确认 owner/repo 拼写后再试。` };
      return { error: r.error };
    }
    const d = r.data || {};
    noteCall('github_repo');
    const bots = [];
    const humans = arr(d.maintainers).filter(x => {
      const login = String(x.login || '');
      if (/\[bot\]$/i.test(login)) { bots.push(login); return false; }
      return true;
    });
    const langs = Object.entries(d.languages || {}).sort((a, b) => (b[1] || 0) - (a[1] || 0)).slice(0, 6)
      .map(([k, v]) => `${k} ${fmtBytes(v)}`).join('、');
    const rel = d.latest_release; // 注意：没有 Release 时这个键根本不存在（不是 null）
    return {
      output: out(
        `${d.full_name || repo}`,
        d.description ? `简介：${cleanText(d.description, 240)}` : '简介：（仓库无 description）',
        [d.stargazers != null ? `★${d.stargazers}` : null, `fork ${d.forks ?? '—'}`,
          `开放 issue ${d.open_issues ?? '—'}（含 PR）`, `订阅 ${d.watchers ?? '—'}`].filter(Boolean).join(' · '),
        f('语言', `${d.language || '（无语言文件）'}${langs ? `；明细：${langs}` : ''}`),
        f('话题', arr(d.topics).join(', ')),
        f('协议 license', `${d.license || '（未声明）'}（这是显示名如 "MIT License"，不是 SPDX 标识）`),
        f('分支', `${d.default_branch || '—'} @ ${String(d.default_branch_sha || '').substring(0, 8)}`),
        f('状态', `${d.visibility || 'public'}${d.archived ? ' · 已归档' : ''}${d.disabled ? ' · 已禁用' : ''}${d.fork ? ' · 是 fork' : ''}`),
        f('主页', httpsUrl(d.homepage)),
        f('最近推送 pushed_at', fmtIso(d.pushed_at) + ' UTC'),
        f('创建时间 created_at', fmtIso(d.created_at)),
        rel ? `最新 Release：${rel.tag_name}${rel.name && rel.name !== rel.tag_name ? `（${trunc(rel.name, 60)}）` : ''} · ${fmtIso(rel.published_at)}${rel.prerelease ? ' · 预发布' : ''}${rel.draft ? ' · 草稿' : ''}\n   ${rel.html_url || ''}\n   （这是"时间最新"的一条，monorepo 里常是某个子包的 Release（如 create-vite@x），要核心包版本请按标签前缀自己筛）` : '最新 Release：无（该键在无 Release 时不存在，不代表接口异常）',
        humans.length ? `维护者（来自提交记录）：${humans.slice(0, Number(cfg.max_maintainers) || 8).map(x => x.login || x.name).join('、')}${humans.length > 8 ? ` 等 ${humans.length} 人` : ''}` : null,
        bots.length ? `（已过滤 CI 机器人：${bots.join('、')}）` : null,
        '',
        d.updated_at ? `注意：updated_at（${fmtIso(d.updated_at)}）会被 fork/star 等元数据变动刷新，判断"最近有无更新"只看 pushed_at；collaborators 恒为 null（上游无令牌取不到）未列出；open_issues 含 PR。` : null
      )
    };
  });
}

// ============================================================
// UApi · B站：视频 / 直播间 / 投稿
// ============================================================
async function runBiliVideo(args) {
  const cfg = configOf('bili_video');
  let bvid = String(args?.bvid || '').trim();
  let aid = String(args?.aid || '').trim();
  if (bvid) {
    const mv = bvid.match(/BV[0-9A-Za-z]{10}/);
    bvid = mv ? mv[0] : '';
    if (!bvid) return { error: 'bili_video:bvid 形如 BV17x411w79F（BV + 10 位），收到值不合法。本地校验不通过不花积分。' };
  }
  if (aid && !/^\d+$/.test(aid)) return { error: 'bili_video:aid 只能是数字（AV 号后面的数字部分）。' };
  if (!bvid && !aid) return { error: 'bili_video:需要提供 bvid 或 aid 之一（都为空时 400，不扣积分）。' };
  const qs = bvid ? { bvid } : { aid }; // 同时传时服务端只看 bvid，这里直接只发一个
  return cachedRun('bili_video', qs, Number(cfg.cache_minutes) || 0, async () => {
    const r = await httpCall({ label: 'bili_video', url: apiUrl(`${UAPI}/api/v1/social/bilibili/videoinfo`, qs), timeoutMs: timeoutSeconds(cfg, 25) });
    if (r.error) {
      if (/HTTP 404/.test(r.error)) return { error: `bili_video:视频不存在或已删除（${bvid || 'AV' + aid}）。注意：404 也扣 4 积分，别用它批量探测。` };
      return { error: r.error };
    }
    const d = r.data || {};
    noteCall('bili_video');
    if (!d.bvid && !d.aid) return { output: 'bili_video:上游返回了 200 但没有视频字段，可能是空结果（本次已扣 4 积分）：' + trunc(JSON.stringify(d), 400) };
    const stat = d.stat || {};
    const pages = arr(d.pages);
    const owner = d.owner || {};
    const rights = d.rights || {};
    const parts = pages.slice(0, 8).map((p, i) => `   P${p.page || i + 1} ${trunc(p.part || d.title || '（分P无标题）', 60)} · ${fmtDur(p.duration)} · cid=${p.cid ?? '—'}`);
    if (pages.length > 8) parts.push(`   …共 ${pages.length} 个分P（videos=${d.videos ?? pages.length}）`);
    return {
      output: out(
        `${cleanText(d.title, 160)}`,
        `链接：https://www.bilibili.com/video/${d.bvid || bvid}`,
        f('AV/BV', `${d.aid ?? '—'} / ${d.bvid || '—'}`),
        f('UP主', `${owner.name || '—'}（mid ${owner.mid ?? '—'}）`),
        f('发布', `${fmtCn(d.pubdate)} 北京时间（pubdate=${d.pubdate ?? '—'} 为秒级时间戳）`),
        f('时长', `${fmtDur(d.duration)}（${d.duration ?? 0} 秒）`),
        f('分区', `tid=${d.tid ?? '—'}；tname 恒为空字符串，别当成"未返回分区名"`),
        f('数据', `播放 ${stat.view ?? '—'} · 弹幕 ${stat.danmaku ?? '—'} · 评论 ${stat.reply ?? '—'} · 收藏 ${stat.favorite ?? '—'} · 投币 ${stat.coin ?? '—'} · 转发 ${stat.share ?? '—'} · 点赞 ${stat.like ?? '—'}`),
        d.desc ? `简介：${cleanText(d.desc, Number(cfg.desc_chars) || 300)}` : '简介：（空）',
        f('封面', httpsUrl(d.pic)),
        [d.copyright === 1 ? '原创' : d.copyright === 2 ? '转载' : null,
          rights.pay ? '付费' : null, rights.restriction ? '有观看限制' : null,
          d.is_upower_exclusive ? '充电专属' : null, d.state ? `state=${d.state}` : null].filter(Boolean).join(' · ') || null,
        parts.length ? parts.join('\n') : null,
        '',
        '未返回：标签、评论、粉丝数、分P之外的剧集信息；需要 UP 主投稿列表用 bili_archives。（本接口不缓存，每次 4 积分）'
      )
    };
  });
}

const LIVE_STATUS = { 0: '未开播', 1: '直播中', 2: '轮播中' };
async function runBiliLive(args) {
  const cfg = configOf('bili_liveroom');
  let mid = String(args?.mid || '').trim();
  let roomId = String(args?.room_id || args?.roomid || '').trim();
  if (mid && !/^\d+$/.test(mid)) return { error: 'bili_liveroom:mid 只能是数字（UP 主用户 ID）。' };
  if (roomId && !/^\d+$/.test(roomId)) return { error: 'bili_liveroom:room_id 只能是数字（长房间号或短房间号都可以）。' };
  if (!mid && !roomId) return { error: 'bili_liveroom:需要提供 mid 或 room_id 之一（都为空时 400，不扣积分）。' };
  const qs = roomId ? { room_id: roomId } : { mid }; // 同时传时服务端只看 room_id
  return cachedRun('bili_liveroom', qs, Number(cfg.cache_minutes) || 0, async () => {
    const r = await httpCall({ label: 'bili_liveroom', url: apiUrl(`${UAPI}/api/v1/social/bilibili/liveroom`, qs), timeoutMs: timeoutSeconds(cfg, 25) });
    if (r.error) {
      if (/HTTP 404/.test(r.error)) return { error: `bili_liveroom:直播间不存在（${roomId ? 'room_id ' + roomId : 'mid ' + mid}）。404 也扣 4 积分，先核对号。` };
      return { error: r.error };
    }
    const d = r.data || {};
    noteCall('bili_liveroom');
    const live = d.live_status === 1; // 只有 1 是直播中；2 是轮播，标题字段仍会残留上一场内容
    const tags = String(d.tags || '').split(',').map(x => x.trim()).filter(Boolean);
    const lt = String(d.live_time || '');
    return {
      output: out(
        `${cleanText(d.title, 120) || '（无标题）'}`,
        live ? `状态：直播中（live_status=1）· 人气 online=${d.online ?? 0}` : `状态：${LIVE_STATUS[d.live_status] || `live_status=${d.live_status}`}（online 在非直播时为 0，不代表房间没人看过）`,
        `直播间：长号 ${d.room_id ?? '—'}${d.short_id ? ` / 短号 ${d.short_id}` : '（未设短号，short_id=0）'} · https://live.bilibili.com/${d.room_id ?? ''}`,
        d.uid ? f('主播', `uid ${d.uid}`) : null,
        f('分区', `${d.parent_area_name || '—'} / ${d.area_name || '—'}（area_id=${d.area_id ?? '—'}）`),
        f('关注数', d.attention),
        live || lt !== '0000-00-00 00:00:00' ? f('本场开播时间', lt === '0000-00-00 00:00:00' ? '' : lt + '（北京时间）') : null,
        d.description ? `房间公告：${cleanText(d.description, 200)}` : null,
        tags.length ? `标签：${tags.join('、')}` : null,
        d.user_cover ? `封面：${httpsUrl(d.user_cover)}` : null,
        '',
        '判断"是否开播"只看 live_status===1；未开播时 live_time 是 "0000-00-00 00:00:00" 而不是空串；hot_words 是全站默认词、与本房间无关，已忽略。（本接口不缓存，每次 4 积分，轮询请控制频率）'
      )
    };
  });
}

async function runBiliArchives(args) {
  const cfg = configOf('bili_archives');
  const mid = String(args?.mid || '').trim();
  if (!/^\d+$/.test(mid)) return { error: 'bili_archives:mid（UP 主数字 ID）必填且只能是数字；缺失时 400 不扣积分。' };
  let ps = parseInt(args?.ps);
  if (!Number.isInteger(ps) || ps < 1) ps = Number(cfg.default_ps) || 10;
  ps = Math.min(Math.max(ps, 1), 50); // 超出 1-50 会 400
  let pn = parseInt(args?.pn || args?.page);
  if (!Number.isInteger(pn) || pn < 1) pn = 1;
  // 实测 keywords 会破坏结果、orderby 完全无效：都不发送，需要时本地过滤/排序
  const dropNote = (String(args?.keywords || '').trim() ? '已忽略 keywords（服务端该过滤失效：total 会被筛但 videos 恒为空）。' : '')
    + (String(args?.orderby || '').trim() ? ' 已忽略 orderby（传与不传响应逐字节相同），结果按上游默认（发布时间）顺序返回。' : '');
  const qs = { mid, ps, pn };
  return cachedRun('bili_archives', qs, Number(cfg.cache_minutes) || 0, async () => {
    const r = await httpCall({ label: 'bili_archives', url: apiUrl(`${UAPI}/api/v1/social/bilibili/archives`, qs), timeoutMs: timeoutSeconds(cfg, 25) });
    if (r.error) return { error: r.error };
    const d = r.data || {};
    noteCall('bili_archives');
    const videos = arr(d.videos);
    const total = num(d.total) ?? 0;
    const size = num(d.size) || ps;
    const page = num(d.page) || pn;
    if (!videos.length) {
      const pages = Math.ceil(total / size);
      const overPaged = total > 0 && (page - 1) * size >= total;
      return {
        output: out(
          `mid=${mid} 第 ${page} 页返回 0 条投稿（total=${total}）。`,
          overPaged ? `这是翻页越界：total=${total}、每页 ${size}，只有 ${pages} 页（pn 取 1~${pages}）。` :
            total > 0 ? `total=${total} 但本页为空，可能是上游数据不一致，换 pn=1 取一次即可。` :
              'total 也为 0：该接口无法区分「用户不存在」与「用户没有投稿」，都返回 200 且照扣 4 积分——别连续试探。',
          dropNote.trim() || null
        )
      };
    }
    const lines = [`UP 主 mid=${mid} 投稿：total=${total}，第 ${page} 页每页 ${size}，本页 ${videos.length} 条${Math.ceil(total / size) > 1 ? `（共 ${Math.ceil(total / size)} 页，取下一页用 pn=${page + 1}）` : ''}。`];
    videos.forEach((v, i) => {
      lines.push(`${i + 1}. ${cleanText(v.title, 90)}`,
        `   https://www.bilibili.com/video/${v.bvid || ''} · aid=${v.aid ?? '—'}`,
        `   ${fmtCn(v.publish_time)} 北京时间 · 时长 ${fmtDur(v.duration)} · 播放 ${v.play_count ?? '—'}${v.is_ugc_pay ? ' · 付费卡' : ''}`);
    });
    if (dropNote.trim()) lines.push('', dropNote.trim());
    lines.push('', '注意：本接口不返回分P、封面已省略；create_time 与 publish_time 同值；duration 是秒数不是 MM:SS。');
    return { output: lines.join('\n') };
  });
}

// ============================================================
// UApi · 网页元数据
// ============================================================
async function runWebMetadata(args) {
  const cfg = configOf('web_metadata');
  const scheme = String(args?.url || '').trim().match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
  if (scheme && !/^https?$/i.test(scheme[1])) return { error: `web_metadata:仅支持 http/https（收到 ${scheme[1]}://）。传 ftp 之类服务端只会回「提供的 URL 不安全或不被支持」。` };
  const url = cleanUrlish(args?.url);
  if (!/^https?:\/\//i.test(url)) return { error: `web_metadata:url 必须是带 http/https 协议的完整地址（收到「${trunc(args?.url, 80)}」）。本地校验不通过不花积分。` };
  let parsed;
  try { parsed = new URL(url); } catch (e) { return { error: `web_metadata:url 解析失败：${url}` }; }
  if (!/^https?:$/.test(parsed.protocol)) return { error: `web_metadata:仅支持 http/https（收到 ${parsed.protocol}），传其他协议服务端会报「URL不安全或不被支持」。` };
  return cachedRun('web_metadata', { url }, Number(cfg.cache_minutes) || 0, async () => {
    const r = await httpCall({ label: 'web_metadata', url: apiUrl(`${UAPI}/api/v1/webparse/metadata`, { url }), timeoutMs: timeoutSeconds(cfg, 35) });
    if (r.error) {
      if (/HTTP 400/.test(r.error)) return { error: r.error + '（400 不扣积分）' };
      if (/HTTP 500/.test(r.error)) return { error: r.error + '（500 通常是目标站返回了非 2xx，且此接口不校验 Content-Type；该请求未扣分，可换 URL）' };
      return { error: r.error };
    }
    const d = r.data || {};
    noteCall('web_metadata');
    const og = d.open_graph && typeof d.open_graph === 'object' ? d.open_graph : {};
    const ogKeys = Object.keys(og);
    const fav = /^data:/.test(String(d.favicon_url || '')) ? '' : httpsUrl(d.favicon_url);
    const weak = !cleanText(d.description, 40) && !arr(d.keywords).length && !ogKeys.length;
    return {
      output: out(
        `${cleanText(d.title, 200) || '（无 title）'}`,
        f('地址', `${d.page_url || url}（page_url 只是入参回显，不跟随重定向；分享/规范地址用 canonical_url）`),
        d.canonical_url ? f('canonical', d.canonical_url) : null,
        cleanText(d.description, 300) ? `描述：${cleanText(d.description, 300)}` : '描述：（无 meta description）',
        f('关键词', arr(d.keywords).join('、')),
        f('语言', d.language), d.author ? f('作者', d.author) : null,
        d.published_time ? f('发布时间', d.published_time) : null,
        d.generator ? f('生成器', d.generator) : null,
        fav ? `favicon：${fav}` : 'favicon：（未找到，接口有时回 data: 占位，已丢弃）',
        ogKeys.length ? `Open Graph（键名保留 og: 前缀，值都是字符串）：${ogKeys.slice(0, 10).map(k => `${k}=${trunc(og[k], 90)}`).join(' | ')}` : 'Open Graph：无（{}）',
        weak ? '' : null,
        weak ? '警告：描述、关键词、OG 全为空。该接口不校验 Content-Type，对 JSON/图片/二进制目标会返回看似合理但错误的数据（实测抓到过无关站点的 title），别据此判定这是一个正常网页。' : null,
        '只取元数据，不含正文；要正文用 web_fetch。（1 积分/次，命中服务端缓存时 0 积分）'
      )
    };
  });
}

// ============================================================
// UApi · OCR
// ============================================================
async function runImageOcr(args) {
  const cfg = configOf('image_ocr');
  const url = String(args?.url || '').trim();
  const b64 = String(args?.image_base64 || args?.base64 || '').trim();
  const lp = String(args?.path || args?.image_path || '').trim();
  const picked = [url && 'url', lp && 'path', b64 && 'image_base64'].filter(Boolean);
  if (picked.length > 1) return { error: `image_ocr:url / path / image_base64 三者只能给一个（同时给会 400，且互斥），收到 ${picked.join(' + ')}。` };
  if (!picked.length) return { error: 'image_ocr:需要提供 url（公网图片地址）、image_base64（图片 Base64）或 path（本地图片，需先在设置里开启）之一。' };

  const fields = [{ name: 'need_location', value: /^(true|1|yes)$/i.test(String(args?.need_location ?? (cfg.need_location ? 'true' : 'false'))) ? 'true' : 'false' }];
  if (/^(true|1|yes)$/i.test(String(args?.return_markdown ?? ''))) fields.push({ name: 'return_markdown', value: 'true' });
  let payload = null;
  if (url) {
    if (!/^https?:\/\//i.test(url)) return { error: 'image_ocr:url 必须是带协议的公网地址（非图片目标会 415，不扣积分）。' };
    fields.push({ name: 'url', value: url });
  } else if (b64) {
    fields.push({ name: 'image_base64', value: b64.replace(/^data:image\/[^;]*;base64,/i, '') });
  } else {
    if (!cfg.allow_local_path) return { error: 'image_ocr:本地图片识别默认关闭（原文会上传到第三方）。需要时在「设置 → 外部 API 工具 → 图片 OCR」里开启「允许读取项目内本地图片」，或改用 url。' };
    let local;
    try { local = await safeLocalPath(lp); } catch (e) { return { error: `image_ocr:本地图片不可用：${String(e.message || e).substring(0, 160)}` }; }
    const cap = (Number(cfg.max_mb) || 8) * 1024 * 1024;
    if (local.size > cap) return { error: `image_ocr:文件 ${local.name} 有 ${fmtBytes(local.size)}，超过上限 ${fmtBytes(cap)}（超限时上游返回 nginx 的 413 HTML 而不是 JSON）。` };
    try { payload = await fsp.readFile(local.file); } catch (e) { return { error: `image_ocr:读取失败：${String(e.message || e).substring(0, 160)}` }; }
    fields.push({ name: 'file', value: payload, filename: local.name });
  }

  const keyObj = { url: url || null, path: lp || null, hash: b64 ? hkey('ocr', b64.substring(0, 512)) : null, loc: fields[0].value, md: (fields[1] || {}).value };
  return cachedRun('image_ocr', keyObj, Number(cfg.cache_minutes) || 0, async () => {
    const form = multipart(fields);
    const r = await httpCall({
      label: 'image_ocr', url: `${UAPI}/api/v1/image/ocr`, method: 'POST',
      form, timeoutMs: timeoutSeconds(cfg, 45), headers: { 'Content-Type': form.contentType }
    });
    if (r.error) {
      if (/HTTP 413/.test(r.error)) return { error: 'image_ocr:图片超过 10MB，上游 nginx 直接断掉（413/连接重置，不扣积分）。请压缩或裁切后重试。' };
      return { error: r.error };
    }
    const d = r.data || {};
    noteCall('image_ocr');
    const words = arr(d.words_result);
    const text = String(d.text || '');
    if (!words.length && !text.trim()) {
      return { output: 'image_ocr:识别完成但没有文字（words_result_num=0）。注意这种空结果照样扣 4 积分，且 HTTP 是 200 不是错误——如果图片本身不是截图/照片（如损坏文件、纯图表），换图别重试同一张。' };
    }
    const lines = [`OCR 结果（${d.need_location ? '含坐标' : '未取坐标'}，words_result_num=${d.words_result_num ?? words.length}）：`, '', text.substring(0, Number(cfg.max_text_chars) || 4000)];
    if (text.length > (Number(cfg.max_text_chars) || 4000)) lines.push('…（识别文本已按配置截断）');
    if (d.markdown) lines.push('', 'Markdown：', trunc(d.markdown, 2000));
    if (d.need_location && words.length) {
      lines.push('', '分段坐标（left/top/width/height，score）：');
      words.slice(0, 12).forEach((w, i) => {
        const l = w.location || {};
        lines.push(`  ${i + 1}. ${trunc(w.words, 40)} → (${l.left ?? '?'},${l.top ?? '?'}) ${l.width ?? '?'}x${l.height ?? '?'} score=${w.score ?? '?'}`);
      });
      if (words.length > 12) lines.push(`  …共 ${words.length} 段`);
      lines.push('  分段不等于视觉行：词内空格会被吞、同一行可能拆成多段，需要行结构时按 location.top 聚类。');
    }
    lines.push('', 'text 与 plain_text 内容相同，只取其一；接口没有返回图片宽高，也没有 timing/summary/lines/blocks/pages 这些文档提到但实际不存在的字段。');
    return { output: lines.filter(x => x !== null).join('\n') };
  });
}

// ============================================================
// UApi · Base64（免费）/ JSON 格式化（免费，默认走本地实现）
// ============================================================
// 服务端只吃「标准字母表 + 正确 padding + 无空白」，变体必须先清洗
function cleanB64(s) {
  let t = String(s || '');
  if (/^\s*data:[^,]*;base64,/i.test(t)) t = t.split(',').slice(1).join(',');
  t = t.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  return t + '='.repeat((4 - (t.length % 4)) % 4);
}

async function runBase64(args) {
  const cfg = configOf('base64_text');
  const action = String(args?.action || 'encode').trim().toLowerCase();
  if (!['encode', 'decode'].includes(action)) return { error: 'base64_text:action 只能是 encode 或 decode。' };
  const text = String(args?.text ?? '');
  const cap = Number(cfg.max_chars) || 8000;
  if (!text) return { error: `base64_text:text 不能为空。注意：服务端对空 text 或缺 text 字段返回的是 200 + 空结果，不报错，所以这里直接拦下。` };
  if (text.length > cap) return { error: `base64_text:text 长度 ${text.length} 超过配置上限 ${cap}。这种量级的转换请在本地做（exec_command 跑一句 node），别走网络。` };
  const send = action === 'decode' ? cleanB64(text) : text;
  if (action === 'decode' && !/^[A-Za-z0-9+/]*={0,2}$/.test(send)) return { error: 'base64_text:清洗后仍不是标准 Base64（含非法字符）。本接口不接受 URL-safe 之外的乱码、也不接受二进制还原。' };
  const r = await httpCall({ label: 'base64_text', url: `${UAPI}/api/v1/text/base64/${action}`, method: 'POST', json: { text: send }, timeoutMs: timeoutSeconds(cfg, 15) });
  if (r.error) return { error: r.error };
  noteCall('base64_text');
  const key = action === 'encode' ? 'encoded' : 'decoded';
  const got = (r.data || {})[key];
  if (typeof got !== 'string') return { error: `base64_text:响应里没有 ${key} 字段：${trunc(JSON.stringify(r.data || {}), 200)}` };
  if (got === '' && send !== '') return { error: 'base64_text:服务端返回了空结果（这是它的静默失败形态，通常意味着请求体没被按 JSON 解析）。本次未扣积分，重试前检查输入。' };
  if (action === 'decode' && /\uFFFD/.test(got)) {
    return { output: `解码结果（含 U+FFFD 替换字符 ${got.match(/\uFFFD/g).length} 个）：\n${trunc(got, 2000)}\n\n警告：原数据不是合法 UTF-8 文本，服务端静默做了字节替换，数据已损坏且仍是 200。要还原二进制请在本地 base64 解码，别用这个接口。` };
  }
  return { output: out(`${action === 'encode' ? 'Base64 编码结果' : 'Base64 解码结果'}：`, got, '', `（${action}，免费接口，标准字母表 + = 填充；URL-safe/data URI/MIME 折行${action === 'decode' ? '已在本地清洗后送解' : '不在本接口输出范围内'}）`) };
}

// 只做结构换行的重排：不重新序列化，因此键序、数字字面量（雪花 ID、1.0）与转义都原样保留。
// 这正是 UApi 那个 /convert/json 会破坏的两件事，所以本地模式是默认。
function reindentJson(text, indent) {
  const pad = ' '.repeat(Math.max(1, Number(indent) || 4));
  let s = '';
  let depth = 0;
  let inStr = false;
  let esc = false;
  const nl = () => { s += '\n' + pad.repeat(depth); };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      s += ch;
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; s += ch; continue; }
    if (ch <= ' ') continue; // 原有多余空白一律丢弃，由我们重排
    if (ch === '{' || ch === '[') {
      const close = ch === '{' ? '}' : ']';
      let j = i + 1;
      while (j < text.length && text[j] <= ' ') j++;
      if (text[j] === close) { s += ch + close; i = j; continue; } // 空对象/空数组保持同行
      s += ch; depth++; nl(); continue;
    }
    if (ch === '}' || ch === ']') { depth = Math.max(0, depth - 1); nl(); s += ch; continue; }
    if (ch === ',') { s += ','; nl(); continue; }
    if (ch === ':') { s += ': '; continue; }
    s += ch;
  }
  return s;
}

function localPrettyJson(raw, indent) {
  const text = String(raw).replace(/^\uFEFF/, '');
  try { JSON.parse(text); } catch (e) { return { error: `json_format:本地判定这不是合法 JSON：${String(e.message).substring(0, 200)}（本地就能报错，省一次请求）` }; }
  return { output: reindentJson(text, indent) };
}

async function runJsonFormat(args) {
  const cfg = configOf('json_format');
  const raw = String(args?.content ?? args?.json ?? '').replace(/^\uFEFF/, '');
  if (!raw.trim()) return { error: 'json_format:content 必须是 JSON 字符串（不是对象）。空内容或缺字段时服务端 400。' };
  if (raw.length > (Number(cfg.max_chars) || 60000)) return { error: `json_format:输入 ${raw.length} 字符，超过配置上限 ${cfg.max_chars || 60000}。` };
  let unsafeInt = false;
  try {
    JSON.parse(raw);
    unsafeInt = /[:\[,]\s*-?\d{17,}\s*[,}\]]/.test(raw); // 超大整数：走远端会被转成科学计数法
  } catch (e) {
    return { error: `json_format:本地就判定这不是合法 JSON，不必发请求：${String(e.message).substring(0, 180)}` };
  }
  if (!cfg.use_remote || unsafeInt) {
    const r = localPrettyJson(raw, cfg.indent);
    if (r.error) return r;
    return {
      output: out(
        r.output,
        '',
        unsafeInt
          ? '（未走网络：输入含超大整数，UApi 会把它们转成浮点科学计数法造成不可逆精度丢失；本地重排保住了数字字面量与键序）'
          : `（本地重排，未走网络：保住键序与大整数。要与服务端行为一致可在「设置 → 外部 API 工具 → JSON 格式化」开启走远端）`
      )
    };
  }
  const r = await httpCall({ label: 'json_format', url: `${UAPI}/api/v1/convert/json`, method: 'POST', json: { content: raw }, timeoutMs: timeoutSeconds(cfg, 15) });
  if (r.error) return { error: r.error + '（两套文案：Failed to format JSON = 内容缺失或不是合法 JSON；Invalid JSON provided = content 传成了对象/数字而非字符串）' };
  noteCall('json_format');
  const pretty = (r.data || {}).content;
  if (typeof pretty !== 'string') return { error: `json_format:响应里的 content 不是字符串：${trunc(JSON.stringify(r.data || {}), 200)}` };
  return { output: out(pretty, '', '（UApi 格式化：缩进固定 4 空格、不可配置；服务端会把大整数转成科学计数法且不保证键序，重要数据建议用本地模式）') };
}

// ============================================================
// 寻鲸录 · 城市天气（免费、无 key；HTTP 恒 200，业务码在 body）
// ============================================================
const CITY_URL = `${XJL}/api/weather/csid.json`;
const CITY_FILE = path.join(DATA_DIR, 'weather-cities.json');
// 内置兜底：只放文档实测确认过的码（北京 101010100 / 天津 101030100 / 杭州 101210101），
// 其余靠在线城市表（csid.json 的 city_code）；输出里会回显上游给的城市名，码错了一眼能看出来
const CITY_SEED = {
  北京: '101010100', 北京市: '101010100',
  天津: '101030100', 天津市: '101030100',
  杭州: '101210101', 杭州市: '101210101'
};
let cityTable = null; // { at, map }

function loadCityTable() {
  if (cityTable) return cityTable;
  try {
    const j = JSON.parse(fs.readFileSync(CITY_FILE, 'utf8'));
    if (j && j.map) cityTable = j;
  } catch (e) { /* 还没有本地表 */ }
  return cityTable;
}

async function refreshCityTable(force) {
  const age = loadCityTable();
  const days = Number(configOf('weather_city').city_table_days) || 30;
  if (age && !force && Date.now() - (age.at || 0) < days * 86400000) return age;
  const r = await httpCall({ label: 'weather_city', url: CITY_URL, timeoutMs: 30000 });
  if (r.error) return age || null;
  const rows = arr(r.data);
  const map = {};
  for (const row of rows) {
    const code = String((row && row.city_code) || '').trim();
    if (!/^\d{9}$/.test(code)) continue; // 594 条没有 city_code（多为省级）
    for (const key of [row.full_name, row.name, row.short_name]) {
      const k = String(key || '').trim();
      if (k && !map[k]) map[k] = code;
    }
  }
  const table = { at: Date.now(), total: rows.length, map };
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.writeFile(CITY_FILE, JSON.stringify(table), 'utf8');
  } catch (e) { /* 写不下也只是下次重新拉 */ }
  cityTable = table;
  return table;
}

function resolveCity(input, table) {
  const name = String(input || '').trim().replace(/\s+/g, '');
  if (/^\d{9}$/.test(name)) return { code: name };
  const map = Object.assign({}, CITY_SEED, (table && table.map) || {});
  if (map[name]) return { code: map[name] };
  const stripped = name.replace(/(市|区|县|自治州|地区|盟|特别行政区)$/,'');
  if (stripped && map[stripped]) return { code: map[stripped] };
  if (map[name + '市']) return { code: map[name + '市'] };
  const want = (stripped || name).toLowerCase();
  const hits = Object.keys(map).filter(k => k.toLowerCase().includes(want)).slice(0, 10);
  return hits.length ? { candidates: hits.map(k => `${k}=${map[k]}`) } : { candidates: [] };
}

async function runWeather(args) {
  const cfg = configOf('weather_city');
  const want = String(args?.city || args?.cityId || '').trim();
  if (!want) return { error: 'weather_city:city 必填（城市名如「天津」「杭州」，或 9 位城市码如 101030100）。' };
  let code = '';
  let resolvedBy = '';
  if (/^\d{9}$/.test(want)) code = want;
  else {
    const table = loadCityTable();
    const hit = resolveCity(want, table);
    if (hit.code) { code = hit.code; resolvedBy = table ? '本地城市表' : '内置城市码'; }
    else {
      const fresh = cfg.auto_update_table ? await refreshCityTable(false) : table;
      const again = resolveCity(want, fresh);
      if (again.code) { code = again.code; resolvedBy = '在线城市表'; }
      else {
        return {
          output: out(
            `weather_city:没找到城市「${want}」的 9 位城市码。`,
            again.candidates && again.candidates.length ? `相近候选：${again.candidates.join('、')}` : `（城市表里没有任何包含「${want}」的条目）`,
            `城市码来自 ${CITY_URL}（字段 city_code，共 3749 条、3099 个唯一码）。确认后可直接传 9 位码调用。`
          )
        };
      }
    }
  }
  return cachedRun('weather_city', { code }, Number(cfg.cache_minutes) || 0, async () => {
    const r = await httpCall({ label: 'weather_city', url: apiUrl(`${XJL}/api/weather/index.php`, { cityId: code }), timeoutMs: timeoutSeconds(cfg, 20) });
    if (r.error) return { error: r.error };
    const d = r.data || {};
    // HTTP 恒 200：业务码在 body.code，data 为 null 就是失败
    if (d.code !== 200 || !d.data) {
      const ec = d.code;
      const msg = String(d.message || '');
      return {
        error: out(
          `weather_city:业务失败 code=${ec}（HTTP 仍是 200）`,
          /不在返回之内/.test(msg) ? `城市码 ${code} 不在上游表内。请改用城市表里的 city_code，或先查候选。` : '',
          /格式错误/.test(msg) ? `cityId 必须是 9 位数字，收到 ${code}。` : '',
          ec === 400 && !msg ? '缺少必要参数 cityId。' : '',
          /HTTP状态码/.test(msg) ? '上游天气源暂时不可用（500），可稍后重试。' : '',
          '（已按内部码映射，不展示上游原文）'
        )
      };
    }
    noteCall('weather_city');
    const data = d.data;
    const cur = data.current || {};
    const info = data.city_info || {};
    const fc = arr(data.forecast); // 固定 15 条，[0] 是今天
    const y = data.yesterday || {};
    const days = Math.min(Math.max(parseInt(args?.days) || 3, 0), 6);
    const lines = [
      `${info.city || '（无城市名）'}（城市码 ${code}，${resolvedBy || '直接使用 9 位码'}）实时天气`,
      f('天气', `${cur.temperature ?? '—'}℃ · 湿度 ${cur.humidity ?? '—'} · ${fc[0] ? fc[0].type : '—'}`),
      f('空气', `PM2.5 ${cur.pm25 ?? '—'} / PM10 ${cur.pm10 ?? '—'} · 等级 ${cur.quality ?? '—'}`),
      f('体感提示', cur.cold_index),
      fc[0] ? f('今天', `${fc[0].ymd} ${numFrom(fc[0].low) ?? '?'}~${numFrom(fc[0].high) ?? '?'}℃ · ${fc[0].type} · ${fc[0].fx}${fc[0].fl} · AQI ${fc[0].aqi ?? '—'} · 日出${fc[0].sunrise} 日落${fc[0].sunset}`) : null
    ];
    for (const x of fc.slice(1, 1 + days)) {
      lines.push(`  ${x.ymd} ${x.week} ${x.type} ${numFrom(x.low) ?? '?'}~${numFrom(x.high) ?? '?'}℃ AQI ${x.aqi ?? '—'}${x.notice ? `（${x.notice}）` : ''}`);
    }
    if (y.ymd) lines.push(`  昨天 ${y.ymd} ${y.type} ${numFrom(y.low) ?? '?'}~${numFrom(y.high) ?? '?'}℃`);
    lines.push('',
      `数据快照 ${data.update_time}，天气本身更新于 ${info.weather_update_time || '—'}（均为北京时间，上游小时级滞后，接口无边缘缓存）。`,
      '说明：city_info.city_id 恒为空串（要用自己传的码）；温度/湿度/高低都是中文包裹的字符串，本输出已抽数；forecast[0] 是今天而不是明天。');
    return { output: lines.filter(x => x !== null).join('\n') };
  });
}

// ============================================================
// 寻鲸录 · QQ 信息（需密钥，2 次/分钟；成功结构未经实测验证）
// ============================================================
const QQ_ERR = { 11001: '未提供密钥', 11002: '密钥错误', 11005: '请求过于频繁（限流 2 次/分钟）' };
async function runQqInfo(args) {
  const cfg = configOf('qq_info');
  const key = String(cfg.api_key || '').trim();
  if (!key) return { error: 'qq_info:未配置调用密钥。请在「设置 → 外部 API 工具 → QQ 信息」填入向服务方申请的 key（密钥只存在本机配置里，随请求以 query 参数发往上游）。' };
  const qq = String(args?.qq || '').trim();
  if (!/^\d{5,12}$/.test(qq)) return { error: 'qq_info:qq 需为 5~12 位数字。（该接口的 qq 校验规则在服务端先校验密钥前无法验证，本地先挡住）' };
  const gap = Number(cfg.min_interval_seconds) || 31;
  const wait = rateWait('qq_info', gap);
  if (wait) return { error: `qq_info:本地节流中，距上次调用不足 ${gap} 秒，请 ${wait} 秒后再试（该服务限流 2 次/分钟，且鉴权失败也计入额度，没有 Retry-After 头）。` };
  rateMark('qq_info');
  const r = await httpCall({ label: 'qq_info', url: apiUrl(`${XJL}/api/qq/v1.php`, { key, qq }), timeoutMs: timeoutSeconds(cfg, 20) });
  if (r.error) return { error: r.error };
  const d = r.data || {};
  if (d.code !== 200 || !d.data) {
    const ec = d.errcode;
    return { error: `qq_info:失败 errcode=${ec ?? '未知'}（${QQ_ERR[ec] || '服务端给出的其他错误'}；HTTP 仍是 200，body.msg=「${trunc(d.msg || d.message, 120)}」）。注意错误体用 msg、成功体才用 message，键名不统一。` };
  }
  noteCall('qq_info');
  const data = d.data;
  const bi = data.basic_info || {};
  const vd = data.vip_detail || {};
  const vip = Object.entries(vd).map(([k, v]) => `${(v && v.description) || k}=${v ? v.value : '—'}`);
  return {
    output: out(
      `QQ ${bi.qq || qq} 资料（来自第三方接口，字段结构未经实调验证，以实际返回为准）`,
      f('昵称', bi.nickname), f('等级', bi.level), f('QID', bi.qid), f('年龄/性别', [bi.age].filter(Boolean).join(' / ')),
      f('签名', cleanText(bi.signature, 160)), f('注册时间', bi.register_time), f('注册天数', bi.register_days),
      f('头像', bi.avatar || data.avatar),
      arr(data.vip_services).length ? `会员服务：${JSON.stringify(data.vip_services).substring(0, 300)}` : '会员服务：无（vip_services 为空数组）',
      vip.length ? '会员详情：' + vip.slice(0, 10).join(' · ') : null,
      '',
      `数据滞后与缓存：本结果本地缓存 ${cfg.cache_minutes || 0} 分钟；服务限流 2 次/分钟，请勿循环查询。`,
      '合规提醒：这是第三方对个人公开资料的聚合查询，昵称/签名/注册时间属于他人个人信息，只做用户明确要求的单条查询，不要批量拉取或长期留存。'
    )
  };
}

// ============================================================
// 注册表
// ============================================================
const CFG = {
  timeout: (def, max) => ({ key: 'timeout_seconds', label: '超时（秒）', type: 'number', def, min: 3, max: max || 180 }),
  cache: (def, max) => ({ key: 'cache_minutes', label: '本地结果缓存（分钟，0=不缓存）', type: 'number', def, min: 0, max: max == null ? 10080 : max })
};

const TOOLS = {
  web_search: {
    name: 'web_search', provider: 'SearXNG（自建）', category: '搜索',
    label: '联网搜索（SearXNG 聚合）',
    source: 'SearXNG · GET /search?format=json',
    doc: 'SearXNG API 接入文档 v1.0（2026-09-23）',
    cost: '免费（自建服务，无额度）；limiter 开启时高频会被 429',
    testArg: 'query',
    testHint: 'Go 语言最新版本',
    description: [
      '联网搜索实时网页信息（新闻、版本号、价格、文档、"最新/最近"类时效问题）。需要外部事实、或本地知识可能过时时使用。',
      '走本机自建 SearXNG 聚合，免费但默认只查 bing 一个引擎（全引擎聚合要 20 秒且多数超时）；确实需要多源交叉再传 engines。',
      '实测翻页 pageno≥2 与 time_range 都会返回 0 条，不要试图翻页或用它做时间筛选；一次把问题问全。',
      'categories 只在确实要换分类（news / science / it 等）时才传，传 general 会让引擎限定失效、耗时涨到 20 秒。',
      'q 里写 site: / filetype: 这类操作符上游引擎不采纳（实测结果域不变），要限定站点请自己在结果里挑 URL。',
      '不要用它抓网页正文，那是 web_fetch 的活。'
    ].join(' '),
    params: {
      query: { type: 'string', required: true, desc: '搜索关键词（中英文均可）' },
      max_results: { type: 'string', required: false, desc: '返回条数（本地截取），默认取配置值，最多 25' },
      engines: { type: 'string', required: false, desc: '逗号分隔的引擎名，如 "bing,google"；留空用配置的默认（bing）。加引擎会显著变慢。' },
      language: { type: 'string', required: false, desc: '语言代码，如 zh-CN / en / auto；留空用配置默认' },
      categories: { type: 'string', required: false, desc: '分类：general（默认）/ news / science / it 等' }
    },
    configFields: [
      { key: 'base_url', label: 'SearXNG 服务地址', type: 'text', def: 'http://127.0.0.1:18888', hint: '填你自己那台 SearXNG 的地址' },
      { key: 'default_engines', label: '默认引擎（逗号分隔）', type: 'text', def: 'bing', hint: '留空=全部引擎（实测约 20 秒且多数超时）' },
      { key: 'default_max_results', label: '默认返回条数', type: 'number', def: 8, min: 1, max: 25 },
      { key: 'language', label: '默认语言', type: 'text', def: 'zh-CN' },
      { key: 'categories', label: '默认分类', type: 'text', def: 'general' },
      { key: 'safesearch', label: '安全搜索（0关/1中/2严）', type: 'number', def: 1, min: 0, max: 2 },
      { key: 'timeout_limit', label: '上游等待上限（秒）', type: 'number', def: 12, min: 3, max: 30, hint: 'SearXNG 侧的 timeout_limit 参数' },
      CFG.cache(60, 1440)
    ],
    run: runWebSearch
  },

  mc_version: {
    name: 'mc_version', provider: 'UApi', category: '游戏',
    label: 'Minecraft 最新版本',
    source: 'UApi · GET /api/v1/game/minecraft/version',
    doc: 'UApi-Minecraft-最新版本.md',
    cost: '1 积分/次（实测 MISS 扣 1；服务端缓存命中时 0）',
    testArg: '',
    testHint: '无需参数，直接点试跑',
    description: '查 Minecraft 当前最新正式版与最新快照版本号及其发布时间（上游为 Mojang），用于更新检查、启动器展示。无参数、1 积分/次。不要拿它做版本比较逻辑：版本号是不透明字符串。',
    params: {},
    configFields: [CFG.timeout(15, 60), CFG.cache(1440, 10080)],
    run: runMcVersion
  },

  mc_mods: {
    name: 'mc_mods', provider: 'UApi', category: '游戏',
    label: 'Minecraft Mod/插件搜索',
    source: 'UApi · GET /api/v1/game/minecraft/mods',
    doc: 'UApi-Minecraft-Mod插件搜索.md',
    cost: '2 积分/次，约 4 秒（enrich 开启时）',
    testArg: 'query',
    testHint: 'sodium',
    description: '按关键词搜索 Minecraft 模组与服务端插件（Modrinth + SpigotMC），返回名称、作者、下载量、页面与直链。用户找 mod/插件/材质包、或问"有没有 XX 模组"时用。',
    params: {
      query: { type: 'string', required: true, desc: '关键词（英文名命中率更高）' },
      source: { type: 'string', required: false, desc: 'all（默认）| modrinth | spigotmc' },
      type: { type: 'string', required: false, desc: 'mod | plugin。其他取值服务端会静默返回空结果，宁可不传' },
      limit: { type: 'string', required: false, desc: '每个来源的条数上限（不是总数），默认 10，最大 50' },
      enrich: { type: 'string', required: false, desc: 'true（默认）补齐下载直链与作者；false 更快但字段退化' }
    },
    configFields: [
      { key: 'default_limit', label: '默认 limit', type: 'number', def: 10, min: 1, max: 50 },
      { key: 'enrich_default', label: '默认补齐直链（enrich）', type: 'bool', def: true },
      CFG.timeout(25, 90),
      CFG.cache(180, 10080)
    ],
    run: runMcMods
  },

  world_time: {
    name: 'world_time', provider: 'UApi', category: '工具',
    label: '世界时间查询',
    source: 'UApi · GET /api/v1/misc/worldtime',
    doc: 'UApi-杂项-世界时间查询.md',
    cost: '免费',
    testArg: 'city',
    testHint: 'Asia/Shanghai',
    description: '查某城市/时区当前的本地时间、UTC 偏移与星期，用于跨时区约会议、世界时钟。只给当前时刻，不能查历史或未来。',
    params: {
      city: { type: 'string', required: true, desc: 'IANA 时区名，大小写敏感，如 Asia/Shanghai、America/New_York（多词用下划线，空格会失败）；常见裸城市名（London、Tokyo）可用但列表不全；不支持中文' }
    },
    configFields: [CFG.timeout(15, 60), CFG.cache(5, 1440)],
    run: runWorldTime
  },

  whois_query: {
    name: 'whois_query', provider: 'UApi', category: '网络',
    label: '域名 WHOIS 查询',
    source: 'UApi · GET /api/v1/network/whois',
    doc: 'UApi-网络-WHOIS查询.md',
    cost: '2 积分/次（命中缓存 1 积分），慢时可达 16 秒',
    testArg: 'domain',
    testHint: 'google.com',
    description: '查域名的注册时间、到期时间、注册商、状态位与 DNS 服务器，用于域名到期提醒、资产盘点、备案核对。未注册也是 200 且照扣积分。',
    params: {
      domain: { type: 'string', required: true, desc: '域名，如 example.com（给 URL 也可以，本地会先抽出主机名并校验）' },
      format: { type: 'string', required: false, desc: 'json（默认，结构化）| text（原始 WHOIS 全文）' }
    },
    configFields: [
      { key: 'prefer_json', label: '默认取结构化 JSON', type: 'bool', def: true },
      { key: 'raw_chars', label: '原文最长保留（字符）', type: 'number', def: 2600, min: 300, max: 8000 },
      CFG.timeout(45, 120),
      CFG.cache(240, 10080)
    ],
    run: runWhois
  },

  github_repo: {
    name: 'github_repo', provider: 'UApi', category: '开发',
    label: 'GitHub 仓库详情',
    source: 'UApi · GET /api/v1/github/repo',
    doc: 'UApi-社交-GitHub仓库查询.md',
    cost: '2 积分/次（命中缓存 1 积分）；404 也扣 2',
    testArg: 'repo',
    testHint: 'vitejs/vite',
    description: '查 GitHub 仓库的公开指标：star/fork/开放 issue、语言与占比、话题、协议、默认分支与 SHA、最新 Release、维护者名单。用户提到某个仓库/开源项目现状、版本、许可证时用。',
    params: { repo: { type: 'string', required: true, desc: 'owner/repo，也接受直接粘贴仓库 URL（本地会抽取）' } },
    configFields: [
      { key: 'max_maintainers', label: '维护者最多列出（已过滤 bot 与邮箱）', type: 'number', def: 8, min: 0, max: 20 },
      CFG.timeout(30, 90),
      CFG.cache(60, 10080)
    ],
    run: runGithubRepo
  },

  bili_video: {
    name: 'bili_video', provider: 'UApi', category: 'B站',
    label: 'B站视频详情',
    source: 'UApi · GET /api/v1/social/bilibili/videoinfo',
    doc: 'UApi-社交-B站视频查询.md',
    cost: '4 积分/次，服务端不缓存（404 同样扣）',
    testArg: 'bvid',
    testHint: 'BV17x411w79F',
    description: '按 BV/AV 号取单条 B 站视频的标题、UP 主、发布时间、时长、播放/弹幕/收藏等数据与分 P 列表。用户给出 B 站链接或 BV 号问内容时用。',
    params: {
      bvid: { type: 'string', required: false, desc: 'BV 号（BV + 10 位）。与 aid 同时给时服务端只看 bvid' },
      aid: { type: 'string', required: false, desc: 'AV 号的数字部分' }
    },
    configFields: [
      { key: 'desc_chars', label: '简介最长保留（字符）', type: 'number', def: 300, min: 60, max: 3000 },
      CFG.timeout(25, 90),
      CFG.cache(240, 10080)
    ],
    run: runBiliVideo
  },

  bili_liveroom: {
    name: 'bili_liveroom', provider: 'UApi', category: 'B站',
    label: 'B站直播间状态',
    source: 'UApi · GET /api/v1/social/bilibili/liveroom',
    doc: 'UApi-社交-B站直播间查询.md',
    cost: '4 积分/次，服务端不缓存（404 同样扣）',
    testArg: 'mid',
    testHint: '673232244',
    description: '判断某 UP 主/房间是否在播，并给直播标题、分区、人气与关注数。用户问"XX 开播了吗"时用。',
    params: {
      mid: { type: 'string', required: false, desc: '主播用户 ID（数字）' },
      room_id: { type: 'string', required: false, desc: '房间号，长号短号都行。与 mid 同时给时服务端只看 room_id' }
    },
    configFields: [CFG.timeout(25, 90), CFG.cache(2, 240)],
    run: runBiliLive
  },

  bili_archives: {
    name: 'bili_archives', provider: 'UApi', category: 'B站',
    label: 'B站UP主投稿列表',
    source: 'UApi · GET /api/v1/social/bilibili/archives',
    doc: 'UApi-社交-B站投稿查询.md',
    cost: '4 积分/次，服务端不缓存（查不存在的 mid 也扣）',
    testArg: 'mid',
    testHint: '483307278',
    description: '分页拉取某 UP 主的投稿视频（标题、BV 号、发布时间、播放、时长）。用户问"某人最近发了什么"时用。',
    params: {
      mid: { type: 'string', required: true, desc: 'UP 主数字 ID' },
      ps: { type: 'string', required: false, desc: '每页 1~50，默认 10；超出会 400' },
      pn: { type: 'string', required: false, desc: '页码，从 1 开始；越界不报错只返回空列表' }
    },
    configFields: [
      { key: 'default_ps', label: '默认每页条数', type: 'number', def: 10, min: 1, max: 50 },
      CFG.timeout(25, 90),
      CFG.cache(30, 10080)
    ],
    run: runBiliArchives
  },

  web_metadata: {
    name: 'web_metadata', provider: 'UApi', category: '搜索',
    label: '网页元数据（链接预览）',
    source: 'UApi · GET /api/v1/webparse/metadata',
    doc: 'UApi-网页解析-网页元数据.md',
    cost: '1 积分/次（命中缓存 0）',
    testArg: 'url',
    testHint: 'https://github.com/torvalds/linux',
    description: '给一个完整 URL，取该页的标题、描述、关键词、favicon、canonical 与 Open Graph 字段，用于链接预览卡片、判断陌生链接是什么。不返回正文（正文用 web_fetch）。',
    params: { url: { type: 'string', required: true, desc: '必须带 http/https 协议；无协议或 ftp 会 400（不扣分）' } },
    configFields: [CFG.timeout(35, 120), CFG.cache(1440, 10080)],
    run: runWebMetadata
  },

  image_ocr: {
    name: 'image_ocr', provider: 'UApi', category: '图像',
    label: '图片文字识别（OCR）',
    source: 'UApi · POST /api/v1/image/ocr（multipart/form-data）',
    doc: 'UApi-图像-OCR文字识别.md',
    cost: '4 积分/张（识别不出文字也扣），1.4~3.6 秒',
    testArg: 'url',
    testHint: 'https://uapis.cn/ocr-samples/bilingual-poetry-sample.png',
    description: '对图片做通用 OCR 取文字（截图、票据、照片里的文本），可返回逐段文本框坐标。入参是公网图片 URL、图片 Base64，或（需另行开启）项目内本地图片路径。',
    params: {
      url: { type: 'string', required: false, desc: '公网图片地址（非图片目标会 415，不扣分）' },
      image_base64: { type: 'string', required: false, desc: '图片 Base64，带不带 data:image/...;base64, 前缀都行' },
      path: { type: 'string', required: false, desc: '本地图片路径（需在设置里开启「允许读取项目内本地图片」）' },
      need_location: { type: 'string', required: false, desc: 'true 才返回坐标，响应体大 3 倍；默认 false' },
      return_markdown: { type: 'string', required: false, desc: 'true 时额外返回 markdown 版文本' }
    },
    configFields: [
      { key: 'need_location', label: '默认返回坐标（建议关闭）', type: 'bool', def: false },
      { key: 'allow_local_path', label: '允许读取项目内本地图片（会把图片上传第三方）', type: 'bool', def: false },
      { key: 'max_mb', label: '本地图片大小上限（MB）', type: 'number', def: 8, min: 1, max: 10 },
      { key: 'max_text_chars', label: '识别文本最长保留（字符）', type: 'number', def: 4000, min: 500, max: 20000 },
      CFG.timeout(45, 120),
      CFG.cache(0, 1440)
    ],
    run: runImageOcr
  },

  base64_text: {
    name: 'base64_text', provider: 'UApi', category: '文本',
    label: 'Base64 编码 / 解码',
    source: 'UApi · POST /api/v1/text/base64/{encode,decode}',
    doc: 'UApi-文本-Base64编解码.md',
    cost: '免费（仍受 4 次/秒限制）',
    testArg: 'text',
    testHint: '你好，世界',
    description: '短文本的 Base64 编码或解码。免费但走网络：长文本、二进制、含隐私的内容请改用本地 exec_command，别把它送第三方。',
    params: {
      action: { type: 'string', required: true, desc: 'encode | decode' },
      text: { type: 'string', required: true, desc: 'encode 时是原文；decode 时是 Base64 串（URL-safe、data URI 前缀、换行会在本地清洗）' }
    },
    configFields: [
      { key: 'max_chars', label: '单次最长文本（字符）', type: 'number', def: 8000, min: 200, max: 60000 },
      CFG.timeout(15, 60)
    ],
    run: runBase64
  },

  json_format: {
    name: 'json_format', provider: 'UApi/本地', category: '文本',
    label: 'JSON 格式化',
    source: 'UApi · POST /api/v1/convert/json',
    doc: 'UApi-转换-JSON格式化.md',
    cost: '免费（默认本地实现，不产生请求）',
    testArg: 'content',
    testHint: '{"b":1,"a":[1,2,{"c":3}]}',
    description: '把压缩/混乱的 JSON 字符串美化成缩进可读版。默认本地完成（保键序、保大整数），仅在你明确要求与服务端行为一致时走接口。',
    params: { content: { type: 'string', required: true, desc: '要格式化的 JSON 字符串（不是已解析的对象）' } },
    configFields: [
      { key: 'use_remote', label: '走 UApi 远端接口（默认关：本地更可靠）', type: 'bool', def: false },
      { key: 'indent', label: '本地模式缩进空格数', type: 'number', def: 4, min: 2, max: 8 },
      { key: 'max_chars', label: '输入长度上限（字符）', type: 'number', def: 60000, min: 1000, max: 500000 },
      CFG.timeout(15, 60)
    ],
    run: runJsonFormat
  },

  weather_city: {
    name: 'weather_city', provider: '寻鲸录', category: '生活',
    label: '城市天气（实时+15天预报）',
    source: '寻鲸录 · GET /api/weather/index.php',
    doc: '寻鲸录-天气-V1城市天气.md',
    cost: '免费、无需 key（数据小时级滞后）',
    testArg: 'city',
    testHint: '天津',
    description: '查国内/主要城市实时天气、空气质量与未来几天预报。用户问"今天/明天/这周天气"时用。城市可传中文名，内部自动换成 9 位城市码。',
    params: {
      city: { type: 'string', required: true, desc: '城市名（如 天津 / 杭州）或 9 位城市码（如 101030100）' },
      days: { type: 'string', required: false, desc: '附带未来几天预报，0~6，默认 3' }
    },
    configFields: [
      { key: 'auto_update_table', label: '自动更新在线城市表（csid.json，约 1.5MB）', type: 'bool', def: true },
      { key: 'city_table_days', label: '城市表有效期（天）', type: 'number', def: 30, min: 1, max: 365 },
      CFG.timeout(20, 60),
      CFG.cache(20, 1440)
    ],
    run: runWeather
  },

  qq_info: {
    name: 'qq_info', provider: '寻鲸录', category: '社交',
    label: 'QQ 号信息查询',
    source: '寻鲸录 · GET /api/qq/v1.php（需申请密钥）',
    doc: '寻鲸录-QQ信息-QQ信息查询V1.md',
    cost: '免费但需 key；限流 2 次/分钟（失败也计数）',
    testArg: 'qq',
    testHint: '3202089153',
    description: '按 QQ 号查公开资料（昵称、等级、个性签名、注册时间、会员状态）。需要在设置里填密钥；只有用户明确询问某个 QQ 号的公开信息时才用，不要批量或循环查。',
    params: { qq: { type: 'string', required: true, desc: 'QQ 号（5~12 位数字）' } },
    configFields: [
      { key: 'api_key', label: '调用密钥 key（以 query 参数发往上游）', type: 'secret', def: '', max: 200 },
      { key: 'min_interval_seconds', label: '本地最小调用间隔（秒，防限流）', type: 'number', def: 31, min: 30, max: 600 },
      CFG.timeout(20, 60),
      CFG.cache(360, 10080)
    ],
    run: runQqInfo
  }
};

const NAMES = Object.keys(TOOLS);

// 注册到统一开关层（持久化、definitions/schemas/提示词/设置页展示都由 toolgate 提供）
toolgate.register(TOOLS);

module.exports = {
  TOOLS, NAMES,
  isEnabled: toolgate.isEnabled, configOf: toolgate.configOf, upsert: toolgate.upsert,
  listForUi: toolgate.listForUi, groupedForUi: toolgate.groupedForUi,
  enabledNames: toolgate.enabledNames, definitions: toolgate.definitions, schemas: toolgate.schemas,
  isApiTool: toolgate.isGateTool, promptNotes: toolgate.promptNotes, noteCall: toolgate.noteCall,
  refreshCityTable,
};
