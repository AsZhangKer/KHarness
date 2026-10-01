import { describe, it, expect } from 'vitest';
import { StallWatch } from '../utils/stallwatch.js';

/**
 * 文字级卡带检测（第五十三轮 #218）。
 * 判据是从同类项目抄来的参数，这里锁的是「什么该报、什么不该报」这两头 ——
 * 误报的代价（把模型正常输出掐了）比漏报大得多，所以反例和正例一样重要。
 */
const LINE = '这是一行会被反复吐出来的废话，用来验证卡带检测。\n';

function feedRepeat(w, line, times) {
  let hit = null;
  for (let i = 0; i < times && !hit; i++) hit = w.feed(line);
  return hit;
}

describe('stallwatch：该报的', () => {
  it('同一行连吐几十遍 → 命中，且裁掉的长度让正文只剩一份', () => {
    const w = new StallWatch();
    const hit = feedRepeat(w, LINE, 40);
    expect(hit).toBeTruthy();
    expect(hit.repeatLen).toBeGreaterThan(240);
    // 命中那一刻正文里就这么多字（feedRepeat 一命中就停），裁掉 repeatLen 后该只剩一两份。
    // 别拿「预设要喂的 40 遍」算 —— 那是 1000 字，而检测在第 300 字就掐断了。
    const kept = w.text.length - hit.repeatLen;
    expect(kept).toBeLessThanOrEqual(LINE.length * 2);
  });

  it('整段（多行）反复 → 命中', () => {
    const block = '第一步：打开终端\n第二步：执行 npm ci\n第三步：看输出\n';
    const w = new StallWatch();
    expect(feedRepeat(w, block, 12)).toBeTruthy();
  });

  it('字符级周期复读（没有换行 Also 的情况）→ 命中', () => {
    const w = new StallWatch();
    const seg = 'ab cd ef gh ';           // 11 字符的周期
    const hit = feedRepeat(w, seg.repeat(40), 1);
    expect(hit).toBeTruthy();
  });
});

describe('stallwatch：不该报的', () => {
  it('正常表格（每行不同）→ 不报', () => {
    const w = new StallWatch();
    for (let i = 0; i < 30; i++) expect(w.feed(`姓名${i} | 年龄 ${18 + (i % 20)}\n`)).toBeNull();
  });

  it('分隔线连排（同一字符刷屏）→ 不报：单元要求 ≥4 种不同字符', () => {
    const w = new StallWatch();
    for (let i = 0; i < 30; i++) expect(w.feed('========================\n')).toBeNull();
  });

  it('代码缩进/空行反复 → 不报（纯空白单元一律放过）', () => {
    const w = new StallWatch();
    for (let i = 0; i < 40; i++) expect(w.feed('    \n')).toBeNull();
  });

  it('重复量没到阈值 → 不报', () => {
    const w = new StallWatch();
    expect(feedRepeat(w, LINE, 3)).toBeNull();
  });

  it('阈值可调：把 minRun 提到 600，同样的重复就不报了', () => {
    const w = new StallWatch({ minRun: 600 });
    expect(feedRepeat(w, LINE, 10)).toBeNull();
  });
});

describe('stallwatch：每轮新建（同类项目就是栽在这里）', () => {
  it('它的 watcher 带全局游标又没人 reset，第二轮就检不出来；我们靠每轮 new 规避', () => {
    const w1 = new StallWatch();
    expect(feedRepeat(w1, LINE, 40)).toBeTruthy();
    const w2 = new StallWatch();                       // 第二轮：全新实例
    expect(feedRepeat(w2, LINE, 40)).toBeTruthy();     // 依然有效
    expect(w1.feed(LINE)).toBeNull();                  // 命中过一次后不再重复报，免得刷屏
  });
});
