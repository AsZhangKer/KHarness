/**
 * 终端 REST/SSE（挂在 /api/ai/term）。
 * 输出走 SSE（EventSource），输入/尺寸/关闭走 POST —— 与聊天、托管同一套流式通路。
 *
 * 每个会话都有独立的输出流，切换标签不会把两份 shell 混到一起；
 * 改名/导出/归档这些标签级操作也都按 id 走，前端不需要自己攒日志。
 */
const express = require('express');
const { db } = require('../database');
const { ok, fail, failErr, wrap } = require('../utils/respond');
const term = require('../utils/term');

const router = express.Router();

/** 可选终端类型 + 可用状态；前端下拉直接吃这个 */
router.get('/options', wrap(async (req, res) => {
  const info = term.info();
  ok(res, {
    pty_ok: info.pty,
    pty_error: info.ptyError,
    max: info.max,
    shells: term.localShells(),
    hosts: db.prepare('SELECT id, name, host, port, username, default_cwd, home FROM ai_remote_hosts ORDER BY sort_order ASC, id ASC').all(),
  });
}));

/** 系统字体列表：前端那个「字体」下拉从这儿来 */
router.get('/fonts', wrap((req, res) => ok(res, { fonts: term.fonts() })));

/** 自定义终端（名称 + exe 路径）整体覆盖保存，同时回一份带 id 的结果 */
router.post('/custom', wrap((req, res) => {
  const list = term.saveCustomTerminals(Array.isArray(req.body?.terminals) ? req.body.terminals : []);
  ok(res, { terminals: list }, '自定义终端已保存');
}));

router.post('/admin-default', wrap((req, res) => {
  return fail(res, 410, '终端的「管理员权限」功能已撤掉（实测会把新建终端卡在等 UAC），这个开关不再存在');
}));

router.get('/', wrap((req, res) => ok(res, term.list())));

router.post('/open', wrap(async (req, res) => {
  try {
    const s = await term.open(req.body || {});
    ok(res, { id: s.id, title: s.title, kind: s.kind, shell: s.shellLabel, host: s.hostName });
  } catch (e) {
    failErr(res, 502, '终端开不起来', e);
  }
}));

router.post('/:id/title', wrap((req, res) => {
  const title = String(req.body?.title || '').trim();
  if (!title) return fail(res, 400, '标签名不能为空');
  if (!term.setTitle(req.params.id, title)) return fail(res, 404, '终端会话不存在（可能已经被回收）');
  ok(res, { title }, '已改名');
}));

/** 导出内容：回纯文本（ANSI 已剥掉），前端塞进 Blob 下载 */
router.get('/:id/dump', wrap((req, res) => {
  const text = term.dump(req.params.id);
  if (text == null) return fail(res, 404, '终端会话不存在（可能已经被回收）');
  ok(res, { text, bytes: Buffer.byteLength(text, 'utf8') });
}));

/** 归档：日志进回收站，然后关掉这个 tty */
router.post('/:id/archive', wrap(async (req, res) => {
  try {
    const r = await term.archive(req.params.id);
    ok(res, r, r.where === '回收站' ? '日志已放入回收站，终端已关闭' : `日志留在 ${r.file}，终端已关闭`);
  } catch (e) {
    failErr(res, 500, '归档失败', e);
  }
}));

router.post('/:id/input', wrap((req, res) => {
  const data = String(req.body?.data || '');
  if (!data) return ok(res, null);
  if (!term.write(req.params.id, data)) return fail(res, 410, '这个终端已经退出了，重开一个即可');
  ok(res, null);
}));

router.post('/:id/resize', wrap((req, res) => {
  term.resize(req.params.id, req.body?.cols, req.body?.rows);
  ok(res, null);
}));

router.post('/:id/close', wrap((req, res) => {
  term.kill(req.params.id, '用户关闭');
  ok(res, null, '终端已关闭');
}));

/** 输出流：EventSource 直连（不走 axios），所以这条路由不能被 json 解析器影响 */
router.get('/:id/stream', (req, res) => {
  if (!term.attach(req.params.id, res)) {
    res.status(404).json({ code: 404, message: '终端会话不存在或已被回收' });
  }
});

module.exports = router;
