<template>
  <div class="k-empty">
    <i v-if="icon" :class="icon"></i>
    <p class="title">{{ title }}</p>
    <p v-if="desc" class="desc">{{ desc }}</p>
    <slot />
  </div>
</template>

<script setup>
defineProps({
  title: { type: String, default: '暂无数据' },
  desc: { type: String, default: '' },
  icon: { type: String, default: 'fas fa-inbox' },
});
</script>

<style scoped>
.k-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 40px 20px;
  color: var(--text-3);
  text-align: center;
}
.k-empty i { font-size: 22px; opacity: 0.7; }
.k-empty .title { margin: 0; color: var(--text-2); font-size: 14px; }
.k-empty .desc { margin: 0; font-size: 12px; max-width: 360px; }
</style>
