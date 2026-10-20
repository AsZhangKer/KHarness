/**
 * #251 内联思考标签的**分段顺序**（根因 C）。
 *
 * 上游把思考混在正文里时（think 类标签），拆分器以前只回两个聚合串 `{content, reasoning}`，
 * 块内交替就丢了：`甲 <thinking>想</thinking> 乙` 会变成「content='甲乙'、reasoning='想'」，
 * 调用处又固定「先正文后思考」→ 推出去是「甲乙 | 想」，
 * 界面上就是「一段连续的正文被思考劈开」（他报的症状）。
 * 现在 push/flush 额外回一份按扫描顺序的 `pieces`，调用处照它逐段发。
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);
const thinking = nodeRequire('../utils/thinking');

const T = 'thin' + 'k';   // 拼一下，别让这个字面量出现在源码里（与 thinking.js 同一惯例）
const OPEN = '<' + T + '>';
const CLOSE = '</' + T + '>';

/** 把一次 push（含可能的 flush）的分段折成 'kind:text' 形状，便于断言顺序 */
function piecesOf(input, { flush = true } = {}) {
  const sp = thinking.createReasoningSplitter();
  const out = [...sp.push(input).pieces];
  if (flush) out.push(...sp.flush().pieces);
  return out.map((p) => `${p.kind}:${p.text}`);
}

describe('内联思考标签：分段顺序', () => {
  it('甲 <思考> 想 </思考> 乙 → 正文 / 思考 / 正文（三段，顺序不乱）', () => {
    expect(piecesOf(`甲${OPEN}想${CLOSE}乙`)).toEqual(['content:甲', 'reason:想', 'content:乙']);
  });

  it('两段思考夹三段正文 → 五段，顺序完全按出现位置', () => {
    expect(piecesOf(`甲${OPEN}想1${CLOSE}乙${OPEN}想2${CLOSE}丙`))
      .toEqual(['content:甲', 'reason:想1', 'content:乙', 'reason:想2', 'content:丙']);
  });

  it('标签被 SSE 分片切断也不改变顺序', () => {
    const sp = thinking.createReasoningSplitter();
    const out = [];
    for (const chunk of ['甲<thi', 'nking>想', '</thin', 'king>乙']) out.push(...sp.push(chunk).pieces);
    out.push(...sp.flush().pieces);
    expect(out.map((p) => `${p.kind}:${p.text}`)).toEqual(['content:甲', 'reason:想', 'content:乙']);
  });

  it('思考到流结束时还没闭合：flush 把暂存的尾巴按思考落地', () => {
    const sp = thinking.createReasoningSplitter();
    const a = sp.push(`甲${OPEN}想到一半`);
    const b = sp.flush();
    expect([...a.pieces, ...b.pieces].map((p) => `${p.kind}:${p.text}`))
      .toEqual(['content:甲', 'reason:想到一半']);
  });

  it('没有标签的普通正文仍然只有一段', () => {
    expect(piecesOf('就是一段普普通通的正文')).toEqual(['content:就是一段普普通通的正文']);
  });

  it('聚合串与分段同时给出（入库/用量估算还在用聚合串）', () => {
    const sp = thinking.createReasoningSplitter();
    const a = sp.push(`甲${OPEN}想${CLOSE}乙`);
    expect(a.content).toBe('甲乙');
    expect(a.reasoning).toBe('想');
  });

  it('stripInlineReasoning 行为不变（整段清洗仍走聚合串）', () => {
    const r = thinking.stripInlineReasoning(`甲${OPEN}想${CLOSE}乙`);
    expect(r.content).toBe('甲乙');
    expect(r.reasoning).toBe('想');
  });
});
