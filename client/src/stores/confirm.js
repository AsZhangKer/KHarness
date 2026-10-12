import { reactive } from 'vue';

const state = reactive({
  open: false,
  title: '确认',
  message: '',
  danger: false,
  okText: '',
  _resolve: null,
});

/**
 * danger 只决定按钮红不红，不决定它写什么字 ——
 * 以前红按钮一律写「删除」，于是「启用 FULL-SEND」「撤销这一步」这种确认也挂着「删除」二字。
 * 每个红按钮调用点都自己给 okText（不传就是「确定」）。
 */
export function confirmDialog(message, { title = '确认', danger = false, okText = '' } = {}) {
  return new Promise((resolve) => {
    state.open = true;
    state.title = title;
    state.message = message;
    state.danger = danger;
    state.okText = okText;
    state._resolve = resolve;
  });
}

export function confirmAnswer(ok) {
  state.open = false;
  const r = state._resolve;
  state._resolve = null;
  if (r) r(!!ok);
}

export function confirmState() {
  return state;
}
