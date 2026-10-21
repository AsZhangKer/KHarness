/**
 * 第七十六轮 ①：计划任务从正文标签协议转向工具。
 *
 * 他报的现象是「能创建计划，但有时候怎么都改不动」。实测（_tmp 探针 + 这轮用例）确认
 * 正文协议有四种静默失效：全角引号、status 不在 doing/done/failed 里、idx 从 0 起、
 * idx 比表里行数大（模型中途重发过 <plan> 就整体错位）—— 四种都是「标签照样被剥掉、库里一个字没改」，
 * 模型拿不到任何回执。所以工具这一路必须做到：写失败就把原因和可用编号回给它。
 *
 * 这里量的是真的 utils/plantools.js 对真的表做了什么，不是读源码。
 * 挂载条件（只在 Plan 模式挂、不进设置→工具）用源码断言钉，因为它在 routes/ai.js 的闭包里，
 * 起一遍完整服务才能跑到的部分交给探针脚本。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'kh76plan-'));
process.env.KH_DATA_DIR = T;      // config.js 在 require 时读它，必须先设再 import

// 必须用 require 拿库，不能 await import：vitest 里 ESM 与 CJS 会把 database.js 当两个模块实例，
// 于是被测模块（CJS 的 plantools）连的是另一条 better-sqlite3 连接 —— 测试里的 db.close() 关不掉它，
// 收尾的 rmSync 会因 kh.db 仍被占而重试满 11 秒（实测 same db object? false）。
const { db, initDatabase } = require('../database.js');
initDatabase();
const plantools = require('../utils/plantools.js');
const toolgate = require('../utils/toolgate.js');

const PROVIDER = db.prepare("INSERT INTO ai_providers (name, base_url, api_key) VALUES ('t', 'http://127.0.0.1:9/v1', 'k')").run().lastInsertRowid;
db.prepare("INSERT INTO ai_models (id, provider_id, model_id, display_name) VALUES (1, ?, 'm', 'm')").run(PROVIDER);
// tasks.chat_id 挂着真外键，会话行得先存在
const CHAT = Number(db.prepare("INSERT INTO ai_chats (title, model_row_id) VALUES ('甲', 1)").run().lastInsertRowid);

const rows = () => db.prepare('SELECT seq, content, status, error_summary FROM tasks WHERE chat_id = ? ORDER BY seq').all(CHAT);
const table = () => rows().map((r) => `${r.seq}:${r.status}`).join(' ');

afterAll(() => {
  try { db.close(); } catch (e) { /* 已关 */ }
  try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* 留给系统清 */ }
});

// 一张表跑到底：每条用例都从空列表开始，否则前一条留下的任务会让「空列表」这类断言假失败
beforeEach(() => {
  db.prepare('DELETE FROM tasks WHERE chat_id = ?').run(CHAT);
});

describe('plan_write 建表', () => {
  it('整表按传入顺序落库，seq 从 1 连续，状态一律 pending', async () => {
    const r = await plantools.exec('plan_write', { items: '读取配置\n改端口为 8317\n重启服务' }, { chatId: CHAT });
    expect(r.error).toBeUndefined();
    expect(table()).toBe('1:pending 2:pending 3:pending');
    // 回执必须带编号：模型下次就靠这个数字调 plan_update，不再猜
    expect(r.output).toContain('1. [pending] 读取配置');
    expect(r.output).toContain('3. [pending] 重启服务');
  });

  it('模型把行写成 "1. 任务" 或带 - 前缀时，编号被剥掉，正文只剩任务本身（老协议会连 "1. " 一起入库）', async () => {
    await plantools.exec('plan_write', { items: '- 甲\n2. 乙\n3）丙\n\n这是说明行' }, { chatId: CHAT });
    expect(rows().map((r) => r.content)).toEqual(['甲', '乙', '丙', '这是说明行']);
  });

  it('一条都没有时给可行动的说明，而不是建一张空表', async () => {
    const r = await plantools.exec('plan_write', { items: '   \n  \n' }, { chatId: CHAT });
    expect(r.error).toMatch(/没有解析到任何任务条目/);
    expect(r.error).toMatch(/每行一条/);
  });

  it('超过 50 条只留前 50 条（与面板的取数上限一致）', async () => {
    const many = Array.from({ length: 55 }, (_, i) => `任务${i + 1}`).join('\n');
    await plantools.exec('plan_write', { items: many }, { chatId: CHAT });
    expect(rows().length).toBe(50);
    expect(rows()[49].seq).toBe(50);
  });

  it('重发 plan_write 是整表重建：进度回到未开始（钉住这条设计，别让模型以为能增量）', async () => {
    await plantools.exec('plan_write', { items: '甲\n乙\n丙' }, { chatId: CHAT });
    await plantools.exec('plan_update', { seq: '1', status: 'done' }, { chatId: CHAT });
    expect(table()).toBe('1:done 2:pending 3:pending');
    await plantools.exec('plan_write', { items: '乙\n丙' }, { chatId: CHAT });
    expect(table()).toBe('1:pending 2:pending');
  });
});

describe('plan_update：老协议静默失效的四种写法', () => {
  beforeEach(async () => {
    await plantools.exec('plan_write', { items: '甲\n乙\n丙' }, { chatId: CHAT });
  });

  it('正常那条照改，并且回执把整张表端回去', async () => {
    const r = await plantools.exec('plan_update', { seq: '2', status: 'doing' }, { chatId: CHAT });
    expect(table()).toBe('1:pending 2:doing 3:pending');
    expect(r.output).toContain('2. [doing] 乙');
    expect(r.output).toContain('3. [pending] 丙');
  });

  it('编号越界不再静默：说明不存在，并把当前列表原样列出（老标签协议这里一个字都不改）', async () => {
    const r = await plantools.exec('plan_update', { seq: '9', status: 'done' }, { chatId: CHAT });
    expect(r.error).toMatch(/编号 9 在当前计划里不存在/);
    expect(r.error).toContain('共 3 条');
    expect(r.error).toContain('1. [pending] 甲');
    expect(table()).toBe('1:pending 2:pending 3:pending');
  });

  it('状态词不在白名单里不再静默：直接给出四个合法值', async () => {
    const r = await plantools.exec('plan_update', { seq: '1', status: 'in_progress' }, { chatId: CHAT });
    expect(r.error).toMatch(/pending\/doing\/done\/failed/);
    expect(table()).toBe('1:pending 2:pending 3:pending');
  });

  it('idx 从 0 开始（老协议的第二种静默失效）现在明确报错', async () => {
    const r = await plantools.exec('plan_update', { seq: '0', status: 'done' }, { chatId: CHAT });
    expect(r.error).toMatch(/从 1 开始/);
  });

  it('置回 pending 是合法动作（老协议白名单里没有 pending，想撤回一条就只能改不动）', async () => {
    await plantools.exec('plan_update', { seq: '1', status: 'done' }, { chatId: CHAT });
    const r = await plantools.exec('plan_update', { seq: '1', status: 'pending' }, { chatId: CHAT });
    expect(r.error).toBeUndefined();
    expect(table()).toBe('1:pending 2:pending 3:pending');
  });

  it('failed 必须带得走原因摘要，面板靠它解释卡在哪；不填时补一句默认，别留空', async () => {
    await plantools.exec('plan_update', { seq: '2', status: 'failed', error: '端口被占用' }, { chatId: CHAT });
    expect(rows()[1].error_summary).toBe('端口被占用');
    await plantools.exec('plan_update', { seq: '3', status: 'failed' }, { chatId: CHAT });
    expect(rows()[2].error_summary).toBeTruthy();
    // 改回非 failed 时摘要要清掉，否则面板上挂着一条过期原因
    await plantools.exec('plan_update', { seq: '2', status: 'done' }, { chatId: CHAT });
    expect(rows()[1].error_summary).toBe('');
  });

  it('seq 给数字而不是字符串也认（原生 function calling 常按 schema 直觉传数）', async () => {
    const r = await plantools.exec('plan_update', { seq: 3, status: 'done' }, { chatId: CHAT });
    expect(r.error).toBeUndefined();
    expect(table()).toBe('1:pending 2:pending 3:done');
  });
});

describe('plan_list', () => {
  it('空列表说清「还没有」并指向 plan_write，而不是回一个空字符串', async () => {
    const r = await plantools.exec('plan_list', {}, { chatId: CHAT });
    expect(r.output).toMatch(/还没有计划任务/);
    expect(r.output).toContain('plan_write');
  });

  it('有列表就把编号 + 状态全端出来', async () => {
    await plantools.exec('plan_write', { items: '甲\n乙' }, { chatId: CHAT });
    await plantools.exec('plan_update', { seq: '1', status: 'done' }, { chatId: CHAT });
    const r = await plantools.exec('plan_list', {}, { chatId: CHAT });
    expect(r.output).toBe('1. [done] 甲\n2. [pending] 乙');
  });
});

describe('没有会话 ID 时（侧栏/托管直调、新会话首条消息前）', () => {
  it('建表明确拒绝并说明原因，不会写出孤儿行', async () => {
    const r = await plantools.exec('plan_write', { items: '甲' }, { chatId: null });
    expect(r.error).toMatch(/会话 ID/);
    expect(db.prepare('SELECT COUNT(*) c FROM tasks WHERE chat_id IS NULL').get().c).toBe(0);
  });
});

describe('设置页与挂载条件', () => {
  it('这三个工具没注册进 toolgate，所以设置→工具里不会出现（它的开关是会话的 Plan 模式）', () => {
    for (const n of ['plan_write', 'plan_update', 'plan_list']) {
      expect(toolgate.registry.has(n)).toBe(false);
      expect(toolgate.isGateTool(n)).toBe(false);
    }
    expect([...plantools.PLAN_NAMES].sort()).toEqual(['plan_list', 'plan_update', 'plan_write']);
  });

  it('挂载只跟 plan_mode 走：关着时 tools 清单里没有计划工具，也没有它们的说明', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../routes/ai.js'), 'utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
    const def = src.slice(src.indexOf('function activeAgentTools('), src.indexOf('function activeAgentTools(') + 260);
    expect(def).toMatch(/AGENT_TOOLS\.concat\(toolgate\.definitions\(\)\)\.concat\(planOn \? plantools\.PLAN_TOOLS : \[\]\)/);
    // 至少 5 处；关键是「不许出现不带参数的调用」——漏传 planMode 就等于 Plan 关着也发工具表。
    // 从 6 降到 5：maybeAutoCompress 的签名改成 opts（force）之后，它不再接收 msgs/tools ——
    // 那三个参数本来就是死的（函数内部只做压缩，不构造上游请求），留着只会让调用点误以为「传了才算」。
    expect((src.match(/activeAgentTools\(planMode\)/g) || []).length).toBeGreaterThanOrEqual(5);
    expect((src.match(/activeAgentTools\(\s*\)/g) || []).length).toBe(0);
    expect((src.match(/allToolSchemas\(planMode\)/g) || []).length).toBe(2);
    expect(src).toMatch(/buildCapabilityMap\(planMode\)/);
  });

  it('执行层在 toolgate 之前分派，且写完表立刻推 t:tasks 给右侧面板', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../routes/ai.js'), 'utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
    const head = src.slice(src.indexOf('  try {\n    // Plan 模式的计划任务工具'), src.indexOf('  try {\n    // Plan 模式的计划任务工具') + 600);
    expect(head.indexOf('plantools.PLAN_NAMES.has(name)')).toBeLessThan(head.indexOf('toolgate.isGateTool(name)'));
    expect(src).toMatch(/plantools\.PLAN_NAMES\.has\(name\) && !result\.error\) send\(\{ t: 'tasks', tasks: getTasks\(chatId\) \}\)/);
  });

  it('提示词不再教标签，改教工具，并且明说标签已废弃', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../routes/ai.js'), 'utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
    const block = src.slice(src.indexOf('if (planMode) {\n    lines.push'), src.indexOf('const apiNotes = toolgate.promptNotes()'));
    expect(block).toContain('plan_write');
    expect(block).toContain('plan_update');
    expect(block).toContain('plan_list');
    expect(block).toMatch(/已废弃|不要再写/);
    expect(block).not.toMatch(/'<task-status idx="1" status="doing"\/>'/);
  });
});
