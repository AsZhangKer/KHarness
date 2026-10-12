const express = require('express');
const fs = require('fs');
const path = require('path');
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

/**
 * 版本信息（设置-关于要显示真实版本号，别再写死「NewUI-dev 重构版」）。
 * 来源与「开发版/正式版」的判定统一在 utils/build.js —— 「调试」板块显不显示、
 * 后端 /api/debug/* 开不开，问的都是同一个答案。
 */
router.get('/app-info', wrap((req, res) => {
  const b = require('../utils/build').resolve();
  ok(res, { version: b.version, display: b.display, packaged: b.packaged, platform: process.platform, node: process.version });
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
  // 上游不可用（500/502/503/504/524）的自动重试次数，和 429 各算各的
  gw_retry_max: v => { const n = parseInt(v); return Number.isInteger(n) && n >= 0 && n <= 100 ? String(n) : null; },
  // run_command 单次超时（秒）；0 = 不限制（长构建场景）
  cmd_timeout_seconds: v => { const n = parseInt(v); return Number.isInteger(n) && n >= 0 && n <= 7200 ? String(n) : null; },
  default_context_limit: v => { const n = parseInt(v); return Number.isInteger(n) && n >= 0 && n <= 2147483647 ? String(n) : null; },
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
  // 全局代理总闸：打开后所有提供商即使勾了「代理」也走直连（判定点见 utils/proxy.js）
  proxy_disabled: boolSetting,
  // 内置浏览器 UA 形态：只有这两种，工具与界面开关共用
  browser_ua_mode: v => (['desktop', 'mobile'].includes(String(v || '').trim()) ? String(v).trim() : null),
  /* 界面尺寸类偏好也放这儿，不放 localStorage：
     桌面端每次启动的端口都可能变，origin 带端口，localStorage 就跟着分家，
     存在那里的东西每启动一次回一次默认值（终端字体「设置了不记住」就是这么来的）。 */
  term_font: v => String(v || '').trim().substring(0, 120) || '',
  term_size: v => { const n = parseInt(v); return Number.isInteger(n) && n >= 9 && n <= 28 ? String(n) : null; },
  // 底部终端浮窗高度（px）
  term_height: v => { const n = parseInt(v); return Number.isInteger(n) && n >= 120 && n <= 4000 ? String(n) : null; },
  // 首页输入框被拖到多高（px）；0 = 没调过，用样式默认值
  composer_height: v => { const n = parseInt(v); return Number.isInteger(n) && n >= 0 && n <= 2000 ? String(n) : null; },
  /* 截图送给模型前的最长边上限（px）；0 = 不缩放。
     存服务端而不是 localStorage：桌面端每次启动端口都可能变，localStorage 按 origin 分家会失忆。
     读取方是桌面外壳（截图在那里落盘），GET /api/settings 一次就拿走。 */
  img_max_side: v => { const n = parseInt(v); return Number.isInteger(n) && n >= 0 && n <= 8192 ? String(n) : null; },
  /* 同一操作（工具名 + 参数完全一样）连续几次就打断，防模型自循环。
     下限 2：设成 1 等于第一次就掐，正常重试都会被打断。判定点见 routes/ai.js 的 repeatStreak。 */
  repeat_break_threshold: v => { const n = parseInt(v); return Number.isInteger(n) && n >= 2 && n <= 20 ? String(n) : null; },
  // 监工 / 托管：已半废弃，默认关，只有实验室里打开才能用（判定点见 routes/ai.js 的 supervisorOn()）
  supervisor_enabled: boolSetting,
  // 工具能力地图（第五十三轮，补充五）：把本轮真要发出去的工具表压成一览塞进 system，
  // 默认开；关掉它就退回只有那段手写规则。判定点 routes/ai.js 的 capabilityMapOn()
  tool_capability_map: boolSetting,
  // 文本级卡带检测：模型在一段输出里原地复读时掐断。判据照第三方同类项目的成熟参数，
  // 阈值可下调到 60 字（更灵敏更易误报）或关掉。判定点 routes/ai.js 的 stallBreak
  stall_guard_enabled: boolSetting,
  // 本轮工具结果自动落盘（超预算折成摘要 + 全文写缓存）；关=本轮一个字都不折，靠压缩兜
  round_tool_fold: boolSetting,
  // FULL-SEND 审批档的实验室总闸：默认关。关着时这一档连出现在选择菜单里都没有，
  // 且存量会话行里的 fullsend 会自动降回 default。判定点 routes/ai.js 的 fullSendLabOn()
  fullsend_enabled: boolSetting,
  // 多模型池（failover）：已半废弃，默认关，只有实验室里打开才有入口（照 supervisor_enabled 那套）
  pool_enabled: boolSetting,
  stall_min_chars: v => { const n = parseInt(v); return Number.isInteger(n) && n >= 60 && n <= 2000 ? String(n) : null; },
  // 上下文自动压缩阈值（占窗口百分比）。原来写死 80%，没得调 —— 长上下文模型想早点压、
  // 短上下文模型想压到极限再压，都改不了。判定点 routes/ai.js 的 maybeAutoCompress。
  compress_threshold: v => { const n = parseInt(v); return Number.isInteger(n) && n >= 10 && n <= 95 ? String(n) : null; },
  // 同一条会话同时在跑的子智能体上限。0 = 不限（他自己盯着额度时用），判定点 utils/subagent.js。
  // 上限给到 50：再高就已经不是「开几个分身」而是拿它刷接口了，误填一个三位数只会把机器压死。
  subagent_max_parallel: v => { const n = parseInt(v); return Number.isInteger(n) && n >= 0 && n <= 50 ? String(n) : null; }
};
router.put('/', wrap((req, res) => {
  const updates = [];
  const params = [];
  /* 请求体里出现了白名单没有的键 = 前端比后端新（装机版没重启就是这种形状）。
     以前是静默丢掉、照样回「设置已保存」，于是界面上填着的值根本没进库，刷新就回原值 —— 看着像「没做持久化」。
     现在直接说清楚，别让人对着一个没写进去的输入框猜。 */
  const unknown = Object.keys(req.body || {}).filter((k) => !(k in SETTING_KEYS));
  if (unknown.length) {
    return fail(res, 400, `服务端不认识这些设置项：${unknown.join('、')}。多半是后端还在跑旧版本，重启 KHarness 后再试。`);
  }
  for (const [key, validate] of Object.entries(SETTING_KEYS)) {
    if (req.body?.[key] !== undefined) {
      const v = validate(req.body[key]);
      if (v === null) return fail(res, 400, `设置 ${key} 的值无效`);
      updates.push(key);
      params.push(v);
    }
  }
  if (!updates.length) return fail(res, 400, '没有可更新的设置项');
  // updated_at 必须跟着写：这张表的列是建表时给的默认值，ON CONFLICT 不点它就一直停在插入那天。
  // 今天查「default_context_limit 到底什么时候被人改回 1000000 的」就因为这个问题完全没答案。
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP');
  const tx = db.transaction(() => { for (let i = 0; i < updates.length; i++) stmt.run(updates[i], params[i]); });
  tx();
  // 代理总闸是缓存着读的（每条请求都要判一次），改完立刻失效，不然要等 5 秒才生效
  if (updates.includes('proxy_disabled')) require('../utils/proxy').cacheBust();
  ok(res, null, '设置已保存');
}));

module.exports = router;
