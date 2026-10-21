// 工具结果的「入库 + pruner」层（第一百一十五轮照 opencode 的 message parts 做；
// 第一百一十七轮把裁剪阈值改成「字节/行 + token 硬顶」，并给 read_file 加了 offset/limit 分页）。
//
// 旧口径：工具调用与结果只活在内存里的 upstreamMsgs，回合结束即消失。于是
//   ① 模型下一轮真的「忘了刚读的文件」——上下文里根本没有那些内容；
//   ② 用量口径被迫在「下一发」和「这一发」之间二选一，显示要么虚高要么塌回去。
// 新口径：一次工具往返就是两个部件（tool_call / tool_result），跟正文一样落库、一样参与下一发装配。
//
// 落库时就要**裁剪**：一条 read_file 能吐出几万 token，三十条就把窗口吃掉一半。
//
// 阈值怎么定（第一百一十七轮，他的口径「别让我刚读的文件凭空没了」）：
//   · 触发：**50 KiB 或 2000 行**（与 opencode 的 tool-output 同一数量级）。
//     旧值 5120 tok ≈ 340 行 ASCII —— 读一个 1500 行的源文件只能看到前 340 行，
//     比 opencode 紧 4 倍，于是模型每隔一轮就要重读同一个文件。
//   · 保留：**头 800 行 + 标记 + 尾 200 行**。保尾不是客气：报错、diff 结论、
//     「共 N 行」这些都在结尾，只留头的话模型必须再读一轮才能知道命令到底成没成
//     （opencode 只留开头，那一轮就是它最常被吐槽的地方）。
//   · 硬顶：不管多少行，裁剪后总量不超过 **16000 tok**（我们自己的尺子）。
//     单行超长（打包后的 bundle、压缩过的 css）按行切不动，这时退化为按 token 切头尾。
//   · 标记里**不承诺**「全文落盘可读」：装机版的数据目录对模型是隐身的（privatepaths），
//     教它去读只会让它撞墙重试。标记只说省掉了哪几行、以及**怎么重新取**
//     —— read_file 现在支持 offset/limit（行号），那才是正路。
const { estimateTokens } = require('./agentsmd');
const pagecap = require('./pagecap');

// 触发「太大」的直觉度量：字节与行数（与 opencode 的 tool-output 同源，不再用 token 当第一判据）
const TOOL_MAX_CHARS = 50 * 1024;    // 50 KiB（按字符计，中文也算 1）
const TOOL_MAX_LINES = 2000;
// 保留形态
const TOOL_HEAD_LINES = 800;
const TOOL_TAIL_LINES = 200;
// 硬顶：裁剪之后不允许超过这么多 token（单行超长时按它切；也兼作触发线 —— 中文 1 tok/字，
// 不按 token 兜一次的话，50KiB 的中文正文会变成 5 万 token 一条）。16000 是「800 行代码 + 200 行尾巴」
// 的实测值（每行约 45 字 → 首尾合计约 13.5k tok），刚好装得下，不用再退化。
const TOOL_MAX_TOKENS = 16000;
const TOOL_HEAD_TOKENS = Math.round(TOOL_MAX_TOKENS * 0.8);   // 12800
const TOOL_TAIL_TOKENS = TOOL_MAX_TOKENS - TOOL_HEAD_TOKENS;  // 3200

/* 历史工具结果的**总量**清理（第二层）。
 *
 * 第一百一十八轮修正（线上事故：上下文才 16% 就收到「工具结果总量超出预算，已把最早的一批
 * 换成占位符」）——病根不在阈值大小，而在**触发条件**：
 *   · 旧实现把它挂在 maybeAutoCompress 的最前面，**每回合无条件跑一遍**，
 *     预算按窗口 10% 算（W=200k → 20k tok，而单条工具结果硬顶就是 16k tok）：
 *     正常读两个文件就超预算，模型刚读的东西被抹成占位符，用户被迫手动压缩。
 *   · opencode / DSH 的 pruner 不是这么用的：它是**压缩流程里的一步**，
 *     在上下文已到压缩线、准备压缩时才来「先削可逆的、再压不可逆的」。
 *     没有谁会在用了 16% 的窗口时去删用户的历史。
 *
 * 现在的口径：
 *   ① 闸门在调用方（pruneToolParts）：**没到压缩线，一条都不动**；
 *   ② 到了压缩线，目标不是「压到窗口 10%」，而是「压到压缩线的下方一点」
 *      （PRUNE_TARGET_RATIO），刚好让这一轮不必牺牲对话摘要；
 *   ③ 当前回合（以及更新的）工具结果**永不清理** —— 那正是模型下一步的依据。
 *
 * budgetForWindow 只剩兜底用途（调用方没给压缩线时），不再参与正常判断。
 */
function budgetForWindow(limit) {
  const w = Number(limit) || 0;
  if (!(w > 0)) return 24000;
  return Math.min(80000, Math.max(16000, Math.round(w * 0.1)));
}

// 到了压缩线，把整包削到「压缩线 × 这个比例」以内（留 15% 余量给本回合继续长出来的内容）
const PRUNE_TARGET_RATIO = 0.85;
function protectForWindow(limit) {
  const w = Number(limit) || 0;
  if (!(w > 0)) return 12000;
  return Math.min(40000, Math.max(8000, Math.round(w * 0.05)));
}

// 按「估算 token 上限」从开头切（二分找最长前缀，避免一次性 O(n) 的反复估）
function takeHeadByTokens(text, maxTokens) {
  const s = String(text || '');
  if (maxTokens <= 0) return '';
  if (estimateTokens(s) <= maxTokens) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(s.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo);
}

function takeTailByTokens(text, maxTokens, notBefore = 0) {
  const s = String(text || '');
  if (maxTokens <= 0) return '';
  if (estimateTokens(s) <= maxTokens) return s;
  let lo = notBefore, hi = s.length;   // 找最短的后缀，长度 = s.length - start
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (estimateTokens(s.slice(mid)) <= maxTokens) hi = mid;
    else lo = mid + 1;
  }
  return s.slice(lo);
}

/**
 * 单条工具结果的裁剪。返回 { text, meta }：
 *   meta = { tokens, raw_chars, raw_tokens, raw_lines, truncated, omitted_lines, omitted_chars, path }
 * 没超阈值时原样返回（meta.truncated=false），一个字符都不动。
 */
function pruneToolOutput(input, opts = {}) {
  const full = String(input == null ? '' : input);
  const rawTokens = estimateTokens(full);
  const allLines = full.split('\n');
  const lineCount = allLines.length;
  const base = { raw_chars: full.length, raw_tokens: rawTokens, raw_lines: lineCount };
  const tooBig = full.length > TOOL_MAX_CHARS || lineCount > TOOL_MAX_LINES || rawTokens > TOOL_MAX_TOKENS;
  if (!tooBig) {
    return { text: full, meta: { ...base, tokens: rawTokens, truncated: false, path: '', omitted_lines: 0, omitted_chars: 0 } };
  }

  // ① 先按行切：头 800 行 + 尾 200 行
  let headLines = Math.min(TOOL_HEAD_LINES, lineCount);
  let tailLines = Math.min(TOOL_TAIL_LINES, Math.max(0, lineCount - headLines));
  let head = allLines.slice(0, headLines).join('\n');
  let tail = tailLines > 0 ? allLines.slice(lineCount - tailLines).join('\n') : '';
  let byTokens = false;

  // ② 单行超长（bundle / 压缩 css）按行切不动 → 按 token 切，并换算出对应行号
  if (estimateTokens(head) + estimateTokens(tail) > TOOL_MAX_TOKENS) {
    byTokens = true;
    head = takeHeadByTokens(full, TOOL_HEAD_TOKENS);
    tail = takeTailByTokens(full, TOOL_TAIL_TOKENS, head.length);
    headLines = Math.min(lineCount, head.split('\n').length);
    tailLines = tail ? Math.min(lineCount - headLines, tail.split('\n').length) : 0;
  }

  const omittedChars = Math.max(0, full.length - head.length - tail.length);
  const omittedLines = Math.max(0, lineCount - headLines - tailLines);
  // 全文落盘（30 分钟有效，与页面缓存的续取同一套）。**不在标记里提它**：
  // 装机版的数据目录对模型隐身，教它去读等于教它撞墙。落盘只给调试/排查留底。
  const file = opts.spill === false ? null
    : pagecap.writeCache('tool-parts', String(opts.key || full.slice(0, 200) + '|' + full.length), full);

  const keepDesc = `第 1–${headLines} 行与第 ${lineCount - tailLines + 1}–${lineCount} 行`
    + (byTokens ? '（按长度截断，不是整行边界）' : '');
  const marker = `\n\n…[工具结果过大已裁剪：原文 ${lineCount.toLocaleString('en-US')} 行 / `
    + `${full.length.toLocaleString('en-US')} 字（约 ${rawTokens.toLocaleString('en-US')} tok），`
    + `这里只给 ${keepDesc}${omittedLines > 0 ? `，中间 ${omittedLines.toLocaleString('en-US')} 行（约 ${omittedChars.toLocaleString('en-US')} 字）没有发出来` : ''}。`
    + `需要那一段就重新调用 read_file 并带 offset/limit 只取你要的几十行`
    + `（例如 offset=${headLines + 1}, limit=200），或用 grep 精确定位；不要整份重读，重读会被裁到同一段。]…\n\n`;

  const text = head + marker + tail;
  return {
    text,
    meta: {
      tokens: estimateTokens(text),
      ...base,
      truncated: true,
      omitted_lines: omittedLines,
      omitted_chars: omittedChars,
      head_lines: headLines,
      tail_lines: tailLines,
      by_tokens: byTokens,
      path: file || '',
    },
  };
}

/**
 * 历史工具结果的总量清理。
 *
 * items: [{ id, name, turn_id, tokens, text }] —— 按时间升序（最旧在前）。
 * 返回 { items, pruned, freedTokens }：被清理的条目 text 换成一行占位符，其余原样。
 *
 * 规则：
 *   · 总量没超预算 → 一条都不动（短会话零副作用）；
 *   · **当前回合（turn_id >= keepTurnId）的工具结果永不清理** —— 那是模型下一步的依据，
 *     清掉它等于让模型「忘了刚读的文件」，比多花几万 token 昂贵得多；
 *   · 最近 protect 个 token 的结果永不清理；
 *   · 从最旧的开始清，清到预算内就停。
 */
function pruneHistoryResults(items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const budget = Number(opts.budget) > 0 ? Number(opts.budget) : 24000;
  const protect = Number(opts.protect) >= 0 ? Number(opts.protect) : 12000;
  const keepTurnId = Number(opts.keepTurnId) || 0;
  let total = 0;
  for (const it of list) total += Math.max(0, Number(it.tokens) || 0);
  if (total <= budget) return { items: list, pruned: 0, freedTokens: 0 };

  // 从尾部往前算「受保护的那一段」的起点
  let keepFrom = list.length;
  let kept = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    kept += Math.max(0, Number(list[i].tokens) || 0);
    if (kept > protect) { keepFrom = i + 1; break; }
    keepFrom = i;
  }
  // 当前回合及之后的一律保留：取两者更靠前（保留得更多）的那个起点
  if (keepTurnId > 0) {
    for (let i = 0; i < list.length; i++) {
      const t = Number(list[i].turn_id) || 0;
      if (t >= keepTurnId) { if (i < keepFrom) keepFrom = i; break; }
    }
  }

  let pruned = 0;
  let freed = 0;
  const out = list.slice();
  for (let i = 0; i < keepFrom && total > budget; i++) {
    const it = list[i];
    const tok = Math.max(0, Number(it.tokens) || 0);
    if (!tok) continue;
    const name = it.name || '工具';
    const placeholder = `[较早的工具结果已清理：${name} 原文 ${(it.chars || 0).toLocaleString('en-US')} 字、约 ${tok.toLocaleString('en-US')} tok。`
      + `内容在后续对话里已被更相关的结果取代；若还需要，请重新调用一次工具。]`;
    const now = estimateTokens(placeholder);
    out[i] = { ...it, text: placeholder, tokens: now, pruned: true };
    total -= (tok - now);
    freed += (tok - now);
    pruned++;
  }
  return { items: out, pruned, freedTokens: freed };
}

module.exports = {
  TOOL_MAX_CHARS, TOOL_MAX_LINES, TOOL_HEAD_LINES, TOOL_TAIL_LINES,
  TOOL_MAX_TOKENS, TOOL_HEAD_TOKENS, TOOL_TAIL_TOKENS,
  PRUNE_TARGET_RATIO,
  budgetForWindow, protectForWindow,
  pruneToolOutput, pruneHistoryResults,
  takeHeadByTokens, takeTailByTokens,
};
