/**
 * ask_user 的入参整形（第五十九轮他报的两条）：
 *   ① 「一条预设回复被分成多个选项」—— 逗号一刀切会把一句正常的话切成两个按钮；
 *   ② 「多个问题会被放在一起问」—— 模型把三行问句塞进一个 question。
 * 判据都在 utils/optlist.js，这个文件只测纯函数（它不碰库，所以能直接 require）。
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parseOptions, splitQuestions } = require('../utils/optlist.js');

describe('候选项拆分', () => {
  it('数组原样收下：去空、去重、最多 8 条', () => {
    expect(parseOptions([' 先修 bug ', '先加功能', '先修 bug', ''])).toEqual(['先修 bug', '先加功能']);
    expect(parseOptions(Array.from({ length: 20 }, (_, i) => `项${i}`)).length).toBe(8);
  });

  it('一条候选里带逗号不再被切成两个按钮（他报的那条）', () => {
    expect(parseOptions('先修登录 bug，再补测试')).toEqual(['先修登录 bug，再补测试']);
    expect(parseOptions('A（推荐，成本低）')).toEqual(['A（推荐，成本低）']);
  });

  it('但 "A, B, C" 这种短列表还是要拆', () => {
    expect(parseOptions('修 bug, 加功能, 重构')).toEqual(['修 bug', '加功能', '重构']);
    expect(parseOptions('修 bug, 加功能')).toEqual(['修 bug', '加功能']);
    // 全角逗号要 ≥3 段才敢切（中文里它更常出现在句子中间）
    expect(parseOptions('修 bug，加功能，重构')).toEqual(['修 bug', '加功能', '重构']);
    expect(parseOptions('修 bug，加功能')).toEqual(['修 bug，加功能']);
  });

  it('换行 / 分号 / 顿号 / 竖线都算列表', () => {
    expect(parseOptions('修 bug\n加功能')).toEqual(['修 bug', '加功能']);
    expect(parseOptions('修 bug；加功能')).toEqual(['修 bug', '加功能']);
    expect(parseOptions('修 bug、加功能')).toEqual(['修 bug', '加功能']);
    expect(parseOptions('修 bug|加功能')).toEqual(['修 bug', '加功能']);
  });

  it('模型给成 JSON 字符串数组时也按数组收', () => {
    expect(parseOptions('["修 bug","加功能，再补测试"]')).toEqual(['修 bug', '加功能，再补测试']);
  });

  it('行首列表记号剥掉，但数字开头的正文不许被削（以前会把「3.5 以上版本」削成「以上版本」）', () => {
    expect(parseOptions('- 修 bug\n* 加功能')).toEqual(['修 bug', '加功能']);
    expect(parseOptions('1. 修 bug\n2) 加功能')).toEqual(['修 bug', '加功能']);
    expect(parseOptions('3.5 以上版本才支持')).toEqual(['3.5 以上版本才支持']);
  });

  it('空值与脏输入都不炸', () => {
    expect(parseOptions(undefined)).toEqual([]);
    expect(parseOptions('')).toEqual([]);
    expect(parseOptions('[坏 JSON')).toEqual(['[坏 JSON']);
  });
});

describe('一屏塞多题的拆分', () => {
  it('每行都以问号收尾时按题拆开', () => {
    const t = '先修登录 bug 还是先加功能？\n数据库要不要跟着迁？\n要不要补测试？';
    expect(splitQuestions(t)).toEqual(['先修登录 bug 还是先加功能？', '数据库要不要跟着迁？', '要不要补测试？']);
  });

  it('单行里「1) …？ 2) …？」这种编号串也拆', () => {
    const list = splitQuestions('1) 用 A 方案？ 2) 用 B 方案？');
    expect(list.length).toBe(2);
  });

  it('正常一句话 / 正文里带问号的不拆（宁可一屏显示长一点）', () => {
    expect(splitQuestions('要不要现在部署？')).toEqual(['要不要现在部署？']);
    expect(splitQuestions('我看了下有三处可疑。\n第一处登录？其实是超时；第二处是缓存。')).toHaveLength(1);
  });

  it('超过 6 题不当成问题串', () => {
    const many = Array.from({ length: 8 }, (_, i) => `第${i + 1}个问题？`).join('\n');
    expect(splitQuestions(many)).toHaveLength(1);
  });
});
