/**
 * 上下文 / 压缩 —— opencode 口径（第一百一十五轮重写）。
 *
 * 这一轮把旧账整个换掉了，所以用例也只测新口径，不再保留旧的三层取大 / 高水位 / EMA：
 *
 *   ① 工具调用与工具结果**入库**（ai_chat_parts），下一发按顺序重放；
 *   ② 落库即裁剪（50KiB / 2000 行触发，保留头 800 行 + 尾 200 行、总量 ≤12k tok），
 *      中间那段不丢弃工具：read_file 带 offset/limit 能按行精确取回；
 *      总量超预算时把最旧的整条换成占位符；
 *   ③ 用量 = 校准尺 ×（库里能重放出来的整包 + 未入库输出）——
 *      没有高水位，没有「按历史最大一发推断能力」，窗口只认「你设的 / 模型声明的 / 全局默认」，撞墙才封顶；
 *   ④ 压缩线 = floor(min(W×0.8, W − 输出预留 − 64k))，分母就是你设的窗口。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-ctx115-'));
const DATA = path.join(T, 'data');
fs.mkdirSync(DATA, { recursive: true });
process.env.KH_DATA_DIR = DATA;

let ctx;
let parts;
let db;
let database;

const mkProv = () => Number(db.prepare(
  "INSERT INTO ai_providers (name, base_url, api_key, api_style) VALUES ('t','https://x.invalid/v1','k','openai')").run().lastInsertRowid);
const mkModel = (provId, maxContext = 0) => Number(db.prepare(
  "INSERT INTO ai_models (provider_id, model_id, display_name, max_context) VALUES (?, 'm', 'm', ?)").run(provId, maxContext).lastInsertRowid);
const mkChat = (limit = 0, modelId = null) => Number(db.prepare(
  'INSERT INTO ai_chats (user_id, title, context_limit, model_row_id) VALUES (1, ?, ?, ?)').run('t', limit, modelId).lastInsertRowid);
const mkMsg = (chatId, role, content) => Number(db.prepare(
  'INSERT INTO ai_chat_messages (chat_id, role, content) VALUES (?, ?, ?)').run(chatId, role, content).lastInsertRowid);

beforeAll(() => {
  database = nodeRequire('../database');
  database.initDatabase();
  db = database.db;
  ctx = nodeRequire('../routes/ai')._internal;
  parts = nodeRequire('../utils/ctxparts.js');
});

afterAll(() => { try { fs.rmSync(T, { recursive: true, force: true }); } catch (e) { /* 句柄还开着 */ } });

describe('① 工具往返入库并按序重放', () => {
  it('user → assistant(tool_calls) → tool(结果) → assistant(最终回复) 顺序不变', () => {
    const c = mkChat(200000);
    const uid = mkMsg(c, 'user', '帮我看一下 package.json');
    // 第 1 轮：模型先说一句、再调工具
    ctx.appendChatPart(c, uid, { kind: 'text', payload: '我先读一下这个文件', meta: { reasoning: '想一想' } });
    ctx.appendChatPart(c, uid, { kind: 'tool_call', call_id: 'call_1', name: 'read_file', payload: '{"path":"package.json"}', meta: {} });
    ctx.appendToolResultPart(c, uid, { id: 'call_1', name: 'read_file' }, '{"name":"kharness","version":"1.4.4"}', false);
    // 回合结束落最终回复（界面气泡的正文）
    mkMsg(c, 'assistant', '我先读一下这个文件\n\n这是 package.json 的内容：kharness 1.4.4');

    const a = ctx.assembleHistoryBase(c);
    expect(a.msgs.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    const call = a.msgs[1];
    expect(call.tool_calls[0].id).toBe('call_1');
    expect(call.tool_calls[0].function.name).toBe('read_file');
    expect(call.reasoning_content).toBe('想一想');
    expect(a.msgs[2].tool_call_id).toBe('call_1');
    expect(a.msgs[2].content).toContain('1.4.4');
    // 最终回复只留「部件里没有的那一段」：中间那句已在 assistant(tool_calls) 里发过
    expect(a.msgs[3].content).toContain('这是 package.json 的内容');
    expect(a.msgs[3].content).not.toContain('我先读一下这个文件');
  });

  it('多轮工具往返：每个 tool_calls 后面紧跟对应的 tool 结果', () => {
    const c = mkChat(200000);
    const uid = mkMsg(c, 'user', '读两个文件');
    for (const n of [1, 2]) {
      ctx.appendChatPart(c, uid, { kind: 'text', payload: `第 ${n} 次读取`, meta: {} });
      ctx.appendChatPart(c, uid, { kind: 'tool_call', call_id: `c${n}`, name: 'read_file', payload: `{"path":"f${n}"}`, meta: {} });
      ctx.appendToolResultPart(c, uid, { id: `c${n}`, name: 'read_file' }, `内容 ${n}`, false);
    }
    mkMsg(c, 'assistant', '第 1 次读取\n第 2 次读取\n两个文件都读完了');
    const a = ctx.assembleHistoryBase(c);
    expect(a.msgs.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant']);
    expect(a.msgs[2].content).toBe('内容 1');
    expect(a.msgs[4].content).toBe('内容 2');
    expect(a.msgs[5].content).toContain('两个文件都读完了');
  });

  it('没有部件的回合仍走旧路（历史消息原样进上下文）', () => {
    const c = mkChat(200000);
    mkMsg(c, 'user', '你好');
    mkMsg(c, 'assistant', '你好，有什么要帮忙的？');
    const a = ctx.assembleHistoryBase(c);
    expect(a.msgs.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(a.msgs[1].content).toBe('你好，有什么要帮忙的？');
  });

  it('被压缩归档的回合：正文和工具往返一起从上下文里消失（只留摘要）', () => {
    const c = mkChat(200000);
    const uid = mkMsg(c, 'user', '旧问题');
    ctx.appendChatPart(c, uid, { kind: 'tool_call', call_id: 'c9', name: 'read_file', payload: '{}', meta: {} });
    ctx.appendToolResultPart(c, uid, { id: 'c9', name: 'read_file' }, '旧文件内容', false);
    mkMsg(c, 'assistant', '旧回答');
    db.prepare('UPDATE ai_chat_messages SET archived = 1 WHERE chat_id = ?').run(c);
    db.prepare('UPDATE ai_chats SET summary = ? WHERE id = ?').run('之前的对话讲了旧问题。', c);
    const a = ctx.assembleHistoryBase(c);
    expect(a.msgs.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(a.msgs[0].content).toContain('摘要');
    expect(JSON.stringify(a.msgs)).not.toContain('旧文件内容');
  });

  it('文本协议的回合：结果按 user 消息的壳重放（没有 tool 通道）', () => {
    const c = mkChat(200000);
    const uid = mkMsg(c, 'user', '读文件');
    ctx.appendChatPart(c, uid, { kind: 'text', payload: '{"tool":"read_file","args":{"path":"a"}}', meta: {} });
    ctx.appendToolResultPart(c, uid, { id: 'x', name: 'read_file' }, '文件内容', true);
    mkMsg(c, 'assistant', '读完了');
    const a = ctx.assembleHistoryBase(c);
    expect(a.msgs.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(a.msgs[2].content).toContain('文件内容');
    expect(a.msgs[2].content).toContain('read_file');
  });
});

describe('② pruner：单条裁剪 + 总量清理', () => {
  // 3000 行、每行约 8 字：行数越过 2000 的触发线（这是读源码最常见的形状）
  const bigSource = Array.from({ length: 3000 }, (_, i) => `第${i + 1}行内容`).join('\n');

  it('行数超限：保留头 800 行 + 尾 200 行，中间标注「哪几行没发出来」', () => {
    const out = parts.pruneToolOutput(bigSource, { spill: false });
    expect(out.meta.truncated).toBe(true);
    expect(out.meta.raw_lines).toBe(3000);
    expect(out.meta.head_lines).toBe(800);
    expect(out.meta.tail_lines).toBe(200);
    expect(out.meta.omitted_lines).toBe(2000);
    expect(out.text).toContain('工具结果过大已裁剪');
    // 头尾都在，中间不在
    expect(out.text).toContain('第1行内容');
    expect(out.text).toContain('第800行内容');
    expect(out.text).toContain('第2801行内容');
    expect(out.text).toContain('第3000行内容');
    expect(out.text).not.toContain('第1500行内容');
    // 标记要给出「怎么重新取」：offset/limit，而不是让它整份重读
    expect(out.text).toContain('offset=');
    expect(out.text).toContain('limit=');
  });

  it('被裁掉的中间那一段能用 read_file 的 offset/limit 取回来（裁剪不再是死路）', () => {
    const out = parts.pruneToolOutput(bigSource, { spill: false });
    expect(out.text).not.toContain('第1500行内容');
    const w = ctx.readFileWindow(bigSource, 1400, 300, 'big.js');
    expect(w.start).toBe(1400);
    expect(w.end).toBe(1699);
    expect(w.more).toBe(true);
    expect(w.text).toContain('第1500行内容');
    expect(w.text).toContain('共 3000 行');
    expect(w.text).toContain('offset=1700');   // 下一段怎么取，写在标记里
  });

  it('单行超长（bundle / 压缩 css）：按 token 硬顶切，不按行', () => {
    const oneLine = 'x'.repeat(200000);
    const out = parts.pruneToolOutput(oneLine, { spill: false });
    expect(out.meta.truncated).toBe(true);
    expect(out.meta.by_tokens).toBe(true);
    expect(out.meta.tokens).toBeLessThanOrEqual(parts.TOOL_MAX_TOKENS + 300);
  });

  it('read_file 走真实工具链：不传分页=整份，传 offset/limit=只回那几行并标行号', async () => {
    const f = path.join(T, 'big.js');
    fs.writeFileSync(f, bigSource, 'utf8');
    // 不传分页：整份返回（老行为，裁剪交给 pruner）
    const whole = await ctx.execTool('read_file', { path: 'big.js' }, T);
    expect(whole.output.split('\n').length).toBe(3000);
    // 传 offset/limit：只回第 1400–1499 行，并标出「第 X–Y 行 / 共 N 行」与下一段 offset
    const page = await ctx.execTool('read_file', { path: 'big.js', offset: 1400, limit: 100 }, T);
    const pageLines = page.output.split('\n');
    expect(pageLines[0]).toContain('第 1400–1499 行 / 共 3000 行');
    expect(pageLines[0]).toContain('offset=1500');
    expect(page.output).toContain('第1400行内容');
    expect(page.output).toContain('第1499行内容');
    expect(page.output).not.toContain('第1500行内容');
    // offset 越界：说清楚文件只有多少行，不是静默回空
    const over = await ctx.execTool('read_file', { path: 'big.js', offset: 9999 }, T);
    expect(over.output).toContain('只到第 3000 行');
  });

  it('预算内的结果一个字都不动', () => {
    const text = '短结果 hello';
    const out = parts.pruneToolOutput(text, { spill: false });
    expect(out.meta.truncated).toBe(false);
    expect(out.text).toBe(text);
  });

  it('总量超预算时最旧的结果被换成占位符，并写回库（不会被下一次装配捞回来）', () => {
    const c = mkChat(100000);   // budget = 10% = 10000 tok, protect = 5000 tok
    const uid = mkMsg(c, 'user', '连读几份大文件');
    for (let i = 0; i < 6; i++) {
      ctx.appendChatPart(c, uid, { kind: 'tool_call', call_id: `c${i}`, name: 'read_file', payload: '{}', meta: {} });
      // 每条约 4.6k tok（中文 1 tok/字）、12000 字，单条既没到 50KiB 也没到 2000 行，不触发单条裁剪
      ctx.appendToolResultPart(c, uid, { id: `c${i}`, name: 'read_file' }, `文件${i}`.repeat(2000), false);
    }
    mkMsg(c, 'assistant', '都读完了');
    const cleaned = ctx.pruneToolParts(c, 100000);
    expect(cleaned).toBeGreaterThan(0);
    const rows = db.prepare("SELECT payload FROM ai_chat_parts WHERE chat_id = ? AND kind = 'tool_result' ORDER BY id ASC").all(c);
    expect(rows[0].payload).toContain('较早的工具结果已清理');
    // 最新的那条一定还在（受保护的那一段 = 当前依据）
    expect(rows[rows.length - 1].payload).toContain('文件5');
    // 再装配一次：占位符是库里的事实，不会被原内容覆盖回来
    const a = ctx.assembleHistoryBase(c);
    const toolMsgs = a.msgs.filter(m => m.role === 'tool');
    expect(toolMsgs[0].content).toContain('较早的工具结果已清理');
    expect(toolMsgs[toolMsgs.length - 1].content).toContain('文件5');
  });
});

describe('③ 用量口径：整包 × 校准尺，不推断窗口', () => {
  it('设 1,000,000 就按 1,000,000 算（不因为历史最大一发而变小）', () => {
    const prov = mkProv();
    const model = mkModel(prov, 0);
    const c = mkChat(1000000, model);
    const uid = mkMsg(c, 'user', '写一段很长的东西');
    // 历史上真的吃过 478,320 的一发 —— 那只能证明「至少能装这么多」，不能反过来当上限
    db.prepare('INSERT INTO usage_log (chat_id, model_row_id, prompt_tokens, completion_tokens) VALUES (?,?,?,0)').run(c, model, 478320);
    ctx.appendChatPart(c, uid, { kind: 'text', payload: '好', meta: {} });
    mkMsg(c, 'assistant', '好');
    const u = ctx.chatContextUsage(c);
    expect(u.limit).toBe(1000000);
    expect(u.configured_limit).toBe(1000000);
  });

  it('撞过输入超长才封顶：limit = 天花板，configured 保留你设的原值', () => {
    const c = mkChat(1000000);
    ctx.noteCeiling(c, 380000);
    const u = ctx.chatContextUsage(c);
    expect(u.limit).toBe(380000);
    expect(u.configured_limit).toBe(1000000);
  });

  it('工具结果入库后用量跟着涨；高水位列不再影响显示', () => {
    const c = mkChat(200000);
    const uid = mkMsg(c, 'user', '读文件');
    mkMsg(c, 'assistant', '读完');
    const before = ctx.chatContextUsage(c).used;
    ctx.appendChatPart(c, uid, { kind: 'tool_call', call_id: 'c1', name: 'read_file', payload: '{}', meta: {} });
    ctx.appendToolResultPart(c, uid, { id: 'c1', name: 'read_file' }, '内容'.repeat(3000), false);
    const after = ctx.chatContextUsage(c).used;
    expect(after).toBeGreaterThan(before + 3000);
    // 旧的高水位字段（历史数据里可能是个很大的数）一个字都不许影响 used
    db.prepare('UPDATE ai_chats SET ctx_high_water_tokens = 999999 WHERE id = ?').run(c);
    expect(ctx.chatContextUsage(c).used).toBe(after);
  });

  it('校准值只作诊断：used 不乘任何缩放系数（opencode / DSH 都没有这个乘数）', () => {
    const c = mkChat(200000);
    mkMsg(c, 'user', '你好');
    ctx.recordContextAnchor(c, { prompt_tokens: 2000, completion_tokens: 0 });
    const u1 = ctx.chatContextUsage(c);
    // 诊断值 = 真实 prompt ÷ 当时的本地整包估算，只写库给调试看
    expect(u1.calib).toBeGreaterThan(0);
    expect(u1.anchored).toBe(true);
    // 刚记完锚点、内容没变：used 就是锚点本身（2000 + 0），不乘系数、不加高水位
    expect(u1.used).toBe(2000);
    // 之后再添一段内容：增量按本地估算 1:1 加上，误差不放大到历史之上
    mkMsg(c, 'user', '再说一句'.repeat(50));
    const u2 = ctx.chatContextUsage(c);
    expect(u2.used - u1.used).toBe(u2.body - u1.body);
  });

  it('锚点口径是「整发」：completion / reasoning 也算进去（opencode 的 measured）', () => {
    const c = mkChat(200000);
    mkMsg(c, 'user', '你好');
    ctx.recordContextAnchor(c, { prompt_tokens: 2000, completion_tokens: 300, reasoning_tokens: 200 });
    const u = ctx.chatContextUsage(c);
    expect(u.used).toBe(2500);
    expect(u.anchor_real).toBe(2500);
  });

  it('工具轮吃过 20 万之后：锚点不让数字塌回去（这是 opencode 口径的关键）', () => {
    const c = mkChat(1000000);
    mkMsg(c, 'user', '读了一堆文件');
    // 工具轮那一发：本地估 19 万、上游真回执 20 万
    ctx.recordContextAnchor(c, { prompt_tokens: 200000, completion_tokens: 500 }, 190000);
    const u = ctx.chatContextUsage(c);
    // 库里现在只有一条短消息，但锚点是真值 —— 显示必须仍然≈20 万，而不是掉回几百
    expect(u.used).toBeGreaterThanOrEqual(200000);
    expect(u.used).toBeLessThan(201000);
  });

  it('生成中未入库的输出也算进 used（涨），清空后回到整包口径', () => {
    const c = mkChat(200000);
    mkMsg(c, 'user', '你好');
    const base = ctx.chatContextUsage(c).used;
    ctx.addLiveOut(c, '正在输出'.repeat(500));
    expect(ctx.chatContextUsage(c).used).toBeGreaterThan(base);
    ctx.clearLiveOut(c);
    expect(ctx.chatContextUsage(c).used).toBe(base);
  });
});

describe('④ 压缩线', () => {
  it('W=1,000,000：min(80万, 100万−8192−65536) = 800,000（比例更小）', () => {
    const c = mkChat(1000000);
    expect(ctx.resolveCompressLine(c, 1000000, 80)).toBe(800000);
  });

  it('W=200,000：80% 与「扣预留」取小 = 126,272', () => {
    const c = mkChat(200000);
    expect(ctx.resolveCompressLine(c, 200000, 80)).toBe(126272);
  });
});

describe('⑤ 撤回 / 压缩后用量真的变小', () => {
  it('删掉部件与消息之后，used 回到删除前之下', () => {
    const c = mkChat(200000);
    const uid = mkMsg(c, 'user', '读个文件');
    ctx.appendChatPart(c, uid, { kind: 'tool_call', call_id: 'c1', name: 'read_file', payload: '{}', meta: {} });
    ctx.appendToolResultPart(c, uid, { id: 'c1', name: 'read_file' }, '大内容'.repeat(2000), false);
    mkMsg(c, 'assistant', '读完了');
    const before = ctx.chatContextUsage(c).used;
    db.prepare('DELETE FROM ai_chat_messages WHERE chat_id = ? AND id >= ?').run(c, uid);
    db.prepare('DELETE FROM ai_chat_parts WHERE chat_id = ? AND turn_id >= ?').run(c, uid);
    ctx.settleContextAfterRetract(c, null);
    expect(ctx.chatContextUsage(c).used).toBeLessThan(before);
  });
});
