/**
 * 第七十四轮 ④：AI 一动就报「内嵌浏览器初始化失败：浏览器栏无法正确渲染，动作未执行」。
 *
 * 触发条件是「这一栏此刻是收起的」或「还没建过视图」—— 三条各自都能单独造成一次失败，
 * 而且第二条会顺手把用户正看着的页面抹掉，所以这条文件钉的是**顺序**而不是文案：
 *   1) 收起时 `.browser-col` 是 width:0，展开有 0.18s 宽度过渡；老代码 expand + 一个 nextTick 就去量洞，
 *      那一瞬量到 0 → 首次建视图直接抛错。现在 expand 之后先 waitForHole()。
 *   2) 老代码在抛错**之前**就置了 viewReady，于是第二个动作走「已就绪」那条分支，
 *      把 bounds:null 发下去 = 主进程 setBounds(0,0,0,0)，用户正看着的页面被抹成 0×0。
 *   3) 就位重试那五秒里，视图还没建起来时原来只调 syncBounds()，而它在 !viewReady 时是直接 return 的
 *      —— 五秒什么都没做，必然超时。
 * 这些都在 <webview> 之外的原生视图之路上，jsdom 挂不起来（要 window.khDesktop），
 * 所以这里钉源码顺序，端到端那一遍由 `_tmp_kh74/browser_cold_start.js` 在真外壳里量。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// jsdom 那侧的 import.meta.url 不是 file: 协议（new URL 会拿它拼出 http://localhost/... 然后 readFileSync 报
// 「The URL must be of scheme file」），而 vitest 的工作目录固定是仓库根，按它拼最稳
const at = (rel) => path.resolve(process.cwd(), 'client/src', rel);
const SRC = fs.readFileSync(at('features/chat/BrowserPanel.vue'), 'utf8');
const COPY = fs.readFileSync(at('copy/chat.js'), 'utf8');
const STORE = fs.readFileSync(at('stores/browser.js'), 'utf8');

const seg = (from, to) => {
  const i = SRC.indexOf(from);
  expect(i, `源码里找不到 ${from}`).toBeGreaterThan(-1);
  const j = to ? SRC.indexOf(to, i) : -1;
  return SRC.slice(i, j > 0 ? j : i + 2500);
};

describe('① 展开之后要等洞量得到，才动视图', () => {
  const s = seg('async function settleForAction()');

  it('store.expand() 之后先 await waitForHole()', () => {
    const e = s.indexOf('store.expand()');
    const w = s.indexOf('await waitForHole()');
    expect(e).toBeGreaterThan(-1);
    expect(w).toBeGreaterThan(e);
  });

  it('waitForHole 用的是那道 40px 门槛（和 holeBounds 同一个判据），不是自己另发明一套', () => {
    const f = seg('async function waitForHole');
    expect(f).toContain('holeBounds()');
    expect(seg('function holeBounds()')).toMatch(/r\.width < 40 \|\| r\.height < 40/);
  });
});

describe('② 量不到洞时绝不宣布「已就绪」，也绝不发空 bounds', () => {
  const s = seg('async function ensureView()', '/** 右键这一栏');

  it('先建视图（把独立窗口那一扇认领回来），再判洞，抛错在 viewReady 之前', () => {
    const create = s.indexOf("op: 'create'");
    const throwNoHole = s.indexOf("txt('chat.browser.noHole'");
    const ready = s.indexOf('viewReady = true');
    expect(create).toBeGreaterThan(-1);
    expect(throwNoHole).toBeGreaterThan(create);
    expect(throwNoHole).toBeLessThan(ready);
  });

  it('洞量不到也照样 create（独立窗口的视图要靠这一步认领回来），但侧栏那一扇没建过视图时才抛错', () => {
    expect(s).toContain('bounds: bounds || undefined');
    expect(s).toMatch(/if \(!bounds && !isWin\)/);
  });

  it('已就绪那条分支只在真有 bounds 时才发（bounds:null 等于把视图抹成 0×0）', () => {
    expect(s).toMatch(/} else if \(bounds\) \{[\s\S]{0,200}op: 'bounds'/);
    expect(s).not.toMatch(/else \{\s*await bv\(\{ op: 'bounds', bounds \}\)/);
  });
});

describe('③ 五秒重试里真的在重试', () => {
  const s = seg('const deadline = Date.now() + 5000;', 'async function cdp');

  it('视图没建起来时重试的是 ensureView，不是空转的 syncBounds', () => {
    expect(s).toMatch(/if \(!viewReady\) \{ await ensureView\(\)/);
    expect(s).toMatch(/else \{ await syncBounds\(\); \}/);
  });

  it('洞根本没撑开时报的是这一栏的尺寸（noHole），不是看不懂的「面板 0×0」', () => {
    expect(s).toMatch(/b\.hw < 40 \|\| b\.hh < 40[\s\S]{0,80}chat\.browser\.noHole/);
    expect(COPY).toContain("'chat.browser.noHole'");
  });
});

describe('④ 独立窗口期间不许把栏拉回侧边', () => {
  it('只有「这一栏真没显示」才 expand；独立窗口那扇 shown 恒为真', () => {
    const s = seg('async function settleForAction()');
    expect(s).toMatch(/if \(!shown\.value\) store\.expand\(\)/);
    expect(SRC).toMatch(/const shown = computed\(\(\) => isWin \|\| st\.open\)/);
  });

  it('store 那边的口径不变：独立期间侧栏不渲染，还原时才强制展开', () => {
    expect(STORE).toContain('if (ev.detached) state.open = false;');
    expect(STORE).toContain('state.detached = ev.detached;');
  });
});
