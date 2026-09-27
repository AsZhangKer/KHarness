<template>
  <aside class="rf" :class="{ collapsed }">
    <button v-if="collapsed" class="rf-edge" type="button" title="展开远端文件区" @click="collapsed = false">
      <i class="fas fa-folder-tree"></i>
    </button>
    <!-- 收起/展开走宽度过渡（和左右侧栏同一套手感）；内容用 v-show 让位，
         不然 v-if 会在收起瞬间把整块 DOM 拆掉，重建时列表与预览的状态都得重新拉一次 -->
    <div v-show="!collapsed" class="rf-inner">
      <header class="rf-head">
        <i class="fas fa-server"></i>
        <span class="t ellip" :title="`${host.username}@${host.host}:${host.port}`">{{ host.name }}</span>
        <span class="grow"></span>
        <button class="icon-btn sm" type="button" title="上一级" :disabled="atRoot || loading" @click="cd(parent)">
          <i class="fas fa-arrow-up"></i>
        </button>
        <button class="icon-btn sm" type="button" title="刷新" :disabled="loading" @click="load(path)">
          <i class="fas" :class="loading ? 'fa-circle-notch fa-spin' : 'fa-rotate'"></i>
        </button>
        <button class="icon-btn sm" type="button" title="收起" @click="collapsed = true">
          <i class="fas fa-angles-right"></i>
        </button>
      </header>

      <div class="rf-path">
        <input v-model="pathInput" spellcheck="false" :placeholder="path || '/'" @keydown.enter="go(pathInput)" />
        <button class="icon-btn sm" type="button" title="前往" @click="go(pathInput)"><i class="fas fa-arrow-right"></i></button>
      </div>

      <div class="rf-tools">
        <button class="k-btn ghost sm" type="button" title="在当前目录新建目录" @click="newDir">
          <i class="fas fa-folder-plus"></i> 目录
        </button>
        <button class="k-btn ghost sm" type="button" title="在当前目录新建文件" @click="newFile">
          <i class="fas fa-file-circle-plus"></i> 文件
        </button>
        <button class="k-btn ghost sm" type="button" :disabled="!cwdSettable" title="把会话的工作目录切到这里" @click="setAsCwd">
          <i class="fas fa-crosshairs"></i> 设为工作目录
        </button>
      </div>

      <div v-if="error" class="rf-err"><i class="fas fa-triangle-exclamation"></i> {{ error }}</div>
      <div v-else-if="loading && !items.length" class="rf-empty">读取中…</div>
      <div v-else-if="!items.length" class="rf-empty">空目录</div>
      <div v-else class="rf-list">
        <button
          v-for="it in items"
          :key="it.name"
          class="rf-row"
          :class="{ active: preview && preview.path === join(path, it.name) }"
          type="button"
          @click="onRow(it)"
          @contextmenu.prevent="rowMenu(it, $event)"
        >
          <i class="fas" :class="iconOf(it)"></i>
          <span class="name ellip" :title="it.name">{{ it.name }}</span>
          <span class="size muted">{{ it.type === 'dir' ? '' : fmtSize(it.size) }}</span>
        </button>
      </div>

      <div v-if="preview" class="rf-view">
        <div class="rf-view-head">
          <span class="ellip" :title="preview.path">{{ base(preview.path) }}</span>
          <span class="grow"></span>
          <span v-if="preview.saving" class="muted"><i class="fas fa-circle-notch fa-spin"></i> 保存中</span>
          <button class="k-btn sm" type="button" :disabled="preview.saving || preview.content === preview.origin" @click="saveFile">
            <i class="fas fa-floppy-disk"></i> 保存
          </button>
          <button class="icon-btn sm" type="button" title="关闭" @click="preview = null"><i class="fas fa-xmark"></i></button>
        </div>
        <textarea v-model="preview.content" spellcheck="false" @input="dirty = true"></textarea>
        <div class="muted rf-view-tip">
          保存会写到远端并记一条可撤销操作（撤销卡在同一条对话里）；改远端文件请谨慎。
        </div>
      </div>

      <Teleport to="body">
        <div v-if="menu" class="ctx-mask" @mousedown="menu = null" @contextmenu.prevent="menu = null"></div>
        <div
          v-if="menu"
          class="ctx-menu"
          :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
          @click="menu = null"
          @contextmenu.prevent="menu = null"
        >
          <button type="button" @click="doRename(menu.item)"><i class="fas fa-pen"></i> 重命名</button>
          <button type="button" class="danger" @click="doDelete(menu.item)"><i class="fas fa-trash-can"></i> 删除</button>
          <button type="button" @click="copyPath(menu.item)"><i class="fas fa-copy"></i> 复制路径</button>
        </div>
      </Teleport>
    </div>
  </aside>
</template>

<script setup>
/**
 * 远端文件快捷操作区：当前会话是远程时，占据原本内置浏览器那一列。
 * 只走 /api/ai/remote 的 SFTP 接口；写操作一律由后端记可撤销记录，这里不自己 rm。
 */
import { computed, ref, watch } from 'vue';
import { aiApi } from '../../api';
import { toast } from '../../stores/toast';
import { toastErr, errFull } from '../../utils/errText';
import { promptDialog } from '../../stores/prompt';
import { useChatStore } from './chatStore';

const props = defineProps({
  host: { type: Object, required: true },
  cwd: { type: String, default: '' },
});

const store = useChatStore();
const collapsed = ref(false);
const loading = ref(false);
const error = ref('');
const path = ref('/');
const pathInput = ref('');
const items = ref([]);
const preview = ref(null);
const dirty = ref(false);
const menu = ref(null);

const join = (a, b) => `${String(a).replace(/\/+$/, '')}/${b}`;
const base = (p) => String(p).split('/').pop();
const parent = computed(() => {
  const s = String(path.value).replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i <= 0 ? '/' : s.slice(0, i);
});
const atRoot = computed(() => !path.value || path.value === '/');
const cwdSettable = computed(() => !!store.state.chatId && store.state.cwd !== path.value);

function iconOf(it) {
  if (it.type === 'dir') return 'fa-folder';
  if (it.mode && (it.mode & 0o111)) return 'fa-file-code';
  return 'fa-file-lines';
}
function fmtSize(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v}B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)}K`;
  return `${(v / 1024 / 1024).toFixed(1)}M`;
}

async function load(p) {
  loading.value = true;
  error.value = '';
  try {
    const r = await aiApi.remoteList(props.host.id, p);
    path.value = r?.real_path || r?.path || p || '/';
    pathInput.value = path.value;
    items.value = r?.items || [];
  } catch (e) {
    // 这里有一整条错误条可以放原因：显示「概括：详情」全句，别只留 axios 的 status code
    error.value = errFull(e, '列不出这个目录');
  } finally {
    loading.value = false;
  }
}
function go(p) { load(p || pathInput.value || '/'); }
function cd(p) { load(p); }

async function onRow(it) {
  const full = join(path.value, it.name);
  if (it.type === 'dir') return go(full);
  try {
    const r = await aiApi.remoteRead(props.host.id, full);
    preview.value = { path: full, content: r?.content ?? '', origin: r?.content ?? '', saving: false };
    dirty.value = false;
  } catch (e) { /* 拦截器弹过了 */ }
}

async function saveFile() {
  if (!preview.value) return;
  preview.value.saving = true;
  try {
    const r = await aiApi.remoteWrite(props.host.id, { path: preview.value.path, content: preview.value.content, chat_id: store.state.chatId || undefined });
    preview.value.origin = preview.value.content;
    toast(`已保存到远端 ${base(preview.value.path)}${r?.undo_id ? '（可撤销）' : ''}`, 'success');
    await load(path.value);
  } catch (e) { /* 弹过了 */ } finally {
    preview.value.saving = false;
  }
}

async function newDir() {
  const name = await promptDialog({ title: '新建远端目录', label: `建在 ${path.value} 下`, value: 'new-dir', confirmText: '创建' });
  if (!name) return;
  try {
    await aiApi.remoteMkdir(props.host.id, { path: join(path.value, name) });
    toast('已创建远端目录', 'success');
    await load(path.value);
  } catch (e) { /* 弹过了 */ }
}
async function newFile() {
  const name = await promptDialog({ title: '新建远端文件', label: `建在 ${path.value} 下`, value: 'new.txt', confirmText: '创建' });
  if (!name) return;
  const full = join(path.value, name);
  try {
    await aiApi.remoteWrite(props.host.id, { path: full, content: '', chat_id: store.state.chatId || undefined });
    preview.value = { path: full, content: '', origin: '', saving: false };
    toast('已创建远端文件', 'success');
    await load(path.value);
  } catch (e) { /* 弹过了 */ }
}
function rowMenu(it, e) {
  menu.value = { item: it, x: e.clientX, y: e.clientY };
}
async function doRename(it) {
  const full = join(path.value, it.name);
  const to = await promptDialog({ title: '改名', label: `${full} → 新名字`, value: it.name, confirmText: '改名' });
  if (!to || to === it.name) return;
  try {
    await aiApi.remoteRename(props.host.id, { path: full, new_path: join(path.value, to), chat_id: store.state.chatId || undefined });
    toast('已改名（可撤销）', 'success');
    await load(path.value);
  } catch (e) { /* 弹过了 */ }
}
async function doDelete(it) {
  const full = join(path.value, it.name);
  if (!window.confirm(`删除远端 ${full}？\n\n会先移到那台机器的 ~/.kh-undo/ 下，本机这条对话里可以撤销。`)) return;
  try {
    await aiApi.remoteDelete(props.host.id, { path: full, is_dir: it.type === 'dir', chat_id: store.state.chatId || undefined });
    toast('已删除（可撤销）', 'success');
    if (preview.value && preview.value.path === full) preview.value = null;
    await load(path.value);
  } catch (e) { /* 弹过了 */ }
}
async function copyPath(it) {
  try { await navigator.clipboard.writeText(join(path.value, it.name)); toast('路径已复制', 'success'); } catch { /* 剪贴板不可用就算了 */ }
}
async function setAsCwd() {
  try {
    await store.setCwd(path.value);
    toast(`会话目录已切到 ${path.value}`, 'success');
  } catch (e) {
    toastErr(e, '切换失败');
  }
}

// 换机器（切换远程会话）就从它的起始目录重新列
watch(() => props.host.id, () => { preview.value = null; load(props.host.default_cwd || '/'); });
watch(() => props.cwd, (v) => { if (v && v !== path.value && v.startsWith('/')) load(v); });

load(props.host.default_cwd || '/');
</script>

<style scoped>
.rf {
  width: var(--dock-w, 300px);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  padding: 8px;
  border-left: 1px solid var(--border-soft);
  background: var(--bg);
  min-height: 0;
  position: relative;
  overflow: hidden;   /* 收/展的过渡期间把来不及缩的内容裁掉，别让它溢出到聊天区 */
  transition: width var(--dur) var(--ease);
}
/* 栏内所有东西搬进这一层：收起时整块 v-show 让位，宽度动画期间不会被拆 DOM 重新拉列表 */
.rf-inner {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
  min-height: 0;
  min-width: 0;
}
.rf.collapsed { width: 34px; padding: 6px 3px; align-items: center; }
.rf-edge {
  width: 26px; height: 26px; border-radius: 8px;
  color: var(--text-2);
  display: inline-flex; align-items: center; justify-content: center;
}
.rf-edge:hover { background: var(--bg-hover); color: var(--text); }
.rf-head { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.rf-head .t { font-weight: 600; max-width: 120px; }
.rf-head .grow, .rf-view-head .grow, .rf-path .grow { flex: 1; }
.rf-path { display: flex; align-items: center; gap: 4px; }
.rf-path input {
  flex: 1; min-width: 0;
  padding: 5px 8px;
  border-radius: var(--radius-xs);
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  font-family: var(--mono);
  font-size: 11px;
}
.rf-tools { display: flex; gap: 4px; flex-wrap: wrap; }
.rf-list { flex: 1; overflow: auto; min-height: 80px; display: flex; flex-direction: column; gap: 1px; }
.rf-row {
  display: flex; align-items: center; gap: 7px;
  padding: 5px 7px; border-radius: var(--radius-xs);
  font-size: 12px; color: var(--text-2); text-align: left;
}
.rf-row:hover { background: var(--bg-hover); color: var(--text); }
.rf-row.active { background: var(--bg-active); color: var(--text); }
.rf-row i { width: 14px; text-align: center; color: var(--text-3); }
.rf-row .name { flex: 1; }
.rf-row .size { font-family: var(--mono); font-size: 10px; }
.rf-empty, .rf-err { padding: 12px 8px; font-size: 12px; color: var(--text-3); }
.rf-err { color: var(--danger); }
.rf-view { display: flex; flex-direction: column; gap: 4px; border-top: 1px solid var(--border-soft); padding-top: 6px; }
.rf-view-head { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.rf-view textarea {
  height: 190px; resize: vertical;
  padding: 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.5;
}
.rf-view-tip { font-size: 10px; line-height: 1.5; }
</style>
