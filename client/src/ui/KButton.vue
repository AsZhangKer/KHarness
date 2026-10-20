<template>
  <!-- 终末地：长条胶囊按钮直接搬母本「弹窗 · 更多文字面板框.html」body 里那颗 .ef-pill 的写法
       （__tex 右端纹理 / __line 细线带两颗点 / __label 文字 / __ico 右端圆盘），
       三颗图标也都是母本 body 里的原 svg：确认用循环箭、取消与危险用叉。
       其余六套主题走下面那条 v-else，一个字节没改。 -->
  <button
    v-if="ef"
    class="ef-pill ef-pill--float"
    :class="[{ 'ef-pill--yellow': variant === 'primary', 'ef-pill--sm': size === 'sm', 'is-block': block, 'is-disabled': disabled }]"
    :type="type"
    :disabled="disabled"
    @click="$emit('click', $event)"
  >
    <i class="ef-pill__tex"></i>
    <i class="ef-pill__line"></i>
    <span class="ef-pill__label"><slot /></span>
    <span class="ef-pill__ico" v-html="ico"></span>
  </button>
  <button
    v-else
    class="k-btn"
    :class="[variant, size, { block }]"
    :type="type"
    :disabled="disabled"
    @click="$emit('click', $event)"
  >
    <i v-if="icon" :class="icon"></i>
    <span v-if="$slots.default"><slot /></span>
  </button>
</template>

<script setup>
/**
 * 动作按钮。终末地主题下它换的是母本 .ef-pill 的解剖件，六套原主题保持 .k-btn 原样。
 * 图标只有母本三颗（D:/粥味数据库/ai/WINDOW/*.html body 行内）：
 *   取消/危险 = 两条 3.6 描边的叉；确认 = 6.7 半径的双弧循环箭。
 */
import { computed } from 'vue';
import { themeState } from '../stores/theme';

const props = defineProps({
  variant: { type: String, default: 'ghost' }, // primary | ghost | soft | danger | ok
  size: { type: String, default: 'md' }, // sm | md
  type: { type: String, default: 'button' },
  disabled: Boolean,
  block: Boolean,
  icon: { type: String, default: '' },
});
defineEmits(['click']);

const ef = computed(() => themeState.id === 'endfield');

const ICO_X = '<svg viewBox="0 0 24 24"><path d="M7.4 7.4l9.2 9.2M16.6 7.4l-9.2 9.2" fill="none" stroke="#454444" stroke-width="3.6" stroke-linecap="round"/></svg>';
const ICO_LOOP = '<svg viewBox="0 0 24 24"><g fill="none" stroke="#ffef01" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 9.6A6.7 6.7 0 0 0 6.5 8.6M6 14.4a6.7 6.7 0 0 0 11.5 1"/><path d="M18.4 5.6v4h-4M5.6 18.4v-4h4"/></g></svg>';

const ico = computed(() => (props.variant === 'primary' ? ICO_LOOP : ICO_X));
</script>

<style scoped>
.k-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: var(--radius-xs);
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  padding: 6px 12px;
  font-size: 12px;
  white-space: nowrap;
}
.k-btn.sm { padding: 4px 8px; font-size: 11px; }
.k-btn.block { width: 100%; }
.k-btn:hover:not(:disabled) { background: var(--bg-hover); }
.k-btn.primary {
  background: var(--accent);
  border-color: transparent;
  color: var(--on-accent);
  font-weight: 600;
}
.k-btn.soft { background: var(--bg-hover); }
.k-btn.danger { color: var(--danger); border-color: var(--danger-line); }
.k-btn.ok { color: var(--ok); border-color: var(--ok-line); }
.k-btn.ghost {
  background: transparent;
  border-color: transparent;
  color: var(--text-2);
}
.k-btn.ghost:hover:not(:disabled) { color: var(--text); background: var(--bg-hover); }
</style>
