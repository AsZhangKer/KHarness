<template>
  <label class="k-field" :class="{ block }">
    <span v-if="label" class="k-label">{{ label }}</span>
    <input
      class="k-input"
      :type="type"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      :readonly="readonly"
      @input="$emit('update:modelValue', $event.target.value)"
      @keydown="onKey"
    />
    <span v-if="hint" class="k-hint">{{ hint }}</span>
  </label>
</template>

<script setup>
import { imeGuard } from '../utils/ime';

defineProps({
  modelValue: { type: [String, Number], default: '' },
  label: { type: String, default: '' },
  type: { type: String, default: 'text' },
  placeholder: { type: String, default: '' },
  hint: { type: String, default: '' },
  disabled: Boolean,
  readonly: Boolean,
  block: Boolean,
});
const emit = defineEmits(['update:modelValue', 'enter']);
// 输入法候选词还没上屏时的 Enter 属于输入法，不该被当成「确认」发出去
const onKey = imeGuard('enter', (e) => emit('enter', e));
</script>

<style scoped>
.k-field { display: inline-flex; flex-direction: column; gap: 6px; }
.k-field.block { display: flex; width: 100%; }
.k-label { font-size: 12px; color: var(--text-3); }
/* .k-input 的样式统一在 styles/tokens.css 里定义（页面里手写的同名控件要一起吃到），
   这里不再写副本：scoped 选择器特异性更高，会把全局那套盖掉。 */
.k-hint { font-size: 11px; color: var(--text-3); }
</style>
