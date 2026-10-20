<template>
  <!-- 终末地照母本「弹窗 · 危险解锁框.html」：黄标头 + 挂锁 + 一段说明 + 两颗胶囊；
       其余六套主题走原来的 .k-modal（KModal 内部按主题分流，这里只传文案）。 -->
  <KModal
    :open="s.open"
    :title="s.title || '确认'"
    :code="s.danger ? 'DANGER.CONFIRM' : 'CONFIRM.DIALOG'"
    board="dialog"
    :cancel-text="cancelText"
    :ok-text="okText"
    :note="noteText"
    width="420px"
    :ef-width="960"
    auto-footer
    @close="on(false)"
    @ok="on(true)"
  >
    {{ s.message }}
  </KModal>
</template>

<script setup>
import { computed } from 'vue';
import KModal from './KModal.vue';
import { confirmState, confirmAnswer } from '../stores/confirm';

const s = confirmState();
// 红按钮不等于「删除」：文案由调用点给，没给就是中性的「确定」
const okText = computed(() => s.okText || '确定');
const cancelText = computed(() => s.cancelText || '取消');
// 母本第二行小字（.tx2）写的是「且无法撤销」那一类后果说明；调用点给了才出
const noteText = computed(() => s.note || '');

function on(v) {
  confirmAnswer(v);
}
</script>
