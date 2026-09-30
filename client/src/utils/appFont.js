// 全局字体设置：仅存本浏览器 localStorage，写入 CSS 变量 --app-font 生效
const KEY = 'kh_app_font';
const DEFAULT_STACK = "'CustomFont', 'Segoe UI', system-ui, sans-serif";

// 应用字体：name 为空 = 恢复默认（内置 CustomFont）
export function applyAppFont(name) {
  const v = String(name || '').trim().replace(/['"]/g, '');
  document.documentElement.style.setProperty(
    '--app-font',
    v ? `'${v}', ${DEFAULT_STACK}` : DEFAULT_STACK
  );
  try {
    if (v) localStorage.setItem(KEY, v);
    else localStorage.removeItem(KEY);
  } catch (e) { /* 存储不可用时忽略 */ }
}

// 启动时恢复上次选择的字体，返回当前字体名（空 = 默认）
export function loadAppFont() {
  let v = '';
  try { v = localStorage.getItem(KEY) || ''; } catch (e) { /* 忽略 */ }
  applyAppFont(v);
  return v;
}

export function getAppFont() {
  try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; }
}

// 常见系统字体兜底清单（浏览器不支持枚举时展示）
export const COMMON_FONTS = [
  '微软雅黑', 'Microsoft YaHei', '宋体', 'SimSun', '黑体', 'SimHei',
  '楷体', 'KaiTi', '仿宋', 'FangSong', '等线', 'DengXian',
  'Segoe UI', 'Arial', 'Calibri', 'Cambria', 'Times New Roman', 'Georgia',
  'Verdana', 'Tahoma', 'Trebuchet MS', 'Courier New', 'Consolas', 'Cascadia Code',
  'Impact', 'Comic Sans MS', 'Roboto', 'Helvetica Neue'
];

// 枚举本机已安装字体（Chrome/Edge 的 Local Font Access API，需用户在浏览器弹窗中授权）
// 返回字体族名数组；浏览器不支持时返回 null
export async function scanLocalFonts() {
  if (typeof window.queryLocalFonts !== 'function') return null;
  const fonts = await window.queryLocalFonts();
  const seen = new Set();
  const out = [];
  for (const f of fonts) {
    if (!seen.has(f.family)) { seen.add(f.family); out.push(f.family); }
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}
