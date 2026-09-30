/**
 * 前端要用的界面偏好（存在服务端 settings 表里，换机器/重开窗口都是老样子）。
 *
 * 为什么放服务端而不是 localStorage：这些开关一半影响行为（审批等待、压缩保留条数、提示音），
 * 一半影响消息怎么画（思考展开、长回复折叠、工具折叠）。画消息的组件在渲染最深处，
 * 让它去读 localStorage 会把「设置」拆成两套真相；统一走这里，启动拉一次、改设置时同步。
 */
import { reactive } from 'vue';
import { settingsApi } from '../api';
import { configureSound } from '../utils/sound';
import { toastErr } from '../utils/errText';

const state = reactive({
  loaded: false,
  sound: true,
  volume: 0.6,
  compressKeep: 2,
  approvalTimeout: 180,
  reasonOpen: false,
  longCollapse: true,
  toolCollapse: false,
  // 全局代理总闸：true = 所有提供商即使勾了「代理」也直连
  proxyDisabled: false,
  // 内置浏览器 UA 形态：'desktop' / 'mobile'（界面开关与 AI 工具共用）
  browserUa: 'desktop',
  // 尺寸类：终端字体/字号/浮窗高度、首页输入框高度（0 = 没拖过，用样式默认值）
  termFont: '',
  termSize: 12,
  termHeight: 300,
  composerHeight: 0,
  // 截图送给模型前的最长边上限（px）；0 = 不缩放。实际缩放发生在桌面外壳落盘那一刻。
  imgMaxSide: 0,
  // 同一操作连续重复几次就打断（防模型自循环）
  repeatBreak: 3,
  // AI 监工 / 托管：已半废弃，默认关，只有实验室里打开才有入口
  supervisorOn: false,
});

function bool(v, def) {
  if (v === '1' || v === 1 || v === true) return true;
  if (v === '0' || v === 0 || v === false) return false;
  return def;
}
function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function apply(s) {
  state.sound = bool(s.sound_enabled, state.sound);
  state.volume = Math.min(1, Math.max(0, num(s.sound_volume, state.volume)));
  state.compressKeep = num(s.compress_keep_messages, state.compressKeep);
  state.approvalTimeout = num(s.approval_timeout_seconds, state.approvalTimeout);
  state.reasonOpen = bool(s.reasoning_default_open, state.reasonOpen);
  state.longCollapse = bool(s.long_reply_collapse, state.longCollapse);
  state.toolCollapse = bool(s.tool_call_collapse, state.toolCollapse);
  state.proxyDisabled = bool(s.proxy_disabled, state.proxyDisabled);
  if (s.browser_ua_mode === 'mobile' || s.browser_ua_mode === 'desktop') state.browserUa = s.browser_ua_mode;
  if (s.term_font !== undefined) state.termFont = String(s.term_font || '');
  state.termSize = clamp(Math.round(num(s.term_size, state.termSize)), 9, 28);
  state.termHeight = clamp(Math.round(num(s.term_height, state.termHeight)), 120, 4000);
  state.composerHeight = clamp(Math.round(num(s.composer_height, state.composerHeight)), 0, 2000);
  state.imgMaxSide = clamp(Math.round(num(s.img_max_side, state.imgMaxSide)), 0, 8192);
  state.repeatBreak = clamp(Math.round(num(s.repeat_break_threshold, state.repeatBreak)), 2, 20);
  state.supervisorOn = bool(s.supervisor_enabled, state.supervisorOn);
  configureSound({ enabled: state.sound, volume: state.volume });
  state.loaded = true;
}

async function load(force = false) {
  if (state.loaded && !force) return state;
  try {
    apply((await settingsApi.getAll()) || {});
  } catch (e) {
    // 拿不到就用默认值，不能把界面卡住；报错本身由拦截器提示过一次
    state.loaded = true;
  }
  return state;
}

/** 保存并即时生效（先改本地、界面马上动；写库失败就回服务端重读一次，回到真实值） */
const FIELD_TO_KEY = {
  sound: 'sound_enabled', volume: 'sound_volume', compressKeep: 'compress_keep_messages',
  approvalTimeout: 'approval_timeout_seconds', reasonOpen: 'reasoning_default_open',
  longCollapse: 'long_reply_collapse', toolCollapse: 'tool_call_collapse',
  proxyDisabled: 'proxy_disabled',
  browserUa: 'browser_ua_mode',
  termFont: 'term_font', termSize: 'term_size', termHeight: 'term_height',
  composerHeight: 'composer_height', imgMaxSide: 'img_max_side',
  repeatBreak: 'repeat_break_threshold', supervisorOn: 'supervisor_enabled',
};

async function save(patch) {
  const body = {};
  for (const [field, key] of Object.entries(FIELD_TO_KEY)) {
    if (patch[field] === undefined) continue;
    const v = patch[field];
    body[key] = typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
  }
  if (!Object.keys(body).length) return true;
  apply(body);
  try {
    await settingsApi.update(body);
    return true;
  } catch (e) {
    toastErr(e, '设置保存失败');
    await load(true);          // 服务端才是准的：失败后把界面拉回真实值
    return false;
  }
}

export const uiPrefs = { state, load, save };
