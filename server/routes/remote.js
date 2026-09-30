/**
 * 远程主机（阶段 5）的 REST：连接增删改查 + 连通测试 + 手动执行 + SFTP 快捷操作。
 *
 * 挂在 /api/ai/remote 下面（server/index.js）。这一层只做「连得上去、看得见文件、动得了文件」，
 * AI 工具走的那套（execTool 的审批、路径边界、只读模式）在 routes/ai.js 里，两边共用
 * utils/remote.js 这一条传输通道，避免两套实现漂移。
 *
 * 三个刻意的决定：
 * 1) 列表接口不回显 secret / private_key 正文，只给 has_secret / has_key —— 前端只需要知道
 *    「配过了没有」，编辑时留空即表示不改。
 * 2) 删除连接是级联的：它下面的远程项目、远程会话、会话消息、撤销记录一起走，同一个事务里做，
 *    不然左栏会留下点不动的孤儿条目（他特别点名过这条）。
 * 3) 手动删除远端文件先移到远端 ~/.kh-undo/<时间戳>/ 再记撤销，跟本地「任何删除都可撤销」一致；
 *    Linux 没有系统回收站，所以撤销记录仍然落在本机 undo_ops（快照也在本机），恢复时反向推回去。
 */
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { db } = require('../database');
const { ok, fail, failErr, wrap } = require('../utils/respond');
const remote = require('../utils/remote');
const undoStore = require('../utils/undo');
const trashStore = require('../utils/trash');   // 删连接时它名下的会话/项目先快照进回收站

const router = express.Router();

const NAME_MAX = 40;
const HOST_MAX = 120;

function cleanName(s) { return String(s || '').replace(/[\r\n\t]+/g, ' ').trim().substring(0, NAME_MAX); }
function cleanHost(s) { return String(s || '').trim().substring(0, HOST_MAX); }
function cleanPort(p) { const n = parseInt(p); return Number.isInteger(n) && n > 0 && n <= 65535 ? n : 22; }
function cleanUser(s) { return String(s || '').trim().replace(/[^A-Za-z0-9._-]/g, '').substring(0, 48) || 'root'; }
/** 远端路径归一：实现放在 utils/remote.js，路由与工具循环共用同一份，别长成两套 */
const posixPath = remote.posixPath;
/** 只有图片需要 MIME（给 data:URL 用）；认不出来就 application/octet-stream，浏览器照样显示靠嗅探 */
const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.avif': 'image/avif', '.tif': 'image/tiff', '.tiff': 'image/tiff',
};
function mimeOf(p) { return MIME_BY_EXT[path.extname(String(p || '')).toLowerCase()] || 'application/octet-stream'; }
function hostRow(id) {
  const row = db.prepare('SELECT * FROM ai_remote_hosts WHERE id = ?').get(Number(id));
  if (!row) return null;
  return row;
}
function publicRow(row) {
  return {
    id: row.id, name: row.name, host: row.host, port: row.port, username: row.username,
    auth: row.auth, default_cwd: row.default_cwd || '', sort_order: row.sort_order || 0,
    last_ok: row.last_ok || '', last_error: row.last_error || '', created_at: row.created_at,
    has_secret: !!row.secret,
    has_key: !!row.private_key,
    // 项目/会话数：删连接前要先让前端看到会带走多少东西
    project_count: db.prepare('SELECT COUNT(*) n FROM projects WHERE remote_id = ?').get(row.id).n,
    chat_count: db.prepare('SELECT COUNT(*) n FROM ai_chats WHERE remote_id = ?').get(row.id).n,
  };
}

/* ------------------------------- 连接管理 ------------------------------- */

router.get('/hosts', wrap((req, res) => {
  const rows = db.prepare('SELECT * FROM ai_remote_hosts ORDER BY sort_order ASC, id ASC').all();
  ok(res, rows.map(publicRow));
}));

router.post('/hosts', wrap((req, res) => {
  const b = req.body || {};
  const host = cleanHost(b.host);
  if (!host) return fail(res, 400, '要填主机域名或 IP');
  if (!/^[\w.-]+$/.test(host)) return fail(res, 400, '主机地址里有非法字符');
  const auth = b.auth === 'key' ? 'key' : 'password';
  if (auth === 'password' && !String(b.secret || '')) return fail(res, 400, '要填密码');
  if (auth === 'key' && !String(b.private_key || '').includes('PRIVATE KEY')) return fail(res, 400, '私钥内容看起来不对（要含 PRIVATE KEY）');
  const name = cleanName(b.name) || `${host}`;
  const r = db.prepare(`INSERT INTO ai_remote_hosts (name, host, port, username, auth, secret, private_key, default_cwd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    name, host, cleanPort(b.port), cleanUser(b.username), auth,
    String(b.secret || ''), auth === 'key' ? String(b.private_key || '') : '',
    posixPath(b.default_cwd || ''),
  );
  ok(res, publicRow(hostRow(Number(r.lastInsertRowid))), '连接已创建');
}));

router.put('/hosts/:id', wrap((req, res) => {
  const row = hostRow(req.params.id);
  if (!row) return fail(res, 404, '连接不存在');
  const b = req.body || {};
  const next = {
    name: b.name !== undefined ? (cleanName(b.name) || row.name) : row.name,
    host: b.host !== undefined ? (cleanHost(b.host) || row.host) : row.host,
    port: b.port !== undefined ? cleanPort(b.port) : row.port,
    username: b.username !== undefined ? cleanUser(b.username) : row.username,
    auth: b.auth !== undefined ? (b.auth === 'key' ? 'key' : 'password') : row.auth,
    // 留空 = 保持原值：前端列表里不回显密钥，编辑时不该被迫重填
    secret: b.secret ? String(b.secret) : row.secret,
    private_key: b.private_key && String(b.private_key).includes('PRIVATE KEY') ? String(b.private_key) : row.private_key,
    default_cwd: b.default_cwd !== undefined ? posixPath(b.default_cwd) : row.default_cwd,
  };
  if (next.auth === 'password' && !next.secret) return fail(res, 400, '密码认证需要密码或保留原密码');
  if (next.auth === 'key' && !next.private_key) return fail(res, 400, '私钥认证需要私钥或保留原私钥');
  db.prepare(`UPDATE ai_remote_hosts SET name=?, host=?, port=?, username=?, auth=?, secret=?, private_key=?, default_cwd=?, last_error='' WHERE id=?`)
    .run(next.name, next.host, next.port, next.username, next.auth, next.secret, next.private_key, next.default_cwd, row.id);
  remote.close(row.id);   // 参数可能变了，旧连接作废
  ok(res, publicRow(hostRow(row.id)), '连接已更新');
}));

/**
 * 删除连接 = 级联删它下面的远程项目 / 会话 / 消息 / 撤销记录。
 * 有内容时未带 confirm=1 先返回 409 + 数量，让前端弹确认（与删项目同一套交互）。
 */
router.delete('/hosts/:id', wrap((req, res) => {
  const row = hostRow(req.params.id);
  if (!row) return fail(res, 404, '连接不存在');
  const projects = db.prepare('SELECT id, name FROM projects WHERE remote_id = ?').all(row.id);
  const chats = db.prepare('SELECT id, title FROM ai_chats WHERE remote_id = ?').all(row.id);
  const confirmed = req.query.confirm === '1' || req.body?.confirm === true;
  if ((projects.length || chats.length) && !confirmed) {
    return res.status(409).json({
      code: 409,
      message: `连接「${row.name}」下还有 ${projects.length} 个项目、${chats.length} 个会话`,
      data: { project_count: projects.length, chat_count: chats.length },
    });
  }
  const chatIds = chats.map((c) => c.id);
  const projectChatIds = projects.length
    ? db.prepare('SELECT id FROM ai_chats WHERE project_id IN (SELECT id FROM projects WHERE remote_id = ?)').all(row.id).map((r) => r.id)
    : [];
  const allChats = [...new Set([...chatIds, ...projectChatIds])];
  remote.close(row.id);
  const run = db.transaction(() => {
    // 会话/项目先进回收站（连接本身不快照 —— 里面是密钥），删掉之后还能把聊天记录捞回来
    const trashed = trashStore.trashForRemoteHost(row.id);
    if (allChats.length) {
      const q = allChats.map(() => '?').join(',');
      db.prepare(`DELETE FROM ai_chat_messages WHERE chat_id IN (${q})`).run(...allChats);
      db.prepare(`DELETE FROM undo_ops WHERE chat_id IN (${q})`).run(...allChats);
      db.prepare(`DELETE FROM ai_chats WHERE id IN (${q})`).run(...allChats);
    }
    db.prepare('DELETE FROM projects WHERE remote_id = ?').run(row.id);
    db.prepare('DELETE FROM ai_remote_hosts WHERE id = ?').run(row.id);
    return trashed;
  });
  const trashedCount = run();
  ok(res, { removed_projects: projects.length, removed_chats: allChats.length, trashed: trashedCount },
    `连接已删除（连带 ${projects.length} 个项目、${allChats.length} 个会话）${trashedCount ? `，${trashedCount} 条快照已进回收站，可恢复` : ''}`);
}));

router.post('/hosts/reorder', wrap((req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((x) => parseInt(x)).filter(Number.isInteger) : [];
  if (!ids.length) return fail(res, 400, '无效的排序列表');
  const upd = db.prepare('UPDATE ai_remote_hosts SET sort_order = ? WHERE id = ?');
  const run = db.transaction(() => ids.forEach((id, i) => upd.run(i, id)));
  run();
  ok(res, null, '顺序已保存');
}));

/** 连通测试：顺手把 default_cwd 空着的主机填上远端家目录，省得用户再输一遍 */
router.post('/hosts/:id/test', wrap(async (req, res) => {
  const row = hostRow(req.params.id);
  if (!row) return fail(res, 404, '连接不存在');
  const r = await remote.probe(row);
  if (!r.ok) {
    db.prepare("UPDATE ai_remote_hosts SET last_error = ? WHERE id = ?").run(String(r.error).substring(0, 400), row.id);
    return ok(res, { ok: false, error: r.error }, '连不上');
  }
  db.prepare(`UPDATE ai_remote_hosts SET last_ok = CURRENT_TIMESTAMP, last_error = '',
      home = CASE WHEN home = '' THEN ? ELSE home END,
      default_cwd = CASE WHEN default_cwd = '' THEN ? ELSE default_cwd END WHERE id = ?`)
    .run(posixPath(r.home) || row.home || '', posixPath(r.home) || row.default_cwd || '', row.id);
  remote.close(row.id);   // 测试用的连接不占池子
  ok(res, { ok: true, info: r.info, home: r.home }, '连接正常');
}));

/* ------------------------------- 手动执行 ------------------------------- */

router.post('/hosts/:id/exec', wrap(async (req, res) => {
  const row = hostRow(req.params.id);
  if (!row) return fail(res, 404, '连接不存在');
  const command = String(req.body?.command || '').trim();
  if (!command) return fail(res, 400, '要执行什么命令？');
  const cwd = req.body?.cwd ? posixPath(req.body.cwd) : (row.default_cwd || '');
  const secs = Number(req.body?.timeout_seconds) || 60;
  const r = await remote.runRemoteCommand(row, command, { cwd, timeoutMs: Math.min(Math.max(secs, 1), 600) * 1000 });
  if (r.error) return ok(res, { ok: false, output: r.error }, '命令未完成');
  ok(res, { ok: true, output: r.output }, '执行完成');
}));

/* ------------------------------- SFTP 快捷操作 ------------------------------- */

async function withHost(req, res, fn) {
  const row = hostRow(req.params.id);
  if (!row) { fail(res, 404, '连接不存在'); return null; }
  return fn(row);
}

router.get('/hosts/:id/files', wrap(async (req, res) => await withHost(req, res, async (row) => {
  const p = posixPath(req.query.path || row.default_cwd || '/');
  try {
    const items = await remote.sftp.list(row, p);
    const real = await remote.sftp.realPath(row, p).catch(() => p);
    ok(res, { path: p, real_path: real, items });
  } catch (e) {
    failErr(res, 502, '列目录失败', e);
  }
})));

router.get('/hosts/:id/file', wrap(async (req, res) => await withHost(req, res, async (row) => {
  const p = posixPath(req.query.path);
  if (!p || p === '/') return fail(res, 400, '要读哪个文件？');
  // enc=b64：给内置图片查看器用。原来这条只按 utf8 出文本，图片读进去是一堆替换字符，
  // 二进制必须整份 base64 出来才能显示；上限 12MB（远端一张大图也够了，再多就是内存浪费）。
  const asBase64 = String(req.query.enc || '') === 'b64';
  try {
    const buf = await remote.sftp.readFile(row, p);
    if (asBase64) {
      if (buf.length > 12 * 1024 * 1024) return fail(res, 400, `图片太大（${Math.round(buf.length / 1048576)}MB），上限 12MB`);
      return ok(res, { path: p, size: buf.length, base64: buf.toString('base64'), mime: mimeOf(p) });
    }
    const text = buf.toString('utf8');
    ok(res, { path: p, size: buf.length, content: text, truncated: text.length > 200000 ? true : false });
  } catch (e) {
    failErr(res, 502, '读不了这个文件', e);
  }
})));

router.post('/hosts/:id/file', wrap(async (req, res) => await withHost(req, res, async (row) => {
  const p = posixPath(req.body?.path);
  if (!p || p === '/') return fail(res, 400, '要写到哪个文件？');
  const content = String(req.body?.content ?? '');
  if (content.length > 8 * 1024 * 1024) return fail(res, 400, '单次写入上限 8MB');
  try {
    let before = null;
    try { before = await remote.sftp.readFile(row, p); } catch (e) { /* 新建 */ }
    await remote.sftp.writeFile(row, p, content);
    const opId = undoStore.record({
      path: p, type: 'file', existed: !!before, isDir: false,
      buf: before, remoteId: row.id, chatId: Number(req.body?.chat_id) || null,
      label: `${before ? '改' : '新建'}远端 ${p}`,
    });
    ok(res, { path: p, undo_id: opId, new_file: !before }, before ? '已保存' : '已创建');
  } catch (e) {
    failErr(res, 502, '写入失败', e);
  }
})));

router.post('/hosts/:id/mkdir', wrap(async (req, res) => await withHost(req, res, async (row) => {
  const p = posixPath(req.body?.path);
  if (!p || p === '/') return fail(res, 400, '要建哪个目录？');
  try {
    await remote.sftp.mkdirP(row, p);
    ok(res, { path: p }, '目录已就绪');
  } catch (e) {
    failErr(res, 502, '建目录失败', e);
  }
})));

router.post('/hosts/:id/rename', wrap(async (req, res) => await withHost(req, res, async (row) => {
  const from = posixPath(req.body?.path);
  const to = posixPath(req.body?.new_path || req.body?.to);
  if (!from || !to || from === to) return fail(res, 400, '改名需要原路径与新路径');
  try {
    await remote.sftp.move(row, from, to);
    const opId = undoStore.record({
      path: to, oldPath: from, type: 'rename', existed: true, isDir: false, buf: null,
      remoteId: row.id, chatId: Number(req.body?.chat_id) || null, label: `重命名远端 ${path.posix.basename(from)}`,
    });
    ok(res, { path: to, undo_id: opId }, `已改名 ${from} → ${to}`);
  } catch (e) {
    failErr(res, 502, '改名失败', e);
  }
})));

/**
 * 删除远端文件/目录：先移到远端 ~/.kh-undo/<时间戳>/，再记一条可撤销操作。
 * 快照（原始内容）落在本机 undo 目录，所以「撤销」是把字节再推回去，不依赖远端那个暂存区。
 */
router.post('/hosts/:id/delete', wrap(async (req, res) => await withHost(req, res, async (row) => {
  const p = posixPath(req.body?.path);
  if (!p || p === '/') return fail(res, 400, '要删哪个路径？');
  const isDir = req.body?.is_dir === true || req.body?.is_dir === '1';
  try {
    let buf = null;
    if (!isDir) {
      try { buf = await remote.sftp.readFile(row, p); } catch (e) { return fail(res, 404, `远端没有这个文件：${p}`); }
    }
    // 远端回收站的实现放在 utils/remote.js（AI 工具删除时走的是同一份，别长成两套）
    const { moved } = await remote.sftp.trash(row, p, isDir);
    const opId = undoStore.record({
      path: p, type: isDir ? 'delete_dir' : 'delete', existed: true, isDir, buf,
      remoteId: row.id, note: moved, chatId: Number(req.body?.chat_id) || null,
      label: `删除远端 ${isDir ? '目录 ' : ''}${p}`,
    });
    ok(res, { path: p, undo_id: opId, moved_to: moved }, `已删除（远端暂存于 ${moved}，可撤销恢复）`);
  } catch (e) {
    failErr(res, 502, '删除失败', e);
  }
})));

module.exports = router;
module.exports._internal = { posixPath, cleanPort, cleanUser };
