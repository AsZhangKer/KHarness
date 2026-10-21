/**
 * 上下文 / 压缩 —— opencode 口径（第一百一十五轮重写）。
 *
 * 这一轮把旧账整个换掉了，所以用例也只测新口径，不再保留旧的三层取大 / 高水位 / EMA：
 *
 *   ① 工具调用与工具结果**入库**（ai_chat_parts），下一发按顺序重放；
 *   ② 落库即裁剪（50KiB / 2000 行触发，保留头 800 行 + 尾 200 行、总量 ≤12k tok），
 *      中间那段不丢弃工具：read_file 带 offset/limit 能按行精确取回；
 *      历史总量削减**只在上下文到压缩线时**发生，当前回合的结果永不清理（118 轮修正）；
 *   ③ 用量 = 锚点(真 token) + 整包增量，不乘校准尺 ——
 *      没有高水位，没有「按历史最大一发推断能力」，窗口只认「你设的 / 模型声明的 / 全局默认」，撞墙才封顶；
 *   ④ 压缩线 = floor(min(W×0.8, W − 输出预留 − 64k))，分母就是你设的窗口。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
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

  it('没到压缩线：历史工具结果一条都不动（118 轮事故：16% 就被抹成占位符）', () => {
    const c = mkChat(200000);
    const uid = mkMsg(c, 'user', '连读几份大文件');
    for (let i = 0; i < 6; i++) {
      ctx.appendChatPart(c, uid, { kind: 'tool_call', call_id: `c${i}`, name: 'read_file', payload: '{}', meta: {} });
      ctx.appendToolResultPart(c, uid, { id: `c${i}`, name: 'read_file' }, `文件${i}`.repeat(2000), false);
    }
    mkMsg(c, 'assistant', '都读完了');
    // 用了 32,000 tok（16%），压缩线 128,000 —— 远没到线，一个字都不许动
    expect(ctx.pruneToolParts(c, 200000, { line: 128000, used: 32000 })).toBe(0);
    const rows = db.prepare("SELECT payload FROM ai_chat_parts WHERE chat_id = ? AND kind = 'tool_result' ORDER BY id ASC").all(c);
    for (let i = 0; i < rows.length; i++) expect(rows[i].payload).toContain(`文件${i}`);
  });

  it('到了压缩线才削：只削到线下方，且当前回合的结果一条不动', () => {
    const c = mkChat(200000);
    // 较早的回合：5 条大结果（每条约 6000 tok）
    const old = mkMsg(c, 'user', '先读一批文件');
    for (let i = 0; i < 5; i++) {
      ctx.appendChatPart(c, old, { kind: 'tool_call', call_id: `o${i}`, name: 'read_file', payload: '{}', meta: {} });
      ctx.appendToolResultPart(c, old, { id: `o${i}`, name: 'read_file' }, `旧文件${i}`.repeat(1500), false);
    }
    mkMsg(c, 'assistant', '读完了');
    // 当前回合：1 条大结果 —— 这是模型下一步的依据，绝不能清
    const cur = mkMsg(c, 'user', '再看看这个');
    ctx.appendChatPart(c, cur, { kind: 'tool_call', call_id: 'n0', name: 'read_file', payload: '{}', meta: {} });
    ctx.appendToolResultPart(c, cur, { id: 'n0', name: 'read_file' }, '新文件'.repeat(3000), false);

    // 130,000 tok 已过 128,000 的压缩线 → 允许削「较早回合」的结果
    const cleaned = ctx.pruneToolParts(c, 200000, { line: 128000, used: 130000 });
    expect(cleaned).toBeGreaterThan(0);
    const rows = db.prepare("SELECT turn_id, payload FROM ai_chat_parts WHERE chat_id = ? AND kind = 'tool_result' ORDER BY id ASC").all(c);
    expect(rows[0].payload).toContain('较早的工具结果已清理');
    // 当前回合那条必须原样
    const now = rows.filter(r => r.turn_id === cur);
    expect(now.length).toBe(1);
    expect(now[0].payload).toContain('新文件');
    // 再装配一次：占位符是库里的事实，不会被原内容覆盖回来
    const a = ctx.assembleHistoryBase(c);
    const toolMsgs = a.msgs.filter(m => m.role === 'tool');
    expect(toolMsgs[0].content).toContain('较早的工具结果已清理');
    expect(toolMsgs[toolMsgs.length - 1].content).toContain('新文件');
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

  it('撞过输入超长也不改分母（opencode / DSH 都不改窗口），ceiling 只留作诊断', () => {
    const c = mkChat(1000000);
    ctx.noteCeiling(c, 380000);
    const u = ctx.chatContextUsage(c);
    expect(u.limit).toBe(1000000);            // 你设的 100 万就是 100 万
    expect(u.configured_limit).toBe(1000000);
    expect(u.ceiling).toBe(380000);           // 事实记着，但不参与判定
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

  it('W=200,000：余量按窗口 8% 缩放（16k），阈值真的生效 = 160,000', () => {
    const c = mkChat(200000);
    expect(ctx.resolveCompressLine(c, 200000, 80)).toBe(160000);
  });

  it('改阈值就改线：同一窗口 60% / 80% / 95% 得到三个不同的点', () => {
    const c = mkChat(200000);
    expect(ctx.resolveCompressLine(c, 200000, 60)).toBe(120000);
    expect(ctx.resolveCompressLine(c, 200000, 95)).toBe(175808);   // 被「窗口−输出预留(8192)−余量(16000)」兜住
    // 12.8 万窗口：以前 60/80/95 全是 54,272，现在各归各位
    const c2 = mkChat(128000);
    expect(ctx.resolveCompressLine(c2, 128000, 60)).toBe(76800);
    expect(ctx.resolveCompressLine(c2, 128000, 80)).toBe(102400);
  });
});

describe('⑥ 压缩保留：条数是下限，token 才是目标（opencode 的 keep=15k）', () => {
  const mkRows = (n, chars) => Array.from({ length: n }, (_, i) => ({ id: i + 1, content: '字'.repeat(chars) }));
  const noParts = new Map();

  it('20 条各 1000 tok：留最近 15 条（累计到 15k 就停）', () => {
    expect(ctx.compressKeepCount(mkRows(20, 1000), noParts, 2, 15000)).toBe(15);
  });

  it('总量不到 15k：全部保留（压不动就是压不动）', () => {
    expect(ctx.compressKeepCount(mkRows(5, 1000), noParts, 2, 15000)).toBe(5);
  });

  it('keepTokens=0 时退回「只留设置里的条数」', () => {
    expect(ctx.compressKeepCount(mkRows(20, 1000), noParts, 3, 0)).toBe(3);
  });

  it('工具往返算进保留量：最后一条挂着 20k tok 的工具结果，留 1 条就够', () => {
    const rows = mkRows(3, 10);
    const parts = new Map([[3, [
      { kind: 'tool_result', payload: 'x', meta: { tokens: 20000 } },
    ]]]);
    expect(ctx.compressKeepCount(rows, parts, 1, 15000)).toBe(1);
  });

  it('下限不会超过消息总数（少到没有可压的）', () => {
    expect(ctx.compressKeepCount(mkRows(2, 10), noParts, 5, 15000)).toBe(2);
  });
});

describe('⑦ 压缩链路（假上游，不花额度）', () => {
  // ai.js 用的是 require('undici').fetch，patch global.fetch 没用 —— 起一个真的本地 HTTP 假上游。
  const withFakeUpstream = async (reply, fn) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        srv.lastPrompt = (() => { try { return JSON.parse(body).messages[0].content || ''; } catch (e) { return ''; } })();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      return await fn(`http://127.0.0.1:${srv.address().port}/v1`, srv);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  };

  it('保留 15k token：旧的归档进摘要、最近的原地留下；摘要按模板写入', async () => {
    const c = mkChat(200000);
    for (let i = 0; i < 30; i++) mkMsg(c, i % 2 ? 'assistant' : 'user', '字'.repeat(1000));   // 每条 ≈1000 tok
    const r = await withFakeUpstream('## 目标\n- 干活\n## 下一步\n- 继续', async (base, srv) => {
      const row = { model_id: 'm', display_name: 'm', api_style: 'openai', base_url: base, api_key: 'k', max_tokens: 8192 };
      const out = await ctx.compressChat(c, row, undefined, undefined);
      return { out, prompt: srv.lastPrompt };
    });
    expect(r.out.skipped).toBe(false);
    expect(r.out.archived).toBe(15);                 // 30k 总量，留最近 15k
    const left = db.prepare('SELECT COUNT(*) AS n FROM ai_chat_messages WHERE chat_id = ? AND COALESCE(archived, 0) = 0').get(c).n;
    expect(left).toBe(15);
    const sum = db.prepare('SELECT summary FROM ai_chats WHERE id = ?').get(c).summary;
    expect(sum).toContain('## 目标');
    // prompt 是结构化模板，并且明确要求「不要复述 AGENTS.md / 工具说明」
    expect(r.prompt).toContain('## 目标');
    expect(r.prompt).toContain('AGENTS.md');
    expect(r.prompt).toContain('不要调用工具');
  });

  it('待压缩部分太小就不压（净收益≈0，别白丢原话）', async () => {
    const c = mkChat(200000);
    for (let i = 0; i < 16; i++) mkMsg(c, i % 2 ? 'assistant' : 'user', '字'.repeat(1000));   // 16k
    let hit = 0;
    const srv = http.createServer((req, res) => { hit++; res.writeHead(500); res.end('should not be called'); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const row = { model_id: 'm', display_name: 'm', api_style: 'openai', base_url: `http://127.0.0.1:${srv.address().port}/v1`, api_key: 'k', max_tokens: 8192 };
      const r = await ctx.compressChat(c, row, undefined, undefined);
      expect(r.skipped).toBe(true);
      expect(hit).toBe(0);                     // 连一次摘要请求都没发
    } finally {
      await new Promise((r) => srv.close(r));
    }
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
