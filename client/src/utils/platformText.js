// 平台偏好（OOBE 首次启动时选择）与本地化文本
// 影响：路径示例风格（C:\Users\... vs ~/.kharness）、终端候选描述等
import { ref } from 'vue';

const KEY = 'kh_platform';

function readStored() {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'windows' || v === 'linux') return v;
  } catch (e) { /* 忽略 */ }
  return /Win/i.test(navigator.platform || navigator.userAgent || '') ? 'windows' : 'linux';
}

const current = ref(readStored());
window.addEventListener('kh-platform', (e) => { if (e.detail === 'windows' || e.detail === 'linux') current.value = e.detail; });

export function platformRef() { return current; }
export function getPlatform() { return current.value; }
export function isWin() { return current.value === 'windows'; }
export function setPlatform(v) {
  if (v !== 'windows' && v !== 'linux') return;
  try { localStorage.setItem(KEY, v); } catch (e) { /* 忽略 */ }
  current.value = v;
  window.dispatchEvent(new CustomEvent('kh-platform', { detail: v }));
}

// 本地化路径示例
export function homeKharnessDir() {
  return isWin() ? 'C:\\Users\\<用户名>\\.kharness' : '~/.kharness';
}
export function agentsFilePath() {
  return isWin() ? homeKharnessDir() + '\\AGENTS.md' : homeKharnessDir() + '/AGENTS.md';
}
export function projectAgentsExample() {
  return isWin() ? 'D:\\my-project\\AGENTS.md' : '/home/user/my-project/AGENTS.md';
}
export function pathSepHint() {
  return isWin() ? '路径分隔符使用反斜杠 \\，盘符开头（如 C:\\）' : '路径分隔符使用斜杠 /，根目录开头（如 /usr/local）';
}
export function shellNamesHint() {
  return isWin() ? 'PowerShell 5 / PowerShell 7 / cmd' : 'bash / zsh / sh（POSIX）';
}

// 实际运行平台（宿主系统，与 OOBE 的界面偏好相互独立）
export function isActuallyWin() {
  return /Win/i.test(navigator.platform || navigator.userAgent || '');
}
// Shell 手动输入框的本地化占位提示
export function shellCustomPlaceholder() {
  return isWin()
    ? '手动输入 exe 完整路径，如 C:\\PowerShell\\pwsh.exe 或 C:\\Windows\\System32\\cmd.exe'
    : '手动输入 shell 完整路径，如 /usr/bin/zsh 或 /bin/bash';
}
