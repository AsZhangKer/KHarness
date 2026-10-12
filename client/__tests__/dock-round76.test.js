/**
 * 第七十六轮 ⑤⑥⑦：右栏子智能体与修改历史这两块的前端形状。
 *
 * 他点名的三件事都在这里量，不看源码猜：
 *   · 子智能体一行一路，只有名称 + 一颗红/绿点；名称不许换行（超出省略号）；点开=步骤弹窗，右键=停止/删除；
 *   · 人工派发那张卡整个拿掉（侧栏不再替人派活）；
 *   · 修改历史标题只显文件名、第二行才是路径，「展开」改成「审阅」，弹窗里是彩色 diff + 那颗红色撤销。
 *
 * 夹具坑照抄第七十五轮那份：KModal / 右键菜单都是 Teleport 到 document.body，
 * 断言要看整棵 body；卸载必须逐个来，漏一个就带着 5s 轮询活到下一个用例。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, h, nextTick } from 'vue';

const CHAT = 42;

const { fx, calls } = vi.hoisted(() => ({
  fx: { agents: [] },
  calls: { del: [], kill: [], confirm: [] },
}));

vi.mock('../src/api', () => ({
  aiApi: new Proxy({}, {
    get: (t, k) => (...a) => {
      if (k === 'getSubagents') return Promise.resolve(fx.agents);
      if (k === 'deleteSubagent') { calls.del.push(a); return Promise.resolve({ message: '已删除' }); }
      if (k === 'killSubagent') { calls.kill.push(a); return Promise.resolve({ message: '已请求停止' }); }
      if (k === 'getChat') return Promise.resolve({ chat: {}, messages: [], tasks: [], usage: {} });
      if (k === 'getBackground') return Promise.resolve({ tasks: [], hidden: 0 });
      return Promise.resolve(k === 'getProjects' || k === 'getChats' || k === 'getTasks' ? [] : null);
    },
  }),
  settingsApi: { getAll: () => Promise.resolve({}), update: () => Promise.resolve({}), appInfo: () => Promise.resolve({}) },
}));
vi.mock('../src/stores/toast', () => ({ toast: () => {} }));
vi.mock('../src/stores/confirm', () => ({
  confirmDialog: (text) => { calls.confirm.push(text); return Promise.resolve(true); },
}));
vi.mock('../src/features/chat/chatStream', () => ({
  openChatStream: () => ({ abort() {}, done: new Promise(() => {}) }),
  openPressStream: () => ({ abort() {}, done: Promise.resolve() }),
}));

const ChatDock = (await import('../src/features/chat/ChatDock.vue')).default;
const HistoryReviewModal = (await import('../src/features/chat/HistoryReviewModal.vue')).default;

const alive = [];
/** 只挂这个组件真正会发的那几颗事件，多传 Vue 会警告（测试日志里灌噪音等于给下次排查埋灰） */
async function mount(Comp, props, evts = ['openAgent', 'review', 'undo']) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const events = {};
  const handlers = {};
  for (const e of evts) handlers['on' + e[0].toUpperCase() + e.slice(1)] = (v) => { events[e] = v; };
  const app = createApp({ render: () => h(Comp, { ...props, ...handlers }) });
  app.mount(host);
  for (let i = 0; i < 8; i++) { await nextTick(); await new Promise((r) => setTimeout(r, 20)); }
  alive.push(() => { app.unmount(); host.remove(); });
  return { host, events, body: () => document.body.textContent };
}

/** 子智能体那一页要点开才会拉清单（切页 watch），测试里手动切一次 */
async function openAgentsTab(dock) {
  const tabs = dock.host.querySelectorAll('.dock-tabs button, .dock-tabs .k-tab');
  const hit = [...tabs].find((b) => /子智能体/.test(b.title || b.textContent || ''));
  if (hit) hit.click();
  else fx.agents.length && (dock.host.__forceTab = true);
  for (let i = 0; i < 8; i++) { await nextTick(); await new Promise((r) => setTimeout(r, 20)); }
  return hit;
}

const RUNNING = { id: 'sa-run-1', name: '摸认证流程', status: 'running', running: true, task: '通读 src/auth 并列出所有登录入口', iter: 3, steps: 6, created_at: '2026-10-12 10:00:00' };
const DONE = { id: 'sa-done-1', name: '查打包慢', status: 'done', running: false, task: '找出 win-unpacked 打包耗时的步骤', iter: 5, steps: 9, created_at: '2026-10-12 09:00:00' };

const HISTORY = [{
  tool: 'edit_file',
  path: 'C:\\Users\\<用户名>\\project\\src\\long\\nested\\dir\\config.js',
  undo_id: 'u1',
  undone: false,
  diff: [
    { t: 'ctx', text: 'const a = 1;' },
    { t: 'add', text: 'const a = 2; // 改过了' },
    { t: 'del', text: 'const b = 3;' },
  ],
  output: 'ok',
  ref: { id: 9, undo_id: 'u1', undone: false, diff: [] },
}];

beforeEach(() => {
  calls.del.length = 0; calls.kill.length = 0; calls.confirm.length = 0;
  fx.agents = [RUNNING, DONE];
  localStorage.setItem('kh.dock.tabs', JSON.stringify(['agents', 'history', 'plan']));
});

afterEach(() => {
  while (alive.length) { try { alive.pop()(); } catch (e) { /* 已卸 */ } }
  document.body.innerHTML = '';
});

describe('右栏子智能体卡片', () => {
  it('一行一路：只有名称与一颗点，行内不再摆一排按钮', async () => {
    const dock = await mount(ChatDock, { tasks: [], history: [], files: [], cwd: 'D:/w' });
    await openAgentsTab(dock);
    const rows = dock.host.querySelectorAll('.ag-row');
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.querySelectorAll('button').length).toBe(0);
      expect(r.querySelector('.ag-dot')).toBeTruthy();
      expect(r.querySelector('.ag-name')).toBeTruthy();
    }
    expect(rows[0].querySelector('.ag-name').textContent).toBe('摸认证流程');
  });

  it('红点=还在跑，绿点=已停下；名称与状态都写进 title（卡片上不占版面）', async () => {
    const dock = await mount(ChatDock, { tasks: [], history: [], files: [], cwd: 'D:/w' });
    await openAgentsTab(dock);
    const rows = dock.host.querySelectorAll('.ag-row');
    expect(rows[0].querySelector('.ag-dot').className).toContain('run');
    expect(rows[1].querySelector('.ag-dot').className).toContain('stop');
    expect(rows[1].getAttribute('title')).toContain('查打包慢');
    expect(rows[1].getAttribute('title')).toContain('已交回');
    expect(rows[1].getAttribute('title')).toContain('找出 win-unpacked 打包耗时的步骤');
  });

  it('点卡片 = 开步骤弹窗（emit open-agent 带 id）', async () => {
    const dock = await mount(ChatDock, { tasks: [], history: [], files: [], cwd: 'D:/w' });
    await openAgentsTab(dock);
    dock.host.querySelectorAll('.ag-row')[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();
    expect(dock.events.openAgent).toBe('sa-done-1');
  });

  it('右键 = 停止 / 删除菜单；已停下的那行不给「停止」', async () => {
    const dock = await mount(ChatDock, { tasks: [], history: [], files: [], cwd: 'D:/w' });
    await openAgentsTab(dock);
    dock.host.querySelectorAll('.ag-row')[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 30 }));
    await nextTick();
    let menu = document.body.querySelector('.ag-menu');
    expect(menu).toBeTruthy();
    const itemsRun = [...menu.querySelectorAll('button')].map((b) => b.textContent.trim());
    expect(itemsRun).toContain('停止');
    expect(itemsRun).toContain('删除记录');

    dock.host.querySelectorAll('.ag-row')[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 30 }));
    await nextTick();
    menu = document.body.querySelector('.ag-menu');
    const itemsDone = [...menu.querySelectorAll('button')].map((b) => b.textContent.trim());
    expect(itemsDone).not.toContain('停止');
    expect(itemsDone).toContain('删除记录');
  });

  it('菜单里删除走的是带 chat_id 的那颗键（别的会话的分身删不掉）', async () => {
    const dock = await mount(ChatDock, { tasks: [], history: [], files: [], cwd: 'D:/w' });
    await openAgentsTab(dock);
    dock.host.querySelectorAll('.ag-row')[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 30 }));
    await nextTick();
    const del = [...document.body.querySelectorAll('.ag-menu button')].find((b) => /删除记录/.test(b.textContent));
    del.click();
    for (let i = 0; i < 6; i++) { await nextTick(); await new Promise((r) => setTimeout(r, 20)); }
    expect(calls.confirm.length).toBe(1);
    expect(calls.del[0][0]).toBe('sa-done-1');
  });

  it('人工派发那张卡已经整个拿掉（没有名称框、任务框、下发按钮）', async () => {
    const dock = await mount(ChatDock, { tasks: [], history: [], files: [], cwd: 'D:/w' });
    await openAgentsTab(dock);
    expect(dock.body()).not.toContain('下发任务');
    expect(dock.body()).not.toContain('派发任务');
    const ph = [...document.body.querySelectorAll('textarea, input')].map((e) => e.placeholder || '');
    expect(ph.some((p) => /派发|名称\(选填\)/.test(p))).toBe(false);
  });
});

describe('右栏修改历史卡片', () => {
  it('标题只有文件名，路径单独一行；两者都不换行', async () => {
    const dock = await mount(ChatDock, { tasks: [], history: HISTORY, files: [], cwd: 'D:/w' });
    const name = dock.host.querySelector('.hist-name');
    const path = dock.host.querySelector('.hist-path');
    expect(name.textContent).toBe('config.js');
    expect(name.textContent).not.toContain('\\');
    expect(path.textContent).toBe('C:\\Users\\<用户名>\\project\\src\\long\\nested\\dir\\config.js');
  });

  it('「展开」改成了「审阅」，行里没有撤销那颗键（撤销在弹窗里）', async () => {
    const dock = await mount(ChatDock, { tasks: [], history: HISTORY, files: [], cwd: 'D:/w' });
    const btns = [...dock.host.querySelectorAll('.hist') ].map((r) => [...r.querySelectorAll('button')].map((b) => b.textContent.trim()));
    expect(btns[0]).toEqual(['审阅']);
    expect(dock.host.textContent).not.toContain('展开');
    expect(dock.host.textContent).not.toContain('收起');
  });

  it('点审阅把这条改动交给父级开弹窗（消息流与侧栏共用同一扇）', async () => {
    const dock = await mount(ChatDock, { tasks: [], history: HISTORY, files: [], cwd: 'D:/w' });
    const btn = [...dock.host.querySelectorAll('button')].find((b) => b.textContent.trim() === '审阅');
    btn.click();
    await nextTick();
    expect(dock.events.review).toBeTruthy();
    expect(dock.events.review.path).toContain('config.js');
    expect(dock.events.review.diff.length).toBe(3);
  });
});

describe('审阅弹窗', () => {
  it('diff 行按增删上色，正文带语法高亮（不是裸文本）', async () => {
    const m = await mount(HistoryReviewModal, { hist: HISTORY[0] }, ['undo']);
    const lines = document.body.querySelectorAll('.diff-line');
    expect(lines.length).toBe(3);
    expect([...lines].map((l) => l.className)).toEqual(['diff-line ctx', 'diff-line add', 'diff-line del']);
    expect(lines[1].querySelector('.code').innerHTML).toContain('hljs-');
    expect(lines[1].textContent).toContain('const a = 2');
    expect(m.body()).toContain('config.js');
  });

  it('红色撤销键点下去 emit undo 并带上那条活对象', async () => {
    const m = await mount(HistoryReviewModal, { hist: HISTORY[0] }, ['undo']);
    const btn = [...document.body.querySelectorAll('button')].find((b) => /撤销这次改动/.test(b.textContent));
    expect(btn.className).toContain('danger');
    btn.click();
    await nextTick();
    expect(m.events.undo).toBe(HISTORY[0].ref);
  });

  // 单独一用例：上一扇还挂在 document.body 上，find() 会先捞到它那颗没禁用的键
  it('已撤销的那条：键禁用、文案改「已撤销」，标题是「审阅 · 文件名」', async () => {
    const doneRow = { ...HISTORY[0], undone: true, ref: { ...HISTORY[0].ref, undone: true } };
    const m2 = await mount(HistoryReviewModal, { hist: doneRow }, ['undo']);
    const btn2 = [...document.body.querySelectorAll('button')].find((b) => /已撤销/.test(b.textContent));
    expect(btn2.disabled).toBe(true);
    expect(m2.body()).toContain('审阅 · config.js');
  });

  it('没有 diff 的改动说清楚「没留下逐行对照」，不是一片空白', async () => {
    await mount(HistoryReviewModal, { hist: { tool: 'delete_file', path: 'D:/a/b.txt', undo_id: 'u2', output: '已删除' } }, ['undo'])
    expect(document.body.textContent).toContain('这次改动没有留下逐行对照');
  });
});
