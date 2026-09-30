// 文件操作撤销快照：原始字节落盘 + 建表索引，重启后历史步骤仍可撤销
// 小快照（≤8KB）直接存库，大快照存 .kh-undo/<op_id>.bin（base64 原样保存，二进制文件不失真）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db } = require('../database');

const INLINE_MAX = 8 * 1024;
const KEEP_MAX = 400;

let dir = null;
// 老版本把快照落在「程序安装根目录/.kh-undo」。装机版一旦装进 Program Files 那里是只读的，
// 撤销会静默失效 —— 所以写只写新目录（数据目录），读/删两头都认，老快照照样能撤。
let legacyDir = null;

function init(undoDir, oldDir) {
  dir = undoDir;
  legacyDir = oldDir && path.resolve(oldDir) !== path.resolve(undoDir) ? oldDir : null;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* 已存在或只读盘 */ }
}

function ensureDir() {
  if (!dir) return null;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
  return dir;
}

/** 快照实际在哪个目录：新目录优先，没有再回安装根目录那个老位置 */
function locate(name) {
  const base = path.basename(String(name || '')).replace(/\/$/, '');
  if (!base) return null;
  for (const d of [dir, legacyDir]) {
    if (!d) continue;
    const p = path.join(d, base);
    if (fs.existsSync(p)) return p;
  }
  return dir ? path.join(dir, base) : null;
}

/** 两个目录里同名快照都清掉（forget / markUndone 用） */
function removeSnapshotFiles(name) {
  const base = path.basename(String(name || '')).replace(/\/$/, '');
  if (!base) return;
  for (const d of [dir, legacyDir]) {
    if (!d) continue;
    const p = path.join(d, base);
    try {
      if (!fs.existsSync(p)) continue;
      if (fs.statSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true });
      else fs.unlinkSync(p);
    } catch (e) { /* ignore */ }
  }
}

function binFile(opId) {
  const d = ensureDir();
  return d ? path.join(d, `${opId}.bin`) : null;
}

// snapshot: { type: file|dir|delete|delete_dir|rename, path, oldPath, buf(Buffer|null), existed, isDir, chatId, label,
//             remoteId(远程主机 id，空=本机), note(远端回收站暂存路径) }
function record(snapshot) {
  const opId = crypto.randomBytes(7).toString('hex');
  const buf = Buffer.isBuffer(snapshot.buf) ? snapshot.buf : null;
  const inline = buf && buf.length <= INLINE_MAX;
  const file = inline ? '' : binFile(opId);
  if (buf && !inline && file) {
    try { fs.writeFileSync(file, buf); } catch (e) { /* 落盘失败则退化为不可撤销 */ }
  }
  try {
    db.prepare(
      'INSERT INTO undo_ops (op_id, type, path, old_path, existed, is_dir, payload, payload_file, chat_id, label, remote_id, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      opId,
      String(snapshot.type || 'file'),
      String(snapshot.path || ''),
      String(snapshot.oldPath || ''),
      snapshot.existed ? 1 : 0,
      snapshot.isDir ? 1 : 0,
      inline ? buf.toString('base64') : null,
      file ? path.basename(file) : '',
      Number.isInteger(snapshot.chatId) ? snapshot.chatId : null,
      String(snapshot.label || ''),
      Number.isInteger(snapshot.remoteId) ? snapshot.remoteId : null,
      String(snapshot.note || '')
    );
  } catch (e) {
    if (file) { try { fs.unlinkSync(file); } catch (e2) { /* ignore */ } }
    return null;
  }
  prune();
  return opId;
}

function peek(opId) {
  try {
    return db.prepare('SELECT * FROM undo_ops WHERE op_id = ?').get(String(opId)) || null;
  } catch (e) {
    return null;
  }
}

function readSnapshotPayload(row) {
  if (row.payload) {
    try { return Buffer.from(row.payload, 'base64'); } catch (e) { return null; }
  }
  if (row.payload_file && dir) {
    try { return fs.readFileSync(locate(row.payload_file)); } catch (e) { return null; }
  }
  return null;
}

function forget(opId) {
  const row = peek(opId);
  if (row && row.payload_file && dir) {
    // 文件快照是 <opId>.bin，目录快照是 <opId>/ 目录；新目录与老的安装根目录都清一遍
    removeSnapshotFiles(row.payload_file);
  }
  try { db.prepare('DELETE FROM undo_ops WHERE op_id = ?').run(String(opId)); } catch (e) { /* ignore */ }
}

// 递归拷贝目录（带文件数/总字节上限）；返回 { files, bytes }，超限抛错
const TREE_MAX_FILES = 3000;
const TREE_MAX_BYTES = 200 * 1024 * 1024;

function copyTree(src, dest, acc, relBase) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyTree(path.join(src, name), path.join(dest, name), acc, relBase);
    }
    return acc;
  }
  acc.files++;
  acc.bytes += st.size;
  if (acc.files > TREE_MAX_FILES || acc.bytes > TREE_MAX_BYTES) {
    throw new Error(`目录过大（超过 ${TREE_MAX_FILES} 个文件或 ${Math.round(TREE_MAX_BYTES / 1048576)}MB），不做快照`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return acc;
}

// 整目录快照（撤销「删除目录」用）：把目录原样复制到 .kh-undo/<opId>/，payload_file 记 '<opId>/'
function recordTree(snapshot) {
  const d = ensureDir();
  if (!d) return null;
  const opId = crypto.randomBytes(7).toString('hex');
  const treeDir = path.join(d, opId);
  const acc = { files: 0, bytes: 0 };
  try {
    copyTree(snapshot.path, treeDir, acc);
  } catch (e) {
    try { fs.rmSync(treeDir, { recursive: true, force: true }); } catch (e2) { /* ignore */ }
    return { error: `目录快照失败：${e.message}` };
  }
  try {
    db.prepare(
      'INSERT INTO undo_ops (op_id, type, path, old_path, existed, is_dir, payload, payload_file, chat_id, label) VALUES (?, ?, ?, ?, 1, 1, NULL, ?, ?, ?)'
    ).run(opId, 'dir_restore', String(snapshot.path), '', opId + '/', Number.isInteger(snapshot.chatId) ? snapshot.chatId : null, String(snapshot.label || ''));
  } catch (e) {
    try { fs.rmSync(treeDir, { recursive: true, force: true }); } catch (e2) { /* ignore */ }
    return null;
  }
  prune();
  return opId;
}

function restoreTree(treeDir, dest) {
  const acc = { files: 0, bytes: 0 };
  copyTree(treeDir, dest, acc);
  return acc;
}

// 撤销：把目标恢复到快照之前状态。返回 { ok, path, label, message } 或 { ok:false, error }
// 成功后不删记录而是留「已撤销」墓碑（并释放快照体积），避免同一操作被重复撤销
function apply(opId) {
  const row = peek(opId);
  if (!row) return { ok: false, error: '撤销记录不存在或已过期（该操作发生在本项目记录之外，或快照已被清理）' };
  if (row.undone) return { ok: false, error: '该操作已经撤销过了，不能重复撤销' };
  const label = String(row.label || '');
  const done = (r) => {
    if (r.ok) markUndone(opId);
    return r.ok ? { ...r, label } : r;
  };

  const target = String(row.path || '');
  if (row.type === 'dir_restore') {
    const src = dir ? locate(row.payload_file || '') : null;
    if (!src || !fs.existsSync(src)) return { ok: false, error: '目录快照已丢失，无法恢复' };
    try {
      fs.mkdirSync(target, { recursive: true });
      const acc = restoreTree(src, target);
      return done({ ok: true, path: target, message: `已恢复目录 ${target}（${acc.files} 个文件）` });
    } catch (e) {
      return { ok: false, error: `恢复目录失败：${e.message}` };
    }
  }
  if (row.type === 'rename') {
    // 反向改名：new_path → old_path
    const from = target;
    const to = String(row.old_path || '');
    if (!to) return { ok: false, error: '撤销记录缺少原始路径' };
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
    } catch (e) {
      if (e.code !== 'ENOENT') return { ok: false, error: `恢复文件名失败：${e.message}` };
    }
    return done({ ok: true, path: to, message: `已撤销重命名，恢复为 ${to}` });
  }
  if (row.type === 'dir') {
    // 撤销创建目录：仅当原本不存在（即该目录由本次操作新建）时删除
    if (row.existed) return { ok: false, error: '该目录原本已存在，无法通过撤销安全删除' };
    try { fs.rmdirSync(target); } catch (e) { /* 非空或已不存在 */ }
    return done({ ok: true, path: target, message: `已撤销创建目录 ${target}` });
  }

  // file（写入/覆盖/编辑）与 delete：按原始内容恢复
  const shouldExist = !!row.existed || row.type === 'delete';
  const buf = readSnapshotPayload(row);
  if (shouldExist) {
    if (!buf) return { ok: false, error: '快照内容已丢失（原始文件过大或落盘失败），无法恢复' };
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buf);
    } catch (e) {
      return { ok: false, error: `恢复失败：${e.message}` };
    }
    return done({ ok: true, path: target, message: `已恢复 ${target}（${buf.length} 字节）` });
  }
  // 原本不存在 → 撤销新建即删除该文件
  try { fs.unlinkSync(target); } catch (e) { /* 已不存在视作成功 */ }
  return done({ ok: true, path: target, message: `已撤销新建，删除 ${target}` });
}

/**
 * 撤销一次「远程操作」：语义与 apply() 一致，只是落点是远端。
 * 单独一个异步函数而不是把 apply() 改造成两用的 —— 本地那条路已经被大量使用，
 * 不想为了远程给它加一层 await/分支风险。
 * 快照（原始字节）始终存在本机 undo 目录，所以恢复是把字节推回远端；
 * 删除目录没有本地快照，靠 note 里记的远端回收站暂存路径 rename 回来。
 */
async function applyRemote(opId) {
  const remote = require('./remote');
  const row = peek(opId);
  if (!row) return { ok: false, error: '撤销记录不存在或已过期' };
  if (row.undone) return { ok: false, error: '该操作已经撤销过了，不能重复撤销' };
  if (!row.remote_id) return { ok: false, error: '这条记录不是远程操作' };
  const host = db.prepare('SELECT * FROM ai_remote_hosts WHERE id = ?').get(row.remote_id);
  if (!host) return { ok: false, error: '对应的远程连接已被删除，无法撤销这次远端改动' };
  const label = String(row.label || '');
  const target = String(row.path || '');
  const done = async (r) => { if (r.ok) markUndone(opId); return r.ok ? { ...r, label } : r; };
  const posix = (s) => String(s || '').replace(/\\/g, '/');

  try {
    if (row.type === 'rename') {
      const to = posix(row.old_path);
      if (!to) return { ok: false, error: '撤销记录缺少原始路径' };
      await remote.sftp.move(host, target, to);
      return await done({ ok: true, path: to, message: `已撤销远端重命名，恢复为 ${to}` });
    }
    if (row.type === 'dir') {
      if (row.existed) return { ok: false, error: '该远端目录原本已存在，无法通过撤销安全删除' };
      await remote.sftp.remove(host, target, true).catch(() => null);
      return await done({ ok: true, path: target, message: `已撤销创建远端目录 ${target}` });
    }
    if (row.type === 'delete' || row.type === 'delete_dir') {
      if (row.note) {
        const staged = posix(row.note);
        await remote.sftp.mkdirP(host, staged.replace(/\/[^/]+$/, '') || '/');
        await remote.sftp.move(host, staged, target);
        // 暂存目录里已经空了就顺手收掉：不然那次撤销留下的空壳会一直堆在远端 ~/.kh-undo 下
        const stampDir = staged.replace(/\/[^/]+$/, '');
        if (stampDir) await remote.sftp.remove(host, stampDir, true).catch(() => null);
        return await done({ ok: true, path: target, message: `已从远端回收站暂存处恢复 ${target}` });
      }
      const buf = readSnapshotPayload(row);
      if (!buf) return { ok: false, error: '快照内容已丢失（原始文件过大或未落盘），无法恢复' };
      await remote.sftp.writeFile(host, target, buf);
      return await done({ ok: true, path: target, message: `已恢复远端 ${target}（${buf.length} 字节）` });
    }
    // type === 'file'：写过/新建过的文件，恢复原字节；原本不存在则删掉
    if (row.existed) {
      const buf = readSnapshotPayload(row);
      if (!buf) return { ok: false, error: '快照内容已丢失（原始文件过大或未落盘），无法恢复' };
      await remote.sftp.writeFile(host, target, buf);
      return await done({ ok: true, path: target, message: `已恢复远端 ${target}（${buf.length} 字节）` });
    }
    await remote.sftp.remove(host, target, !!row.is_dir).catch(() => null);
    return await done({ ok: true, path: target, message: `已撤销新建，删除远端 ${target}` });
  } catch (e) {
    return { ok: false, error: `远端撤销失败：${e.message}` };
  }
}

// 标记已撤销并释放快照体积（记录本身保留，供前端持久显示「已撤销」）
function markUndone(opId) {
  const row = peek(opId);
  if (row && row.payload_file && dir) removeSnapshotFiles(row.payload_file);
  try {
    db.prepare("UPDATE undo_ops SET undone = 1, payload = NULL, payload_file = '' WHERE op_id = ?").run(String(opId));
  } catch (e) { /* ignore */ }
}

// 只保留最近 KEEP_MAX 条，超出部分连同落盘文件一起清理
function prune() {
  try {
    const rows = db.prepare('SELECT op_id FROM undo_ops ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?').all(KEEP_MAX);
    for (const r of rows) forget(r.op_id);
  } catch (e) { /* 清理失败不影响主流程 */ }
}

// 启动时清理孤儿落盘内容（快照已删但 .bin / 目录树残留）
function sweepOrphans() {
  if (!dir) return;
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return; }
  const known = new Set();
  try {
    for (const r of db.prepare("SELECT payload_file FROM undo_ops WHERE payload_file <> ''").all()) {
      known.add(path.basename(String(r.payload_file)));
    }
  } catch (e) { return; }
  for (const f of names) {
    if (!f.endsWith('.bin') && !/^[0-9a-f]{14}$/.test(f)) continue;
    const bare = f.replace(/\.bin$/, '');
    if (known.has(f) || known.has(bare) || known.has(bare + '/')) continue;
    try {
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true });
      else fs.unlinkSync(p);
    } catch (e) { /* ignore */ }
  }
}

module.exports = { init, record, recordTree, peek, apply, applyRemote, forget, prune, sweepOrphans, get dir() { return dir; } };
