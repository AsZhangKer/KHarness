// Computer Use 的管理接口：实验室开关、全部开放、急停快捷键、授权清单、netwright 检测。
// 工具本身走 toolgate（模型调用），这里只服务界面：设置页与右栏「电脑操作」面板。
const express = require('express');
const { ok, fail, wrap } = require('../utils/respond');
const cuse = require('../utils/cuse');

const router = express.Router();

// Computer Use 的底层（PowerShell 坐标引擎 / netwright）只有 Windows 有。
// 读接口照常回（前端据 state.supported 显示「本平台不支持」），**所有写接口整组挡掉**：
// 免得在非 Windows 上留下一个「能拨但什么都不发生」的开关，也免得逐条路由各判一次漏掉某条。
router.use((req, res, next) => {
  if (req.method !== 'GET' && !cuse.supported()) return fail(res, 400, cuse.NOT_SUPPORTED);
  return next();
});

// 面板/设置页轮询用：一次性给出全部状态。
// open_pending_ack：重启后若「全部开放」还开着，服务端置 1，前端据此弹警告询问是否关掉
// （按主人的口径：不自动关，只提醒）。ack 一次后清掉，避免每次轮询都弹。
router.get('/state', wrap((req, res) => {
  const st = cuse.state(Number(req.query.chat_id) || 0);
  st.open_pending_ack = cuse.getSetting('computer_open_pending_ack', '') === '1';
  ok(res, st);
}));

// 总开关（实验室功能 → Computer Use）。开的时候顺带拉起坐标引擎、检测 netwright、预置黑名单。
router.post('/enabled', wrap((req, res) => {
  const on = !!req.body?.enabled;
  ok(res, cuse.setGroupEnabled(on));
}));

// 「全部开放（危险）」。开启时置 restart 提醒标记：下次启动要问一次。
router.post('/open-all', wrap((req, res) => {
  const on = !!req.body?.enabled;
  cuse.setSetting('computer_open_all', on ? '1' : '0');
  if (on) cuse.setSetting('computer_open_pending_ack', '1');
  else cuse.setSetting('computer_open_pending_ack', '0');
  ok(res, { open_all: on });
}));

// 用户看过重启警告并做了选择（保留 / 关掉）后确认，免得反复弹。
router.post('/open-all/ack', wrap((req, res) => {
  cuse.setSetting('computer_open_pending_ack', '0');
  ok(res, { ok: true });
}));

// 引擎偏好：auto / coords / netwright
router.post('/engine', wrap((req, res) => {
  const v = String(req.body?.engine || 'auto');
  if (!['auto', 'coords', 'netwright'].includes(v)) return fail(res, 400, 'engine 只能是 auto / coords / netwright');
  cuse.setSetting('computer_engine', v);
  ok(res, { engine: v });
}));

// 急停快捷键：spec 形如 ctrl+alt+q / xbutton1（鼠标侧键）；空串=取消。
// 必须 await：下发给守护进程是异步的，直接 ok(res, promise) 会被序列化成 {}，
// 界面看到「设置成功」其实钩子可能压根没装上（实测就是这个坑）。
router.post('/hotkey', wrap(async (req, res) => {
  const r = await cuse.setHotkey(String(req.body?.spec || ''));
  return ok(res, r);
}));

// 手动急停：撤销全部授权（与快捷键同一出口），前端也放一颗按钮。
router.post('/emergency-stop', wrap((req, res) => {
  ok(res, cuse.emergencyStop(String(req.body?.reason || 'manual')));
}));

// 授权清单（含跨会话 chat_id=0 的全局授权），可按 id 撤销。
router.post('/grant', wrap((req, res) => {
  const b = req.body || {};
  const r = cuse.addGrant(Number(b.chat_id) || 0, { pid: b.pid, exe: b.exe, title: b.title, scope: b.scope });
  if (r.error) return fail(res, 400, r.error);
  ok(res, { grants: cuse.grantsFor(Number(b.chat_id) || 0).map((g) => ({ id: g.id, pid: g.pid, exe: g.exe, title: g.title, scope: g.scope })) });
}));

router.post('/grant/revoke', wrap((req, res) => {
  const r = cuse.removeGrant(req.body?.id);
  if (r.error) return fail(res, 400, r.error);
  ok(res, { ok: true });
}));

// 重新检测 netwright（装完之后点一下，不用重启 KHarness）
router.post('/detect', wrap((req, res) => {
  cuse.detectNetwright(() => {});
  // 探测是异步的：先回「检测中」，前端过两秒再读 /state
  ok(res, { detecting: true });
}));

// 引擎状态长轮询：急停（快捷键触发）要能立刻反映到界面上。
// 没有事件时挂住 20 秒再回，避免前端空转打请求。
router.get('/events', (req, res) => {
  const since = Number(req.query.since) || 0;
  const send = () => {
    const d = cuse.drainStops(since);
    if (d.events.length || Date.now() - started > 20000) {
      clearInterval(timer);
      res.json({ code: 200, message: 'success', data: d });
      return true;
    }
    return false;
  };
  const started = Date.now();
  const timer = setInterval(send, 500);
  req.on('close', () => clearInterval(timer));
  send();
});

// 只读诊断：直接问守护进程要窗口清单/屏幕布局（面板顶部「现在屏幕上有什么」按钮）。
router.post('/probe', wrap(async (req, res) => {
  const cmd = String(req.body?.cmd || 'displays');
  if (!['displays', 'windows', 'foreground', 'cursor_pos', 'ping', 'hotkey_state'].includes(cmd)) {
    return fail(res, 400, `不允许的探测命令：${cmd}`);
  }
  try { ok(res, await cuse.daemonCall(cmd, {}, 15000)); }
  catch (e) { fail(res, 500, `坐标引擎没响应：${String((e && e.message) || e)}`); }
}));

module.exports = router;
