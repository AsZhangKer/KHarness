/**
 * 「自由会话切去某个项目再切回来，工作目录被那个项目同化」—— 他报的第七十三轮 ①。
 *
 * 关键点是他补的那两句：**不可稳定复现**、**Ctrl+R 强刷一下就变回来**。
 * 库里那条会话行一直是对的（刷新能变回来就是这个意思），坏的只有内存里屏幕上那一份。
 * 而 `openChat` 要 await 一趟 GET：手快连着切两条时，两趟响应会在网上错身而过，
 * 老代码谁后回来谁就把 messages / cwd / 模型 / 用量整份盖上去 —— 于是
 * 「切到项目那条（它先回）→ 自由会话那趟迟到 → 屏幕上写着项目的目录，库里还是自由的」，
 * 下一次发送再把这个显示值发出去，看着就像真被同化了。慢网、大会话时才出得来，正是竞态的形状。
 *
 * 这里用一条**慢的 A + 一条快的 B**把竞态摆成确定的：A 后回来，也不许覆盖正在看的 B。
 */
import { describe, it, expect, vi } from 'vitest';

const SLOW_MS = 60, FAST_MS = 5;
const CHAT_A = { id: 1, title: 'A-自由会话', cwd: 'C:\\Users\\me\\Desktop', model_row_id: 11, plan_mode: 0, agent_mode: 1, readonly: 0 };
const CHAT_B = { id: 2, title: 'B-项目会话', cwd: 'D:\\proj\\B', model_row_id: 22, project_id: 7, plan_mode: 0, agent_mode: 1, readonly: 0 };

vi.mock('../src/api', () => ({
  aiApi: {
    // 先发起的那条（A）故意回得晚：这就是「两趟错身而过」
    getChat: (id) => new Promise((res) => setTimeout(() => res({
      chat: id === 1 ? CHAT_A : CHAT_B,
      messages: [{ id: id * 10, role: 'user', content: `这条是会话 ${id} 的历史` }],
      tasks: [],
      usage: { used: id * 100, limit: 8000 },
    }), id === 1 ? SLOW_MS : FAST_MS)),
    getProjects: () => Promise.resolve([]),
    getChats: () => Promise.resolve([]),
    getModels: () => Promise.resolve([]),
    getInsert: () => Promise.resolve({ items: [] }),
    getChatSkills: () => Promise.resolve({ loaded: [] }),
    getTasks: () => Promise.resolve([]),
    getChatSettings: () => Promise.reject(new Error('no such route')),
  },
  settingsApi: { getAll: () => Promise.resolve({}), update: () => Promise.resolve({}), appInfo: () => Promise.resolve({}) },
}));
vi.mock('../src/stores/toast', () => ({ toast: () => {} }));

const { useChatStore } = await import('../src/features/chat/chatStore');

describe('切会话的竞态：迟到的那趟响应不许覆盖', () => {
  it('A 先发起但后回来 —— 屏幕上留着的是 B 的那一份', async () => {
    const store = useChatStore();
    const s = store.state;
    s.models = [{ id: 11, display_name: 'A 的模型' }, { id: 22, display_name: 'B 的模型' }];

    const pA = store.openChat(1);
    await new Promise((r) => setTimeout(r, 10));   // 人在这中间点下了第二条会话
    const pB = store.openChat(2);
    await Promise.all([pA, pB]);
    await new Promise((r) => setTimeout(r, 120));  // 再给 A 那趟迟到的响应一点时间

    expect(s.chatId).toBe(2);
    // 这三条就是他的现象本体：工作目录、历史、模型都不许被迟到的 A 盖回去
    expect(s.cwd).toBe(CHAT_B.cwd);
    expect(s.messages.map((m) => m.content)).toEqual(['这条是会话 2 的历史']);
    expect(s.modelIdx).toBe(1);
    // 连 A 的用量也不许顶上来（同一条族：②里那半）
    expect(s.contextUsed).toBe(200);
  });

  it('只切一条时照常落地（不是把 openChat 修成什么都不写）', async () => {
    const store = useChatStore();
    await store.openChat(1);
    expect(store.state.chatId).toBe(1);
    expect(store.state.cwd).toBe(CHAT_A.cwd);
    expect(store.state.messages[0].content).toContain('会话 1');
  });
});
