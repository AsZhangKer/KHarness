// AI 监工：按 kh.checks.md 驱动**内置浏览器**跑一轮网页自测，产出 pass/fail + 证据。
//
// 三条已拍板的边界（ROADMAP 第 9 节 + 本轮问答）：
//   1) 只出报告和证据，绝不改代码；失败项由人一键交给主 Agent。
//   2) 判定是**确定性**的（文本包含 / 不包含 / 元素出现 / 控制台零 error），
//      结果可重复、不花额度；只有失败时才可选叫一次模型写一句人话诊断。
//   3) 走内置浏览器那条通道（inapp.call），所以用户能在右栏看着它点；
//      桌面端不在线时立刻报错，不空等。
'use strict';

const fs = require('fs');
const path = require('path');
const { db } = require('../database');
const { DATA_DIR } = require('../config');
const inapp = require('./inapp');
const checks = require('./checks');
const notify = require('./notify');
const protocols = require('./protocols');

const MAX_DIAGNOSE = 3;         // 一轮最多让模型写几条诊断（失败多了说明整体没跑起来，不必逐条烧额度）
const STEP_TIMEOUT = 45000;

/* ---------------- 浏览器动作 ---------------- */

/** 打一个动作给桌面窗口；统一成 { ok, text } / { error } */
async function act(name, args = {}, timeoutMs = STEP_TIMEOUT) {
  const r = await inapp.call(name, args || {}, timeoutMs);
  if (!r) return { error: `${name} 没有返回值` };
  if (r.error) return { error: String(r.error) };
  return { ok: true, text: typeof r.text === 'string' ? r.text : '' };
}

function shotPathOf(text) {
  const m = /：\s*([A-Za-z]:[\\/][^\r\n]+\.png|\/[^\r\n]+\.png)/.exec(String(text || ''));
  return m ? m[1] : '';
}

/** browser_console 的正文形如「3 条：\n- [error] xxx」；只数真错误，warning 不算失败 */
function errorLinesOf(text) {
  const t = String(text || '');
  if (!t || t.startsWith('没有控制台报错')) return [];
  return t.split('\n').map((l) => l.replace(/^-\s*/, '').trim())
    .filter((l) => /^\[error\]/i.test(l));
}

/* ---------------- 单个用例 ---------------- */

const STEP_OP = {
  open: (s) => ['browser_open', { url: s.target }],
  goto: (s) => ['browser_navigate', { url: s.target }],
  click: (s) => ['browser_click', { selector: s.target }],
  type: (s) => ['browser_type', { selector: s.target, text: s.value }],
  select: (s) => ['browser_select', { selector: s.target, value: s.value }],
  press: (s) => ['browser_press', { key: s.value }],
  scroll: (s) => ['browser_scroll', { direction: s.value || 'down' }],
  wait: (s) => ['browser_wait_for', { selector: s.target }],
  wait_text: (s) => ['browser_wait_for', { text: s.target }],
  sleep: (s) => ['browser_wait_for', { ms: s.value }],
  reload: () => ['browser_reload', {}],
  back: () => ['browser_back', {}],
};

function stepLabel(s) {
  if (s.op === 'type') return `type ${s.target} = ${s.value}`;
  if (s.op === 'select') return `select ${s.target} = ${s.value}`;
  return `${s.op} ${s.target || s.value || ''}`.trim();
}

async function runCase(c, emit, shouldStop = () => false) {
  const t0 = Date.now();
  const res = { name: c.name, ok: true, checks: [], steps: [], errors: [], shot: '', ms: 0 };
  const fail = (kind, detail) => { res.ok = false; res.checks.push({ kind, ok: false, detail: String(detail || '').slice(0, 400) }); };
  const pass = (kind, detail) => res.checks.push({ kind, ok: true, detail: String(detail || '').slice(0, 200) });
  const budget = c.timeout_ms || 8000;

  // 每个用例从干净的控制台开始，否则上一条的报错会冤枉这一条
  await act('browser_console', { clear: true });

  if (c.url) {
    const r = await act('browser_open', { url: c.url });
    if (r.error) { fail('打开页面', r.error); res.ms = Date.now() - t0; return res; }
    pass('打开页面', c.url);
  }

  for (const s of c.steps) {
    if (shouldStop()) { fail('已停止', '用户中途停了这一轮'); break; }
    const mk = STEP_OP[s.op];
    if (!mk) { fail('步骤', `不认识的动作 ${s.op}`); continue; }
    const [tool, args] = mk(s);
    const r = await act(tool, args);
    if (r.error) { fail(`步骤 ${stepLabel(s)}`, r.error); }
    else res.steps.push(stepLabel(s));
    if (!r.ok) break;                    // 步骤断了再往下点没意义
  }

  if (c.wait_for) {
    const r = await act('browser_wait_for', { selector: c.wait_for, timeout_ms: budget });
    r.ok ? pass(`等待元素 ${c.wait_for}`, '') : fail(`等待元素 ${c.wait_for}`, r.error);
  }
  if (c.wait_text) {
    const r = await act('browser_wait_for', { text: c.wait_text, timeout_ms: budget });
    r.ok ? pass(`等待文本「${c.wait_text}」`, '') : fail(`等待文本「${c.wait_text}」`, r.error);
  }

  const needText = c.expect_text.length || c.expect_not.length;
  let pageText = '';
  if (needText) {
    const r = await act('browser_text', {});
    if (r.error) fail('读取正文', r.error); else pageText = r.text;
    for (const want of c.expect_text) {
      (pageText.includes(want) ? pass : fail)(`包含「${want}」`, pageText.includes(want) ? '' : '正文里没有这段');
    }
    for (const bad of c.expect_not) {
      (pageText.includes(bad) ? fail : pass)(`不包含「${bad}」`, pageText.includes(bad) ? `正文里出现了：…${pageText.split(bad)[0].slice(-40)}【${bad}】` : '');
    }
  }

  for (const sel of c.expect_selector) {
    const r = await act('browser_wait_for', { selector: sel, timeout_ms: budget });
    r.ok ? pass(`元素可见 ${sel}`, '') : fail(`元素可见 ${sel}`, r.error);
  }

  if (c.console_no_errors !== false) {
    const r = await act('browser_console', {});
    const errs = r.error ? [] : errorLinesOf(r.text);
    errs.length ? fail('控制台零错误', `${errs.length} 条：\n${errs.slice(0, 5).join('\n')}`) : pass('控制台零错误', '');
  }

  if ((!res.ok && c.screenshot !== '否' && c.screenshot !== false) || c.screenshot === true) {
    const r = await act('browser_screenshot', {});
    res.shot = r.ok ? shotPathOf(r.text) : '';
    if (!r.ok) res.errors.push(`截图失败：${r.error}`);
  }

  res.ms = Date.now() - t0;
  // 进度事件由 run() 统一发（它才知道 idx），这里不发免得重复
  return res;
}

/* ---------------- 失败诊断（可选，一次模型调用） ---------------- */

const MODEL_SELECT = `
  SELECT m.id AS row_id, m.model_id, m.display_name,
         p.base_url, p.api_key, p.proxy_enabled, p.proxy_host, p.proxy_port,
         p.api_style, p.max_tokens, p.custom
  FROM ai_models m JOIN ai_providers p ON m.provider_id = p.id
`;

function pickModel(hint) {
  const key = String(hint ?? '').trim();
  if (key) { const row = db.prepare(MODEL_SELECT + ' WHERE m.id = ? OR m.model_id = ? LIMIT 1').get(Number(key) || -1, key); if (row) return row; }
  return db.prepare(MODEL_SELECT + ' ORDER BY m.id ASC LIMIT 1').get() || null;
}

async function askOnce(row, messages) {
  const req = protocols.buildChatRequest(row, { model: row.model_id, messages, stream: false });
  let dispatcher;
  if (row.proxy_enabled && row.proxy_host) {
    try { const { ProxyAgent } = require('undici'); dispatcher = new ProxyAgent(`http://${row.proxy_host}:${row.proxy_port}`); } catch (e) { /* 没代理就用直连 */ }
  }
  const resp = await fetch(req.url, { method: req.method, headers: req.headers, body: JSON.stringify(req.body), dispatcher, signal: AbortSignal.timeout(60000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 160)}`);
  const norm = protocols.normalizeReply(row, await resp.json());
  return String(norm?.choices?.[0]?.message?.content || '').trim();
}

/** 给失败用例写一句人话诊断。任何一步不成都不能影响报告本身。 */
async function diagnoseWith(cases, modelRowId) {
  const failed = cases.filter((c) => !c.ok).slice(0, MAX_DIAGNOSE);
  if (!failed.length) return;
  const row = pickModel(modelRowId);
  if (!row) return;
  for (const c of failed) {
    const bad = c.checks.filter((k) => !k.ok).map((k) => `- ${k.kind}${k.detail ? '：' + k.detail : ''}`).join('\n');
    try {
      const text = await askOnce(row, [
        { role: 'system', content: '你是网页自测的读报告助手。用户给你一个失败的验收用例和它的失败断言，你只写 1-2 句最可能的原因和下一步该查什么。不要建议改代码之外的花活，不要复述断言。中文。' },
        { role: 'user', content: `用例：${c.name}\n失败断言：\n${bad}\n步骤：${c.steps.join(' → ') || '（无）'}${c.shot ? `\n截图：${c.shot}` : ''}` },
      ]);
      if (text) c.diag = text.slice(0, 400);
    } catch (e) { /* 诊断是加分项，失败就算了 */ }
  }
}

/* ---------------- 报告与落库 ---------------- */

function ensureTable() {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS ai_supervise_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      root TEXT NOT NULL DEFAULT '',
      file TEXT NOT NULL DEFAULT '',
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      finished_at DATETIME,
      total INTEGER DEFAULT 0,
      passed INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0,
      report_path TEXT NOT NULL DEFAULT '',
      results_json TEXT NOT NULL DEFAULT '[]'
    )`).run();
  } catch (e) { /* 建表失败时按空处理 */ }
}

function reportPathOf(startedAt) {
  const dir = path.join(DATA_DIR, 'supervise');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* 目录已存在 */ }
  const d = new Date(startedAt);
  // 秒级时间戳会撞车：两轮在同一秒收尾时，后一份报告会把前一份直接盖掉
  const stamp = d.toISOString().replace(/[-:T]/g, '').slice(0, 14)
    + String(d.getMilliseconds()).padStart(3, '0')
    + '-' + Math.random().toString(36).slice(2, 6);
  return path.join(dir, `run-${stamp}.md`);
}

function renderReport({ root, file, startedAt, cases, ms }) {
  const passed = cases.filter((c) => c.ok).length;
  const lines = [
    '# 监工报告',
    '',
    `- 清单：\`${file}\``,
    `- 项目：\`${root}\``,
    `- 时间：${new Date(startedAt).toLocaleString('zh-CN')}　耗时 ${(ms / 1000).toFixed(1)}s`,
    `- 结果：**${passed} 通过 / ${cases.length - passed} 失败**（共 ${cases.length} 项）`,
    '',
  ];
  for (const c of cases) {
    lines.push(`## ${c.ok ? '✅' : '❌'} ${c.name}`, '');
    for (const k of c.checks) lines.push(`- ${k.ok ? '✓' : '✗'} ${k.kind}${k.detail ? ` — ${k.detail}` : ''}`);
    if (c.steps.length) lines.push(`- 步骤：${c.steps.join(' → ')}`);
    if (c.diag) lines.push(`- 诊断：${c.diag}`);
    if (c.shot) lines.push(`- 证据截图：\`${c.shot}\``);
    for (const e of c.errors || []) lines.push(`- 备注：${e}`);
    lines.push('');
  }
  return lines.join('\n');
}

function listRuns(limit = 20) {
  ensureTable();
  try {
    return db.prepare('SELECT id, root, file, started_at, finished_at, total, passed, failed, report_path FROM ai_supervise_runs ORDER BY id DESC LIMIT ?').all(limit);
  } catch (e) { return []; }
}

/* ---------------- 主流程 ---------------- */

/**
 * 跑一轮监工。onEvent 收 { t:'start'|'case_start'|'case_done'|'done'|'error', ... }。
 * 只读：它不动任何文件（除了往 DATA_DIR 写报告和截图）。
 */
async function run({ projectRoot, cwd, modelRowId, diagnose = true, onEvent = () => {}, shouldStop = () => false } = {}) {
  const emit = (e) => { try { onEvent(e); } catch (err) { /* 流断了不影响跑 */ } };
  const info = checks.load({ projectRoot, cwd });
  if (!info.exists) {
    const msg = `没找到 ${checks.FILE_NAME}（找过：${info.file}）。在项目根建一个，每个 ## 是一个用例。`;
    emit({ t: 'error', message: msg, hint: checks.TEMPLATE });
    return { error: msg, hint: checks.TEMPLATE };
  }
  if (!info.cases.length) {
    const msg = `${checks.FILE_NAME} 里没有可跑的用例${info.errors.length ? `（${info.errors.length} 处格式问题）` : ''}`;
    emit({ t: 'error', message: msg, errors: info.errors });
    return { error: msg, errors: info.errors, file: info.file };
  }
  if (!inapp.clientOnline()) {
    const msg = '内置浏览器不在：监工靠桌面端右栏那个页面跑。请开着 KHarness 桌面端（这一项只在桌面端可用）。';
    emit({ t: 'error', message: msg });
    return { error: msg, file: info.file };
  }

  ensureTable();
  const startedAt = Date.now();
  emit({ t: 'start', file: info.file, total: info.cases.length, errors: info.errors });

  const cases = [];
  let stopped = false;
  for (let i = 0; i < info.cases.length; i += 1) {
    if (shouldStop()) { stopped = true; break; }
    const c = info.cases[i];
    emit({ t: 'case_start', idx: i, name: c.name, url: c.url });
    let res;
    try {
      res = await runCase(c, emit, shouldStop);
    } catch (e) {
      // 兜底结果也走下面同一个 emit，别在这里再发一遍（会重复一条）
      res = { name: c.name, ok: false, checks: [{ kind: '执行', ok: false, detail: String(e?.message || e) }], steps: [], errors: [], shot: '', ms: 0 };
    }
    res.idx = i;
    cases.push(res);
    emit({ t: 'case_done', idx: i, name: res.name, ok: res.ok, ms: res.ms, checks: res.checks, shot: res.shot, steps: res.steps });
  }

  if (diagnose && !stopped) await diagnoseWith(cases, modelRowId);

  const ms = Date.now() - startedAt;
  const failed = cases.filter((c) => !c.ok);
  const report = renderReport({ root: projectRoot || cwd || info.dir || '', file: info.file, startedAt, cases, ms });
  const rp = reportPathOf(startedAt);
  let written = true;
  try { fs.writeFileSync(rp, report, 'utf8'); } catch (e) { written = false; }

  try {
    db.prepare(`INSERT INTO ai_supervise_runs (root, file, started_at, finished_at, total, passed, failed, report_path, results_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(projectRoot || cwd || '', info.file, new Date(startedAt).toISOString().replace('T', ' ').slice(0, 19),
        new Date().toISOString().replace('T', ' ').slice(0, 19), cases.length, cases.length - failed.length, failed.length,
        written ? rp : '', JSON.stringify(cases.map((c) => ({ idx: c.idx, name: c.name, ok: c.ok, ms: c.ms, checks: c.checks, shot: c.shot, diag: c.diag || '' }))));
  } catch (e) { /* 记账失败不影响结果 */ }

  if (failed.length) {
    try { notify(`监工：${failed.length} 项没通过`, failed.map((f) => `· ${f.name}`).join('\n').slice(0, 240)); } catch (e) { /* 通知失败就算了 */ }
  }

  const summary = { t: 'done', stopped, total: cases.length, passed: cases.length - failed.length, failed: failed.length, ms, report: written ? rp : '', file: info.file, cases, parseErrors: info.errors };
  emit(summary);
  return summary;
}

module.exports = { run, listRuns, act, checks };
