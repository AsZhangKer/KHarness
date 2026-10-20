/**
 * 手机桥「离线补投」与「已裁决回执」（本轮新增）。
 *
 * 背景：手机 App 没开着（或正在退避重连）的那段时间，后端推的事件会被静默丢弃 ——
 * 旧实现第一行就是 `if (!enabled() || !session) return null`。表现是「App 没开就什么都收不到」。
 *
 * 这里用**真实 TCP** 验证（不 mock socket，因为要证的正是握手时机的补投）：
 *   ① 没连接时推提醒 → 入队不丢；手机连上 → 立刻补投
 *   ② 没连接时推审批 → 入队，且总超时按**入队时刻**算（不会被补投悄悄拉长）
 *   ③ 电脑端已裁决 → dropQueued 把还没补投的同目标事件撤掉
 *   ④ 桥被关掉（enabled=false）→ 不排队、不假装发送
 *
 * 数据目录指向临时目录：既有 privatepaths 用例被 shell 里残留的 KH_DATA_DIR 带偏的前车之鉴，
 * 这个文件绝不碰主人正在用的库。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);

// 关键顺序：先改数据目录，再 require —— database.js 在 require 时就打开库了
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-lanbridge-'));
process.env.KH_DATA_DIR = TMP_DIR;

const lanbridge = nodeRequire('../utils/lanbridge');
const { db, initDatabase } = nodeRequire('../database');
initDatabase();   // 临时库是空的，得先把表建起来

const setSetting = (k, v) => db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
).run(k, v);
const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;

let PORT = 0;

/** 找一个空闲端口给桥用（避免和真实 45678 抢） */
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

/** 4 字节大端长度 + JSON */
function writeFrame(sock, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  sock.write(Buffer.concat([head, body]));
}

/** 扮一台手机连上去：发 hello，把收到的帧攒在 frames 里 */
function connectPhone(hello) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, '127.0.0.1');
    const frames = [];
    let buf = Buffer.alloc(0);
    sock.on('connect', () => writeFrame(sock, hello));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 4) break;
        const len = buf.readUInt32BE(0);
        if (buf.length < 4 + len) break;
        const body = buf.slice(4, 4 + len).toString('utf8');
        buf = buf.slice(4 + len);
        try { frames.push(JSON.parse(body)); } catch (e) { /* 坏帧 */ }
      }
    });
    sock.on('error', reject);
    // 连上就 resolve：调用方自己等某类帧出现
    sock.on('connect', () => resolve({ sock, frames }));
    setTimeout(() => resolve({ sock, frames }), 2000);
  });
}

/** 轮询等条件成立（补投是握手后立刻发的，但网络上仍有一两跳延迟） */
async function waitFor(fn, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等桥回到「没有手机连接」的状态 —— 上一个用例 destroy() 之后服务端 close 事件是异步的 */
async function ensureOffline(ms = 2000) {
  const ok = await waitFor(() => !lanbridge.status().connected, ms);
  expect(ok).toBe(true);
}

beforeAll(async () => {
  PORT = await freePort();
  setSetting('lanbridge_port', String(PORT));
  setSetting('lanbridge_sid', 'test-sid-0001');
  setSetting('lanbridge_paired_cid', 'test-cid-0001');
  setSetting('lanbridge_token', 'test-token-0001');
  setSetting('lanbridge_enabled', '1');
  lanbridge.sync();
  await sleep(150);   // 等 TCP 监听起来
});

afterAll(() => {
  try { setSetting('lanbridge_enabled', '0'); lanbridge.sync(); } catch (e) { /* 忽略 */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
});

const HELLO = { type: 'hello', sid: 'test-sid-0001', cid: 'test-cid-0001', token: 'test-token-0001' };

describe('离线补投', () => {
  it('没连接时推提醒：入队不丢，手机一连上立刻补投', async () => {
    await ensureOffline();
    expect(lanbridge.status().connected).toBe(false);
    const before = lanbridge.queuedCount();

    // 提醒类（timeoutMs = 0）：App 没开着也应该收到
    await lanbridge.push({ kind: 'question', id: 'q-offline-1', question: '在吗？', options: [] },
      { kind: 'question', id: 'q-offline-1', chatId: 1 });

    expect(lanbridge.queuedCount()).toBe(before + 1);

    const phone = await connectPhone(HELLO);
    try {
      const got = await waitFor(() => phone.frames.some((f) => f.type === 'event' && f.payload?.id === 'q-offline-1'));
      expect(phone.frames.some((f) => f.type === 'hello_ack' && f.ok)).toBe(true);
      expect(got).toBe(true);                       // 连上瞬间补投出去了
      expect(lanbridge.queuedCount()).toBe(before); // 队列已清空
    } finally { phone.sock.destroy(); }
  });

  it('没连接时推审批：补投时仍能收到手机的回复', async () => {
    await ensureOffline();
    // 审批是等待类：无连接时入队，超时从入队时刻算
    const waiting = lanbridge.pushAndWait(
      { kind: 'approval', id: 'a-offline-1', tool: 'run_command', reason: '越界' }, 5000, { kind: 'approval', id: 'a-offline-1' });
    expect(lanbridge.queuedCount()).toBe(1);

    const phone = await connectPhone(HELLO);
    try {
      const arrived = await waitFor(() => phone.frames.find((f) => f.type === 'event' && f.payload?.id === 'a-offline-1'));
      expect(arrived).toBe(true);
      // 手机回复：带 seq 的 reply，后端应按 seq 认领并 resolve 掉那个 Promise
      const evt = phone.frames.find((f) => f.type === 'event' && f.payload?.id === 'a-offline-1');
      writeFrame(phone.sock, { v: 1, type: 'reply', seq: evt.seq, payload: { ok: true } });
      const reply = await waiting;
      expect(reply).toEqual({ ok: true });
    } finally { phone.sock.destroy(); }
  });

  it('等待类没人理：按入队时刻超时，不因为补投被无限拉长', async () => {
    await ensureOffline();
    const t0 = Date.now();
    const p = lanbridge.pushAndWait({ kind: 'approval', id: 'a-offline-timeout' }, 300, null);
    expect(lanbridge.queuedCount()).toBe(1);
    const r = await p;
    expect(r).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1500);   // 300ms 量级，不是被拖到很久
    expect(lanbridge.queuedCount()).toBe(0);      // 超时后从队列移除
  });

  it('dropQueued：电脑端已裁决的项，不再补投给手机', async () => {
    await ensureOffline();
    await lanbridge.push({ kind: 'question', id: 'q-drop-1' }, { kind: 'question', id: 'q-drop-1' });
    await lanbridge.push({ kind: 'question', id: 'q-keep-1' }, { kind: 'question', id: 'q-keep-1' });
    const n = lanbridge.dropQueued((p) => p && p.kind === 'question' && p.id === 'q-drop-1');
    expect(n).toBe(1);
    expect(lanbridge.queuedCount()).toBe(1);      // 只剩 keep 那条

    const phone = await connectPhone(HELLO);
    try {
      await waitFor(() => phone.frames.some((f) => f.payload?.id === 'q-keep-1'));
      const ids = phone.frames.filter((f) => f.type === 'event').map((f) => f.payload?.id);
      expect(ids).toContain('q-keep-1');
      expect(ids).not.toContain('q-drop-1');       // 已裁决的不再打扰
    } finally { phone.sock.destroy(); }
  });

  it('桥关着（enabled=false）时不排队：用户明确关了就不偷偷攒', async () => {
    setSetting('lanbridge_enabled', '0');
    const n = lanbridge.queuedCount();
    await lanbridge.push({ kind: 'question', id: 'q-when-disabled' });
    expect(lanbridge.queuedCount()).toBe(n);
    setSetting('lanbridge_enabled', '1');
  });

  it('队列有上限：超量只丢最老的，不会无限涨', async () => {
    for (let i = 0; i < 80; i++) {
      await lanbridge.push({ kind: 'question', id: `q-flood-${i}` });
    }
    expect(lanbridge.queuedCount()).toBeLessThanOrEqual(50);
    lanbridge.dropQueued(() => true);   // 清干净，别影响后续
    expect(lanbridge.queuedCount()).toBe(0);
  });
});
