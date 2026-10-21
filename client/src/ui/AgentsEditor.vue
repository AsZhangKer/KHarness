<template>
  <KModal :open="open" :title="title" board="panel" tall code="AGENTS.MD" ghost="AGENTS" width="760px" ef-width="1280" @close="$emit('close')">
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
      <div class="ae-vars">
        <span class="ae-vars-label">插入占位符（注入时自动替换成真值）：</span>
        <button
          v-for="v in VARS"
          :key="v.key"
          class="ae-var"
          type="button"
          :title="`${v.desc}｜例：${v.sample}`"
          @click="insertVar(v.key)"
        >{{ '{' + v.key + '}' }}</button>
      </div>
      <p class="ae-note">
        AGENTS.md 与 AGENT.md 两种名字都认（前者优先）；这里是全局 + 就近那一份叠加进系统提示词的其中一段。
        <b>保存即生效</b>，下一次提问就会带上，不用重启。<br />
        占位符在<b>注入的那一刻</b>才替换，文件里存着的仍是这几个记号本身 —— 所以换会话、换机器、明天再跑，
        展开的都是当下的真值，不会被"定格"成写下它的那一天。想在提示词里写一个字面量的 <code>{cwd}</code>（教模型这个记号本身），
        写成 <code>{{cwd}}</code>。
      </p>
    </template>
    <template #footer>
      <KButton variant="ghost" size="sm" :disabled="loading || !dirty" @click="revert">放弃更改</KButton>
      <KButton variant="ghost" size="sm" :disabled="loading" @click="load">重新读取</KButton>
      <KButton variant="primary" size="sm" :disabled="loading || !dirty" @click="save">保存</KButton>
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
import KButton from './KButton.vue';
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

/* 可用的占位符。**必须与后端 utils/agentsmd.js 的 VAR_KEYS / promptVars 一致** ——
   这里只是"给用户看有哪些、点一下插进去"，真正的替换在注入时由后端做；
   两边不同步的话按钮插进去的记号不会被展开，看起来就像这个功能坏了。 */
const VARS = [
  { key: 'cwd', desc: '完整绝对工作目录（到了某个会话 / 项目会给 AI 的时候自适应）', sample: 'D:\\1\\my-project' },
  { key: 'time', desc: '当前时间，hh:mm:ss', sample: '09:41:07' },
  { key: 'date', desc: '当前日期，yyyy/mm/dd', sample: '2026/10/16' },
  { key: 'os', desc: '当前系统（平台 + 内核版本 + 架构）', sample: 'Windows（win32 · 10.0.26100 · x64）' },
];

/** 在光标处插入记号；没有光标（没聚焦过）就追加到末尾 */
function insertVar(key) {
  const token = `{${key}}`;
  const el = taEl.value;
  if (!el) { text.value += token; return; }
  const start = el.selectionStart ?? text.value.length;
  const end = el.selectionEnd ?? start;
  text.value = text.value.slice(0, start) + token + text.value.slice(end);
  // 插完把光标摆到记号之后，连着插两个也不会叠在一起
  requestAnimationFrame(() => {
    try { el.focus(); el.setSelectionRange(start + token.length, start + token.length); } catch (e) { /* 不支持的浏览器就算了 */ }
  });
}
const dirty = computed(() => text.value !== saved.value);
const bytes = computed(() => new TextEncoder().encode(text.value).length);
// 与服务端 utils/agentsmd.js 的 estimateTokens 同一套口径（CJK 1 tok/字、其余 0.3），
// 只为让人对「注入了多少」有个数。**别改回 0.6/0.25**：那会让这里显示的估算比服务端口径小一半，
// 用户对着「约 200 tok」的内容却看到真实占用是 400，只会以为是上下文算错了。
const tokens = computed(() => {
  const s = text.value;
  const cjk = (s.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  return Math.ceil(cjk * 1 + (s.length - cjk) * 0.3);
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
/* 占位符那一排：一排小按钮，点一下就插到光标处 */
.ae-vars {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
  font-size: 11.5px;
  color: var(--text-3);
}
.ae-vars-label { margin-right: 2px; }
.ae-var {
  font-family: var(--mono);
  font-size: 11.5px;
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--bg-panel);
  color: var(--text-2);
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.ae-var:hover { color: var(--text); border-color: var(--border-strong); background: var(--bg-hover); }
.ae-note { margin: 8px 0 0; font-size: 11.5px; color: var(--text-3); line-height: 1.7; }
.ae-note b { color: var(--text-2); font-weight: 600; }
.ae-note code {
  font-family: var(--mono);
  font-size: 11px;
  padding: 0 4px;
  border-radius: 4px;
  background: var(--bg-panel);
  color: var(--text-2);
}
</style>
