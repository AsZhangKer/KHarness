/**
 * 第七十九轮：开屏加载动画的板子本体（内联在 client/index.html）。
 *
 * 为什么用 jsdom 真解析这份 HTML，而不是把驱动逻辑抽成模块单测：
 * 板子的全部意义是「赶在 bundle 之前画出来」，逻辑一旦抽进 src/ 就得等 chunk 到齐才生效，
 * 那正是 endfield 踩过的坑（他们把动画写成组件里的东西，异步设置段没到时读到默认值 ⇒ 再也不出现）。
 * 所以逻辑就留在内联脚本里，测试也照真页面测。
 *
 * 钉死四件事：
 *  1. 关着 / 独立浏览器窗 ⇒ DOM 里根本没有板子（不是藏起来，是拔掉）
 *  2. 里程碑没齐 ⇒ 绝不报 100%（时间线封顶），这条是「进度是真的」的底线
 *  3. 到齐 / fuse 到点 ⇒ 一定摘干净，两层保险栓都通向同一个幂等的 destroy
 *  4. 板子在放的时候底下那层必须点得动（pointer-events:none）
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const HTML = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
const TOKEN = /window\.__KH_BOOT__ = "__KH_BOOT__";/;
// 里程碑的 id 两处各写一份（板子在内联脚本里，报点在 utils/boot.js），名字对不上就是静默失效
const BOOT_UTIL = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'utils', 'boot.js'), 'utf8');

/** 装载：把服务端会做的那次替换先做掉，再按真页面跑内联脚本 */
function mount({ on = true, url = 'http://127.0.0.1:8317/', reduce = false } = {}) {
  const html = HTML.replace(TOKEN, `window.__KH_BOOT__ = ${JSON.stringify({ on, v: 'v9.9.9' })};`);
  const clock = { t: 0 };
  const dom = new JSDOM(html, {
    url,
    runScripts: 'dangerously',
    pretendToBeVisual: false,
    beforeParse(w) {
      // 自己给时钟：rAF 用 setTimeout 模拟，performance.now 由测试推着走，
      // 这样「时间到了多少」和「跑了多少帧」在同一个可控刻度上。
      // 注意 window.performance 是只读访问器，直接赋值会抛，必须 defineProperty 顶掉。
      Object.defineProperty(w, 'performance', { value: { now: () => clock.t }, configurable: true });
      w.requestAnimationFrame = (cb) => w.setTimeout(() => { clock.t += 16; cb(clock.t); }, 16);
      w.cancelAnimationFrame = (id) => w.clearTimeout(id);
      w.matchMedia = () => ({ matches: reduce });
    },
  });
  return { dom, clock, win: dom.window, doc: dom.window.document };
}

function pctOf(doc) {
  const el = doc.querySelector('.kb-pct');
  return el ? parseInt(el.textContent, 10) : NaN;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('关着的时候：板子必须根本不存在', () => {
  it('boot_plate=0 ⇒ #kh-boot 被拔掉，不留一个隐藏的空壳挡在那儿', () => {
    vi.useFakeTimers();
    const { doc } = mount({ on: false });
    expect(doc.getElementById('kh-boot')).toBeNull();
    expect(doc.getElementById('app')).not.toBeNull();
  });

  it('浏览器独立窗口（?kh=browser）也不播：那是附属小窗，盖一屏只会莫名其妙闪一下', () => {
    vi.useFakeTimers();
    const { doc } = mount({ on: true, url: 'http://127.0.0.1:8317/?kh=browser' });
    expect(doc.getElementById('kh-boot')).toBeNull();
  });

  it('服务端没注上（vite dev / 旧 dist）就按默认播，不能变成「永远不播」', () => {
    vi.useFakeTimers();
    const dom = new JSDOM(HTML, {
      url: 'http://127.0.0.1:5173/',
      runScripts: 'dangerously',
      beforeParse(w) {
        Object.defineProperty(w, 'performance', { value: { now: () => 0 }, configurable: true });
        w.requestAnimationFrame = (cb) => w.setTimeout(() => cb(0), 16);
        w.matchMedia = () => ({ matches: false });
      },
    });
    // 内联脚本读到的是字符串 "__KH_BOOT__"，不是配置对象 ⇒ 走默认播那条分支
    expect(dom.window.document.getElementById('kh-boot')).not.toBeNull();
    expect(dom.window.__khBoot).not.toBeNull();
  });
});

describe('进度是真的：里程碑没齐就不许谎报 100%', () => {
  it('时间线跑到天黑也封顶在 90%，状态行还老实地说在等什么', () => {
    vi.useFakeTimers();
    const { doc, win, clock } = mount();
    for (let i = 0; i < 200; i++) {   // 推 3.2 秒，早过 DURATION
      clock.t += 16;
      vi.advanceTimersByTime(16);
    }
    expect(pctOf(doc)).toBeLessThanOrEqual(90);
    expect(pctOf(doc)).toBeGreaterThan(0);
    expect(doc.querySelector('.kb-status').textContent).toBe('LOADING MODULES');
    expect(win.__khBoot.state().finished).toBe(false);
  });

  it('报一格涨一格；且 utils/boot.js 里那几个 id 板子必须都认（两处改名会静默失效，这条就是盯它）', () => {
    vi.useFakeTimers();
    const { doc, win } = mount();
    expect(pctOf(doc)).toBe(0);
    win.__khBoot.mark('module');
    vi.advanceTimersByTime(32);
    expect(pctOf(doc)).toBeGreaterThanOrEqual(25);
    win.__khBoot.mark('app');
    win.__khBoot.mark('prefs');
    vi.advanceTimersByTime(32);
    expect(pctOf(doc)).toBeGreaterThanOrEqual(70);
    expect(doc.querySelector('.kb-status').textContent).toBe('OPENING VIEW');

    // util 声明的每个 id 拿去报点，板子里必须真的记上一格（最后一条没有逗号，所以 ,? ）
    const ids = [...BOOT_UTIL.matchAll(/^\s{2}\w+: '([a-z]+)',?/gm)].map((m) => m[1]);
    expect(ids.length).toBe(4);
    for (const id of ids) {
      win.__khBoot.mark(id);
      expect(win.__khBoot.state().done[id]).toBe(true);
    }
    expect(win.__khBoot.state().milestones).toBe(ids.length);
  });

  it('两张里程碑表逐字相同，且每一格在 src/ 里都有人真的报它（改名只改一半会静默卡住）', () => {
    const plateIds = [...HTML.matchAll(/\{ id: '([a-z]+)', w: \d+, wait:/g)].map((m) => m[1]);
    const utilIds = [...BOOT_UTIL.matchAll(/^\s{2}\w+: '([a-z]+)',?/gm)].map((m) => m[1]);
    // 顺序也要一致：状态行是按这张表挑「还在等谁」的
    expect(plateIds).toEqual(utilIds);

    const srcDir = path.resolve(__dirname, '..', 'src');
    const all = fs
      .readdirSync(srcDir, { recursive: true })
      .filter((f) => /\.(js|vue)$/.test(f))
      .map((f) => fs.readFileSync(path.join(srcDir, f), 'utf8'))
      .join('\n');
    for (const id of utilIds) expect(all).toContain(`bootMark('${id}')`);
  });

  it('四格报齐 ⇒ 走到 100%、进收尾、最后把板子整个摘掉并清空句柄', () => {
    vi.useFakeTimers();
    const { doc, win } = mount();
    for (const id of ['module', 'app', 'prefs', 'route']) win.__khBoot.mark(id);
    vi.advanceTimersByTime(48);
    expect(pctOf(doc)).toBe(100);
    expect(doc.querySelector('.kb-status').textContent).toBe('READY');
    // 100% 得先停一拍（HOLD_MS）才允许动扫光，否则这一格数字没人看得见
    vi.advanceTimersByTime(100);
    expect(pctOf(doc)).toBe(100);
    vi.advanceTimersByTime(2000);
    expect(doc.getElementById('kh-boot')).toBeNull();
    expect(win.__khBoot).toBeNull();
  });
});

describe('两层保险栓：板子永远不能把应用盖住', () => {
  it('两条时钟都停了也被 fuse 强制收尾（里程碑一个都没报，最后依然摘干净）', () => {
    vi.useFakeTimers();
    const { doc, win, clock } = mount();
    // 让 rAF 不再回调（模拟被遮挡的窗口 / 挂起的标签页里 rAF 停摆），只剩每 60ms 那颗粗时钟与 fuse
    win.requestAnimationFrame = () => 0;
    // 最坏链路：FUSE 5000 → HOLD 220 → 扫光那一相逐帧走不动，靠 exitT(1540) 兜住 = 6760；
    // 推满 8000 是给 kill(6940) 也留出余量，验的是「无论哪一道闸生效，板子最后一定不在了」。
    for (let i = 0; i < 500; i++) {
      clock.t += 16;
      vi.advanceTimersByTime(16);
    }
    expect(win.__khBoot === null || doc.getElementById('kh-boot') === null).toBe(true);
  });

  it('源码层面还得有第三层：一颗不参与清 timer 的硬 kill（收尾本身卡住也照样删节点）', () => {
    expect(HTML).toMatch(/tick = setInterval\(step, 60\)/);        // 第二颗粗时钟
    expect(HTML).toMatch(/kill = setTimeout\(destroy/);            // 最末一道闸
    expect(HTML).toMatch(/pointer-events: none/);                  // 动画在放也不能吞鼠标
    // kill 不许在 cancelClocks 里被清掉：finish() 会先调它停掉进度时钟，
    // 一起清就等于「花字卡住时再没人来摘板子」
    const cancelBody = HTML.slice(HTML.indexOf('function cancelClocks'), HTML.indexOf('function destroy'));
    expect(cancelBody).not.toMatch(/clearTimeout\(kill\)/);
  });

  it('fuse 到点强制收尾也不谎报：数字停在封顶值，状态行仍写着在等谁', () => {
    vi.useFakeTimers();
    const { doc, win, clock } = mount();
    win.__khBoot.mark('module');            // 只报上一格，后面三格永远不来
    for (let i = 0; i < 320; i++) {         // 推过 FUSE_MS(5000)，但停在 HOLD 之内
      clock.t += 16;
      vi.advanceTimersByTime(16);
    }
    expect(win.__khBoot.state().finished).toBe(true);
    expect(pctOf(doc)).toBeLessThanOrEqual(90);
    expect(pctOf(doc)).not.toBe(100);
    expect(doc.querySelector('.kb-status').textContent).not.toBe('READY');
  });

  it('系统要少动效（prefers-reduced-motion）就直接拿走板子，不放扫光', () => {
    vi.useFakeTimers();
    const { doc, win } = mount({ reduce: true });
    for (const id of ['module', 'app', 'prefs', 'route']) win.__khBoot.mark(id);
    vi.advanceTimersByTime(48);
    expect(doc.getElementById('kh-boot')).toBeNull();
  });
});
