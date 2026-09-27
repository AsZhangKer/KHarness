const express = require('express');
const { db } = require('../database');
const { ok, fail, wrap } = require('../utils/respond');

const router = express.Router();

// 公开设置（桌面端 harness 无鉴权，全部可读）
router.get('/', wrap((req, res) => {
  const settings = db.prepare('SELECT key, value FROM settings').all();
  const settingsObj = {};
  settings.forEach(s => {
    settingsObj[s.key] = s.value;
  });
  ok(res, settingsObj);
}));

// 布尔型设置统一存成 '1' / '0'
function boolSetting(v) {
  if (v === true || v === 1 || v === '1' || v === 'true') return '1';
  if (v === false || v === 0 || v === '0' || v === 'false') return '0';
  return null;
}

// 更新设置（白名单键；桌面端无鉴权）
const SETTING_KEYS = {
  rl_retry_max: v => { const n = parseInt(v); return Number.isInteger(n) && n >= 0 && n <= 100 ? String(n) : null; },
  // run_command 单次超时（秒）；0 = 不限制（长构建场景）
  cmd_timeout_seconds: v => { const n = parseInt(v); return Number.isInteger(n) && n >= 0 && n <= 7200 ? String(n) : null; },
  default_context_limit: v => { const n = parseInt(v); return Number.isInteger(n) && n >= 0 && n <= 1000000 ? String(n) : null; },
  agent_shell: v => String(v || '').trim().substring(0, 300) || null,
  // 提示音总闸与音量（音量和音效一起存，界面上滑条即时生效）
  sound_enabled: boolSetting,
  sound_volume: v => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 1 ? String(Math.round(n * 100) / 100) : null; },
  // 压缩时保留最近几条原文（0 = 全压进摘要）
  compress_keep_messages: v => { const n = parseInt(v); return Number.isInteger(n) && n >= 0 && n <= 50 ? String(n) : null; },
  // 审批等待时长（秒）：太短会来不及看，太长挂着一轮不放
  approval_timeout_seconds: v => { const n = parseInt(v); return Number.isInteger(n) && n >= 30 && n <= 3600 ? String(n) : null; },
  // 这三条是给前端看的显示偏好，服务端只管存
  reasoning_default_open: boolSetting,
  long_reply_collapse: boolSetting,
  tool_call_collapse: boolSetting,
  /* 界面尺寸类偏好也放这儿，不放 localStorage：
     桌面端每次启动的端口都可能变，origin 带端口，localStorage 就跟着分家，
     存在那里的东西每启动一次回一次默认值（终端字体「设置了不记住」就是这么来的）。 */
  term_font: v => String(v || '').trim().substring(0, 120) || '',
  term_size: v => { const n = parseInt(v); return Number.isInteger(n) && n >= 9 && n <= 28 ? String(n) : null; },
  // 底部终端浮窗高度（px）
  term_height: v => { const n = parseInt(v); return Number.isInteger(n) && n >= 120 && n <= 4000 ? String(n) : null; },
  // 首页输入框被拖到多高（px）；0 = 没调过，用样式默认值
  composer_height: v => { const n = parseInt(v); return Number.isInteger(n) && n >= 0 && n <= 2000 ? String(n) : null; }
};
router.put('/', wrap((req, res) => {
  const updates = [];
  const params = [];
  for (const [key, validate] of Object.entries(SETTING_KEYS)) {
    if (req.body?.[key] !== undefined) {
      const v = validate(req.body[key]);
      if (v === null) return fail(res, 400, `设置 ${key} 的值无效`);
      updates.push(key);
      params.push(v);
    }
  }
  if (!updates.length) return fail(res, 400, '没有可更新的设置项');
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const tx = db.transaction(() => { for (let i = 0; i < updates.length; i++) stmt.run(updates[i], params[i]); });
  tx();
  ok(res, null, '设置已保存');
}));

module.exports = router;
