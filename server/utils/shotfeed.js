/**
 * 截图类工具（browser_screenshot_full / screen_capture）的「文件 → 模型能看到的图片」这一段。
 *
 * 为什么要单独一层：外壳（主进程）把 PNG 落在 DATA_DIR 的 browser-shots / screen-shots 里，
 * 后端和它共用同一个 DATA_DIR，所以后端直接按路径读回来就行，不必让几 MB base64 穿过
 * 动作队列的 HTTP 通道 —— 那条路上还要过 redactSecrets 和审查词表，一命中就把整回合掐掉。
 *
 * 两条硬约束（都是安全线，不是洁癖）：
 *  · 只认这两个目录里的文件。不这样限的话，任何工具回一个绝对路径就等于把用户磁盘上的
 *    任意文件读进上下文 —— read_file 那条路是有审批的，这里没有。
 *  · 有大小上限。整页/全屏图动辄几 MB，base64 后再乘 4/3，上游请求体和内存都吃不消；
 *    超限就只回路径文字，并在回喂里说清「图没进来」，别让模型以为自己看过了。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config');
const privatepaths = require('./privatepaths');

const SHOT_DIRS = ['browser-shots', 'screen-shots'].map((d) => path.join(DATA_DIR, d));
const MAX_BYTES = 4 * 1024 * 1024;

/** 这个路径是不是「本服务自己写的截图」；返回 null 表示不是（或拿不到） */
function insideShotDir(raw) {
  let abs = '';
  try { abs = path.resolve(String(raw)); } catch (e) { return null; }
  return SHOT_DIRS.some((d) => abs.startsWith(d + path.sep)) ? abs : null;
}

/**
 * 读出图片并登记，回 { token, marker } 或 { note }（note = 没回喂成功时要告诉模型的那句话）。
 * put 是 routes/ai.js 的 imageStorePut —— 那张表在那边（还要给 /chat/image/:token 用），
 * 这里不重复建一份，只做「读文件 + 判断该不该读」。
 *
 * opts.allowAny：view_image 专用。那条路的审批与越界判定由 read_file 同一套把关（FILE_TARGET_TOOLS），
 * 所以这里可以放宽到任意路径，但 KHarness 自己的数据仍然挡 —— 两道墙不能因为「这个是可信工具」就塌一道。
 */
function shotFromFile(file, put, opts = {}) {
  if (!file || typeof file !== 'string') return null;
  let abs = '';
  if (opts.allowAny) {
    try { abs = path.resolve(String(file)); } catch (e) { return null; }
    const priv = privatepaths.guardPrivatePath(abs, { chatId: opts.chatId });
    if (priv) return { note: `[图片未回喂] ${priv}` };
  } else {
    abs = insideShotDir(file);
    if (!abs) return { note: `[图片未回喂] 截图路径不在截图目录内：${file}` };
  }
  let stat = null;
  try { stat = fs.statSync(abs); } catch (e) { return { note: `[图片未回喂] 截图文件读不到（可能已被清掉）：${file}` }; }
  if (!stat.isFile()) return { note: `[图片未回喂] 那不是文件：${file}` };
  if (stat.size > MAX_BYTES) {
    return { note: `[图片未回喂] ${Math.round(stat.size / 1024)} KB 超过单张 ${Math.round(MAX_BYTES / 1024 / 1024)}MB 上限，只留路径 ${file}` };
  }
  let buf = null;
  try { buf = fs.readFileSync(abs); } catch (e) {
    return { note: `[图片未回喂] 读取失败：${String(e.message || e).slice(0, 120)}` };
  }
  // MIME 跟着文件后缀走，不能写死 png：外壳按实验室「图片大小控制」压缩后落盘的是 .jpg，
  // 用 png 标一条 JPEG 数据，上游要么当坏图丢掉、要么解码成灰块 —— 模型会说它「看到了图」其实没看到。
  const mime = /\.jpe?g$/i.test(abs) ? 'image/jpeg' : /\.gif$/i.test(abs) ? 'image/gif'
    : /\.webp$/i.test(abs) ? 'image/webp' : 'image/png';
  const token = put(`data:${mime};base64,${buf.toString('base64')}`);
  return { token, marker: `[[img:${token}]]`, file: abs, bytes: buf.length, mime };
}

/**
 * 把外壳刚落盘的截图收进 <截图目录>/<chat_id>/ 子目录，返回归置后的路径（失败就回原路径）。
 *
 * 为什么要动这一步：外壳只写 `screen-<时间戳>.png`，文件名里没有会话，所以「模型只能回看
 * 本会话截的那几张」这条口径没地方判。挪进以 chat_id 命名的子层之后，光看路径就知道归属，
 * privatepaths 的例外分支也无需查表。归置失败不影响本轮回喂（图已经读到手上了），
 * 只是那条截图之后再也读不到 —— 宁可少给，不能多给。
 */
function claimForChat(file, chatId) {
  const abs = insideShotDir(file);
  if (!abs || !Number.isInteger(chatId) || chatId <= 0) return file;
  const dir = SHOT_DIRS.find((d) => abs.startsWith(d + path.sep));
  if (!dir) return file;
  if (path.relative(dir, abs).includes(path.sep)) return abs;   // 已经归置过
  try {
    const own = path.join(dir, String(chatId));
    fs.mkdirSync(own, { recursive: true });
    const dst = path.join(own, path.basename(abs));
    fs.renameSync(abs, dst);
    return dst;
  } catch (e) { return file; }
}

/**
 * 把截图拼进回喂文本：回喂正文 = 「[[img:token]] + 原来的文字」。
 * 存库和给前端看的还是那份纯文字（marker 只活在这一轮的上游请求里），
 * 图片本身在内存表里 30 分钟后销毁，不会把对话记录撑大。
 */
function feedTextWithShot(result, echoText, put, opts = {}) {
  const shot = result && result.image_file
    ? shotFromFile(result.image_file, put, { allowAny: !!result.image_trusted, chatId: opts.chatId })
    : null;
  if (!shot) return { text: echoText, token: null };
  if (shot.note) return { text: `${echoText}\n${shot.note}`, token: null };
  return { text: `${shot.marker}\n${echoText}`, token: shot.token };
}

module.exports = { shotFromFile, feedTextWithShot, insideShotDir, claimForChat, SHOT_DIRS, MAX_BYTES };
