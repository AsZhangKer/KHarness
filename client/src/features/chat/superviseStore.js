// AI 监工的界面状态：右栏「监工」那一页 = 一个三行控制台（选模型 / 说话 / 发送·停止）
// 加上它自己的对话记录。监工跑在服务端（server/utils/orchestrator.js），这里只是遥控器。
//
// 分工：监工自己的话留在本面板；它下发给主智能体的命令、以及主智能体的回话，
// 通过 mainSink 交给 chatStore 画进主会话流（用户要看见「监工替我说了什么」）。
// 下面还保留着手动的「验收清单」那一套（跑 kh.checks.md），它是监工的一件工具，也能单独用。
import { reactive } from 'vue';
import { aiApi } from '../../api';
import { toast } from '../../stores/toast';
import { openSuperviseStream, openHostedStream } from './chatStream';

const state = reactive({
  loading: false,
  running: false,
  file: '',
  exists: false,
  cases: [],          // 清单里解析出的用例（预览用）
  parseErrors: [],
  template: '',
  results: [],        // 本轮结果：{ idx, name, status:'run'|'pass'|'fail', checks, shot, diag, ms }
  summary: null,      // { total, passed, failed, ms, report }
  error: '',
  startedAt: 0,
  focusSeq: 0,        // 自增一下，让 ChatDock 切到「监工」页
  /** 托管控制台：kind = user(你说的) | sup(监工) | cmd(下发给主智能体) | note | case | plan | report */
  sup: {
    model: Number(localStorage.getItem('nu_sup_model')) || 0,
    draft: '',
    running: false,          // 监工那一轮正在出字
    waiting: false,          // 已交棒，等主智能体跑完回叫
    auto: true,              // 自动往复：主智能体跑完就自动再叫监工
    chatId: 0,
    workerModel: 0,          // 交棒给主智能体时用哪个模型（开场定，回叫沿用）
    turns: [],
    error: '',
  },
});

/**
 * chatStore 挂上来的桥：交棒后的命令由它用普通 /chat 发出去（这样主会话的停止、审批、
 * 撤销、队列都照常工作），以及必要时替我们掐掉主智能体那一轮。
 */
let mainBridge = null;
function setMainBridge(b) { mainBridge = b; }

let turnSeq = 0;
const nextTurnId = () => `t${++turnSeq}`;

let stream = null;

function focus() { state.focusSeq += 1; }

async function loadChecks(chatId) {
  state.loading = true;
  try {
    const d = await aiApi.superviseChecks(chatId) || {};
    state.exists = !!d.exists;
    state.file = d.file || '';
    state.cases = d.cases || [];
    state.parseErrors = d.errors || [];
    state.template = d.template || '';
    state.error = '';
  } catch (e) {
    state.error = String(e?.message || e);
  } finally {
    state.loading = false;
  }
}

function stop() {
  if (!stream) return;
  stream.abort();
  stream = null;
  state.running = false;
  toast('已停止：剩下的用例不再跑', 'warn');
}

function run({ chatId, modelRowId, diagnose = true } = {}) {
  if (state.running) return toast('监工正在跑这一轮', 'warn');
  focus();
  state.error = '';
  state.summary = null;
  state.results = state.cases.map((c, idx) => ({ idx, name: c.name, status: 'wait', checks: [], shot: '', diag: '', ms: 0 }));
  state.running = true;
  state.startedAt = Date.now();

  stream = openSuperviseStream({ chat_id: chatId || 0, model_row_id: modelRowId || undefined, diagnose }, {
    onEvent: (evt) => {
      const t = evt && evt.t;
      // 事件对象要整体换掉：原地改字段不会触发重渲染
      const at = (idx) => state.results.findIndex((r) => r.idx === idx);
      const patch = (idx, fields) => {
        const i = at(idx);
        if (i >= 0) state.results[i] = { ...state.results[i], ...fields };
        else state.results.push({ idx, name: '', status: 'wait', checks: [], shot: '', diag: '', ms: 0, ...fields });
      };
      if (t === 'start') {
        state.file = evt.file || state.file;
        state.exists = true;
        state.parseErrors = evt.errors || [];
        state.results = (evt.cases || state.cases).slice(0, evt.total).map((c, idx) => ({ idx, name: c.name, status: 'wait', checks: [], shot: '', diag: '', ms: 0 }));
      } else if (t === 'case_start') {
        patch(evt.idx, { name: evt.name, status: 'run' });
      } else if (t === 'case_done') {
        patch(evt.idx, { name: evt.name, status: evt.ok ? 'pass' : 'fail', checks: evt.checks || [], shot: evt.shot || '', ms: evt.ms || 0 });
      } else if (t === 'done') {
        state.running = false;
        stream = null;
        state.summary = { total: evt.total, passed: evt.passed, failed: evt.failed, ms: evt.ms, report: evt.report, stopped: !!evt.stopped };
        // 收尾时按服务端给的完整结果重建一遍：漏收 case_done 也不会停在「进行中」
        if (Array.isArray(evt.cases)) {
          state.results = evt.cases.map((c) => ({
            idx: c.idx, name: c.name, status: c.ok ? 'pass' : 'fail',
            checks: c.checks || [], shot: c.shot || '', diag: c.diag || '', ms: c.ms || 0,
          }));
        }
        if (evt.failed) toast(`监工：${evt.failed} 项没通过`, 'error');
        else if (evt.total) toast(`监工：${evt.total} 项全过`, 'success');
      } else if (t === 'error') {
        state.error = String(evt.message || '跑不起来');
        state.running = false;
        stream = null;
      }
    },
    onError: (e) => {
      state.error = String(e?.message || e);
      state.running = false;
      stream = null;
    },
    onAbort: () => { state.running = false; stream = null; },
    onDone: () => { state.running = false; stream = null; },
  });
}

/** 把失败项打包成一条临时指示交给主 Agent（在下一个工具边界注入，不打断当前动作） */
async function handToMain(chatId) {
  if (!chatId) return toast('还没有主会话', 'warn');
  const bad = state.results.filter((r) => r.status === 'fail');
  if (!bad.length) return toast('这一轮没有失败项', 'warn');
  const lines = bad.map((r) => {
    const why = (r.checks || []).filter((k) => !k.ok).map((k) => `${k.kind}${k.detail ? '（' + k.detail.split('\n')[0] + '）' : ''}`).join('；');
    return `- ${r.name}：${why}${r.diag ? `\n  可能原因：${r.diag}` : ''}${r.shot ? `\n  证据截图：${r.shot}` : ''}`;
  });
  const text = `【监工报告 · ${new Date(state.startedAt).toLocaleString('zh-CN')}】以下 ${bad.length} 项验收没通过，请逐条排查并修好，改完再跑一轮监工：\n${lines.join('\n')}`;
  const r = await aiApi.addInsert(chatId, text).catch(() => null);
  if (r) toast(`已把 ${bad.length} 项失败交给主对话`, 'success');
}

/* ---------------- 托管控制台：跟监工说话 ---------------- */

let supStream = null;

function pushTurn(turn) {
  state.sup.turns.push({ id: nextTurnId(), steps: [], ...turn });
  return state.sup.turns[state.sup.turns.length - 1];
}

function endSupTurn(live) {
  if (!live) return;
  live.streaming = false;
  if (!String(live.text || '').trim() && !live.steps.length) {
    const i = state.sup.turns.indexOf(live);
    if (i >= 0) state.sup.turns.splice(i, 1);
  }
}

/** 监工那一轮结束后要不要立刻交棒给主智能体；交棒命令暂存在这里 */
let pendingHandoff = null;

function onSupEvent(evt, live) {
  const t = evt && evt.t;
  if (!t) return;
  if (t === 'delta') { live.text += evt.text || ''; return; }
  if (t === 'tool') { live.steps.push({ type: 'tool', name: evt.name, args: evt.args }); return; }
  if (t === 'tool_result') { live.steps.push({ type: 'result', name: evt.name, ok: evt.ok, preview: evt.preview }); return; }
  if (t === 'note') { live.steps.push({ type: 'note', message: evt.message || evt.text || '' }); return; }
  if (t === 'handoff') {
    pendingHandoff = { title: evt.title, command: evt.command };
    pushTurn({ kind: 'cmd', title: evt.title, text: evt.command });
    return;
  }
  if (t === 'plan') { pushTurn({ kind: 'plan', items: evt.items || [] }); return; }
  if (t === 'supervise_case') { pushTurn({ kind: 'case', name: evt.name, ok: evt.ok }); return; }
  if (t === 'report') { pushTurn({ kind: 'report', text: evt.path || '' }); return; }
  if (t === 'error') { state.sup.error = String(evt.message || '监工报错'); return; }
  if (t === 'done') {
    if (evt.finished && !String(live.text || '').trim()) live.text = String(evt.finished.summary || '');
    endSupTurn(live);
    return;
  }
}

/**
 * 跑监工的一轮。relay=true 表示「主智能体刚跑完，回叫它接着判断」（服务端不落新的用户消息）。
 * 一轮结束：有 handoff 就交棒给主智能体；否则这一场到此为止，等用户再说话。
 */
function runOnce({ chatId, workerModel, content = '', relay = false } = {}) {
  state.sup.chatId = chatId;
  if (workerModel) state.sup.workerModel = workerModel;   // 回叫时沿用同一个主智能体模型
  state.sup.error = '';
  state.sup.running = true;
  state.sup.waiting = false;
  pendingHandoff = null;
  const live = pushTurn({ kind: 'sup', text: '', streaming: true });
  focus();
  const finishStream = () => {
    state.sup.running = false;
    supStream = null;
    endSupTurn(live);
    if (pendingHandoff && state.sup.auto) {
      const hand = pendingHandoff;
      pendingHandoff = null;
      state.sup.waiting = true;                 // 主智能体在干活，跑完 onMainDone 再回叫
      mainBridge?.send(hand.command);
    } else if (state.sup.waiting) {
      state.sup.waiting = false;
    }
  };
  supStream = openHostedStream(
    { chat_id: chatId, content, relay, supervisor_model: state.sup.model || undefined, worker_model: state.sup.workerModel || undefined },
    {
      onEvent: (evt) => onSupEvent(evt, live),
      onError: (e) => { state.sup.error = String(e?.message || e); finishStream(); },
      onAbort: finishStream,
      onDone: finishStream,
    },
  );
  return true;
}

/** 主智能体那一轮跑完（由 chatStore 回调）：把监工再叫起来接下一棒 */
function onMainDone() {
  if (!state.sup.waiting) return;
  state.sup.waiting = false;
  if (!state.sup.auto) return;
  runOnce({ chatId: state.sup.chatId, relay: true });
}

function say({ chatId, workerModel } = {}) {
  const text = String(state.sup.draft || '').trim();
  if (!text) return toast('先写下要交给监工的话', 'warn');
  if (state.sup.running || state.sup.waiting) return toast('监工这一场还在跑，先按停止', 'warn');
  if (!chatId) return toast('监工要往当前会话下发命令，先选中一个会话', 'warn');
  state.sup.draft = '';
  state.sup.auto = true;
  pushTurn({ kind: 'user', text });
  return runOnce({ chatId, workerModel, content: text });
}

/**
 * 停止 = 三段一起掐：监工那一轮的 SSE、交棒后主智能体那一轮、以及「跑完自动回叫」的意图。
 * 上一版只掐了第一条，主智能体还在服务端继续跑，看起来就是「按了停止没反应」。
 */
function stopSay() {
  state.sup.auto = false;
  const wasWaiting = state.sup.waiting;
  pendingHandoff = null;
  state.sup.waiting = false;
  if (supStream) {
    supStream.abort();
    supStream = null;
  }
  state.sup.running = false;
  if (wasWaiting) mainBridge?.stop();
  toast(wasWaiting ? '已停止：监工和主智能体都掐了' : '已停止监工这一轮', 'warn');
}

function clearTurns() { state.sup.turns.splice(0, state.sup.turns.length); state.sup.error = ''; }

function setSupModel(id) {
  state.sup.model = Number(id) || 0;
  try { localStorage.setItem('nu_sup_model', String(state.sup.model)); } catch { /* 存不上就算了 */ }
}

/**
 * 重开对话 / 切会话时把监工面板的历史捞回来：监工的话本来就落在主会话里
 * （assistant + speaker=supervisor），命令是 user + speaker=supervisor，
 * 用户在面板里输入的原话是普通 user 消息。主智能体的回复不搬进来 —— 它就在主流里。
 */
let turnsReq = 0;
async function loadTurns(chatId) {
  const mine = ++turnsReq;
  if (!chatId) { state.sup.turns.splice(0, state.sup.turns.length); return; }
  if (state.sup.running) return;                       // 正在跑就别覆盖现场
  const d = await aiApi.getChat(chatId).catch(() => null);
  if (!d || mine !== turnsReq || state.sup.running) return;   // 期间又切了会话就丢掉这次结果
  state.sup.chatId = Number(chatId);
  const turns = [];
  for (const m of (d.messages || [])) {
    const sp = m.speaker;
    if (m.role === 'user' && sp === 'supervisor') {
      const t = /^【监工指令 · (.+?)】/.exec(String(m.content || ''));
      turns.push({ id: nextTurnId(), kind: 'cmd', title: t ? t[1] : '', text: m.content, steps: [] });
    } else if (m.role === 'user') {
      turns.push({ id: nextTurnId(), kind: 'user', text: m.content, steps: [] });
    } else if (m.role === 'assistant' && sp === 'supervisor') {
      turns.push({
        id: nextTurnId(), kind: 'sup', text: m.content || '', streaming: false,
        steps: Array.isArray(m.steps) ? m.steps : [],
      });
    }
  }
  state.sup.turns.splice(0, state.sup.turns.length, ...turns.slice(-40));
}

export const superviseStore = {
  state, loadChecks, run, stop, handToMain, focus,
  say, stopSay, clearTurns, setSupModel, setMainBridge, onMainDone, loadTurns,
};
