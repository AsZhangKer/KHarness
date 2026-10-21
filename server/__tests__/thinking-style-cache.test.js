/**
 * 思考参数样式的「记住」逻辑（第一百一十八轮修的线上 bug）。
 *
 * 现场：每个新会话开头刷一屏
 *   [deepseek-v4.1-flash-1017] 思考参数样式 reasoning_effort 不受支持，尝试 thinking{type:enabled}…
 *   …（七条）…
 *   [deepseek-v4.1-flash-1017] 思考参数均不受支持，按模型默认模式继续…
 *   [deepseek-v4.1-flash-1017] 上游要求回传思考字段，已补齐 0 处后重试…
 *   …（再来一遍七条）…
 *
 * 两个成因：
 *   ① cache 里写的是 -1（全都不支持），读的时候却要求 `remembered >= 0` 才采用 ——
 *      于是「全不支持」永远不生效，每次请求都从第一种开始重试七种；
 *      cache 还只在内存里，重启又归零。
 *   ② reasoning_content 自愈第一次只补带 tool_calls 的 assistant，补完 0 处也照样重发 ——
 *      白跑一轮。
 * 这里锁 ①：resolveThinkingVariant 的三种结论，以及持久化字段的读回。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const nodeRequire = createRequire(import.meta.url);
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-think-cache-'));
process.env.KH_DATA_DIR = T;

let ctx;
let thinking;

beforeAll(() => {
  nodeRequire('../database').initDatabase();
  ctx = nodeRequire('../routes/ai')._internal;
  thinking = nodeRequire('../utils/thinking');
});

const EN = () => thinking.variantsFor({ mode: 'on', effort: 'medium' });
const norm = { mode: 'on', effort: 'medium' };

describe('思考参数样式的记忆', () => {
  it('没试过：undefined（从第一种开始试）', () => {
    const variants = EN();
    expect(ctx.resolveThinkingVariant({ thinking_style: '' }, norm, variants, 'k1', new Map())).toBeUndefined();
  });

  it('内存 cache 里的 -1 必须生效（这是 118 轮修的那条）', () => {
    const variants = EN();
    const cache = new Map([['k1', -1]]);
    expect(ctx.resolveThinkingVariant({ thinking_style: '' }, norm, variants, 'k1', cache)).toBe(-1);
  });

  it('持久化 unsupported：重启后也不再七连试', () => {
    const variants = EN();
    expect(ctx.resolveThinkingVariant({ thinking_style: 'unsupported' }, norm, variants, 'k2', new Map())).toBe(-1);
  });

  it('持久化的成功样式能读回序号', () => {
    const variants = EN();
    expect(ctx.resolveThinkingVariant({ thinking_style: 'on:thinking{type:enabled}' }, norm, variants, 'k3', new Map())).toBe(1);
    expect(ctx.resolveThinkingVariant({ thinking_style: 'on:reasoning_effort' }, norm, variants, 'k4', new Map())).toBe(0);
  });

  it('mode 不匹配的持久化样式不采用（off 的样式表跟 on 不同）', () => {
    const variants = EN();
    expect(ctx.resolveThinkingVariant({ thinking_style: 'off:thinking{type:disabled}' }, norm, variants, 'k5', new Map())).toBeUndefined();
  });

  it('内存 cache 优先于持久化字段', () => {
    const variants = EN();
    const cache = new Map([['k6', 2]]);
    expect(ctx.resolveThinkingVariant({ thinking_style: 'unsupported' }, norm, variants, 'k6', cache)).toBe(2);
  });
});
