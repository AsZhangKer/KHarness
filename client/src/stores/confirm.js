import { reactive } from 'vue';

const state = reactive({
  open: false,
  title: '确认',
  message: '',
  danger: false,
  _resolve: null,
});

export function confirmDialog(message, { title = '确认', danger = false } = {}) {
  return new Promise((resolve) => {
    state.open = true;
    state.title = title;
    state.message = message;
    state.danger = danger;
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
