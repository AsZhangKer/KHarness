<template>
  <KModal :open="open" title="上下文导入 / 导出" width="560px" @close="$emit('close')">
    <section class="blk">
      <h4><i class="fas fa-file-export"></i> 导出会话</h4>
      <label class="field">
        <span>格式</span>
        <KDropdown :items="FORMATS" v-model="fmt" block width="100%" />
      </label>
      <label class="opt">
        <input v-model="raw" type="checkbox" class="k-check" />
        <span>导出完整数据</span>
      </label>
      <p class="hint">
        默认会把本机提供商 API Key 与「设置 → 密钥」里正则命中的内容替换成
        <code>***REDACTED***</code>——导出文件会离开本机，而工具轨迹里常夹带读到的文件内容。
        {{ fmt === 'json' ? 'JSON 含思考过程与工具轨迹，导入后可接着聊。' : 'Markdown 便于人读，不能用于导入。' }}
      </p>
      <div class="act">
        <button class="k-btn primary sm" type="button" :disabled="busy" @click="doExport">
          <i class="fas fa-download"></i> 导出到……
        </button>
        <span v-if="exportInfo" class="muted">{{ exportInfo }}</span>
      </div>
    </section>

    <hr class="sep" />

    <section class="blk">
      <h4><i class="fas fa-file-import"></i> 导入上下文</h4>
      <div class="act">
        <button class="k-btn sm" type="button" @click="pickFile">
          <i class="fas fa-folder-open"></i> 选择Json文件
        </button>
        <input ref="fileEl" type="file" accept="application/json,.json" class="hide" @change="onFile" />
      </div>
      <div v-if="preview" class="prev">
        <div class="row"><span class="k">文件</span><span class="v ellip" :title="preview.name">{{ preview.name }}</span></div>
        <div class="row"><span class="k">会话标题</span><span class="v">{{ preview.title }}</span></div>
        <div class="row"><span class="k">消息</span><span class="v">{{ preview.messages }} 条（用户 {{ preview.user }} / AI {{ preview.assistant }}）</span></div>
        <div class="row"><span class="k">工具轨迹</span><span class="v">{{ preview.withSteps }} 条消息带轨迹</span></div>
        <div class="row"><span class="k">原工作目录</span><span class="v ellip" :title="preview.cwd">{{ preview.cwd || '（无）' }}</span></div>
        <div class="row"><span class="k">来源</span><span class="v">{{ preview.redacted ? '脱敏导出' : '原样导出（含密钥）' }} · {{ preview.size }}</span></div>
      </div>
      <p v-if="preview && !preview.ok" class="err"><i class="fas fa-triangle-exclamation"></i> {{ preview.error }}</p>
      <p v-else class="hint">导入只会<b>新建一个会话</b>，不改动当前会话。</p>
      <div class="act">
        <button class="k-btn primary sm" type="button" :disabled="busy || !preview || !preview.ok" @click="doImport">
          <i class="fas fa-upload"></i> 导入为新会话
        </button>
      </div>
    </section>
  </KModal>
</template>

<script setup>
import { ref, watch } from 'vue';
import { aiApi } from '../../api';
import { toast } from '../../stores/toast';
import KModal from '../../ui/KModal.vue';
import KDropdown from '../../ui/KDropdown.vue';

const props = defineProps({
  open: { type: Boolean, default: false },
  chatId: { type: Number, default: 0 },
});
const emit = defineEmits(['close', 'imported']);

const FORMATS = [
  { value: 'json', label: 'JSON格式(兼容导入)' },
  { value: 'md', label: 'Markdown格式(可读性强)' },
];
const fmt = ref('json');
const raw = ref(false);
const busy = ref(false);
const exportInfo = ref('');
const preview = ref(null);
const fileEl = ref(null);
// 解析出来的原文，导入时整份回传
let parsed = null;

// 每次重新打开都清空上一次的选择，避免误按「导入」把旧文件灌进新会话
watch(
  () => props.open,
  (v) => {
    if (!v) return;
    exportInfo.value = '';
    preview.value = null;
    parsed = null;
  }
);

function download(text, filename, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Markdown 走服务端同一份上下文，所以能带上归档消息与工具轨迹 */
function toMarkdown(ctx) {
  const lines = [`# ${ctx.chat?.title || '会话'}`, ''];
  lines.push(`- 导出时间：${new Date(ctx.exported_at || Date.now()).toLocaleString()}`);
  lines.push(`- 工作目录：${ctx.chat?.cwd || '（未设置）'}`);
  lines.push(`- 模型：${ctx.chat?.model?.model_id || '（未知）'}`);
  if (ctx.redacted) lines.push('- 本文件已脱敏（密钥替换为 ***REDACTED***）');
  lines.push('');
  if (ctx.chat?.summary) lines.push('## 会话摘要', '', ctx.chat.summary, '');
  for (const m of ctx.messages || []) {
    lines.push(m.role === 'user' ? '## 你' : `## AI${m.model ? ` · ${m.model}` : ''}`, '');
    const steps = Array.isArray(m.steps) ? m.steps : [];
    if (steps.length) {
      lines.push('<details><summary>工具轨迹（' + steps.length + ' 步）</summary>', '');
      for (const s of steps) {
        if (s.type === 'tool') lines.push(`- ▶ \`${s.name}\` ${JSON.stringify(s.args || {}).slice(0, 200)}`);
        else if (s.type === 'result') lines.push(`- ◀ \`${s.name}\` ${(s.error || s.output || '').toString().split('\n')[0].slice(0, 200)}`);
        else if (s.type === 'note') lines.push(`- ℹ ${s.message}`);
      }
      lines.push('', '</details>', '');
    }
    if ((m.reasoning || '').trim()) lines.push('<details><summary>思考过程</summary>', '', m.reasoning, '', '</details>', '');
    lines.push(m.content || '', '');
  }
  return lines.join('\n');
}

async function doExport() {
  if (!props.chatId) return toast('还没有会话可导出', 'warn');
  busy.value = true;
  exportInfo.value = '';
  try {
    const ctx = await aiApi.exportContext(props.chatId, raw.value);
    const safe = String(ctx.chat?.title || 'context').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
    if (fmt.value === 'md') {
      download(toMarkdown(ctx), `${safe}.md`, 'text/markdown;charset=utf-8');
    } else {
      download(JSON.stringify(ctx, null, 2), `${safe}.context.json`, 'application/json;charset=utf-8');
    }
    exportInfo.value = `已导出 ${ctx.messages?.length || 0} 条消息${raw.value ? '（原样，含密钥）' : '（已脱敏）'}`;
    toast('导出完成', 'success');
  } catch (e) {
    // 拦截器已弹错误提示
  } finally {
    busy.value = false;
  }
}

function pickFile() {
  fileEl.value?.click();
}

// 前端先按后端同口径校验一遍，好把问题写在「预览」里而不是等报错
async function onFile(ev) {
  const f = ev.target?.files?.[0];
  if (!f) return;
  preview.value = null;
  parsed = null;
  let text = '';
  try {
    text = await f.text();
  } catch (e) {
    return toast('文件读取失败', 'error');
  }
  let obj = null;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return toast('不是合法的 JSON 文件', 'error');
  }
  const msgs = Array.isArray(obj?.messages) ? obj.messages : [];
  const okKind = obj?.kind === 'kharness.context';
  const bytes = f.size;
  preview.value = {
    name: f.name,
    ok: okKind && msgs.length > 0,
    error: !okKind
      ? '这个文件不是 KHarness 的上下文导出（缺少 kind: kharness.context 标识）'
      : !msgs.length
        ? '文件里没有消息'
        : '',
    title: obj?.chat?.title || '（无标题）',
    messages: msgs.length,
    user: msgs.filter((m) => m.role === 'user').length,
    assistant: msgs.filter((m) => m.role === 'assistant').length,
    withSteps: msgs.filter((m) => Array.isArray(m.steps) && m.steps.length).length,
    cwd: obj?.chat?.cwd || '',
    redacted: obj?.redacted === true,
    size: bytes > 1048576 ? (bytes / 1048576).toFixed(2) + ' MB' : Math.round(bytes / 1024) + ' KB',
  };
  parsed = obj;
  ev.target.value = '';
}

async function doImport() {
  if (!parsed) return;
  busy.value = true;
  try {
    const res = await aiApi.importContext(parsed);
    const data = res?.data || {};
    // 失败详情（模型降级、项目没匹配上）都在 message 里，直接照播
    toast(res?.message || '导入完成', 'success');
    emit('imported', data);
    emit('close');
  } catch (e) {
    // 拦截器已经弹过一次错误提示，这里只收尾
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.blk h4 {
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 8px;
}
.sep {
  border: 0;
  border-top: 1px solid var(--border-soft);
  margin: 16px 0;
}
.opt {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-2);
  margin-top: 10px;
  cursor: pointer;
}
.hint {
  margin: 8px 0 0;
  font-size: 11.5px;
  line-height: 1.65;
  color: var(--text-3);
}
.hint code {
  font-size: 11px;
  padding: 0 3px;
  border-radius: 4px;
  background: var(--bg-hover);
}
.act {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}
.hide {
  display: none;
}
.prev {
  margin-top: 10px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  background: var(--bg-panel);
  padding: 6px 12px;
}
.row {
  display: flex;
  gap: 10px;
  padding: 5px 0;
  font-size: 12px;
  border-bottom: 1px solid var(--border-soft);
}
.row:last-child {
  border-bottom: 0;
}
.k {
  flex: 0 0 82px;
  color: var(--text-3);
}
.v {
  flex: 1;
  min-width: 0;
  color: var(--text);
}
.ellip {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.err {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--danger);
}
.muted {
  font-size: 12px;
  color: var(--text-3);
}
</style>
