// 验收清单解析：读项目根的 kh.checks.md，解析成监工能执行的用例。
//
// 为什么用文件而不是数据库：清单描述的是「这个项目的页面应该长什么样」，
// 它跟代码同源、要能 diff、要能跟着仓库走；换台机器不该就没了。
//
// 写法（键名中英文都行，值里的选择器按 CSS 原样写）：
//
//   ## 用例名
//   - url: http://127.0.0.1:5173/
//   - 等待: #app                 // 或 - 等待文本: 欢迎
//   - 步骤: type input[name="user"] = admin
//   - 步骤: click button[type="submit"]
//   - 包含: 我的项目              // 可重复
//   - 不包含: 出错了              // 可重复
//   - 元素可见: .dashboard        // 可重复
//   - 控制台无错: 是              // 默认就是「是」
//   - 截图: 失败时               // 是 / 否 / 失败时（默认）
//   - 超时: 15000
'use strict';

const fs = require('fs');
const path = require('path');

const FILE_NAME = 'kh.checks.md';

// 中英键名都收：模型和人写起来都不别扭
const KEY_MAP = [
  [['url', '地址', '网址'], 'url'],
  [['wait_for', '等待'], 'wait_for'],
  [['wait_text', '等待文本'], 'wait_text'],
  [['step', 'steps', '步骤'], 'steps'],
  [['expect_text', '包含'], 'expect_text'],
  [['expect_not', '不包含', '不得出现'], 'expect_not'],
  [['expect_selector', '元素可见'], 'expect_selector'],
  [['console_no_errors', '控制台无错'], 'console_no_errors'],
  [['screenshot', '截图'], 'screenshot'],
  [['timeout_ms', '超时'], 'timeout_ms'],
];

const LIST_KEYS = new Set(['steps', 'expect_text', 'expect_not', 'expect_selector']);
const CASE_KEYS = new Set(['url', 'wait_for', 'wait_text', 'timeout_ms']);

function normKey(raw) {
  const k = String(raw || '').trim().toLowerCase();
  for (const [aliases, canon] of KEY_MAP) if (aliases.includes(k)) return canon;
  return null;
}

function boolOf(v, line) {
  const s = String(v || '').trim().toLowerCase();
  if (['是', 'true', 'yes', 'y', '1', 'on'].includes(s)) return true;
  if (['否', 'false', 'no', 'n', '0', 'off'].includes(s)) return false;
  if (s === '失败时' || s === 'onfail' || s === 'on_fail') return 'onfail';
  return { error: `第 ${line} 行的值不是真假（可用：是 / 否 / 失败时）` };
}

/**
 * 步骤解析：`动作 目标 [= 值]`。
 * 目标里带空格的选择器不切（用引号也行），只按第一个空格分动作。
 */
function parseStep(raw, line) {
  const s = String(raw || '').trim();
  const sp = s.indexOf(' ');
  if (sp < 0) return { error: `第 ${line} 行步骤缺目标（写法：步骤: click .btn）` };
  const op = s.slice(0, sp).toLowerCase();
  let rest = s.slice(sp + 1).trim();
  const unquote = (v) => String(v).trim().replace(/^["'`]|["'`]$/g, '');
  if (['type', 'fill', '输入', 'select', '选择'].includes(op)) {
    // 选择器里也可能有 =（input[name=user]），所以优先按「空格 = 空格」切；
    // 注意切完要跳过整个 3 字符分隔符，别只跳一个 =（踩过：值会变成「= admin」）
    const spaced = rest.lastIndexOf(' = ');
    let target, value;
    if (spaced >= 0) { target = rest.slice(0, spaced); value = rest.slice(spaced + 3); }
    else {
      const eq = rest.indexOf('=');
      if (eq < 0) return { error: `第 ${line} 行 ${op} 需要「选择器 = 值」` };
      target = rest.slice(0, eq); value = rest.slice(eq + 1);
    }
    return { op: ['select', '选择'].includes(op) ? 'select' : 'type', target: unquote(target), value: unquote(value) };
  }
  const ALIAS = { click: 'click', 点: 'click', 点击: 'click', press: 'press', 按键: 'press', scroll: 'scroll', 滚动: 'scroll',
    open: 'open', 打开: 'open', goto: 'open', 跳转: 'open', wait: 'wait', 等待: 'wait', sleep: 'sleep', 停: 'sleep',
    reload: 'reload', 刷新: 'reload', back: 'back', 后退: 'back' };
  const canon = ALIAS[op];
  if (!canon) return { error: `第 ${line} 行不认识的动作「${op}」（可用：click / type / press / select / scroll / open / wait / sleep / reload / back）` };
  if (canon === 'sleep') return { op: 'sleep', value: Number(rest) || 1000 };
  if (canon === 'scroll') return { op: 'scroll', value: rest || 'down' };
  if (canon === 'wait') return { op: rest.startsWith('text=') ? 'wait_text' : 'wait', target: rest.startsWith('text=') ? rest.slice(5) : unquote(rest) };
  if (canon === 'open') return { op: 'open', target: unquote(rest) };
  if (canon === 'press') return { op: 'press', value: unquote(rest) };
  return { op: canon, target: unquote(rest) };
}

/** 解析清单正文。返回 { cases, errors }；errors 里每条都带行号。 */
function parse(text) {
  const lines = String(text || '').split(/\r?\n/);
  const cases = [];
  const errors = [];
  let cur = null;

  const openCase = (name, line) => {
    cur = { name: name || `用例 ${cases.length + 1}`, line, url: '', wait_for: '', wait_text: '', timeout_ms: 0,
      steps: [], expect_text: [], expect_not: [], expect_selector: [], console_no_errors: true, screenshot: 'onfail' };
    cases.push(cur);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const no = i + 1;
    const raw = lines[i];
    const line = raw.trim();
    if (!line || line.startsWith('# ')) continue;          // 空行与文件级标题
    if (line.startsWith('## ')) { openCase(line.slice(3).trim(), no); continue; }
    if (line.startsWith('<!--') || line.startsWith('>')) continue;
    const m = line.match(/^[-*]\s+(.*)$/);
    if (!m) {
      if (cur) continue;                                    // 用例外的散文忽略
      errors.push({ line: no, message: '这一行既不是用例标题也不是清单项，已忽略' });
      continue;
    }
    const body = m[1];
    if (!cur) { openCase('默认用例', no); }
    const colon = body.indexOf(':');
    const key = colon < 0 ? null : normKey(body.slice(0, colon));
    const val = colon < 0 ? '' : body.slice(colon + 1).trim();
    if (!key) {
      errors.push({ line: no, message: `不认识的键「${body.slice(0, colon < 0 ? body.length : colon)}」，可用：url / 等待 / 等待文本 / 步骤 / 包含 / 不包含 / 元素可见 / 控制台无错 / 截图 / 超时` });
      continue;
    }
    if (key === 'steps') {
      const st = parseStep(val, no);
      if (st.error) errors.push({ line: no, message: st.error }); else cur.steps.push(st);
      continue;
    }
    if (LIST_KEYS.has(key)) {
      if (!val) { errors.push({ line: no, message: `${key} 的值为空` }); continue; }
      cur[key].push(val);
      continue;
    }
    if (key === 'console_no_errors' || key === 'screenshot') {
      const b = boolOf(val, no);
      if (b && b.error) errors.push({ line: no, message: b.error }); else cur[key] = b;
      continue;
    }
    if (key === 'timeout_ms') {
      const n = Number(val);
      if (!Number.isFinite(n) || n <= 0) errors.push({ line: no, message: '超时得是正整数（毫秒）' }); else cur.timeout_ms = Math.min(n, 120000);
      continue;
    }
    if (CASE_KEYS.has(key)) { cur[key] = val; continue; }
    errors.push({ line: no, message: `${key} 还没支持` });
  }

  // 用例自身的完整性：没 url 又没步骤的没法跑；只有「控制台无错」这一条默认检查太弱
  const kept = [];
  for (const c of cases) {
    const need = [c.url, c.steps.length, c.wait_for, c.wait_text].some(Boolean);
    const asserts = c.expect_text.length || c.expect_not.length || c.expect_selector.length || c.wait_for || c.wait_text;
    if (!need) { errors.push({ line: c.line, message: `用例「${c.name}」没有 url 也没有步骤，跳过` }); continue; }
    if (!asserts) { errors.push({ line: c.line, message: `用例「${c.name}」只有默认的控制台检查，太弱：至少再加一条 包含 / 不包含 / 元素可见 / 等待` }); continue; }
    kept.push(c);
  }
  return { cases: kept, errors };
}

function rootOf({ projectRoot, cwd } = {}) {
  const guess = [projectRoot, cwd, process.cwd()].filter(Boolean);
  for (const dir of guess) {
    try {
      let p = path.resolve(dir);
      // 从给定目录往上找，最多 4 层：允许在子目录里工作而清单放在仓库根
      for (let i = 0; i < 5; i += 1) {
        const f = path.join(p, FILE_NAME);
        if (fs.existsSync(f)) return { file: f, dir: p };
        const parent = path.dirname(p);
        if (parent === p) break;
        p = parent;
      }
    } catch (e) { /* 目录不可访问就试下一个 */ }
  }
  const first = path.resolve(guess[0] || process.cwd());
  return { file: path.join(first, FILE_NAME), dir: first, missing: true };
}

/** 读并解析。文件不存在不算错：exists=false，由界面提示怎么写。 */
function load(ctx = {}) {
  const { file, dir, missing } = rootOf(ctx);
  if (missing) return { file, dir, exists: false, cases: [], errors: [] };
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { file, dir, exists: true, cases: [], errors: [{ line: 0, message: `读不了：${e.message}` }] }; }
  const { cases, errors } = parse(text);
  return { file, dir, exists: true, cases, errors, bytes: Buffer.byteLength(text) };
}

const TEMPLATE = `# 验收清单（监工跑这个文件）
#
# 每个 ## 是一个用例；键名中英文都行。
# 内置浏览器一次只有一个页面，所以用例是顺序跑的。

## 首页能打开
- url: http://127.0.0.1:5173/
- 等待: #app
- 包含: 首页
- 控制台无错: 是

## 主要按钮点得动
- url: http://127.0.0.1:5173/
- 步骤: click .primary-btn
- 等待文本: 提交成功
- 不包含: undefined
- 截图: 失败时
`;

module.exports = { load, parse, rootOf, FILE_NAME, TEMPLATE };
