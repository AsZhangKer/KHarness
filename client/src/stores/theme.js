// 主题 store：不引入 pinia，和 stores/toast.js 一样用 reactive 单例。
// 主题只改 <html data-theme="...">，所有颜色走 styles/themes.css 的令牌覆盖。
import { computed, reactive } from 'vue';

// 数组顺序 = 设置页里的排列顺序；id 是内部标识，对应 themes.css 的 [data-theme=id]，不要改
export const THEMES = [
  { id: 'dark', name: '暗色', desc: '纯黑白灰，产品默认', mode: 'dark' },
  { id: 'gray', name: '亮色', desc: '中性灰白，常规浅色模式', mode: 'light' },
  { id: 'light', name: '米白', desc: '旧站那套暖米色', mode: 'light' },
  { id: 'aurora-blue', name: '云母·蓝', desc: '深色底 + 蓝/浅蓝/绿云母光', mode: 'dark', backdrop: 'aurora-blue' },
  { id: 'aurora-purple', name: '云母·紫', desc: '深色底 + 紫/品红/靛云母光', mode: 'dark', backdrop: 'aurora-purple' },
  { id: 'starry', name: '星夜', desc: '黑底 + 旧版动态星空', mode: 'dark', backdrop: 'stars' },
];

const KEY = 'kh.theme';
const FALLBACK = 'dark';

function readStored() {
  try {
    const v = localStorage.getItem(KEY);
    return THEMES.some((t) => t.id === v) ? v : FALLBACK;
  } catch {
    return FALLBACK;
  }
}

export const themeState = reactive({ id: readStored() });

export function themeMeta(id = themeState.id) {
  return THEMES.find((t) => t.id === id) || THEMES[0];
}

/** 把当前主题写到 <html> 上；CSS 变量与背景层都依赖这个属性 */
export function applyTheme() {
  const el = document.documentElement;
  el.dataset.theme = themeState.id;
  el.dataset.themeMode = themeMeta().mode;
  el.classList.toggle('theme-dark', themeMeta().mode === 'dark');
  el.classList.toggle('theme-light', themeMeta().mode === 'light');
  // 亮色主题下让浏览器原生控件（滚动条、日期选择器等）也切到浅色
  el.style.colorScheme = themeMeta().mode === 'light' ? 'light' : 'dark';
}

export function setTheme(id) {
  if (!THEMES.some((t) => t.id === id)) return;
  themeState.id = id;
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* 隐私模式下写不进去，忽略即可 */
  }
  applyTheme();
}

export const isDarkTheme = computed(() => themeMeta().mode === 'dark');
export const currentBackdrop = computed(() => themeMeta().backdrop || '');

applyTheme();
