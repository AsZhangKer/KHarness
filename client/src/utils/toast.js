import { reactive } from 'vue';

// 全局轻提示：App.vue 挂载渲染容器，任意组件 import { toast } 调用
export const toastState = reactive({ items: [] });

let seq = 0;

export function toast(message, type = 'info', duration = 3000) {
  if (!message) return;
  const id = ++seq;
  toastState.items.push({ id, message, type });
  setTimeout(() => {
    const i = toastState.items.findIndex(t => t.id === id);
    if (i !== -1) toastState.items.splice(i, 1);
  }, duration);
}

export const toastIcons = {
  success: 'fa-check-circle',
  error: 'fa-times-circle',
  info: 'fa-info-circle'
};
