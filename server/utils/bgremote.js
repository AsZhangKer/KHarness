/**
 * 远端后台任务：与 utils/bg.js 同一套 handle / status / list / kill 语义，
 * 但进程起在远端 —— 远程会话里模型说「起个 dev server」，那台机器上才该多出这个进程。
 *
 * 为什么不用本机 spawn 转发：本机起的进程连的是本机的 node/端口/文件系统，
 * 对远程项目来说基本没用（构建产物落在本机，端口也占在本机），是「看着能跑其实跑错地方」。
 *
 * 实现约束（都写进返回值，让模型知道差异）：
 *  - 远端没有我们的进程树回收器（procguard 认的是本机 PID），所以 kill 用 `kill` + `kill -9` 两级，
 *    并明确提示「孤儿进程要自己去那台机器上 kill」；
 *  - 日志落在远端 ~/.kh-bg/<handle>.log（家目录没探到就退到 /tmp/.kh-bg），status 用 tail 取尾部；
 *  - 注册表在内存，与本机 bg 一样不跨重启恢复。
 */
const crypto = require('crypto');
const remote = require('./remote');

const tasks = new Map();   // handle -> { hostId, pid, log, cmd, cwd, startedAt }

function bgRoot(host) {
  const home = remote.posixPath(host.home || host.default_cwd || '/tmp').replace(/\/+$/, '');
  return `${home || '/tmp'}/.kh-bg`;
}

async function start(host, command, cwd) {
  const cmd = String(command || '').trim();
  if (!cmd) return { error: 'run_background:command 不能为空' };
  const handle = `bg-${crypto.randomBytes(4).toString('hex')}`;
  const root = bgRoot(host);
  const log = `${root}/${handle}.log`;
  // cwd 只认远端路径：漏进本机 Windows 路径的话，nohup 前面的 cd 就会在远端报不存在
  const looksLocal = /^[A-Za-z]:/.test(String(cwd || '')) || String(cwd || '').includes('\\');
  const dir = remote.posixPath((looksLocal ? '' : cwd) || host.default_cwd || host.home || '/');
  // nohup + </dev/null + & 才能从 SSH exec 里活下来；echo $! 拿远端 PID
  const inner = `cd ${remote.shellQuote(dir)} && (${cmd})`;
  const full = `mkdir -p ${remote.shellQuote(root)} && nohup sh -c ${remote.shellQuote(inner)} </dev/null >${remote.shellQuote(log)} 2>&1 & echo $!`;
  const r = await remote.runRemoteCommand(host, full, { timeoutMs: 30000 });
  if (r.error) return { error: r.error };
  const m = /(\d+)\s*$/.exec(String(r.output || '').trim().split('\n').pop() || '');
  if (!m) return { error: `远端后台任务起不来（没拿到 PID）。远端回包：${String(r.output).slice(0, 300)}` };
  const rec = { hostId: host.id, pid: Number(m[1]), log, cmd, cwd: dir, startedAt: Date.now() };
  tasks.set(handle, rec);
  return { id: handle, pid: rec.pid, log, cwd: dir, shell: `远端 sh（${host.username}@${host.host}）` };
}

async function status(host, handle, tail) {
  const rec = tasks.get(String(handle));
  if (!rec) return { error: `background_status:没有这个远端任务（handle=${handle}）。它可能随服务重启丢了，或本来就是本机任务 —— 用 background_list 看全部。` };
  const n = Math.min(Math.max(parseInt(tail) || 100, 1), 400);
  const script = `if kill -0 ${rec.pid} 2>/dev/null; then echo STATE=RUNNING; else echo STATE=EXITED; fi; echo "---- 输出尾部 ----"; tail -n ${n} ${remote.shellQuote(rec.log)} 2>/dev/null || echo '(还没有输出)'`;
  const r = await remote.runRemoteCommand(host, script, { timeoutMs: 30000 });
  if (r.error) return { error: r.error };
  const out = String(r.output || '');
  const running = /STATE=RUNNING/.test(out);
  const body = out.replace(/^STATE=\w+\n?/, '');
  return {
    output: `远端任务 ${handle} · ${running ? '运行中' : '已退出'} · PID ${rec.pid} · 已跑 ${Math.round((Date.now() - rec.startedAt) / 1000)} 秒 · 命令：${rec.cmd}\n日志：${rec.log}\n${body}`.trim(),
    running,
    handle: String(handle),
    pid: rec.pid,
    log: rec.log,
    remote: true,
  };
}

async function list(host) {
  const mine = [...tasks.entries()].filter(([, r]) => r.hostId === host.id);
  if (!mine.length) return { output: `那台机器上没有本服务启动的远端后台任务（handle 在内存里，服务重启就清了）。` };
  const ids = mine.map(([, r]) => r.pid).join(' ');
  const r = await remote.runRemoteCommand(host, `ps -o pid=,etime=,args= -p ${ids} 2>/dev/null || true`, { timeoutMs: 20000 });
  const alive = new Set(String((r && r.output) || '').split('\n').map((l) => (l.trim().split(/\s+/)[0] || '')).filter(Boolean));
  const rows = mine.map(([handle, rec]) => {
    const running = alive.has(String(rec.pid));
    return `${handle}  ${running ? '运行中' : '已退出'}  PID ${rec.pid}  已跑 ${Math.round((Date.now() - rec.startedAt) / 1000)}s  ${rec.cmd.slice(0, 90)}`;
  });
  return { output: `远端后台任务（${host.username}@${host.host}）：\n${rows.join('\n')}` };
}

async function kill(host, handle) {
  const rec = tasks.get(String(handle));
  if (!rec) return { error: `background_kill:没有这个远端任务（handle=${handle}）。` };
  const script = `kill ${rec.pid} 2>/dev/null; sleep 1; if kill -0 ${rec.pid} 2>/dev/null; then kill -9 ${rec.pid} 2>/dev/null; sleep 1; fi; if kill -0 ${rec.pid} 2>/dev/null; then echo STILL_ALIVE; else echo GONE; fi`;
  const r = await remote.runRemoteCommand(host, script, { timeoutMs: 30000 });
  if (r.error) return { error: r.error };
  const gone = /GONE/.test(String(r.output || ''));
  tasks.delete(String(handle));
  return {
    output: gone
      ? `已终止远端任务 ${handle}（PID ${rec.pid} 已不在）。`
      : `已发过 kill 但 PID ${rec.pid} 还在（可能它自己 fork 了子进程）。远端没有本机的进程树回收器，需要的话去那台机器上 ` + '`pkill -P ' + rec.pid + '`' + ' 或直接 kill。',
  };
}

/** 这个 handle 是不是远端任务（决定 status/kill 走哪条路） */
function owns(handle) {
  return tasks.has(String(handle));
}

function hostOf(handle) {
  const rec = tasks.get(String(handle));
  if (!rec) return null;
  return db_host(rec.hostId);
}

function db_host(id) {
  try {
    const { db } = require('../database');
    return db.prepare('SELECT * FROM ai_remote_hosts WHERE id = ?').get(Number(id)) || null;
  } catch (e) {
    return null;
  }
}

module.exports = { start, status, list, kill, owns, hostOf, bgRoot };
