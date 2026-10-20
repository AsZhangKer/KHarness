/**
 * 第七十九轮：开屏加载动画（endfield 那一套的 KHarness 版）。
 *
 * 这一页真正要钉死的是两件事，别的都是表面：
 *  1. **首帧就得知道播不播** —— 值由服务端注进 index.html，不靠前端异步读设置。
 *     endfield 那条「动画再也不出现」的 bug 就是这么来的（异步段没到时读到默认值）。
 *  2. **板子绝不能把应用盖住** —— 关掉/独立窗要立刻没掉，播完要真摘掉，摘板要幂等。
 *
 * 进度是不是"真的"（里程碑没齐不许报 100%）在 client/__tests__/boot-plate-round78.test.js 里量。
 */
import { describe, it, expect } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');

const bootinject = require('../utils/bootinject');
const { DEFAULT_SETTINGS } = require('../data/defaults');

/** 假 db：只认 boot_plate 这一行，形状照 better-sqlite3 的 .get() */
function fakeDb(value) {
  return {
    prepare() {
      return { get: () => (value === undefined ? undefined : { value }) };
    },
  };
}

describe('boot_plate 这条设置：三端名字必须一致', () => {
  it('服务端种子化了，默认开', () => {
    expect(DEFAULT_SETTINGS.boot_plate).toBe('1');
  });

  it('写库白名单里有这一项（漏了就是「前端勾了、后端静默丢掉照样回 200」）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'settings.js'), 'utf8');
    expect(/boot_plate:\s*boolSetting/.test(src)).toBe(true);
  });

  it('前端字段映射到同一个 key', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'client', 'src', 'stores', 'prefs.js'),
      'utf8'
    );
    expect(/bootPlate:\s*'boot_plate'/.test(src)).toBe(true);
  });
});

describe('bootConfig：读不出就按默认播，不读也不许抛', () => {
  it("存了 '0' 才关", () => {
    expect(bootinject.bootConfig(fakeDb('0')).on).toBe(false);
    expect(bootinject.bootConfig(fakeDb('1')).on).toBe(true);
  });

  it('老库里没这一行 = 按默认开（不能因为没种子化就永远不播）', () => {
    expect(bootinject.bootConfig(fakeDb(undefined)).on).toBe(true);
  });

  it('db 直接炸也不抛 —— 首页比一层视觉重要', () => {
    const broken = { prepare() { throw new Error('SQLITE_BUSY'); } };
    expect(bootinject.bootConfig(broken).on).toBe(true);
  });

  it('带上真实版本号（板上那行小字，和「调试」板块同一个来源）', () => {
    const cfg = bootinject.bootConfig(fakeDb('1'));
    expect(typeof cfg.v).toBe('string');
    // display 的形态就是「v1.3.6」/「v1.3.6d」，带不带 d 取决于这次是不是开发版
    expect(cfg.v).toMatch(/^v\d+\.\d+\.\d+d?$/);
  });
});

describe('injectBoot：注得上、且注不上时不弄坏页面', () => {
  const withToken = '<script>window.__KH_BOOT__ = "__KH_BOOT__";</script>';

  it('把占位串换成配置对象字面量', () => {
    const out = bootinject.injectBoot(withToken, { on: false });
    expect(out).toBe('<script>window.__KH_BOOT__ = {"on":false};</script>');
    expect(out).not.toMatch(/"__KH_BOOT__"/);   // 变量名本身带这串下划线，所以要连着引号判
  });

  it('构建产物里没有这个占位（被改写过/旧 dist）就原样返回，前端按默认播', () => {
    const html = '<div id="app"></div>';
    expect(bootinject.injectBoot(html, { on: true })).toBe(html);
  });

  /* 真踩过的坑：index.html 顶部那段说明注释里就写了 "__KH_BOOT__" 这个串（解释占位符没被替换会怎样），
     而 String.replace 只吃第一次命中 ⇒ 换掉的是注释，真正那行赋值一个字没动，
     板子内联脚本永远读到字符串，只能走默认播，设置里关掉也没用。
     探针 _tmp_kh79/boot_inject_probe.js 是靠「长度 +12 字节却找不到注入」把它揪出来的。 */
  it('注释里再提一次占位串也不许抢走那次替换', () => {
    const html = '<!-- 没被替换时它就是个字符串 "__KH_BOOT__" --><script>window.__KH_BOOT__ = "__KH_BOOT__";</script>';
    const out = bootinject.injectBoot(html, { on: false, v: 'v1.3.6d' });
    expect(out).toContain('字符串 "__KH_BOOT__"');           // 注释原样留着
    expect(out).toContain('window.__KH_BOOT__ = {"on":false,"v":"v1.3.6d"};');   // 赋值那行才是被换的
  });

  it('压过的产物（等号两边没空格）也认', () => {
    const out = bootinject.injectBoot('window.__KH_BOOT__="__KH_BOOT__";', { on: true });
    expect(out).toBe('window.__KH_BOOT__={"on":true};');
  });
});

describe('renderIndex：按 mtime 缓存原文，重新构建后必须重读', () => {
  it('改了 dist 里的 index.html，下一次就发出新内容', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-boot-'));
    const file = path.join(dir, 'index.html');
    fs.writeFileSync(file, '<p>__A__ window.__KH_BOOT__ = "__KH_BOOT__";</p>', 'utf8');
    expect(bootinject.renderIndex(dir, { on: true })).toContain('__A__');

    // mtime 只精确到毫秒，连写两次之间挪一下时钟基准，确保缓存真的被判定为过期
    const t = Date.now() + 5;
    fs.utimesSync(file, new Date(t), new Date(t));
    fs.writeFileSync(file, '<p>__B__ window.__KH_BOOT__ = "__KH_BOOT__";</p>', 'utf8');
    const again = bootinject.renderIndex(dir, { on: false });
    expect(again).toContain('__B__');
    expect(again).not.toContain('__A__');
    expect(again).toContain('window.__KH_BOOT__ = {"on":false};');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('index.js 的接线', () => {
  it('SPA 兜底那条中间件走的是注入，不再是裸 sendFile', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    expect(src).toMatch(/bootinject\.renderIndex/);
    // 静态资源那层不能把 index.html 缓存住，否则改了开关要等 maxAge 才见效
    expect(src).toMatch(/filePath\.endsWith\('\.html'\)[\s\S]{0,80}no-cache/);
  });
});
