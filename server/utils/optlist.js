/**
 * ask_user 的入参整形：把模型给的「候选项」和「好几个问题」还原成它们本来的形状。
 *
 * 为什么单独一个纯模块：这两个判断全是启发式，必须有单测；放进 extools.js 就得连带
 * require('./toolgate') → require('../database')，测一个字符串切分要开一份真库。
 *
 * 两条他报的毛病都出在这里：
 *   1) 一条候选项里带逗号就被切成两个按钮（「先修登录 bug，再补测试」→ 两条）；
 *   2) 模型把三个问题塞进一个 question、九个选项塞进一个 options，横幅上就是一坨。
 */

// 行首的列表记号才剥：`- A` `* A` `1. A` `2）A`（点和括号后面**必须有空格**）、`1、A`。
// 以前写成 `[-*\d.、)\]]+`，「3.5 以上版本」这种开头会被整个削成「5 以上版本」。
const LIST_MARKER = /^\s*(?:[-*•]\s+|\d+[.)）]\s+|\d+、|[a-z][.)）]\s+)/i;

function clean(x) {
  return String(x == null ? '' : x).replace(LIST_MARKER, '').trim();
}

function finish(list, max) {
  const out = [];
  for (const raw of list) {
    const s = clean(raw);
    if (!s || out.includes(s)) continue;
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 候选项 → 字符串数组。数组原样收（模型走原生 function calling 时给的就是数组）；
 * 字符串只在「明显是列表」的形状下才切，切不开就整条留 —— 宁可一个按钮字长一点，
 * 也不能把一句话切成两个都不成立的选项。
 */
function parseOptions(raw, max = 8) {
  if (Array.isArray(raw)) return finish(raw, max);
  const s = String(raw ?? '').trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const j = JSON.parse(s);
      if (Array.isArray(j)) return finish(j, max);
    } catch (e) { /* 不是合法 JSON 数组，按普通文本继续 */ }
  }
  // 1) 换行最强：模型一行写一项
  const byLine = s.split(/\r?\n/).filter((x) => clean(x));
  if (byLine.length > 1) return finish(byLine, max);
  // 2) 分号 / 竖线 / 顿号：中文里这三个基本只用来列清单
  for (const re of [/[；;|]+/g, /、+/g]) {
    const parts = s.split(re).filter((x) => clean(x));
    if (parts.length > 1) return finish(parts, max);
  }
  // 3) 逗号最后才考虑，而且半角与全角区别对待：
  //    半角 ", " 是模型写清单最常见的写法（"A, B, C"），两段就切；
  //    全角「，」在中文里更常出现在句子中间（「先修登录 bug，再补测试」），要 ≥3 段且每段 ≤12 字才切。
  //    任何一段括号不闭合 = 这一项本身被切坏了，整串原样留。
  const ascii = s.split(/,[ ]*/).filter((x) => clean(x));
  if (listShape(ascii, 2, 16)) return finish(ascii, max);
  const wide = s.split(/，+/).filter((x) => clean(x));
  if (listShape(wide, 3, 12)) return finish(wide, max);
  return finish([s], max);
}

/** 切出来像不像一份清单：段数够、每段够短、没有句末标点、括号成对 */
function listShape(parts, minParts, maxLen) {
  if (parts.length < minParts) return false;
  return parts.every((raw) => {
    const x = clean(raw);
    if (!x || x.length > maxLen) return false;
    if (/[。！？?!]/.test(x)) return false;
    const open = (x.match(/[（(]/g) || []).length;
    const close = (x.match(/[）)]/g) || []).length;
    return open === close;
  });
}

/**
 * 「一个问题」的字符串里其实塞了好几题时的拆法。判据收得很紧，三个条件同时满足才拆：
 * 至少两行、每行都以问号收尾（？/?，允许后面跟引号或括号）、行数 ≤ 6（再多就是正文不是提问）。
 * 拆不出来就原样返回一题 —— 宁可让它一屏显示长一点，也不要把正文切碎成假问题。
 */
function splitQuestions(text, max = 6) {
  const s = String(text ?? '').trim();
  if (!s) return [];
  const lines = s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const looksLikeQuestion = (x) => /[？?][”"'）)】]?$/.test(x);
  if (lines.length >= 2 && lines.length <= max && lines.every(looksLikeQuestion)) return lines;
  // 单行里「1) …？ 2) …？」这种编号串，也按编号拆
  if (lines.length === 1) {
    const numbered = s.split(/(?=(?:\d+[)）.、]|[①-⑩]|[A-Za-z][)）.、])\s*)/).map((x) => x.trim()).filter(looksLikeQuestion);
    if (numbered.length >= 2 && numbered.length <= max) return numbered;
  }
  return [s];
}

module.exports = { parseOptions, splitQuestions, cleanOption: clean };
