/**
 * KHarness 桌面外壳（阶段 0：只加壳，不改业务）
 *
 * 主进程只做四件事：定数据目录 → 拉起现有 Express → 等就绪信号 → 开窗口。
 * 后端仍是独立进程，所以「浏览器直连 localhost」这条调试路一直没断。
 *
 * 两个刻意的选择，改之前先读：
 * 1) 后端用 PATH 上的 node 起，不用 Electron 自带的 node。因为 better-sqlite3
 *    现在编的是 Node 22 的 ABI；用 Electron 起就得按 Electron ABI 重编。
 *    真要打包时再二选一：随包带一个 node，或 electron-rebuild + ELECTRON_RUN_AS_NODE。
 * 2) 端口优先沿用上一次的（见下面 pickPort/savePort）：localStorage 按 origin 分家，
 *    origin 带端口，端口一变所有存在 localStorage 的界面偏好就全回默认值了。
 *    拿不到稳定端口时才回 PORT=0 交给系统，避免和你手动跑在 8317 的那个实例抢地址。
 */
const { app, BrowserWindow, BrowserView, dialog, ipcMain, screen, shell, webContents } = require('electron');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const net = require('net');
const path = require('path');
const fs = require('fs');

/**
 * 打包后（app.isPackaged）三样东西都在asar外的 resources 目录里，node.exe 也随包带着：
 *   resources/server/app         后端源码 + server/node_modules（含 better-sqlite3 原生模块）
 *   resources/client/dist       前端产物
 *   resources/runtime/node.exe  随包的 Node 运行时
 * 为什么随包带 node 而不是用 Electron 当 node（ELECTRON_RUN_AS_NODE）：
 * better-sqlite3 现在编的是 Node 22 的 ABI，用 Electron 起就得按 Electron ABI 重编一遍；
 * 带一个 node.exe 省事，而且后端崩溃时不会连带把 GUI 进程一起带走。
 * 开发态（electron .）仍然用 PATH 上的 node，行为跟以前完全一样。
 */
const RES = process.resourcesPath || path.join(__dirname, '..');
const PACKAGED = app.isPackaged;
const ROOT = path.join(__dirname, '..');
// 打包后是 resources/server/app/index.js —— app 这一层是故意的：
// electron-builder 会把 extraResources 的 from 目录下「紧挨着一层」的 node_modules 剔掉，
// 垫一层目录后 node_modules 落在第二层就能完整带上（详见 desktop/pack-prep.js 第 3 节）。
const SERVER_DIR = PACKAGED ? path.join(RES, 'server', 'app') : path.join(ROOT, 'server');
// 数据目录：默认仍在 %APPDATA%\KHarness。
// 「设置 → 关于 → 数据库位置」可以把它指到别处（比如放到大容量盘）：
// 锚点是指针文件本身，它永远留在默认目录里 —— 不然挪完下次就找不到自己了。
const DEFAULT_DATA_DIR = path.join(app.getPath('appData'), 'KHarness');
const DATA_POINTER = process.env.KH_DATA_POINTER || path.join(DEFAULT_DATA_DIR, 'data-location.json');

function resolveDataDir() {
  if (process.env.KH_DATA_DIR) return process.env.KH_DATA_DIR;   // 显式传入最大（自测多实例、绿色便携版）
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_POINTER, 'utf8'));
    const dir = typeof raw.dir === 'string' ? raw.dir.trim() : '';
    // 指过去的目录得在、且真的放着（或准备放）库；不合法就回默认，绝不启动到一个不存在的路径上
    if (dir && path.isAbsolute(dir) && fs.existsSync(dir)) return dir;
  } catch (e) { /* 没有指针文件 = 第一次，用默认 */ }
  return DEFAULT_DATA_DIR;
}

const DATA_DIR = resolveDataDir();
const STATIC_DIR = process.env.KH_STATIC_DIR || (PACKAGED ? path.join(RES, 'client', 'dist') : path.join(ROOT, 'client', 'dist'));
const BUNDLED_NODE = PACKAGED ? path.join(RES, 'runtime', 'node.exe') : '';
const NODE_BIN = process.env.KH_NODE || (BUNDLED_NODE && fs.existsSync(BUNDLED_NODE) ? BUNDLED_NODE : 'node');
const LOG_FILE = path.join(DATA_DIR, 'desktop.log');

let child = null;
let win = null;

/**
 * 自绘顶栏的总开关（第三十三轮）。
 * true  = frame:false，窗口三键与拖拽条由前端画（client/src/ui/WindowControls.vue）；
 * false = 退回系统标题栏。
 * 这是「建窗口时一次定死」的东西，运行时切不了，所以把结论随 webPreferences 带给 preload，
 * 页面据此决定要不要挂 `html.kh-frame` —— 改成 false 时前端那套把手 CSS 自动整体失效。
 */
const FRAMELESS = true;

/** 顶栏「编辑」菜单认的几个命令（webContents 上的原生方法名）。只当白名单用，页面点不到别的。 */
const EDIT_COMMANDS = {
  undo: 'undo',
  redo: 'redo',
  copy: 'copy',
  cut: 'cut',
  paste: 'paste',
  selectAll: 'selectAll',
};
const ZOOM_STEP = 0.1;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2;
const clampZoom = (f) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(f * 100) / 100));
let serverUrl = '';
let stopRequested = false;
let restarting = false;

function log(line) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${String(line).trimEnd()}\n`);
  } catch (e) { /* 日志写不进去不该拦启动 */ }
}

/* ---------------------------------------------------------------------------
 * 端口要固定：localStorage 是按 origin 分家的，origin 里有端口。
 * 以前每次启动都让系统随手分配（PORT=0），于是「http://127.0.0.1:<新端口>」
 * 每次都是个全新的 origin，里面空空如也 —— 终端字体、内容宽度、固定模型、
 * 右栏显示哪几页这些存 localStorage 的偏好，每启动一次就全回默认值。
 * 现在把第一次拿到的端口写进 <数据目录>/desktop-port.json，以后先用它。
 * 端口被别的进程占了（比如同机第二个 KHarness）就回随机，那次仍会丢偏好，
 * 但总好过启动失败。
 * ------------------------------------------------------------------------- */
const PORT_FILE = path.join(DATA_DIR, 'desktop-port.json');
let forceRandomOnce = false;   // 上一次指定端口起不来，这一次交给系统

function savedPort() {
  try {
    const n = Number(JSON.parse(fs.readFileSync(PORT_FILE, 'utf8')).port);
    return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : 0;
  } catch (e) { return 0; }
}

function savePort(n) {
  try { fs.writeFileSync(PORT_FILE, JSON.stringify({ port: n })); } catch (e) { /* 存不上下次回随机 */ }
}

/**
 * 先探一次这个端口能不能绑：能就用它（拿到稳定的 origin），不能就交给系统。
 * 后端自己没实现重试，所以宁可在这儿试出来。开发态 electron . 的 userData
 * 就是仓库目录，所以端口文件顺手 gitignore 掉。
 */
function pickPort() {
  return new Promise((resolve) => {
    const want = savedPort();
    if (!want) return resolve(0);
    const probe = net.createServer();
    probe.once('error', () => { log(`[desktop] 上次的端口 ${want} 被占用，这次交给系统分配`); resolve(0); });
    probe.once('listening', () => probe.close(() => resolve(want)));
    try { probe.listen({ host: '127.0.0.1', port: want }); } catch (e) { resolve(0); }
  });
}

/** 拉起后端，resolve 出它真实监听的地址 */
function startServer() {
  return new Promise(async (resolve, reject) => {
    const token = crypto.randomBytes(16).toString('hex');
    let pref = 0;
    let canRetryRandom = false;
    if (process.env.KH_PORT) {
      pref = Number(process.env.KH_PORT) || 0;     // 显式指定最大（自测、绿色便携版），出问题也不自作主张换端口
    } else {
      pref = forceRandomOnce ? 0 : await pickPort();
      forceRandomOnce = false;                     // 只让这一次随机，下次重启仍先试稳定端口
      canRetryRandom = pref > 0;
    }
    const env = {
      ...process.env,
      PORT: String(pref || 0),
      NODE_ENV: 'production',        // 没这个 Express 不托管 client/dist
      KH_DATA_DIR: DATA_DIR,
      KH_HOST: '127.0.0.1',
      KH_STATIC_DIR: STATIC_DIR,
      KH_SHUTDOWN_TOKEN: token,
    };
    log(`[desktop] boot node=${NODE_BIN} dataDir=${DATA_DIR} port=${pref || '随机'}`);
    child = spawn(NODE_BIN, ['index.js'], {
      cwd: SERVER_DIR, env, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    /**
     * 指定端口刚好在「探测能绑」和「后端真去绑」之间被人抢了（或后端在那个端口上起不来）：
     * 换系统分配的端口再拉一次。稳定 origin 只是锦上添花，起不来才是要紧事。
     */
    const retryRandom = () => {
      if (!canRetryRandom || stopRequested) return false;
      settled = true;
      clearTimeout(timer);
      log(`[desktop] 端口 ${pref} 上后端起不来，改用系统分配的端口重试`);
      const dead = child;
      if (dead) {
        // 旧进程监听先摘掉：它的 exit 回调会把整个应用一起带走
        dead.removeAllListeners('exit');
        dead.stdout && dead.stdout.removeListener('data', onData);
        dead.stderr && dead.stderr.removeListener('data', onData);
        try { dead.kill(); } catch (e) { /* 已经退了 */ }
      }
      child = null;
      forceRandomOnce = true;
      resolve(startServer());
      return true;
    };
    const timer = setTimeout(() => {
      if (settled || retryRandom()) return;
      settled = true;
      reject(new Error(`后端 25s 内没有就绪，详见日志：${LOG_FILE}`));
    }, 25000);

    const onData = (buf) => {
      const text = String(buf);
      log(text.trimEnd());
      const m = text.match(/KH_READY url=(\S+)/);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        serverUrl = m[1];
        global.__khToken = token;
        const pm = /:(\d+)\/?$/.exec(serverUrl);
        if (pm) savePort(Number(pm[1]));   // 下次启动先试这个端口，origin 才稳得住
        resolve(serverUrl);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', (e) => {
      // node 不在 PATH 上会走这里，而不是退出码
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`无法启动后端（${NODE_BIN}）：${e.message}\n可设 KH_NODE=<node 可执行文件路径> 指定。`));
    });

    child.on('exit', (code, signal) => {
      log(`[desktop] 后端退出 code=${code} signal=${signal}`);
      // 约定：退出码 2 = 后端请主进程把它再拉起来一次（导入数据库后的重启走这条）
      if (code === 2 && !stopRequested) { restartServer(); return; }
      if (!settled && !stopRequested) {
        if (retryRandom()) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`后端启动后即退出（code=${code}），详见日志：${LOG_FILE}`));
      }
      child = null;
      if (!stopRequested) app.quit();   // 后端没了，留着窗口只是白屏
    });
  });
}

/* ── 自绘顶栏要的窗口状态 ────────────────────────────────────────────────
   页面得知道「现在是不是最大化」（中间那颗键的图标要在「最大化 / 还原」之间换），
   所以 maximize/unmaximize/全屏四个事件都得推一条给渲染进程。
   最大化时顺手记一行 bounds 与工作区对比：frameless 窗口在 Windows 上有把任务栏盖掉的老毛病，
   光看屏幕不好确认，日志里留个读数。 */
function winStateOf(w) {
  if (!w || w.isDestroyed()) return { frameless: FRAMELESS, maximized: false, fullscreen: false };
  return { frameless: FRAMELESS, maximized: w.isMaximized(), fullscreen: w.isFullScreen() };
}

function pushWinState(w) {
  if (!w || w.isDestroyed()) return;
  try { w.webContents.send('kh:win-state', winStateOf(w)); } catch (e) { /* 窗口正在关 */ }
}

function bindWindowState(w) {
  w.on('maximize', () => {
    /* 留一行读数好判断「最大化有没有吃掉任务栏」。注意别看 getBounds()：
       最大化时 Windows 会把那圈 8px 的隐形缩放边推到屏幕外（rect 从 -8,-8 开始、比工作区大 16px），
       但 Chromium 把内容区缩回来了 —— 实测内容区 = 0,0 1920x1150，工作区 1920x1152，
       既不裁自绘标题栏也不盖任务栏。真正该比的是 getContentBounds()。
       （顺手试过 titleBarStyle:'hidden' 与 frame:false 两种写法，内容区读数一致。） */
    const c = w.getContentBounds();
    const a = screen.getDisplayMatching(c).workArea;
    log(
      `[desktop] 最大化 内容区=${c.x},${c.y} ${c.width}x${c.height} ` +
        `workArea=${a.x},${a.y} ${a.width}x${a.height} ` +
        `压住任务栏=${c.y + c.height > a.y + a.height + 1}`
    );
    pushWinState(w);
  });
  w.on('unmaximize', () => pushWinState(w));
  w.on('enter-full-screen', () => pushWinState(w));
  w.on('leave-full-screen', () => pushWinState(w));
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#141414',
    title: 'KHarness',
    // 自绘顶栏：系统那条标题栏整个去掉，窗口按钮与拖拽区由前端画（client/src/ui/WindowControls.vue
    // + styles/framebar.css）。拖动靠 CSS `-webkit-app-region: drag`（Chromium 把它翻成 WM_NCHITTEST
    // 的 HTCAPTION，所以贴边 Snap、双击最大化都是系统原生行为）；缩放边框 frame:false 在 Windows 上
    // 照旧保留（没有 transparent:true 就不会丢 WS_THICKFRAME）。
    frame: !FRAMELESS,
    autoHideMenuBar: true,
    icon: fs.existsSync(path.join(ROOT, 'icon.png')) ? path.join(ROOT, 'icon.png') : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: [`--kh-frameless=${FRAMELESS ? 1 : 0}`],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // 内置浏览器：右栏那一栏里真的是个 <webview>，AI 的动作最终落到它身上
      webviewTag: true,
    },
  });
  win.loadURL(url);

  // 外链一律交给系统浏览器，别把窗口变成网页浏览器
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (target.startsWith(url)) return;
    e.preventDefault();
    if (/^https?:/i.test(target)) shell.openExternal(target);
  });

  /* 顶栏菜单上写的那几个快捷键。frame:false 之后没有原生应用菜单，这些组合键没人接了，
     就在 before-input-event 里自己落 —— 和菜单项同一份实现，不会出现「菜单能用、快捷键不能用」。
     只接窗口级这几个（关闭 / 刷新 / 缩放）；复制·剪切·粘贴·全选·撤销留给 Chromium 自己处理，
     它在输入框里本来就能用，抢过来反而会把「在非编辑区按 Ctrl+A」这类原生行为改掉。 */
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || input.altKey || !(input.controlKey || input.metaKey)) return;
    const wc = win.webContents;
    const k = String(input.key || '').toLowerCase();
    if (k === 'w') { e.preventDefault(); win.close(); return; }
    if (k === 'r') { e.preventDefault(); wc.reload(); return; }
    if (k === '=' || k === '+') { e.preventDefault(); wc.setZoomFactor(clampZoom(wc.getZoomFactor() + ZOOM_STEP)); return; }
    if (k === '-') { e.preventDefault(); wc.setZoomFactor(clampZoom(wc.getZoomFactor() - ZOOM_STEP)); return; }
    if (k === '0') { e.preventDefault(); wc.setZoomFactor(1); return; }
  });

  // 右栏内置浏览器的那个 <webview>：窗口被盖住/最小化时默认会降帧，
  // 实测 capturePage 就在没有新帧的状态下挂住不返回。让 guest 一直保持出帧。
  win.webContents.on('did-attach-webview', (e, guest) => {
    try {
      guest.setBackgroundThrottling(false);
      if (typeof guest.beginForegroundProcessing === 'function') guest.beginForegroundProcessing();
    } catch (err) { /* 老版本没这些 API，忽略 */ }
  });

  win.on('closed', () => { win = null; bview = null; });
  bindWindowState(win);
}

/* 内置浏览器：一个由主进程定边界的 BrowserView（详见下面 handleBview 的注释） */
let bview = null;         // { view, wc }

function bviewNav(wc) {
  const h = wc.navigationHistory;
  return {
    url: wc.getURL(),
    title: wc.getTitle(),
    canBack: h ? h.canGoBack() : wc.canGoBack(),
    canForward: h ? h.canGoForward() : wc.canGoForward(),
  };
}

function bviewTell(type, extra) {
  if (!win || win.isDestroyed() || !bview) return;
  try { win.webContents.send('kh:bview-event', { type, ...bviewNav(bview.wc), ...(extra || {}) }); } catch (e) { /* 窗口正在关 */ }
}

function bviewBind(wc) {
  wc.on('did-navigate', (e, url) => bviewTell('nav', { url }));
  wc.on('did-navigate-in-page', (e, url) => bviewTell('nav', { url }));
  wc.on('page-title-updated', (e, title) => bviewTell('title', { title }));
  wc.on('did-stop-loading', () => bviewTell('idle'));
  wc.on('console-message', (e, level, message) => {
    if (Number(level) >= 2) bviewTell('console', { message: `[${Number(level) === 3 ? 'error' : 'warning'}] ${message}` });
  });
  // target=_blank 留在本栏里打开，否则用户看不到 AI 点了什么
  wc.setWindowOpenHandler(({ url: target }) => {
    try { wc.loadURL(target); } catch (err) { /* 忽略 */ }
    return { action: 'deny' };
  });
}

/**
 * 渲染进程（浏览器栏）→ 主进程的唯一入口。
 *
 * 为什么不用 <webview>：webview 的 guest 视口要靠渲染进程把元素尺寸同步过去，
 * 实测 Electron 33 在应用里无论怎么写 CSS，页面视口都停在默认 300×150
 * （用户只看到上方一条 150px 的带子，截图也只有那条）；
 * 同样位置换成主进程 setBounds 给边界的 BrowserView，视口 / capturePage / CDP
 * 输入全部准确（对照实验：同尺寸的 BrowserView 拿到 420×681 视口，webview 只有 300×150）。
 *
 * BrowserView 在新 Electron 里标了废弃（将来是 WebContentsView + BaseWindow），
 * 33 上仍可用；这一节的接口面很窄，将来替换成本可控。
 */
async function handleBview(msg = {}) {
  const op = String(msg.op || '');
  try {
    if (op === 'create') {
      // removeBrowserView 会顺手把视图的 webContents 销毁，所以视图一旦被销毁过
      // 就得整个重建，不能继续拿着死的 wc 用
      if (bview && (!bview.wc || bview.wc.isDestroyed())) bview = null;
      if (!bview && win) {
        const view = new BrowserView({
          webPreferences: {
            sandbox: true, contextIsolation: true, nodeIntegration: false,
            partition: 'persist:kharness-browser', spellcheck: false,
          },
        });
        bview = { view, wc: view.webContents, shown: null };
        bviewBind(bview.wc);
        win.addBrowserView(view);
      }
      if (!bview) return { error: '窗口还没准备好' };
      if (msg.bounds) {
        bview.view.setBounds(msg.bounds);
        bview.shown = msg.bounds;
      }
      // 刚建出来的 BrowserView 没有文档，executeJavaScript 会一直等不到回音，
      // 所以至少落到 about:blank 再交给调用方
      if (!bview.wc.getURL()) await bview.wc.loadURL('about:blank').catch(() => { /* 空白页失败不可能有更糟的事 */ });
      if (msg.url) await bview.wc.loadURL(msg.url).catch(() => { /* 加载失败由页面自己呈现 */ });
      return { ok: true, ...bviewNav(bview.wc) };
    }
    if (!bview) return { error: '内置浏览器还没创建' };
    const wc = bview.wc;
    switch (op) {
      case 'bounds': {
        const b = msg.bounds || {};
        bview.view.setBounds(b);
        if (Number(b.width) > 0 && Number(b.height) > 0) bview.shown = b;
        return { ok: true };
      }
      // AI 要用这一栏时把窗口带回前台：窗口被最小化或完全挡住时，
      // 真实鼠标点击不会落到页面上，capturePage 也会报「no display surface」
      case 'focus':
        if (win && !win.isDestroyed()) {
          if (win.isMinimized()) win.restore();
          win.focus();
        }
        try { wc.focus(); } catch (e) { /* 忽略 */ }
        return { ok: true };
      case 'show':
        bview.view.setBounds(bview.shown || msg.bounds || bview.view.getBounds());
        return { ok: true };
      // 隐藏 = 把边界收成 0×0。
      // 两条路都不能用：setVisible() 在 Electron 33 的 BrowserView 上根本不存在
      // （调了会抛错，界面看起来就是「收不起来、悬浮在其他控件上」），
      // removeBrowserView() 会连带销毁 webContents，页面全没。
      case 'hide':
        bview.shown = bview.view.getBounds();
        bview.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
        return { ok: true };
      case 'nav': wc.loadURL(String(msg.url || 'about:blank')); return { ok: true };
      case 'reload': if (msg.hard) wc.reloadIgnoringCache(); else wc.reload(); return { ok: true };
      case 'back': (wc.navigationHistory ? wc.navigationHistory.goBack() : wc.goBack()); return { ok: true, ...bviewNav(wc) };
      case 'forward': (wc.navigationHistory ? wc.navigationHistory.goForward() : wc.goForward()); return { ok: true, ...bviewNav(wc) };
      case 'stop': wc.stop(); return { ok: true };
      case 'exec': return { ok: true, result: await wc.executeJavaScript(String(msg.code || ''), true) };
      case 'state': return { ok: true, ...bviewNav(wc), bounds: bview.view.getBounds() };
      case 'destroy':
        if (win) win.removeBrowserView(bview.view);
        try { wc.close(); } catch (e) { /* 已经关了 */ }
        bview = null;
        return { ok: true };
      default: return { error: `不认识的操作：${op}` };
    }
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
}

/**
 * 重启后端并让窗口跟到新地址。
 * 网页端没有主进程可求助，所以这条只在桌面壳里可用；用退出码当信号，
 * 是为了不必把「后端与外壳之间的秘密」（KH_SHUTDOWN_TOKEN）暴露给渲染进程。
 */
async function restartServer() {
  if (restarting) return;
  restarting = true;
  log('[desktop] 重启后端中…');
  if (win) win.setTitle('KHarness（重启中…）');
  try {
    child = null;                       // 旧进程已退出，交给下一次 startServer
    // 页面要重载，浏览器视图先收掉：新页面挂起来时会重新建，不然它会浮在重加载的界面上
    await handleBview({ op: 'destroy' });
    const url = await startServer();
    serverUrl = url;
    if (win) win.loadURL(url);
    else createWindow(url);
  } catch (e) {
    log(`[desktop] 重启失败：${(e && e.message) || e}`);
    dialog.showErrorBox('重启后端失败', String((e && e.message) || e));
    app.quit();
  } finally {
    restarting = false;
  }
}

/** 先让后端自己退出（好回收 AI 起的后台任务），超时才强杀整棵进程树 */
async function stopServer() {
  if (!child) return;
  const pid = child.pid;
  const token = global.__khToken;
  const gone = new Promise((r) => child.once('exit', r));
  try {
    const res = await fetch(`${serverUrl}/api/desktop/shutdown`, {
      method: 'POST',
      headers: { 'x-kh-shutdown-token': String(token || '') },
    });
    log(`[desktop] shutdown ack=${res.status}`);
  } catch (e) {
    log(`[desktop] shutdown 请求失败：${e.message}`);
  }
  const timed = await Promise.race([gone.then(() => 'exit'), new Promise((r) => setTimeout(() => r('timeout'), 3000))]);
  if (timed === 'timeout' && pid) {
    log(`[desktop] 后端 3s 未退出，强杀进程树 pid=${pid}`);
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {});
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    ipcMain.handle('kh:restart', async () => {
      // 让后端自己退出（退出码 2 会触发 restartServer），比在这儿重拉一遍干净
      const pid = child && child.pid;
      if (!pid) { restartServer(); return { ok: true }; }
      try {
        const res = await fetch(`${serverUrl}/api/desktop/restart`, {
          method: 'POST',
          headers: { 'x-kh-shutdown-token': String(global.__khToken || '') },
        });
        log(`[desktop] restart ack=${res.status}`);
        if (!res.ok) restartServer();
        return { ok: res.ok };
      } catch (e) {
        log(`[desktop] restart 请求失败：${e.message}`);
        return { ok: false, error: String(e.message || e) };
      }
    });
    /* ── 关于页：数据库位置 / 恢复出厂设置 ────────────────────────────────
       这两件事都要「改了下次启动才算数」，所以统一走「让后端自己退出码 2 重启」那条既有路；
       并且都要带 token 找后端办 —— 清库这种动作不能让页面自己隔着 fetch 直接干。 */
    const backend = async (apiPath, body) => {
      if (!serverUrl) throw new Error('后端还没就绪');
      const res = await fetch(`${serverUrl}${apiPath}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'content-type': 'application/json',
          'x-kh-shutdown-token': String(global.__khToken || ''),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(j.message || `HTTP ${res.status}`));
      return j.data || {};
    };

    ipcMain.handle('kh:db-location', async (e, msg = {}) => {
      const action = String(msg && msg.action || 'info');
      try {
        if (action === 'info') {
          const d = await backend('/api/desktop/db-info');
          return { ok: true, ...d, dir_default: DEFAULT_DATA_DIR, pointer: DATA_POINTER, using_default: DATA_DIR === DEFAULT_DATA_DIR };
        }
        let dir = action === 'set' ? String(msg.dir || '') : '';
        if (action === 'pick') {
          const r = await dialog.showOpenDialog(win, {
            title: '数据库放到哪个目录',
            buttonLabel: '就用这里',
            properties: ['openDirectory', 'createDirectory'],
          });
          if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
          dir = r.filePaths[0];
        }
        if (!dir) return { ok: false, error: '没说要放到哪个目录' };
        const moved = await backend('/api/desktop/db-move', { dir });
        fs.mkdirSync(DEFAULT_DATA_DIR, { recursive: true });
        fs.writeFileSync(DATA_POINTER, JSON.stringify({ dir, moved_at: new Date().toISOString(), used_existing: !!moved.used_existing }, null, 2), 'utf8');
        log(`[desktop] 数据目录指针 → ${dir}（${moved.used_existing ? '沿用目标已有库' : '已复制一份过去'}）`);
        return { ok: true, dir, used_existing: !!moved.used_existing, file: moved.file, needsRestart: true };
      } catch (err) {
        log(`[desktop] db-location ${action} 失败：${err && err.message}`);
        return { ok: false, error: String((err && err.message) || err) };
      }
    });

    // 前端已经收齐「逐字确认语 + 三连点」才走到这里；主进程只负责落标记并重启
    ipcMain.handle('kh:factory-reset', async () => {
      try {
        await backend('/api/desktop/factory-reset', { reason: 'settings-factory-reset' });
      } catch (err) {
        log(`[desktop] 恢复出厂标记失败：${err && err.message}`);
        return { ok: false, error: String((err && err.message) || err) };
      }
      log('[desktop] 已排定恢复出厂设置，正在重启后端执行');
      try {
        await fetch(`${serverUrl}/api/desktop/restart`, { method: 'POST', headers: { 'x-kh-shutdown-token': String(global.__khToken || '') } });
      } catch (err) {
        log(`[desktop] 重启请求没送出：${err && err.message}`);
        return { ok: true, scheduled: true, needsManualRestart: true };
      }
      return { ok: true, scheduled: true };
    });

    try {
      const url = await startServer();
      createWindow(url);
    } catch (e) {
      log(`[desktop] 启动失败：${e && e.stack ? e.stack : e}`);
      dialog.showErrorBox('KHarness 启动失败', String((e && e.message) || e));
      app.quit();
    }
    // 内置浏览器的真实输入通道：AI 的点击/键盘走 CDP 打到 <webview> 的 guest 上，
    // 这样站点拿到的是受信任事件（JS 合成 click 会被不少站点当机器人）。
    // 只开白名单方法 —— 等于把调试器递给渲染进程，不能给它任意方法。
    ipcMain.handle('kh:cdp', async (e, payload = {}) => {
      const allow = new Set([
        'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText',
        'Page.getLayoutMetrics', 'Page.captureScreenshot',
      ]);
      const method = String(payload.method || '');
      if (!allow.has(method)) return { error: `不允许的 CDP 方法：${method}` };
      // id 传 'bview' 就是打到内置浏览器那个视图上；否则按 webContentsId 找
      const wc = String(payload.id) === 'bview' ? (bview && bview.wc) : webContents.fromId(Number(payload.id));
      if (!wc || wc.isDestroyed()) return { error: '找不到那个页面（可能已被关掉）' };
      try {
        if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      } catch (err) {
        return { error: `接管页面失败：${err.message}` };
      }
      try {
        // sendCommand 在某些页面上会不返回（实测截图时挂死），加硬超时兜底，
        // 不然动作要等到服务端 90 秒超时才失败
        const result = await Promise.race([
          wc.debugger.sendCommand(method, payload.params || {}),
          new Promise((_, rej) => setTimeout(() => rej(new Error(`${method} 12s 无响应`)), 12000)),
        ]);
        return { result };
      } catch (err) {
        return { error: `${method} 执行失败：${String(err.message || err).slice(0, 200)}` };
      }
    });

    // 截图落盘并回路径：不把 base64 塞回对话，模型要看的是文件位置。
    // 用 capturePage 而不是 CDP 的 Page.captureScreenshot —— 后者实测会挂住不返回。
    // 窗口被最小化或完全挡住时拿不到画面（「no display surface」），先试着把窗口带回来再拍一次。
    ipcMain.handle('kh:screenshot', async (e, payload = {}) => {
      const wc = String(payload.id) === 'bview' ? (bview && bview.wc) : webContents.fromId(Number(payload.id));
      if (!wc || wc.isDestroyed()) return { error: '找不到那个页面' };
      const grab = () => Promise.race([
        wc.capturePage(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('截图 12s 无响应')), 12000)),
      ]);
      let img = null;
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          img = await grab();
          if (img && !img.isEmpty()) break;
          img = null;
          lastErr = new Error('拿到的画面是空的');
        } catch (err) {
          img = null;
          lastErr = err;
        }
        // 第二遍之前把窗口弄回前台，并让这一页重新出帧
        if (win && !win.isDestroyed()) {
          if (win.isMinimized()) win.restore();
          try { wc.invalidate(); } catch (e2) { /* 忽略 */ }
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      if (!img) {
        const why = String((lastErr && lastErr.message) || lastErr || '').slice(0, 200);
        return { error: `截图失败：${why}（窗口被最小化或完全挡住了？把它露出来再试）` };
      }
      const buf = img.toPNG();
      const dir = path.join(DATA_DIR, 'browser-shots');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `shot-${Date.now()}.png`);
      fs.writeFileSync(file, buf);
      return { result: { file, bytes: buf.length, ...img.getSize() } };
    });

    ipcMain.handle('kh:bview', async (e, msg = {}) => handleBview(msg));

    /* 自绘顶栏的三颗键 + 菜单动作：全在这里落，动作是白名单，页面传什么都不怕。
       用 fromWebContents 拿发信那个窗口，不拿全局 win —— 以后要是有第二个窗口，
       页面点自己标题栏上的关闭键才不会把主窗口关掉。 */
    ipcMain.handle('kh:win', (e, msg = {}) => {
      const w = BrowserWindow.fromWebContents(e.sender);
      if (!w || w.isDestroyed()) return { ok: false, error: '窗口不存在' };
      const act = String(msg.action || '');
      const what = String(msg.what || '');
      if (act === 'state') return { ok: true, ...winStateOf(w) };
      // 真实光标位置（**页面 CSS 像素**，原点 = 内容区左上角 + inside = 有没有落在内容区里）。
      // 为什么要有这条只读通道：无框窗口的窗口顶栏是系统拖拽区（HTCAPTION），Blink 在那里一条
      // mousemove 都收不到 —— 页面自己写「鼠标离开顶栏就收起」时，光标一往上挪进顶栏就当场瞎掉，
      // 那一排再也不会收回去。只有主进程问得到系统光标，所以按需提供这一个数（不返回任何窗口/进程信息）。
      if (act === 'cursor') {
        const b = w.getContentBounds();
        const p = screen.getCursorScreenPoint();
        const zoom = w.webContents.getZoomFactor() || 1;   // 视图·放大过就得换算，否则和 clientY 对不上
        return {
          ok: true,
          x: (p.x - b.x) / zoom,
          y: (p.y - b.y) / zoom,
          inside: p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height,
        };
      }
      if (act === 'minimize') w.minimize();
      else if (act === 'toggle-maximize') { if (w.isMaximized()) w.restore(); else w.maximize(); }
      else if (act === 'close') w.close();   // 和原生 X 同一条路：走 close → window-all-closed → 停后端
      else if (act === 'edit') {
        // 只认这张表里的几个 webContents 原生命令，绝不让页面点名要调什么方法
        const fn = EDIT_COMMANDS[what];
        if (!fn) return { ok: false, error: `未知编辑动作 ${what}` };
        w.webContents[fn]();
      } else if (act === 'zoom') {
        const now = w.webContents.getZoomFactor();
        const f = what === 'in' ? clampZoom(now + ZOOM_STEP) : what === 'out' ? clampZoom(now - ZOOM_STEP) : what === 'reset' ? 1 : null;
        if (f === null) return { ok: false, error: `未知缩放动作 ${what}` };
        w.webContents.setZoomFactor(f);
        log(`[desktop] 缩放 ${what} → ${(f * 100).toFixed(0)}%`);
      } else if (act === 'reload') {
        w.webContents.reload();
      } else {
        return { ok: false, error: `未知窗口动作 ${act}` };
      }
      return { ok: true, zoom: w.webContents.getZoomFactor(), ...winStateOf(w) };
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0 && serverUrl) createWindow(serverUrl);
    });
  });

  app.on('window-all-closed', () => app.quit());

  let stopped = false;
  app.on('before-quit', (e) => {
    if (stopped || !child) return;
    e.preventDefault();
    stopRequested = true;
    stopped = true;
    stopServer().finally(() => app.exit(0));
  });
}
