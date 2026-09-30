<template>
  <!-- 独立出来的浏览器窗口：整页就是那一栏（标题 + 地址栏 + 视图 + 状态栏）。
       由主进程用 `<服务地址>/?kh=browser` 打开，那份入口不装路由、不渲染左栏与自绘顶栏。 -->
  <BrowserPanel mode="window" />
</template>

<script setup>
import BrowserPanel from './BrowserPanel.vue';
</script>
