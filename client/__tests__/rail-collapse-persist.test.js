/**
 * 第七十四轮 ③：左栏「哪几行被折叠了」要活过刷新与新一轮消息。
 *
 * 两个病灶各自都能单独把折叠吃掉：
 *   1) chatStore.refreshTree 每次重建项目行都写 `open: true`（发一条消息就走这条路）；
 *   2) remoteStore 存的是**展开清单**，那句 `had.size === 0 ? true : opened.has(id)`
 *      把「刷新页面后第一次拿到」也当成第一次，于是整表重开。
 * 修法统一成一份折叠清单（utils/collapse）：不在清单里就是展开，新出现的项目/连接默认展开。
 *
 * 这里既量清单本身，也挂一次真组件（折叠得真的渲染出来才算数）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp, h } from 'vue';
import fsNode from 'node:fs';
import ChatRail from '../src/features/chat/ChatRail.vue';

const { fx } = vi.hoisted(() => ({
  fx: {
    projects: [
      { id: 1, name: '前端演练', root_path: 'D:/work/fe', sort_order: 1 },
      { id: 2, name: '后端服务', root_path: 'D:/work/be', sort_order: 2 },
    ],
    chats: [{ id: 11, project_id: 1, title: '修登录页' }],
    hosts: [{ id: 5, name: '实验室机器', host: '10.0.0.5', port: 22, username: 'root' }],
  },
}));

vi.mock('../src/api', () => ({
  aiApi: new Proxy({}, {
    get: (t, k) => () => Promise.resolve(
      k === 'getProjects' ? fx.projects
        : k === 'getChats' ? fx.chats
          : k === 'getRemoteHosts' ? fx.hosts
            : null
    ),
  }),
  settingsApi: { getAll: () => Promise.resolve({}), update: () => Promise.resolve({}), appInfo: () => Promise.resolve({}) },
}));
vi.mock('../src/stores/toast', () => ({ toast: () => {} }));
vi.mock('../src/features/chat/chatStream', () => ({
  openChatStream: () => ({ abort() {}, done: new Promise(() => {}) }),
  openPressStream: () => ({ abort() {}, done: Promise.resolve() }),
}));

const { isCollapsed, setCollapsed } = await import('../src/utils/collapse');
const { useChatStore } = await import('../src/features/chat/chatStore');
const { remoteStore } = await import('../src/features/chat/remoteStore');

const read = (rel) => fsNode.readFileSync(new URL(rel, import.meta.url), 'utf8');

const openOf = (store, id) => store.state.projects.find((p) => p.id === id)?.open;

beforeEach(() => {
  localStorage.clear();
  fx.projects = [
    { id: 1, name: '前端演练', root_path: 'D:/work/fe', sort_order: 1 },
    { id: 2, name: '后端服务', root_path: 'D:/work/be', sort_order: 2 },
  ];
  fx.hosts = [{ id: 5, name: '实验室机器', host: '10.0.0.5', port: 22, username: 'root' }];
});

describe('折叠清单本身', () => {
  it('没存过 = 展开；存了折叠才折叠', () => {
    expect(isCollapsed('p', 1)).toBe(false);
    setCollapsed('p', 1, true);
    expect(isCollapsed('p', 1)).toBe(true);
    // 项目与远程主机分前缀：同 id 不能互相牵连
    expect(isCollapsed('h', 1)).toBe(false);
    setCollapsed('p', 1, false);
    expect(isCollapsed('p', 1)).toBe(false);
  });

  it('存的是折叠清单，不是展开清单（新条目天生默认展开）', () => {
    setCollapsed('p', 2, true);
    const raw = JSON.parse(localStorage.getItem('kh.rail_collapsed'));
    expect(raw).toEqual(['p2']);
  });
});

describe('项目行：refreshTree 不再把折叠翻回展开', () => {
  const store = useChatStore();

  it('折叠后再刷新（发消息 / 切会话都走这条路），折叠还在', async () => {
    await store.refreshTree();
    expect(openOf(store, 1)).toBe(true);
    store.toggleProjectOpen(1);
    expect(openOf(store, 1)).toBe(false);
    await store.refreshTree();
    expect(openOf(store, 1)).toBe(false);
    expect(openOf(store, 2)).toBe(true);
  });

  it('相当于重新打开程序：内存清空后重建，仍然记得折叠的是哪一行', async () => {
    setCollapsed('p', 1, true);
    store.state.projects = [];
    await store.refreshTree();
    expect(openOf(store, 1)).toBe(false);
    expect(openOf(store, 2)).toBe(true);
  });

  it('中途新建的项目默认展开（不该被上一份清单里没记录这个 id 猜成折叠）', async () => {
    setCollapsed('p', 1, true);
    await store.refreshTree();
    fx.projects = [...fx.projects, { id: 3, name: '新加的', root_path: 'D:/work/new', sort_order: 3 }];
    await store.refreshTree();
    expect(openOf(store, 3)).toBe(true);
    expect(openOf(store, 1)).toBe(false);
  });

  it('再点一次是展开，并且清单里同步删掉', async () => {
    await store.refreshTree();
    store.toggleProjectOpen(2);
    expect(isCollapsed('p', 2)).toBe(true);
    store.toggleProjectOpen(2);
    expect(openOf(store, 2)).toBe(true);
    expect(isCollapsed('p', 2)).toBe(false);
  });
});

describe('远程主机：刷新页面不再全展开回来', () => {
  it('折叠的那台在 refresh 之后仍然折叠', async () => {
    await remoteStore.refresh();
    expect(remoteStore.state.hosts.find((h) => h.id === 5).open).toBe(true);
    remoteStore.toggle(5);
    expect(remoteStore.state.hosts.find((h) => h.id === 5).open).toBe(false);
    await remoteStore.refresh();
    expect(remoteStore.state.hosts.find((h) => h.id === 5).open).toBe(false);
    expect(isCollapsed('h', 5)).toBe(true);
  });

  it('新加的一台连接默认展开', async () => {
    setCollapsed('h', 5, true);
    await remoteStore.refresh();
    fx.hosts = [...fx.hosts, { id: 6, name: '第二台', host: '10.0.0.6', port: 22, username: 'root' }];
    await remoteStore.refresh();
    expect(remoteStore.state.hosts.find((h) => h.id === 6).open).toBe(true);
    expect(remoteStore.state.hosts.find((h) => h.id === 5).open).toBe(false);
  });
});

describe('挂到栏上：折叠真的少渲染一行', () => {
  const store = useChatStore();

  it('折叠的项目在 DOM 里就是收起态，展开的那个不是', async () => {
    setCollapsed('p', 1, true);
    await store.refreshTree();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createApp({
      render: () => h(ChatRail, {
        projects: store.state.projects, chats: store.state.chats,
        hosts: [], activeChatId: 11, busyIds: [], railW: 260,
      }),
    });
    app.mount(host);
    await Promise.resolve();
    const bodies = [...host.querySelectorAll('.proj > .proj-body')];
    expect(bodies.length).toBe(2);
    expect(bodies[0].classList.contains('open')).toBe(false);
    expect(bodies[1].classList.contains('open')).toBe(true);
    app.unmount();
    host.remove();
  });
});

describe('接线：折叠只有一个人能改', () => {
  const storeSrc = read('../src/features/chat/chatStore.js');
  const remoteSrc = read('../src/features/chat/remoteStore.js');
  const pageSrc = read('../src/features/chat/ChatPage.vue');

  it('refreshTree 的 open 来自折叠清单，不再写死', () => {
    expect(storeSrc).toContain("open: !isCollapsed('p', p.id)");
    expect(storeSrc).not.toMatch(/projects[\s\S]{0,40}map[\s\S]{0,120}open: true/);
  });

  it('旧的那份展开清单（kh.remote_open_hosts）已经彻底拆掉', () => {
    expect(remoteSrc).not.toContain('kh.remote_open_hosts');
    expect(remoteSrc).toContain("open: !isCollapsed('h', h.id)");
  });

  it('左栏点行头走的是 store（翻内存 + 记清单），不是本地翻一下', () => {
    expect(pageSrc).toContain('@toggle-project="onToggleProject"');
    expect(pageSrc).toContain('store.toggleProjectOpen(id)');
    expect(pageSrc).toContain('@toggle-host="remote.toggle"');
  });
});
