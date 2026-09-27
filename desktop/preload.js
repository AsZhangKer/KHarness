// 桌面外壳给页面露出的能力：请求重启后端（导入数据库后要重启才生效）、
// 以及内置浏览器那两个必须走主进程的口子（CDP 输入与截图）。
// 走 IPC 而不是把 KH_SHUTDOWN_TOKEN 塞进页面 —— 那是主进程与后端之间的秘密；
// CDP 也不在渲染进程直给，主进程那边有方法白名单。
const { contextBridge, ipcRenderer } = require('electron');

// 主进程建窗口时定的那套框（frame:false 才走自绘顶栏）。用 additionalArguments 传，
// 而不是让页面去 invoke 一把才知道 —— 挂 CSS 类要在首帧前定下来，晚一帧就闪一下系统栏样式。
const FRAMELESS = process.argv.includes('--kh-frameless=1');

contextBridge.exposeInMainWorld('khDesktop', {
  isDesktop: true,
  platform: process.platform,
  frameless: FRAMELESS,
  restartApp: () => ipcRenderer.invoke('kh:restart'),
  // 关于页的两把大锤：数据库放哪儿、恢复出厂。都在主进程里办（要 token、要弹目录选择框）
  dbLocation: (action, dir) => ipcRenderer.invoke('kh:db-location', dir ? { action, dir } : { action: action || 'info' }),
  factoryReset: () => ipcRenderer.invoke('kh:factory-reset'),
  cdp: (id, method, params) => ipcRenderer.invoke('kh:cdp', { id, method, params }),
  screenshot: (id, full) => ipcRenderer.invoke('kh:screenshot', { id, full }),
  // 内置浏览器：视图本体是主进程里的 BrowserView，页面只报位置、收发事件
  bview: (msg) => ipcRenderer.invoke('kh:bview', msg),
  onBview: (cb) => {
    const h = (e, data) => cb(data);
    ipcRenderer.on('kh:bview-event', h);
    return () => ipcRenderer.removeListener('kh:bview-event', h);
  },
  /* 自绘顶栏：三颗键 + 文件/编辑/视图菜单。动作白名单在主进程那边
     （minimize / toggle-maximize / close / state / edit+what / zoom+what / reload），
     页面传什么都不怕；除 state 外的调用都回一份最新状态，省一次往返。 */
  winCtl: (action, what) => ipcRenderer.invoke('kh:win', what === undefined ? { action } : { action, what }),
  onWinState: (cb) => {
    const h = (e, data) => cb(data);
    ipcRenderer.on('kh:win-state', h);
    return () => ipcRenderer.removeListener('kh:win-state', h);
  },
});
