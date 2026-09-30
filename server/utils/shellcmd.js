// Shell 调用构造：run_command（前台 exec/execFile）与 run_background（spawn 异步）共用同一套
// 「按设置里的 Shell 拼参数」逻辑，避免两条路径行为分叉。
const path = require('path');
const { db } = require('../database');

// 设置里选定的 Shell；空串 = 用系统默认（exec 的 shell:true）
function getShellSetting() {
  try { return (db.prepare("SELECT value FROM settings WHERE key = 'agent_shell'").get()?.value || '').trim(); }
  catch (e) { return ''; }
}

// 返回 null 表示「不指定 Shell，交给系统默认」；否则返回 { file, args }
function buildShell(command, shellOverride) {
  const shell = shellOverride === undefined ? getShellSetting() : String(shellOverride || '').trim();
  if (!shell) return null;
  const base = path.basename(shell).toLowerCase();
  let args;
  if (/\.bash$|^bash|zsh|^sh(\.exe)?$|wsl/.test(base)) args = ['-c', command];
  else if (/pwsh|powershell/.test(base)) args = ['-NoProfile', '-Command', command];
  else args = ['/d', '/s', '/c', command]; // cmd.exe
  return { file: shell, args, image: base };
}

module.exports = { getShellSetting, buildShell };
