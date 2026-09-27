<template>
  <div ref="rootEl" class="k-tabs" :class="{ compact: iconMode }" role="tablist">
    <button
      v-for="t in items"
      :key="t.id"
      :ref="(el) => setRef(t.id, el)"
      class="k-tab"
      :class="{ active: t.id === modelValue }"
      type="button"
      role="tab"
      :title="t.label"
      :aria-selected="t.id === modelValue"
      @click="select(t.id)"
    >
      <i v-if="iconMode && t.icon" :class="t.icon"></i>
      <template v-else>{{ t.label }}</template>
    </button>
    <span class="k-tab-bar" :style="barStyle"></span>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps({
  items: { type: Array, default: () => [] },
  modelValue: { type: String, default: '' },
  // 只显示图标、文字留给 title 悬浮提示（右侧栏那种窄栏用）。
  // 没配 icon 的条目会退回显示文字，不会出现空按钮。
  iconsOnly: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue']);

const refs = {};
const rootEl = ref(null);
const compact = ref(false);
const barLeft = ref(0);
const barTop = ref(0);
const barW = ref(0);
const barH = ref(0);

const iconMode = computed(() => props.iconsOnly || compact.value);

function setRef(id, el) {
  if (el) refs[id] = el;
}

function measure() {
  const root = rootEl.value;
  if (!root) return;
  compact.value = root.scrollWidth > root.clientWidth + 2 || root.clientWidth < 180;
  moveBar();
}

function moveBar() {
  const el = refs[props.modelValue];
  if (!el) return;
  // 框比按钮稍微缩一点，别把分隔线顶满，看着像浮在标签后面
  barLeft.value = el.offsetLeft - 2;
  barTop.value = el.offsetTop + 3;
  barW.value = el.offsetWidth + 4;
  barH.value = Math.max(18, el.offsetHeight - 8);
}

const barStyle = computed(() => ({
  width: `${barW.value}px`,
  height: `${barH.value}px`,
  transform: `translate(${barLeft.value}px, ${barTop.value}px)`,
  opacity: barW.value ? 1 : 0,
}));

function select(id) {
  emit('update:modelValue', id);
  nextTick(moveBar);
}

onMounted(() => {
  measure();
  window.addEventListener('resize', measure);
});
watch(() => props.modelValue, () => nextTick(moveBar));
watch(() => props.items, () => nextTick(measure), { deep: true });
onBeforeUnmount(() => window.removeEventListener('resize', measure));
</script>

<style scoped>
.k-tabs {
  position: relative;
  display: flex;
  gap: 4px;
  padding: 0 8px;
  border-bottom: 1px solid var(--border-soft);
}
.k-tab {
  position: relative;
  z-index: 1;
  padding: 10px 12px;
  color: var(--text-3);
  font-size: 12px;
  white-space: nowrap;
}
.k-tabs.compact .k-tab {
  padding: 10px;
  width: 36px;
  justify-content: center;
}
.k-tabs.compact {
  overflow: hidden;
}
.k-tab.active { color: var(--text); }
/* 高亮框：整块跟在选中标签后面滑，带一点点回弹，切换时眼睛跟得上 */
.k-tab-bar {
  position: absolute;
  left: 0;
  top: 0;
  border-radius: var(--radius-sm);
  background: var(--bg-active);
  box-shadow: inset 0 0 0 1px var(--border);
  z-index: 0;
  transition: transform 0.2s cubic-bezier(0.34, 1.32, 0.64, 1), width 0.2s var(--ease),
    height 0.2s var(--ease), opacity 0.15s ease;
}
.k-tab { z-index: 1; }
@media (prefers-reduced-motion: reduce) {
  .k-tab-bar { transition: none; }
}
</style>
