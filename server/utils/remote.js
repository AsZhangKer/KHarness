/**
 * 远程主机通道（阶段 5）：只做「怎么连、怎么执行、怎么读写文件」，不含任何审批/边界策略 ——
 * 那些仍然留在 routes/ai.js 的 execTool 里，本地与远程共用同一套上层判断。
 *
 * 几个刻意的选择：
 * 1) 连接按主机 id 池化复用（一次 SSH 握手几百毫秒，工具循环里每条命令都重连会慢得没法用），
 *    空闲 5 分钟自动关；连接死了下一次调用会重连，调用方不用管。
 * 2) 凭证与 ai_providers.api_key 同一口径：明文存 kh.db。这台机器本来就握着全部模型密钥，
 *    再造一套「加密但密钥也在本机」的东西只是自我安慰。
 * 3) 报错一律走 describeError()：ssh2 的 err.level 分协议层/传输层，光看 message 分不清是
 *    密码错、主机密钥变了、还是网络断了。
 * 4) runRemoteCommand 的返回形状与本地 runShellCommand 完全一致（{output}/{error} + 部分输出
 *    + 改用 run_background 的建议），这样工具循环与前端撤销卡都不用为远程特判。
 */
const path = require('path');
const crypto = require('crypto');
const { Client } = require('ssh2');

const CONN_TIMEOUT_MS = 15000;
const IDLE_CLOSE_MS = 5 * 60 * 1000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;   // 单条命令输出上限，超出截断（与本地 maxBuffer 同量级）
const READ_FILE_MAX_BYTES = 8 * 1024 * 1024; // read_file 上限，比本地更保守：整份走网络进内存

const pool = new Map(); // hostId -> { conn, sftp, busy, lastUsed, closing }

function describeError(e) {
  if (!e) return String(e);
  const bits = [];
  if (e.level) bits.push(e.level);            // client-auth / handshake / connection / protocol
  bits.push(String(e.message || e));
  if (e.code) bits.push(e.code);
  if (e.errno) bits.push(String(e.errno));
  return bits.filter(Boolean).join('｜');
}

function connectOptions(row) {
  const opt = {
    host: row.host,
    port: Number(row.port) || 22,
    username: row.username || 'root',
    readyTimeout: CONN_TIMEOUT_MS,
    keepaliveInterval: 10000,
    keepaliveCountMax: 3,
    // 首版不校验主机指纹（kh.db 里没有 known_hosts 的概念，直接拒连会让「填 IP 密码就能连」
    // 这个目标落空）。代价是中间人风险，后面要收口就在这里换成显式指纹比对。
  };
  if (row.auth === 'key' && row.private_key) {
    opt.privateKey = row.private_key;
    if (row.secret) opt.passphrase = row.secret;
  } else {
    opt.password = row.secret || '';
  }
  return opt;
}

/** 拿到一条活连接（没有就建；建失败抛 describeError 后的信息） */
function getConnection(row) {
  return new Promise((resolve, reject) => {
    const id = row.id;
    const held = pool.get(id);
    if (held && held.conn && !held.closing) {
      held.lastUsed = Date.now();
      return resolve(held);
    }
    const entry = { conn: null, sftp: null, lastUsed: Date.now(), closing: false };
    const conn = new Client();
    const opt = connectOptions(row);
    let settled = false;
    conn.on('ready', () => {
      entry.conn = conn;
      entry.lastUsed = Date.now();
      pool.set(id, entry);
      settled = true;
      resolve(entry);
    });
    conn.on('error', (err) => {
      pool.delete(id);
      try { conn.end(); } catch (e) { /* 已经断了 */ }
      if (settled) return;                     // 已经成功过的连接后续报错交给调用方
      settled = true;
      reject(new Error(`连不上 ${row.username || 'root'}@${row.host}:${opt.port}：${describeError(err)}`));
    });
    conn.on('close', () => {
      entry.closing = true;
      if (pool.get(id) === entry) pool.delete(id);
    });
    conn.on('end', () => {
      if (pool.get(id) === entry) pool.delete(id);
    });
    try {
      conn.connect(opt);
    } catch (e) {
      settled = true;
      reject(new Error(describeError(e)));
    }
  });
}

function sftpOf(entry) {
  if (entry.sftp) return Promise.resolve(entry.sftp);
  return new Promise((resolve, reject) => {
    entry.conn.sftp((err, sftp) => {
      if (err) return reject(new Error(`打不开 SFTP 通道：${describeError(err)}`));
      entry.sftp = sftp;
      resolve(sftp);
    });
  });
}

/** 主动关掉某台机器的连接（编辑/删除连接时用） */
function close(rowId) {
  const held = pool.get(rowId);
  if (!held) return;
  held.closing = true;
  pool.delete(rowId);
  try { held.conn && held.conn.end(); } catch (e) { /* 已经没了 */ }
}

function closeAll() {
  for (const id of [...pool.keys()]) close(id);
}

// 空闲回收：unref 让这个定时器不阻止进程退出
const reaper = setInterval(() => {
  const now = Date.now();
  for (const [id, held] of pool) {
    if (!held.closing && now - held.lastUsed > IDLE_CLOSE_MS) close(id);
  }
}, 60000);
if (reaper.unref) reaper.unref();

/**
 * 远程执行一条命令。返回形状与本地 runShellCommand 一致：{ output } 或 { error }。
 * holder 沿用本地的约定：holder.manualTimeout 由「超时」按钮调用，holder.child 这里放一个
 * 假子进程（只有 kill 语义），让上层「停止」按钮不用分本地/远程两套代码。
 */
async function runRemoteCommand(row, command, opts = {}) {
  const { cwd, holder = {}, timeoutMs = 0, onChunk = null } = opts;
  let entry;
  try {
    entry = await getConnection(row);
  } catch (e) {
    return { error: `SSH 连接失败：${e.message}` };
  }
  entry.lastUsed = Date.now();
  const fullCmd = cwd ? `cd ${shellQuote(cwd)} && (${command})` : command;

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const outBuf = [];
    const errBuf = [];
    let bytes = 0;
    let truncated = false;
    const partialText = () => {
      const join = (bufs) => Buffer.concat(bufs).toString('utf8');
      const o = join(outBuf), e = join(errBuf);
      return [o, e && `[stderr]\n${e}`].filter(Boolean).join('\n') || '(无输出)';
    };
    const finish = (r) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      holder.child = null;
      holder.manualTimeout = null;
      resolve(r);
    };

    let stream;
    try {
      stream = null;
      entry.conn.exec(fullCmd, (err, s) => {
        if (err) return finish({ error: `命令送不出去：${describeError(err)}` });
        stream = s;
        // 「停止」按钮与进程树回收在远程没有本地 PID 可用：关掉这条流即可（远端进程由 sshd 收尾）
        holder.child = { pid: null, kill: () => { try { s.close(); } catch (e) { /* 已关 */ } } };
        holder.command = command;
        holder.startedAt = Date.now();
        holder.manualTimeout = () => triggerTimeout(true, Date.now() - holder.startedAt);
        s.on('data', (c) => { push(c, outBuf); onChunk && onChunk(c.toString('utf8')); });
        s.stderr.on('data', (c) => { push(c, errBuf); onChunk && onChunk(c.toString('utf8')); });
        s.on('close', (code) => {
          const body = partialText();
          if (truncated) return finish({ output: body + `\n[输出超过 ${MAX_OUTPUT_BYTES / 1024 / 1024}MB，已截断。要更多请用 head/tail/grep 收窄后重跑]` });
          if (code && code !== 0) return finish({ output: `${body}\n[退出码 ${code}]` });
          finish({ output: body || '(无输出)' });
        });
        s.on('error', (e) => finish({ error: `流中断：${describeError(e)}` }));
      });
    } catch (e) {
      return finish({ error: describeError(e) });
    }

    const push = (chunk, buf) => {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (bytes + b.length > MAX_OUTPUT_BYTES) {
        truncated = true;
        buf.push(b.subarray(0, Math.max(0, MAX_OUTPUT_BYTES - bytes)));
        return;
      }
      bytes += b.length;
      buf.push(b);
    };

    function triggerTimeout(byUser, waitedMs) {
      if (settled) return false;
      const secs = Math.max(1, Math.round((waitedMs || timeoutMs || 0) / 1000));
      const head = byUser
        ? `用户在第 ${secs} 秒手动判定该命令已超时，远程通道已关闭。`
        : `命令运行超过 ${secs} 秒已超时，远程通道已关闭。`;
      finish({
        error: head + `\n已收集到的部分输出：\n${partialText().substring(0, 6000)}` +
          `\n[系统提示] 命令未完成而不是环境故障：需要更久请把命令拆小、或用 nohup ... & 放到远端后台再查。`,
      });
      try { stream && stream.close(); } catch (e) { /* 已关 */ }
      return true;
    }
    if (timeoutMs > 0) timer = setTimeout(() => triggerTimeout(false, timeoutMs), timeoutMs);
  });
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * 远端路径一律按 posix 归一：消解 ./ ../ 与重复斜杠、去掉尾斜杠，结果总是以 / 开头。
 * 本地那套 path.resolve 在 Windows 上会把 /srv/app 变成 \srv\app，所以远程一律走这个。
 */
function posixPath(p) {
  const raw = String(p || '').trim().replace(/\\/g, '/');
  if (!raw) return '';
  const abs = raw.startsWith('/') ? raw : `/${raw}`;
  const out = [];
  for (const seg of abs.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return '/' + out.join('/');
}

/** 连通性自检：给「测试连接」按钮用，返回系统概览 */
async function probe(row) {
  const r = await runRemoteCommand(row, 'uname -srmo; echo "user=$(id -un)"; echo "home=$HOME"; pwd', { timeoutMs: 20000 });
  if (r.error) return { ok: false, error: r.error };
  return { ok: true, info: r.output.trim(), home: /home=([^\n]*)/.exec(r.output)?.[1] || '' };
}

/* ---------------- SFTP 读写 ---------------- */

async function sftpCall(row, fn) {
  const entry = await getConnection(row);
  entry.lastUsed = Date.now();
  const sftp = await sftpOf(entry);
  return new Promise((resolve, reject) => {
    fn(sftp, (err, val) => (err ? reject(new Error(describeError(err))) : resolve(val)));
  });
}

const SFTP_TYPE = { 2: 'dir', 1: 'file', 5: 'link', 4: 'fifo', 6: 'sock', 7: 'block', 8: 'char' };

/**
 * 判断远端条目是文件还是目录。
 *
 * 这里踩过一个坑，别再踩第二次：ssh2 的 Stats 对象**没有 `type` 字段**
 * （lib/protocol/SFTP.js 里只有 mode/uid/gid/size/atime/mtime + isDirectory() 一组方法），
 * 只有 libssh2/SFTP v4 那种 attrs.type 才有 1=普通 2=目录。
 * 早先按 attrs.type 查表，真机上永远 undefined → 所有条目都被当成文件，
 * 于是「进不去目录」「/home/ker 说它不是目录」「mkdirP 以为目录已存在所以不建」一串现象全来了，
 * 而自测里的假 SFTP 恰好返回了 type 字段，所以测试全绿、真机全废。
 * 现在优先用 isDirectory() 这些判定，再退回按 mode 的 S_IFMT 位算，两条路都不依赖 type。
 */
const S_IFMT = 0o170000;
function typeOfAttrs(attrs) {
  if (!attrs) return 'file';
  if (typeof attrs.isDirectory === 'function') {
    if (attrs.isDirectory()) return 'dir';
    if (attrs.isSymbolicLink && attrs.isSymbolicLink()) return 'link';
    if (attrs.isFIFO && attrs.isFIFO()) return 'fifo';
    if (attrs.isSocket && attrs.isSocket()) return 'sock';
    if (attrs.isBlockDevice && attrs.isBlockDevice()) return 'block';
    if (attrs.isCharacterDevice && attrs.isCharacterDevice()) return 'char';
    if (typeof attrs.isFile === 'function' ? attrs.isFile() : true) return 'file';
    return 'other';
  }
  const fmt = (Number(attrs.mode) || 0) & S_IFMT;
  if (fmt === 0o040000) return 'dir';
  if (fmt === 0o120000) return 'link';
  if (fmt === 0o010000) return 'fifo';
  if (fmt === 0o020000) return 'char';
  if (fmt === 0o060000) return 'block';
  if (fmt === 0o140000) return 'sock';
  if (fmt === 0o100000) return 'file';
  // 只有极少数服务端会带 type（SFTP v4 的类型字节），有就用它兜底
  return SFTP_TYPE[attrs.type] || 'file';
}

async function listDir(row, p) {
  const items = await sftpCall(row, (sftp, cb) => sftp.readdir(p, cb));
  return items.map((it) => ({
    name: it.filename,
    type: typeOfAttrs(it.attrs),
    size: Number(it.attrs && it.attrs.size) || 0,
    mtime: (Number(it.attrs && it.attrs.mtime) || 0) * 1000,
    mode: Number(it.attrs && it.attrs.mode) & 0o777,
  })).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
}

async function stat(row, p) {
  const st = await sftpCall(row, (sftp, cb) => sftp.stat(p, cb));
  return { type: typeOfAttrs(st), size: Number(st.size) || 0, mtime: (Number(st.mtime) || 0) * 1000, mode: Number(st.mode) & 0o777 };
}

async function readFile(row, p) {
  const st = await stat(row, p).catch(() => null);
  if (st && st.type === 'dir') throw new Error(`${p} 是目录，不是文件（要浏览目录请用文件区，或 list_dir）`);
  if (st && st.size > READ_FILE_MAX_BYTES) throw new Error(`远端文件 ${(st.size / 1048576).toFixed(1)}MB，超过 ${READ_FILE_MAX_BYTES / 1048576}MB 上限，别整个读进上下文`);
  const buf = await sftpCall(row, (sftp, cb) => {
    const chunks = [];
    const rs = sftp.createReadStream(p);
    rs.on('data', (c) => chunks.push(c));
    rs.on('end', () => cb(null, Buffer.concat(chunks)));
    rs.on('error', cb);
  });
  return buf;
}

/** 写文件：先确保父目录存在（远端没有 mkdir -p 的 sftp 语义，逐级建） */
async function writeFile(row, p, content) {
  await mkdirP(row, path.posix.dirname(String(p).replace(/\\/g, '/')) || '/');
  return sftpCall(row, (sftp, cb) => {
    const ws = sftp.createWriteStream(p);
    ws.on('close', () => cb(null, true));
    ws.on('error', cb);
    ws.end(Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8'));
  });
}

async function mkdirP(row, p) {
  const clean = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  if (!clean || clean === '/') return true;
  try { await stat(row, clean); return true; } catch (e) { /* 不存在，逐级建 */ }
  await mkdirP(row, path.posix.dirname(clean));
  try {
    return await sftpCall(row, (sftp, cb) => sftp.mkdir(clean, cb));
  } catch (e) {
    // 并发下可能刚被别的调用建好
    if (/already|exists/i.test(String(e.message))) return true;
    throw e;
  }
}

async function remove(row, p, isDir) {
  return sftpCall(row, (sftp, cb) => (isDir ? sftp.rmdir(p, cb) : sftp.unlink(p, cb)));
}

async function rename(row, from, to) {
  return sftpCall(row, (sftp, cb) => sftp.rename(from, to, cb));
}

/**
 * 远端「移动」：先试 SFTP rename，失败再交给远端 mv。
 *
 * 真机踩到的坑：/tmp 通常是 tmpfs、家目录在另一块设备上，跨设备时 SFTP 的 rename
 * 只会回一个 Failure(4)（内存假实现复现不出来，自测全绿）。mv 自己会「拷过去再删源」，
 * 文件和目录都一样，所以拿它当兜底；仍保留 rename 作快路径（同设备时不依赖 exec 通道，
 * 纯 chroot-sftp 那种只给 SFTP 的机器也能用）。
 */
async function move(row, from, to) {
  const a = posixPath(from);
  const b = posixPath(to);
  let firstErr = null;
  try {
    await rename(row, a, b);
    return { to: b, via: 'rename' };
  } catch (e) {
    firstErr = String(e.message || e);
  }
  const parent = b.replace(/\/[^/]*\/?$/, '') || '/';
  const r = await runRemoteCommand(row, `mkdir -p ${shellQuote(parent)} && mv -f ${shellQuote(a)} ${shellQuote(b)}`, { timeoutMs: 120000 });
  if (r.error) throw new Error(`移动失败：rename 报「${firstErr}」，退回 mv 也没成（${r.error}）`);
  return { to: b, via: 'mv' };
}

/** 远端真实路径（SFTP 的 realpath，用来做工作目录边界校验） */
async function realPath(row, p) {
  return sftpCall(row, (sftp, cb) => sftp.realpath(String(p).replace(/\\/g, '/'), cb));
}

/**
 * 把远端路径移到「远端回收站」而不是直接 rm：Linux 没有系统回收站，只能自造一个暂存区。
 * 返回移动到的新路径。原始字节的快照由调用方记进本机 undo_ops，所以这里只负责「可找回」。
 */
async function trash(row, p, isDir) {
  const stamp = `${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${crypto.randomBytes(2).toString('hex')}`;
  const root = posixPath(row.home || '/tmp').replace(/\/+$/, '') || '/tmp';
  const trashDir = posixPath(`${root}/.kh-undo/${stamp}`);
  await mkdirP(row, trashDir);
  const moved = posixPath(`${trashDir}/${path.posix.basename(posixPath(p))}`);
  await move(row, posixPath(p), moved);
  return { moved, isDir: !!isDir };
}

/**
 * 开一条交互式远端 shell（真 PTY，由远端 sshd 分配）。
 * 终端抽屉用它：不需要 node-pty，也不会有「本地 Windows 控制台冒充 Linux」的错位。
 */
async function openShell(row, opts = {}) {
  const entry = await getConnection(row);
  entry.lastUsed = Date.now();
  return new Promise((resolve, reject) => {
    entry.conn.shell(
      { term: 'xterm-256color', cols: Math.max(20, opts.cols || 100), rows: Math.max(6, opts.rows || 28) },
      (err, stream) => (err ? reject(new Error(`开远端 shell 失败：${describeError(err)}`)) : resolve(stream)),
    );
  });
}

/**
 * 这条会话属于哪台远程主机（null = 本机）。
 * 放在传输层是为了让 routes/ai.js、extools.js、toolgate 那几处都能查同一份，
 * 不用互相 require（routes 之间互相引用会把路由挂载顺序变成隐性依赖）。
 */
function hostForChat(chatId) {
  const id = Number(chatId);
  if (!Number.isInteger(id) || id < 1) return null;
  try {
    const { db } = require('../database');
    const rid = db.prepare('SELECT remote_id FROM ai_chats WHERE id = ?').get(id)?.remote_id;
    if (!rid) return null;
    return db.prepare('SELECT * FROM ai_remote_hosts WHERE id = ?').get(rid) || null;
  } catch (e) {
    return null;   // 表还没迁移（老库刚起来）就当本机
  }
}

module.exports = {
  describeError, shellQuote, posixPath, hostForChat, getConnection, close, closeAll, probe,
  runRemoteCommand, openShell,
  sftp: { list: listDir, stat, readFile, writeFile, mkdirP, remove, rename, move, realPath, trash },
  LIMITS: { CONN_TIMEOUT_MS, IDLE_CLOSE_MS, MAX_OUTPUT_BYTES, READ_FILE_MAX_BYTES },
};
