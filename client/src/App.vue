<template>
  <ThemeBackdrop />
  <!-- 无框窗口那条顶栏（只在 Electron 里出现）。必须是 .app-root 的**兄弟**而不是它的孩子：
       .app-root 有 z-index:1 自己成一个层叠上下文，塞在它里面的任何 z-index 都比不过
       挂在 body 上的弹窗遮罩（KModal 的 .k-modal-root 是 z-index:80 的 fixed 层），
       那样一开弹窗三颗键就被遮罩吃掉点不动了。同级才比得动。 -->
  <WindowBar />
  <div class="app-root">
    <AppShell />
    <UiToasts />
    <ConfirmDialog />
    <PromptDialog />
  </div>
</template>

<script setup>
import { onMounted } from 'vue';
import AppShell from './layouts/AppShell.vue';
import WindowBar from './ui/WindowBar.vue';
import UiToasts from './ui/UiToasts.vue';
import ConfirmDialog from './ui/ConfirmDialog.vue';
import PromptDialog from './ui/PromptDialog.vue';
import ThemeBackdrop from './ui/ThemeBackdrop.vue';
import { uiPrefs } from './stores/prefs';

// 界面偏好（提示音、折叠方式、压缩保留条数…）开屏拉一次，深处组件直接用，不再各自读 localStorage
onMounted(() => { uiPrefs.load(); });
</script>

<style scoped>
/* 背景层是 fixed + z-index:0，内容抬到它上面；极光/星夜主题靠这个层级关系透出背景 */
.app-root { height: 100%; min-height: 0; position: relative; z-index: 1; }
</style>
