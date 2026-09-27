<template>
  <KModal :open="open" :title="title" width="760px" @close="$emit('close')">
    <div v-if="loading" class="ae-tip"><i class="fas fa-circle-notch fa-spin"></i> 正在读取…</div>
    <div v-else-if="loadErr" class="ae-tip bad">
      <i class="fas fa-triangle-exclamation"></i> {{ loadErr }}
      <button class="k-btn sm ghost" type="button" @click="load">重试</button>
    </div>
    <template v-else>
      <div class="ae-meta">
        <span class="ae-path" :title="info.path">{{ info.host ? `${info.host}：` : '' }}{{ info.path }}</span>
        <span class="ae-state" :class="{ new: !info.exists }">{{ info.exists ? '已有这份文件' : '还没有，保存即新建' }}</span>
        <span class="ae-count">{{ bytes }} B · 约 {{ tokens }} tok</span>
      </div>
      <textarea
        ref="taEl"
        v-model="text"
        class="ae-ta"
        spellcheck="false"
        :placeholder="placeholder"
      ></textarea>
      <p class="ae-note">
        AGENTS.md 与 AGENT.md 两种名字都认（前者优先）；这里是全局 + 就近那一份叠加进系统提示词的其中一段。
        <b>保存即生效</b>，下一次提问就会带上，不用重启。
      </p>
    </template>
    <template #footer>
      <button class="k-btn sm ghost" type="button" :disabled="loading || !dirty" @click="revert">放弃更改</button>
      <button class="k-btn sm ghost" type="button" :disabled="loading" @click="load">重新读取</button>
      <button class="k-btn sm primary" type="button" :disabled="loading || !dirty" @click="save">
        <i v-if="saving" class="fas fa-circle-notch fa-spin"></i> 保存
      </button>
    </template>
  </KModal>
</template>

<script setup>
/**
 * 提示词文件编辑器（全局 / 单个项目共用一个）。
 *
 * 只把 target 交给后端去解析路径（scope=global 或 project_id），前端经手的只有一个字符串，
 * 所以这里不可能「指到任意目录去写文件」—— 那台服务没有鉴权。
 */
import { computed, ref, watch } from 'vue';
import KModal from './KModal.vue';
import { aiApi } from '../api';
import { toast } from '../stores/toast';
import { toastErr } from '../utils/errText';

const props = defineProps({
  open: Boolean,
  /** { scope: 'global' } 或 { project_id: 3 } */
  target: { type: Object, default: () => ({ scope: 'global' }) },
  title: { type: String, default: '编辑系统提示词' },
});
const emit = defineEmits(['close', 'saved']);

const taEl = ref(null);
const loading = ref(false);
const saving = ref(false);
const loadErr = ref('');
const info = ref({ path: '', name: '', host: '', exists: false, content: '' });
const text = ref('');
const saved = ref('');

const placeholder = '# 项目背景\n\n# 编码规范\n\n# 业务约定\n';
const dirty = computed(() => text.value !== saved.value);
const bytes = computed(() => new TextEncoder().encode(text.value).length);
// 与服务端同一套估算口径（CJK 0.6 / 其他 0.25），只为让人对「注入了多少」有个数
const tokens = computed(() => {
  const s = text.value;
  const cjk = (s.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) || []).length;
  return Math.ceil(cjk * 0.6 + (s.length - cjk) * 0.25);
});

async function load() {
  loading.value = true;
  loadErr.value = '';
  try {
    const d = await aiApi.agentsFile(props.target);
    info.value = d || {};
    text.value = d?.content || '';
    saved.value = text.value;
  } catch (e) {
    loadErr.value = `${e?.response?.data?.message || e?.message || '读取失败'}`;
  } finally {
    loading.value = false;
  }
}

function revert() {
  text.value = saved.value;
}

async function save() {
  saving.value = true;
  try {
    const d = await aiApi.saveAgentsFile({ ...props.target, content: text.value });
    info.value = { ...info.value, ...(d || {}) };
    saved.value = text.value;
    toast(d?.exists === false ? `已新建 ${d?.name || 'AGENTS.md'}` : '提示词已保存', 'success');
    emit('saved', d);
  } catch (e) {
    toastErr(e, '保存失败');
  } finally {
    saving.value = false;
  }
}

watch(() => [props.open, JSON.stringify(props.target)], ([o]) => {
  if (o) load();
}, { immediate: true });
</script>

<style scoped>
.ae-tip { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text-2); padding: 12px 0; }
.ae-tip.bad { color: var(--danger); }
.ae-meta { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; font-size: 11.5px; }
.ae-path {
  font-family: var(--mono);
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 60%;
}
.ae-state { color: var(--ok); flex-shrink: 0; }
.ae-state.new { color: var(--text-3); }
.ae-count { margin-left: auto; font-family: var(--mono); color: var(--text-3); flex-shrink: 0; }
.ae-ta {
  width: 100%;
  min-height: 340px;
  resize: vertical;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  color: var(--text);
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.7;
}
.ae-ta:focus { outline: none; border-color: var(--border-strong); }
.ae-note { margin: 8px 0 0; font-size: 11.5px; color: var(--text-3); line-height: 1.7; }
.ae-note b { color: var(--text-2); font-weight: 600; }
</style>
