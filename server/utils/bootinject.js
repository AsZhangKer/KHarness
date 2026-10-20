/* 开屏加载动画的「首帧配置」注入。
 *
 * 为什么必须由服务端在发出 index.html 时把值注进页面，而不是前端自己读设置：
 * 板子要盖住的正是「HTML 到了、549KB 的 ChatPage chunk 还没到」这段空档。
 * uiPrefs.load() 在 App.vue 挂载后才异步发请求，等它回来再决定播不播，那段已经过去了；
 * 反过来先按默认播、回来发现该关，就变成应用都跑起来了却突然黑一屏。
 * 注在 HTML 上还有个好处：真相只有服务端 settings 这一份，不用往 localStorage 抄一份
 * 会随端口分家的缓存（桌面端每次启动端口都可能变，这是这个项目踩过的老坑）。
 *
 * 同一条坑第三方主题 endfield 也踩过（异步设置段没到时读到默认值 ⇒ 动画再也不出现），
 * 他们是在客户端补一次 settle 救回来的；我们这里没那个必要，HTML 本来就从本机发出去。
 */
const fs = require('fs');
const path = require('path');

/* 只认「赋值形状」这一处，不认裸的占位串。
   踩过一次：index.html 的说明注释里也写了 "__KH_BOOT__" 这个字符串（解释占位符没被替换时会怎样），
   而 String.replace 吃的是第一次命中 —— 结果换掉的是注释，真正那行赋值一个字没动，
   板子内联脚本永远读到字符串 ⇒ 只能走默认播，设置里关掉也没用。
   探针 _tmp_kh79/boot_inject_probe.js 就是靠"长度 +12 字节却找不到注入"抓到的。 */
const TOKEN_RE = /(=\s*)"__KH_BOOT__"/;

/**
 * 读出该注什么。任何一步失败都退回「播」：这是一层视觉，宁可多播一次，
 * 也不能因为读库出错就把首页搞挂；板子自己有 fuse / kill 两层兜底保证它一定会消失。
 * @param {object} db better-sqlite3 实例
 * @returns {{on: boolean, v?: string}}
 */
function bootConfig(db) {
  let on = true;
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'boot_plate'").get();
    // 只有明确存了 '0' 才关；缺行（老库还没种子化这一条）、空值一律按默认开
    on = row ? String(row.value) !== '0' : true;
  } catch (e) {
    on = true;
  }
  const cfg = { on };
  try {
    // 板上那行小字显示真实版本号（含开发版的 d），来源与「调试」板块同一处
    const b = require('./build').resolve();
    if (b && b.display) cfg.v = String(b.display);
  } catch (e) { /* 拿不到就不显示版本，别拖累首页 */ }
  return cfg;
}

/** 把配置注进 HTML。占位符不在（构建产物不对/被改写）就原样返回，前端按默认播。
 *  等号与它后面的空白按原样保留（捕获组 $1）：压过的产物不该被我们重新撑开。 */
function injectBoot(html, cfg) {
  if (typeof html !== 'string' || !TOKEN_RE.test(html)) return html;
  return html.replace(TOKEN_RE, (m, eq) => `${eq}${JSON.stringify(cfg)}`);
}

// dist 里的 index.html 只在重新构建后才会变，按 mtime 缓存一份原文
const cache = new Map();

/** 读 index.html 原文（带 mtime 缓存），注入配置后返回字符串。 */
function renderIndex(distDir, cfg) {
  const file = path.join(distDir, 'index.html');
  const mtimeMs = fs.statSync(file).mtimeMs;
  const hit = cache.get(file);
  let html = hit && hit.mtimeMs === mtimeMs ? hit.html : null;
  if (html === null) {
    html = fs.readFileSync(file, 'utf8');
    cache.set(file, { mtimeMs, html });
  }
  return injectBoot(html, cfg);
}

module.exports = { TOKEN_RE, bootConfig, injectBoot, renderIndex };
