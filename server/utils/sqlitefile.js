// 只在「文件」层面动 SQLite 的活：体检、以及把待应用导入落到主库位置。
// 单独一个模块是因为 database.js 要在打开连接之前调它，反过来 require database.js
// 会形成循环依赖（启动期只能拿到半初始化的导出）。
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { DATA_DIR, DB_PATH } = require('../config');

const IMPORT_DIR = path.join(DATA_DIR, 'imports');
const PENDING = path.join(DATA_DIR, 'kh.import-pending.json');
const RESULT = path.join(DATA_DIR, 'kh.import-result.json');
const MIN_TABLES = ['ai_models', 'ai_providers', 'ai_chats', 'ai_chat_messages', 'settings'];

function stamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

/** 只读体检：完整性 + 是不是 KHarness 的表结构，顺带报几行数给界面看 */
function inspect(file) {
  let probe = null;
  try {
    probe = new Database(file, { readonly: true, fileMustExist: true });
    const integrity = probe.prepare('PRAGMA integrity_check').get();
    if (!integrity || integrity.integrity_check !== 'ok') {
      return { ok: false, error: `完整性检查未通过：${JSON.stringify(integrity)}` };
    }
    const have = new Set(probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    const missing = MIN_TABLES.filter((t) => !have.has(t));
    if (missing.length) return { ok: false, error: `不是一份 KHarness 库（缺少表 ${missing.join('、')}）` };
    const count = (t) => (have.has(t) ? probe.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c : 0);
    return {
      ok: true,
      tables: have.size,
      counts: {
        提供商: count('ai_providers'),
        模型: count('ai_models'),
        会话: count('ai_chats'),
        消息: count('ai_chat_messages'),
        用量: count('usage_log'),
        MCP服务器: count('ai_mcp_servers'),
      },
    };
  } catch (e) {
    return { ok: false, error: `读不出来：${String((e && e.message) || e).slice(0, 200)}` };
  } finally {
    if (probe) probe.close();
  }
}

/**
 * 有待应用的导入就替换主库。必须在打开连接之前跑：换文件 + 清 WAL 之后，
 * 新的连接才会看到新库。替换前先给现库做一份 VACUUM INTO 快照，砸了能退回。
 */
function applyPendingImport() {
  const pending = readJson(PENDING);
  if (!pending) return null;
  const out = { file: pending.file, ok: false };
  try {
    if (!pending.file || !fs.existsSync(pending.file)) throw new Error('导入文件已不存在');
    const info = inspect(pending.file);
    if (!info.ok) throw new Error(info.error);
    let backup = '';
    if (fs.existsSync(DB_PATH)) {
      backup = `${DB_PATH}.pre-import-${stamp()}`;
      const cur = new Database(DB_PATH, { readonly: true });
      try { cur.prepare('VACUUM INTO ?').run(backup); } finally { cur.close(); }
    }
    fs.rmSync(DB_PATH, { force: true });
    fs.rmSync(`${DB_PATH}-wal`, { force: true });
    fs.rmSync(`${DB_PATH}-shm`, { force: true });
    fs.copyFileSync(pending.file, DB_PATH);
    fs.unlinkSync(pending.file);
    out.ok = true;
    out.backup = backup;
    out.counts = info.counts;
  } catch (e) {
    out.error = String((e && e.message) || e).slice(0, 400);
  }
  try {
    fs.writeFileSync(RESULT, JSON.stringify({ ...out, applied_at: new Date().toISOString() }), 'utf8');
    fs.rmSync(PENDING, { force: true });
  } catch (e) { /* 结果写不出去不拦启动 */ }
  return out;
}

/* ── 恢复出厂设置 ───────────────────────────────────────────────────────
   正在用的库没法「边开着边清空」：prepared statement、WAL、连接池都在上面。
   所以这里只落一个待办标记，由 prepareDataDir() 在下次启动、打开连接之前把库文件删掉，
   后面 createSchema() + insertDefaultData() 自然生成一份干净的新库。
   按他的要求不备份：点了就是真没了（界面那边要逐字输入确认语 + 连点三次）。 */
const FACTORY_PENDING = path.join(DATA_DIR, 'kh.factory-reset-pending.json');
const FACTORY_RESULT = path.join(DATA_DIR, 'kh.factory-reset-result.json');

function markFactoryReset(reason) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FACTORY_PENDING, JSON.stringify({ marked_at: new Date().toISOString(), reason: String(reason || '').slice(0, 200) }), 'utf8');
    return FACTORY_PENDING;
  } catch (e) {
    return null;
  }
}

function applyPendingFactoryReset() {
  const pending = readJson(FACTORY_PENDING);
  if (!pending) return null;
  const out = { marked_at: pending.marked_at, removed: [] };
  try {
    for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
      if (!fs.existsSync(f)) continue;
      fs.rmSync(f, { force: true });
      out.removed.push(path.basename(f));
    }
    out.ok = true;
  } catch (e) {
    out.ok = false;
    out.error = String((e && e.message) || e).slice(0, 300);
  }
  try {
    fs.writeFileSync(FACTORY_RESULT, JSON.stringify({ ...out, applied_at: new Date().toISOString() }), 'utf8');
    fs.rmSync(FACTORY_PENDING, { force: true });
  } catch (e) { /* 记不上结果也别拦启动 */ }
  return out;
}

module.exports = {
  inspect, applyPendingImport, applyPendingFactoryReset, markFactoryReset,
  readJson, stamp, IMPORT_DIR, PENDING, RESULT, FACTORY_PENDING, FACTORY_RESULT, DB_PATH, DATA_DIR
};
