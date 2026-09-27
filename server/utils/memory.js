// 长期记忆：跨会话、跨项目持久化的一小段知识（偏好、约定、环境事实）。
// 存 ai_memories 表；检索名统一 kebab-case 短名，正文 ≤ 4000 字，同名 upsert 覆盖。
const { db } = require('../database');

const MAX_CONTENT = 4000;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function ensureTable() {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS ai_memories (
      name TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`).run();
  } catch (e) { /* 建表失败时上层按空处理 */ }
}

// 宽松归一：小写、空格/下划线转连字符、去掉 B 站式重复前缀符号
function normalizeName(raw) {
  return String(raw || '').trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
}

function rowOf(name) {
  ensureTable();
  try { return db.prepare('SELECT * FROM ai_memories WHERE name = ?').get(name) || null; } catch (e) { return null; }
}

function allRows() {
  ensureTable();
  try { return db.prepare('SELECT name, length(content) AS len, updated_at FROM ai_memories ORDER BY name').all(); }
  catch (e) { return []; }
}

function write(name, content) {
  const n = normalizeName(name);
  if (!n) return { error: 'memory_write:name 不能为空。用 kebab-case 短名，如 coding-style、preferred-lang、deploy-host。' };
  if (!NAME_RE.test(n)) return { error: `memory_write:name 只允许小写字母、数字与连字符（1-64 位），收到「${n}」。示例：coding-style` };
  const body = String(content ?? '').trim();
  if (!body) return { error: 'memory_write:content 不能为空（要删除记忆请让用户在设置里删，或写明新的替代内容）。' };
  if (body.length > MAX_CONTENT) return { error: `memory_write:content ${body.length} 字，超过单条上限 ${MAX_CONTENT} 字。请拆成几条更聚焦的记忆，或压缩成要点。` };
  ensureTable();
  const existed = !!rowOf(n);
  try {
    db.prepare(`INSERT INTO ai_memories (name, content, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(name) DO UPDATE SET content = excluded.content, updated_at = CURRENT_TIMESTAMP`).run(n, body);
  } catch (e) { return { error: `memory_write:写入失败：${String(e.message || e).substring(0, 160)}` }; }
  return { output: `已${existed ? '更新' : '保存'}记忆「${n}」（${body.length} 字）。这条记忆对所有项目和会话可见，下次会话用 memory_read("${n}") 取回。` };
}

function read(name) {
  const n = normalizeName(name);
  if (!n) return { error: 'memory_read:name 不能为空。先调 memory_list 看有哪些名字。' };
  const row = rowOf(n);
  if (row) return { output: `【记忆：${row.name}】（更新于 ${row.updated_at}）\n${row.content}` };
  const rows = allRows();
  const near = rows.filter(r => r.name.includes(n) || n.includes(r.name)).slice(0, 8).map(r => r.name);
  return {
    error: `memory_read:没有名为「${n}」的记忆。` +
      (near.length ? `名字相近的有：${near.join('、')}。` : '') +
      `完整清单用 memory_list（记忆名区分不了就先列清单，别猜）。`
  };
}

function list() {
  const rows = allRows();
  if (!rows.length) return { output: '当前没有任何长期记忆。需要沉淀用户偏好/环境事实/项目约定时用 memory_write(name, content) 保存。' };
  const lines = [`共 ${rows.length} 条长期记忆（跨项目共享）：`];
  for (const r of rows) lines.push(`- ${r.name}（${r.len} 字，更新于 ${r.updated_at}）`);
  lines.push('', '用 memory_read(name) 取回正文；只读你确实需要的那几条。');
  return { output: lines.join('\n') };
}

// 供设置页/管理界面使用
function listForUi() {
  ensureTable();
  try { return db.prepare('SELECT name, content, updated_at FROM ai_memories ORDER BY updated_at DESC').all(); }
  catch (e) { return []; }
}

function remove(name) {
  ensureTable();
  const n = normalizeName(name);
  const r = db.prepare('DELETE FROM ai_memories WHERE name = ?').run(n);
  return { deleted: r.changes > 0, name: n };
}

module.exports = { ensureTable, normalizeName, write, read, list, listForUi, remove, allRows, MAX_CONTENT };
