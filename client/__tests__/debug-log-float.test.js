/**
 * ⑥「调试」板块的客户端这一层（第六十四轮）。
 *
 * 挂真 LogFloat + 真 store，喂假 EventSource 与假快照接口。盯四件容易静默坏掉的事：
 * 关窗没把 SSE 摘掉（页面一直挂着一条流）、快照与实时流重发同一批会显示两遍、
 * 心跳行把真操作刷出屏、正式版误开这扇窗。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, nextTick } from 'vue';
import { h } from 'vue';
import LogFloat from '../src/ui/LogFloat.vue';
import { debugLog, readAppInfoForDev } from '../src/stores/debuglog';
import { logErr } from '../src/utils/errlog';

let snapshot;
let clearCalls;

class FakeEventSource {
  constructor(url) { this.url = url; this.closed = false; FakeEventSource.last = this; }
  close() { this.closed = true; }
  emit(obj) { this.onmessage({ data: JSON.stringify(obj) }); }
}

vi.mock('../src/api', () => ({
  aiApi: {
    debugLogs: async () => ({ lines: snapshot.lines, total: snapshot.lines.length, version: snapshot.version }),
    debugLogsClear: async () => { clearCalls++; return { total: 0 }; },
  },
  settingsApi: {
    get: async () => ({}),
    update: async () => ({}),
    appInfo: async () => ({ version: snapshot.version, display: snapshot.display, packaged: snapshot.packaged }),
  },
}));

function line(over) {
  return { id: over.id, at: '2026-10-11 13:20:31', level: 'info', tag: 'op', text: '一行', ms: 0, ...over };
}

let inst = null;
async function mountFloat() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp({ render: () => h(LogFloat) });
  app.mount(host);
  inst = { app, host };
  await nextTick();
}

function rows() {
  return [...document.querySelectorAll('.logfloat .lf-line')].map((el) => el.textContent.replace(/\s+/g, ' ').trim());
}
const settle = () => nextTick().then(() => nextTick());

beforeEach(async () => {
  snapshot = {
    version: '1.3.5d', display: '1.3.5d', packaged: false,
    lines: [
      line({ id: 1, tag: 'op', text: '[mcp] browser 已连接，12 个工具' }),
      line({ id: 2, tag: 'http', text: 'GET /api/settings → 200', ms: 12 }),
      line({ id: 3, tag: 'hb', text: 'GET /api/ai/browser/poll → 200', ms: 25000 }),
      line({ id: 4, tag: 'up', level: 'warn', text: '上游 agnes（api.x.com）→ HTTP 429', ms: 30 }),
      line({ id: 5, tag: 'up', level: 'error', text: '上游 agnes（api.x.com）失败：socket hang up', ms: 45 }),
    ],
  };
  clearCalls = 0;
  globalThis.EventSource = FakeEventSource;
  Object.assign(debugLog.state, { dev: true, open: false, paused: false, showHb: false, filter: 'all', connected: false, version: '' });
  await debugLog.clear();     // 走 store 自己的清空：连内部那份「已见过的 id」一起归零，否则上个用例的 id 会把这个用例的行吃掉
  clearCalls = 0;
});

afterEach(() => {
  debugLog.close();
  if (inst) { inst.app.unmount(); inst.host.remove(); inst = null; }
  document.querySelectorAll('.logfloat').forEach((n) => n.remove());
});

describe('日志悬浮窗', () => {
  it('开一次：拉快照 + 建通道，默认把心跳行藏起来', async () => {
    await mountFloat();
    await debugLog.open();
    await settle();
    expect(debugLog.state.open).toBe(true);
    expect(FakeEventSource.last.url).toBe('/api/debug/logs/stream');
    expect(debugLog.state.lines.length).toBe(5);           // 缓冲里是全集
    expect(document.querySelectorAll('.logfloat .lf-line').length).toBe(4);   // 屏幕上少了心跳那条
    expect(rows().join(' ')).not.toContain('browser/poll');
    expect(document.querySelector('.logfloat .lf-ver').textContent).toContain('1.3.5d');
  });

  it('勾上「心跳」才显示轮询行；筛「报错」只剩 error 那一条', async () => {
    await mountFloat();
    await debugLog.open();
    debugLog.state.showHb = true;
    await settle();
    expect(document.querySelectorAll('.logfloat .lf-line').length).toBe(5);
    debugLog.state.filter = 'error';
    await settle();
    const r = rows();
    expect(r.length).toBe(1);
    expect(r[0]).toContain('socket hang up');
    expect(r[0]).toContain('45ms');
  });

  it('实时流重发快照里已有的行不会显示两遍；新 id 才落进来', async () => {
    await mountFloat();
    await debugLog.open();
    const es = FakeEventSource.last;
    es.emit({ t: 'hello', version: '1.3.5d', total: 5 });
    es.emit({ t: 'log', line: line({ id: 2, tag: 'http', text: 'GET /api/settings → 200', ms: 12 }) });
    es.emit({ t: 'log', line: line({ id: 6, tag: 'op', text: '刚打的一行' }) });
    await settle();
    expect(debugLog.state.lines.filter((l) => l.id === 2).length).toBe(1);
    expect(debugLog.state.lines.map((l) => l.id)).toContain(6);
    expect(debugLog.state.version).toBe('1.3.5d');
  });

  it('客户端自己报的错并到同一列，标成 web；关窗后不再往里塞', async () => {
    await mountFloat();
    await debugLog.open();
    logErr({ kind: 'error', where: 'GET /ai/browser/poll', summary: '请求失败', detail: 'AxiosError: timeout of 90000ms exceeded' });
    await settle();
    const web = debugLog.state.lines.filter((l) => l.tag === 'web');
    expect(web.length).toBe(1);
    expect(web[0].text).toContain('timeout of 90000ms');
    expect(rows().join(' ')).toContain('web');

    debugLog.close();
    expect(FakeEventSource.last.closed).toBe(true);
    logErr({ kind: 'error', summary: '关窗之后的一条' });
    expect(debugLog.state.lines.some((l) => String(l.text).includes('关窗之后的一条'))).toBe(false);
  });

  it('清空把本地与后端一起清掉', async () => {
    await mountFloat();
    await debugLog.open();
    await debugLog.clear();
    expect(clearCalls).toBe(1);
    expect(debugLog.state.lines.length).toBe(0);
  });

  it('复制走的文本与屏幕上筛出来的一致（含时间/级别/标签/耗时）', async () => {
    await mountFloat();
    await debugLog.open();
    debugLog.state.filter = 'net';
    await settle();
    const txt = debugLog.textOf(debugLog.visible.value);
    const lines = txt.split('\n');
    expect(lines.length).toBe(debugLog.visible.value.length);
    expect(txt).toContain('13:20:31');
    expect(txt).toContain('[info/http] 12ms');
    expect(txt).not.toContain('browser/poll');   // 心跳不算网络，且不显示就不该被复制走
  });
});

describe('开发版判定（判据=版本号结尾带 d）', () => {
  it('带 d 才算开发版，正式版把开关拨回去', async () => {
    expect(await readAppInfoForDev()).toBe(true);
    expect(debugLog.state.dev).toBe(true);
    expect(debugLog.state.version).toBe('1.3.5d');
    snapshot = { ...snapshot, version: '1.3.5', display: 'v1.3.5', packaged: true };
    expect(await readAppInfoForDev()).toBe(true);
    expect(debugLog.state.dev).toBe(false);
    expect(debugLog.state.version).toBe('v1.3.5');
  });
});
