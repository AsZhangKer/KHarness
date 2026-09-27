<template>
  <div class="k-dropdown" :class="{ block }" ref="rootEl" @keydown.esc="close" @keydown="onKey">
    <button
      class="k-dd-trigger"
      type="button"
      :class="{ open, disabled }"
      :disabled="disabled"
      aria-haspopup="listbox"
      :aria-expanded="open"
      ref="triggerEl"
      @click="toggle"
    >
      <span v-if="!$slots.trigger" class="k-dd-text" :class="{ ph: !hasValue }">{{ shownLabel }}</span>
      <slot v-else name="trigger" :open="open"></slot>
      <i class="fas fa-chevron-down caret"></i>
    </button>
    <Transition name="kdd">
      <div
        v-if="open"
        ref="menuEl"
        class="k-dd-menu"
        :class="'place-' + place"
        role="listbox"
        :style="{ minWidth: menuWidth }"
      >
        <button
          v-for="(item, i) in items"
          :key="String(item.value)"
          class="k-dd-item"
          :data-i="i"
          :class="{ on: isOn(item), cursor: i === cursor }"
          type="button"
          role="option"
          :aria-selected="isOn(item)"
          @mouseenter="cursor = i"
          @click="pick(item)"
        >
          <span>{{ item.label }}</span>
          <i v-if="isOn(item)" class="fas fa-check"></i>
        </button>
        <div v-if="!items.length" class="k-dd-empty">无选项</div>
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps({
  items: { type: Array, default: () => [] },
  modelValue: { type: [String, Number, Boolean, Object], default: '' },
  /** 覆盖触发器文案；不传则显示选中项的 label（表单里当 select 用） */
  label: { type: String, default: '' },
  placeholder: { type: String, default: '请选择' },
  width: { type: String, default: '220px' },
  disabled: { type: Boolean, default: false },
  /** auto = 下方空间不足时朝上开；也可强制 top / bottom */
  placement: { type: String, default: 'auto' },
  /** 撑满父容器宽度（放进表单行里用） */
  block: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue', 'change', 'open', 'close']);
const open = ref(false);
const cursor = ref(0);
const rootEl = ref(null);
const triggerEl = ref(null);
const menuEl = ref(null);
const place = ref('bottom');

const current = computed(() => props.items.find((x) => isOn(x)) || null);
const hasValue = computed(() => !!current.value);
const shownLabel = computed(() => props.label || current.value?.label || props.placeholder);
const menuWidth = computed(() => (props.block ? '100%' : props.width));

function isOn(item) {
  return String(item.value) === String(props.modelValue) && props.modelValue !== '' && props.modelValue != null;
}

// 朝上还是朝下：靠近视口底部（如输入框上方）时朝上，其余朝下
function measure() {
  if (props.placement === 'top' || props.placement === 'bottom') {
    place.value = props.placement;
    return;
  }
  const rect = triggerEl.value?.getBoundingClientRect?.();
  if (!rect) return;
  const below = window.innerHeight - rect.bottom;
  place.value = below < 260 && rect.top > below ? 'top' : 'bottom';
}

function toggle() {
  if (props.disabled) return;
  if (open.value) close();
  else open.value = true;
}
function close() {
  if (!open.value) return;
  open.value = false;
  emit('close');
}
function pick(item) {
  emit('update:modelValue', item.value);
  emit('change', item.value);
  close();
}

function onKey(e) {
  if (!open.value) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      open.value = true;
    }
    return;
  }
  const n = props.items.length;
  if (!n) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    cursor.value = (cursor.value + 1) % n;
    nextTick(() => scrollTo(cursor.value));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    cursor.value = (cursor.value - 1 + n) % n;
    nextTick(() => scrollTo(cursor.value));
  } else if (e.key === 'Enter') {
    e.preventDefault();
    pick(props.items[cursor.value]);
  }
}

function onDoc(e) {
  if (!rootEl.value?.contains(e.target)) close();
}
onMounted(() => document.addEventListener('mousedown', onDoc));
onBeforeUnmount(() => document.removeEventListener('mousedown', onDoc));
watch(open, (v) => {
  if (!v) return;
  measure();
  const idx = props.items.findIndex((x) => isOn(x));
  cursor.value = idx >= 0 ? idx : 0;
  nextTick(() => {
    triggerEl.value?.focus?.();
    // 长列表（迁移后 280+ 模型）打开时必须落在当前选项上，否则要点开再滚很久
    scrollTo(cursor.value);
  });
  emit('open');
});

function scrollTo(i) {
  const menu = menuEl.value;
  if (!menu) return;
  const el = menu.querySelector(`.k-dd-item[data-i="${i}"]`) || menu.querySelector('.k-dd-item.on');
  if (el) el.scrollIntoView({ block: 'center' });
}
</script>

<style scoped>
.k-dropdown { position: relative; display: inline-block; }
.k-dropdown.block { display: block; width: 100%; }
.k-dd-trigger {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 32px;
  padding: 5px 12px;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text-2);
  border-radius: var(--radius-sm);
  font-size: 12px;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease),
    border-color var(--dur) var(--ease);
}
.k-dd-trigger:hover,
.k-dd-trigger.open {
  color: var(--text);
  background: var(--bg-hover);
  border-color: var(--border-strong);
}
.k-dd-trigger:disabled,
.k-dd-trigger.disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.k-dd-text {
  flex: 1;
  min-width: 0;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.k-dd-text.ph { color: var(--text-3); }
.caret { font-size: 9px; opacity: 0.7; transition: transform var(--dur) var(--ease); flex-shrink: 0; }
.open .caret { transform: rotate(180deg); }
/* 弹层与右键菜单 / 命令面板 / 弹窗共用一套表面语言（见 tokens.css 的 .k-pop-*） */
.k-dd-menu {
  position: absolute;
  left: 0;
  z-index: 60;
  max-height: 280px;
  overflow: auto;
  background: var(--surface-pop);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow);
  padding: 4px;
}
.k-dd-menu.place-bottom { top: calc(100% + 4px); }
.k-dd-menu.place-top { bottom: calc(100% + 4px); }
.k-dd-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 7px 10px;
  border-radius: var(--radius-xs);
  color: var(--text-2);
  font-size: 12px;
  text-align: left;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.k-dd-item:hover,
.k-dd-item.cursor {
  background: var(--surface-hover);
  color: var(--text);
}
.k-dd-item.on {
  background: var(--surface-active);
  color: var(--text);
  font-weight: 600;
}
.k-dd-item i { color: var(--text-3); font-size: 10px; }
.k-dd-empty {
  padding: 10px;
  color: var(--text-3);
  font-size: 12px;
}
/* 下拉面板和别的弹窗同一套开合：升起 + 轻微抖动进场，下落渐隐收走 */
.kdd-enter-active { animation: kh-pop-in 0.22s cubic-bezier(0.22, 1.08, 0.36, 1); }
.kdd-leave-active { animation: kh-pop-out 0.14s cubic-bezier(0.4, 0, 0.9, 0.35) forwards; }
@media (prefers-reduced-motion: reduce) {
  .kdd-enter-active,
  .kdd-leave-active { animation: none; }
}
</style>
