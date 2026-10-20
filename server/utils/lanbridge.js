/**
 * lanbridge —— 局域网手机审批/回答桥（把 KHarness 的审批、ask_user 提问、中断「继续」
 * 推给同一局域网内的手机端，手机回执后裁决）。
 *
 * 协议完全复刻参考项目 JsonBridge.Sender（C#）/ JsonBridge_Receiver（Android）：
 *   · 发现：每秒从每张真实 IPv4 网卡发一次**组播**到 239.255.42.99:37020
 *     （手机端 DiscoveryListener joinGroup 同一个组播组；用 239.255.42.99 而非
 *     255.255.255.255，因为 Android 默认丢弃全局广播），载荷 {magic:"JSONBRIDGE/1",
 *     role:"win-controller", sid, name, tcp_port}
 *   · 传输：TCP 0.0.0.0:<tcp_port>，4 字节大端长度前缀 + UTF-8 JSON 帧（≤8MB）
 *   · 配对：手机首连自动绑定 cid+token；此后 sid/cid/token 三者校验，不符拒绝
 *   · 请求-响应：发 {type:"event", seq, payload} → 手机回 {type:"reply", seq, payload}，
 *     按 seq 配对
 *
 * 开关：settings.lanbridge_enabled（bool，默认关）。判定点与前端顶栏那颗「手机」开关共用。
 * 端口：settings.lanbridge_port（默认 45678，可改避开冲突）。
 */
const net = require('net');
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');
const { db } = require('../database');

const MAGIC = 'JSONBRIDGE/1';
const MULTICAST_GROUP = '239.255.42.99';
const DISCOVERY_PORT = 37020;
const DEFAULT_TCP_PORT = 45678;
const MAX_FRAME = 8 * 1024 * 1024;
const HELLO_TIMEOUT_MS = 10 * 1000;

// ---------- 配对身份（存 settings 表，重启不丢） ----------
function readPair() {
  try {
    const sid = db.prepare("SELECT value FROM settings WHERE key = 'lanbridge_sid'").get()?.value;
    const pairedCid = db.prepare("SELECT value FROM settings WHERE key = 'lanbridge_paired_cid'").get()?.value;
    const token = db.prepare("SELECT value FROM settings WHERE key = 'lanbridge_token'").get()?.value;
    return { sid: sid || '', pairedCid: pairedCid || '', token: token || '' };
  } catch (e) { return { sid: '', pairedCid: '', token: '' }; }
}
function savePair(p) {
  const stmt = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP");
  db.transaction(() => {
    stmt.run('lanbridge_sid', p.sid);
    stmt.run('lanbridge_paired_cid', p.pairedCid);
    stmt.run('lanbridge_token', p.token);
  })();
}
function ensureSid() {
  const p = readPair();
  if (!p.sid) { p.sid = crypto.randomBytes(16).toString('hex'); savePair(p); }
  return p;
}
function resetPairing() {
  const p = { sid: ensureSid().sid, pairedCid: '', token: '' };
  savePair(p);
  return p;
}

// ---------- 开关 / 端口 ----------
function enabled() {
  try { return db.prepare("SELECT value FROM settings WHERE key = 'lanbridge_enabled'").get()?.value === '1'; } catch (e) { return false; }
}
function tcpPort() {
  try {
    const n = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'lanbridge_port'").get()?.value);
    return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : DEFAULT_TCP_PORT;
  } catch (e) { return DEFAULT_TCP_PORT; }
}

// ---------- 广播（组播，Android 能收到） ----------
// 手机端 DiscoveryListener 是 joinGroup(239.255.42.99) 收**组播**，后端必须发到同一个组播组。
// 这里只枚举各真实网卡的本地 IPv4（作为组播出口接口），不再算子网广播地址。
function broadcastTargets() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const a of ifaces[name] || []) {
      if (a.family !== 'IPv4') continue;
      if (a.internal) continue;
      if (!a.netmask) continue;
      out.push({ local: a.address });
    }
  }
  return out;
}

// ---------- TCP 帧协议 ----------
function frameWrite(sock, obj) {
  const bytes = Buffer.from(JSON.stringify(obj), 'utf8');
  if (bytes.length < 1 || bytes.length > MAX_FRAME) return false;
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length, 0);
  sock.write(Buffer.concat([header, bytes]));
  return true;
}
function frameReadAll(sock, onFrame) {
  let buf = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 4) return;
      const len = buf.readUInt32BE(0);
      if (len < 1 || len > MAX_FRAME) { sock.destroy(); return; }
      if (buf.length < 4 + len) return;
      const body = buf.slice(4, 4 + len).toString('utf8');
      buf = buf.slice(4 + len);
      try { onFrame(JSON.parse(body)); }
      catch (e) { /* 坏帧丢弃 */ }
    }
  });
}

// ---------- 会话 ----------
let server = null;
let broadcaster = null;
let session = null;      // 当前已配对的手机连接
let seqCounter = 0;
const pendingReplies = new Map();   // seq -> { resolve, timer, kind }
// seq -> 调用方上下文（如 { kind:'question', id }）。
// 手机端 reply 的载荷只有 { answered, answer } / { ok } 这类业务字段，
// 不带 kind/id，所以「这条回复是回给谁的」只能靠 push 时登记的 seq 来认领。
const seqContexts = new Map();

/** 登记 seq 上下文；问句/审批可能挂很久，加个上限防止只增不减 */
function rememberSeq(seq, ctx) {
  seqContexts.set(seq, ctx);
  if (seqContexts.size > 500) {
    const oldest = seqContexts.keys().next().value;
    seqContexts.delete(oldest);
  }
}
const listeners = new Set();        // 状态变化订阅（前端顶栏显示）
const replyListeners = new Set();   // 手机主动 reply（不在等待列表里）分发

function emitState() {
  const st = { running: !!server, connected: !!session, sid: ensureSid().sid };
  for (const fn of listeners) { try { fn(st); } catch (e) { /* 忽略 */ } }
}

// 广播载荷
function discoveryPayload() {
  const p = ensureSid();
  return JSON.stringify({
    magic: MAGIC,
    role: 'win-controller',
    sid: p.sid,
    name: 'KHarness',
    tcp_port: tcpPort(),
  });
}

function startBroadcaster() {
  if (broadcaster) return;
  const send = () => {
    const bytes = Buffer.from(discoveryPayload(), 'utf8');
    // 手机端 DiscoveryListener 是 joinGroup(239.255.42.99) 收**组播**，
    // 后端必须发到同一个组播组，否则手机发现不到（旧实现发的是子网广播地址，两端对不上）。
    const targets = broadcastTargets();
    if (!targets.length) return;
    for (const t of targets) {
      try {
        const s = dgram.createSocket('udp4');
        s.on('error', () => { try { s.close(); } catch (e) {} });
        s.bind(() => {
          s.setMulticastInterface(t.local);   // 指定出口网卡（组播默认可能走错网卡）
          s.setMulticastTTL(1);               // 组播 TTL 显式设 1，保证跨网段一跳可达
          s.send(bytes, DISCOVERY_PORT, MULTICAST_GROUP, () => { try { s.close(); } catch (e) {} });
        });
      } catch (e) { /* 单卡失败不影响其他 */ }
    }
  };
  send();
  broadcaster = setInterval(send, 1000);
  if (broadcaster.unref) broadcaster.unref();
}

function stopBroadcaster() {
  if (broadcaster) { clearInterval(broadcaster); broadcaster = null; }
}

function handleClient(sock) {
  const remote = sock.remoteAddress || '';
  let cid = '';
  let handshook = false;
  let helloTimer = setTimeout(() => { if (!handshook) sock.destroy(); }, HELLO_TIMEOUT_MS);

  frameReadAll(sock, (msg) => {
    const type = msg.type;
    if (type === 'hello') {
      clearTimeout(helloTimer);
      const p = ensureSid();
      // 调试：打印手机 hello 与后端配对状态，定位 cid_mismatch 根因
      console.log('[lanbridge] hello: 手机=' + JSON.stringify({ sid: msg.sid, cid: msg.cid, token: msg.token }) + ' 后端=' + JSON.stringify({ sid: p.sid, pairedCid: p.pairedCid, token: p.token }));
      // 校验 sid
      if (String(msg.sid || '') !== p.sid) {
        frameWrite(sock, { type: 'hello_ack', ok: false, error: 'sid_mismatch' });
        sock.destroy(); return;
      }
      cid = String(msg.cid || '');
      const token = String(msg.token || '');
      if (!cid) {
        frameWrite(sock, { type: 'hello_ack', ok: false, error: 'missing_cid' });
        sock.destroy(); return;
      }
      // 配对校验
      if (!p.pairedCid) {
        // 首次绑定
        p.pairedCid = cid; p.token = token; savePair(p);
      } else if (p.pairedCid !== cid) {
        frameWrite(sock, { type: 'hello_ack', ok: false, error: 'cid_mismatch' });
        sock.destroy(); return;
      } else if (p.token !== token) {
        frameWrite(sock, { type: 'hello_ack', ok: false, error: 'bad_token' });
        sock.destroy(); return;
      }
      handshook = true;
      frameWrite(sock, { type: 'hello_ack', ok: true, session: crypto.randomBytes(8).toString('hex') });
      // 单连接锁：踢掉旧会话
      if (session && session !== sock) { try { session.destroy(); } catch (e) {} }
      session = sock;
      emitState();
      flushOffline();     // 手机刚连上：把积压的事件补投出去（App 没开着时收到的提醒不再丢）
      return;
    }
    if (!handshook) { sock.destroy(); return; }
    if (type === 'reply') {
      const seq = Number(msg.seq);
      const pend = pendingReplies.get(seq);
      // 先按 seq 认领上下文：手机回复不带 kind/id，只有 seq 能对上号
      const ctx = seqContexts.get(seq) || null;
      if (ctx) seqContexts.delete(seq);
      // 调试：原样打印手机回的 reply，确认 payload 结构（手机端与后端协议是否一致）
      console.log('[lanbridge] 手机 reply:', JSON.stringify({ seq, payload: msg.payload || {} }));
      if (pend) {
        pendingReplies.delete(seq);
        if (pend.timer) clearTimeout(pend.timer);
        pend.resolve(msg.payload || {});
      } else {
        // 不在等待列表里的 reply（如 question 的随时回复）：分发给全局回调（ai.js 注册）
        const payload = msg.payload || {};
        for (const fn of replyListeners) { try { fn(payload, seq, ctx); } catch (e) { /* 忽略 */ } }
      }
      return;
    }
    if (type === 'ping') {
      frameWrite(sock, { type: 'pong', ts: Math.floor(Date.now() / 1000) });
    }
  });

  sock.on('close', () => {
    if (session === sock) { session = null; emitState(); }
  });
  sock.on('error', () => { try { sock.destroy(); } catch (e) {} });
}

function startServer() {
  if (server) return;
  const port = tcpPort();
  server = net.createServer((sock) => {
    sock.setNoDelay(true);
    handleClient(sock);
  });
  server.on('error', (e) => { console.error('[lanbridge] TCP 监听失败:', e.message); server = null; });
  server.listen(port, '0.0.0.0', () => {
    console.log(`[lanbridge] 手机审批桥已开启：TCP 0.0.0.0:${port}，广播 ${MULTICAST_GROUP}:${DISCOVERY_PORT}`);
    emitState();
  });
}

function stopServer() {
  if (server) {
    try { server.close(); } catch (e) {}
    server = null;
  }
  if (session) { try { session.destroy(); } catch (e) {} session = null; }
  for (const [, pend] of pendingReplies) {
    if (pend.timer) clearTimeout(pend.timer);
    pend.resolve({ error: 'bridge_closed' });
  }
  pendingReplies.clear();
  seqContexts.clear();
  for (const item of [...offlineQueue]) finishQueued(item, null);   // 桥停了：积压项一并作废
  emitState();
}

/** 按当前开关状态启停（供 index.js 启动时与设置变更时调用） */
function sync() {
  if (enabled()) { startBroadcaster(); startServer(); }
  else { stopBroadcaster(); stopServer(); }
}

// ---------- 离线补投队列 ----------
// 手机不在线（App 没开 / 刚断开 / 正在退避重连）时，事件不再直接丢弃：
//   · 提醒类（提问、已裁决回执）：入队，手机一连上立刻补投；最多留 5 分钟、最多 50 条
//   · 等待类（审批）：同样入队，且**总超时从入队那一刻起算**，不会因为补投把等待时间悄悄拉长
// 这解决了「App 没开着就收不到任何提醒」的根因（旧实现是 `if (!session) return null` 静默丢弃）。
const offlineQueue = [];
const OFFLINE_MAX = 50;
const OFFLINE_TTL_MS = 5 * 60 * 1000;

/** 结束一个队列项：移出队列、清定时器、清 seq 登记、resolve */
function finishQueued(item, result) {
  if (!item || item.done) return;
  item.done = true;
  const i = offlineQueue.indexOf(item);
  if (i >= 0) offlineQueue.splice(i, 1);
  if (item.timer) { clearTimeout(item.timer); item.timer = null; }
  if (item.seq) { pendingReplies.delete(item.seq); seqContexts.delete(item.seq); }
  try { item.resolve(result); } catch (e) { /* 忽略 */ }
}

function enqueueOffline(payload, timeoutMs, ctx) {
  const wait = timeoutMs > 0;
  let resolveFn = null;
  const promise = new Promise((resolve) => { resolveFn = resolve; });
  const item = {
    payload, ctx, wait, timeoutMs,
    enqueuedAt: Date.now(),
    expireAt: wait ? 0 : Date.now() + OFFLINE_TTL_MS,
    seq: 0, done: false, resolve: resolveFn, timer: null,
  };
  if (wait) {
    item.timer = setTimeout(() => finishQueued(item, null), timeoutMs);
    if (item.timer.unref) item.timer.unref();
  }
  offlineQueue.push(item);
  while (offlineQueue.length > OFFLINE_MAX) finishQueued(offlineQueue[0], null);
  if (!wait) resolveFn(null);      // 提醒类本来就不等回复
  return promise;
}

/** 手机连上后把积压的事件按序补投（等回复的重新挂进 pendingReplies，超时仍按入队时刻算） */
function flushOffline() {
  if (!session || !offlineQueue.length) return;
  const items = offlineQueue.splice(0);
  const now = Date.now();
  for (const item of items) {
    if (item.done) continue;
    if (!item.wait && item.expireAt && now > item.expireAt) { finishQueued(item, null); continue; }
    const seq = ++seqCounter;
    item.seq = seq;
    if (item.ctx) rememberSeq(seq, item.ctx);
    if (item.wait) {
      // timer 已经在跑（总超时从入队时刻算），这里只把它接到 pendingReplies 上
      pendingReplies.set(seq, { resolve: (reply) => finishQueued(item, reply), timer: null });
    }
    try {
      frameWrite(session, { v: 1, type: 'event', seq, ts: Math.floor(Date.now() / 1000), payload: item.payload });
    } catch (e) { finishQueued(item, null); }
  }
}

/** 电脑端已裁决：把队列里同一目标还没发出去的项撤掉（免得手机连上后收到一张已经没用的卡） */
function dropQueued(pred) {
  if (typeof pred !== 'function') return 0;
  let n = 0;
  for (const item of [...offlineQueue]) {
    let hit = false;
    try { hit = !!pred(item.payload); } catch (e) { hit = false; }
    if (hit) { finishQueued(item, null); n++; }
  }
  return n;
}

/** 当前积压条数（状态展示 / 排查用） */
function queuedCount() { return offlineQueue.length; }

/**
 * 推一条事件给手机并等回复（带超时）。
 * payload：要发给手机的对象；timeoutMs：等待秒数（0 = 不等回复，只推送）。
 * 返回 Promise<replyPayload | null>。没开 / 超时返回 null；**没连接时入队，连上补投**。
 */
function pushAndWait(payload, timeoutMs = 0, ctx = null) {
  if (!enabled()) return Promise.resolve(null);      // 桥被用户关了：不排队，也不假装发送
  if (!session) return enqueueOffline(payload, timeoutMs, ctx);   // 手机不在线：入队，连上补投
  if (!timeoutMs || timeoutMs <= 0) {
    // 只推送不等待：仍然登记 seq 上下文，手机回复时靠它认领（见 seqContexts 的说明）
    const seq = ++seqCounter;
    if (ctx) rememberSeq(seq, ctx);
    try { frameWrite(session, { v: 1, type: 'event', seq, ts: Math.floor(Date.now() / 1000), payload }); }
    catch (e) { seqContexts.delete(seq); return Promise.resolve(null); }
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const seq = ++seqCounter;
    if (ctx) rememberSeq(seq, ctx);
    const timer = setTimeout(() => {
      pendingReplies.delete(seq);
      seqContexts.delete(seq);
      resolve(null);
    }, timeoutMs);
    pendingReplies.set(seq, { resolve, timer });
    try {
      frameWrite(session, { v: 1, type: 'event', seq, ts: Math.floor(Date.now() / 1000), payload });
    } catch (e) {
      clearTimeout(timer);
      pendingReplies.delete(seq);
      seqContexts.delete(seq);
      resolve(null);
    }
  });
}

/** 只推送、不等回复（审批/提问的「提醒」用）；ctx 用于手机回复时按 seq 认领 */
function push(payload, ctx = null) {
  return pushAndWait(payload, 0, ctx);
}

// ---------- 订阅状态（前端顶栏显示） ----------
function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
/** 手机主动 reply（不在等待列表里，如 question 随时回复）的分发注册 */
function onReply(fn) {
  replyListeners.add(fn);
  return () => replyListeners.delete(fn);
}
function status() {
  return { running: !!server, connected: !!session, enabled: enabled(), sid: ensureSid().sid };
}

module.exports = {
  sync, push, pushAndWait, status, subscribe, onReply, resetPairing,
  enabled, tcpPort, DEFAULT_TCP_PORT, dropQueued, queuedCount,
};