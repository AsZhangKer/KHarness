/**
 * AGENTS.md / AGENT.md —— 静态长期记忆（系统提示词的一部分）
 *
 * 从 routes/ai.js 抽出来的原因：这条链原本只有主聊天路在用，侧栏提问 / 托管工作者 / 子智能体
 * 三条各自另写了系统提示词，等于「同一台机器上有的对话听得懂全局规矩、有的听不懂」。
 * 抽成工具层后四条路共用一份，设置页的「编辑全局提示词」和项目右键菜单的「编辑系统提示词」
 * 也复用同一套路径解析，不会出现「界面改的文件和模型读的文件不是同一个」。
 *
 * 位置与优先级（叠加注入，就近的排后面）：
 *   1. 全局：~/.kharness/AGENTS.md（或 AGENT.md）—— 所有本机会话生效
 *   2. 项目：<项目根>/AGENTS.md（或 AGENT.md）—— 项目会话，叠加在全局之后
 *   3. 自由会话：<当前工作目录>/AGENTS.md —— 按 cwd 就近
 * 远程会话只取远端那一份（本机全局份讲的是另一台机器的规矩，注入进来会把模型带偏）。
 *
 * 文件名两种都认，AGENTS.md 优先（兼容 OpenCode 的约定）；都不存在时新建用 AGENTS.md。
 * 刷新：每次调用模型前重读并校验 SHA-256（改了立刻生效，不用重启）；单文件 200KB 上限，超限跳过并提示。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const userdir = require('./userdir');
const remoteUtil = require('./remote');

const AGENTS_MD_MAX_BYTES = 200 * 1024;
const NAMES = ['AGENTS.md', 'AGENT.md'];
const agentsMdCache = new Map(); // file -> { hash, content }

function globalDir() {
  return path.join(os.homedir(), '.kharness');
}

/** 自由会话没给 cwd 时的兜底目录：与聊天路同一个「用户桌面」，别另猜一套 */
function defaultCwd() {
  return userdir.desktop();
}

function loadAgentsMd(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    if (st.size > AGENTS_MD_MAX_BYTES) return { content: '', skipped: `文件过大（${Math.round(st.size / 1024)}KB，上限 200KB，已跳过）` };
    const content = fs.readFileSync(file, 'utf8');
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    const cached = agentsMdCache.get(file);
    if (cached && cached.hash === hash) return { ...cached, fresh: true };
    const entry = { hash, content };
    agentsMdCache.set(file, entry);
    return entry;
  } catch (e) {
    return null;
  }
}

function loadAgentsMdWithFallback(dir) {
  for (const name of NAMES) {
    const p = path.join(dir, name);
    const r = loadAgentsMd(p);
    if (r) return { file: p, data: r };
  }
  return null;
}

/**
 * 这个目录里「该编辑哪一个文件」：已存在的那种优先，都没有就回 AGENTS.md（新建用它）。
 * opts.create=true 时目录不存在会顺手建出来 —— 全局那份（~/.kharness）本来就该由我们自己兜底，
 * 第一次用还没这个目录是常态；项目根则相反，目录没了是真出问题，要报出去而不是凭空建一个。
 */
function resolveAgentsFile(dir, opts = {}) {
  const d = String(dir || '').trim();
  if (!d) return null;
  let isDir = false;
  try { isDir = fs.existsSync(d) && fs.statSync(d).isDirectory(); } catch (e) { isDir = false; }
  if (!isDir) {
    if (!opts.create) return null;
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { return null; }
  }
  for (const name of NAMES) {
    const p = path.join(d, name);
    try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch (e) { /* 当不存在 */ }
  }
  return path.join(d, NAMES[0]);
}

// 估算 token：口径「宁多不少」（主人定的）。中文按 1 tok/字、其余按 0.3 tok/字符 —— 各 tokenizer
// 对中文普遍落在 0.6~1.2 之间，取 0.6 会低估整包、让界面显示个位数百分比而模型那边已经撑爆。
// 估高一点的代价是提前压缩（少烧一点上下文精度），估低了是直接报错罢工，两害取其轻。
function estimateTokens(text) {
  const s = String(text || '');
  const cjk = (s.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  return Math.ceil(cjk * 1 + (s.length - cjk) * 0.3);
}

/**
 * 本机某会话适用的 AGENTS.md：全局兜底 + 项目根（项目会话）/ 工作目录（自由会话）。
 * 两份都读得到就都注入（就近那份排在后面，模型按「后说的优先」理解）。
 */
function collect(projectRoot, cwd) {
  const gDir = globalDir();
  const scopedDir = projectRoot ? projectRoot : (cwd || defaultCwd());
  const files = [];
  const g = loadAgentsMdWithFallback(gDir);
  if (g) files.push({ scope: '全局', path: g.file, ...g.data, tokens: estimateTokens(g.data.content) });
  const s = loadAgentsMdWithFallback(scopedDir);
  if (s && s.file !== (g ? g.file : null)) {
    files.push({ scope: projectRoot ? '项目' : '目录', path: s.file, ...s.data, tokens: estimateTokens(s.data.content) });
  }
  return files;
}

/** 远程会话的那一份：只从远端读，全局份跳过（见文件头注释） */
async function collectRemote(hostRow, projectRoot, cwd) {
  const base = projectRoot || cwd;
  if (!base) return [];
  const out = [];
  for (const name of NAMES) {
    const p = remoteUtil.posixPath(`${String(base).replace(/\/+$/, '')}/${name}`);
    try {
      const buf = await remoteUtil.sftp.readFile(hostRow, p);
      const content = buf.toString('utf8').substring(0, AGENTS_MD_MAX_BYTES);
      out.push({
        scope: projectRoot ? '远端项目' : '远端目录', path: p, content,
        hash: crypto.createHash('sha256').update(content).digest('hex'),
        tokens: estimateTokens(content),
      });
      break;   // AGENTS.md 优先，命中就不看别名
    } catch (e) { /* 远端没有这份文件，试下一个名字 */ }
  }
  return out;
}

/* ── 提示词占位符 ──────────────────────────────────────────────────────────
   主人写在 AGENTS.md 里的这几个记号，注入系统提示词时会被换成当下的真值：
     {cwd}   完整绝对工作目录（到了某个会话/项目自适应）
     {time}  hh:mm:ss
     {date}  yyyy/mm/dd
     {os}    当前系统（平台 + 架构 + 内核版本）
   **只在注入那一刻替换**，磁盘上的文件一个字节都不动 —— 编辑器里看到的是原文（带占位符），
   模型看到的是展开后的值。这也是为什么不能把替换写进 read()/write()：那样用户每开一次编辑器，
   文件就被"定格"成当次的路径与时间，换台机器 / 换个会话就全是过期的假值。

   只做这四个（主人点名的），**不是**通用模板引擎：宁可少而准，也不引入一个会跟用户文本打架的语法。
   想写一个字面量的 {cwd}（要教模型这个记号本身），写成 {{cwd}} 即可。 */
const VAR_KEYS = ['cwd', 'time', 'date', 'os'];

const pad2 = (n) => String(n).padStart(2, '0');

/** 平台人话名（{os} 用）。认不出来就回 process.platform 本身，不猜。 */
function osLabel() {
  const p = process.platform;
  const arch = process.arch;
  const base = p === 'win32' ? 'Windows' : p === 'darwin' ? 'macOS' : p === 'linux' ? 'Linux' : p;
  // release 在 Windows 上是内核版本（10.0.26100 这种），在 Linux 上是内核版本号：
  // 都留着 —— 模型判断"能不能用某个命令/特性"时，这串比一句笼统的"Windows"有用得多。
  let rel = '';
  try { rel = String(os.release() || '').trim(); } catch (e) { rel = ''; }
  return `${base}（${p}${rel ? ' · ' + rel : ''} · ${arch}）`;
}

/** 这一次注入的变量快照（时间取调用当刻，所以每一轮都是新的） */
function promptVars(cwd, now = new Date()) {
  return {
    cwd: String(cwd || ''),
    time: `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`,
    date: `${now.getFullYear()}/${pad2(now.getMonth() + 1)}/${pad2(now.getDate())}`,
    os: osLabel(),
  };
}

/**
 * 展开占位符。规则：
 *   1) 先保护转义的 {{key}}（换成一个不可能出现在正文里的哨兵），最后再还原成字面 {key}
 *   2) 只替换白名单里的四个键 —— 别的 {xxx} 原样留着（用户写 JSON 示例、写模板都别掺和）
 *   3) {cwd} 拿不到值（调用方没给）时**保留占位符原文**，不换成空串：
 *      换成空串会让「工作目录是 」出现在提示词里，看着像正经信息，其实是坏的
 */
function renderVars(text, vars) {
  const s = String(text == null ? '' : text);
  if (!s || s.indexOf('{') === -1) return s;
  const v = vars || {};
  const sentinel = '\u0000KHESC';
  let out = s.replace(/\{\{(cwd|time|date|os)\}\}/g, (_m, k) => `${sentinel}${k}\u0000`);
  out = out.replace(/\{(cwd|time|date|os)\}/g, (m, k) => {
    const val = v[k];
    return (val === undefined || val === null || val === '') ? m : String(val);
  });
  return out.replace(new RegExp(`${sentinel}(cwd|time|date|os)\u0000`, 'g'), (_m, k) => `{${k}}`);
}

/**
 * 把收集到的文件拼成注入系统提示词的那段文本；一份都没有就回空串。
 * vars 见上面 promptVars：**必须由调用方带上当前会话的 cwd**，否则 {cwd} 会原样留在提示词里。
 */
function promptBlock(files, vars) {
  const usable = (files || []).filter((f) => f && f.content);
  if (!usable.length) return '';
  const v = vars || {};
  const lines = ['[长期记忆：以下内容来自 AGENTS.md 文件（全局配置 + 项目/目录配置，就近覆盖），是项目背景、编码规范与业务约定，必须遵守]'];
  for (const f of usable) lines.push(`<<AGENTS.md：${f.scope}（${f.path}）>>\n${renderVars(f.content, v)}`);
  return lines.join('\n');
}

/** 读一份提示词；文件还不存在不算错（编辑器要能开着写第一版） */
function read(file) {
  let exists = false;
  try { exists = fs.existsSync(file) && fs.statSync(file).isFile(); } catch (e) { exists = false; }
  if (!exists) return { exists: false, content: '', bytes: 0 };
  try {
    const content = fs.readFileSync(file, 'utf8');
    return { exists: true, content, bytes: Buffer.byteLength(content, 'utf8') };
  } catch (e) {
    return { exists: true, content: '', bytes: 0 };   // 存在但读不动：让界面开着，保存时会真报错
  }
}

/** 落盘（原子写：先写 .tmp 再 rename，避免半截文件被下一次读走） */
function write(file, content) {
  const text = String(content == null ? '' : content);
  if (Buffer.byteLength(text, 'utf8') > AGENTS_MD_MAX_BYTES) {
    throw new Error(`内容 ${Math.round(Buffer.byteLength(text, 'utf8') / 1024)}KB，超过 200KB 上限`);
  }
  const tmp = `${file}.kh-tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // 跨设备 rename 只会回一个笼统的 Failure：退化成覆盖写，别把整件事判死
    try { fs.copyFileSync(tmp, file); fs.unlinkSync(tmp); } catch (e2) { throw new Error(`写入失败：${e2.message || e2}`); }
  }
  agentsMdCache.delete(file);   // 缓存按哈希判新，删掉让下一次必读新内容
  return { bytes: Buffer.byteLength(text, 'utf8'), tokens: estimateTokens(text) };
}

module.exports = {
  AGENTS_MD_MAX_BYTES, NAMES, globalDir, defaultCwd,
  loadAgentsMd, loadAgentsMdWithFallback, resolveAgentsFile, estimateTokens,
  collect, collectRemote, promptBlock, read, write,
  VAR_KEYS, promptVars, renderVars, osLabel,
};
