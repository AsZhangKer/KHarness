<template>
  <div class="backdrop" aria-hidden="true">
    <template v-if="backdrop === 'aurora-blue' || backdrop === 'aurora-purple'">
      <div class="aurora a1"></div>
      <div class="aurora a2"></div>
      <div class="aurora a3"></div>
      <div class="aurora veil"></div>
    </template>
    <StarField v-else-if="backdrop === 'stars'" />
  </div>
</template>

<script setup>
// 主题背景层：极光用 CSS 渐变，星夜用 canvas。
// 只负责画背景，颜色全部来自 themes.css 的 --aurora-* / --star-* 令牌。
import { computed } from 'vue';
import { themeMeta } from '../stores/theme';
import StarField from './StarField.vue';

const backdrop = computed(() => themeMeta().backdrop || '');
</script>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  overflow: hidden;
}
.aurora {
  position: absolute;
  border-radius: 50%;
  filter: blur(80px);
  opacity: 0.8;
  will-change: transform;
}
.a1 {
  width: 70vw;
  height: 55vh;
  left: -12vw;
  top: -18vh;
  background: var(--aurora-1);
  animation: drift-a 34s ease-in-out infinite alternate;
}
.a2 {
  width: 58vw;
  height: 48vh;
  right: -14vw;
  top: 6vh;
  background: var(--aurora-2);
  animation: drift-b 41s ease-in-out infinite alternate;
}
.a3 {
  width: 66vw;
  height: 42vh;
  left: 18vw;
  bottom: -22vh;
  background: var(--aurora-3);
  animation: drift-a 47s ease-in-out infinite alternate-reverse;
}
/* 顶部压一层深色渐变，保证上方导航文字在极光上仍有对比度 */
.veil {
  position: absolute;
  inset: 0;
  width: auto;
  height: auto;
  border-radius: 0;
  filter: none;
  opacity: 1;
  background: var(--aurora-veil);
  animation: none;
}
@keyframes drift-a {
  from { transform: translate3d(0, 0, 0) scale(1); }
  to { transform: translate3d(8vw, 6vh, 0) scale(1.15); }
}
@keyframes drift-b {
  from { transform: translate3d(0, 0, 0) scale(1.1); }
  to { transform: translate3d(-7vw, 9vh, 0) scale(0.95); }
}
@media (prefers-reduced-motion: reduce) {
  .aurora { animation: none; }
}
</style>
