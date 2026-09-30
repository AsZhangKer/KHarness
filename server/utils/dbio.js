// 整库导出 / 暂存导入。桌面版启动时不再自动复制项目里的历史库，搬数据只走这里。
//
// 导入为什么不就地换文件：database.js 导出的是同一个 better-sqlite3 连接，全站都在用。
// 热替换等于让几十条路径上的已编译 statement 指向不存在的库，症状会到处漂。
// 所以这里只落盘 + 打标记，真正替换在下次进程启动最开头（utils/sqlitefile.js）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { db } = require('../database');
const { DB_PATH, DATA_DIR } = require('../config');
const sqlitefile = require('./sqlitefile');

const { IMPORT_DIR, PENDING, RESULT, inspect, readJson, stamp } = sqlitefile;

/** 在线备份到临时文件（含 WAL 内容）；调用方发完下载要删掉 */
async function exportSnapshot() {
  const file = path.join(os.tmpdir(), `kh-export-${stamp()}.db`);
  await db.backup(file);
  return { file, size: fs.statSync(file).size };
}

/** 收下上传的库文件，校验通过才写「下次启动应用」的标记 */
function stageImport(buffer, originalName) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return { error: '上传内容为空' };
  if (buffer.length < 16 || buffer.slice(0, 15).toString('binary') !== 'SQLite format 3') {
    return { error: '文件不是 SQLite 数据库（头部魔数不对）' };
  }
  fs.mkdirSync(IMPORT_DIR, { recursive: true });
  const safe = String(originalName || 'import.db').replace(/[^\w.\-]+/g, '_').slice(0, 80);
  const file = path.join(IMPORT_DIR, `${stamp()}-${safe}`);
  fs.writeFileSync(file, buffer);
  const info = inspect(file);
  if (!info.ok) {
    try { fs.unlinkSync(file); } catch (e) { /* 留着也影响不到运行 */ }
    return { error: info.error };
  }
  fs.writeFileSync(PENDING, JSON.stringify({ file, created_at: new Date().toISOString(), source: safe }), 'utf8');
  return { staged: true, file, bytes: buffer.length, tables: info.tables, counts: info.counts };
}

function status() {
  let bytes = 0;
  try { bytes = fs.statSync(DB_PATH).size; } catch (e) { /* 还没建库 */ }
  let imports = [];
  try {
    imports = fs.readdirSync(IMPORT_DIR).filter((f) => f.endsWith('.db'))
      .map((f) => ({ name: f, bytes: fs.statSync(path.join(IMPORT_DIR, f)).size }));
  } catch (e) { /* 目录还没建 */ }
  let current = null;
  try {
    const info = inspect(DB_PATH);
    if (info.ok) current = info.counts;
  } catch (e) { /* 库还没建，读不出来很正常 */ }
  return {
    path: DB_PATH,
    data_dir: DATA_DIR,
    bytes,
    counts: current,
    pending: readJson(PENDING),
    last_result: readJson(RESULT),
    imports,
  };
}

/** 撤销一次还没应用的导入 */
function cancelPending() {
  const p = readJson(PENDING);
  if (!p) return { message: '没有待应用的导入' };
  try { if (p.file) fs.rmSync(p.file, { force: true }); } catch (e) { /* 文件已不在 */ }
  fs.rmSync(PENDING, { force: true });
  return { message: '已取消待应用的导入' };
}

module.exports = { exportSnapshot, stageImport, status, cancelPending, IMPORT_DIR, PENDING, RESULT };
