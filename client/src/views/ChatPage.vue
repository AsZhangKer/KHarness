<template>
  <AiPlayground :model="routeModel" />
</template>

<script setup>
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import AiPlayground from '../components/AiPlayground.vue';

// 显式命名：App.vue 的 KeepAlive include 按名称缓存本页（切页不销毁，后台继续接收响应）
defineOptions({ name: 'ChatPage' });

const route = useRoute();

// 模型列表页点击模型名跳转：/?model=ID 指定初始模型
const routeModel = computed(() => {
  const id = parseInt(route.query.model);
  return Number.isInteger(id) && id > 0 ? { id } : null;
});
</script>
