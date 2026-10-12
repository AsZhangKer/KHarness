/**
 * 「自动压缩阈值存不住」这一条的三段锁（第七十轮，他真机连报两次）。
 *
 * 他看到的形状是：填了值点保存 → 输入框变回空白 +「未设置」提示；不点保存刷新也是空白。
 * 三段各有一个不许回退的写法：
 *   显示 —— 库里第一次就有这一行（种子值 80），界面显示的就是生效的那个数，不是空白；
 *   存储 —— 种船用 INSERT OR IGNORE，重启不许把用户改过的值盖回 80；
 *   调取 —— 判定只从 compressThresholdPct() 走，别处再写死一个 0.8 就是两套口径。
 * 外加前端那段「回 200 也要读回来对一遍」：后端版本旧时会静默丢掉新键照样说保存成功，
 * 那正是「保存了、刷新就没」的成因，必须点名报错而不是留一个空白框让人猜。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const page = fs.readFileSync(path.resolve(ROOT, 'client/src/features/settings/SettingsPage.vue'), 'utf8');
const save = page.slice(page.indexOf('async function saveUpstream'), page.indexOf('async function setApproval'));
const defaults = fs.readFileSync(path.resolve(ROOT, 'server/data/defaults.js'), 'utf8');
const settings = fs.readFileSync(path.resolve(ROOT, 'server/routes/settings.js'), 'utf8');
const database = fs.readFileSync(path.resolve(ROOT, 'server/database.js'), 'utf8');
const ai = fs.readFileSync(path.resolve(ROOT, 'server/routes/ai.js'), 'utf8');
const copy = fs.readFileSync(path.resolve(ROOT, 'client/src/copy/settings.js'), 'utf8');

describe('阈值这条设置：显示 / 存储 / 调取 三段都锁住', () => {
  it('新库种子带着这一项，值就是代码里那个默认 80', () => {
    expect(defaults).toMatch(/compress_threshold: '80'/);
  });

  it('种船用 INSERT OR IGNORE —— 重启不许盖掉用户改过的值', () => {
    const fn = database.slice(database.indexOf('function insertDefaultData'), database.indexOf('let initialized'));
    expect(fn).toMatch(/INSERT OR IGNORE INTO settings \(key, value\)/);
    expect(fn).not.toMatch(/ON CONFLICT\(key\) DO UPDATE/);
  });

  it('判定只有一个入口：读设置项，不再写死 80%／0.8', () => {
    expect(ai).toMatch(/function compressThresholdPct\(\) \{ return numSetting\('compress_threshold', 80, 10, 95\); \}/);
    const fn = ai.slice(ai.indexOf('const maybeAutoCompress'), ai.indexOf('const maybeAutoCompress') + 2200);
    expect(fn).toMatch(/const thr = compressThresholdPct\(\);/);
    expect(fn).toMatch(/if \(liveUsed < limit \* thr \/ 100\) return false;/);
    expect(fn).not.toMatch(/liveUsed < limit \* 0\.8/);
    expect(fn).not.toMatch(/liveUsed < limit \* 80 \/ 100/);
  });

  it('PUT 设置必须同时点 updated_at —— 不然「谁什么时候改的」永远查不出来', () => {
    expect(settings).toMatch(/ON CONFLICT\(key\) DO UPDATE SET value = excluded\.value, updated_at = CURRENT_TIMESTAMP/);
  });

  it('保存后按提交项逐条读回比对，对不上就点名（旧后端会静默丢掉新键）', () => {
    expect(save).toMatch(/const st = await settingsApi\.getAll\(\);/);
    expect(save).toMatch(/String\(st\?\.\[k\]\) !== String\(payload\[k\]\)/);
    expect(save).toMatch(/txt\('settings\.notStored'/);
    // 不许退回「PUT 完就直接说已保存」
    expect(save).not.toMatch(/await settingsApi\.update\(payload\);\s*\}\s*catch \(e\) \{\s*return toastErr\(e, '上游设置保存失败'\);\s*\}\s*if \(shell\.value\)/);
  });

  it('那句报错在文案表里，且带「重启」的指路', () => {
    expect(copy).toMatch(/'settings\.notStored':/);
    expect(copy).toMatch(/\{keys\}/);
    expect(copy).toMatch(/重启 KHarness/);
  });
});
