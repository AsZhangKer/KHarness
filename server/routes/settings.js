const express = require('express');
const { db } = require('../database');
const { ok, wrap } = require('../utils/respond');

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

module.exports = router;
