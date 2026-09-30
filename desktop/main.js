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
const { app, BrowserWindow, BrowserView, clipboard, dialog, desktopCapturer, ipcMain, nativeImage, nativeTheme, screen, shell, webContents } = require('electron');
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

  win.on('closed', () => {
    win = null; bview = null;
    // 独立窗口还开着的话一起关掉：留着它会变成「主窗口没了、只剩一块网页」的孤儿，
    // 而且 window-all-closed 不会触发，进程就这么吊着
    if (bwin && !bwin.isDestroyed()) bwin.destroy();
  });
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
  if (!bview) return;
  const payload = { type, detached: !!(bview && bview.detached), ...bviewNav(bview.wc), ...(extra || {}) };
  // 两边都要通知：侧栏那份靠它知道「视图已经不归我了」，独立窗口那份靠它刷地址栏与 waitIdle
  for (const w of [win, bwin]) {
    if (!w || w.isDestroyed()) continue;
    try { w.webContents.send('kh:bview-event', payload); } catch (e) { /* 窗口正在关 */ }
  }
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
 * UA 落地的唯一入口。ua 传空串 = 回到 Electron 默认（也就是电脑版）。
 * 建视图时抓的那份 defaultUA 是「恢复默认」的依据 —— setUserAgent('') 会不会真清空没有保证，
 * 所以不赌，显式写回抓到的那一条。
 */
function applyUserAgent(bv, ua) {
  if (!bv || !bv.wc || bv.wc.isDestroyed()) return;
  bv.wc.setUserAgent(String(ua || '') || bv.defaultUA);
}

/* ── 独立窗口 ──────────────────────────────────────────────────────────────
   把同一个 BrowserView 从主窗口的洞上摘下来、挂到另一扇无边框可缩放窗口里。
   可行性先量过（_tmp_bview_move_probe.js）：removeBrowserView 并不销毁 webContents，
   页面状态（输入框里打过的字、window 上的变量）、事件绑定、CDP debugger 全都跟着视图走，
   搬回来时用户看到的还是同一张网页 —— 不需要「另开一扇再复制 URL」那种假独立。

   那一扇窗开的是**同一份前端**（`<服务地址>/?kh=browser`）：整页只渲染浏览器栏自己，
   所以地址栏、前进后退、UA、右键菜单全套跟着搬过去，侧栏那一列则整个收起。
   视图位置照前端那套尺寸先摆个初值（头部 46 + 地址栏 48，四周让出 10px 缩放边，底栏 28），
   页面起来后由它自己发 bounds 校准。 */
const DETACHED_TOP = 94;
const DETACHED_SIDE = 10;
const DETACHED_BOTTOM = 38;
let bwin = null;
// 拖边缩放进行中的那一次：{ id, b=起始内容边界 }
let khResizeBase = { id: null, b: null };

function bviewDetachLayout() {
  if (!bwin || bwin.isDestroyed() || !bview) return;
  const c = bwin.getContentBounds();
  bview.view.setBounds({
    x: DETACHED_SIDE,
    y: DETACHED_TOP,
    width: Math.max(1, c.width - DETACHED_SIDE * 2),
    height: Math.max(1, c.height - DETACHED_TOP - DETACHED_BOTTOM),
  });
}

/**
 * 搬回主窗口的洞上，并关掉独立窗口。
 * 只能从 close 事件之外调（见下面 dwin.on('close') 的注释）。
 */
function bviewReattach() {
  if (!bview || !bview.detached) return false;
  bview.detached = false;
  const gone = bwin;
  bwin = null;
  if (gone && !gone.isDestroyed()) {
    try { gone.removeBrowserView(bview.view); } catch (e) { /* 正在销毁 */ }
  }
  const b = bview.sidebarBounds;
  if (win && !win.isDestroyed()) {
    win.addBrowserView(bview.view);
    if (b) { bview.view.setBounds(b); bview.shown = b; }
    log(`[desktop] 浏览器搬回侧栏 主窗视图数=${win.getBrowserViews().length} 边界=${JSON.stringify(bview.view.getBounds())}`);
  }
  if (gone && !gone.isDestroyed()) gone.destroy();
  bviewTell('detach', { detached: false });
  return true;
}

async function bviewDetach(bounds) {
  if (!bview || !bview.wc || bview.wc.isDestroyed()) return { error: '内置浏览器还没创建' };
  if (bview.detached) return { ok: true, detached: true };
  if (!win || win.isDestroyed()) return { error: '主窗口不在' };
  const hole = bounds || bview.sidebarBounds || bview.view.getBounds();
  bview.sidebarBounds = hole;

  const area = screen.getDisplayMatching(win.getContentBounds()).workArea;
  // 侧栏本来就窄（420），直接按洞的宽度做 16:9 会小得看不清；取 1.8 倍再夹进屏幕
  const w = Math.round(Math.min(Math.max(hole.width * 1.8, 760), area.width - 80));
  const h = Math.round(Math.min((w - DETACHED_SIDE * 2) * 9 / 16 + DETACHED_TOP + DETACHED_BOTTOM, area.height - 80));
  const dwin = new BrowserWindow({
    width: w,
    height: h,
    useContentSize: true,       // 上面按内容区算的 16:9，别让隐形缩放边把比例吃掉
    x: Math.round(area.x + (area.width - w) / 2),
    y: Math.round(area.y + (area.height - h) / 2),
    minWidth: 480,
    minHeight: 360,
    backgroundColor: '#141414',
    title: 'KHarness 内嵌浏览器',
    frame: !FRAMELESS,
    autoHideMenuBar: true,
    icon: fs.existsSync(path.join(ROOT, 'icon.png')) ? path.join(ROOT, 'icon.png') : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: [`--kh-frameless=${FRAMELESS ? 1 : 0}`, '--kh-detached=1'],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  bwin = dwin;
  // 页面标题会盖掉窗口标题，两扇窗在任务栏上就都叫「KHarness」分不清 —— 这一扇钉死自己的名字
  dwin.on('page-title-updated', (e) => e.preventDefault());
  dwin.on('resize', bviewDetachLayout);
  dwin.on('maximize', bviewDetachLayout);
  dwin.on('unmaximize', bviewDetachLayout);
  // 关窗前先把页面搬回侧栏：BrowserView 挂在哪个窗口上，那个窗口一关它就跟着销毁
  // （实测 window.close() 之后所有 op 都回 "Object has been destroyed"，整栏作废）。
  // 但搬这个动作不能在 close 事件里同步做：实测主进程会当场卡住（连日志都写不出来，
  // CDP 直接连不上）。所以拦下这次 close，下一轮事件循环再走「还原」那条已验证的路。
  dwin.on('close', (e) => {
    if (bview && bview.detached) {
      e.preventDefault();
      setImmediate(() => bviewReattach());
    }
  });
  // 这一扇也是完整的前端页面：外链照主窗口那套交给系统浏览器，别让它开出第三扇窗
  dwin.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  dwin.on('closed', () => {
    if (bwin === dwin) bwin = null;
  });

  await dwin.loadURL(`${serverUrl}/?kh=browser`);
  if (dwin.isDestroyed()) return { error: '独立窗口没能建起来' };
  win.removeBrowserView(bview.view);
  dwin.addBrowserView(bview.view);
  bview.detached = true;
  bviewDetachLayout();
  dwin.show();
  dwin.focus();
  log(`[desktop] 浏览器独立成窗 ${bview.view.getBounds().width}x${bview.view.getBounds().height}`);
  bviewTell('detach', { detached: true });
  return { ok: true, detached: true };
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
async function handleBview(msg = {}, sender = null) {
  const op = String(msg.op || '');
  // 视图同一时刻只挂在一扇窗上，谁发的位置指令就只认谁的：侧栏与独立窗口可能同时活着
  // （搬过去的那几秒、以及两边各自的重排），不认宿主就把独立窗口的尺寸设歪了。
  const host = sender ? BrowserWindow.fromWebContents(sender) : null;
  const owner = bview && bview.detached ? bwin : win;
  const fromOwner = !!host && host === owner;
  try {
    if (op === 'create') {
      // 视图可能被强关（独立窗口被以不触发 close 的方式关掉），销毁过就得整个重建，
      // 不能继续拿着死的 wc 用
      if (bview && (!bview.wc || bview.wc.isDestroyed())) bview = null;
      if (!bview && win) {
        const view = new BrowserView({
          webPreferences: {
            sandbox: true, contextIsolation: true, nodeIntegration: false,
            partition: 'persist:kharness-browser', spellcheck: false,
          },
        });
        bview = { view, wc: view.webContents, shown: null, defaultUA: view.webContents.getUserAgent() };
        bviewBind(bview.wc);
        win.addBrowserView(view);
      }
      if (!bview) return { error: '窗口还没准备好' };
      if (msg.bounds) {
        if (fromOwner) { bview.view.setBounds(msg.bounds); bview.shown = msg.bounds; }
        else bview.sidebarBounds = msg.bounds;   // 视图活在另一扇窗里：只登记洞位，等搬回来用
      }
      // UA 要在第一次导航前就位（建视图时就带上），否则首页还是电脑版渲染的
      if (msg.ua !== undefined) applyUserAgent(bview, msg.ua);
      // 刚建出来的 BrowserView 没有文档，executeJavaScript 会一直等不到回音，
      // 所以至少落到 about:blank 再交给调用方
      if (!bview.wc.getURL()) await bview.wc.loadURL('about:blank').catch(() => { /* 空白页失败不可能有更糟的事 */ });
      if (msg.url) await bview.wc.loadURL(msg.url).catch(() => { /* 加载失败由页面自己呈现 */ });
      // detached 一定要带回去：渲染层重载过（viewReady 丢了）时，这边视图还活在独立窗口里，
      // 不带这个标志它就会在主窗口上凭空糊出一块网页
      return { ok: true, detached: !!bview.detached, ...bviewNav(bview.wc) };
    }
    if (!bview) return { error: '内置浏览器还没创建' };
    const wc = bview.wc;
    switch (op) {
      case 'detach': return await bviewDetach(msg.bounds);
      case 'attach': bviewReattach(); return { ok: true, detached: false };
      case 'bounds': {
        if (!fromOwner) return { ok: true, ignored: 'not-host', detached: !!(bview && bview.detached) };
        const b = msg.bounds || {};
        bview.view.setBounds(b);
        if (Number(b.width) > 0 && Number(b.height) > 0) bview.shown = b;
        return { ok: true };
      }
      // AI 要用这一栏时把窗口带回前台：窗口被最小化或完全挡住时，
      // 真实鼠标点击不会落到页面上，capturePage 也会报「no display surface」
      case 'focus': {
        const host2 = bview.detached ? bwin : win;
        if (host2 && !host2.isDestroyed()) {
          if (host2.isMinimized()) host2.restore();
          host2.focus();
        }
        try { wc.focus(); } catch (e) { /* 忽略 */ }
        return { ok: true, detached: !!bview.detached };
      }
      case 'show':
        if (!fromOwner) return { ok: true, ignored: 'not-host' };
        if (bview.detached) { bviewDetachLayout(); return { ok: true, detached: true }; }
        bview.view.setBounds(bview.shown || msg.bounds || bview.view.getBounds());
        return { ok: true };
      // 隐藏 = 把边界收成 0×0。
      // 两条路都不能用：setVisible() 在 Electron 33 的 BrowserView 上根本不存在
      // （调了会抛错，界面看起来就是「收不起来、悬浮在其他控件上」），
      // removeBrowserView() 会连带销毁 webContents，页面全没。
      case 'hide':
        if (!fromOwner) return { ok: true, ignored: 'not-host', detached: !!(bview && bview.detached) };
        bview.shown = bview.view.getBounds();
        bview.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
        return { ok: true };
      case 'nav': wc.loadURL(String(msg.url || 'about:blank')); return { ok: true };
      // UA 切换：只在导航时生效，所以设完要重载一次；msg.reload=false 时交给调用方自己导航
      case 'ua': {
        applyUserAgent(bview, msg.ua);
        if (msg.reload !== false) wc.reload();
        return { ok: true, ua: wc.getUserAgent() };
      }
      case 'reload': if (msg.hard) wc.reloadIgnoringCache(); else wc.reload(); return { ok: true };
      case 'back': (wc.navigationHistory ? wc.navigationHistory.goBack() : wc.goBack()); return { ok: true, ...bviewNav(wc) };
      case 'forward': (wc.navigationHistory ? wc.navigationHistory.goForward() : wc.goForward()); return { ok: true, ...bviewNav(wc) };
      case 'stop': wc.stop(); return { ok: true };
      case 'exec': return { ok: true, result: await wc.executeJavaScript(String(msg.code || ''), true) };
      case 'state': return { ok: true, detached: !!bview.detached, ...bviewNav(wc), bounds: bview.view.getBounds() };
      case 'destroy':
        log(`[desktop] 浏览器视图销毁（独立窗口=${!!(bview && bview.detached)}）`);
        bviewReattach();   // 独立窗口先关掉，否则它带着一个已经作废的视图挂在桌上
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
        'Page.getLayoutMetrics', 'Page.captureScreenshot', 'Page.enable',
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

    // 截图统一落盘：browser-shots / screen-shots 两个目录，回 {file, bytes}。
    // 服务端与外壳共用 DATA_DIR，所以后端能直接按这个路径把图片喂给模型，不必把 base64 穿过动作队列。
    const saveShot = (buf, kind, ext = 'png') => {
      const dir = path.join(DATA_DIR, kind === 'screen' ? 'screen-shots' : 'browser-shots');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${kind}-${Date.now()}.${ext}`);
      fs.writeFileSync(file, buf);
      return { file, bytes: buf.length };
    };

    /* 送给模型之前的图片闸（设置 → 实验室 → 图片大小控制）。
       两张卡在一起才够用：只缩放不转码，1920×1200 的 PNG 还是 2MB+，base64 后 2.7MB；
       只转码不缩放，小图省了、大图照样爆。所以缩放 + JPEG 一起做，尺寸取用户填的最长边。
       上限读的是后端 settings（不是 localStorage：桌面端端口每启动都可能变，origin 一变就失忆），
       缓存 5 秒，免得一次连拍把 GET /api/settings 打成一串。 */
    let imgCap = { side: 0, at: 0 };
    async function maxImageSide() {
      if (Date.now() - imgCap.at < 5000) return imgCap.side;
      try {
        const d = await backend('/api/settings');
        const n = parseInt(d && d.img_max_side);
        imgCap.side = Number.isFinite(n) && n > 0 ? Math.min(n, 8192) : 0;
      } catch (err) { /* 后端没起来就按不缩放处理，别把截图功能一起拖死 */ }
      imgCap.at = Date.now();
      return imgCap.side;
    }

    /** nativeImage → 按最长边缩放 → JPEG。回 {buf, ext, width, height, scaled} */
    function encodeForModel(img, maxSide) {
      const s0 = img.getSize();
      const longSide = Math.max(s0.width, s0.height);
      if (!maxSide || longSide <= maxSide) {
        // 尺寸本来就合规：只转 JPEG 压体积，不重采样（免得把小字糊掉）
        return { buf: img.toJPEG(88), ext: 'jpg', width: s0.width, height: s0.height, scaled: false, from: `${s0.width}×${s0.height}` };
      }
      const k = maxSide / longSide;
      const sized = img.resize({
        width: Math.max(1, Math.round(s0.width * k)),
        height: Math.max(1, Math.round(s0.height * k)),
        quality: 'good',
      });
      const s1 = sized.getSize();
      return { buf: sized.toJPEG(85), ext: 'jpg', width: s1.width, height: s1.height, scaled: true, from: `${s0.width}×${s0.height}` };
    }

    /** 抓一张屏幕/窗口的 nativeImage，按设置压完落盘，回 {file, bytes, width, height} */
    async function saveEncoded(img, kind) {
      const e = encodeForModel(img, await maxImageSide());
      const saved = saveShot(e.buf, kind, e.ext);
      return { ...saved, width: e.width, height: e.height, scaled: e.scaled, src_size: e.from };
    }

    /** PowerShell 那条兜底路径已经写了 PNG，这里按同一套规则重压一遍（原 PNG 删掉） */
    async function recompressShot(shot) {
      try {
        const img = nativeImage.createFromPath(shot.file);
        if (!img || img.isEmpty()) { log('[desktop] 图片压缩跳过：读回的画面是空的'); return shot; }
        const e = encodeForModel(img, await maxImageSide());
        const saved = saveShot(e.buf, 'screen', e.ext);
        try { fs.unlinkSync(shot.file); } catch (err) { /* 删不掉也不影响 */ }
        return { file: saved.file, bytes: saved.bytes, width: e.width, height: e.height, scaled: e.scaled, src_size: e.from };
      } catch (err) {
        // 这里静默失败过一回（nativeImage 忘了 import，异常被吞掉，表现就是「设了大小却没生效」）
        log(`[desktop] 图片压缩失败，改用原图：${String((err && err.message) || err).slice(0, 160)}`);
        return shot;
      }
    }

    /**
     * 从 desktopCapturer 的屏幕源里挑出要的那一块。
     *
     * 不能只信「source.display_id === display.id」这一条：多屏下它可能匹配不上，
     * 老写法于是悄悄退到 sources[0] —— 表现就是「display 传任何序号都只截到第一块屏」，
     * 而缩略图尺寸又按请求的那块算，看上去只是尺寸不对，认不出选错了屏。
     * 这里逐级降级（字符串 id → 数字 id → 显示器名 → 同序号 → 第一块），
     * 并把命中的第几级写进日志，下次对不上号能一眼看出是哪一步救的场。
     */
    const pickScreenSource = (sources, d, idx) => {
      const idStr = String(d.id);
      const idNum = Number(d.id);
      const label = String(d.label || d.name || '');
      const steps = [
        ['id', (s) => String(s.display_id) === idStr],
        ['id-num', (s) => Number(s.display_id) === idNum],
        ['name', label ? (s) => String(s.name) === label : null],
        ['index', null],
      ];
      for (const [how, test] of steps) {
        if (!test) return { src: sources[idx] || sources[0], how: 'index' };
        const hit = sources.find(test);
        if (hit) return { src: hit, how };
      }
      return { src: sources[0], how: 'first' };
    };

    // 截图落盘并回路径：不把 base64 塞回对话，模型要看的是文件位置。
    // full=false 用 capturePage 拍当前视口（BrowserView 只渲染 bounds 内那块，视口外的内容压根没渲出来）；
    // full=true 走 CDP Page.captureScreenshot + captureBeyondViewport，把滚动区外也渲出来一次拍全。
    // CDP 截图实测在个别页面上会挂住不返回，所以带硬超时，失败退回视口截图并说清只拍到了视口。
    ipcMain.handle('kh:screenshot', async (e, payload = {}) => {
      const wc = String(payload.id) === 'bview' ? (bview && bview.wc) : webContents.fromId(Number(payload.id));
      if (!wc || wc.isDestroyed()) return { error: '找不到那个页面' };
      const grab = () => Promise.race([
        wc.capturePage(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('截图 12s 无响应')), 12000)),
      ]);
      // 整页：量出内容总高（上限 MAX_FULL_PX，太长的一律截到上限并说明），一次 CDP 拍全
      if (payload.full) {
        // 上限按「总像素」而不是「高度」算：3000px 高的页面实测 CDP 要 20 秒以上，
        // 再宽就按面积把 scale 压下来，别拿几千万像素去撞超时。
        const MAX_FULL_PX = 12000;
        const MAX_FULL_AREA = 5200000;
        try {
          if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
          const call = (method, params, ms) => Promise.race([
            wc.debugger.sendCommand(method, params || {}),
            new Promise((_, rej) => setTimeout(() => rej(new Error(`${method} ${Math.round(ms / 1000)}s 无响应`)), ms)),
          ]);
          // 必须先开 Page 域：没开时 captureScreenshot 会一声不响地不返回
          // （当年「CDP 截图实测会挂住」的真相就是这个，不是 captureScreenshot 本身不能用）
          await call('Page.enable', null, 15000);
          const m = await call('Page.getLayoutMetrics', null, 15000);
          const sz = (m && (m.cssContentSize || m.contentSize)) || null;
          if (!sz || !sz.width || !sz.height) throw new Error('拿不到页面内容尺寸');
          const width = Math.ceil(sz.width);
          const height = Math.min(Math.ceil(sz.height), MAX_FULL_PX);
          const scale = Math.min(1, Math.sqrt(MAX_FULL_AREA / Math.max(1, width * height)));
          // 这一枪给 20 秒：短页实测 1 秒内就回；长页（3000px 量级）实测 55 秒都不返回，
          // 再等下去只是让模型干等，所以宁早不晚 —— 退回视口截图并在文案里说清是退路。
          const shot = await call('Page.captureScreenshot', {
            format: 'png', captureBeyondViewport: true,
            clip: { x: 0, y: 0, width, height, scale },
          }, 20000);
          if (!shot || !shot.data) throw new Error('CDP 没返回图片数据');
          const buf = Buffer.from(shot.data, 'base64');
          // 长页整页图是最容易爆的一张（3000px 高的 PNG 好几 MB），同样过一遍尺寸闸：
          // 各家视觉模型进内部前本来就会把长边压到 ~1500px 量级，我们早压不会多丢信息。
          const enc = encodeForModel(nativeImage.createFromBuffer(buf), await maxImageSide());
          const saved = saveShot(enc.buf, 'browser', enc.ext);
          // 报出去的尺寸是「这张图实际多大」：scale 压过时两者不一样，别说成一个数
          return { result: { ...saved, width: enc.width, height: enc.height, full: true, scaled: enc.scaled,
            page_width: width, page_height: Math.ceil(sz.height), truncated: sz.height > MAX_FULL_PX, scale } };
        } catch (err) {
          const why = String(err.message || err).slice(0, 160);
          // 不直接失败：退回视口截图，让模型至少看到当前这一屏，并说明是退路
          payload = { ...payload, full: false, fullError: why };
        }
      }
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
      // 走同一套缩放/压缩：回给后端的宽高就是模型实际看到那张图的宽高
      const saved = await saveEncoded(img, 'browser');
      return { result: { ...saved, full: false,
        fell_back_from_full: payload.fullError ? true : false, full_error: payload.fullError || null } };
    });

    /* 全屏截取：拍整块显示器画面（不是应用窗口截图，所以屏幕里有什么就带什么）。
       默认拍鼠标所在那块屏；多屏时可选第几张。
       权限在服务端那条 isHighPrivilege 上收口：免除审批模式下也必须人工确认才走到这里。 */
    // 诊断用：把「系统认为有几块屏」和「desktopCapturer 给出几个源」并排列出来。
    // 多屏截不对时只有这一份数据能分清是枚举的问题还是匹配的问题（两者修法完全不同）。
    ipcMain.handle('kh:screen-list', async () => {
      const displays = screen.getAllDisplays().map((d) => ({
        id: String(d.id), label: d.label || '', bounds: d.bounds, size: d.size, scale: d.scaleFactor, primary: !!d.primary,
      }));
      const grab = async (opts) => {
        try {
          const src = await desktopCapturer.getSources(opts);
          return src.map((s) => ({ id: String(s.display_id), name: s.name, thumb: s.thumbnail.getSize() }));
        } catch (e) { return { error: String(e && e.message || e) }; }
      };
      return {
        displays,
        noThumb: await grab({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }),
        bigThumb: await grab({ types: ['screen'], thumbnailSize: { width: 3000, height: 3000 } }),
      };
    });

    /**
     * 直接从虚拟桌面上按坐标抠一块下来（PowerShell + System.Drawing）。
     *
     * 为什么需要：`desktopCapturer.getSources({types:['screen']})` 在双屏机器上可能只给出**一个**源
     * （实测这台机器两块屏，1600×900 那块能枚举到，1920×1200 那块压根不在清单里）。
     * 这时无论怎么匹配都拿不到第二块屏，Chromium 还会把唯一那张图按请求的缩略图尺寸放大，
     * 表现就是「display 传几都只截到第一块屏，只是分辨率不一样」。
     * 显示器边界 Electron 是知道得清清楚楚的，所以直接按坐标抓 —— 不依赖采集接口的枚举。
     *
     * 数字全部由本机算出来的整数拼进脚本、路径由我们自己生成，没有用户输入参与，不构成注入面。
     */
    const grabRegion = (b, scale) => new Promise((resolve) => {
      const dir = path.join(DATA_DIR, 'screen-shots');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `screen-${Date.now()}.png`);
      const w = Math.max(16, Math.round(b.width * scale));
      const h = Math.max(16, Math.round(b.height * scale));
      const x = Math.round(b.x * scale);
      const y = Math.round(b.y * scale);
      const ps = [
        'Add-Type -AssemblyName System.Drawing',
        'Add-Type -MemberDefinition "[DllImport(\\"user32.dll\\")] public static extern bool SetProcessDPIAware();" -Name Dpi -Namespace Win32 | Out-Null',
        '[Win32.Dpi]::SetProcessDPIAware() | Out-Null',
        `$bmp = New-Object System.Drawing.Bitmap(${w}, ${h})`,
        '$g = [System.Drawing.Graphics]::FromImage($bmp)',
        `$g.CopyFromScreen(${x}, ${y}, 0, 0, $bmp.Size)`,
        `$bmp.Save('${file}', [System.Drawing.Imaging.ImageFormat]::Png)`,
        '$g.Dispose(); $bmp.Dispose()',
      ].join('\n');
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
        { windowsHide: true, timeout: 15000 },
        (err) => {
          if (err) { resolve({ error: `按坐标抓取屏幕失败：${String(err.message || err).slice(0, 160)}` }); return; }
          try {
            // PNG 头里 IHDR 的宽高（大端），不必引第三方库
            const head = fs.readFileSync(file);
            const pw = head.readUInt32BE(16);
            const ph = head.readUInt32BE(20);
            resolve({ file, bytes: head.length, width: pw, height: ph });
          } catch (e) { resolve({ error: `按坐标抓取没落出文件：${String(e && e.message || e).slice(0, 120)}` }); }
        });
    });

    ipcMain.handle('kh:screen-capture', async (e, payload = {}) => {
      const displays = screen.getAllDisplays();
      if (!displays.length) return { error: '没有可用的显示器' };
      const asked = payload.display !== undefined && payload.display !== null && payload.display !== '';
      let idx = 0;
      let byCursor = false;
      if (asked) {
        idx = parseInt(payload.display, 10);
        if (!Number.isInteger(idx) || idx < 0 || idx >= displays.length) {
          const map = displays.map((x, i) => `${i}=${x.size.width}×${x.size.height}${x.bounds.x < 0 || x.bounds.y < 0 ? '(偏左/上)' : ''}`).join('，');
          return { error: `显示器序号超出范围：要 0 ~ ${displays.length - 1}（当前 ${displays.length} 块：${map}）` };
        }
      } else {
        // 没指定就先看光标在哪块屏（多屏用户要的多半是自己正在看的那张），落不回就取第 0 块
        const pt = screen.getCursorScreenPoint();
        const hit = displays.findIndex((x) => {
          const b = x.bounds;
          return pt.x >= b.x && pt.x < b.x + b.width && pt.y >= b.y && pt.y < b.y + b.height;
        });
        idx = hit >= 0 ? hit : 0;
        byCursor = hit >= 0;
      }
      const d = displays[idx];
      // 按物理像素拍（逻辑尺寸 × 缩放），否则 HiDPI 屏拿到糊的一张
      const scale = d.scaleFactor || 1;
      const w = Math.round(d.size.width * scale);
      const h = Math.round(d.size.height * scale);
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: w, height: h } });
        const pick = sources.length ? pickScreenSource(sources, d, idx) : null;
        // 只有「这个源确实是那块屏」才敢用它。否则采集接口给的是别的屏的画面，
        // 尺寸还按本次请求缩放过来 —— 看着像成功，其实截错了屏。这种情况改走按坐标硬抓。
        const sure = pick && String(pick.src.display_id) === String(d.id);
        let shot = null;
        let via = 'region';
        if (sure) {
          const enc = await saveEncoded(pick.src.thumbnail, 'screen');
          if (enc.bytes) { shot = enc; via = 'capturer'; }
        }
        if (!shot) {
          const g = await grabRegion(d.bounds, scale);
          if (g.error) return { error: g.error };
          shot = await recompressShot(g);
        }
        // 每一块屏的读数都记一行：多屏对不上号时这是唯一能说清「哪块是哪块」的证据。
        // 出图带字节和压缩前尺寸：设了「最大分辨率」却没生效时，这一行就能看出是没缩放还是缩放错了。
        log(`[desktop] 全屏截取 第 ${idx} 块(id=${d.id} ${d.size.width}×${d.size.height} scale=${scale} bounds=${d.bounds.x},${d.bounds.y}) `
          + `走=${via} 出图=${shot.width}×${shot.height} ${Math.round((shot.bytes || 0) / 1024)}KB${shot.src_size ? ` (原 ${shot.src_size}${shot.scaled ? '，已缩放' : ''})` : ''} `
          + `全部屏=[${displays.map((x) => `${x.id}:${x.size.width}×${x.size.height}`).join(' ')}] `
          + `采集源=[${sources.map((x) => `${x.display_id}/${x.name}`).join(' ') || '空'}]`);
        return {
          result: {
            ...shot,
            display: idx,
            displays: displays.length,
            byCursor,
            via,
            list: displays.map((x, i) => ({ index: i, width: x.size.width, height: x.size.height, primary: !!x.primary, scaleFactor: x.scaleFactor || 1 })),
          },
        };
      } catch (err) {
        return { error: `全屏截图失败：${String(err.message || err).slice(0, 200)}` };
      }
    });

    // 界面主题的明暗 → 全站 prefers-color-scheme。网页认深色只有这一条路
    // （它们读不到我们注入在 <html> 上的主题变量），而 Electron 默认跟随系统，
    // 于是暗色主题下网页仍旧出白底。我们自己不读这条媒体查询，所以设它不会带偏界面。
    ipcMain.handle('kh:theme-scheme', (e, payload = {}) => {
      const s = String(payload.scheme || '');
      nativeTheme.themeSource = s === 'light' ? 'light' : 'dark';
      return { ok: true, themeSource: nativeTheme.themeSource };
    });

    // 剪贴板：终端右键复制/粘贴用。读写都限长度（2MB），防止整块 4000 行 buffer 塞进 IPC 卡主进程。
    ipcMain.handle('kh:clipboard-read', () => {
      try {
        const text = clipboard.readText();
        return { text: typeof text === 'string' ? text.slice(0, 2 * 1024 * 1024) : '' };
      } catch (err) {
        return { error: `读剪贴板失败：${String(err.message || err).slice(0, 160)}` };
      }
    });
    ipcMain.handle('kh:clipboard-write', (e, payload = {}) => {
      try {
        clipboard.writeText(String(payload.text || '').slice(0, 2 * 1024 * 1024));
        return { ok: true };
      } catch (err) {
        return { error: `写剪贴板失败：${String(err.message || err).slice(0, 160)}` };
      }
    });

    ipcMain.handle('kh:bview', async (e, msg = {}) => handleBview(msg, e.sender));

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
      else if (act === 'resize') {
        // 独立浏览器窗口的加宽缩放边：页面只报「哪条边 + 从按下点算起的累计位移 + 本次拖动的 id」，
        // 起始边界由这边按 id 记住 —— 报累计量而不是增量，掉帧也不会把窗口越拖越大。
        const q = (msg.what && typeof msg.what === 'object') ? msg.what : {};
        const edge = String(q.edge || '');
        const dx = Number(q.dx) || 0;
        const dy = Number(q.dy) || 0;
        if (!edge || !/[nsew]/.test(edge)) return { ok: false, error: `未知缩放边 ${edge}` };
        if (khResizeBase.id !== q.id) khResizeBase = { id: q.id, b: w.getContentBounds() };
        const b = { ...khResizeBase.b };
        const [minW, minH] = w.getMinimumSize();
        if (edge.includes('e')) b.width = Math.max(minW, b.width + dx);
        if (edge.includes('s')) b.height = Math.max(minH, b.height + dy);
        if (edge.includes('w')) { b.width = Math.max(minW, b.width - dx); b.x = khResizeBase.b.x + (khResizeBase.b.width - b.width); }
        if (edge.includes('n')) { b.height = Math.max(minH, b.height - dy); b.y = khResizeBase.b.y + (khResizeBase.b.height - b.height); }
        w.setContentBounds(b);
        return { ok: true, bounds: w.getContentBounds() };
      }
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
