/**
 * 「调试」板块的前端事实源（第六十四轮，仅开发版）。
 *
 * 为什么用 EventSource 而不是轮询：这扇窗要的是「刚打印的那一行立刻出现」，
 * 3 秒一轮会把一屏内容切成好几段刷上来，反而看不出时序。服务端那条流空闲时只发注释心跳，
 * 断线自己按 retry: 2000 重连。
 *
 * 关闭时把连接摘掉：他不看日志的时候，这个页面不该一直挂着一条 SSE。
 */
import { computed, reactive } from 'vue';
import { addErrLogSink } from '../utils/errlog';

const MAX = 2000;

const state = reactive({
  dev: false,        // 版本号结尾带 d 才算开发版（App.vue 拉 app-info 时定，判据只有一处）
  version: '',
  open: false,
  connected: false,
  paused: false,     // 暂停跟随：想看上面某一行时不能被新日志顶走
  showHb: false,     // 轮询/SSE 这类心跳行，默认不显示
  filter: 'all',     // all | op | net | warn | error
  lines: [],         // { id, at, level, tag, text, ms }
});

let es = null;
let localSeq = 0;
let detachWebLog = null;
// 快照与实时流会重几条（订阅那刻服务端把历史也发一遍），按 id 去重；
// 环形淘汰时把对应 id 一起摘掉，这个集合才不会一直长。
const ids = new Set();

function pushLine(line) {
  if (!line || !line.text) return;
  if (ids.has(line.id)) return;
  ids.add(line.id);
  state.lines.push(line);
  if (state.lines.length > MAX) {
    const dropped = state.lines.splice(0, state.lines.length - MAX);
    for (const d of dropped) ids.delete(d.id);
  }
}

/** 客户端自己报的那些（请求失败、未捕获异常）并进来，tag 标 web 好区分来源 */
function onWebLog(rec) {
  if (!state.open) return;
  const level = rec.kind === 'error' ? 'error' : rec.kind === 'net' ? 'warn' : 'info';
  pushLine({
    id: `w${++localSeq}`,
    at: rec.at,
    level,
    tag: 'web',
    ms: 0,
    text: `${rec.where ? rec.where + ' · ' : ''}${rec.summary}${rec.detail ? ` ｜ ${rec.detail.replace(/\s+/g, ' ').slice(0, 220)}` : ''}`,
  });
}

/** 前端模块自己报的一行（性能采样这类），不受「窗口开没开」影响先进环形缓冲留着 */
function pushLocal(tag, text, level = 'info') {
  pushLine({ id: `l${++localSeq}`, at: new Date().toISOString().replace('T', ' ').slice(0, 19), level, tag, ms: 0, text });
}

function connect() {
  if (es || typeof EventSource === 'undefined') return;
  es = new EventSource('/api/debug/logs/stream');
  es.onopen = () => { state.connected = true; };
  es.onerror = () => { state.connected = false; };   // 浏览器会按服务端 retry 自己重连
  es.onmessage = (ev) => {
    let j = null;
    try { j = JSON.parse(ev.data); } catch (e) { return; }
    if (j?.t === 'hello') { state.connected = true; state.version = j.version || state.version; return; }
    if (j?.t === 'log') pushLine(j.line);
  };
}

function disconnect() {
  if (es) { try { es.close(); } catch (e) { /* 已经关了 */ } es = null; }
  state.connected = false;
}

async function open() {
  state.open = true;
  if (!detachWebLog) detachWebLog = addErrLogSink(onWebLog);
  try {
    const { aiApi } = await import('../api');
    const r = await aiApi.debugLogs(800);
    for (const line of (r?.lines || [])) pushLine(line);
    state.version = r?.version || state.version;
  } catch (e) { /* 正式版或后端没起来：窗照样开，只是空的 */ }
  connect();
}

function close() {
  state.open = false;
  disconnect();
  if (detachWebLog) { detachWebLog(); detachWebLog = null; }
}

async function clear() {
  state.lines.splice(0, state.lines.length);
  ids.clear();          // 服务端重新发同一批时要认得出来不是重复
  try {
    const { aiApi } = await import('../api');
    await aiApi.debugLogsClear();
  } catch (e) { /* 清不掉也只是本地清了 */ }
}

const isHb = (l) => l.tag === 'hb';

const visible = computed(() => state.lines.filter((l) => {
  if (isHb(l) && !state.showHb) return false;
  const f = state.filter;
  if (f === 'all') return true;
  if (f === 'error') return l.level === 'error';
  if (f === 'warn') return l.level === 'warn' || l.level === 'error';
  if (f === 'net') return l.tag === 'http' || l.tag === 'up';
  if (f === 'op') return l.tag === 'op' || l.tag === 'web';
  return true;
}));

const counts = computed(() => {
  const c = { all: 0, op: 0, net: 0, warn: 0, error: 0, hb: 0 };
  for (const l of state.lines) {
    c.all++;
    if (isHb(l)) c.hb++;
    else if (l.tag === 'http' || l.tag === 'up') c.net++;
    else c.op++;
    if (l.level === 'error') c.error++;
    else if (l.level === 'warn') c.warn++;
  }
  return c;
});

/** 复制走的全文：与屏幕上筛出来的一致（他复制的就是他看见的那些） */
function textOf(list) {
  return list.map((l) => `${l.at} [${l.level}/${l.tag}]${l.ms ? ` ${l.ms}ms` : ''} ${l.text}`).join('\n');
}

/**
 * 「调试」板块只在开发版出现，判据就一条：关于页上那串版本号结尾带 d。
 * 不在这里再问一遍环境变量 —— 界面显示的和他点到的必须是同一件事。
 */
export function readAppInfoForDev() {
  return import('../api').then(({ settingsApi }) => settingsApi.appInfo())
    .then((i) => {
      const display = String(i?.display || '');
      debugLog.setDev(display.endsWith('d'), display);
      return !!i;
    })
    .catch(() => false);
}

export const debugLog = {
  state,
  visible,
  counts,
  open,
  close,
  clear,
  textOf,
  pushLocal,
  setDev: (flag, version) => {
    state.dev = !!flag;
    if (version) state.version = version;
    // 只有开发版才挂性能采样（正式版一个字都不多跑）。动态 import：perfwatch 反过来要往这里报行，
    // 静态互相引用会变成循环依赖，模块初始化顺序就不好看了。
    if (flag) import('./perfwatch').then((m) => m.startPerfWatch()).catch(() => { /* 采样挂了不影响用 */ });
  },
};
