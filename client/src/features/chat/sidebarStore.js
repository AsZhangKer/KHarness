// 侧栏提问（Sidebar AI）的界面状态。
//
// 它是主会话旁边的一条**只读旁路**：自己的线程、自己的流、自己的 busy，
// 不碰主会话的上下文，也不受主会话正在跑活的影响 —— 主 Agent 在敲命令时，
// 你可以在这里问「那个配置文件第几行是干什么的」，它只会读文件。
//
// 工作目录默认跟随主会话（/dir 切了它跟着切），可以点「锁定」钉在某个目录上；
// 模型默认跟随主会话当前模型，也可以在面板里单独选。
import { reactive } from 'vue';
import { aiApi } from '../../api';
import { toast } from '../../stores/toast';
import { openSidebarStream } from './chatStream';

const FOLLOW_KEY = 'kh.sidebar_follow';

const state = reactive({
  open: false,
  threads: [],
  activeId: 0,
  messages: [],
  busy: false,
  loading: false,
  error: '',
  cwd: '',
  follow: localStorage.getItem(FOLLOW_KEY) !== '0',   // 跟随主会话的工作目录
  modelRowId: 0,                                      // 0 = 跟随主会话当前模型
  mainCwd: '',
  mainModelRowId: 0,
  mainChatId: 0,
});

let stream = null;

/** ChatPage 把主会话的目录/模型/会话 id 推进来；侧栏只在「跟随」时采纳目录 */
function setContext({ cwd, modelRowId, chatId } = {}) {
  if (typeof modelRowId === 'number') state.mainModelRowId = modelRowId;
  if (typeof chatId === 'number') state.mainChatId = chatId;
  if (typeof cwd === 'string' && cwd) {
    state.mainCwd = cwd;
    if (state.follow) state.cwd = cwd;
  }
}

function setFollow(v) {
  state.follow = !!v;
  try { localStorage.setItem(FOLLOW_KEY, state.follow ? '1' : '0'); } catch (e) { /* 存不上就算了 */ }
  if (state.follow && state.mainCwd) state.cwd = state.mainCwd;
}

/** 有效模型：面板里选过的优先，否则跟随主会话 */
function effectiveModel() {
  return state.modelRowId || state.mainModelRowId || 0;
}

async function refresh() {
  try {
    state.threads = await aiApi.sidebarThreads() || [];
  } catch (e) { /* 列表拿不到不影响继续问 */ }
}

async function select(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return;
  if (state.busy) return toast('侧栏正在回答，先停止再切会话', 'warn');
  state.loading = true;
  try {
    const d = await aiApi.sidebarThread(n);
    state.activeId = n;
    state.messages = (d.messages || []).map((m) => ({ ...m, streaming: false }));
    if (d.thread?.cwd) state.cwd = d.thread.cwd;
    if (d.thread?.model_row_id) state.modelRowId = d.thread.model_row_id;
  } finally {
    state.loading = false;
  }
}

function newThread() {
  if (state.busy) return toast('侧栏正在回答，先停止再开新提问', 'warn');
  state.activeId = 0;
  state.messages = [];
  state.error = '';
}

async function remove(id) {
  await aiApi.deleteSidebarThread(id).catch(() => {});
  if (state.activeId === Number(id)) newThread();
  refresh();
}

async function rename(id, title) {
  const r = await aiApi.renameSidebarThread(id, title).catch(() => null);
  refresh();
  return r;
}

function setOpen(v) {
  const next = !!v;
  if (state.open === next) return;
  state.open = next;
  if (next) {
    if (!state.cwd) state.cwd = state.mainCwd;
    refresh();
  } else {
    stop();
  }
}

function toggle() { setOpen(!state.open); }

function stop() {
  if (!stream) return;
  stream.abort();
  stream = null;
  state.busy = false;
  const last = state.messages[state.messages.length - 1];
  if (last && last.role === 'assistant' && last.streaming) {
    last.streaming = false;
    last.stopped = true;
  }
}

/** 提一个问题。流式事件直接落到最后一条助手消息上。 */
function ask(text) {
  const q = String(text || '').trim();
  if (!q) return;
  if (state.busy) return toast('侧栏正在回答上一条', 'warn');
  state.error = '';
  state.messages.push({ id: Date.now(), role: 'user', content: q, steps: [] });
  state.messages.push({ id: Date.now() + 1, role: 'assistant', content: '', steps: [], streaming: true, tools: 0 });
  // 必须从 state 里取回「响应式代理」再改：直接改 push 进去的那个原始对象不会触发重渲染，
  // 实测就是这个回答要等到最后才整块蹦出来，看不到逐字流式
  const reply = state.messages[state.messages.length - 1];
  state.busy = true;

  const touchTool = (name, patchFields) => {
    const open = reply.steps.slice().reverse().find((s) => s.type === 'tool' && s.name === name && s.pending);
    if (open) Object.assign(open, patchFields, patchFields.pending !== undefined ? {} : { pending: false });
  };

  stream = openSidebarStream(
    { thread_id: state.activeId || 0, content: q, cwd: state.cwd || undefined, model_row_id: effectiveModel() || undefined },
    {
      onEvent: (evt) => {
        const t = evt && evt.t;
        if (t === 'chat') {
          if (evt.thread_id) state.activeId = evt.thread_id;
          if (evt.cwd) state.cwd = evt.cwd;
        } else if (t === 'delta') {
          reply.content += String(evt.text || '');
        } else if (t === 'tool') {
          reply.tools += 1;
          reply.steps.push({ type: 'tool', name: evt.name, args: evt.args, pending: true });
        } else if (t === 'tool_result') {
          touchTool(evt.name, { ok: !!evt.ok, preview: evt.preview });
        } else if (t === 'error') {
          state.error = String(evt.message || '出错了');
        } else if (t === 'done') {
          reply.streaming = false;
          reply.stopped = !!evt.stopped;
          state.busy = false;
          stream = null;
          refresh();
        }
      },
      onError: (e) => {
        state.error = String(e?.message || e);
        reply.streaming = false;
        state.busy = false;
        stream = null;
      },
      onAbort: () => {
        reply.streaming = false;
        reply.stopped = true;
        state.busy = false;
        stream = null;
        refresh();
      },
      onDone: () => {
        reply.streaming = false;
        state.busy = false;
        stream = null;
      },
    },
  );
}

/** 把某条回答作为临时指示插入主对话（在下一个工具边界生效，不打断当前动作） */
async function insertToMain(message) {
  if (!state.mainChatId) return toast('还没有主会话，先开一个对话再插入', 'warn');
  const text = String(message?.content || '').trim();
  if (!text) return toast('这条回答没有内容', 'warn');
  const r = await aiApi.addInsert(state.mainChatId, `【侧栏提问的结论】\n${text}`).catch(() => null);
  if (r) toast('已投递给主对话，将在工具结果回喂时注入', 'success');
}

export const sidebarStore = {
  state, setContext, setFollow, effectiveModel,
  refresh, select, newThread, remove, rename,
  setOpen, toggle, ask, stop, insertToMain,
};
