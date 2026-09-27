<template>
  <button
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
defineProps({
  variant: { type: String, default: 'ghost' }, // primary | ghost | soft | danger | ok
  size: { type: String, default: 'md' }, // sm | md
  type: { type: String, default: 'button' },
  disabled: Boolean,
  block: Boolean,
  icon: { type: String, default: '' },
});
defineEmits(['click']);
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
