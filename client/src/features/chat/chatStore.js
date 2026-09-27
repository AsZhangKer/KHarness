// 会话工作台状态（从零实现，不复用旧 AiPlayground）
import { reactive, computed, watch } from 'vue';
import { aiApi } from '../../api';
import { openChatStream } from './chatStream';
import { superviseStore } from './superviseStore';
import { toast } from '../../stores/toast';
import { recycleBin } from '../../stores/recycle';
import { soundDone, soundError, soundApproval, soundQuestion } from '../../utils/sound';
import { logErr } from '../../utils/errlog';

const recycle = recycleBin();

const state = reactive({
  loading: false,
  projects: [],
  chats: [],
  models: [],
  modelIdx: 0,
  pool: [],
  chatId: null,
  messages: [],
  tasks: [],
  draft: '',
  cwd: '',
  agentMode: localStorage.getItem('nu_agent') !== '0', // 默认开 Agent，工具才可调用
  planMode: localStorage.getItem('nu_plan') === '1',
  readonlyMode: localStorage.getItem('nu_readonly') === '1',
  autoMode: localStorage.getItem('nu_auto') === '1',
  approvalMode: localStorage.getItem('nu_approval') || 'default',
  thinkingLevel: localStorage.getItem('nu_think') || 'medium',
  temperature: 0.7,
  frequency_penalty: 0,
  presence_penalty: 0,
  contextLimit: 0,
  censoredWords: '',
  insertItems: [],
  loadedSkills: [],
  /** 审批队列：服务端可同时挂起多条（不同工具/不同会话） */
  approvals: [],
  question: null,
  usage: {},
  contextUsed: 0,
  latencyMs: 0,
  tokPerSec: 0,
  /** 本轮已产出的输出 token 估算（正文+思考），实时速度就按它的增量算 */
  streamTokens: 0,
  /** 首个正文字节的延迟（ms），用于运行状态条 */
  firstTokenMs: 0,
  /** 最后一次收到任何 SSE 事件的时刻，用于「无输出 > 2min」 */
  lastEventAt: 0,
  /** 当前正在前台运行的命令（run_command），用于「判定超时」按钮 */
  runningCmd: null,
  skillsPicker: false,
  poolPicker: false,
  modelPicker: false,
  queue: [],
  busyChats: {},
  /** 子智能体实时状态：id -> { name, phase, model, iter, tool, result_preview, error } */
  subagents: {},
  /** chatId -> 本地消息数组（含 live），切会话/页面时保留 */
  msgBuf: {},
  // busy 按「本会话是否有流在跑」派生：切到空闲会话仍能输入发送
  get busy() {
    // 监工在当前会话上下发命令时也算「忙」：此时用户输入会进队列，等这一场结束再发，
    // 避免两条流同时往一个会话里写消息
    if (superviseStore.state.sup.running && superviseStore.state.sup.chatId === this.chatId) return true;
    return !!this.busyChats[this.chatId || 'tmp'];
  },
  // 兼容旧引用：审批横幅取队首
  get pendingApproval() {
    return this.approvals[0] || null;
  },
});

// 模式持久化
watch(
  () => [state.agentMode, state.planMode, state.readonlyMode, state.autoMode, state.approvalMode, state.thinkingLevel],
  ([agent, plan, ro, auto, approval, think]) => {
    try {
      localStorage.setItem('nu_agent', agent ? '1' : '0');
      localStorage.setItem('nu_plan', plan ? '1' : '0');
      localStorage.setItem('nu_readonly', ro ? '1' : '0');
      localStorage.setItem('nu_auto', auto ? '1' : '0');
      localStorage.setItem('nu_approval', approval || 'default');
      localStorage.setItem('nu_think', think || 'medium');
    } catch { /* ignore */ }
  }
);

// 按会话保存进行中的流：切换页面/会话不 abort
const streams = new Map();

/* ── 输出速度：实时值 ──────────────────────────────────────────────────────
   运行中每 2 秒按「这两秒内新增的输出估算」算一次瞬时速度；done 帧带着真实 usage 到达时
   改成整轮平均并锁住（speedFinalized），此后 tick 不再覆盖 —— 停止后看到的就是这次任务的平均速度。
   与服务的口径无关：这里只关心「刚刚这两秒」。 */
let speedTimer = null;
let speedLastTok = 0;
let speedFinalized = false;
let speedT0 = 0;

/** 与服务端 agentsmd.estimateTokens 同一把尺：CJK 0.6 tok/字，其余 0.25 tok/字符 */
function estTok(s) {
  const str = String(s || '');
  const cjk = (str.match(/[一-鿿぀-ヿ]/g) || []).length;
  return cjk * 0.6 + (str.length - cjk) * 0.25;
}
function startSpeedTicker() {
  speedLastTok = state.streamTokens;
  speedFinalized = false;
  speedT0 = Date.now();
  if (speedTimer) return;
  speedTimer = setInterval(() => {
    if (speedFinalized) return;
    const now = state.streamTokens;
    state.tokPerSec = Math.max(0, now - speedLastTok) / 2;
    speedLastTok = now;
  }, 2000);
}
function stopSpeedTicker() {
  if (speedTimer) { clearInterval(speedTimer); speedTimer = null; }
}
watch(() => state.busy, (b) => {
  if (b) { startSpeedTicker(); return; }
  stopSpeedTicker();
  // 手动停止/中断没有 done 帧可用：拿「这一轮总产出 ÷ 总时长」收尾，别把最后一刻的瞬时值当成结果挂着
  if (!speedFinalized) {
    const secs = (Date.now() - speedT0) / 1000;
    if (secs > 0.5 && state.streamTokens > 0) state.tokPerSec = state.streamTokens / secs;
  }
});

function safeJson(v) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** 实验室开关：存在 localStorage，随每次请求带上，只影响本次回合 */
function readLabs() {
  try {
    const o = JSON.parse(localStorage.getItem('nu_labs') || '{}');
    return { uncommittedTip: !!o.uncommittedTip, gitPreview: !!o.gitPreview, crossChat: !!o.crossChat };
  } catch {
    return {};
  }
}

/** 页面不在前台时才提醒：Web 通知优先，失败回落到系统通知接口 */
function notifyHidden(title, body) {
  try {
    if (document.visibilityState === 'visible') return;
  } catch { /* ignore */ }
  try {
    if ('Notification' in window) {
      if (Notification.permission === 'granted') {
        const n = new Notification(title, { body, tag: 'kharness' });
        n.onclick = () => { window.focus(); n.close(); };
        return;
      }
      if (Notification.permission !== 'denied') { try { Notification.requestPermission(); } catch { /* ignore */ } }
    }
  } catch { /* ignore */ }
  try { aiApi.systemNotify({ title, body }).catch(() => {}); } catch { /* ignore */ }
}

/** 固定（置顶）模型：只存本地，key 沿用旧版 nu_pin_models，读写都在这对函数里收口 */
const PIN_MODELS_KEY = 'nu_pin_models';

function readPinModels() {
  try {
    const raw = JSON.parse(localStorage.getItem(PIN_MODELS_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw.map(Number).filter(Boolean) : []);
  } catch {
    return new Set();
  }
}

function writePinModels(set) {
  try {
    localStorage.setItem(PIN_MODELS_KEY, JSON.stringify([...set]));
  } catch { /* ignore */ }
}

export function useChatStore() {
  const activeChat = computed(() => state.chats.find((c) => c.id === state.chatId) || null);
  const activeProject = computed(
    () => state.projects.find((p) => p.id === activeChat.value?.project_id) || null
  );
  const freeChats = computed(() => state.chats.filter((c) => !c.project_id));
  const currentModel = computed(() => state.models[state.modelIdx] || null);
  const modelName = computed(
    () => currentModel.value?.display_name || currentModel.value?.model_id || ''
  );
  const chatTitle = computed(() => activeChat.value?.title || '未命名会话');
  // 审批横幅只针对当前会话；其它会话挂起的审批切回去才显示（服务端 180s 超时自动拒绝）
  const currentApprovals = computed(() =>
    state.approvals.filter((a) => !a.chat_id || a.chat_id === state.chatId)
  );

  async function refreshTree() {
    const [ps, cs] = await Promise.all([aiApi.getProjects(), aiApi.getChats()]);
    let pinnedSet = new Set();
    try {
      pinnedSet = new Set(JSON.parse(localStorage.getItem('nu_pinned_chats') || '[]'));
    } catch { /* ignore */ }
    state.projects = (ps || []).map((p) => ({ ...p, open: true }));
    state.chats = (cs || []).map((c) => ({
      ...c,
      pinned: !!(c.pinned || pinnedSet.has(c.id)),
    }));
    for (const p of state.projects) {
      p.chats = state.chats.filter((c) => c.project_id === p.id);
    }
  }

  async function refreshModels() {
    const res = await aiApi.getModels();
    const list = Array.isArray(res) ? res : res?.list || [];
    const pins = readPinModels();
    state.models = list
      .filter((m) => !m.disabled)
      .map((m) => ({ ...m, pinned: pins.has(m.id) ? 1 : 0 }));
    // 固定的排在最前（下拉与弹窗共用这一顺序），其余保持服务端 id 顺序
    state.models.sort((a, b) => (b.pinned - a.pinned) || (a.id - b.id));
    // 恢复上次选中的模型（本地持久化）
    try {
      const saved = Number(localStorage.getItem('nu_model_id') || 0);
      const idx = state.models.findIndex((m) => m.id === saved);
      if (idx >= 0) state.modelIdx = idx;
      else if (state.modelIdx >= state.models.length) state.modelIdx = 0;
    } catch {
      if (state.modelIdx >= state.models.length) state.modelIdx = 0;
    }
  }

  function persistModel() {
    const m = state.models[state.modelIdx];
    if (m) {
      try { localStorage.setItem('nu_model_id', String(m.id)); } catch { /* ignore */ }
      if (state.chatId) {
        try { aiApi.updateChatSettings(state.chatId, { model_row_id: m.id }); } catch { /* ignore */ }
      }
    }
  }

  /**
   * 固定 / 取消固定模型。列表里被禁用的模型不在 state.models 中，
   * 所以持久化以 localStorage 现值为基准增删，避免一次保存把隐藏的固定项抹掉。
   */
  function toggleModelPin(id, on) {
    const row = state.models.find((m) => m.id === id);
    if (row) row.pinned = on ? 1 : 0;
    const set = readPinModels();
    if (on) set.add(id);
    else set.delete(id);
    writePinModels(set);
    state.models.sort((a, b) => (b.pinned - a.pinned) || (a.id - b.id));
    const cur = currentModel.value;
    if (cur) {
      const idx = state.models.findIndex((m) => m.id === cur.id);
      if (idx >= 0) state.modelIdx = idx;
    }
  }

  async function openChat(id) {
    if (state.chatId && state.chatId !== id) {
      state.msgBuf[state.chatId] = state.messages;
    }
    state.chatId = id;
    // 切会话：命令运行态与首字延迟属于「本场流」，不带过去（心跳 15s 内会重新点亮）
    state.runningCmd = null;
    state.firstTokenMs = 0;

    const inflight = streams.get(id);
    const cached = state.msgBuf[id];
    if (inflight?.live && cached) {
      // 生成中：用本地缓冲，live 同一引用继续被流写入
      state.messages = cached;
      if (!state.messages.includes(inflight.live)) state.messages.push(inflight.live);
    } else {
      const res = await aiApi.getChat(id);
      const chat = res?.chat || {};
      state.messages = (res?.messages || []).map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content || '',
        reasoning: m.reasoning || '',
        steps: (Array.isArray(m.steps) ? m.steps : []).map((s) => ({
          ...s,
          output: s && s.output != null && typeof s.output !== 'string' ? safeJson(s.output) : s.output,
          diff: Array.isArray(s?.diff) ? s.diff : (s?.diff || null),
        })),
        timeline: null,
        usage: m.usage || null,
        model_name: m.model_name || '',
        // 托管模式：监工与工作者的话在同一条会话里，靠这个字段分气泡
        speaker: m.speaker || '',
      }));
      state.tasks = res?.tasks || [];
      state.planMode = !!chat.plan_mode;
      state.approvalMode = chat.approval_mode || state.approvalMode || 'default';
      state.thinkingLevel = chat.thinking_level || state.thinkingLevel || 'medium';
      state.temperature = chat.temperature ?? 0.7;
      state.frequency_penalty = chat.frequency_penalty ?? 0;
      state.presence_penalty = chat.presence_penalty ?? 0;
      state.censoredWords = chat.censored_words || '';
      state.cwd = chat.cwd || '';
      if (res?.usage) {
        state.usage = res.usage;
        state.contextLimit = res.usage.limit || 0;
        state.contextUsed = res.usage.used || 0;
      }
      // 流式中的 live 回复挂回列表
      if (inflight?.live && !state.messages.includes(inflight.live)) {
        state.messages.push(inflight.live);
      }
      state.msgBuf[id] = state.messages;
    }
    await refreshSidecar(id);
  }

  async function refreshSidecar(chatId) {
    if (!chatId) return;
    try {
      const [ins, sk] = await Promise.all([
        aiApi.getInsert(chatId),
        aiApi.getChatSkills(chatId),
      ]);
      state.insertItems = ins?.items || [];
      state.loadedSkills = sk?.loaded || [];
    } catch { /* optional */ }
  }

  async function newProject(name, root_path, remote_id) {
    // remote_id 非空 = 远端项目：root_path 是远端绝对路径，校验由后端走 SFTP 做
    await aiApi.createProject({ name, root_path, ...(remote_id ? { remote_id } : {}) });
    await refreshTree();
  }

  async function newChat(projectId, remoteId) {
    const model = currentModel.value;
    if (!model) {
      toast('请先在模型管理中添加模型', 'warn');
      return null;
    }
    // 指名要远端会话时不能回退到「当前活动项目」（那多半是本机项目）
    const pid = projectId || (remoteId ? null : activeProject.value?.id) || undefined;
    const res = await aiApi.createChat({
      model_row_id: model.id,
      project_id: pid,
      // 不挂项目也能开远端会话：直接告诉后端这条对话属于哪台机器
      remote_id: pid ? undefined : (remoteId || undefined),
      plan_mode: state.planMode,
      title: '未命名会话',
    });
    await refreshTree();
    return res;
  }

  async function removeChat(id) {
    await aiApi.deleteChat(id);
    if (state.chatId === id) {
      state.chatId = null;
      state.messages = [];
    }
    await refreshTree();
  }

  async function renameChat(id, title) {
    await aiApi.updateChatSettings(id, { title });
    await refreshTree();
  }

  async function pinChat(id, pinned) {
    try {
      await aiApi.updateChatSettings(id, { pinned: pinned ? 1 : 0 });
    } catch { /* 后端无字段时用本地固定 */ }
    const c = state.chats.find((x) => x.id === id);
    if (c) c.pinned = pinned ? 1 : 0;
    try {
      const key = 'nu_pinned_chats';
      const set = new Set(JSON.parse(localStorage.getItem(key) || '[]'));
      if (pinned) set.add(id);
      else set.delete(id);
      localStorage.setItem(key, JSON.stringify([...set]));
    } catch { /* ignore */ }
    await refreshTree();
  }

  async function openInExplorer(path) {
    if (!path) return false;
    try {
      await aiApi.revealPath(path);
      toast('已在资源管理器中打开', 'info');
      return true;
    } catch {
      toast('打开失败', 'error');
      return false;
    }
  }

  function pushMessage(msg) {
    state.messages.push({
      id: msg.id ?? null,
      role: msg.role,
      content: msg.content || '',
      reasoning: msg.reasoning || '',
      steps: msg.steps || [],
      timeline: msg.timeline || null,
      usage: msg.usage || null,
      model_name: msg.model_name || '',
      speaker: msg.speaker || '',
    });
  }

  function lastAssistant() {
    for (let i = state.messages.length - 1; i >= 0; i--) {
      if (state.messages[i].role === 'assistant') return state.messages[i];
    }
    return null;
  }

  function tlPush(reply, item) {
    if (!reply.timeline) reply.timeline = [];
    reply.timeline.push(item);
  }
  function tlAppendText(reply, text) {
    if (!text) return;
    if (!reply.timeline) reply.timeline = [];
    const last = reply.timeline[reply.timeline.length - 1];
    if (last && last.kind === 'text') {
      last.text += text;
    } else {
      reply.timeline.push({ kind: 'text', text });
    }
    reply.content += text;
  }

  function handleEvent(evt, reply) {
    const t = evt.t;
    state.lastEventAt = Date.now();
    if (t === 'chat') {
      const prevId = state.chatId;
      const nextId = evt.chat_id || state.chatId;
      if (nextId && nextId !== prevId) {
        // 新会话首次拿到 id：把 'tmp' 上的流登记与消息缓冲迁到真实 id
        const inflight = streams.get(prevId || 'tmp');
        if (inflight) {
          streams.delete(prevId || 'tmp');
          streams.set(nextId, inflight);
        }
        if (state.busyChats[prevId || 'tmp']) {
          const nb = { ...state.busyChats };
          delete nb[prevId || 'tmp'];
          nb[nextId] = true;
          state.busyChats = nb;
        }
        if (state.msgBuf[prevId || 'tmp']) {
          state.msgBuf[nextId] = state.msgBuf[prevId || 'tmp'];
          delete state.msgBuf[prevId || 'tmp'];
        }
        // 关键：登记这次迁移，让发起方收尾时按新 key 清理。
        // 否则 send() 仍拿住旧的 'tmp' 去 delete，真实 id 的 busy 永久残留，
        // 之后每一次发送都会被当成「本会话正在生成」塞进队列——表现为撤回重发卡死。
        reply._busyKey = nextId;
      }
      state.chatId = nextId;
      const c = state.chats.find((x) => x.id === evt.chat_id);
      if (c && evt.title) c.title = evt.title;
      if (evt.user_message_id) {
        for (let i = state.messages.length - 1; i >= 0; i--) {
          if (state.messages[i].role === 'user') {
            state.messages[i].id = evt.user_message_id;
            break;
          }
        }
      }
      refreshTree();
    } else if (t === 'model') {
      reply.model_name = evt.name;
    } else if (t === 'delta') {
      if (evt.text && !state.firstTokenMs) state.firstTokenMs = Date.now() - (reply._startedAt || Date.now());
      state.streamTokens += estTok(evt.text);
      tlAppendText(reply, evt.text || '');
    } else if (t === 'reason') {
      const rt = evt.text || '';
      state.streamTokens += estTok(rt);
      reply.reasoning += rt;
      if (!reply.timeline) reply.timeline = [];
      const last = reply.timeline[reply.timeline.length - 1];
      if (last && last.kind === 'reason') last.text += rt;
      else reply.timeline.push({ kind: 'reason', text: rt });
    } else if (t === 'compress') {
      // 「先压缩上下文、再回答」要在消息流里看得见：一条 compress 步骤卡，
      // start → done/skipped/failed 就地更新同一张卡（timeline 那边存的是 ref，改 ref 即改显示）
      let st = null;
      for (let i = reply.steps.length - 1; i >= 0; i--) {
        if (reply.steps[i].type === 'compress' && reply.steps[i].phase === 'start') { st = reply.steps[i]; break; }
      }
      const isNew = !st;
      if (isNew) {
        st = { type: 'compress', name: '压缩上下文', phase: evt.phase, used: evt.used, limit: evt.limit, percent: evt.percent, from: evt.from, basis: evt.basis };
        reply.steps.push(st);
      }
      if (evt.phase !== 'start') {
        st.phase = evt.phase;
        st.after = evt.after ?? st.after;
        st.after_basis = evt.after_basis ?? st.after_basis;
        st.chars = evt.chars ?? st.chars;
        st.archived = evt.archived ?? st.archived;
        st.summary = evt.summary ?? st.summary;
        st.message = evt.message ?? st.message;
      }
      if (isNew) tlPush(reply, { kind: 'step', ref: st, ...st });
      if (evt.used) state.contextUsed = evt.used;
    } else if (t === 'tool') {
      const st = { type: 'tool', name: evt.name, args: evt.args };
      reply.steps.push(st);
      tlPush(reply, { kind: 'step', ref: st, ...st });
    } else if (t === 'tool_result') {
      let out = evt.output;
      if (out != null && typeof out !== 'string') {
        try { out = JSON.stringify(out, null, 2); } catch { out = String(out); }
      }
      const st = {
        type: 'result',
        name: evt.name,
        output: out,
        error: typeof evt.error === 'string' ? evt.error : (evt.error != null ? String(evt.error) : null),
        path: evt.path || null,
        undo_id: evt.undo_id || null,
        undone: false,
        diff: Array.isArray(evt.diff) ? evt.diff : (evt.diff || null),
        new_file: !!evt.new_file,
      };
      reply.steps.push(st);
      tlPush(reply, { kind: 'step', ref: st, ...st });
      if (st.undo_id && (st.name === 'delete_file' || st.name === 'delete_dir' || st.name === 'rename_file')) {
        recycle.add({
          id: `undo-${st.undo_id}`,
          undo_id: st.undo_id,
          kind: '文件',
          name: st.path || (st.args && st.args.path) || st.name,
          path: st.path || (st.args && st.args.path) || '',
          chat_id: state.chatId,
        });
      }
    } else if (t === 'note' || t === 'insert_injected') {
      if (t === 'insert_injected') {
        // 一条只注入一次：注入即清空服务端缓冲，界面状态条同步消失
        state.insertItems = [];
      }
      const st = {
        type: 'note',
        message:
          t === 'insert_injected'
            ? `已在工具结果回喂时注入 ${evt.count} 条临时提示词`
            : String(evt.message ?? ''),
      };
      reply.steps.push(st);
      tlPush(reply, { kind: 'step', ref: st, ...st });
    } else if (t === 'approval') {
      soundApproval();
      // 服务端可同时挂起多条审批：入队，队首渲染，target 用于「始终允许」建规则
      state.approvals = state.approvals.concat([{
        id: evt.id,
        tool: evt.tool,
        args: evt.args,
        reason: evt.reason,
        level: evt.level,
        target: evt.target || null,
        is_high: !!evt.is_high,
        mode: evt.mode || state.approvalMode,
        chat_id: evt.chat_id || state.chatId,
      }]);
      notifyHidden('KHarness 需要审批', `${evt.tool}：${evt.reason || '敏感操作'}`);
    } else if (t === 'question') {
      soundQuestion();
      state.question = {
        id: evt.id,
        question: evt.question,
        options: evt.options || [],
        timeout_ms: evt.timeout_ms || 600000,
        chat_id: evt.chat_id || state.chatId,
      };
      notifyHidden('AI 在等你回答', String(evt.question || '').slice(0, 120));
    } else if (t === 'cmd_running') {
      // run_command 开始/结束：驱动「判定超时」按钮与已跑时长
      state.runningCmd = evt.command
        ? { command: String(evt.command), startedAt: Date.now(), elapsedMs: 0 }
        : null;
    } else if (t === 'heartbeat') {
      // 15s 一次；命令运行时带 pid/command/elapsed_ms
      if (evt.command || evt.pid) {
        if (!state.runningCmd) {
          state.runningCmd = { command: String(evt.command || ''), startedAt: Date.now() - (evt.elapsed_ms || 0), elapsedMs: evt.elapsed_ms || 0 };
        } else {
          state.runningCmd.elapsedMs = evt.elapsed_ms || Date.now() - state.runningCmd.startedAt;
          state.runningCmd.pid = evt.pid || null;
        }
      }
    } else if (t === 'tasks') {
      state.tasks = evt.tasks || [];
    } else if (t === 'subagent') {
      // 子智能体进度：右栏面板据此实时更新；开始/结束各在正文里落一条 note
      const cur = state.subagents[evt.id] || { id: evt.id };
      cur.name = evt.name || cur.name || evt.id;
      cur.phase = evt.phase;
      if (evt.model) cur.model = evt.model;
      if (evt.tool) cur.tool = evt.tool;
      if (evt.phase === 'start') {
        cur.iter = 0;
        cur.task = evt.task || '';
        const st = { type: 'note', message: `派出子智能体「${cur.name}」（只读）：${evt.task || ''}` };
        reply.steps = reply.steps || [];
        reply.steps.push(st);
        tlPush(reply, { kind: 'step', ref: st, ...st });
      } else if (evt.phase === 'tool') {
        cur.iter = (cur.iter || 0) + 1;
      } else if (evt.phase === 'done' || evt.phase === 'failed' || evt.phase === 'killed') {
        cur.status = evt.phase;
        cur.result = evt.result || '';
        cur.error = evt.error || '';
        const st = {
          type: 'note',
          message: evt.phase === 'done'
            ? `子智能体「${cur.name}」已交回结论（${String(evt.result || '').length} 字）`
            : `子智能体「${cur.name}」${evt.phase === 'killed' ? '被停止' : '失败'}：${evt.error || ''}`,
        };
        reply.steps = reply.steps || [];
        reply.steps.push(st);
        tlPush(reply, { kind: 'step', ref: st, ...st });
      }
      state.subagents[evt.id] = cur;
    } else if (t === 'done') {
      soundDone();
      reply.latency_ms = evt.latency_ms || 0;
      if (evt.latency_ms) state.latencyMs = evt.latency_ms;
      // 回合收尾：速度从「这两秒」切成「整轮平均」并锁住，之后 tick 不再动它
      speedFinalized = true;
      if (evt.gen_ms > 0 && evt.usage?.completion_tokens > 0) {
        state.tokPerSec = evt.usage.completion_tokens / (evt.gen_ms / 1000);
      } else if (evt.usage?.completion_tokens && evt.latency_ms) {
        state.tokPerSec = evt.usage.completion_tokens / (evt.latency_ms / 1000);
      }
      if (evt.usage) {
        reply.usage = evt.usage;
        state.usage = evt.usage;
        if (evt.usage.prompt_tokens > 0) state.contextUsed = evt.usage.prompt_tokens;
      }
      if (evt.tasks) state.tasks = evt.tasks;
      if (evt.context_limit != null) state.contextLimit = evt.context_limit;
      state.runningCmd = null;
    } else if (t === 'error') {
      soundError();
      // 只记 errorText，由页面底部红条呈现（可撤回重发），不污染正文
      reply.errorText = String(evt.message || '未知错误');
      logErr({
        kind: 'sse',
        where: `本轮出错${evt.model ? ' · ' + evt.model : ''}`,
        summary: reply.errorText,
        detail: String(evt.detail || evt.note || JSON.stringify(evt.context || evt.raw || '')).slice(0, 1200),
      });
      notifyHidden('KHarness 本轮出错', reply.errorText.slice(0, 120));
    }
  }

  /**
   * 监工 ⇄ 主智能体的「交棒」桥：监工那一轮结束后，命令由这里以普通用户消息发出去，
   * 走的就是平时那条 /chat —— 所以主会话的停止按钮、审批、撤销、队列全都照常可用。
   * 跑完再回调 onMainDone()，让监工接着判断下一棒。
   */
  superviseStore.setMainBridge({
    send: (command) => send(command, { fromSupervisor: true }),
    stop: () => stop(),
  });

  async function send(content, opts = {}) {
    const continueMode = !!opts.continue;
    let text = continueMode ? '' : String(content ?? state.draft ?? '').trim();
    if (!continueMode && !text) return;

    // 命令拦截与「\ 转义」都放在入队判断之前：命令不进队列，行首 \ 让 / 开头的文本当消息发出
    if (!continueMode && (text.startsWith('/') || text.startsWith('\\'))) {
      if (text.startsWith('\\')) {
        text = text.slice(1);
      } else {
        const handled = await runCommand(text);
        state.draft = '';
        if (handled) return;
      }
    }

    const busyId = state.chatId || 'tmp';
    // 本会话生成中：进消息队列，答完自动发送
    if (!continueMode && state.busyChats[busyId]) {
      state.queue.push(text);
      state.draft = '';
      toast(`已加入队列（${state.queue.length}）`, 'info', 2000);
      return;
    }
    if (continueMode && state.busyChats[busyId]) return;
    if (!continueMode) state.draft = '';

    if (!continueMode) pushMessage({ role: 'user', content: text, speaker: opts.fromSupervisor ? 'supervisor' : '' });
    const reply = { role: 'assistant', content: '', reasoning: '', steps: [], usage: null, model_name: '', unfinished: false };
    pushMessage(reply);
    const live = state.messages[state.messages.length - 1];
    live._startedAt = Date.now();
    state.firstTokenMs = 0;
    state.streamTokens = 0;
    state.runningCmd = null;
    state.lastEventAt = Date.now();
    if (busyId) state.busyChats = { ...state.busyChats, [busyId]: true };

    const pool = state.autoMode
      ? state.pool.slice()
      : [currentModel.value?.id].filter(Boolean);

    const runId = state.chatId || 'tmp';
    const st = openChatStream(
      {
        model_row_id: pool[0],
        pool,
        chat_id: state.chatId,
        project_id: state.chatId ? undefined : activeProject.value?.id || undefined,
        plan_mode: state.planMode,
        content: text,
        agent: state.agentMode,
        cwd: state.cwd || undefined,
        readonly: state.readonlyMode,
        approval_mode: state.approvalMode,
        thinking_level: state.thinkingLevel || undefined,
        labs: readLabs(),
        continue: continueMode,
        speaker: opts.fromSupervisor ? 'supervisor' : undefined,
      },
      {
        onEvent: (evt) => handleEvent(evt, live),
        onError: (e) => {
          live.errorText = String(e.message || '请求失败');
          live.unfinished = true;
          // 进台账：这条往往是「初始报错」，后面任何一条红条点击复制时都该带得上它
          logErr({ kind: 'sse', where: '流式中断', summary: live.errorText, detail: String(e.stack || e.message || '') });
        },
        onAbort: () => {
          live.unfinished = true;
        },
      }
    );
    streams.set(runId, { abort: st.abort, live });
    await st.done;
    // 收尾按「迁移后的 key」清理：新会话首轮流里 chat 事件会把登记从 'tmp' 迁到真实 id，
    // 只删 runId 会让真实 id 的 busy 与流永久残留，导致后续发送全被塞进队列（撤回重发卡死）
    const finalKey = live._busyKey || runId;
    if (streams.get(finalKey)?.live === live || streams.get(finalKey)?.abort === st.abort) streams.delete(finalKey);
    if (finalKey !== runId && streams.get(runId)?.live === live) streams.delete(runId);
    state.runningCmd = null;
    // 本轮什么都没产出（例如服务端拒绝继续、连接立刻失败）→ 撤掉空气泡，把错误挂到上一条回复
    const liveIdx = state.messages.indexOf(live);
    if (liveIdx >= 0 && !live.content.trim() && !(live.reasoning || '').trim() && !(live.steps || []).length) {
      const errText = live.errorText;
      state.messages.splice(liveIdx, 1);
      if (errText) {
        const prev = lastAssistant();
        if (prev) prev.errorText = errText;
        else toast(errText, 'error');
      }
    }
    if (busyId || finalKey) {
      const next = { ...state.busyChats };
      delete next[busyId];
      if (finalKey) delete next[finalKey];
      state.busyChats = next;
    }
    await refreshTree();
    if (state.queue.length) {
      const next = state.queue.shift();
      await send(next);
    }
    // 监工交棒过来的这一轮跑完了：等队列里的用户消息也发完，再回叫监工接下一棒
    if (opts.fromSupervisor) superviseStore.onMainDone();
  }

  function stop() {
    // 仅停当前会话的流
    const key = state.chatId || 'tmp';
    const cur = streams.get(key) || streams.get('tmp');
    cur?.abort();
    state.runningCmd = null;
  }

  async function runCommand(text) {
    const [name, ...rest] = text.slice(1).split(/\s+/);
    const args = rest.join(' ').trim();
    switch (name) {
      case 'dir':
        if (!args) return toast('用法：/dir <路径>', 'warn'), true;
        await setCwd(args);
        return true;
      case 'model': {
        if (!args) {
          state.modelPicker = true;
          return true;
        }
        const m = state.models.find((x) => String(x.id) === args || x.model_id === args || x.display_name === args);
        if (!m) return toast('未找到模型', 'warn'), true;
        state.modelIdx = state.models.indexOf(m);
        persistModel();   // 不落盘的话刷新后又跳回旧模型
        toast(`已切换模型：${m.display_name || m.model_id}`, 'success');
        return true;
      }
      case 'mode': {
        const parts = args.toLowerCase().split(/\s+/).filter(Boolean);
        const flag = parts[0] || '';
        const want = parts[1] || 'on';
        const switches = {
          plan: ['planMode', 'Plan 规划'],
          auto: ['autoMode', '模型池先点'],
          agent: ['agentMode', 'Agent 工具'],
          readonly: ['readonlyMode', '只读'],
          'read-only': ['readonlyMode', '只读'],
        };
        if (!flag) {
          const on = (v) => (v ? '开' : '关');
          return toast(
            `Agent ${on(state.agentMode)} · Plan ${on(state.planMode)} · 只读 ${on(state.readonlyMode)} · 先点 ${on(state.autoMode)} · 审批 ${state.approvalMode}`,
            'info', 6000
          ), true;
        }
        if (switches[flag]) {
          const [key, label] = switches[flag];
          if (want === 'on') state[key] = true;
          else if (want === 'off') state[key] = false;
          else state[key] = !state[key];
          toast(`${label}：${state[key] ? '开' : '关'}`, 'success');
          return true;
        }
        if (['strict', 'default', 'exempt'].includes(flag)) {
          state.approvalMode = flag;
          toast(`审批模式：${{ strict: '严格', default: '默认', exempt: '免除' }[flag]}`, 'success');
          return true;
        }
        return toast('用法：/mode [plan|auto|agent|readonly] [on|off|toggle]，或 /mode strict|default|exempt', 'warn'), true;
      }
      case 'pool':
        state.poolPicker = true;
        return true;
      case 'insert':
        if (args === '--clear') {
          await clearInserts();
          return true;
        }
        if (!args) return toast('用法：/insert <内容> 或 /insert --clear', 'warn'), true;
        await addInsert(args);
        return true;
      case 'skills-load':
        state.skillsPicker = true;
        return true;
      case 'supervise': {
        // 监工：翻到右栏那一页并按 kh.checks.md 跑一轮（只读，不改代码）
        superviseStore.focus();
        superviseStore.run({ chatId: state.chatId, modelRowId: currentModel.value?.id });
        return true;
      }
      case 'press':
        await pressChat();
        return true;
      case 'context': {
        const n = parseInt(args, 10);
        if (!Number.isInteger(n)) return toast('用法：/context <token数>', 'warn'), true;
        await setContext(n);
        return true;
      }
      case 'exit':
        state.agentMode = false;
        toast('已退出 Agent 模式', 'info');
        return true;
      case 'help':
      case '?':
        toast('命令：model / pool / mode / dir / insert / skills-load / press / context / exit / help', 'info', 6000);
        return true;
      default:
        toast(`未知命令：/${name}（输入 /help 查看）`, 'warn');
        return true;
    }
  }

  async function setThinkingLevel(level) {
    // 空值归一成 'auto'（跟随模型默认）：下拉里每一项都该是真档位，
    // 空串在界面上没有对应条目，会把当前档位显示成「medium」而实际什么都没发。
    state.thinkingLevel = level || 'auto';
    if (state.chatId) {
      try {
        await aiApi.updateChatSettings(state.chatId, { thinking_level: state.thinkingLevel });
      } catch { /* 会话未创建时忽略 */ }
    }
  }

  async function saveModelParams(patch) {
    Object.assign(state, patch);
    if (!state.chatId) return;
    try {
      await aiApi.updateChatSettings(state.chatId, {
        thinking_level: state.thinkingLevel || 'auto',
        temperature: state.temperature,
        frequency_penalty: state.frequency_penalty,
        presence_penalty: state.presence_penalty,
        context_limit: state.contextLimit || 0,
        censored_words: state.censoredWords || '',
      });
    } catch { /* 会话未创建时忽略 */ }
  }

  /** 找到某个步骤所属消息（撤销要把标注写回正确的 assistant 消息） */
  function ownerMessageId(step) {
    if (!step) return null;
    if (step.message_id) return step.message_id;
    for (const m of state.messages) {
      const steps = m.steps || [];
      if (steps.some((s) => s === step || (step.undo_id && s.undo_id === step.undo_id))) {
        return m.id || null;
      }
    }
    return null;
  }

  async function undo(step) {
    const opId = step.undo_id || step.opId;
    if (!opId) return null;
    if (step.undone) return null;
    const res = await aiApi.undo(opId, state.chatId, ownerMessageId(step));
    // 服务端已把 undone 标注写进 steps_json；这里同步本地（steps 与 timeline 两种引用都要覆盖）
    for (const m of state.messages) {
      for (const s of m.steps || []) {
        if (s.undo_id === opId) s.undone = true;
      }
      for (const tl of m.timeline || []) {
        if (tl && (tl === step || tl.undo_id === opId || tl.ref?.undo_id === opId)) tl.undone = true;
      }
    }
    step.undone = true;
    recycle.markRestored(opId);
    return res;
  }

  async function decideApproval(allow) {
    const p = currentApprovals.value[0] || state.approvals[0];
    if (!p?.id) return;
    const always = allow === 'always';
    const okFlag = always || allow === true;
    if (always && !p.target) toast('该操作没有可固定的目标，将只允许本次', 'info', 2500);
    await aiApi.approve({
      id: p.id,
      allow: okFlag,
      always,
      target: p.target || undefined,
      chat_id: p.chat_id || state.chatId,
    });
    state.approvals = state.approvals.filter((x) => x.id !== p.id);
  }

  async function answerQuestion({ text, option, cancelled }) {
    const q = state.question;
    if (!q?.id) return;
    const body = { id: q.id, chat_id: q.chat_id || state.chatId };
    if (cancelled) body.cancel = true;
    else body.answer = String(text || option || '').trim();
    await aiApi.answerQuestion(body);
    state.question = null;
  }

  async function addInsert(text) {
    if (!state.chatId) return toast('先选择会话', 'warn');
    await aiApi.addInsert(state.chatId, text);
    await refreshSidecar(state.chatId);
  }

  async function clearInserts() {
    if (!state.chatId) return;
    await aiApi.clearInsert(state.chatId);
    state.insertItems = [];
  }

  async function saveSkills(loaded) {
    if (!state.chatId) {
      toast('先选择或新建会话再加载技能', 'warn');
      return false;
    }
    await aiApi.setChatSkills(state.chatId, loaded);
    state.loadedSkills = loaded;
    return true;
  }

  async function setCwd(path) {
    const res = await aiApi.setCwd(path, state.chatId);
    state.cwd = res?.cwd || path;
  }

  /** 手动压缩：不指定模型，服务端默认用本会话正在用的那个 */
  async function pressChat() {
    if (!state.chatId) return;
    let res = null;
    try {
      res = await aiApi.pressChat({ chat_id: state.chatId });
    } catch {
      return; // 拦截器已弹错误
    }
    const d = res?.data || {};
    await openChat(state.chatId);
    if (d.skipped) return toast(res?.message || '没有可压缩的内容', 'warn');
    toast(res?.message || '已压缩上下文', 'success');
  }

  async function setContext(limit) {
    if (!state.chatId) return;
    await aiApi.setContext({ chat_id: state.chatId, limit });
    state.contextLimit = limit;
  }

  async function updateTask(id, patch) {
    await aiApi.updateTask(id, patch);
    state.tasks = (await aiApi.getTasks(state.chatId)) || [];
  }

  function filesFromMessages() {
    const set = new Set();
    for (const m of state.messages) {
      for (const s of m.steps || []) {
        const p = s.path || s.args?.path || s.args?.new_path;
        if (p) set.add(p);
      }
    }
    return [...set];
  }

  function historyFromMessages() {
    const list = [];
    for (const m of state.messages) {
      for (const s of m.steps || []) {
        if (s.undo_id) {
          list.push({
            tool: s.name,
            path: s.path || s.args?.path || '',
            undo_id: s.undo_id,
            undone: !!s.undone,
            diff: s.diff || null,
            output: typeof s.output === 'string' ? s.output : (s.output != null ? safeJson(s.output) : ''),
            ref: s,
          });
        }
      }
    }
    return list;
  }

  return {
    state,
    activeChat,
    activeProject,
    freeChats,
    currentModel,
    modelName,
    chatTitle,
    currentApprovals,
    refreshTree,
    refreshModels,
    openChat,
    newProject,
    newChat,
    removeChat,
    renameChat,
    pinChat,
    openInExplorer,
    send,
    stop,
    undo,
    decideApproval,
    answerQuestion,
    setThinkingLevel,
    saveModelParams,
    persistModel,
    toggleModelPin,
    addInsert,
    clearInserts,
    saveSkills,
    setCwd,
    pressChat,
    setContext,
    updateTask,
    filesFromMessages,
    historyFromMessages,
  };
}
