<template>
  <KModal :open="s.open" :title="s.title || '确认'" width="420px" @close="on(false)">
    <p style="margin:0;line-height:1.6;white-space:pre-wrap">{{ s.message }}</p>
    <template #footer>
      <button class="k-btn ghost sm" type="button" @click="on(false)">取消</button>
      <button class="k-btn sm" :class="s.danger ? 'danger' : 'primary'" type="button" @click="on(true)">
        {{ okText }}
      </button>
    </template>
  </KModal>
</template>

<script setup>
import { computed } from 'vue';
import KModal from './KModal.vue';
import { confirmState, confirmAnswer } from '../stores/confirm';

const s = confirmState();
// 红按钮不等于「删除」：文案由调用点给，没给就是中性的「确定」
const okText = computed(() => s.okText || '确定');

function on(v) {
  confirmAnswer(v);
}
</script>
