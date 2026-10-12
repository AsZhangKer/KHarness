<!--
  子智能体的执行步骤弹窗（第七十五轮他点的那条：点卡片能看到它到底做了什么）。
  整体长得像主聊天窗：正文直接复用 ChatMessage 渲染那份 steps（工具卡 / 参数行 / 正文分段同一套走法），
  区别是没有输入框 —— 这里只能看，不能替它说话。
  跑着的时候 1.5 秒拉一次 detail（服务端每一步都写进 steps_json），所以「它在查什么」是实时看得见的。
-->
<template>
  <KModal :open="!!id" :title="titleText" width="860px" @close="close">
    <div class="ss-meta">
      <span class="badge" :class="badgeClass">{{ stateText }}</span>
      <span class="mono muted">{{ id }}</span>
      <span v-if="d.model" class="muted">{{ d.model }}</span>
      <span class="muted">{{ (d.iter || 0) }} 轮 / {{ (d.steps || []).length }} 条轨迹</span>
      <button v-if="running" class="k-btn sm danger" type="button" :disabled="stopping" @click="kill">
        <i v-if="stopping" class="fas fa-circle-notch fa-spin"></i>
        {{ txt('chat.agent.stop') }}
      </button>
    </div>

    <div v-if="d.task" class="ss-task">{{ d.task }}</div>

    <div v-if="!(d.steps || []).length && running" class="muted ss-empty">{{ txt('chat.agent.stepsWaiting') }}</div>
    <div v-else-if="!(d.steps || []).length" class="muted ss-empty">{{ txt('chat.agent.stepsEmpty') }}</div>

    <!-- 一整份 steps 交给一条 ChatMessage：它自己会把 {type:'text'} 当正文、把调用行并进结果卡 -->
    <div v-else class="ss-stream">
      <ChatMessage
        role="assistant"
        content=""
        :steps="d.steps"
        :busy="false"
        :flat="true"
        :index="0"
        :msg-id="0"
      />
    </div>

    <pre v-if="d.error" class="ss-err">{{ d.error }}</pre>

    <!-- 结论放结尾（第七十七轮他的口径）：交回主 Agent 的那份是工具回执式的、不画气泡，
         人要看的全文就落在这扇窗的最后 -->
    <div v-if="finalText" class="ss-final">
      <div class="ss-final-title">{{ txt('chat.agent.conclusion') }}</div>
      <div class="ss-final-body md" v-html="renderMarkdownCached(finalText)"></div>
    </div>

    <template #footer>
      <button class="k-btn sm ghost" type="button" @click="close">{{ txt('chat.agent.close') }}</button>
    </template>
  </KModal>
</template>

<script setup>
import { computed, onUnmounted, ref, watch } from 'vue';
import KModal from '../../ui/KModal.vue';
import ChatMessage from './ChatMessage.vue';
import { aiApi } from '../../api';
import { txt } from '../../copy';
import { renderMarkdownCached } from '../../utils/mdcache';

const props = defineProps({
  id: { type: String, default: '' },
  name: { type: String, default: '' },
  chatId: { type: Number, default: null },
});
const emit = defineEmits(['close', 'killed']);

const d = ref({});
const stopping = ref(false);
let timer = null;

const running = computed(() => {
  const s = String(d.value.status || '');
  return s === 'running' || s === 'queued' || !!d.value.running;
});
const stateText = computed(() => ({
  queued: txt('chat.agent.stQueued'), running: txt('chat.agent.stRunning'),
  done: txt('chat.agent.stDone'), failed: txt('chat.agent.stFailed'), killed: txt('chat.agent.stKilled'),
}[String(d.value.status || 'queued')] || d.value.status || ''));
const badgeClass = computed(() => (running.value ? 'on' : d.value.status === 'done' ? '' : 'err'));
const titleText = computed(() => txt('chat.agent.modalTitle', { name: props.name || d.value.name || props.id || '' }));
// 它还在跑就没有结论可看；跑完（含被停/失败）才把 result 摊在窗尾
const finalText = computed(() => (running.value ? '' : String(d.value.result || '').trim()));

async function load() {
  if (!props.id) return;
  try {
    const r = await aiApi.getSubagent(props.id);
    if (r && !r.error) d.value = r;
  } catch (e) { /* 拉不到就留着上一份，别把弹窗弄成空白 */ }
}

// 跑着就每 1.5 秒对一次账；结束（或关窗）立刻停手，别留一个没人要的轮询
function arm() {
  if (timer || !props.id) return;
  timer = setInterval(() => { if (running.value) load(); else disarm(); }, 1500);
}
function disarm() {
  if (timer) { clearInterval(timer); timer = null; }
}

async function kill() {
  stopping.value = true;
  try {
    const r = await aiApi.killSubagent(props.id, props.chatId || undefined);
    emit('killed', { id: props.id, message: r?.message || '' });
    await load();
  } finally {
    stopping.value = false;
  }
}

function close() {
  disarm();
  emit('close');
}

watch(() => props.id, async (v) => {
  disarm();
  d.value = {};
  if (!v) return;
  await load();
  arm();
}, { immediate: true });

onUnmounted(disarm);
</script>

<style scoped>
.ss-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; font-size: 12px; }
.ss-meta .grow { flex: 1; }
/* 状态角标：这一栏自己画（右栏那份是 scoped 样式，这里借不到） */
.badge {
  font-size: 11px; line-height: 1; padding: 4px 7px; border-radius: 999px;
  border: 1px solid var(--line, #333); color: var(--muted, #9aa);
}
.badge.on { border-color: var(--accent, #4a7cff); color: var(--accent, #4a7cff); }
.badge.err { border-color: var(--danger, #e5533d); color: var(--danger, #e5533d); }
.ss-task {
  white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.6;
  padding: 8px 10px; border-left: 2px solid var(--line, #333); margin-bottom: 10px; opacity: .92;
}
.ss-empty { padding: 14px 0; }
.ss-stream { max-height: 52vh; overflow: auto; }
.ss-final { margin-top: 12px; border-top: 1px solid var(--line, #333); padding-top: 10px; }
.ss-final-title { font-size: 12px; color: var(--muted, #9aa); margin-bottom: 6px; }
.ss-final-body { font-size: 13px; line-height: 1.7; }
.ss-err {
  margin-top: 10px; padding: 8px 10px; white-space: pre-wrap; word-break: break-word;
  font-size: 12px; color: var(--danger, #e5533d);
}
</style>
