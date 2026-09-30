// 回收站：Windows 走 Shell/VisualBasic API，Linux 走 freedesktop  trash-cli/gvfs，macOS 走 Finder
// 全部失败时由调用方决定是否退回普通删除（本项目策略：先撤销快照再退回删除，保证仍可恢复）
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, Object.assign({ windowsHide: true, timeout: 20000 }, opts || {}), (err) => {
      if (err) reject(err); else resolve(true);
    });
  });
}

async function winRecycle(p, isDir) {
  const method = isDir ? 'DeleteDirectory' : 'DeleteFile';
  const script = [
    'Add-Type -AssemblyName Microsoft.VisualBasic',
    `[Microsoft.VisualBasic.FileIO.FileSystem]::${method}($env:KH_TARGET,'OnlyErrorDialogs','SendToRecycleBin')`
  ].join('; ');
  // 路径走环境变量而不是拼进命令行：中文/空格/引号都不用在 PowerShell 里再转义一遍，
  // 脚本本体保持纯 ASCII。之前漏传了这个 env，Windows 上回收站其实一直静默失败（调用方回退成普通删除）。
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: Object.assign({}, process.env, { KH_TARGET: p }),
  });
  return true;
}

async function linuxRecycle(p) {
  for (const [cmd, args] of [
    ['gio', ['trash', p]],
    ['trash-put', [p]],
    ['trash', [p]]
  ]) {
    try { await run(cmd, args); return true; } catch (e) { /* 试下一个 */ }
  }
  // 都没有则手工移到 ~/.local/share/Trash（freedesktop 规范）
  const base = path.basename(p);
  const trash = path.join(os.homedir(), '.local', 'share', 'Trash');
  const files = path.join(trash, 'files');
  const info = path.join(trash, 'info');
  fs.mkdirSync(files, { recursive: true });
  fs.mkdirSync(info, { recursive: true });
  let dest = path.join(files, base);
  let i = 1;
  while (fs.existsSync(dest)) dest = path.join(files, `${base}.${i++}`);
  fs.renameSync(p, dest);
  fs.writeFileSync(dest + '.info', `[Trash Original Path]\n${p}\n[Trash Deletion Date]\n${new Date().toISOString()}\n`);
  return true;
}

async function macRecycle(p) {
  const script = `tell application "Finder" to delete POSIX file ${JSON.stringify(p)}`;
  await run('osascript', ['-e', script]);
  return true;
}

// 返回 true = 已入回收站；抛错 = 失败（调用方决定回退策略）
async function moveToRecycle(p) {
  const abs = path.resolve(p);
  const st = await fs.promises.stat(abs).catch(() => null);
  if (!st) throw new Error('目标不存在');
  if (process.platform === 'win32') return winRecycle(abs, st.isDirectory());
  if (process.platform === 'darwin') return macRecycle(abs);
  return linuxRecycle(abs);
}

module.exports = { moveToRecycle };
