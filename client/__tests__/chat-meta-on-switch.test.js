/**
 * 「切回一条正在生成的会话，界面留着别的会话的模型」——第七十二轮他报的那条。
 *
 * 现象：A 项目下的会话 a（mimo-2.6-pro）在跑，切去自由会话 _b（deepseek-v4-flash）再切回 a，
 * a 的模型名变成 deepseek，但那一轮真正在跑的模型没变；下一次请求就发给 deepseek 了。
 * a 不在运行状态时切换没事；Ctrl+R 又能变回来。
 *
 * 三条现象合起来只有一种解释：**库里那条会话行一直是对的，是内存里那份界面状态没跟着会话走**。
 * 根因在 `openChat` 的快路径：`if (inflight?.live && cached)` 只把本地消息缓冲挂回来，
 * 整段「会话行 → 界面」的回读（模型 / 三个开关 / 审批档 / 思考档 / 温度 / 工作目录）全被跳过。
 * 修法是把那段回读抽成 `applyChatMeta(chat)`，两条路都调；快路径额外走一条只读配置的小接口。
 *
 * 这里两头都锁：逻辑（applyChatMeta 真把值写对）+ 接线（两条路径都调用它，小接口存在）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { useChatStore } from '../src/features/chat/chatStore';

const SRC = path.resolve(__dirname, '../src');

describe('会话行 → 界面：applyChatMeta', () => {
  const store = useChatStore();
  const s = store.state;

  it('模型按会话行为准（他报的那条：切回来必须回到这条会话自己的模型）', () => {
    s.models = [{ id: 11, display_name: 'mimo-2.6-pro' }, { id: 22, display_name: 'deepseek-v4-flash' }];
    s.modelIdx = 1;               // 当前停在 _b 的那个模型上（= 他看到的现象）
    store.applyChatMeta({ model_row_id: 11, cwd: 'D:\\proj\\A', plan_mode: 1, agent_mode: 1, readonly: 0,
      approval_mode: 'strict', approval_effective: 'strict', thinking_level: 'high', temperature: 0.3,
      frequency_penalty: 0, presence_penalty: 0, censored_words: '', context_limit: 0 });
    expect(s.modelIdx).toBe(0);
    expect(s.chatModelId).toBe(11);
    expect(s.cwd).toBe('D:\\proj\\A');
    expect(s.planMode).toBe(true);
    expect(s.approvalMode).toBe('strict');
    expect(s.thinkingLevel).toBe('high');
  });

  it('行里那个模型已被删/被禁用时不动界面那份（免得显示一个空模型）', () => {
    s.modelIdx = 1;
    store.applyChatMeta({ model_row_id: 999 });
    expect(s.modelIdx).toBe(1);
  });

  it('开关列 -1 = 这条会话从没动过 → 保持全局那份，不被会话行覆盖', () => {
    s.agentMode = true;
    store.applyChatMeta({ model_row_id: 11, agent_mode: -1, readonly: -1 });
    expect(s.agentMode).toBe(true);
  });

  it('context_limit 为 0（跟随模型上限）不许把界面已有的生效值清成 0', () => {
    s.contextLimit = 128000;
    store.applyChatMeta({ model_row_id: 11, context_limit: 0 });
    expect(s.contextLimit).toBe(128000);
    store.applyChatMeta({ model_row_id: 11, context_limit: 200000 });
    expect(s.contextLimit).toBe(200000);
  });

  it('空对象/undefined 什么都不写（读失败时保持现状，别把人切到一个空白界面）', () => {
    s.modelIdx = 0;
    store.applyChatMeta(null);
    store.applyChatMeta({});
    expect(s.modelIdx).toBe(0);
  });
});

describe('接线：两条打开路径都得回读配置', () => {
  const store = fs.readFileSync(path.join(SRC, 'features/chat/chatStore.js'), 'utf8');
  const fast = store.slice(store.indexOf('if (inflight?.live && cached)'), store.indexOf('} else {'));
  const api = fs.readFileSync(path.join(SRC, 'api/index.js'), 'utf8');

  it('生成中那条快路径也调用 loadChatMeta（以前整段跳过 = 本轮的 bug）', () => {
    // 第七十三轮起还并上要按会话读的 plan 清单（快路径同样不能留着别条会话的任务）
    expect(fast).toMatch(/await Promise\.all\(\[loadChatMeta\(id\), refreshTasks\(id\)\]\);/);
  });
  it('快路径的读接口只要配置那一小份，读不到才退回整份 GET', () => {
    const fn = store.slice(store.indexOf('async function loadChatMeta'), store.indexOf('async function openChat'));
    expect(fn).toMatch(/aiApi\.getChatSettings\(id\)/);
    expect(fn).toMatch(/chat = \(await aiApi\.getChat\(id\)\)\?\.chat \|\| null;/);
    // 等回来时人可能已经切走了 —— 不许把配置写到别的会话身上
    expect(fn).toMatch(/if \(state\.chatId === id\) applyChatMeta\(chat\);/);
  });
  it('applyChatMeta 从 store 里拿得到（两条路径共用一份，测试也打这一份）', () => {
    expect(store).toMatch(/applyChatMeta,\s*\/\/|applyChatMeta,/g);
  });
  it('完整那条路径共用同一个 applyChatMeta（不留第二套口径）', () => {
    expect(store).toMatch(/state\.tasks = res\?\.tasks \|\| \[\];\s*(tasksByChat\[id\] = state\.tasks;\s*)?applyChatMeta\(chat\);/);
    // 那段回读只许存在一份：函数体一次，两处调用点
    expect(store.match(/state\.planMode = !!chat\.plan_mode;/g)?.length).toBe(1);
  });
  it('前端有那条只读配置接口，且带 silent（老后端 404 不该弹红条）', () => {
    expect(api).toMatch(/getChatSettings: \(id\) => http\.get\(`\/ai\/chats\/\$\{id\}\/settings`, \{ silent: true \}/);
  });
});
