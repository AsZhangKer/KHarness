/**
 * 「这到底是开发版还是正式版」的唯一答案（第六十四轮）。
 *
 * 以前只有 /settings/app-info 里那三段判断，关于页显示版本号顺便也就只有它知道答案。
 * 现在「调试」板块要按同一件事决定显不显示，而且服务端的日志接口也得照同一件事决定开不开 ——
 * 两边各写一遍早晚会对不上，所以把这段抽出来，两处都问这里。
 *
 * 三个来源按优先级：
 *   1) 新版外壳传的环境变量 KH_APP_VERSION（= app.getVersion()），KH_APP_PACKAGED=1 才算正式版；
 *   2) 打包时 `pack-prep` 写进服务端载荷里的 version.json —— 它不依赖外壳，所以旧外壳的装机版也认得出正式版；
 *   3) 都没有就是源码/自测跑法，以及我们平时热同步的 win-unpacked 自用目录：算开发版。
 */
const fs = require('fs');
const path = require('path');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function resolve() {
  const fromShell = String(process.env.KH_APP_VERSION || '').trim();
  const fromFile = readJson(path.join(__dirname, '..', 'version.json'));
  const base = fromShell || String((fromFile && fromFile.version) || '')
    || String((readJson(path.join(__dirname, '..', '..', 'package.json')) || {}).version || '');
  /* 载荷里那份 version.json 是「打包机自己写的答复」，优先级压过外壳：
     外壳只能看见 app.isPackaged，而 win-unpacked 也是 packaged —— 它分辨不出
     「我打给自己日用的这一份」和「进了安装包里的那一份」，硬要它判就会把自用版也标成正式版，
     「调试」板块和 d 后缀一起消失（第六十四轮他自己要的东西，正好看不见）。
     现在出包用 `pack-prep --release`（默认，packaged:true），自用同步用 `pack-prep --dev`（packaged:false），
     谁出的包由出包那一步说了算，不用外壳猜。env 只在没有这份文件时说话（源码跑法、老探针）。 */
  const packaged = fromFile && typeof fromFile.packaged === 'boolean'
    ? fromFile.packaged
    : process.env.KH_APP_PACKAGED === '1';
  return {
    version: base,
    packaged,
    // 开发版版本号结尾带 d（v1.3.5d）：界面上看到的那串字就是判据本身，不搞两套真相
    display: base ? (packaged ? `v${base}` : `v${base}d`) : '',
  };
}

module.exports = { resolve, isDev: () => !resolve().packaged };
