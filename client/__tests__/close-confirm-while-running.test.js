/**
 * 「窗口容易误关闭」——他第八十二轮要的那句确认：还有会话在回答中时，关窗口先问一句。
 *
 * 三条关闭路径必须共用同一句问话，不能出现「按钮拦、快捷键不拦」：
 *   1) 顶栏那颗 X 与菜单「关闭窗口」—— 本来就在页面里，走 WindowBar 的 act('close')；
 *   2) Ctrl+W —— 主进程原来直接 win.close()，现在改成发一句 kh:ask-close，让页面裁决；
 *   3) 页面 → 主进程：确认过才真的调 winCtl('close')。
 * 这一条锁接线（跨三个文件的链路，逻辑测试覆盖不到），口径本身在 stores/running.js 那头测。
 *
 * 已知没覆盖的一条：Alt+F4 / 任务栏「关闭窗口」不经过页面，拦不到 —— 要拦得住得在主进程
 * 的 close 事件里做，而那里的三条死法（销毁顺序、close 里只能 preventDefault+setImmediate）
 * 不适合为了一句确认去碰。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (p) => fs.readFileSync(path.resolve(__dirname, p), 'utf8');
const BAR = read('../src/ui/WindowBar.vue');
const MAIN = read('../../desktop/main.js');
const PRELOAD = read('../../desktop/preload.js');

describe('关闭窗口前的确认', () => {
  it('关闭动作先查「还有没有活儿在跑」，跑着就弹确认', () => {
    expect(BAR).toMatch(/action === 'close'[\s\S]*runningCount\(\) > 0/);
    expect(BAR).toMatch(/await confirmDialog\(/);
    // 人说不关就必须停下：确认返回 false 时一颗键都不许发出去
    expect(BAR).toMatch(/if \(!ok\) return/);
  });

  it('确认文案用的是他给的那句，且这是危险动作（红按钮自己写清字样）', () => {
    expect(BAR).toContain('还有会话回答中，是否确认关闭？');
    expect(BAR).toMatch(/danger: true/);
    expect(BAR).toMatch(/okText: '确认关闭'/);
  });

  it('Ctrl+W 不再由主进程自己关，改成问页面', () => {
    const w = MAIN.match(/if \(k === 'w'\) \{[\s\S]*?\}/);
    expect(w, '找不到 Ctrl+W 那条分支').toBeTruthy();
    expect(w[0]).toContain("send('kh:ask-close')");
    expect(w[0]).not.toMatch(/win\.close\(\)/);
  });

  it('preload 把这一问暴露成 onAskClose，页面关掉监听时要退订', () => {
    expect(PRELOAD).toMatch(/onAskClose: \(cb\) => \{[\s\S]*ipcRenderer\.on\('kh:ask-close', h\);[\s\S]*removeListener/);
    expect(BAR).toMatch(/api\.onAskClose\(/);
    expect(BAR).toMatch(/offAskClose\(\)/);
  });
});
