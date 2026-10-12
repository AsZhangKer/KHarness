// 会话工作台状态（从零实现，不复用旧 AiPlayground）
import { reactive, computed, watch } from 'vue';
import { aiApi } from '../../api';
import { openChatStream, openPressStream } from './chatStream';
import { superviseStore } from './superviseStore';
import { toast } from '../../stores/toast';
import { confirmDialog } from '../../stores/confirm';
import { uiPrefs } from '../../stores/prefs';
import { recycleBin } from '../../stores/recycle';
import { soundDone, soundError, soundApproval, soundQuestion } from '../../utils/sound';
import { logErr } from '../../utils/errlog';
import { errReport, toastErr } from '../../utils/errText';
import { isCollapsed, setCollapsed } from '../../utils/collapse';

const recycle = recycleBin();

const state = reactive({
  loading: false,
  projects: [],
  chats: [],
  models: [],
  modelIdx: 0,
  /** 当前会话行里记着的那个模型（会话隔离的事实源；0 = 这条会话还没显式选过） */
  chatModelId: 0,
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
  // 审批模式的事实源在服务端（全局 settings + 会话行），这里只缓存**生效值**用于显示。
  // 以前它由 localStorage.nu_approval 决定并每条请求都发上去，服务端顺手写进会话行 ——
  // 于是会话发过一句话就被钉死，之后在控制台改全局对该条会话永远无效（显示一个值、按另一个值判）。
  approvalMode: 'default',
  /** true = 用户为**这条会话**显式选过（才允许落进会话行）；false = 跟随全局，请求里发空串 */
  approvalExplicit: false,
  /** 全局那一份（控制台/设置页改的就是它），新建会话还没 id 时显示它 */
  approvalGlobal: 'default',
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
  /* ask_user 的提问按会话分桶（第七十三轮 ④）。
     以前只有一格 state.question：A 在后台跑到 ask_user，事件把那一格写成 A 的问题，
     人却正看着 B —— B 的输入框上方冒出一条别人的提问，而 B 自己那条（如果有）被顶掉了。
     键 = chatId（新会话还没 id 时是 'tmp'），界面只显示正在看的那条会话的。 */
  questions: {},
  usage: {},
  contextUsed: 0,
  // 手动压缩在跑（/press 或右栏按钮）：按钮禁用 + 转圈全靠它
  pressing: false,
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
  /** 发送队列：一项是 { text, chatId }。带着归属才敢在「这条流跑完」时只倒自己那条会话的货 */
  queue: [],
  busyChats: {},
  /** 子智能体实时状态（只放**正在看的那条会话**的）：id -> { name, phase, model, iter, tool, result_preview, error } */
  subagents: {},
  /** chatId -> 本地消息数组（含 live），切会话/页面时保留 */
  msgBuf: {},
  /** 流式每落地一批就 +1：ChatPage 跟着它滚到底。
      以前那边是对整个 messages 数组开 deep watch —— 每次批都要把每条消息的 steps/timeline 全走一遍，
      读数（_tmp_kh77/perf_probe.js）：一条会话流式 6.5 秒里样式重算 1641 次、主线程任务 3.0 秒。 */
  streamTick: 0,
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

// 模式开关的落点：localStorage 是「全局默认」（新会话跟它），会话列是「这条会话显式选过」。
// 会话列为 -1 = 从没在这条会话上动过手 → openChat 读回时保持全局那份，不动。
// 以前这四个值只有 localStorage 一份，而且 openChat 读来的会话值会被 watch 倒灌回全局，
// 于是「切个会话把别的会话的开关也改了」；Plan 更惨：三条写库路全断（顶栏只改内存、
// body 里的 plan_mode 对已有会话被服务端忽略、弹窗新建会话写死 0）。
const MODE_FLAGS = {
  agentMode: { ls: 'nu_agent', col: 'agent_mode' },
  planMode: { ls: 'nu_plan', col: 'plan_mode' },
  readonlyMode: { ls: 'nu_readonly', col: 'readonly' },
  // 多模型池已半废弃（进实验室总闸），不占会话列
  autoMode: { ls: 'nu_auto', col: '' },
};

// 只有思考档还留在这里：它有自己的 setThinkingLevel 写会话行，这里只维护全局默认那一份
watch(
  () => state.thinkingLevel,
  (think) => {
    try { localStorage.setItem('nu_think', think || 'medium'); } catch { /* ignore */ }
  }
);

// 按会话保存进行中的流：切换页面/会话不 abort
const streams = new Map();

/* ── 「本场流」状态的落点 ────────────────────────────────────────────────────
   界面里这些格子每个都只有一份（用量、任务清单、子智能体、运行中的命令、首字与速度），
   而后台那条会话的流一直在往里写 —— 谁最后写谁就是屏幕上那个数，跟正在看的会话无关。
   他报的「切项目再切回，自由会话的工作目录被同化」「压缩后上下文百分比一动不动」是同一族。
   现在事件只写**自己那条会话**的桶，人正在看的那条才镜像进 state 供界面显示。 */
const tasksByChat = {};      // chatId（新会话是 'tmp'）→ 侧栏 plan 任务清单
const subagentsByChat = {};  // chatId → { 子智能体 id → 状态 }
let openSeq = 0;             // openChat 的序号：几条切换同时在飞时只让最后那次的响应落地

/* ── 输出速度与首字：0.2 秒一刷，读近 2 秒，**按会话分桶** ──────────────────────
   每个 tick（200ms）对**每一条在跑的会话**各算一次「近 2 秒内新增的输出估算 ÷ 这段时间」，
   屏幕上那格永远取当前会话那一桶。
   以前这一组是模块级单份（speedSamples / speedFinalized / genAccum…），_tmp_kh77/speed_crosschat_probe.js
   量出两条真的坏形状：
     · 后台那条会话的 done 把 speedFinalized 钉成 true → 屏幕上这条还在流，速度格却冻结（2.4 秒里只出 1 个值）；
     · 切会话把 firstTokenMs 清 0，切回来又拿「按下发送」那个锚点重记 → 首字成了整段墙钟（实测 2.6s，真值 38ms）。
   首字口径（第七十七轮拍的）：**按下发送 → 上游第一个包**（思考/正文/工具调用谁先到算谁），记一次就不再改。
   done 帧只在这一桶没量到首字时拿服务端 ttft_ms 兜底，不再覆盖客户端实测 —— 服务端那个起点是「本机后端
   把请求发出去」，不含按下发送到后端的排队与预处理，覆盖回来会偏小（实测 8ms 对 39ms）。
   手动停止没有 done 帧：收工时拿「本场产出 ÷ 本场生成时长」钉住那一桶（生成时段已跳过工具执行那些间隔）。 */
const SPEED_TICK_MS = 200;
const SPEED_WINDOW_MS = 2000;
// 两个产物之间隔这么久就算「这一段生成结束了」（中间在跑工具或在等审批）—— 别把那段墙钟算进速度
const GEN_GAP_MS = 1500;
let speedTimer = null;

const perfByChat = {};   // chatId（新会话是 'tmp'）→ 这一场的首字 / 速度 / 已产出估算 / 生成时段

function perfOf(key) {
  const k = key || 'tmp';
  if (!perfByChat[k]) {
    perfByChat[k] = {
      firstTokenMs: 0, tokPerSec: 0, streamTokens: 0,
      samples: [], segStart: 0, segLast: 0, segAccumMs: 0, finalized: false,
    };
  }
  return perfByChat[k];
}

/** 新一轮开始：这一桶整个换掉（旧的收尾值不许漏进新一轮） */
function resetPerf(key) {
  const p = perfOf(key);
  p.firstTokenMs = 0; p.tokPerSec = 0; p.streamTokens = 0;
  p.samples = []; p.segStart = 0; p.segLast = 0; p.segAccumMs = 0; p.finalized = false;
  return p;
}

function movePerf(from, to) {
  const k = from || 'tmp';
  if (!perfByChat[k]) return;
  perfByChat[to] = perfByChat[k];
  delete perfByChat[k];
}

/** 界面上那两格（首字 / tok/s）与已产出估算都来自屏幕上这条会话的桶 */
function mirrorPerf() {
  // 只看有没有这一桶：切到一个从没在本地流式过的会话时不凭空建桶（那会一路攒出几百个空对象）
  const p = perfByChat[state.chatId || 'tmp'];
  state.firstTokenMs = p ? p.firstTokenMs : 0;
  state.tokPerSec = p ? p.tokPerSec : 0;
  state.streamTokens = p ? p.streamTokens : 0;
}

/** 与服务端 agentsmd.estimateTokens 同一把尺：CJK 0.6 tok/字，其余 0.25 tok/字符 */
function estTok(s) {
  const str = String(s || '');
  const cjk = (str.match(/[一-鿿぀-ヿ]/g) || []).length;
  return cjk * 0.6 + (str.length - cjk) * 0.25;
}

/** 每来一个产物（正文 / 思考 / 工具调用）记一次：据此把「在生成」和「在等工具」分成两段 */
function markArtifact(p) {
  const now = Date.now();
  if (!p.segStart || now - p.segLast > GEN_GAP_MS) {
    if (p.segStart && p.segLast > p.segStart) p.segAccumMs += p.segLast - p.segStart;
    p.segStart = now;
  }
  p.segLast = now;
}

/** 本场累计的纯生成时长（秒），包含还开着的那一段 */
function genSeconds(p) {
  let ms = p.segAccumMs;
  if (p.segStart && p.segLast > p.segStart) ms += p.segLast - p.segStart;
  return ms / 1000;
}

/**
 * 首字：按下发送（reply._startedAt）→ 上游第一个包，**记一次就不再改**。
 * 没有锚点（_startedAt 丢了，例如换页后接回这趟流）时**什么都不写** ——
 * 以前写 0，屏幕上就是一个坏掉的「0.0s」。
 */
function markFirstToken(p, reply) {
  if (p.firstTokenMs) return;
  const at = reply && reply._startedAt;
  if (!at) return;
  p.firstTokenMs = Math.max(1, Date.now() - at);
}

function startSpeedTicker() {
  if (speedTimer) return;
  speedTimer = setInterval(() => {
    const now = Date.now();
    for (const key of Object.keys(perfByChat)) {
      const p = perfByChat[key];
      // 不在跑 / 已收尾的桶一律不动：否则「上一场的平均值」会被下一拍算成 0 刷掉
      if (p.finalized || !state.busyChats[key]) continue;
      p.samples.push({ t: now, tok: p.streamTokens });
      // 头那一个要留「比窗口老的那一个」，其余全留：这样 secs 稳定在 2 秒上下。
      // 条件以前写反成 `<= SPEED_WINDOW_MS`（把窗口内的都甩掉，只剩上一拍），secs 恒等于 0.2 秒，
      // 于是 `secs >= 0.4` 这道闸**从来没开过** —— 实时 tok/s 一个字都没刷过，屏幕上那个数一直是上一回合的收尾值
      // （他报的「tok 发生故障，不再按固定间隔刷新」真正的根因；用例见 client/__tests__/perf-per-chat-round77.test.js）。
      while (p.samples.length > 2 && now - p.samples[1].t > SPEED_WINDOW_MS) p.samples.shift();
      const head = p.samples[0];
      const secs = (now - head.t) / 1000;
      if (secs >= 0.4) p.tokPerSec = Math.max(0, p.streamTokens - head.tok) / secs;
    }
    mirrorPerf();
  }, SPEED_TICK_MS);
}
function stopSpeedTicker() {
  if (speedTimer) { clearInterval(speedTimer); speedTimer = null; }
}
/** 一条会话收工（done 或手动停止都走这里）：把那一桶钉成「本场产出 ÷ 本场生成时长」 */
function settlePerf(key) {
  const p = perfOf(key);
  if (p.finalized) return;
  const secs = genSeconds(p);
  if (secs > 0.2 && p.streamTokens > 0) p.tokPerSec = p.streamTokens / secs;
  p.finalized = true;
}
// 有**任何一条**会话在跑就开着表，全闲下来才停。
// 以前盯的是 state.busy（= 屏幕上这条在不在跑）：屏幕上开着一条空闲会话、后台那条在流时，
// 后台那一桶永远采不到样，切回去就看到速度停在 0。
watch(() => Object.keys(state.busyChats).length, (n) => {
  if (n > 0) startSpeedTicker(); else stopSpeedTicker();
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
  /** 正在看的这条会话的提问（ask_user 按会话分桶，见 state.questions） */
  const currentQuestion = computed(() => state.questions[state.chatId || 'tmp'] || null);
  /** 队列里属于当前会话的那几条（横幅只该数自己这几条） */
  const queued = computed(() =>
    state.queue.filter((q) => (q.chatId || 'tmp') === (state.chatId || 'tmp'))
  );

  async function refreshTree() {
    const [ps, cs] = await Promise.all([aiApi.getProjects(), aiApi.getChats()]);
    let pinnedSet = new Set();
    try {
      pinnedSet = new Set(JSON.parse(localStorage.getItem('nu_pinned_chats') || '[]'));
    } catch { /* ignore */ }
    // open 按折叠清单算，**不再写死 true**：以前每发一条消息（chat 帧 → refreshTree）
    // 就把用户折叠好的项目全展开回来（第七十四轮 ③）
    state.projects = (ps || []).map((p) => ({
      ...p,
      open: !isCollapsed('p', p.id),
      pinned: !!(p.pinned || pinnedSet.has(p.id)),
    }));
    state.chats = (cs || []).map((c) => ({
      ...c,
      pinned: !!(c.pinned || pinnedSet.has(c.id)),
    }));
    for (const p of state.projects) {
      p.chats = state.chats.filter((c) => c.project_id === p.id);
    }
  }

  /** 左栏点项目/远端项目的行头：内存翻一下，同时记进折叠清单（不记就活不到下一次刷新） */
  function toggleProjectOpen(id) {
    const p = state.projects.find((x) => x.id === id);
    if (!p) return;
    p.open = !p.open;
    setCollapsed('p', id, !p.open);
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
    // 当前会话显式用过的那个模型优先；没有（新会话/从没选过）才回落到全局那份默认
    try {
      const prefer = state.chatId && state.chatModelId ? state.chatModelId : Number(localStorage.getItem('nu_model_id') || 0);
      const idx = state.models.findIndex((m) => m.id === prefer);
      if (idx >= 0) state.modelIdx = idx;
      else if (state.modelIdx >= state.models.length) state.modelIdx = 0;
    } catch {
      if (state.modelIdx >= state.models.length) state.modelIdx = 0;
    }
  }

  function persistModel() {
    const m = state.models[state.modelIdx];
    if (m) {
      // 会话行的那份是「这条会话显式选过的模型」，openChat/refreshModels 都以它为先
      state.chatModelId = m.id;
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

  /**
   * 改一个模式开关。两处一起落：localStorage 当「全局默认」（新会话跟它），
   * 会话列当「这条会话显式选过」—— 他 2026-10-10 定的口径就是「会话留空=跟随全局」。
   */
  async function setModeFlag(key, on) {
    const spec = MODE_FLAGS[key];
    if (!spec) return;
    state[key] = !!on;
    try { localStorage.setItem(spec.ls, state[key] ? '1' : '0'); } catch { /* ignore */ }
    if (spec.col && state.chatId) {
      try { await aiApi.updateChatSettings(state.chatId, { [spec.col]: state[key] ? 1 : 0 }); } catch { /* 没写成也别卡住界面：下一条请求仍带当前值 */ }
    }
  }

  /**
   * 会话行那份配置应用到界面：模型、三个开关、审批档、思考档、温度、脱敏词、工作目录。
   * 「打开会话」和「这条会话还在生成、切回来」两条路都必须走它 —— 以前快路径整个跳过这一段，
   * 于是 a 在跑时切去 _b 再切回 a，界面留着 _b 的模型，下一次请求就把 a 真发给那个模型
   * （他 2026-10-11 报的那条；Ctrl+R 能变回来正因为库里那条行一直是对的）。
   */
  function applyChatMeta(chat) {
    if (!chat) return;
    state.planMode = !!chat.plan_mode;
    // Agent / 只读：会话列 -1 = 这条会话从没手动开关过，保持全局默认那份（localStorage 初始值）
    if (Number(chat.agent_mode) >= 0) state.agentMode = Number(chat.agent_mode) === 1;
    if (Number(chat.readonly) >= 0) state.readonlyMode = Number(chat.readonly) === 1;
    // 模型按会话隔离：会话行有值就以它为准（他 2026-10-10 的口径）。
    // 行里那个模型已被删/被禁用（不在 state.models 里）时不动，继续用全局那份，免得界面显示一个空模型。
    state.chatModelId = Number(chat.model_row_id) || 0;
    if (chat.model_row_id) {
      const mi = state.models.findIndex((m) => m.id === chat.model_row_id);
      if (mi >= 0) state.modelIdx = mi;
    }
    // 显示服务端算出的**生效值**；会话行非空才算「本会话显式覆盖」
    state.approvalExplicit = !!chat.approval_mode;
    state.approvalMode = chat.approval_effective || chat.approval_mode || state.approvalGlobal || 'default';
    state.thinkingLevel = chat.thinking_level || state.thinkingLevel || 'medium';
    state.temperature = chat.temperature ?? 0.7;
    state.frequency_penalty = chat.frequency_penalty ?? 0;
    state.presence_penalty = chat.presence_penalty ?? 0;
    state.censoredWords = chat.censored_words || '';
    state.cwd = chat.cwd || '';
    // 上下文窗口：行里 0 = 没单独设定（跟随模型上限，那个数由这一轮的 usage 帧带），
    // 所以只在有显式值时才盖，免得把界面已有的生效值清成 0。
    if (Number(chat.context_limit) > 0) state.contextLimit = Number(chat.context_limit);
    // 用量也一起回读（/chats/:id/settings 带这一份）：切回一条正在生成的会话时，
    // 那条快路径不拉整段历史，百分比就只能靠这里给的数 —— 不读的就是上一条会话留下的值。
    // 注意这只管「上下文占用」那一行；`state.usage` 是**回合 token 明细**（另一把尺），
    // 由 syncTurnUsage 从消息里倒查，别拿这份上下文口径的 {used,limit} 去覆盖它。
    if (chat.usage) {
      if (Number(chat.usage.used) > 0) state.contextUsed = Number(chat.usage.used);
      if (Number(chat.usage.limit) > 0) state.contextLimit = Number(chat.usage.limit);
    }
  }

  /**
   * 右栏「本轮输入 / 输出 / 缓存 / 思考」那四格的数据源：倒查最后一条带 usage 的 assistant 消息。
   * 以前这四格只活在 done 帧写进来的内存里，一刷新就被上下文口径那份（used/limit）盖成 0，
   * 也没有「上一轮的结果」可看（他第七十四轮报的那条）。现在每回合随消息落库，切回来还在。
   */
  function syncTurnUsage() {
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const m = state.messages[i];
      if (m.role === 'assistant' && m.usage) { state.usage = m.usage; return; }
    }
    state.usage = {};
  }

  /**
   * 快路径（这条会话还在生成）也回服务端读配置：只取那一小份，不拖整段消息。
   * 老后端没这条路由（404）就退回整份 GET —— 宁可多拉一次消息，也不能让界面留着别条会话的模型。
   */
  async function loadChatMeta(id) {
    let chat = null;
    try {
      chat = await aiApi.getChatSettings(id);
    } catch (e) {
      try { chat = (await aiApi.getChat(id))?.chat || null; } catch { /* 读不到就保持现状，别把切换卡住 */ }
    }
    // 等回来时人可能已经切到别的会话了 —— 别把这条会话的配置写到别人身上
    if (state.chatId === id) applyChatMeta(chat);
  }

  async function openChat(id) {
    // 序号守卫：连着切两条会话时，两趟 GET 会在网上错身而过。
    // 谁后回来谁覆盖 —— 于是「自由会话切去某个项目再切回来，工作目录变成了那个项目的根」
    // 这种只在手快时才出现、Ctrl+R 又好回去的毛病（第七十三轮 ①，不稳定复现的正是竞态的形状）。
    const seq = ++openSeq;
    if (state.chatId && state.chatId !== id) {
      state.msgBuf[state.chatId] = state.messages;
    }
    state.chatId = id;
    // 切会话：命令运行态属于「本场流」，不带过去（心跳 15s 内会重新点亮）；
    // 首字与速度**不是**清掉，而是换成目标会话自己那一桶 —— 清掉会让切回正在生成的那条时
    // 拿「按下发送」的锚点重记一次，屏幕上就成了整段墙钟（第七十七轮实测 2.6s / 真值 38ms）
    state.runningCmd = null;
    mirrorPerf();
    state.lastEventAt = Date.now();
    // 子智能体与 plan 清单换成这条会话自己那份桶（还没写过就是空），流里的帧再补
    state.subagents = { ...(subagentsByChat[id] || {}) };
    state.tasks = tasksByChat[id] || [];

    const inflight = streams.get(id);
    const cached = state.msgBuf[id];
    if (inflight?.live && cached) {
      // 生成中：用本地缓冲，live 同一引用继续被流写入
      state.messages = cached;
      if (!state.messages.includes(inflight.live)) state.messages.push(inflight.live);
      // 消息可以不重新拉，**配置与用量必须回服务端读一次** —— 以前这条快路径整段省了，
      // 于是模型/开关/工作目录/百分比全留着上一条会话的值
      await Promise.all([loadChatMeta(id), refreshTasks(id)]);
      if (seq !== openSeq) return;
    } else {
      const res = await aiApi.getChat(id);
      if (seq !== openSeq) return;   // 迟到的上一条会话的响应：一个字都不许再写
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
      tasksByChat[id] = state.tasks;
      applyChatMeta(chat);
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
    // 右栏那四格换成这条会话自己的「上一轮明细」（两条路径都要，见 syncTurnUsage）
    syncTurnUsage();
    await refreshSidecar(id);
    // 切回来时这条会话空闲、队列里还攒着它自己的话：补发出去（切走时没发的那半）
    flushQueue(id);
  }

  /** 侧栏 plan 清单：按会话读，回来时人可能已经切走了 —— 只写给原来那条会话 */
  async function refreshTasks(chatId) {
    if (!chatId) return;
    try {
      const t = await aiApi.getTasks(chatId);
      const list = Array.isArray(t) ? t : (t?.tasks || []);
      tasksByChat[chatId] = list;
      if (state.chatId === chatId) state.tasks = list;
    } catch { /* 读不到保持现状，别把切换卡住 */ }
  }

  async function refreshSidecar(chatId) {
    if (!chatId) return;
    try {
      const [ins, sk] = await Promise.all([
        aiApi.getInsert(chatId),
        aiApi.getChatSkills(chatId),
      ]);
      // 这两格也是「正在看的那条会话」的：等回来时人切走了就不写（否则侧栏显示别条会话的待注入项）
      if (state.chatId === chatId) {
        state.insertItems = ins?.items || [];
        state.loadedSkills = sk?.loaded || [];
      }
    } catch { /* optional */ }
  }

  async function newProject(name, root_path, remote_id) {
    // remote_id 非空 = 远端项目：root_path 是远端绝对路径，校验由后端走 SFTP 做
    await aiApi.createProject({ name, root_path, ...(remote_id ? { remote_id } : {}) });
    await refreshTree();
  }

  /**
   * 左栏右键「编辑项目」：改显示名与工作目录。
   * 两个字段都只是库里的值 —— 后端不会（也不许）去移动、重命名或创建磁盘上的任何文件/目录。
   * 目录改了以后落在新根之外的会话会被重置成新根，条数在返回里，交给调用方说清楚。
   */
  async function editProject(id, patch) {
    const res = await aiApi.updateProject(id, patch);
    await refreshTree();
    return res;
  }

  async function newChat(projectId, remoteId) {
    const model = currentModel.value;
    if (!model) {
      toast('请先在模型管理中添加模型', 'warn');
      return null;
    }
    // 挂哪个项目只由调用方给，这里不再悄悄兜底。
    // 以前这句是 `projectId || activeProject?.id`：新建弹窗里选了「不关联项目」（null）会被兜回当前活动项目，
    // 用户看到的就是「明明选了不关联，会话却出现在项目下面」。「默认=当前项目」这件事只该在弹窗预填那一次
    // （ChatPage.onNewChat），落到建会话这一步必须照实传。
    const pid = projectId ?? null;
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
    // 这条会话的本地桶一起清：留着下次同一个 id 复用会把旧消息显示成新会话的
    delete state.msgBuf[id];
    delete tasksByChat[id];
    delete subagentsByChat[id];
    delete state.questions[id];
    if (state.chatId === id) {
      state.chatId = null;
      state.messages = [];
      state.tasks = [];
      state.subagents = {};
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
    state.streamTick++;
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
    state.streamTick++;
  }
  /* 同一段思考不许被过程提示切成两张卡（#243）。
     任何非 delta/reason 的事件都会先封口缓冲区，于是服务端每遇 429 限流 / 超时 / 参数重试发的那条
     note 一插进来，后面的思考就只能新开一条 reason —— 用户看到的是「一段思考被截成两段」。
     note 不是模型在动手，往回找段时越过它；碰到正文或工具卡才算真的换段了。 */
  function tailReason(tl) {
    for (let i = tl.length - 1; i >= 0; i--) {
      const it = tl[i];
      if (it.kind === 'reason') return it;
      if (!(it.kind === 'step' && it.type === 'note')) return null;
    }
    return null;
  }
  function tlAppendReason(reply, text) {
    if (!text) return;
    if (!reply.timeline) reply.timeline = [];
    const r = tailReason(reply.timeline);
    if (r) r.text += text;
    else reply.timeline.push({ kind: 'reason', text });
    reply.reasoning += text;
    state.streamTick++;
  }

  /* 流式合并刷新（#231）：SSE 每来一块就改一次响应式数据 → 每块渲染一次。
     攒到 ~30ms 再落地，一次渲染替掉十几次的重排重绘；入库文本一个字没改（那是服务端的事），
     界面最多钝 30ms。别用 requestAnimationFrame 当唯一驱动：窗口没焦点时它被节流到 ~1/s，
     他会看到「切回来才刷」，所以用定时器。 */
  function queueStream(reply, kind, text) {
    if (!text) return;
    if (!reply._buf) reply._buf = { text: '', reason: '' };
    reply._buf[kind] += text;
    if (reply._bufQueued) return;
    reply._bufQueued = true;
    setTimeout(() => {
      reply._bufQueued = false;
      const buf = reply._buf;
      if (!buf) return;
      if (buf.text) { tlAppendText(reply, buf.text); buf.text = ''; }
      if (buf.reason) { tlAppendReason(reply, buf.reason); buf.reason = ''; }
    }, 30);
  }
  function flushStream(reply) {
    const buf = reply._buf;
    if (buf && (buf.text || buf.reason)) {
      if (buf.text) tlAppendText(reply, buf.text);
      if (buf.reason) tlAppendReason(reply, buf.reason);
      buf.text = '';
      buf.reason = '';
    }
    reply._bufQueued = false;
  }

  /**
   * SSE 事件分发。
   * @param ctx 这条流的归属：{ chatId }，新建会话那首轮在 chat 帧里从 null 换成真实 id。
   *   凡是往「界面那一格」写的状态都要先问一句 `here()` —— 人不在看这条会话就不许动。
   *   不传 ctx 的调用（单测直接灌事件序列）等于「正在看的就是这条」，行为照旧。
   */
  function handleEvent(evt, reply, ctx) {
    const t = evt.t;
    const c = ctx || { chatId: state.chatId || null };
    // 判断「这条流是不是屏幕上那一场」必须在改 c.chatId 之前问，否则新建会话首轮自己就把自己踢掉了
    const here = () => c.chatId === (state.chatId || null);
    if (here()) state.lastEventAt = Date.now();
    // 增量之外的任何事件都要先把攒着的文字落地，否则顺序会串（工具卡插在一截正文前面）
    if (t !== 'delta' && t !== 'reason') flushStream(reply);
    if (t === 'chat') {
      // 新建会话这轮才拿到 id：顺手把服务端算出的生效审批模式接过来显示（内存里选的那份就此落地）
      const onScreen = here();
      const prevId = c.chatId;
      const nextId = evt.chat_id || c.chatId;
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
        if (state.questions[prevId || 'tmp']) {
          state.questions[nextId] = state.questions[prevId || 'tmp'];
          delete state.questions[prevId || 'tmp'];
        }
        if (tasksByChat[prevId || 'tmp']) {
          tasksByChat[nextId] = tasksByChat[prevId || 'tmp'];
          delete tasksByChat[prevId || 'tmp'];
        }
        if (subagentsByChat[prevId || 'tmp']) {
          subagentsByChat[nextId] = subagentsByChat[prevId || 'tmp'];
          delete subagentsByChat[prevId || 'tmp'];
        }
        // 首字 / 速度那一桶也跟着搬：不然新建会话首轮拿到 id 之后，界面上那两格会掉回空桶
        movePerf(prevId, nextId);
        // 关键：登记这次迁移，让发起方收尾时按新 key 清理。
        // 否则 send() 仍拿住旧的 'tmp' 去 delete，真实 id 的 busy 永久残留，
        // 之后每一次发送都会被当成「本会话正在生成」塞进队列——表现为撤回重发卡死。
        reply._busyKey = nextId;
      }
      c.chatId = nextId;
      // 人早就切到别的会话了：这条流只把自己的归属记清楚，界面一格都不写
      // （以前这里无条件 `state.chatId = nextId`，后台新建的会话会把正在看的会话抢走）
      if (!onScreen) { refreshTree(); return; }
      if (evt.approval_effective) state.approvalMode = evt.approval_effective;
      state.chatId = nextId;
      const cRow = state.chats.find((x) => x.id === evt.chat_id);
      if (cRow && evt.title) cRow.title = evt.title;
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
      // 首字 / 生成时段 / 已产出估算一律写**这条流自己那一桶**（后台那几条也在流，不能只在屏幕上时才记），
      // 只有看着这条会话时才把它镜像到界面上那两格
      const p = perfOf(c.chatId);
      markArtifact(p);
      markFirstToken(p, reply);
      p.streamTokens += estTok(evt.text);
      if (here()) mirrorPerf();
      queueStream(reply, 'text', evt.text || '');
    } else if (t === 'reason') {
      const rt = evt.text || '';
      const p = perfOf(c.chatId);
      markArtifact(p);
      markFirstToken(p, reply);
      p.streamTokens += estTok(rt);
      if (here()) mirrorPerf();
      queueStream(reply, 'reason', rt);
    } else if (t === 'compress') {
      // 「先压缩上下文、再回答」要在消息流里看得见：一条 compress 步骤卡，
      // start → done/skipped/failed 就地更新同一张卡（timeline 那边存的是 ref，改 ref 即改显示）
      let st = null;
      for (let i = reply.steps.length - 1; i >= 0; i--) {
        if (reply.steps[i].type === 'compress' && reply.steps[i].phase === 'start') { st = reply.steps[i]; break; }
      }
      const isNew = !st;
      if (isNew) {
        // threshold / manual 必须一起抄：卡片那句「已达 X%」要说的是**当时生效的阈值**，
        // 前端自己兜一个 80 的话，用户把设置改成 60 后流式期间就还在报 80%（他第七十四轮报的那条）
        st = { type: 'compress', name: '压缩上下文', phase: evt.phase, used: evt.used, limit: evt.limit, percent: evt.percent, from: evt.from, basis: evt.basis, threshold: evt.threshold, manual: evt.manual };
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
      // 压缩卡片本身属于这条流（reply），照写；界面那一格用量只有在看着这条会话时才动。
      // 而且取的是**压缩后**的那份：帧里的 used 是压缩前的量，after 才是压完的实际占用 ——
      // 以前只写 used，于是「压完了百分比一动不动，看着像压了个空的」（第七十三轮 ②）。
      if (here()) {
        const shown = evt.phase === 'done' && Number(evt.after) > 0 ? Number(evt.after) : Number(evt.used);
        if (shown > 0) state.contextUsed = shown;
        if (Number(evt.limit) > 0) state.contextLimit = Number(evt.limit);
      }
    } else if (t === 'tool') {
      // 工具调用也是上游产物：它到了才算「这轮已经出字」，而它后面那段执行时间不算生成
      {
        const p = perfOf(c.chatId);
        markArtifact(p);
        markFirstToken(p, reply);
        if (here()) mirrorPerf();
      }
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
        image_token: evt.image_token || null,   // 截图类工具：图就在服务端内存里，按 token 取
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
          // 归属写这条流自己的会话，不是界面当前那格 —— 后台会话删的文件不该记到正在看的会话名下
          chat_id: c.chatId,
        });
      }
    } else if (t === 'note' || t === 'insert_injected') {
      if (t === 'insert_injected' && here()) {
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
        chat_id: evt.chat_id || c.chatId,
        // 「审阅」要的数据：服务端在弹审批前算好的真 diff / 命令原文 / 目标文件信息（#214）
        preview: evt.preview || null,
      }]);
      notifyHidden('KHarness 需要审批', `${evt.tool}：${evt.reason || '敏感操作'}`);
    } else if (t === 'question') {
      soundQuestion();
      // 提问按会话落桶：后台那条会话问的，不许顶掉正在看的这条会话的提问横幅
      state.questions[c.chatId || 'tmp'] = {
        id: evt.id,
        question: evt.question,
        options: evt.options || [],
        chat_id: evt.chat_id || c.chatId,
        // ask_user 一次问多题时服务端按顺序下发，序号只用来显示「第 i/N 题」
        q_index: Number(evt.q_index) || 1,
        q_total: Number(evt.q_total) || 1,
      };
      notifyHidden('AI 在等你回答', String(evt.question || '').slice(0, 120));
    } else if (t === 'approval_expired') {
      // 服务端到点按拒绝处理并删掉了挂起的审批：卡片必须跟着退场。
      // 留着它，用户点哪颗键都是一个 404，而且永远点不掉（他报的「赖着不走」）。
      state.approvals = state.approvals.filter((a) => a.id !== evt.id);
    } else if (t === 'question_expired') {
      const qk = c.chatId || 'tmp';
      if (state.questions[qk]?.id === evt.id) delete state.questions[qk];
    } else if (t === 'cmd_running') {
      // run_command 开始/结束：驱动「判定超时」按钮与已跑时长 —— 只在看着这条会话时写
      if (here()) {
        state.runningCmd = evt.command
          ? { command: String(evt.command), startedAt: Date.now(), elapsedMs: 0 }
          : null;
      }
    } else if (t === 'usage') {
      // 回合中途的用量刷新（Agent 每读完一批工具就发一次）：右侧百分比要跟着往上走，
      // 而不是整回合结束才跳一下 —— 以前那种「连读几十个文件界面纹丝不动」就是这么来的。
      // 反过来也成立：后台会话的用量帧不许写进正在看的这条会话的百分比（第七十三轮 ②）。
      if (here()) {
        if (Number(evt.used) > 0) state.contextUsed = Number(evt.used);
        if (Number(evt.limit) > 0) state.contextLimit = Number(evt.limit);
      }
    } else if (t === 'heartbeat') {
      // 15s 一次；命令运行时带 pid/command/elapsed_ms
      if ((evt.command || evt.pid) && here()) {
        if (!state.runningCmd) {
          state.runningCmd = { command: String(evt.command || ''), startedAt: Date.now() - (evt.elapsed_ms || 0), elapsedMs: evt.elapsed_ms || 0 };
        } else {
          state.runningCmd.elapsedMs = evt.elapsed_ms || Date.now() - state.runningCmd.startedAt;
          state.runningCmd.pid = evt.pid || null;
        }
      }
    } else if (t === 'tasks') {
      // 侧栏 plan 清单按会话分桶，正在看的那条才镜像给界面
      const tk = c.chatId || 'tmp';
      tasksByChat[tk] = evt.tasks || [];
      if (here()) state.tasks = tasksByChat[tk];
    } else if (t === 'subagent') {
      // 子智能体进度：右栏面板据此实时更新；开始/结束各在正文里落一条 note
      // 状态按会话分桶（后台会话派出的子智能体不许混进这一栏），正在看的那条才镜像给界面
      const sk = c.chatId || 'tmp';
      const bucket = subagentsByChat[sk] || (subagentsByChat[sk] = {});
      const cur = bucket[evt.id] || { id: evt.id };
      cur.name = evt.name || cur.name || evt.id;
      cur.phase = evt.phase;
      if (evt.model) cur.model = evt.model;
      if (evt.tool) cur.tool = evt.tool;
      if (evt.phase === 'start') {
        cur.iter = 0;
        cur.task = evt.task || '';
        // subagentId 带在卡片上：点这张卡要看的是那个分身的执行步骤（ChatMessage 据此变成可点）
        const st = { type: 'note', subagentId: evt.id, message: `派出子智能体「${cur.name}」（只读）：${evt.task || ''}` };
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
          subagentId: evt.id,
          message: evt.phase === 'done'
            ? `子智能体「${cur.name}」已交回结论（${String(evt.result || '').length} 字）`
            : `子智能体「${cur.name}」${evt.phase === 'killed' ? '被停止' : '失败'}：${evt.error || ''}`,
        };
        reply.steps = reply.steps || [];
        reply.steps.push(st);
        tlPush(reply, { kind: 'step', ref: st, ...st });
        // 结论不再凭空画一个「子智能体」气泡（第七十七轮他的口径：像工具返回一样直接交给 AI，
        // 界面上要看就点上面那条 note 进详情窗，结论在窗尾）。服务端也不落消息表了。
      }
      bucket[evt.id] = cur;
      if (here()) state.subagents = { ...bucket };
    } else if (t === 'done') {
      soundDone();
      reply.latency_ms = evt.latency_ms || 0;
      // 回合收尾的这几格（延迟 / 首字 / 平均速度 / 用量 / 任务 / 运行命令）都是「屏幕上这一场」的，
      // 后台那条流跑完不许把它们换掉 —— 换了他就会看到「百分比压完不降」「速度突然变成别条会话的」
      const fin = here();
      if (evt.usage) reply.usage = evt.usage;
      if (evt.tasks) tasksByChat[c.chatId || 'tmp'] = evt.tasks;
      // 这一回合的收尾数先进**自己那一桶**（后台那条流跑完不许把屏幕上这两格换掉）
      {
        const p = perfOf(c.chatId);
        // 首字：客户端按下发送那把表已经记上了就用它（口径就是「按下发送→第一个包」）；
        // 只有接回别人的流这种没锚点的情况，才拿服务端 ttft_ms 兜底
        if (!p.firstTokenMs && evt.ttft_ms > 0) p.firstTokenMs = evt.ttft_ms;
        const outTok = evt.usage && evt.usage.completion_tokens > 0 ? evt.usage.completion_tokens : p.streamTokens;
        const genSecs = evt.gen_ms > 0 ? evt.gen_ms / 1000 : genSeconds(p);
        if (outTok > 0 && genSecs > 0.2) p.tokPerSec = outTok / genSecs;
        p.finalized = true;
      }
      if (fin) {
        if (evt.latency_ms) state.latencyMs = evt.latency_ms;
        mirrorPerf();
        if (evt.usage) state.usage = evt.usage;
        // 百分比只认服务端那一份：done 事件带的 context_used 是回合结束后按锚点重算的
        // （锚点 = 上游真实 prompt+completion，还含工具 schema 的开销）。
        // 以前这里用 evt.usage.prompt_tokens 覆盖一次 —— 少了 completion，等于一轮结束后换了一把尺。
        if (evt.context_used > 0) state.contextUsed = evt.context_used;
        if (evt.tasks) state.tasks = evt.tasks;
        if (evt.context_limit != null) state.contextLimit = evt.context_limit;
        state.runningCmd = null;
      }
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
      // 自动重试打光才断的（429/5xx）：红条上那颗键改叫「重试」，别让人以为一点就又是失败
      reply.retryExhausted = !!evt.retry_exhausted;
      // 已经吐出字却被打断 → 标未完成，下方留「继续生成」（服务端同一口径落库，刷新后还在）。
      // 一个字没出就不标：那时「继续」在上游没有锚点可接，红条那颗「重试」才是对的用法。
      if (String(reply.content || '').trim()) reply.unfinished = true;
    }
  }

  /**
   * 把队列里攒着的那条发出去 —— 只能在「它所属的那条会话」空闲且正看着它时发。
   * 以前回合结束是无条件 `state.queue.shift()` 然后 send()：人中途从 A 切到 B，
   * A 跑完就把本来要给 A 的下一条发进了 B（队列里没有归属信息，谁都拦不住）。
   */
  function flushQueue(chatId) {
    const key = chatId || 'tmp';
    if ((state.chatId || 'tmp') !== key) return Promise.resolve();
    if (state.busyChats[key]) return Promise.resolve();
    const i = state.queue.findIndex((q) => (q.chatId || 'tmp') === key);
    if (i < 0) return Promise.resolve();
    const [item] = state.queue.splice(i, 1);
    // 返回那条 promise：监工交棒要等队列里的用户消息发完才接下一棒（口径见 send 收尾）
    return send(item.text).catch(() => { /* send 内部已有红条与 toast，这里不再叠一层 */ });
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
        // 先把输入框清空再执行：命令一旦抛错（压缩超时、窗口校验 400…），
        // 原来那句 `state.draft = ''` 永远走不到 —— 表现就是「按了回车命令执行了、字还留在框里」。
        state.draft = '';
        try {
          const handled = await runCommand(text);
          if (handled) return;
        } catch (e) {
          toastErr(e, `命令 ${text.split(' ')[0]} 执行失败`);
          return;
        }
      }
    }

    const busyId = state.chatId || 'tmp';
    // 本会话生成中：进消息队列，答完自动发送。队列项带着归属，收尾才敢只对号倒货
    if (!continueMode && state.busyChats[busyId]) {
      state.queue.push({ text, chatId: busyId });
      state.draft = '';
      toast(`已加入队列（${queued.value.length}）`, 'info', 2000);
      return;
    }
    if (continueMode && state.busyChats[busyId]) return;
    if (!continueMode) state.draft = '';

    // 「先点」的池子只有打开池选择器确认时才落地，localStorage 里存的却是 autoMode=true ——
    // 于是重启之后池是空的：以前这里把空数组发上去，model_row_id 就是 undefined，
    // 服务端一路回「未指定模型」，界面只剩一条红条。现在退回当前选中的那一个模型；
    // 一个模型都没有时先把话放回输入框并给一句人话，不再发一个注定失败的请求。
    // 实验室那道闸（pool_enabled）关掉时整条「先点」不参与选模型 —— 存着的 autoMode 与池子都不算数。
    const autoPool = uiPrefs.state.poolOn && state.autoMode ? state.pool.filter(Boolean) : [];
    const pool = autoPool.length ? autoPool : [currentModel.value?.id].filter(Boolean);
    if (!pool.length) {
      if (!continueMode) state.draft = text;
      return toast('还没有可用模型：先到模型管理添加或启用一个模型（「先点」模式下还要选一个模型池）', 'warn', 5000);
    }

    if (!continueMode) pushMessage({ role: 'user', content: text, speaker: opts.fromSupervisor ? 'supervisor' : '' });
    const reply = { role: 'assistant', content: '', reasoning: '', steps: [], usage: null, model_name: '', unfinished: false };
    pushMessage(reply);
    const live = state.messages[state.messages.length - 1];
    live._startedAt = Date.now();
    // 新一轮：这一桶从零开始（旧的收尾值不许漏进来），并把界面换成它
    resetPerf(state.chatId);
    mirrorPerf();
    state.runningCmd = null;
    state.lastEventAt = Date.now();
    if (busyId) state.busyChats = { ...state.busyChats, [busyId]: true };

    const runId = state.chatId || 'tmp';
    // 这条流的归属句柄：handleEvent 每写一次界面那几格都要先问它「你还在屏幕上吗」。
    // 新建会话首轮那个 chat 帧会把它从 null 换成真实 id（并搬走 'tmp' 上的登记）。
    const ctx = { chatId: state.chatId || null };
    const st = openChatStream(
      {
        model_row_id: pool[0],
        pool,
        chat_id: state.chatId,
        project_id: state.chatId ? undefined : activeProject.value?.id || undefined,
        plan_mode: state.planMode,
        content: text,
        agent: state.agentMode,
        // 工作目录只在**新建会话**那一刻有用（服务端拿它给新行做种子）。已有会话一律以库里的
        // 会话行为准，请求体这份只是界面当时的显示 —— 切过会话后的过期值不能再去喂服务端
        // （他报的「自由会话切去某项目再切回，目录被那个项目同化」，第七十三轮 ①）。
        cwd: state.chatId ? undefined : (state.cwd || undefined),
        readonly: state.readonlyMode,
        // 只有用户为**这条会话**显式选过才发具体值；否则发空串 = 跟随全局，
        // 服务端就不会把会话行钉成一个前端缓存的旧值。
        approval_mode: state.approvalExplicit ? state.approvalMode : '',
        thinking_level: state.thinkingLevel || undefined,
        labs: readLabs(),
        continue: continueMode,
        speaker: opts.fromSupervisor ? 'supervisor' : undefined,
      },
      {
        onEvent: (evt) => handleEvent(evt, live, ctx),
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
    if ((finalKey || 'tmp') === (state.chatId || 'tmp')) state.runningCmd = null;
    // 本轮什么都没产出（例如服务端拒绝继续、连接立刻失败）→ 撤掉空气泡，把错误挂到上一条回复。
    // 要在**这条流自己那份**消息数组里做：人可能已经切到别的会话，state.messages 是别人的列表
    const ownerArr = state.msgBuf[finalKey] || state.msgBuf[runId] || state.messages;
    const liveIdx = ownerArr.indexOf(live);
    if (liveIdx >= 0 && !live.content.trim() && !(live.reasoning || '').trim() && !(live.steps || []).length) {
      const errText = live.errorText;
      ownerArr.splice(liveIdx, 1);
      if (errText) {
        let prev = null;
        for (let i = ownerArr.length - 1; i >= 0; i--) {
          if (ownerArr[i].role === 'assistant') { prev = ownerArr[i]; break; }
        }
        // 挂到上一条回复的红条上（那条才有「复制完整报错」的上下文）；没有上一条才直接弹 toast
        if (prev) prev.errorText = errText;
        else toast(errText, 'error', 5000, '', errReport({ message: errText }, errText, { where: '本轮流式中断', request: `POST /api/ai/chat chat=${finalKey || '(新会话)'}` }));
      }
    }
    if (busyId || finalKey) {
      const next = { ...state.busyChats };
      delete next[busyId];
      if (finalKey) delete next[finalKey];
      state.busyChats = next;
      // 这一场收工：把那一桶钉住（正常结束 done 已经钉过，settlePerf 自己会跳过；
      // 手动停止 / 断流没有 done 帧，就靠这里拿本场生成时长收尾）
      settlePerf(busyId);
      if (finalKey) settlePerf(finalKey);
      mirrorPerf();
    }
    await refreshTree();
    // 队列里属于这条会话的下一条：接着发（人已经切走时 flushQueue 自己会拦，不会把话发到别处）
    await flushQueue(finalKey || busyId);
    // 监工交棒过来的这一轮跑完了：等队列里的用户消息也发完，再回叫监工接下一棒
    if (opts.fromSupervisor) superviseStore.onMainDone();
  }

  function stop() {
    // 仅停当前会话的流
    const key = state.chatId || 'tmp';
    const cur = streams.get(key) || streams.get('tmp');
    cur?.abort();
    state.runningCmd = null;
    // 这条会话派出去、还在跑的分身也要一起停（他第七十五轮点的那条）。
    // 在跑的回合那边 SSE 一断，服务端 onAbort 已经会连带 killChat；但人工从右栏下发的任务
    // 根本没有这条连接，所以这里补一枪，别让主会话都停了分身还在烧额度
    const chatId = state.chatId;
    if (!chatId) return;
    const bucket = subagentsByChat[chatId];
    // 先就地标成「已被停止」再发请求：界面不该等着一趟网络才改脸色，
    // 而这一格本来就是屏幕上这条会话的镜像（stop() 只对当前会话生效）
    if (bucket) {
      for (const k of Object.keys(bucket)) {
        if (bucket[k].phase === 'start' || bucket[k].phase === 'tool') bucket[k] = { ...bucket[k], phase: 'killed' };
      }
      state.subagents = { ...bucket };
    }
    aiApi.killSubagentsByChat(chatId).catch(() => { /* 停不掉也别把「停止」这一步报错弹出来，连接本来就断了 */ });
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
            `Agent ${on(state.agentMode)} · Plan ${on(state.planMode)} · 只读 ${on(state.readonlyMode)} · `
            + `先点 ${uiPrefs.state.poolOn ? on(state.autoMode) : '关（实验室没开）'} · 审批 ${state.approvalMode}`,
            'info', 6000
          ), true;
        }
        if (switches[flag]) {
          const [key, label] = switches[flag];
          if (key === 'autoMode' && !uiPrefs.state.poolOn) {
            toast('多模型池「先点优先」已半废弃、默认关闭。要用请在 设置 → 实验室功能 → 多模型池 打开。', 'warn');
            return true;
          }
          const next = want === 'on' ? true : want === 'off' ? false : !state[key];
          await setModeFlag(key, next);
          toast(`${label}：${state[key] ? '开' : '关'}`, 'success');
          return true;
        }
        if (['strict', 'default', 'exempt', 'fullsend'].includes(flag)) {
          const before = state.approvalMode;
          await setApprovalMode(flag);
          // FULL-SEND 那条确认框被点了「取消」时值不会变，别 toast 成功
          if (state.approvalMode === before && flag !== before) return true;
          toast(`本会话审批模式：${{ strict: '严格', default: '默认', exempt: '免除', fullsend: 'FULL-SEND' }[flag]}`, 'success');
          return true;
        }
        return toast('用法：/mode [plan|auto|agent|readonly] [on|off|toggle]，或 /mode strict|default|exempt|fullsend', 'warn'), true;
      }
      case 'pool':
        // 多模型池已半废弃：实验室那道闸（pool_enabled）关着就不开选择器，只指路
        if (!uiPrefs.state.poolOn) {
          toast('多模型池「先点优先」已半废弃、默认关闭。要用请在 设置 → 实验室功能 → 多模型池 打开。', 'warn');
          return true;
        }
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
        // 监工已半废弃：实验室开关（supervisor_enabled）关着就不跑，也不去敲后端那条 403
        if (!uiPrefs.state.supervisorOn) {
          toast('AI 监工已半废弃、默认关闭。要用请在 设置 → 实验室功能 → AI 监工 打开。', 'warn');
          return true;
        }
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
        await setModeFlag('agentMode', false);
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

  /** 全局审批模式（控制台/设置页那三颗按钮管的那份）：启动时拉一次，新建会话显示它 */
  async function loadGlobalApproval() {
    try {
      const r = await aiApi.getApprovalMode();
      // 库里存的是原值。实验室总闸关着时 FULL-SEND 根本不生效（服务端也会把存量降回 default），
      // 界面不能写着一个没在跑的危险档 —— 显示必须等于生效值
      const raw = r?.mode || 'default';
      const masked = raw === 'fullsend' && !uiPrefs.state.fullSend ? 'default' : raw;
      state.approvalGlobal = masked;
      if (!state.approvalExplicit && !state.chatId) state.approvalMode = masked;
    } catch { /* 拿不到就沿用当前显示 */ }
  }

  /** 本会话显式选一个审批模式。会话还没 id（新会话没发过话）时先记在内存，第一条消息会把它落库 */
  async function setApprovalMode(mode) {
    if (!['strict', 'default', 'exempt', 'fullsend'].includes(mode)) return;
    // FULL-SEND 什么都不问，所以换上去之前必须让人看清跳过了什么（他定的口径：弹一次确认）
    if (mode === 'fullsend') {
      const okGo = await confirmDialog(
        'FULL-SEND 生效后，这一会话里的每一次操作都直接执行，不再弹审批卡。会一并跳过：\n'
        + '· 权限黑名单 / 关键词与工具黑名单\n'
        + '· 高权限底线（关机重启类命令、盘符与系统目录操作、全屏截取）\n'
        + '· Computer Use 的进程/窗口放行\n'
        + '· 项目根与工作目录边界（可以越级写到项目外的位置）\n'
        + '· MCP 未声明只读 / 自声明破坏性的确认\n\n'
        + '唯一还挡着的是 KHarness 自己的数据目录（主库 kh.db 里有真实密钥、日志、截图、撤销快照）。\n'
        + '随时可以在同一个下拉里切回「默认审批」。',
        { title: '切到 FULL-SEND', danger: true, okText: '切到这一档' }
      );
      if (!okGo) return;
    }
    const prev = { mode: state.approvalMode, explicit: state.approvalExplicit };
    state.approvalMode = mode;
    state.approvalExplicit = true;
    if (state.chatId) {
      // 写不成就把显示拉回原样：拦截图那边会弹出真实报错，这里只保证「屏幕上那格 = 库里真生效的那档」。
      // 以前是 catch 掉什么都不做 —— 后端不认这一档（老进程）或请求失败时，界面上还挂着 FULL-SEND，
      // 实际每条工具调用照旧弹审批，看着就是「切不到这一档」（第七十三轮 ④）。
      try {
        await aiApi.overrideApprovalMode(mode, state.chatId);
      } catch {
        state.approvalMode = prev.mode === mode ? (state.approvalGlobal || 'default') : prev.mode;
        state.approvalExplicit = prev.explicit;
      }
    }
  }

  /** 取消本会话的覆盖，回到跟随全局 */
  async function followGlobalApproval() {
    const before = { explicit: state.approvalExplicit, mode: state.approvalMode };
    state.approvalExplicit = false;
    state.approvalMode = state.approvalGlobal || 'default';
    if (state.chatId) {
      try {
        await aiApi.overrideApprovalMode('', state.chatId);
      } catch {
        // 没写成：会话行还留着它自己的覆盖值，显示就得跟着回去，否则屏幕上的档又和生效的档分家
        state.approvalExplicit = before.explicit;
        state.approvalMode = before.mode;
      }
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
    const r = await aiApi.updateChatSettings(state.chatId, {
      thinking_level: state.thinkingLevel || 'auto',
      temperature: state.temperature,
      frequency_penalty: state.frequency_penalty,
      presence_penalty: state.presence_penalty,
      context_limit: state.contextLimit || 0,
      censored_words: state.censoredWords || '',
    });
    // 以服务端算出的**生效值**为准（会话设定 → 模型上限 → 全局默认），界面不再显示「我刚敲的那个数」
    const eff = Number(r?.context_effective);
    if (Number.isInteger(eff)) state.contextLimit = eff;
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
    // 卡片一律先出队再报错：服务端那半边的挂起项可能已经超时删掉了（审批超时 / 换页断流 / 后端重启），
    // 这时请求回 404。以前 404 会抛出去、卡片一条不减，于是每次点都弹一版全量报错窗且永远点不掉。
    state.approvals = state.approvals.filter((x) => x.id !== p.id);
    try {
      await aiApi.approve({
        id: p.id,
        allow: okFlag,
        always,
        target: p.target || undefined,
        chat_id: p.chat_id || state.chatId,
      }, true);
    } catch (e) {
      if (e?.response?.status === 404) toast('该审批已超时或已结束，操作按拒绝处理', 'warn', 3000);
      else throw e;
    }
  }

  async function answerQuestion({ text, option, cancelled }) {
    const key = state.chatId || 'tmp';
    const q = state.questions[key];
    if (!q?.id) return;
    const body = { id: q.id, chat_id: q.chat_id || state.chatId };
    if (cancelled) body.cancel = true;
    else body.answer = String(text || option || '').trim();
    delete state.questions[key];
    try {
      await aiApi.answerQuestion(body, true);
    } catch (e) {
      if (e?.response?.status === 404) toast('该提问已超时或已结束，AI 会自行决定下一步', 'warn', 3000);
      else throw e;
    }
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

  /** 删掉某一条待注入提示词（服务端按现存列表回一份，前端不自己 splice —— 免得两边错位） */
  async function removeInsert(index) {
    if (!state.chatId) return;
    const d = await aiApi.removeInsert(state.chatId, index);
    if (d && Array.isArray(d.items)) state.insertItems = d.items;
    else await refreshSidecar(state.chatId);
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
    const chatId = state.chatId;
    const res = await aiApi.setCwd(path, chatId);
    // 服务端回的是**规范化后的绝对路径**，界面就显示它（人可能在这期间切了会话，别写给别人）
    if (state.chatId === chatId) state.cwd = res?.cwd || path;
  }

  /** 手动压缩（/press 与右栏那颗按钮共用）。
   *  进度看得见靠两件事：① 往消息流尾部插一张**本地**压缩卡，服务端 t:'compress' 的每个阶段
   *  就地改它（start 转圈 → done/skipped/failed），跑完 openChat 重拉时自然消失 —— 这一次压缩
   *  不属于任何一轮回复，没有消息可以挂，所以不落库；② state.pressing 让那颗按钮禁用 + 转圈，
   *  以前它连 disabled 都没有，90 秒里可以反复点。 */
  async function pressChat(modelRowId) {
    if (state.pressing) return;
    if (!state.chatId) return toast('还没有会话，没有历史可压缩', 'warn', 4000);
    const chatId = state.chatId;
    if (state.busyChats[chatId]) return toast('本轮还在生成，先停止再压缩', 'warn', 4000);
    state.pressing = true;
    // 这张卡要钉在**按下按钮那一刻所属的那份消息数组**上：中途切了会话，
    // state.messages 已经换成别条会话的列表，再按「列表最后一条」找卡片就会把压缩进度写进别人的消息里
    const msgArr = state.messages;
    msgArr.push({
      id: null, role: 'assistant', content: '', reasoning: '',
      steps: [{ type: 'compress', name: '压缩上下文', phase: 'start', manual: true, used: state.contextUsed, limit: state.contextLimit, percent: 0 }],
      timeline: null, usage: null, model_name: '', unfinished: false, local: true,
    });
    // 必须从响应式数组里取引用：直接改推进去的那个原始对象不会触发渲染（Vue 只代理拿到的那条路径），
    // 表现就是「进度条一直转、数字永远停在按下那一刻」—— 有用例守着（client/__tests__/press-progress.test.js）
    const card = () => msgArr[msgArr.length - 1]?.steps?.[0];
    let failed = '';
    let result = null;
    openPressStream({ chat_id: chatId, model_row_id: modelRowId || undefined }, {
      onEvent: (evt) => {
        if (evt.t !== 'compress') return;
        const c = card();
        if (c) Object.assign(c, evt);
        // 界面那一格用量只在「还在看这条会话」时跟着走，而且压完取的是压缩后的 after
        // （以前写的是 evt.used = 压缩**前**的量 —— 他报的「压完百分比一动不动」，第七十三轮 ②）
        if (state.chatId === chatId) {
          const shown = evt.phase === 'done' && Number(evt.after) > 0 ? Number(evt.after) : Number(evt.used);
          if (shown > 0) state.contextUsed = shown;
          if (Number(evt.limit) > 0) state.contextLimit = Number(evt.limit);
        }
        if (evt.phase === 'failed') failed = evt.message || '压缩失败';
        else result = evt;
      },
      // 校验类失败（没模型 / 会话不存在）服务端回的是 JSON，openStreamAt 会把它变成 onError
      onError: (e) => {
        failed = String(e?.message || e);
        const c = card();
        if (c) Object.assign(c, { phase: 'failed', message: failed });
      },
      onDone: async () => {
        state.pressing = false;
        if (state.chatId !== chatId) return;   // 中途切了会话：用量与消息都不许再动（别把那边的拉掉）
        if (result?.after != null) state.contextUsed = result.after;
        await openChat(chatId);
        if (failed) return toastErr(new Error(failed), '压缩失败');
        if (result?.phase === 'skipped') return toast(result.message || '没有可压缩的内容', 'warn');
        const arch = result?.archived ?? 0;
        const chars = result?.chars ?? 0;
        const after = result?.after;
        toast(`已压缩：归档 ${arch} 条、摘要 ${chars} 字${after != null ? `，上下文降到 ${after}/${state.contextLimit || '?'}` : ''}`, 'success', 6000);
        return undefined;
      },
    });
    return undefined;
  }

  async function setContext(limit) {
    if (!state.chatId) return toast('还没有会话，无法设定上下文窗口', 'warn', 4000);
    const chatId = state.chatId;
    // 窗口数字本地就能定：先立刻写进状态，右侧百分比当场按新分母重算。
    // 以前要等服务端那趟「设窗口 + 顺手压缩」（可能几十秒）回来才动，看着就像「没生效，得强刷」。
    state.contextLimit = limit;
    toast(`上下文窗口已设为 ${limit}，正在压缩较早的历史…`, 'info', 4000);
    let d = null;
    try {
      d = await aiApi.setContext({ chat_id: chatId, limit });
    } catch (e) {
      return toastErr(e, '设定上下文窗口失败');
    }
    // 回来时人可能已经切走了：这两格属于按下按钮那条会话，别写到别人身上
    if (state.chatId === chatId) {
      if (d && d.limit != null) state.contextLimit = d.limit;
      if (d && d.used != null) state.contextUsed = d.used;
    }
    if (d && d.compressed) {
      if (state.chatId !== chatId) return;
      await openChat(chatId);   // 压过了：历史条数变了，不重拉一遍界面还是旧的
      if (d.compressed.error) toastErr(new Error(d.compressed.error), '窗口已改，但压缩失败');
      else toast('窗口已更新，并压缩了一轮历史', 'success');
    }
  }

  async function updateTask(id, patch) {
    await aiApi.updateTask(id, patch);
    await refreshTasks(state.chatId);
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
    currentQuestion,
    queued,
    refreshTree,
    toggleProjectOpen,
    refreshModels,
    refreshTasks,
    openChat,
    newProject,
    editProject,
    newChat,
    removeChat,
    renameChat,
    pinChat,
    openInExplorer,
    send,
    stop,
    // SSE 事件分发器：正常只有 send() 内部在调，导出是为了给测试直接灌事件序列
    // （#243 那条「思考被 note 切成两段」只能从这一层验）
    handleEvent,
    undo,
    decideApproval,
    answerQuestion,
    setThinkingLevel,
    loadGlobalApproval,
    setApprovalMode,
    setModeFlag,
    followGlobalApproval,
    saveModelParams,
    persistModel,
    applyChatMeta,   // 会话行 → 界面那一份应用（两条打开路径共用，测试也直接打它）
    toggleModelPin,
    addInsert,
    clearInserts,
    removeInsert,
    saveSkills,
    setCwd,
    pressChat,
    setContext,
    updateTask,
    filesFromMessages,
    historyFromMessages,
  };
}
