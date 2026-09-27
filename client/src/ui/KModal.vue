<template>
  <Teleport to="body">
    <Transition name="kpop">
      <div v-if="open" class="k-modal-root" @click.self="$emit('close')">
        <div class="k-modal" :style="{ width }" role="dialog" :aria-label="title">
        <header class="k-modal-head">
          <h3>{{ title }}</h3>
          <button type="button" class="k-icon-btn" @click="$emit('close')" aria-label="关闭">
            <i class="fas fa-xmark"></i>
          </button>
        </header>
        <div class="k-modal-body"><slot /></div>
        <footer v-if="$slots.footer" class="k-modal-foot"><slot name="footer" /></footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
defineProps({
  open: Boolean,
  title: { type: String, default: '' },
  width: { type: String, default: '480px' },
});
defineEmits(['close']);
</script>

<style scoped>
.k-modal-root {
  position: fixed;
  inset: 0;
  background: var(--scrim);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 80;
  padding: 24px;
}
.k-modal {
  background: var(--surface-pop);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  max-height: min(80vh, 720px);
  display: flex;
  flex-direction: column;
  width: 100%;
}
/* 开：底板只淡入，面板本身从下方升起 + 两下衰减的抖动；关：面板快速下落渐隐。
   注意根节点的过渡时长必须 ≥ 面板动画时长：Vue 到点会摘掉 *-active 类，
   类一没，面板那条 animation 就被掐断、直接弹回终态，看着就是抖到一半卡住。 */
.kpop-enter-active { transition: opacity 0.28s ease; }
.kpop-enter-from { opacity: 0; }
.kpop-leave-active { transition: opacity 0.18s ease; }
.kpop-leave-to { opacity: 0; }
.kpop-enter-active .k-modal { animation: kh-pop-in 0.24s cubic-bezier(0.22, 1.08, 0.36, 1); }
.kpop-leave-active .k-modal { animation: kh-pop-out 0.16s cubic-bezier(0.4, 0, 0.9, 0.35) forwards; }
@media (prefers-reduced-motion: reduce) {
  .kpop-enter-active .k-modal,
  .kpop-leave-active .k-modal { animation: none; }
}
.k-modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-soft);
}
.k-modal-head h3 { margin: 0; font-size: 14px; font-weight: 600; }
.k-modal-body { padding: 16px; overflow: auto; }
.k-modal-foot {
  padding: 12px 16px;
  border-top: 1px solid var(--border-soft);
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.k-icon-btn {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-xs);
  color: var(--text-2);
}
.k-icon-btn:hover { background: var(--bg-hover); }
</style>
