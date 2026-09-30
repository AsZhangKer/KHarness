/**
 * 内置图片查看器的单例状态（不引 pinia，和 stores/toast.js 一个路子）。
 *
 * 为什么要单独一个 store：三处入口都在很深的地方 —— 输入框上方的暂存缩略图、
 * 工具回执里的截图、远程文件栏里的图片。让每个组件各自挂一份弹窗，
 * 就会出现「同时在三个地方渲染三个遮罩」；统一走这里，全应用只挂一次。
 */
import { reactive } from 'vue';

const state = reactive({
  open: false,
  url: '',        // 任何能进 <img src> 的东西：/api/... 或 data:URL
  title: '',
});

function openViewer({ url, title = '' } = {}) {
  if (!url) return;
  state.url = String(url);
  state.title = String(title || '');
  state.open = true;
}

function closeViewer() {
  state.open = false;
}

export const imageViewer = { state, openViewer, closeViewer };
