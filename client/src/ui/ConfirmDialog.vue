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
const okText = computed(() => (s.danger ? '删除' : '确定'));

function on(v) {
  confirmAnswer(v);
}
</script>
