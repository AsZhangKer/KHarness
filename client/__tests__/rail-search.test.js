/**
 * 左栏条目级搜索（#220）。
 *
 * 这里挂的是真组件、真 props，走的是用户那条路：打字 → 树被过滤 → 清空 → 树复原。
 * 之所以不只看源码：这一改动了 v-for 的数据源、展开类和空态提示十几处，
 * 少改一处不会报错，只会「搜得出但看不见」或「清空了树回不来」——只有挂起来点一遍才知道。
 */
import { describe, it, expect } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import ChatRail from '../src/features/chat/ChatRail.vue';

const projects = [
  { id: 1, name: '前端演练', root_path: 'D:/work/fe', open: false, sort_order: 1 },
  { id: 2, name: '后端服务', root_path: 'D:/work/be', open: true, sort_order: 2 },
];
// sort_order 写死：栏里「同置顶、同项目」的默认顺序是按 id 倒序，不写死的话断言顺序会在改 fixture 时莫名翻面
const chats = [
  { id: 11, project_id: 1, title: '修登录页', sort_order: 1 },
  { id: 12, project_id: 1, title: '关于 Docker 的讨论', sort_order: 2 },
  { id: 21, project_id: 2, title: '索引优化', sort_order: 1 },
  { id: 31, title: '随机闲聊', sort_order: 1 },
];

function mountRail() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp({
    render: () => h(ChatRail, { projects, chats, hosts: [], activeChatId: 11, busyIds: [], railW: 260 }),
  });
  app.mount(host);
  return { host, app, unmount: () => { app.unmount(); host.remove(); } };
}

function names(host) {
  return [...host.querySelectorAll('.chat-row .name')].map((el) => el.textContent.trim());
}

async function type(host, text) {
  const input = host.querySelector('.rail-search input');
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  return input;
}

describe('左栏搜索', () => {
  it('不打字时一切照旧：四条会话都在，折叠的项目不会自己张开', async () => {
    const { host, unmount } = mountRail();
    expect(names(host)).toEqual(['前端演练 / 修登录页', '前端演练 / 关于 Docker 的讨论', '后端服务 / 索引优化', '随机闲聊']);
    expect(host.querySelector('.proj .proj-body').classList.contains('open')).toBe(false);
    unmount();
  });

  it('按标题命中：只剩那一条，并且它所属的折叠项目自动展开', async () => {
    const { host, unmount } = mountRail();
    await type(host, 'docker');
    expect(names(host)).toEqual(['前端演练 / 关于 Docker 的讨论']);
    const body = host.querySelector('.proj .proj-body');
    expect(body.classList.contains('open')).toBe(true);
    unmount();
  });

  it('命中的是项目名：这个项目整个露出来（两条会话都在），别的项目消失', async () => {
    const { host, unmount } = mountRail();
    await type(host, '前端');
    expect(names(host)).toEqual(['前端演练 / 修登录页', '前端演练 / 关于 Docker 的讨论']);
    expect(host.querySelectorAll('.proj').length).toBe(1);
    unmount();
  });

  it('谁都没命中：树清空并给一句话，而不是留一片空白让人以为列表坏了', async () => {
    const { host, unmount } = mountRail();
    await type(host, 'zzz-没有这种东西');
    expect(names(host)).toEqual([]);
    expect(host.querySelector('.tree-empty').textContent).toContain('没有匹配');
    unmount();
  });

  it('清空 / Esc 之后树立刻回到平时的样子', async () => {
    const { host, unmount } = mountRail();
    const input = await type(host, 'docker');
    expect(names(host).length).toBe(1);
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    expect(names(host).length).toBe(4);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextTick();
    expect(input.value).toBe('');
    expect(names(host).length).toBe(4);
    unmount();
  });

  it('自由会话只看「最近」这一段：项目里的会话不会串进来', async () => {
    const { host, unmount } = mountRail();
    await type(host, '闲聊');
    expect(names(host)).toEqual(['随机闲聊']);
    expect(host.querySelectorAll('.proj').length).toBe(0);
    unmount();
  });
});
