/**
 * 第七十五轮 ①②④ 的服务端行为：子智能体没有步数/文本上限、并发按会话算、结论回到所属会话、
 * 主会话停止时连带中止。
 *
 * 这些不能只看源码：LIMITS 少一个键、或者哪一处还留着 slice，读代码很容易看漏，
 * 而那正是他报的三件事（「去掉步数限制和输出文本限制」「允许并发多个」「主会话停了子智能体也要停」）。
 * 所以这里用**假上游（stub global.fetch）+ 假 host**跑真的 drive 循环，量真落库的那一行。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'kh75sa-'));
process.env.KH_DATA_DIR = T;      // config.js 在 require 时读它，必须先设再 import

// 必须用 require 拿库：vitest 里 ESM 与 CJS 会把 database.js 当两个模块实例，
// 那样 subagent（CJS）连的是另一条 better-sqlite3 连接，这里 close() 关不掉它，
// 收尾 rmSync 会因 kh.db 仍被占而重试满 11 秒（实测同一份文件 esm.db !== cjs.db）。
const { db, initDatabase } = require('../database.js');
initDatabase();
const subagent = require('../utils/subagent.js');

const PROVIDER = db.prepare("INSERT INTO ai_providers (name, base_url, api_key) VALUES ('t', 'http://127.0.0.1:9/v1', 'k')").run().lastInsertRowid;
db.prepare("INSERT INTO ai_models (id, provider_id, model_id, display_name) VALUES (1, ?, 'm', 'm')").run(PROVIDER);
// 外键是真开着的（这库一直如此），所以模型行必须先存在，会话才挂得上
const CHAT_A = db.prepare("INSERT INTO ai_chats (title, model_row_id) VALUES ('甲', 1)").run().lastInsertRowid;
const CHAT_B = db.prepare("INSERT INTO ai_chats (title, model_row_id) VALUES ('乙', 1)").run().lastInsertRowid;

const frames = [];
subagent.setHost({
  // 工具执行替身：回一段很长的文本，正好顺手验「不再截断」
  execTool: async (name) => ({ output: `OUT-${name}·` + '字'.repeat(20000) }),
  builtinToolDefs: () => [],
  defaultCwd: T,
  redact: (s) => String(s ?? ''),
  emitSubagent: (e) => frames.push(e),
});

/** 假上游：前 deep 次都回一个 tool_call，最后一次回正文。全程不走真网络 */
let plan = { deep: 0, text: '' };
let calls = 0;
const realFetch = global.fetch;
beforeAll(() => {
  global.fetch = async () => {
    calls++;
    const i = calls;
    // 每趟留一点间隔：「还在跑」这件事要能被观察到（停止那两条用例就靠它）
    await new Promise((r) => setTimeout(r, 25));
    if (i <= plan.deep) {
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: `第 ${i} 步先看一眼`, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `f${i}.txt` }) } }] } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: plan.text, tool_calls: [] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    };
  };
});
afterAll(async () => {
  // 先把还在跑的收干净再收库：留一个循环在写同一张表，close/rmSync 会一路卡到 hook 超时
  subagent.killChat(CHAT_A);
  subagent.killChat(CHAT_B);
  await new Promise((r) => setTimeout(r, 400));
  global.fetch = realFetch;
  try { db.close(); } catch (e) { /* 已关 */ }
  try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* 留给系统清 */ }
}, 40000);

const noteRows = (chat) => db.prepare("SELECT * FROM ai_chat_messages WHERE chat_id = ? AND speaker = 'subagent' ORDER BY id ASC").all(chat);
async function runOne(chatId, opts = {}) {
  calls = 0;
  plan = { deep: opts.deep ?? 2, text: opts.text ?? '结论在此。' };
  const c = subagent.create({ name: opts.name || `n${Date.now()}${Math.random()}`, task: opts.task || '查一下', chatId, cwd: T });
  expect(c.error).toBeFalsy();
  const s = subagent.start(c.id);
  expect(s.error).toBeFalsy();
  const r = await s.promise;
  return { id: c.id, r };
}

describe('① 没有步数上限，也没有文本截断', () => {
  it('LIMITS 里只剩超时；并发数改成读设置的函数（第七十六轮挪进 设置→常规）', () => {
    expect(subagent.LIMITS.maxSteps).toBeUndefined();
    expect(subagent.LIMITS.resultChars).toBeUndefined();
    expect(subagent.LIMITS.taskChars).toBeUndefined();
    expect(subagent.LIMITS.maxParallel).toBeUndefined();
    expect(subagent.LIMITS.maxParallelPerChat).toBeUndefined();
    expect(subagent.maxParallelPerChat()).toBeGreaterThan(1);
    expect(subagent.LIMITS.timeoutMs).toBeGreaterThan(0);
  });

  it('跑 30 步（早于旧上限 24）照样出结论，轨迹一步不少', async () => {
    const { id, r } = await runOne(CHAT_A, { deep: 30, text: '跑完 30 步的结论' });
    expect(r.result).toContain('跑完 30 步的结论');
    expect(r.error).toBeFalsy();
    const row = db.prepare('SELECT * FROM ai_subagents WHERE id = ?').get(id);
    const steps = JSON.parse(row.steps_json);
    // 每一步：正文一段 + 调用一条 + 结果一条；旧的 200 条上限与 12000 字截断都不许再咬
    expect(steps.filter((s) => s.type === 'tool').length).toBe(30);
    expect(steps.filter((s) => s.type === 'text').length).toBe(31);
    expect(steps.some((s) => s.type === 'result' && String(s.output || '').length > 12000)).toBe(true);
    expect(steps.some((s) => String(s.output || '').includes('已截断'))).toBe(false);
    expect(row.iter).toBe(31);
  });

  it('结论本身再长也不砍（旧的 resultChars=8000 会把交回的结论削掉）', async () => {
    const long = '长'.repeat(30000);
    const { r } = await runOne(CHAT_A, { deep: 1, text: long });
    expect(String(r.result).length).toBe(long.length);
  });
});

describe('② 并发按会话算', () => {
  it('一条会话占满就不再收，另一条会话不受影响', async () => {
    // 深到 60 步 + 每趟 25ms：这几颗在断言时必须真的还在跑（否则上限这道门根本量不到）
    plan = { deep: 60, text: '不该到这一步' };
    calls = 0;
    const held = [];
    for (let i = 0; i < subagent.maxParallelPerChat(); i++) {
      const c = subagent.create({ name: `hold-${i}`, task: '占位', chatId: CHAT_A, cwd: T });
      expect(c.error).toBeFalsy();
      held.push(c.id);
      expect(subagent.start(c.id).error).toBeFalsy();
    }
    const over = subagent.create({ name: 'over', task: '再多一个', chatId: CHAT_A, cwd: T });
    expect(over.error).toContain('本会话同时在跑的子智能体已达上限');
    const other = subagent.create({ name: 'other-chat', task: '别的会话', chatId: CHAT_B, cwd: T });
    expect(other.error).toBeFalsy();
    // 没带会话身份（设置页试跑那类）不该被这道上限挡住
    expect(subagent.create({ name: 'no-chat', task: '无归属', cwd: T }).error).toBeFalsy();
    for (const id of held) subagent.kill(id, CHAT_A);
    subagent.kill(other.id, CHAT_B);
    await new Promise((r) => setTimeout(r, 400));   // 让那几颗收尾，别把 running 漏给下一个用例
  }, 20000);
});

describe('④ 停止链路：归属 + 主会话停了连带停', () => {
  it('别的会话停不掉它，本会话停得掉', async () => {
    const { id } = await runOne(CHAT_A, { deep: 0, text: '已结束的' });
    expect(subagent.kill(id, CHAT_B).error).toContain('不是本会话派出去的');
    expect(subagent.remove(id, CHAT_B).error).toContain('不属于本会话');
    expect(subagent.kill(id, CHAT_A).error).toBeFalsy();
  });

  it('killChat 只停这条会话还在跑的，并标成 killed', async () => {
    // 让它们真在跑：假上游每趟留 25ms，深到 60 步，200ms 后一定还没收尾
    plan = { deep: 60, text: '不该到这一步' };
    calls = 0;
    const a = subagent.create({ name: 'cascade-a', task: '慢慢跑', chatId: CHAT_A, cwd: T });
    const b = subagent.create({ name: 'cascade-b', task: '慢慢跑', chatId: CHAT_B, cwd: T });
    const sa = subagent.start(a.id);
    const sb = subagent.start(b.id);
    // 等它们真进入 running（不然 runningCount 那侧还没记上）
    await new Promise((r) => setTimeout(r, 200));
    const res = subagent.killChat(CHAT_A);
    expect(res.killed).toEqual([a.id]);
    await sa.promise.catch(() => {});
    await sb.promise.catch(() => {});
    expect(db.prepare('SELECT status FROM ai_subagents WHERE id = ?').get(a.id).status).toBe('killed');
    const bs = db.prepare('SELECT status FROM ai_subagents WHERE id = ?').get(b.id).status;
    expect(['done', 'killed', 'failed']).toContain(bs);   // B 那条不该被 A 的停止牵连（它自己会跑完）
    expect(frames.some((f) => f.id === a.id && f.phase === 'killed')).toBe(true);
  }, 30000);
});

describe('结果像工具返回一样交回，不占消息表（第七十七轮他改的口径）', () => {
  // 前面几组用例跑的分身都还挂着「未交回」标记，先各自排空再断言，否则读到的不是这一条的账
  const drain = () => { subagent.takeDeliveries(CHAT_A); subagent.takeDeliveries(CHAT_B); };

  it('跑完不落 speaker=subagent 的消息；交回文本要等构建上文时取走，且只取一次', async () => {
    drain();
    const before = db.prepare('SELECT COUNT(*) c FROM ai_chat_messages WHERE chat_id = ?').get(CHAT_B).c;
    await runOne(CHAT_B, { deep: 1, text: 'B 会话的结论：这里没问题。' });
    expect(noteRows(CHAT_B)).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) c FROM ai_chat_messages WHERE chat_id = ?').get(CHAT_B).c).toBe(before);
    const txt = subagent.takeDeliveries(CHAT_B);
    expect(txt).toContain('B 会话的结论：这里没问题。');
    expect(txt).toContain('已完成');
    expect(subagent.takeDeliveries(CHAT_B)).toBe('');   // 取走即标，同一份结论不许在上下文里出现两遍
  });

  it('交回的只算到它自己的会话，别的会话取不到（不串台）', async () => {
    drain();
    await runOne(CHAT_B, { deep: 0, text: '只属于乙会话的结论' });
    expect(subagent.takeDeliveries(CHAT_A)).toBe('');
    expect(subagent.takeDeliveries(CHAT_B)).toContain('只属于乙会话的结论');
  });

  it('有人当场用 wait 拿走了结论，就不再交回这一份', async () => {
    drain();
    const c = subagent.create({ name: 'waited', task: '等一下', chatId: CHAT_B, cwd: T });
    subagent.start(c.id);
    const w = await subagent.wait(c.id, 20000);
    expect(w.result).toBeTruthy();
    expect(w.status).toBe('done');
    expect(noteRows(CHAT_B)).toHaveLength(0);
    expect(subagent.takeDeliveries(CHAT_B)).toBe('');
  }, 30000);
});

describe('接线：派发那一枪与工具层都跟着改了', () => {
  const extools = fs.readFileSync(path.resolve(__dirname, '../utils/extools.js'), 'utf8');
  const routes = fs.readFileSync(path.resolve(__dirname, '../routes/ai.js'), 'utf8');
  const schemas = fs.readFileSync(path.resolve(__dirname, '../utils/schemas.js'), 'utf8');

  it('agent_run 不再 await 整轮（派完就返回 id），runSync 这条路整个拆了', () => {
    const sec = extools.slice(extools.indexOf('agent_run: {'), extools.indexOf('agent_wait: {'));
    expect(sec).toContain('subagent.spawn(');
    expect(sec).not.toMatch(/await subagent\.(runSync|wait)/);
    expect(extools).not.toContain('subagent.report(');
    expect(subagent.runSync).toBeUndefined();
    expect(schemas).toContain("agent_spawn: 'agent_run'");
  });

  it('父回合的 abort 会连带 killChat；REST 的 kill/delete 都带归属', () => {
    expect(routes).toContain('subagent.killChat(chatId)');
    expect(routes).toContain("subagent.kill(String(req.body?.agent_id || ''), parseInt(req.body?.chat_id) || null)");
    expect(routes).toContain("subagent.remove(String(req.body?.agent_id || ''), parseInt(req.body?.chat_id) || null)");
    expect(routes).toContain("router.post('/subagents/kill-chat'");
  });

  it('进度帧把结论全文带回前端，但不再带 injected（界面上不该长出气泡）', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../utils/subagent.js'), 'utf8');
    expect(src).not.toMatch(/injected:/);
    expect(src).not.toMatch(/result: String\(result \|\| ''\)\.slice\(0, 400\)/);
    const done = frames.filter((f) => f.phase === 'done');
    expect(done.length).toBeGreaterThan(0);
    expect(done.every((f) => f.injected === undefined)).toBe(true);
    expect(done.some((f) => String(f.result || '').length > 400)).toBe(true);
  });

  it('交回的两个消费点都接上了：跨轮上文与安全边界各取一次', () => {
    expect(routes).toContain('subagent.takeDeliveries(chatId)');
    const bm = routes.slice(routes.indexOf('const buildBaseMsgs = () =>'), routes.indexOf('await maybeAutoCompress'));
    expect(bm.match(/takeDeliveries/g)).toHaveLength(1);
    const ib = routes.slice(routes.indexOf('const injectAtBoundary = () =>'), routes.indexOf('const ROUND_TOOL_BUDGET_TOKENS'));
    expect(ib.match(/takeDeliveries/g)).toHaveLength(1);
  });
});

