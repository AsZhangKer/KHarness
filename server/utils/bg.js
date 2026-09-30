// 后台任务：让长命令（dev server / watch / 构建）异步于 AI 主循环运行，不阻塞对话。
// 与 run_command 共用 shellcmd 的 Shell 拼参逻辑；进程一律登记进 procguard，只允许本模块杀自己起的树。
// 注意：任务表在内存里，服务重启即失联（退出时会统一清理），不跨重启恢复。
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { buildShell } = require('./shellcmd');
const procguard = require('./procguard');

const BG_DIR = path.join(os.tmpdir(), 'kh-bg');
const MAX_TASKS = 50;            // 超过则淘汰最久的已结束任务
const KEEP_MS = 24 * 3600 * 1000; // 已结束任务保留 24 小时
const TAIL_LINES = 400;          // 内存里为每个任务留最后 N 行用于 status 输出

const tasks = new Map(); // id -> task
let seq = 0;

function newId() {
  seq += 1;
  return `bg-${Date.now().toString(36)}-${seq}`;
}

function prune() {
  if (tasks.size <= MAX_TASKS) return;
  const done = [...tasks.values()].filter(t => t.state !== 'running').sort((a, b) => a.startedAt - b.startedAt);
  while (tasks.size > MAX_TASKS && done.length) {
    const t = done.shift();
    tasks.delete(t.id);
    fsp.unlink(t.log).catch(() => {});
  }
}

// 中文 Windows 上 ping / findstr / 各类 .bat 输出的是 OEM 代码页（GBK），按 UTF-8 解会成乱码。
// 与 routes/ai.js 的文件解码同一套规则：严格 UTF-8 解失败 → 回退 GBK。日志文件仍按原始字节落盘。
const DEC_UTF8_STRICT = (() => { try { return new TextDecoder('utf-8', { fatal: true }); } catch (e) { return null; } })();
const DEC_UTF8 = (() => { try { return new TextDecoder('utf-8'); } catch (e) { return null; } })();
const DEC_GBK = (() => { try { return new TextDecoder('gbk'); } catch (e) { return null; } })();

function decodeChunk(buf) {
  if (DEC_UTF8_STRICT) {
    try { return DEC_UTF8_STRICT.decode(buf); } catch (e) { /* 不是合法 UTF-8，按 GBK 再解 */ }
  }
  if (DEC_GBK) {
    try { return DEC_GBK.decode(buf); } catch (e) { /* GBK 也不行，兜底 */ }
  }
  return (DEC_UTF8 || { decode: (b) => b.toString('utf8') }).decode(buf);
}

function appendTail(t, chunk) {
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const text = decodeChunk(buf);
  t.bytes += buf.length;
  for (const line of text.split(/(?<=\n)/)) {
    if (!line) continue;
    t.tail.push(line.replace(/\r?\n?$/, ''));
  }
  while (t.tail.length > TAIL_LINES) t.tail.shift();
  if (t.stream) { try { t.stream.write(chunk); } catch (e) { /* 日志文件写失败不影响任务 */ } }
}

// 返回 { id, pid, log } 或 { error }
function start(command, cwd) {
  const cmd = String(command || '').trim();
  if (!cmd) return { error: 'run_background:command 不能为空' };
  prune();
  const id = newId();
  let stream = null;
  let log = path.join(BG_DIR, `${id}.log`);
  try {
    fs.mkdirSync(BG_DIR, { recursive: true });
    stream = fs.createWriteStream(log, { flags: 'a' });
  } catch (e) {
    return { error: `run_background:无法创建日志文件：${String(e.message || e).substring(0, 160)}` };
  }
  const sh = buildShell(cmd);
  const opts = { cwd: cwd || process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
  // POSIX 用 detached 让子进程自成进程组，超时可整组回收；Windows 靠 taskkill /T
  if (process.platform !== 'win32') opts.detached = true;
  let child;
  try {
    child = sh ? spawn(sh.file, sh.args, opts) : spawn(cmd, { ...opts, shell: true });
  } catch (e) {
    try { stream.end(); } catch (e2) {}
    return { error: `run_background:启动失败：${String(e.message || e).substring(0, 200)}` };
  }
  const task = {
    id, command: cmd, cwd: opts.cwd, pid: child.pid, state: 'running', exitCode: null, signal: null,
    startedAt: Date.now(), endedAt: 0, log, tail: [], bytes: 0, stream, child, killed: false
  };
  tasks.set(id, task);
  procguard.claim(child.pid, sh ? sh.image : (process.platform === 'win32' ? 'cmd.exe' : 'sh'), id);
  child.stdout && child.stdout.on('data', c => appendTail(task, c));
  child.stderr && child.stderr.on('data', c => appendTail(task, c));
  child.on('error', (e) => {
    task.state = 'failed';
    task.endedAt = Date.now();
    appendTail(`\n[启动错误] ${String(e.message || e)}\n`);
    try { stream.end(); } catch (e2) {}
    task.stream = null;
    procguard.release(child.pid);
  });
  child.on('close', (code, signal) => {
    task.exitCode = code;
    task.signal = signal || null;
    task.state = task.killed ? 'killed' : (code === 0 ? 'exited' : 'exited-error');
    task.endedAt = Date.now();
    try { stream.end(); } catch (e) {}
    task.stream = null;
    procguard.release(child.pid);
  });
  if (typeof child.unref === 'function') { try { child.unref(); } catch (e) {} }
  return { id, pid: child.pid, log, shell: sh ? path.basename(sh.file) : '系统默认' };
}

function runtimeText(t) {
  const ms = (t.endedAt || Date.now()) - t.startedAt;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
}

const STATE_TEXT = {
  running: '运行中', exited: '已退出（码 0）', 'exited-error': '已退出（非 0）', killed: '已被终止', failed: '启动失败'
};

function brief(t) {
  return { id: t.id, pid: t.pid, state: STATE_TEXT[t.state] || t.state, runtime: runtimeText(t), exit: t.exitCode, command: t.command };
}

function status(id, tailLines) {
  const t = tasks.get(String(id || '').trim());
  if (!t) return { error: `background_status:找不到任务「${id}」。用 background_list 看当前有哪些任务（注意：服务重启后旧任务不保留）。` };
  const n = Math.min(Math.max(parseInt(tailLines) || 100, 1), TAIL_LINES);
  const body = t.tail.slice(-n).join('\n');
  return {
    output: [
      `任务 ${t.id}：${STATE_TEXT[t.state] || t.state} · PID ${t.pid} · 已运行 ${runtimeText(t)}`,
      `命令：${t.command}`,
      `工作目录：${t.cwd}`,
      `完整日志：${t.log}（已写 ${t.bytes} 字节；此处只显示最后 ${Math.min(n, t.tail.length)} 行）`,
      '',
      body || '(暂无输出)'
    ].join('\n'),
    raw: Object.assign(brief(t), { log: t.log, bytes: t.bytes })
  };
}

function list() {
  const rows = [...tasks.values()].sort((a, b) => b.startedAt - a.startedAt).map(brief);
  if (!rows.length) return { output: '当前没有后台任务（后台任务不跨服务重启）。用 run_background 启动一个：dev server、watch、长时间构建等。' };
  const running = rows.filter(r => r.state === '运行中').length;
  const lines = [`共 ${rows.length} 个后台任务（运行中 ${running} 个）：`];
  for (const r of rows) lines.push(`- ${r.id} · ${r.state} · PID ${r.pid} · ${r.runtime} · ${r.command.length > 70 ? r.command.substring(0, 70) + '…' : r.command}`);
  lines.push('', '查详情用 background_status(handle)，终止用 background_kill(handle)。');
  return { output: lines.join('\n') };
}

async function kill(id) {
  const t = tasks.get(String(id || '').trim());
  if (!t) return { error: `background_kill:找不到任务「${id}」。先 background_list 确认 handle。` };
  if (t.state !== 'running') return { output: `任务 ${t.id} 已经是「${STATE_TEXT[t.state] || t.state}」状态，无需终止。` };
  t.killed = true;
  const r = await procguard.killTree(t.pid);
  // 兜底：树杀不成时至少让本进程退出（同一 PID，仍受 procguard 校验保护）
  if (!r.ok && t.child) { try { t.child.kill('SIGKILL'); } catch (e) {} }
  if (!r.ok) return { error: `background_kill:${r.note}` };
  return { output: `已请求终止任务 ${t.id}（PID ${t.pid}）。${r.note}。状态：${r.method}` };
}

// 服务退出时统一清理，避免留下孤儿进程
function shutdownAll() {
  for (const t of tasks.values()) {
    if (t.state !== 'running') continue;
    t.killed = true;
    procguard.killTree(t.pid).catch(() => {});
  }
}

module.exports = { start, status, list, kill, shutdownAll, tasks, BG_DIR, TAIL_LINES };
