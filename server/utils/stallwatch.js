/**
 * 文本级卡带检测（第五十三轮 #218）。
 *
 * 已有的 repeatStreak 管的是「同一个工具用同样的参数被反复调用」，那是**动作层**的死循环；
 * 模型也可能在**文字层**卡带 —— 同一段话反复吐，一直吐到单次输出上限，用户等到的是几分钟复读机。
 * 这里对累积正文做检测，命中就掐断这一轮。
 *
 * 判据取自同类项目里跑过一段时间的参数（这种阈值靠猜必然一边误报一边漏报，不自己发明）：
 *   · 只看尾部窗口（6000 字）—— 卡带是局部现象，全文比对又慢又没必要；
 *   · 行块级优先于字符级 —— 「同样几行连着再来几遍」是最常见形态，也最好定位；
 *   · 重复单元必须含 ≥4 种不同字符且非纯空白 —— 否则表格分隔线、`====`、长串空格全中招；
 *   · 重复总量要到 minRun（默认 240）字才算 —— 正常的自我强调、短促反问不该被打断。
 *
 * 与那个项目的关键差别：它写了 reset() 却没人调用，而每轮正文是从 0 重新长的，
 * 它的游标按全局长度节流 → 长度一倒退检测就被跳过（第二轮之后等于没防）。
 * 这里 watcher **每轮新建**，游标只在本轮内单调，结构上不带这个洞。
 */
'use strict';

const WINDOW = 6000;          // 只保留尾部这么多字做判断
const MIN_RUN = 240;          // 重复部分总量至少这么多字才认定卡带
const CHECK_EVERY = 96;         // 攒够这么多新字再查一次：查得越晚，命中前已经累积的重复就越多
const MAX_BLOCKS = 24;        // 行块级最多回看「最后 1~24 行」这些长度
const MAX_PERIOD = 200;       // 字符级最大周期

function noisy(unit) {
  return !unit || !unit.trim() || new Set(unit).size < 4;
}

class StallWatch {
  constructor(opts = {}) {
    this.minRun = Number.isInteger(opts.minRun) && opts.minRun >= 60 ? opts.minRun : MIN_RUN;
    this.text = '';
    this.since = 0;
    this.done = null;
  }

  /**
   * 追加增量。返回 null = 继续；返回 { repeatLen } = 卡带，
   * 调用方把正文裁掉尾部 repeatLen 个字（保留一份重复内容）再掐断本轮。
   */
  feed(chunk) {
    if (this.done || !chunk) return null;
    this.text += chunk;
    this.since += String(chunk).length;
    if (this.since < CHECK_EVERY) return null;
    this.since = 0;
    if (this.text.length > WINDOW) this.text = this.text.slice(-WINDOW);
    const repeatLen = this._tailRepeatLen();
    if (repeatLen >= this.minRun) this.done = { repeatLen };
    return this.done;
  }

  _tailRepeatLen() {
    const t = this.text;

    // 1) 行块级：尾部「连续 k 遍同样的 m 行」，遍历所有 m 取裁得最多的那个。
    //    全程在 lines 数组上比，不拿字符串 endsWith 去凑 —— 每段增量都带行尾换行，
    //    字符串那套算来算去会差一个 \n，行级判据就悄悄失效了（第一版就是这样，只剩字符级兜底）。
    const lines = t.split('\n');
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    let best = 0;
    for (let m = Math.min(MAX_BLOCKS, Math.floor(lines.length / 2)); m >= 1; m--) {
      const unit = lines.slice(lines.length - m).join('\n');
      if (!unit || noisy(unit)) continue;
      let k = 1;
      for (let i = lines.length - m; i - m >= 0; i -= m) {
        if (lines.slice(i - m, i).join('\n') !== unit) break;
        k += 1;
      }
      if (k < 2) continue;
      // +1 是把行间那个换行算回去
      if ((k - 1) * (unit.length + 1) > best) best = (k - 1) * (unit.length + 1);
    }
    if (best) return best;

    // 2) 字符级：尾部存在固定周期 p 的连续重复
    const tail = t.slice(-Math.min(t.length, this.minRun + MAX_PERIOD));
    for (let p = 1; p <= Math.min(MAX_PERIOD, Math.floor(tail.length / 2)); p++) {
      const unit = tail.slice(-p);
      if (noisy(unit)) continue;
      let run = 0;
      for (let i = tail.length; i - p >= 0 && tail.slice(i - p, i) === unit; i -= p) run += p;
      if (run >= this.minRun + p) return run - p;
    }
    return 0;
  }
}

module.exports = { StallWatch, WINDOW, MIN_RUN };
