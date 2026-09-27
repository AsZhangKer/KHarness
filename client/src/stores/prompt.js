import { reactive } from 'vue';

/**
 * 应用内输入框（替代 window.prompt）。
 * Electron 里 window.prompt 根本不存在返回值：调用立刻返回 null，
 * 于是「新建目录/新建文件/改名/提交说明」全部静默失效 —— 所以统一走这个。
 * 与 stores/confirm.js 同一套法：单例状态 + Promise，App.vue 里挂 <PromptDialog />。
 */
const state = reactive({
  open: false,
  title: '输入',
  label: '',
  value: '',
  placeholder: '',
  confirmText: '确定',
  _resolve: null,
});

export function promptDialog(opts = {}) {
  const { title = '输入', label = '', value = '', placeholder = '', confirmText = '确定' } =
    typeof opts === 'string' ? { title: opts } : opts;
  return new Promise((resolve) => {
    // 连开两次不该发生，但真发生就把前一次判取消，别让调用方永远挂着
    if (state._resolve) {
      const prev = state._resolve;
      state._resolve = null;
      prev(null);
    }
    state.open = true;
    state.title = title;
    state.label = label;
    state.value = value;
    state.placeholder = placeholder;
    state.confirmText = confirmText;
    state._resolve = resolve;
  });
}

/** 确定回字符串（去掉首尾空白），取消/关窗回 null */
export function promptAnswer(v) {
  state.open = false;
  const r = state._resolve;
  state._resolve = null;
  if (r) r(typeof v === 'string' ? v.trim() : null);
}

export function promptState() {
  return state;
}
