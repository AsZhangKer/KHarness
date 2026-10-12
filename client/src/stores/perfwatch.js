/**
 * 开发版内置的性能自采样（第七十七轮）。
 *
 * 为什么要放进界面里跑而不是我这边量：我这边那份隔离实例怎么压都量不到他报的掉帧
 * （读数：帧 p95 6ms、最差 19ms、longtask 0 次 —— 见 _tmp_kh77/perf_probe.js）。
 * 也就是说「有一个会话在回答就掉帧」这件事依赖他机器上我复现不了的那部分：真的会话体量、真的模型出字速度、
 * 真的多窗口/多项目同开。所以这里把探针装进 1.3.5d 里：他正常干活，日志悬浮窗自己记读数，
 * 卡的时候把那一行抄给我就是证据 —— 省掉「猜一个改一个」那一轮。
 *
 * 只在开发版挂（debuglog.setDev 里判版本号带 d），正式版这个 chunk 连加载都不会加载。
 */
import { debugLog } from './debuglog';

const WINDOW_MS = 10000;

let started = false;
let gaps = [];
let last = 0;
let lt = [];
let rafOn = false;

function frameTick(t) {
  if (last) gaps.push(Math.round(t - last));
  last = t;
  if (rafOn) requestAnimationFrame(frameTick);
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

function report() {
  const md = window.__khRenderStats;
  const dropped = gaps.filter((g) => g > 32).length;
  const busy = !!md && md.md > 0;
  const work = dropped > 0 || lt.length > 0 || busy;
  // 空转就不报：12 行/分钟会把真正有用的那几行挤出环形缓冲
  if (work) {
    const streaming = !!document.querySelector('.caret-dot');
    debugLog.pushLocal('perf', [
      `10s 采样：帧 ${gaps.length} 张 p95 ${pct(gaps, 0.95)}ms 最差 ${gaps.length ? Math.max(...gaps) : 0}ms 掉帧(>32ms) ${dropped}`,
      `｜ longtask ${lt.length} 次/${lt.reduce((a, b) => a + b, 0)}ms${lt.length ? ` 最差 ${Math.max(...lt)}ms` : ''}`,
      md ? `｜ markdown 渲染 ${md.md} 次(缓存命中 ${md.hit}/未命中 ${md.miss})` : '',
      `｜ DOM ${document.querySelectorAll('*').length} 节点/消息流 ${document.querySelectorAll('.stream-inner .msg').length} 条`,
      `｜ ${streaming ? '正在流式输出' : '没在流式'}`,
    ].join(' '), dropped > 0 || lt.length > 0 ? 'warn' : 'info');
  }
  gaps = [];
  lt = [];
  if (md) { md.md = 0; md.hit = 0; md.miss = 0; }
}

export function startPerfWatch() {
  if (started || typeof window === 'undefined' || !window.requestAnimationFrame) return;
  started = true;
  window.__khPerf = { on: true };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) lt.push(Math.round(e.duration));
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) { /* 内核不支持 longtask 就只报帧与渲染数 */ }
  rafOn = true;
  requestAnimationFrame(frameTick);
  setInterval(report, WINDOW_MS);
  debugLog.pushLocal('perf', '性能采样已挂上：每 10 秒在出现掉帧/长任务/渲染活动时记一行（空转不记，免得挤掉别的日志；环形缓冲留最近 2000 行）');
}
