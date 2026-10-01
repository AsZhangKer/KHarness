/**
 * KHarness 自己的运行数据对模型隐身。
 *
 * 为什么要这一层：普通读操作在默认模式下不审批（routes/ai.js 的 READ_ONLY），越界读顶多弹一行
 * 「read_file D:\...\kh.db」的审批 —— 用户顺手就批了。而那里躺着模型密钥、全部对话、屏幕截图、
 * 被删文件的原件。实测读数（_tmp_kh53/guard_canary.js）：自由会话里批准后 kh.db 备份、.env、日志、
 * 截图全部读得到，grep 一次能捞齐，list_dir 能列全。
 *
 * 所以这里不是「再要一次批准」，而是让这些东西在模型的世界里压根不存在：读不到、列不出、搜不着，
 * 并且报错文案要写清「重试和绕路都没用」，否则模型会换条路径再来一遍。
 *
 * 两套跑法都要挡：装机版数据在 %APPDATA%\KHarness（整个目录都是私人数据，只放开 skills/ 与本会话截图）；
 * 仓库跑法数据就在 server/ 下，那里同时是主人的代码目录，所以只能按文件名精准挡，
 * 不能把 server/ 整片封掉（他天天让 AI 读改 KHarness 自己的源码）。
 */
const path = require('path');
const { DATA_DIR } = require('../config');

const SERVER_DIR = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';
// 数据目录另指（装机版 / KH_DATA_DIR）时，那个目录整体都是用户私人数据
const DATA_DIR_ISOLATED = path.resolve(DATA_DIR) !== SERVER_DIR;

const SHOT_DIRS = new Set(['screen-shots', 'browser-shots']);
const PRIVATE_SEGS = new Set(['.kh-undo', '.kh-term']);
const LOG_EXT = '.log';

const norm = (p) => (IS_WIN ? String(p).toLowerCase() : String(p));

/** abs 是不是在 root 里面（含 root 本身） */
function under(abs, root) {
  const a = norm(abs);
  const r = norm(root);
  return a === r || a.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/** 命中了私人数据：返回相对哪个根、以及被切分的路径段 */
function privateHit(abs, ctx = {}) {
  const a = path.resolve(String(abs || ''));
  const roots = DATA_DIR_ISOLATED ? [DATA_DIR, SERVER_DIR] : [SERVER_DIR];
  for (const root of roots) {
    if (!under(a, root)) continue;
    const rel = path.relative(root, a);
    if (!rel) continue;                                   // 根目录本身不挡（挡了会把 list_dir '.' 连带打死）
    const parts = rel.split(path.sep);
    const seg0 = parts[0];
    const base = parts[parts.length - 1];

    // 数据目录整体私人时，唯一的例外：自定义技能与本会话的截图
    if (DATA_DIR_ISOLATED && root === DATA_DIR) {
      if (seg0 === 'skills') continue;
      if (SHOT_DIRS.has(seg0)) {
        // 截图按会话隔离：<shotdir>/<chat_id>/xxx.png 才放行（文件名直落的那批还没归属，一律挡）
        if (ctx.chatId && parts.length > 2 && String(parts[1]) === String(ctx.chatId)) continue;
        return { abs: a, why: '截图（可能含用户屏幕上的任何内容）' };
      }
      return { abs: a, why: 'KHarness 数据目录' };
    }

    if (SHOT_DIRS.has(seg0)) {
      if (ctx.chatId && parts.length > 2 && String(parts[1]) === String(ctx.chatId)) continue;
      return { abs: a, why: '截图（可能含用户屏幕上的任何内容）' };
    }
    if (PRIVATE_SEGS.has(seg0)) return { abs: a, why: '撤销快照 / 终端归档（被覆盖和被删文件的原始副本）' };
    if (base === '.env') return { abs: a, why: '.env（本机配置与密钥）' };
    if (base.startsWith('kh.db')) return { abs: a, why: 'SQLite 主库及其临时/备份副本（模型密钥与全部对话）' };
    if (base.startsWith('kh.factory-reset')) return { abs: a, why: '恢复出厂的标记与结果文件' };
    if (base.endsWith(LOG_EXT)) return { abs: a, why: '本机日志' };
  }
  return null;
}

/**
 * 工具要碰这个路径时的拒绝文案（返回字符串=拒，null=放行）。
 * 文案里必须说清「批准也不会放开」，不然模型会重试或换 grep / run_command 绕。
 */
function guardPrivatePath(abs, ctx = {}) {
  const hit = privateHit(abs, ctx);
  if (!hit) return null;
  return `访问被拒绝：${hit.abs} 属于 KHarness 自己的运行数据 —— ${hit.why}。`
    + '这一层对模型永久隐身，不是权限不够：用户批准、换绝对路径、改用 grep/glob 或 run_command 都拿不到，请勿再试。'
    + '要搬数据请让用户走 设置 → 关于 → 导出/导入数据库；要查长期记忆用 memory_list / memory_read；'
    + '要看画面就重新截一次（screen_capture / browser_screenshot_full 会直接把图回喂给你），不要去翻截图目录。';
}

/** 遍历（list_dir / grep / glob）里静默跳过：不报错、也不出现在结果中 */
function isPrivateEntry(abs, ctx = {}) {
  return privateHit(abs, ctx) !== null;
}

module.exports = { guardPrivatePath, isPrivateEntry, DATA_DIR, SERVER_DIR, DATA_DIR_ISOLATED };
