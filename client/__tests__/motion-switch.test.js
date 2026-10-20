/**
 * 界面动效开关（第八十一轮，Linux「动画几乎全失效」那条的落点）。
 *
 * 判据是「谁来决定降级」：以前是系统的 prefers-reduced-motion（桌面一关动画，全站 16 处一起静帧，
 * 而且没有任何地方能关回来），现在只认 <html data-motion>，值由设置-外观那颗开关写。
 * 这里测开关本身；CSS 侧那 16 处门控由 motion-css.test 兜住（别让谁再顺手加回 @media）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

async function freshMotion() {
  vi.resetModules();
  return await import('../src/stores/motion.js');
}

describe('界面动效开关', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.motion;
  });

  it('没存过 = 开：<html data-motion="on">', async () => {
    const m = await freshMotion();
    expect(m.motionState.on).toBe(true);
    expect(document.documentElement.dataset.motion).toBe('on');
  });

  it('关掉：属性、落盘、读回三样一起对上', async () => {
    const m = await freshMotion();
    expect(m.setMotion(false)).toBe(true);
    expect(m.motionState.on).toBe(false);
    expect(document.documentElement.dataset.motion).toBe('off');
    expect(localStorage.getItem('kh.motion')).toBe('off');
  });

  it('重启后记住关（首帧就得是关的，不然每次启动都闪一次动画）', async () => {
    localStorage.setItem('kh.motion', 'off');
    const m = await freshMotion();
    expect(m.motionState.on).toBe(false);
    expect(document.documentElement.dataset.motion).toBe('off');
    m.setMotion(true);
    expect(document.documentElement.dataset.motion).toBe('on');
  });

  it('全站不再有「自动跟随系统减少动效」的降级入口（这条只能扫源码：jsdom 不跑 @media）', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const ROOT = path.resolve(__dirname, '../src');
    const hits = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(css|vue)$/.test(e.name) && fs.readFileSync(p, 'utf8').includes('prefers-reduced-motion')) hits.push(p);
      }
    })(ROOT);
    expect(hits).toEqual([]);
  });
});
