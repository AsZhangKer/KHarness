// 安全杀进程树：只允许杀「本进程亲自起过、并且现在还是那个镜像」的 PID。
// 为什么这么严：超时杀树是异步发生的，原始 cmd.exe 可能已经退出、PID 被 Windows 回收给别的进程，
// 直接 taskkill /T 会误杀无关进程（极端情况下就是系统进程）。所以三道闸：
//   1) PID 必须是 claim() 登记过的（我们起的）；
//   2) 系统关键 PID（0/1/自身/父进程）一律拒绝；
//   3) 动手前用 tasklist 复核该 PID 的镜像名与登记时一致，不一致就放弃并说明原因。
const { execFile } = require('child_process');

const owned = new Map(); // pid -> { image, startedAt, label }

function isWin() { return process.platform === 'win32'; }

function claim(pid, image, label) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 1) return false;
  owned.set(n, { image: String(image || '').toLowerCase(), startedAt: Date.now(), label: String(label || '') });
  return true;
}

function release(pid) {
  const n = Number(pid);
  if (Number.isInteger(n)) owned.delete(n);
}

function isOwned(pid) { return owned.has(Number(pid)); }

// 关键/敏感 PID：绝不触碰
function isProtectedPid(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 1) return true;
  if (isWin()) {
    // Windows 上 2=System、4=System、以及会话关键进程（csrss/winlogon/services/lsass/exporer）
    // 由镜像名校验兜住；这里只挡明显危险的低号与自身链路
    if (n <= 4) return true;
  } else {
    if (n <= 2) return true; // 0=整组、1=init
  }
  if (n === process.pid || n === process.ppid) return true;
  return false;
}

function tasklistImage(pid) {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 8000, encoding: 'utf8' },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const line = String(stdout).split('\n').map(s => s.trim()).find(s => s.startsWith('"'));
        if (!line) return resolve(null);
        const first = line.match(/^"([^"]*)"/);
        resolve(first ? first[1].toLowerCase() : null);
      });
  });
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), err: String((err && (err.message || stderr)) || '') });
    });
  });
}

// 返回 { ok, method, note }
async function killTree(pid) {
  const n = Number(pid);
  const rec = owned.get(n);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, note: `PID 非法（${pid}），拒绝杀进程` };
  if (isProtectedPid(n)) return { ok: false, note: `PID ${n} 属于系统或本服务自身链路，已拒绝终止` };
  if (!rec) return { ok: false, note: `PID ${n} 不是本服务登记的进程，为防误杀已拒绝终止` };
  owned.delete(n);

  if (isWin()) {
    const now = await tasklistImage(n);
    if (now === null) return { ok: true, method: 'already-gone', note: `PID ${n} 已不存在，无需清理` };
    if (rec.image && now !== rec.image) {
      return { ok: false, method: 'image-mismatch', note: `PID ${n} 现为「${now}」，与登记时的「${rec.image}」不符（PID 可能已被系统回收），已拒绝终止` };
    }
    const r = await run('taskkill', ['/PID', String(n), '/T', '/F']);
    return r.ok
      ? { ok: true, method: 'taskkill /T /F', note: `已终止进程树（根 PID ${n}，镜像 ${now}）` }
      : { ok: false, method: 'taskkill', note: `taskkill 失败：${r.err.substring(0, 200) || r.out.substring(0, 200)}` };
  }

  // POSIX：起进程时用 detached 让它自成一组，优先整组 SIGKILL；组杀不动再单杀
  const tryGroup = () => { try { process.kill(-n, 'SIGKILL'); return true; } catch (e) { return false; } };
  const single = () => { try { process.kill(n, 'SIGKILL'); return true; } catch (e) { return false; } };
  if (tryGroup()) return { ok: true, method: 'killpg SIGKILL', note: `已终止进程组 -${n}` };
  if (single()) return { ok: true, method: 'kill SIGKILL', note: `已终止进程 ${n}（进程组不存在，仅杀单进程）` };
  return { ok: true, method: 'already-gone', note: `PID ${n} 已不存在，无需清理` };
}

module.exports = { claim, release, isOwned, killTree, _owned: owned };
