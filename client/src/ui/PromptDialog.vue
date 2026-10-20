<template>
  <!-- 终末地照母本「重命名对话框.html」：白卡 + 大标题 + 灰胶囊输入 + 提示 + 两颗胶囊。
       母本 body 里的 .form-group / .form-title / .scifi-input / .form-helper 原样用，只换文字。 -->
  <KModal
    :open="s.open"
    :title="s.title"
    board="form"
    width="420px"
    :ef-width="720"
    auto-footer
    :ok-text="s.confirmText"
    :ok-disabled="!val.trim()"
    @close="on(null)"
    @ok="ok()"
  >
    <input
      ref="inp"
      v-model="val"
      :class="ef ? 'scifi-input' : 'pd-input'"
      :placeholder="s.placeholder"
      spellcheck="false"
      @keydown="onKey"
    />
    <div v-if="s.label" :class="ef ? 'form-helper' : 'pd-label'">{{ s.label }}</div>
  </KModal>
</template>

<script setup>
/**
 * window.prompt 的应用内替身（Electron 不支持 prompt，原来那些调用一律返回 null）。
 * 焦点与选中：打开就聚焦，默认值整段选中，直接打字即可覆盖。
 */
import { computed, nextTick, ref, watch } from 'vue';
import KModal from './KModal.vue';
import { themeState } from '../stores/theme';
import { promptState, promptAnswer } from '../stores/prompt';
import { isImeComposing } from '../utils/ime';

const s = promptState();
// 终末地用母本的 .scifi-input / .form-helper，其余六套主题用原来那套 .pd-input / .pd-label
const ef = computed(() => themeState.id === 'endfield');
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

// 合成中的 Enter/Esc 是给输入法用的（选词/取消候选），一律不许抢 ——
// 抢了会把 compositionend 弄丢，v-model 从此对这个框失聪（详见 utils/ime.js 顶部那段）。
function onKey(e) {
  if (isImeComposing(e)) return;
  if (e.key === 'Enter') { e.preventDefault(); ok(); }
  else if (e.key === 'Escape') { e.preventDefault(); on(null); }
}
</script>

<style scoped>
/* 终末地：母本的 .scifi-input 由 styles/endfield-dialogs.css 提供（尺寸字号都是母本原值） */
.scifi-input { box-sizing: border-box; }

/* 其余六套主题：基线原样，一个值没改 */
.pd-row { display: flex; flex-direction: column; gap: 6px; }
.pd-label { font-size: 12px; color: var(--text-2); }
.pd-input {
  width: 100%;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--bg-input);
  color: var(--text);
  font-family: var(--mono);
  font-size: 12px;
  box-sizing: border-box;
}
.pd-input:focus { outline: none; border-color: var(--accent, var(--border)); }
</style>
