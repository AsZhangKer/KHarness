/**
 * 回收站（会话 / 项目）。
 *
 * 为什么不是软删除标记：ai_chats 被十几处查询读着（列表、树、搜索、上下文、用量），
 * 加一个 deleted_at 就要每个地方都记得过滤，漏一处就是「删掉的会话又冒出来」。
 * 所以这里反过来 —— 删除前把整行连同消息、任务快照进 ai_trash 的 payload，
 * 原表该删还是删干净；恢复就是按快照把行插回去。查询侧一行都不用改。
 *
 * 快照里刻意不含的东西：远程连接的密钥。删掉 SSH 连接时，它下面的会话照样能恢复，
 * 但只会恢复成一条普通会话（remote_id 置空并说明原因），不会把密码/私钥再抄一份到别的表里。
 */
const { db } = require('../database');

const SELECT_CHAT = 'SELECT * FROM ai_chats WHERE id = ?';
const SELECT_MSGS = 'SELECT * FROM ai_chat_messages WHERE chat_id = ? ORDER BY id ASC';
const SELECT_TASKS = 'SELECT * FROM tasks WHERE chat_id = ? ORDER BY seq ASC, id ASC';

/** 一条会话的完整快照（消息 + 任务），会话不存在时回 null */
function snapshotChat(chatId) {
  const chat = db.prepare(SELECT_CHAT).get(chatId);
  if (!chat) return null;
  return {
    chat,
    messages: db.prepare(SELECT_MSGS).all(chatId),
    tasks: db.prepare(SELECT_TASKS).all(chatId),
  };
}

function snapshotProject(projectId) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) return null;
  const ids = db.prepare('SELECT id FROM ai_chats WHERE project_id = ? ORDER BY id ASC').all(projectId).map((r) => r.id);
  return { project, chats: ids.map(snapshotChat).filter(Boolean) };
}

function push(kind, refId, title, path, payload) {
  const r = db.prepare('INSERT INTO ai_trash (kind, ref_id, title, path, payload) VALUES (?, ?, ?, ?, ?)')
    .run(kind, refId, String(title || '').substring(0, 200), String(path || '').substring(0, 500), JSON.stringify(payload));
  return r.lastInsertRowid;
}

/** 删会话（含消息与任务）。原来的 DELETE /chats/:id 只删了会话行，消息成了孤儿留在库里 —— 这里一并清掉 */
function purgeChats(chatIds) {
  const delTask = db.prepare('DELETE FROM tasks WHERE chat_id = ?');
  const delMsg = db.prepare('DELETE FROM ai_chat_messages WHERE chat_id = ?');
  const delChat = db.prepare('DELETE FROM ai_chats WHERE id = ?');
  for (const id of chatIds) { delTask.run(id); delMsg.run(id); delChat.run(id); }
}

/** 删除入口用：把会话快照进回收站再真删，返回回收站条目 id */
function trashChat(chatId) {
  const snap = snapshotChat(chatId);
  if (!snap) return 0;
  const id = push('chat', chatId, snap.chat.title || snap.chat.cwd || `会话 ${chatId}`, snap.chat.cwd || '', snap);
  purgeChats([chatId]);
  return id;
}

/** 删除入口用：项目连同它下面的会话一起快照，再整条删掉 */
function trashProject(projectId) {
  const snap = snapshotProject(projectId);
  if (!snap) return 0;
  const id = push('project', projectId, snap.project.name, snap.project.root_path, snap);
  const chatIds = snap.chats.map((c) => c.chat.id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
  purgeChats(chatIds);
  return id;
}

/**
 * 删 SSH 连接时的级联：它名下的项目与自由会话先逐个进回收站（连接本身不快照 —— 里面是密钥）。
 * 返回快照条数，调用方拿去告诉用户「这些还能恢复」。
 */
function trashForRemoteHost(hostId) {
  let n = 0;
  const projects = db.prepare('SELECT id FROM projects WHERE remote_id = ?').all(hostId);
  for (const p of projects) { if (trashProject(p.id)) n++; }
  const free = db.prepare('SELECT id FROM ai_chats WHERE remote_id = ? AND (project_id IS NULL OR project_id NOT IN (SELECT id FROM projects))').all(hostId);
  for (const c of free) { if (trashChat(c.id)) n++; }
  return n;
}

/** 列表：只回元信息，不把 payload（整段聊天记录）拖给前端 */
function list() {
  const rows = db.prepare(`
    SELECT id, kind, ref_id, title, path, created_at, restored_at, payload FROM ai_trash ORDER BY id DESC
  `).all();
  return rows.map((r) => {
    let chats = 0; let messages = 0;
    try {
      const p = JSON.parse(r.payload);
      if (r.kind === 'chat') { chats = 1; messages = (p.messages || []).length; }
      else {
        chats = (p.chats || []).length;
        messages = (p.chats || []).reduce((n, c) => n + (c.messages || []).length, 0);
      }
    } catch (e) { /* 快照坏了也不该让列表打不开 */ }
    return {
      id: r.id, kind: r.kind, ref_id: r.ref_id, title: r.title, path: r.path,
      created_at: r.created_at, restored_at: r.restored_at,
      chats, messages, bytes: r.payload.length,
    };
  });
}

function idFree(table, id) {
  return id != null && !db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id);
}

/** 把一整行原样插回某张表（对象里的 key 就是列名；id 为空就交给自增），返回落地的 id */
function insert(table, row) {
  const obj = Object.assign({}, row);
  if (obj.id === undefined || obj.id === null) delete obj.id;
  const cols = Object.keys(obj);
  const r = db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => obj[c]));
  return obj.id !== undefined ? obj.id : r.lastInsertRowid;
}

/**
 * 模型行可能已经被删了（ai_chats.model_row_id 是 NOT NULL + 外键），
 * 硬插会整条恢复失败。这里退到「当前随便一个还在的模型」，并在返回里说清楚。
 */
function pickModel(wanted) {
  if (wanted != null && db.prepare('SELECT 1 FROM ai_models WHERE id = ?').get(wanted)) return { id: wanted, changed: false };
  const any = db.prepare('SELECT id FROM ai_models ORDER BY id ASC LIMIT 1').get();
  return { id: any ? any.id : null, changed: wanted != null && !!any };
}

function restoreChatSnap(snap, opts = {}) {
  const keepId = idFree('ai_chats', snap.chat.id) ? snap.chat.id : null;
  const model = pickModel(snap.chat.model_row_id);
  const row = Object.assign({}, snap.chat, { user_id: 1 });
  if (opts.projectId !== undefined) row.project_id = opts.projectId;
  if (opts.dropRemote) row.remote_id = null;
  if (model.id !== null) row.model_row_id = model.id;
  row.id = keepId;
  const target = insert('ai_chats', row);
  let messages = 0;
  for (const m of snap.messages || []) {
    insert('ai_chat_messages', Object.assign({}, m, { chat_id: target, id: idFree('ai_chat_messages', m.id) ? m.id : null }));
    messages++;
  }
  for (const t of snap.tasks || []) {
    insert('tasks', Object.assign({}, t, { chat_id: target, id: idFree('tasks', t.id) ? t.id : null }));
  }
  return { id: target, messages, modelChanged: model.changed };
}

/** 恢复一条回收站记录：会话（或项目连同其会话）原样塞回去，id 还空着就用原来的 id */
function restore(id) {
  const row = db.prepare('SELECT * FROM ai_trash WHERE id = ?').get(Number(id));
  if (!row) throw new Error('回收站里没有这一条');
  if (row.restored_at) return { kind: row.kind, title: row.title, already: true, chats: [] };
  let payload = null;
  try { payload = JSON.parse(row.payload); } catch (e) { throw new Error('快照数据已损坏，恢复不了'); }
  const hostGone = (chatRow) => chatRow.remote_id != null
    && !db.prepare('SELECT 1 FROM ai_remote_hosts WHERE id = ?').get(chatRow.remote_id);

  const run = db.transaction(() => {
    if (row.kind === 'chat') {
      const dropped = hostGone(payload.chat);
      const r = restoreChatSnap(payload, { dropRemote: dropped });
      db.prepare('UPDATE ai_trash SET restored_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
      return { chats: [r.id], messages: r.messages, modelChanged: r.modelChanged, remoteDropped: dropped };
    }
    const keepPid = idFree('projects', payload.project.id) ? payload.project.id : null;
    const projectId = insert('projects', Object.assign({}, payload.project, { id: keepPid }));
    const chats = []; let messages = 0; let modelChanged = false; let remoteDropped = false;
    for (const c of payload.chats || []) {
      const dropped = hostGone(c.chat);
      const r = restoreChatSnap(c, { projectId, dropRemote: dropped });
      chats.push(r.id); messages += r.messages;
      modelChanged = modelChanged || r.modelChanged;
      remoteDropped = remoteDropped || dropped;
    }
    db.prepare('UPDATE ai_trash SET restored_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
    return { chats, messages, projectId, modelChanged, remoteDropped };
  });

  return Object.assign({ kind: row.kind, title: row.title, path: row.path }, run());
}

function remove(id) {
  const r = db.prepare('DELETE FROM ai_trash WHERE id = ?').run(Number(id));
  if (!r.changes) throw new Error('回收站里没有这一条');
  return true;
}

function clear() {
  const r = db.prepare('DELETE FROM ai_trash').run();
  return r.changes;
}

function stats() {
  const a = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(payload)),0) AS b FROM ai_trash').get();
  return { items: a.n, bytes: a.b };
}

module.exports = { snapshotChat, snapshotProject, trashChat, trashProject, trashForRemoteHost, list, restore, remove, clear, stats };
