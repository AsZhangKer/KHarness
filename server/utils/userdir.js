/**
 * 用户自己的目录。目前只有一个：桌面 —— 自由会话的默认工作目录用它。
 *
 * 为什么不直接 os.homedir() + 'Desktop'：中文 Windows 上桌面经常被重定向
 * （D:\桌面、OneDrive\桌面、或者改过名的「工作文件夹」），硬拼出来的那个目录
 * 要么不存在、要么不是他在资源管理器里看到的「桌面」，AI 在里面干活他根本找不到。
 * 所以 Windows 读注册表 User Shell Folders\\Desktop（REG_EXPAND_SZ，要自己展开 %VAR%），
 * Linux 读 XDG 的 user-dirs.dirs，都探不到才退回 homedir/Desktop，再退 homedir。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let cached = null;

function expandEnv(s) {
  return String(s || '').replace(/%([^%]+)%/g, (m, k) => process.env[k] || '');
}

function isDir(p) {
  if (!p) return false;
  try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

function winDesktopFromRegistry() {
  try {
    const r = spawnSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'Desktop'],
      { encoding: 'utf8', windowsHide: true, timeout: 4000 }
    );
    const line = String(r.stdout || '').split('\n').find((l) => /\bDesktop\b.*REG_EXPAND_SZ/i.test(l));
    if (!line) return '';
    return expandEnv(line.split('REG_EXPAND_SZ').pop().trim()).trim();
  } catch (e) {
    return '';   // 注册表读不到不是大事，后面有兜底
  }
}

function xdgDesktop() {
  try {
    const txt = fs.readFileSync(path.join(os.homedir(), '.config', 'user-dirs.dirs'), 'utf8');
    const m = /XDG_DESKTOP_DIR="?([^"\n]+)"?/.exec(txt);
    if (!m) return '';
    return expandEnv(m[1].replace('$HOME', os.homedir())).trim();
  } catch (e) {
    return '';
  }
}

/** 当前用户的桌面（一定返回一个存在的目录；实在没有就回家目录） */
function desktop() {
  if (cached) return cached;
  const special = process.platform === 'win32' ? winDesktopFromRegistry() : xdgDesktop();
  const cands = [special, path.join(os.homedir(), 'Desktop'), os.homedir()];
  cached = cands.find(isDir) || os.homedir();
  return cached;
}

module.exports = { desktop };
