/**
 * 浏览器栏「视口错误」误报的守卫。
 *
 * 根因是单位不一致：洞位（getBoundingClientRect）是 CSS px，视图里的 innerWidth 是 DIP，
 * 外壳放置视图时乘过 zoomFactor，界面缩放不是 100% 时两个数直接比必然差一个倍数。
 * 真机读数（_tmp_kh65/zoom_settle_probe.js，真外壳真 BrowserView）：
 *   洞 900×600、主窗 dPR 1.1、视图 dPR 1 → 视图拿到 990×660（=洞×1.1）。
 * 这里锁两件事：判据必须按倍数比，且不能为了消音把门放宽成「什么都算对」。
 */
import { readFileSync } from 'fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(path.resolve(__dirname, '../src/features/chat/BrowserPanel.vue'), 'utf8');

// 与 BrowserPanel 里同一套算式（外壳读数变了要同步改探针，不是改这里凑数）
function judge(guest, hole, mainDpr) {
  const z = guest.dpr > 0 ? mainDpr / guest.dpr : 1;
  const zoom = Number.isFinite(z) && z > 0.2 && z < 6 ? z : 1;
  const wantW = Math.round(hole.width * zoom);
  const wantH = Math.round(hole.height * zoom);
  const tolW = Math.max(10, Math.round(wantW * 0.03));
  const tolH = Math.max(10, Math.round(wantH * 0.03));
  const realW = guest.realW === undefined ? wantW : guest.realW;
  const realH = guest.realH === undefined ? wantH : guest.realH;
  return guest.iw > 40 && guest.ih > 40 && realW >= 40 && realH >= 40
    && Math.abs(guest.iw - wantW) <= tolW && Math.abs(guest.ih - wantH) <= tolH;
}

describe('浏览器栏视口判据按界面缩放换算', () => {
  it('源码里确实乘了倍数，也没有留下原来的绝对比法', () => {
    expect(src).toMatch(/function mainZoom\(/);
    expect(src).toMatch(/dpr:devicePixelRatio/);
    expect(src).toMatch(/Math\.round\(b\.hw \* z\)/);
    expect(src).toMatch(/Math\.round\(b\.hh \* z\)/);
    expect(src).not.toMatch(/Math\.abs\(b\.ih - b\.hh\) <= 8/);
    expect(src).not.toMatch(/Math\.abs\(b\.iw - b\.hw\) <= 8/);
  });

  it('他报错那一档（1.1 倍）：缩放过的洞与视口对得上', () => {
    expect(judge({ iw: 990, ih: 660, dpr: 1 }, { width: 900, height: 600 }, 1.1)).toBe(true);
    // 他给的真实数字：栏位 1176×626 CSS → 视图应拿到 1294×689，实得 1296×702（差在取整与工具条）
    expect(judge({ iw: 1296, ih: 702, dpr: 1 }, { width: 1176, height: 626 }, 1.1)).toBe(true);
  });

  it('没缩放时退化成绝对比法，不会被容差放水', () => {
    expect(judge({ iw: 900, ih: 600, dpr: 1 }, { width: 900, height: 600 }, 1)).toBe(true);
    expect(judge({ iw: 900, ih: 300, dpr: 1 }, { width: 900, height: 600 }, 1)).toBe(false);
  });

  it('真错位仍然报错：洞只有一半高 / 视图比洞宽一截 / 视图被收成 0', () => {
    expect(judge({ iw: 990, ih: 660, dpr: 1 }, { width: 900, height: 300 }, 1.1)).toBe(false);
    expect(judge({ iw: 1110, ih: 660, dpr: 1 }, { width: 900, height: 600 }, 1.1)).toBe(false);
    expect(judge({ iw: 0, ih: 0, dpr: 1 }, { width: 900, height: 600 }, 1.1)).toBe(false);
  });

  it('dPR 读数不可信时不放大成荒谬倍数', () => {
    expect(judge({ iw: 900, ih: 600, dpr: 0 }, { width: 900, height: 600 }, 1)).toBe(true);
    expect(judge({ iw: 900, ih: 600, dpr: 0.001 }, { width: 900, height: 600 }, 1.1)).toBe(true);  // 倍数被夹到 <6，退回原值
  });
});

/**
 * 第六十六轮（同一天，他真机又撞一条）：模型第一次让浏览器去 example.com，
 * 面板还是空白页 → syncBounds 的「空白页把视图收成 0×0」那条分支和就位检查互相咬死。
 * 读数在 _tmp_kh66/blank_hold_probe.js（真外壳真 BrowserView，5/5）。
 */
describe('空白页不许把视图藏成就位检查量不到的 0×0', () => {
  it('源码：hide 那条分支被动作期间的 flag 让开，动作跑完要还回去', () => {
    expect(src).toMatch(/const actionHold = ref\(false\)/);
    expect(src).toMatch(/if \(blankPage\.value && !actionHold\.value\) \{ await bv\(\{ op: 'hide' \}/);
    expect(src).toMatch(/actionHold\.value = true;/);
    expect(src).toMatch(/actionHold\.value = false;\s*\n\s*if \(!offColumn\) await syncBounds\(\)/);
    // 旧的那句无条件 hide 不许回来
    expect(src).not.toMatch(/if \(blankPage\.value\) \{ await bv\(\{ op: 'hide' \}/);
  });

  it('源码：判据要看外壳实际边界，不能只信页面的 innerWidth', () => {
    expect(src).toMatch(/op: 'state'/);
    expect(src).toMatch(/b\.realW >= 40 && b\.realH >= 40/);
    // 第六十八轮：这些话进文案表了（他要在一张表里看到所有能看见的字），
    // 所以这里锁的是「走表」，具体措辞归他改
    expect(src).toMatch(/txt\('chat\.browser\.hidden'/);
    expect(src).toMatch(/txt\('chat\.browser\.viewportBad'/);
  });

  it('回给模型的措辞按他的口径改过：术语统一、去掉口语', () => {
    const chatCopy = require('../src/copy/chat').default;
    expect(chatCopy['chat.browser.initFail']).toContain('内嵌浏览器初始化失败');
    expect(chatCopy['chat.browser.viewportBad']).toContain('视口未就绪');
    expect(src).not.toMatch(/浏览器栏没能就位/);
    expect(src).not.toMatch(/这个动作没有执行/);
    // 「栏位」是内部说法（那一栏让出来的那块洞），可见文案里不该再有；
    // 源码注释里留着一次引用他原话（那句报错的原始形状），那是历史证据，不是界面文字
    for (const k of Object.keys(chatCopy)) expect(chatCopy[k]).not.toMatch(/栏位/);
  });

  it('hide 之后页面仍报旧尺寸这一路必须判失败（实测：边界 0×0、页面还报 419×700）', () => {
    expect(judge({ iw: 419, ih: 700, dpr: 1, realW: 0, realH: 0 }, { width: 419, height: 700 }, 1)).toBe(false);
    expect(judge({ iw: 461, ih: 770, dpr: 1, realW: 0, realH: 770 }, { width: 419, height: 700 }, 1.1)).toBe(false);
    expect(judge({ iw: 419, ih: 700, dpr: 1, realW: 419, realH: 700 }, { width: 419, height: 700 }, 1)).toBe(true);
  });

  it('冷启动没给尺寸的视图（他撞的那种）本来就过不了，摆对位置才过', () => {
    expect(judge({ iw: 0, ih: 0, dpr: 1, realW: 0, realH: 0 }, { width: 419, height: 700 }, 1)).toBe(false);
    expect(judge({ iw: 419, ih: 700, dpr: 1, realW: 419, realH: 700 }, { width: 419, height: 700 }, 1)).toBe(true);
  });
});
