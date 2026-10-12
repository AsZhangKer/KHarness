/**
 * 「调试」板块的后端通道（第六十四轮）：日志快照 + SSE 实时流 + 清空。
 *
 * 只有开发版开着：正式版（pack-prep 写过 version.json 的那些）一律 404 ——
 * 这套无鉴权服务握着密钥与对话，不该在交付给别人的包里多开一扇能读走全部运行日志的门。
 */
const express = require('express');
const logbus = require('../utils/logbus');
const build = require('../utils/build');
const { ok, wrap } = require('../utils/respond');

const router = express.Router();

// 每一扇门都先问这个：正式版没有调试
router.use((req, res, next) => {
  if (build.isDev()) return next();
  res.status(404).json({ code: 404, message: '调试通道仅开发版可用' });
});

router.get('/logs', wrap((req, res) => {
  const n = Math.min(2000, Math.max(1, parseInt(req.query.n) || 500));
  ok(res, { lines: logbus.snapshot(n), total: logbus.size(), version: build.resolve().display });
}));

router.delete('/logs', wrap((req, res) => {
  logbus.clear();
  ok(res, { total: logbus.size() }, '日志已清空');
}));

// 实时流：连上先补一段历史（订阅时由 snapshot 发出），之后每行一条
router.get('/logs/stream', wrap((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  const send = (obj) => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    } catch (e) { /* 客户端已断开 */ }
  };
  send({ t: 'hello', version: build.resolve().display, total: logbus.size() });
  const unsubscribe = logbus.subscribe((line) => send({ t: 'log', line }));
  // 没日志的时候也得让中间层知道这条连接活着（浏览器自己会断在 300s 那种地方）
  const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* 已关 */ } }, 20000);
  res.on('close', () => { clearInterval(beat); unsubscribe(); });
}));

module.exports = router;
