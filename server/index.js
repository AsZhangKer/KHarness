const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');

const { PORT, HOST, isProduction, STATIC_DIR } = require('./config');
const { initDatabase, dataHome } = require('./database');
const { errDetail, errMessage } = require('./utils/respond');

initDatabase();

const app = express();
const PORT_FINAL = PORT;

app.set('trust proxy', 1);

// 跨源：桌面端是 win.loadURL(http://127.0.0.1:<端口>)、前端 axios 用相对路径 '/api'，本来就同源，
// 挂 CORS 只会把「任意网页能读这套无鉴权 API 的返回值」这扇门开着 —— 生产不挂。
// dev 下留一个白名单（vite 的 /api 代理其实是同源的，这里只为哪天直连 8317 调试时不炸）。
// 改之前查过的三类潜在跨源消费者：① 内置浏览器注入脚本 —— desktop/main.js 只有 case 'exec' 执行
//   模型给的 JS，我们自己的注入代码不回打 /api；② 终端输出流 EventSource 用相对路径
//   （terminalStore.js:166）；③ 主进程那几处 fetch 是 Node 发的，不带 Origin，与 CORS 无关。
if (!isProduction) {
  app.use(cors({ origin: [/^https?:\/\/(127\.0\.0\.1|localhost):5173$/, /^file:\/\//] }));
}
app.use(compression({
  // SSE（AI 聊天流式响应）禁用压缩：压缩缓冲会让逐字输出变成一次性到达
  filter: (req, res) => {
    if (String(res.getHeader('Content-Type') || '').includes('text/event-stream')) return false;
    return compression.filter(req, res);
  }
}));
// 20mb：上下文导入要把整段会话（正文+思考+工具轨迹）一次性 POST 回来，
// 几十条带 diff 的会话就能超过 1mb；本机单用户应用，这个上限不构成风险。
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// 基础安全响应头
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // CSP：允许同源 + Font Awesome CDN + 内联样式（Vue 需要）
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; " +
    "font-src 'self' https://cdnjs.cloudflare.com; " +
    "img-src 'self' data: blob:; " +
    "connect-src 'self'; " +
    "frame-ancestors 'self'"
  );
  next();
});

// 整库导入是原始字节上传（库文件几 MB 到几十 MB），不能让 json 解析器先吞一遍；
// 只挂在这一条路径上，其它请求照常走上面的 json/urlencoded。
app.use('/api/ai/database/import', express.raw({ type: '*/*', limit: '500mb' }));

// 远程主机（SSH/SFTP）挂在更具体的前缀上，必须先于 /api/ai 注册，否则会被主路由吃掉
app.use('/api/ai/remote', require('./routes/remote'));
app.use('/api/ai/term', require('./routes/terminal'));   // 终端抽屉：SSE 输出 + POST 输入
// Computer Use 同理：/api/ai/computer 要早于 /api/ai
app.use('/api/ai/computer', require('./routes/computer'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/settings', require('./routes/settings'));

// 桌面外壳的优雅退出通道：只有 Electron 每次启动随机发的 token 对得上才生效。
// 走 HTTP 而不是强杀进程，是为了让下面的 exit 钩子有机会回收 AI 起的后台任务；
// Windows 上 taskkill 是直接 TerminateProcess，那些钩子一个都不会跑。
if (process.env.KH_SHUTDOWN_TOKEN) {
  const token = String(process.env.KH_SHUTDOWN_TOKEN);
  app.post('/api/desktop/shutdown', (req, res) => {
    if (String(req.get('x-kh-shutdown-token') || '') !== token) {
      return res.status(403).json({ code: 403, message: 'token 不匹配' });
    }
    res.json({ code: 0, message: 'bye' });
    setTimeout(() => process.exit(0), 50);
  });

  // 导入数据库后要重启才生效。约定退出码 2 = 「请把我再拉起来一次」，
  // 由 Electron 主进程看到后重启子进程；网页端没有外壳，只能提示用户自己重启。
  app.post('/api/desktop/restart', (req, res) => {
    if (String(req.get('x-kh-shutdown-token') || '') !== token) {
      return res.status(403).json({ code: 403, message: 'token 不匹配' });
    }
    res.json({ code: 0, message: 'restarting' });
    setTimeout(() => process.exit(2), 50);
  });

  /* ── 关于页的两把大锤（只有桌面端有这几个口，网页端拿不到 token 就是 404） ──
     db-info / db-move / factory-reset 全部要 token：这个服务只绑 127.0.0.1，
     但「清库」和「改库位置」不能让任意本机网页隔着 fetch 触发。 */
  const needToken = (req, res) => {
    if (String(req.get('x-kh-shutdown-token') || '') === token) return true;
    res.status(403).json({ code: 403, message: 'token 不匹配' });
    return false;
  };

  app.get('/api/desktop/db-info', (req, res) => {
    if (!needToken(req, res)) return;
    res.json({ code: 0, message: 'success', data: { ...require('./database').dbFile(), reset_pending: fs.existsSync(path.join(require('./config').DATA_DIR, 'kh.factory-reset-pending.json')) } });
  });

  // 「有则使用、无则迁移」由 database.copyDbTo 判定；写完指针再重启才真正生效
  app.post('/api/desktop/db-move', async (req, res) => {
    if (!needToken(req, res)) return;
    try {
      const r = await require('./database').copyDbTo(req.body?.dir);
      res.json({ code: 0, message: r.used_existing ? '目标位置已有数据库，将直接改用' : '已把数据库复制到新位置', data: r });
    } catch (e) {
      res.status(400).json({ code: 400, message: errMessage('迁移数据库失败', e), detail: errDetail(e) });
    }
  });

  // 只落标记：真正的清空发生在下次启动、打开库文件之前（正在用的库没法边开边删）
  app.post('/api/desktop/factory-reset', (req, res) => {
    if (!needToken(req, res)) return;
    const marker = require('./database').markFactoryReset(req.body?.reason || 'settings-page');
    if (!marker) return res.status(500).json({ code: 500, message: '标记写不下去（数据目录不可写？）' });
    res.json({ code: 0, message: '已排定：重启后清空数据库', data: { marker } });
  });
}

// API 404：返回 JSON 而不是 HTML
app.use('/api', (req, res) => {
  res.status(404).json({ code: 404, message: '接口不存在' });
});

// 托管前端构建产物：有 dist 就挂（开发也可直接开 :8317；HMR 用 vite :5173）
const distPath = STATIC_DIR;
const fs = require('fs');
if (fs.existsSync(path.join(distPath, 'index.html'))) {
  console.log('Serving static from:', distPath);
  app.use(express.static(distPath, {
    maxAge: '7d',
    index: false,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    }
  }));
  // SPA fallback（Express 5 不再支持 '*' 通配，用兜底中间件；HEAD 同样返回以支持探测）
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

// 全局错误处理：把真实原因回给界面。这个服务只绑 127.0.0.1、只有一个用户，
// 「对外统一错误信息」在这儿没有意义，只会让人看不到到底哪儿炸了（以前 500 一律回「服务器错误」）。
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const detail = errDetail(err);
  console.error(`[error] ${req.method} ${req.path}:`, detail);
  if (!isProduction) console.error(err.stack);
  const status = err.status || 500;
  const summary = status === 500 ? '服务器错误' : (err.message || `请求失败（HTTP ${status}）`);
  res.status(status).json({ code: status, message: errMessage(summary, err), summary, detail });
});

const server = app.listen(PORT_FINAL, HOST, () => {
  const actual = server.address().port;   // PORT=0 时由系统分配，Electron 用这个真实端口开窗口
  console.log(`KHarness server running on http://${HOST}:${actual} (${isProduction ? 'production' : 'development'})`);
  const ir = dataHome.importResult;
  console.log('data dir:', dataHome.path,
    ir && ir.factoryReset
      ? (ir.ok ? `（已按「恢复出厂设置」清空：移除 ${ir.removed.join('、') || '无'}，重建空库）` : `（恢复出厂未执行：${ir.error}）`)
      : (ir ? (ir.ok ? `（已应用导入的数据库，备份在 ${ir.backup || '无'}）` : `（导入未应用：${ir.error}）`) : ''));
  // 机器可读的一行，给 Electron 主进程等就绪信号用
  console.log(`KH_READY url=http://127.0.0.1:${actual}`);
  // MCP server 异步拉起：慢/挂都不该拖住服务就绪，单个失败也只记录不抛出
  const mcp = require('./utils/mcp');
  mcp.connectAll().then((rs) => {
    for (const r of rs) {
      if (r.error) console.log(`[mcp] ${r.name} 连接失败：${r.error}`);
      else console.log(`[mcp] ${r.name} 已连接，${(r.tools || []).length} 个工具`);
    }
  }).catch((e) => console.log('[mcp] 启动连接异常：', e && e.message));
  // Computer Use：如果重启后「全部开放」还开着，不自动关（主人的口径），
  // 但置一个待确认标记，前端读到就弹一次警告询问是否关掉。
  const cuse = require('./utils/cuse');
  if (cuse.isOpenAll()) {
    cuse.setSetting('computer_open_pending_ack', '1');
    console.log('[computer] 「全部开放」仍开着，界面会提示一次');
  }
  // 总开关开着就把坐标引擎和急停快捷键先挂上：快捷键是「出事立刻停手」的东西，
  // 不能等 AI 真要动手时才起进程（那中间有一段按了没反应）。netwright 探测同样放这里。
  if (cuse.isEnabled()) {
    cuse.bootArm();
    cuse.detectNetwright((okNet) => console.log(okNet ? '[computer] netwright 在线（上位引擎）' : '[computer] 未检测到 netwright，使用坐标引擎'));
  }
});

// 退出前回收由 AI 启动的后台任务，避免留下孤儿进程（后台任务表在内存，不跨重启恢复）
const bg = require('./utils/bg');
let bgCleaned = false;
const cleanupBg = () => {
  if (bgCleaned) return;
  bgCleaned = true;
  try { bg.shutdownAll(); } catch (e) { /* 清理失败不阻塞退出 */ }
  // MCP 子进程同理：不杀掉就会留下一堆 npx / node 孤儿
  try { require('./utils/mcp').shutdownAll(); } catch (e) { /* 同上 */ }
  // 内置浏览器的动作是跨进程等的：服务要退了就先把等待者叫醒，别让窗口那头悬着
  try { require('./utils/inapp').dropPending('KHarness 服务正在退出'); } catch (e) { /* 同上 */ }
  // SSH 连接池：留着会让 node 进程挂在退出路上（keepalive 定时器与 socket）
  try { require('./utils/remote').closeAll(); } catch (e) { /* 同上 */ }
  // 终端会话：pty / ssh shell 都是子进程，服务退了不能留
  try { require('./utils/term').shutdownAll(); } catch (e) { /* 同上 */ }
  // Computer Use 的 PowerShell 坐标引擎与 netwright 子进程同理（快捷键钩子挂在它们里面）
  try { require('./utils/cuse').shutdownAll(); } catch (e) { /* 同上 */ }
};
process.on('exit', cleanupBg);
['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(sig => process.on(sig, () => { cleanupBg(); process.exit(0); }));
