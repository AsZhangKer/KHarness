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

// 估算 token（经验公式：CJK 约 0.6 tok/字，其余约 0.25 tok/字符；仅用于无 API 真实值时的兜底）
function estimateTokens(text) {
  const s = String(text || '');
  const cjk = (s.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) || []).length;
  return Math.ceil(cjk * 0.6 + (s.length - cjk) * 0.25);
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

/** 把收集到的文件拼成注入系统提示词的那段文本；一份都没有就回空串 */
function promptBlock(files) {
  const usable = (files || []).filter((f) => f && f.content);
  if (!usable.length) return '';
  const lines = ['[长期记忆：以下内容来自 AGENTS.md 文件（全局配置 + 项目/目录配置，就近覆盖），是项目背景、编码规范与业务约定，必须遵守]'];
  for (const f of usable) lines.push(`<<AGENTS.md：${f.scope}（${f.path}）>>\n${f.content}`);
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
};
