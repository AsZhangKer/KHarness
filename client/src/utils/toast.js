// 轻量 toast（无 pinia）
const listeners = new Set();
let items = [];
let seq = 0;

function emit() {
  for (const fn of listeners) fn(items);
}

export const toastState = {
  items,
  get all() {
    return items;
  },
};

export function subscribeToasts(fn) {
  listeners.add(fn);
  fn(items);
  return () => listeners.delete(fn);
}

export function toast(message, type = 'info', duration = 3500) {
  const id = ++seq;
  items = [...items, { id, message: String(message ?? ''), type }];
  toastState.items = items;
  emit();
  window.setTimeout(() => {
    items = items.filter((x) => x.id !== id);
    toastState.items = items;
    emit();
  }, duration);
}
