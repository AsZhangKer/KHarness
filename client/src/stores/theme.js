// 主题 store：不引入 pinia，和 stores/toast.js 一样用 reactive 单例。
// 主题只改 <html data-theme="...">，所有颜色走 styles/themes.css 的令牌覆盖。
import { computed, reactive } from 'vue';

/* 实验室开关那本账（设置页写 localStorage 的 nu_labs）。
   开发到一半的主题不再摆在外观页给人当正常主题用：条目上标 `lab` = 只有实验室点亮才出现。
   ⚠ 这里必须是 reactive 对象 + 逐键赋值，不能是 ref 整包换：
   打包后的产物实测（v16 探针，1440×900，一次页签都不切直接点开关）——
   `labOn.value = {...新值}` 这种「换整个 ref.value」不会触发重渲染（开关不亮、卡也不露），
   只有别的状态（搜索框输入）碰巧引起一次重渲染时才把新值补画出来；
   而 `themeState.id = 'dark'` 这类 reactive 属性赋值每次都当场重画。
   键还要在建立时就种好（`!!初始值`，即使 localStorage 里没这个键）：读一个不存在的键、之后再加，
   走的又是「新增属性」那条触发路径，没必要再去赌它。 */
const LABS_KEY = 'nu_labs';
const LAB_ENDFIELD = 'endfieldTheme';
const readLabs = () => {
  try {
    return JSON.parse(localStorage.getItem(LABS_KEY) || '{}') || {};
  } catch {
    return {};
  }
};
const labs = reactive({ [LAB_ENDFIELD]: !!readLabs()[LAB_ENDFIELD] });

// 数组顺序 = 设置页里的排列顺序；id 是内部标识，对应 themes.css 的 [data-theme=id]，不要改
export const THEMES = [
  { id: 'dark', name: '暗色', desc: '纯黑白灰，产品默认', mode: 'dark' },
  { id: 'gray', name: '亮色', desc: '中性灰白，常规浅色模式', mode: 'light' },
  { id: 'light', name: '米白', desc: '旧站那套暖米色', mode: 'light' },
  { id: 'aurora-blue', name: '云母·蓝', desc: '深色底 + 蓝/浅蓝/绿云母光', mode: 'dark', backdrop: 'aurora-blue' },
  { id: 'aurora-purple', name: '云母·紫', desc: '深色底 + 紫/品红/靛云母光', mode: 'dark', backdrop: 'aurora-purple' },
  { id: 'starry', name: '星夜', desc: '黑底 + 旧版动态星空', mode: 'dark', backdrop: 'stars' },
  { id: 'endfield', name: '终末地', desc: '游戏《明日方舟：终末地》风格主题', mode: 'light', lab: LAB_ENDFIELD },
];

const KEY = 'kh.theme';
const FALLBACK = 'dark';

const unlocked = (t) => !t?.lab || !!labs[t.lab];

function readStored() {
  const v = (() => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  })();
  const t = THEMES.find((x) => x.id === v);
  return t && unlocked(t) ? v : FALLBACK;
}

export const themeState = reactive({ id: readStored() });

/** 外观页只摆已解锁的：没点实验室开关的人根本看不见这张卡 */
export const visibleThemes = computed(() => THEMES.filter(unlocked));

/** 设置页的开关直接绑这本账（不要再自己抄一份 ref）：读的是同一颗 reactive 属性 */
export const labFlags = labs;

/**
 * 拨一颗实验室开关：localStorage 是账（别的页面按 nu_labs 读，见 ChatPage / chatStore），
 * labs 是画。写账之前先读一遍整本，免得把别处留下的老键（gitPreview 那类）抹掉。
 * 返回值是落盘后读回来的比对结果 —— 账没写上就别让界面装作拨开了。
 */
export function setLabFlag(key, on) {
  const fresh = readLabs();
  fresh[key] = !!on;
  try {
    localStorage.setItem(LABS_KEY, JSON.stringify(fresh));
  } catch {
    /* 隐私模式下写不进去，内存这本账照旧生效 */
  }
  labs[key] = !!on;
  if (!unlocked(themeMeta(themeState.id))) setTheme(FALLBACK);   // 正在用却没解锁的主题退回默认
  return !!readLabs()[key] === !!on;
}

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
  pushSchemeToMain(themeMeta().mode);
}

/**
 * 内置浏览器里的网页读不到我们的 CSS 变量，只能读 prefers-color-scheme ——
 * 而 Electron 默认跟随系统，于是「界面是暗的、网页却是白的」。
 * 这里把主题明暗报给主进程去设 nativeTheme.themeSource：
 * 米白/亮色时网页跟着亮，其余（暗色/云母/星夜）强制网页出深色配色。
 * 我们自己的界面不读这条媒体查询（全仓库没有 prefers-color-scheme），所以不会被它带偏。
 */
function pushSchemeToMain(mode) {
  try {
    if (window.khDesktop && window.khDesktop.setThemeScheme) {
      window.khDesktop.setThemeScheme(mode === 'light' ? 'light' : 'dark');
    }
  } catch (e) { /* 网页配色没跟上不影响界面 */ }
}

export function setTheme(id) {
  const t = THEMES.find((x) => x.id === id);
  if (!t || !unlocked(t)) return;   // 实验室没点亮的主题：认不得也切不过去
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
