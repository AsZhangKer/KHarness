<template>
  <aside class="sb">
    <header class="sb-head">
      <span class="t"><i class="fas fa-comment-dots"></i> 侧栏会话</span>
      <span v-if="st.busy" class="busy"><i class="fas fa-circle-notch fa-spin"></i> 思考中</span>
      <span v-else-if="st.messages.length" class="idle muted">仅只读</span>
      <span class="grow"></span>
      <button class="icon-btn" type="button" title="关闭侧栏提问，回到右侧面板" @click="store.setOpen(false)">
        <i class="fas fa-xmark"></i>
      </button>
    </header>

    <div class="sb-bar">
      <KDropdown
        class="hist"
        :items="threadItems"
        :model-value="st.activeId"
        :label="activeTitle"
        width="190px"
        @change="(v) => (v ? store.select(v) : store.newThread())"
      />
      <button class="icon-btn sm" type="button" title="新提问" @click="store.newThread()"><i class="fas fa-plus"></i></button>
      <KDropdown
        class="model"
        :items="modelItems"
        :model-value="st.modelRowId"
        :label="modelLabel"
        width="150px"
        @change="(v) => (st.modelRowId = Number(v) || 0)"
      />
    </div>

    <div class="sb-dir">
      <span class="ellip" :title="st.cwd || '缺省工作目录将同步项目主会话工作目录'">
        <i class="fas fa-folder-open"></i> {{ st.cwd || '（默认目录，仅询问一次即要确定）' }}
      </span>
      <button
        class="k-btn xs"
        :class="st.follow ? 'ghost' : 'solid'"
        type="button"
        :title="st.follow ? '正在跟随主会话的工作目录，点这里固定当前目录' : '已固定，点这里恢复跟随主会话'"
        @click="store.setFollow(!st.follow)"
      >{{ st.follow ? '跟随主会话' : '已锁定' }}</button>
    </div>

    <div ref="listEl" class="sb-body">
      <div v-if="st.loading" class="sb-empty muted">载入中…</div>
      <div v-else-if="!st.messages.length" class="sb-empty">
        <p>主 Agent 正在干活时，有什么想问的可以在这里问；侧栏会话仅<b>只读权限、无编辑权限</b>。</p>
        <p class="muted">仅可用工具 read_file / list_dir / grep / glob / web_fetch，且仅限工作目录内。</p>
        <p class="muted">回答不会进主会话的上下文；必要插入上下文时可以点「插入主对话」。</p>
      </div>

      <div v-for="m in st.messages" :key="m.id" class="msg" :class="m.role">
        <div v-if="m.role === 'user'" class="bubble user">{{ m.content }}</div>
        <template v-else>
          <div v-if="m.tools" class="trace">
            <button class="trace-head" type="button" @click="toggleSteps(m.id)">
              <i class="fas" :class="opened[m.id] ? 'fa-chevron-down' : 'fa-chevron-right'"></i>
              调用 {{ m.tools }} 次工具{{ m.streaming ? '（进行中）' : '' }}
            </button>
            <div v-if="opened[m.id]" class="trace-body">
              <div v-for="(s, i) in m.steps" :key="i" class="trace-row" :class="{ bad: s.ok === false }">
                <code>{{ s.name }}</code>
                <span class="muted ellip">{{ argsBrief(s) }}</span>
                <i v-if="s.pending" class="fas fa-circle-notch fa-spin"></i>
                <i v-else-if="s.ok" class="fas fa-check"></i>
                <i v-else class="fas fa-ban" title="被拒绝或出错"></i>
              </div>
            </div>
          </div>
          <div class="bubble md" v-html="renderMarkdown(m.content)"></div>
          <span v-if="m.streaming" class="caret"></span>
          <div v-if="m.stopped" class="muted small">（已停止）</div>
          <div v-if="!m.streaming && m.content" class="acts">
            <button class="k-btn xs ghost" type="button" title="作为临时指示投递给主对话，在下一个工具边界生效" @click="store.insertToMain(m)">
              <i class="fas fa-arrow-right-to-bracket"></i> 插入主对话
            </button>
            <button class="k-btn xs ghost" type="button" @click="copy(m.content)"><i class="fas fa-copy"></i> 复制</button>
          </div>
        </template>
      </div>
    </div>

    <div v-if="st.error" class="sb-err">
      <i class="fas fa-triangle-exclamation"></i> {{ st.error }}
      <button class="icon-btn sm" type="button" title="知道了" @click="st.error = ''"><i class="fas fa-xmark"></i></button>
    </div>

    <footer class="sb-foot">
      <textarea
        v-model="draft"
        class="k-input sb-input"
        rows="2"
        :placeholder="st.busy ? '侧栏正在回答…' : '问点什么，Enter 发送，Shift+Enter 换行'"
        @keydown.enter.exact.prevent="send"
      ></textarea>
      <button v-if="!st.busy" class="icon-btn send" type="button" title="发送" :disabled="!draft.trim()" @click="send">
        <i class="fas fa-arrow-up"></i>
      </button>
      <button v-else class="icon-btn send stop" type="button" title="停止本次回答" @click="store.stop()">
        <i class="fas fa-stop"></i>
      </button>
    </footer>
  </aside>
</template>

<script setup>
import { computed, nextTick, reactive, ref, watch } from 'vue';
import KDropdown from '../../ui/KDropdown.vue';
import { renderMarkdown } from '../../utils/format';
import { toast } from '../../stores/toast';
import { sidebarStore as store } from './sidebarStore';

const props = defineProps({
  /** [{ value, label }] —— 由 ChatPage 从模型列表里挑出来（可用且非异常的） */
  models: { type: Array, default: () => [] },
});

const st = store.state;
const draft = ref('');
const listEl = ref(null);
const opened = reactive({});

const threadItems = computed(() => [
  { value: 0, label: '新提问' },
  ...st.threads.map((t) => ({ value: t.id, label: t.title || `线程 ${t.id}` })),
]);
const activeTitle = computed(() => {
  const t = st.threads.find((x) => x.id === st.activeId);
  return t ? (t.title || `线程 ${t.id}`) : '新提问';
});
const modelItems = computed(() => [{ value: 0, label: '跟随主会话' }, ...props.models]);
const modelLabel = computed(() => {
  if (!st.modelRowId) return `模型：跟随（${props.models.find((m) => m.value === st.mainModelRowId)?.label || '未选'}）`;
  return props.models.find((m) => m.value === st.modelRowId)?.label || '选模型';
});

function argsBrief(s) {
  const a = s.args || {};
  const v = a.path ?? a.url ?? a.pattern ?? a.query ?? Object.values(a)[0] ?? '';
  return String(v).slice(0, 60);
}

function toggleSteps(id) { opened[id] = !opened[id]; }

function copy(text) {
  navigator.clipboard?.writeText(String(text || '')).then(
    () => toast('已复制', 'success'),
    () => toast('复制失败', 'error'),
  );
}

function send() {
  const q = draft.value.trim();
  if (!q) return;
  draft.value = '';
  store.ask(q);
}

// 有新内容就贴到底
watch(
  () => [st.messages.length, st.messages[st.messages.length - 1]?.content?.length || 0],
  async () => {
    await nextTick();
    const el = listEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  },
);
</script>

<style scoped>
.sb {
  width: 360px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg-elev);
  border-left: 1px solid var(--border-soft);
}
.sb-head { display: flex; align-items: center; gap: 8px; padding: 11px 12px; border-bottom: 1px solid var(--border-soft); font-size: 13px; font-weight: 600; }
.sb-head .t { display: inline-flex; align-items: center; gap: 6px; }
.sb-head .busy { font-size: 11px; color: var(--accent); font-weight: 400; }
.sb-head .idle { font-size: 11px; font-weight: 400; }
.sb-head .grow { flex: 1; }
.sb-bar { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--border-soft); }
.sb-bar .hist { flex: 1; min-width: 0; }
.sb-dir { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--border-soft); font-size: 11.5px; color: var(--text-2); }
.sb-dir .ellip { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sb-body { flex: 1; min-height: 0; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
.sb-empty { padding: 14px 6px; font-size: 12.5px; line-height: 1.7; color: var(--text-2); }
.sb-empty p + p { margin-top: 6px; }
.msg { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.msg.user { align-items: flex-end; }
.bubble { font-size: 13px; line-height: 1.65; word-break: break-word; }
.bubble.user {
  max-width: 92%;
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  background: var(--bg-hover);
  white-space: pre-wrap;
}
.caret { display: inline-block; width: 6px; height: 14px; background: var(--accent); vertical-align: -2px; animation: sb-blink 1s steps(2) infinite; }
@keyframes sb-blink { 0%, 50% { opacity: 1; } 51%, 100% { opacity: 0; } }
.trace { border: 1px solid var(--border-soft); border-radius: var(--radius-xs); background: var(--bg-panel); }
.trace-head { display: flex; align-items: center; gap: 6px; width: 100%; padding: 5px 8px; font-size: 11.5px; color: var(--text-2); }
.trace-head:hover { color: var(--text); }
.trace-body { border-top: 1px solid var(--border-soft); padding: 4px 8px 6px; display: flex; flex-direction: column; gap: 3px; }
.trace-row { display: flex; align-items: center; gap: 6px; font-size: 11.5px; }
.trace-row code { font-family: var(--mono); font-size: 11px; color: var(--text); }
.trace-row .ellip { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.trace-row.bad i { color: var(--danger); }
.acts { display: flex; gap: 6px; }
.small { font-size: 11.5px; }
.sb-err {
  display: flex; align-items: center; gap: 6px;
  margin: 0 10px 8px; padding: 6px 8px;
  border-radius: var(--radius-xs);
  background: var(--danger-soft); color: var(--danger); font-size: 12px;
}
.sb-err i:first-child { flex-shrink: 0; }
.sb-foot { display: flex; align-items: flex-end; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--border-soft); }
.sb-input { flex: 1; min-width: 0; resize: none; padding: 6px 8px; font-size: 12.5px; line-height: 1.5; }
.icon-btn.sm { width: 26px; height: 26px; font-size: 12px; }
.icon-btn.send { width: 30px; height: 30px; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--bg-panel); }
.icon-btn.send:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.icon-btn.send:disabled { opacity: .45; }
.icon-btn.stop { color: var(--danger); border-color: var(--danger); }
</style>
