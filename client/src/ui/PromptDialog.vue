<template>
  <KModal :open="s.open" :title="s.title" width="420px" @close="on(null)">
    <label class="pd-row">
      <span v-if="s.label" class="pd-label">{{ s.label }}</span>
      <input
        ref="inp"
        v-model="val"
        class="pd-input"
        :placeholder="s.placeholder"
        spellcheck="false"
        @keydown.enter.prevent="ok()"
        @keydown.esc.prevent="on(null)"
      />
    </label>
    <template #footer>
      <button class="k-btn ghost sm" type="button" @click="on(null)">取消</button>
      <button class="k-btn sm primary" type="button" :disabled="!val.trim()" @click="ok()">{{ s.confirmText }}</button>
    </template>
  </KModal>
</template>

<script setup>
/**
 * window.prompt 的应用内替身（Electron 不支持 prompt，原来那些调用一律返回 null）。
 * 焦点与选中：打开就聚焦，默认值整段选中，直接打字即可覆盖。
 */
import { nextTick, ref, watch } from 'vue';
import KModal from './KModal.vue';
import { promptState, promptAnswer } from '../stores/prompt';

const s = promptState();
const inp = ref(null);
const val = ref('');

watch(() => s.open, (v) => {
  if (!v) return;
  val.value = s.value || '';
  nextTick(() => {
    const el = inp.value;
    if (!el) return;
    el.focus();
    el.select();
  });
});

function ok() {
  if (!val.value.trim()) return;
  on(val.value);
}
function on(v) {
  promptAnswer(v);
}
</script>

<style scoped>
.pd-row { display: flex; flex-direction: column; gap: 6px; }
.pd-label { font-size: 12px; color: var(--text-2); }
.pd-input {
  width: 100%;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  font-family: var(--mono);
  font-size: 12px;
  box-sizing: border-box;
}
.pd-input:focus { outline: none; border-color: var(--accent, var(--border)); }
</style>
