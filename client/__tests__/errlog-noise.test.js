/**
 * 报错台账不许掺浏览器自己的假报错（第六十一轮，别的 AI 分析里那条 ResizeObserver 噪音）。
 *
 * 「ResizeObserver loop completed with undelivered notifications」不是故障：浏览器只是说这一帧里
 * 观察回调又改了被观察元素的尺寸，下一帧照常跑。流式输出每来一个字就重排一次，这行几乎必然出现，
 * 而它是「点击复制报错」里最占地方的一行 —— 真原因被淹在假报错下面。
 */
import { describe, it, expect } from 'vitest';
import { installErrLog, clearErrLog, errLogSize, recentErrs } from '../src/utils/errlog';

function fire(message) {
  window.dispatchEvent(new ErrorEvent('error', { message }));
}

describe('报错台账的噪音过滤', () => {
  installErrLog();

  it('ResizeObserver 的两种话式都不进台账', () => {
    clearErrLog();
    fire('ResizeObserver loop completed with undelivered notifications.');
    fire('ResizeObserver loop limit exceeded');
    expect(errLogSize()).toBe(0);
  });

  it('真·未捕获异常照样记（过滤不能把门封死）', () => {
    clearErrLog();
    fire("Uncaught TypeError: Cannot read properties of undefined (reading 'usage')");
    expect(errLogSize()).toBe(1);
    expect(recentErrs(1)[0].summary).toContain("reading 'usage'");
  });
});
