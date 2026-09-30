/**
 * 打包前的准备（npm run dist 里先跑这个），产物全部落在 build/ 下：
 *   1) build/runtime/node.exe      —— 把本机 node.exe 随包带着。better-sqlite3 编的是
 *      Node 22 的 ABI，装机的电脑上不装 Node 也能跑后端，也不必 electron-rebuild。
 *   2) build/icon.png + icon.ico   —— 图标（.ico 由 make-icon.ps1 手工生成，
 *      electron-builder 自带的转换器在这台机器上会 WebAssembly OOM）。
 *   3) build/server-payload/       —— 后端整份副本（含 node_modules）。
 *      必须自己拷：electron-builder 的 extraResources 会按全局规则把 node_modules
 *      剔掉（第一次打包就因此少了 express，后端起不来），而打包用的 files 白名单里
 *      本来也只有 desktop/**，所以后端只能走「预演一遍再整目录塞进去」这条路。
 *   4) 确认 client/dist 已经 build 过。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');

/* ---------- 1) Node 运行时 ---------- */
const RUNTIME = path.join(BUILD, 'runtime');
fs.mkdirSync(RUNTIME, { recursive: true });
const nodeDst = path.join(RUNTIME, 'node.exe');
fs.copyFileSync(process.execPath, nodeDst);
console.log(`node.exe ${(fs.statSync(nodeDst).size / 1048576).toFixed(1)}MB ← ${process.execPath}`);

/* ---------- 2) 图标 ---------- */
const iconSrc = path.join(ROOT, 'icon.png');
const iconDst = path.join(BUILD, 'icon.png');
const icoDst = path.join(BUILD, 'icon.ico');
if (fs.existsSync(iconSrc)) {
  fs.copyFileSync(iconSrc, iconDst);
  const head = fs.readFileSync(iconDst).subarray(0, 26);
  console.log(`icon.png ${head.readUInt32BE(16)}×${head.readUInt32BE(20)}`);
}
if (!fs.existsSync(icoDst)) {
  console.log('build/icon.ico 不存在，调用 desktop/make-icon.ps1 生成');
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'desktop', 'make-icon.ps1')], { stdio: 'inherit' });
  if (r.status !== 0 || !fs.existsSync(icoDst)) {
    console.log('!! 图标生成失败，手动跑一次：powershell -File desktop/make-icon.ps1');
    process.exit(1);
  }
}
console.log(`icon.ico ${(fs.statSync(icoDst).size / 1024).toFixed(0)}KB`);

/* ---------- 3) 后端负载（自己拷，绕开 electron-builder 的 node_modules 剔除） ----------
 * electron-builder 拷 extraResources 时会把 **from 目录下一层的 node_modules 整个剔掉**
 * （实测：build/server-payload/node_modules 消失，而更深一层的 xxx/node_modules 完好）。
 * 所以这里把后端拷进 build/server-payload/app/，多套一层目录，让 node_modules 落在第二层：
 * 装机后资源路径是 resources/server/app/index.js，main.js 里的 SERVER_DIR 跟着指到 app。
 */
// 名字 = 相对 server/ 的路径；命中前缀即整个目录跳过
const SERVER_SKIP_DIRS = [
  '.kh-undo',        // 撤销快照
  'browser-shots',   // 内置浏览器截图
  'supervise',       // 监工验收报告
  'hosted',          // 托管交付报告
  // 内置技能目录：里面是我自己网站的私密笔记（服务器路径、PM2 进程名、git 邮箱），
  // 随公开安装包出去既泄露又对别人无意义。装机版技能列表空着没关系 ——
  // listSkills() 对不存在的目录是 catch 跳过的，自定义技能走数据目录那条路，不受影响。
  'agent-skills',
];
// 精确到文件的排除：本机数据/隐私，一律不进安装包
const SERVER_SKIP_FILES = [
  'data/weather-cities.json', // 第三方下载的城市表，首用时会重新拉
];
// 这些前缀开头的文件一律跳过（数据库及其临时/备份副本，里面有真实密钥和全部对话）
const SERVER_SKIP_PREFIX = ['kh.db'];
const SERVER_SKIP_EXT = ['.log', '.bak', '.tmp'];

function shouldSkip(rel) {
  const parts = rel.split('/');
  if (parts.some((p) => SERVER_SKIP_DIRS.includes(p))) return true;
  if (SERVER_SKIP_FILES.includes(rel)) return true;
  const base = parts[parts.length - 1];
  if (SERVER_SKIP_PREFIX.some((p) => base.startsWith(p))) return true;
  if (base.includes('.bak-') || base.endsWith('.pre-import')) return true;
  if (SERVER_SKIP_EXT.some((e) => base.endsWith(e))) return true;
  return false;
}

// app/ 这一层就是上面说的「垫一层」，别去掉
const payload = path.join(BUILD, 'server-payload', 'app');
fs.rmSync(path.join(BUILD, 'server-payload'), { recursive: true, force: true });
let copied = 0;
let bytes = 0;
const walked = [];   // 相对 payload 的文件清单，拷完拿去做隐私自查
fs.cpSync(path.join(ROOT, 'server'), payload, {
  recursive: true,
  force: true,
  filter: (src) => {
    const rel = path.relative(path.join(ROOT, 'server'), src).split(path.sep).join('/');
    if (!rel) return true;
    if (shouldSkip(rel)) return false;
    /* npm 会在 server/node_modules 里放一个和根包同名的 junction 指回仓库根
       （实测：server\node_modules\kharness → D:\projects\foo）。
       跟着它递归就是无限套娃 —— 而 build/server-payload 正好也在根里，于是越拷越深，
       直到撞上 Windows 路径长度上限，表现为「系统找不到指定的路径」，Inno/NSIS 直接编不过。
       所以：链接一律不带（真需要依赖的话它是实体目录），再兜一层「不许出现 build/server-payload」。 */
    try {
      if (fs.lstatSync(src).isSymbolicLink()) return false;
    } catch (e) {
      return false;
    }
    if (/build\/server-payload/.test(rel)) return false;
    // node_modules 里的 .bin / 头文件 / sourcemap 之类没必要带
    if (/node_modules\/(\.bin|\.cache)\//.test(rel + '/')) return false;
    if (/\.(h|cc|gyp|vcxproj|obj|pdb|map)$/.test(rel)) return false;
    return true;
  },
});
for (const stack = [payload]; stack.length;) {
  const dir = stack.pop();
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) stack.push(p);
    else { copied += 1; bytes += fs.statSync(p).size; walked.push(path.relative(payload, p).split(path.sep).join('/')); }
  }
}
/* 包内禁止个人数据 —— 上面那些排除规则只要被谁改坏一次，就是「装到别人机器上带着我的库/笔记」，
   所以这里不当日志看一眼就算完，直接卡住构建。 */
const LEAK_PATTERNS = [
  /(^|\/)kh\.db/,                 // 主库 + 它的 wal/shm/备份副本（里面有真实密钥和全部对话）
  /(^|\/)\.env/,
  /\.log$/,
  /\.bak/,
  /\.pre-import$/,
  /(^|\/)agent-skills\//,         // 内置技能 = 我自己的项目笔记
  /(^|\/)(\.kh-undo|browser-shots|supervise|hosted)\//,
  /data\/weather-cities\.json$/,
  /node_modules\/kharness\//,        // 指回仓库根的 junction：一旦跟进去就是无限套娃 + 整仓外泄
];
const leaks = walked.filter((rel) => LEAK_PATTERNS.some((re) => re.test(rel)));
if (leaks.length) {
  console.log(`!! 包里混进 ${leaks.length} 个本机/隐私文件，先修排除规则再打包：`);
  console.log(leaks.slice(0, 20).map((x) => '   - ' + x).join('\n'));
  process.exit(1);
}
console.log(`server-payload：${copied} 个文件，${(bytes / 1048576).toFixed(1)}MB（隐私自查通过：无 kh.db / .env / 日志 / 我的技能笔记）`);
if (!fs.existsSync(path.join(payload, 'node_modules', 'express'))) {
  console.log('!! server-payload 里没有 express，后端必然起不来');
  process.exit(1);
}
for (const dep of ['ssh2', 'node-pty']) {
  if (!fs.existsSync(path.join(payload, 'node_modules', dep))) { console.log('!! 远程/终端依赖 ' + dep + ' 没进包，装机版会「连不上 SSH」或「本机终端不可用」'); process.exit(1); }
}
if (!fs.existsSync(path.join(payload, 'node_modules', 'node-pty', 'prebuilds')) && !fs.existsSync(path.join(payload, 'node_modules', 'node-pty', 'build'))) { console.log('!! node-pty 的原生产物没带进去（.node 被过滤规则误杀了？）'); process.exit(1); }
if (!fs.existsSync(path.join(payload, 'node_modules', 'better-sqlite3', 'build', 'Release'))) {
  console.log('!! better-sqlite3 的原生产物没带进去（.node 被过滤规则误杀了？）');
  process.exit(1);
}
if (fs.existsSync(path.join(payload, 'data', 'defaults.js')) === false) {
  console.log('!! server/data/defaults.js 漏了：database.js 启动就要 require 它');
  process.exit(1);
}

/* ---------- 4) 前端产物 ---------- */
const dist = path.join(ROOT, 'client', 'dist', 'index.html');
if (!fs.existsSync(dist)) { console.log('!! client/dist 不存在，先跑 npm run build'); process.exit(1); }
console.log('client/dist 就绪，mtime', fs.statSync(dist).mtime.toISOString());
