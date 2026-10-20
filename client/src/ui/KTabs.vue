<template>
  <!-- 终末地下这条栏换成母本 ai/TAB_BAR/公告标签栏.html 的页签（hatch 顶带 + 下缘站立的页签 + 图标方块），
       类名用母本自己的 .ui-announcement__*；其余六套主题照旧走 .k-tabs 那套滑动胶囊。 -->
  <div ref="rootEl" class="k-tabs ui-announcement__top" :class="{ compact: iconMode }" role="tablist">
    <div class="ui-announcement__tabs">
      <button
        v-for="t in items"
        :key="t.id"
        :ref="(el) => setRef(t.id, el)"
        class="k-tab ui-announcement__tab ui-interactive"
        :class="{ active: t.id === modelValue, 'is-active': t.id === modelValue }"
        type="button"
        role="tab"
        :title="t.label"
        :aria-selected="t.id === modelValue"
        @click="select(t.id)"
      >
        <span v-if="t.icon && (iconMode || ef)" class="ui-announcement__tab-icon"><i :class="t.icon"></i></span>
        <template v-if="!iconMode">{{ t.label }}</template>
      </button>
      <span class="k-tab-bar" :style="barStyle"></span>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { themeState } from '../stores/theme';

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
const ef = computed(() => themeState.id === 'endfield');

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
/* 母本那层 .ui-announcement__tabs 只是终末地页签的定位盒；其余六套主题里让它从盒树里消失，
   按钮仍旧直接排在 .k-tabs 这条 flex 上 —— 不然六套主题会平白少掉 4px 间距。
   终末地下母本规则 (0,3,0) 把它改回 display:flex，这条 (0,1,0) 自然让位。 */
.ui-announcement__tabs {
  display: contents;
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

  html[data-motion='off'] .k-tab-bar{ transition: none; }

</style>
