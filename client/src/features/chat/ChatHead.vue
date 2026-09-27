<template>
  <header class="chat-head">
    <div class="title">
      <template v-if="projectName">
        <span class="muted">{{ projectName }} / </span>
      </template>
      <span>{{ title || '新会话' }}</span>
    </div>
    <div class="actions">
      <button class="icon-btn" :class="{ on: agentMode }" type="button" title="Agent 开关" @click="toggle('agentMode')">
        <i class="fas fa-screwdriver-wrench"></i>
      </button>
      <button class="icon-btn" :class="{ on: planMode }" type="button" title="Plan 任务模式" @click="toggle('planMode')">
        <i class="fas fa-list-check"></i>
      </button>
      <button class="icon-btn" :class="{ on: readonlyMode }" type="button" title="只读模式" @click="toggle('readonlyMode')">
        <i class="fas fa-eye"></i>
      </button>
      <button class="icon-btn" :class="{ on: autoMode }" type="button" title="模型池自动切换" @click="toggle('autoMode')">
        <i class="fas fa-layer-group"></i>
      </button>
      <button class="icon-btn" type="button" :title="'审批模式：' + approvalMode" @click="$emit('cycle-approval')">
        <i class="fas fa-shield-halved"></i>
      </button>
    </div>
  </header>
</template>

<script setup>
const props = defineProps({
  title: { type: String, default: '' },
  projectName: { type: String, default: '' },
  agentMode: Boolean,
  planMode: Boolean,
  readonlyMode: Boolean,
  autoMode: Boolean,
  approvalMode: { type: String, default: 'default' },
});

const emit = defineEmits(['toggle', 'cycle-approval']);

function toggle(key) {
  emit('toggle', { key, value: !props[key] });
}
</script>

<style scoped>
.chat-head {
  height: 46px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px;
  border-bottom: 1px solid var(--line-soft);
  flex-shrink: 0;
}
.title {
  font-weight: 550;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.title .muted { color: var(--text-3); font-weight: 400; }
.actions {
  margin-left: auto;
  display: flex;
  gap: 4px;
}
.icon-btn {
  width: 30px;
  height: 30px;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-3);
}
.icon-btn:hover { background: var(--bg-hover); color: var(--text); }
.icon-btn.on {
  background: var(--bg-active);
  border-color: var(--line);
  color: var(--text);
}
</style>
