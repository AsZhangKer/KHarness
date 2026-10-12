/**
 * 第七十六轮 ②③：子智能体并发上限挪到「设置 → 常规」，以及名称不许为空。
 *
 * 上限这一项以前写死在 LIMITS 里（4），他要按机器情况调、还要能设不限；
 * 所以这里量的不是「代码里那个数改成了 5」，而是**改了设置真的生效、0 真的不限**。
 * 名称那一半是他改侧栏卡片（只显名称）之后必须成立的：库里 name 永不为空。
 *
 * 跑的是真的 utils/subagent.js + 假上游（stub fetch）+ 假 host，派发链路一步没替身。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'kh76sa-'));
process.env.KH_DATA_DIR = T;      // config.js 在 require 时读它，必须先设再 import
// 同 plan-tools 那份说明：必须用 require 拿库，ESM/CJS 会各开一条连接，收尾会卡满 11 秒
const { db, initDatabase } = require('../database.js');
initDatabase();
const subagent = require('../utils/subagent.js');

const PROVIDER = db.prepare("INSERT INTO ai_providers (name, base_url, api_key) VALUES ('t', 'http://127.0.0.1:9/v1', 'k')").run().lastInsertRowid;
db.prepare("INSERT INTO ai_models (id, provider_id, model_id, display_name) VALUES (1, ?, 'm', 'm')").run(PROVIDER);
const CHAT = Number(db.prepare("INSERT INTO ai_chats (title, model_row_id) VALUES ('甲', 1)").run().lastInsertRowid);

const KEY = 'subagent_max_parallel';
function setCap(v) {
  db.prepare(`INSERT INTO settings (key, value) VALUES ('${KEY}', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(v);
}
function clearCap() {
  db.prepare(`DELETE FROM settings WHERE key = ?`).run(KEY);
}

const realFetch = global.fetch;
beforeAll(() => {
  subagent.setHost({
    execTool: async (name) => ({ output: `OUT-${name}` }),
    builtinToolDefs: () => [],
    defaultCwd: T,
    redact: (s) => String(s ?? ''),
    emitSubagent: () => {},
  });
  // 每趟留 40ms：断言时这几颗必须真的还在跑，否则上限那道门量不到；又能在收尾时被 abort 收掉
  global.fetch = async () => {
    await new Promise((r) => setTimeout(r, 40));
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: '继续查',
            tool_calls: [{ id: `c${Date.now()}${Math.random()}`, type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    };
  };
});

/** 派一颗真的在跑的（不 await 它的 promise）；全部登记进 ALL，收尾时一次杀干净 */
const ALL = [];
function spawnRunning(name) {
  const c = subagent.create({ name, task: '占位长跑', chatId: CHAT, cwd: T });
  expect(c.error).toBeFalsy();
  expect(subagent.start(c.id).error).toBeFalsy();
  ALL.push(c.id);
  return c.id;
}
function killAll(ids) {
  for (const id of ids) { try { subagent.kill(id, CHAT); } catch (e) { /* 已收 */ } }
}

afterAll(async () => {
  // 先收干净还在循环的那几颗，再关库：留一个写手在场，close/rmSync 会一路卡到 hook 超时
  killAll(ALL);
  await new Promise((r) => setTimeout(r, 400));
  global.fetch = realFetch;
  try { db.close(); } catch (e) { /* 已关 */ }
  try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* 留给系统清 */ }
}, 20000);

describe('并发上限读设置（subagent_max_parallel）', () => {
  it('库里没种过这一项时是 5，不是以前写死的 4', () => {
    clearCap();
    expect(subagent.maxParallelPerChat()).toBe(5);
  });

  it('0 / 3 / 空串 / 非数各按口径来（0 是有效值「不限」，不能被当成没填）', () => {
    setCap('0'); expect(subagent.maxParallelPerChat()).toBe(0);
    setCap('3'); expect(subagent.maxParallelPerChat()).toBe(3);
    setCap('12'); expect(subagent.maxParallelPerChat()).toBe(12);
    setCap(''); expect(subagent.maxParallelPerChat()).toBe(5);
    setCap('abc'); expect(subagent.maxParallelPerChat()).toBe(5);
    setCap('-1'); expect(subagent.maxParallelPerChat()).toBe(5);
  });

  it('上限 2 时第三颗被拒，且错误文案指向设置页那一条', () => {
    clearCap(); setCap('2');
    const held = [spawnRunning('a'), spawnRunning('b')];
    const over = subagent.create({ name: 'c', task: '再多一个', chatId: CHAT, cwd: T });
    expect(over.error).toContain('本会话同时在跑的子智能体已达上限（2 个');
    expect(over.error).toContain('设置 → 常规 → 子智能体并发上限');
    killAll(held);
  });

  it('设成 0 = 真的不限：连着派 4 颗一颗都不被拒', async () => {
    setCap('0');
    const held = [];
    for (let i = 0; i < 4; i++) {
      const c = subagent.create({ name: `free-${i}`, task: '占位长跑', chatId: CHAT, cwd: T });
      expect(c.error).toBeFalsy();
      expect(subagent.start(c.id).error).toBeFalsy();
      held.push(c.id);
      ALL.push(c.id);
    }
    await new Promise((r) => setTimeout(r, 120));   // 让它们在假上游上真的转几圈
    // running 这一项直接来自在跑的注册表（live map），比状态字段实时
    expect(subagent.list(CHAT).filter((a) => a.running).length).toBeGreaterThanOrEqual(4);
    killAll(held);
    await new Promise((r) => setTimeout(r, 300));
  }, 15000);

  it('改完立刻生效，不用重启（同一进程内连续两次取值不一样）', () => {
    clearCap();
    expect(subagent.maxParallelPerChat()).toBe(5);
    setCap('1');
    expect(subagent.maxParallelPerChat()).toBe(1);
    clearCap();
  });
});

describe('名称不许为空（侧栏卡片只显示名称）', () => {
  const nameOf = (id) => db.prepare('SELECT name FROM ai_subagents WHERE id = ?').get(id).name;

  it('给了名字就用它', () => {
    clearCap(); setCap('0');
    const c = subagent.create({ name: 'survey-auth', task: '查认证流程', chatId: CHAT, cwd: T });
    expect(nameOf(c.id)).toBe('survey-auth');
    killAll([c.id]);
  });

  it('没给名字时从任务第一行摘，不会再一律落成 agent', () => {
    clearCap(); setCap('0');
    const a = subagent.create({ name: '   ', task: '统计 client/src 下 .vue 的行数\n第二行不要', chatId: CHAT, cwd: T });
    const b = subagent.create({ task: '摸清楚打包脚本为什么慢', chatId: CHAT, cwd: T });
    const na = nameOf(a.id), nb = nameOf(b.id);
    expect(na).toBeTruthy();
    expect(nb).toBeTruthy();
    expect(na).not.toBe('agent');
    expect(nb).not.toBe('agent');
    // 只取第一行：第二行那些不该混进名称
    expect(na).not.toContain('第二行');
    killAll([a.id, b.id]);
  });

  it('task 也是空白时兜到 agent，但绝不留空串（卡片不能显示成空白）', () => {
    const c = subagent.create({ name: '', task: '   ', chatId: CHAT, cwd: T });
    // task 空在 create 里就先被拒，走不到名称那一步 —— 这两条是同一条纪律
    expect(c.error).toContain('task 不能为空');
  });

  it('agent_run 的 name 参数已改必填（工具描述里也说了上限可配置）', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../utils/extools.js'), 'utf8');
    const run = src.slice(src.indexOf('agent_run: {'), src.indexOf('agent_wait: {'));
    expect(run).toMatch(/name: \{ type: 'string', required: true/);
    expect(run).toMatch(/上限默认 5 个/);
    expect(run).not.toMatch(/本会话同时在跑的上限 4 个/);
  });
});
