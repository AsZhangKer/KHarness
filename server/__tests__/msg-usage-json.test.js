/**
 * 第七十四轮 ⑤ 的服务端那一半：本轮 token 明细随消息落库（ai_chat_messages.usage_json）。
 *
 * 最要紧的是**升级老库不能出事**：他那份 kh.db 里是真实对话与真实密钥，这条 ALTER 会在
 * 他下次启动时对整库执行。所以这里先手造一份「这次改动之前的库」（只有基列表 + 两行老数据），
 * 再让真的 database.js 去开它，量三件事：列加上了、老数据一行没丢、重复执行不炸。
 * 然后才量新写的这一列存得进、读得出。
 *
 * 端到端（真跑一轮上游回执 → 落库 → GET /ai/chats/:id 读回 m.usage）由
 * `_tmp_kh74/usage_persist.js` 探针量，这里不重复起服务。
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);
const Database = nodeRequire('better-sqlite3');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-usage-'));
const DATA = path.join(T, 'data');
fs.mkdirSync(DATA, { recursive: true });

// 老库形状：这次改动之前（甚至最早）的那张表只有这几列，剩下的全靠 MIGRATIONS 往上加
const old = new Database(path.join(DATA, 'kh.db'));
old.exec(`CREATE TABLE ai_chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
old.exec(`INSERT INTO ai_chat_messages (chat_id, role, content) VALUES
  (1, 'user', 'OLD-ROW-一'), (1, 'assistant', 'OLD-ROW-二')`);
const beforeCount = old.prepare('SELECT COUNT(*) c FROM ai_chat_messages').get().c;
old.close();

process.env.KH_DATA_DIR = DATA;   // config.js 在 require 时读它，必须先设再 import
const { db, initDatabase } = await import('../database.js');
// 建表 + 迁移不是 import 时自动跑的（跑在 server/index.js 启动那一下），这里照启动的顺序来
initDatabase();

const cols = () => db.prepare('PRAGMA table_info(ai_chat_messages)').all().map((c) => c.name);

afterAll(() => {
  try { db.close(); } catch (e) { /* 已关 */ }
  try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* 留给系统清 */ }
});

describe('老库升上来', () => {
  it('usage_json 这一列加上了', () => {
    expect(cols()).toContain('usage_json');
    // 顺带确认这条列的形态：可空 TEXT（没明细的老消息就该是 NULL，不是空串）
    const c = db.prepare('PRAGMA table_info(ai_chat_messages)').all().find((x) => x.name === 'usage_json');
    expect(c.type).toBe('TEXT');
    expect(c.notnull).toBe(0);
  });

  it('老对话一行都没丢，内容原样（升级不能动数据）', () => {
    const rows = db.prepare('SELECT * FROM ai_chat_messages ORDER BY id').all();
    expect(rows.length).toBe(beforeCount);
    expect(rows.map((r) => r.content)).toEqual(['OLD-ROW-一', 'OLD-ROW-二']);
    // 老行补上来的是 NULL（没明细就是没明细，不该是 '{}' 或 0 一串）
    expect(rows[0].usage_json).toBeNull();
  });

  it('重复执行这条迁移不炸（duplicate column 被 runner 咽掉）', () => {
    let threw = null;
    try { db.prepare('ALTER TABLE ai_chat_messages ADD COLUMN usage_json TEXT').run(); }
    catch (e) { threw = e.message; }
    expect(threw).toMatch(/duplicate column/i);
    // runner 的判据就是这条正则，这里把「为什么它敢 try/catch」钉住
    expect(/duplicate column/i.test(String(threw))).toBe(true);
    expect(cols().filter((c) => c === 'usage_json').length).toBe(1);
  });
});

describe('写入与读回', () => {
  // 与 routes/ai.js 里那条 insertAssistantMsg 同一份列清单
  const insert = db.prepare(
    'INSERT INTO ai_chat_messages (chat_id, role, content, model_row_id, reasoning, steps_json, unfinished, usage_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );

  it('一轮明细存得进、读得出（四格 + 轮次都在同一份 JSON 里）', () => {
    const turn = { prompt_tokens: 5619, completion_tokens: 312, cached_tokens: 4096, reasoning_tokens: 120, rounds: 3 };
    insert.run(7, 'assistant', '回答', 1, null, null, 0, JSON.stringify(turn));
    const row = db.prepare('SELECT * FROM ai_chat_messages WHERE chat_id = 7 ORDER BY id DESC LIMIT 1').get();
    const back = JSON.parse(row.usage_json);
    expect(back).toEqual(turn);
  });

  it('被审查拦掉那一类没有明细的消息落 NULL，读回时是「没数」而不是 0 一堆', () => {
    insert.run(8, 'assistant', '敏感词拦下', 1, null, null, null, null);
    const row = db.prepare("SELECT usage_json FROM ai_chat_messages WHERE chat_id = 8").get();
    expect(row.usage_json).toBeNull();
  });

  it('GET 那一路只把解析好的 usage 交给前端，原始 JSON 字符串不外泄', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../routes/ai.js'), 'utf8');
    const sec = src.slice(src.indexOf("router.get('/chats/:id'"), src.indexOf("router.get('/chats/:id'") + 3000);
    expect(sec).toContain('msg.usage_json');
    expect(sec).toMatch(/m\.usage = JSON\.parse\(m\.usage_json\)/);
    expect(sec).toContain('delete m.usage_json');
  });

  it('回合结束与中断那两处插入都带上了这一列（不能只补正常收尾那条路）', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../routes/ai.js'), 'utf8');
    const runs = src.match(/insertAssistantMsg\.run\(/g) || [];
    const withUsage = src.match(/insertAssistantMsg\.run\([\s\S]{0,900}?\bturnUsage \? JSON\.stringify\(turnUsage\) : null\)/g) || [];
    expect(runs.length).toBe(3);
    expect(withUsage.length).toBe(2);
  });
});
