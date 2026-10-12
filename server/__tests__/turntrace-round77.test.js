/**
 * #267 中断回合的工具轨迹清单。
 *
 * 为什么要有这份清单：跨轮重建上文只 `SELECT role, content`，steps_json 落了库也没有第二个读者；
 * 而"跑了十几步工具然后上游 502、一个字没吐"的那一轮，以前整条被 `if (fullReply.trim())` 卡住不入库
 * ⇒ 下一轮完全不知道刚才读过哪个文件、改过哪张表。
 * 清单只给中断的回合，且刻意压得很小（一行一步、参数与结果各截一段、末尾单列动过的文件）。
 */
import { describe, it, expect } from 'vitest';

const { traceDigest, DIGEST_MAX_STEPS, DIGEST_MAX_CHARS } = require('../utils/turntrace');

const pair = (name, args, extra = {}) => [
  { type: 'tool', name, args },
  { type: 'result', name, output: extra.output ?? '正常返回', error: extra.error ?? null, open: !!extra.open },
];

describe('中断回合的工具轨迹清单', () => {
  it('一步一行：工具名 + 参数摘要 + 结果摘要，序号连着排', () => {
    const steps = [...pair('grep', { pattern: 'fetchUpstream' }), ...pair('read_file', { path: 'server/routes/ai.js' }, { output: '第 4965 行起' })];
    const text = traceDigest(steps);
    expect(text).toContain('1. grep {"pattern":"fetchUpstream"} → 正常返回');
    expect(text).toContain('2. read_file {"path":"server/routes/ai.js"} → 第 4965 行起');
    expect(text.split('\n').filter((l) => /^\d+\./.test(l))).toHaveLength(2);
  });

  it('报错与没执行完的要标出来（下一轮才知道那步不能当作已完成）', () => {
    const steps = [
      ...pair('run_command', { command: 'npm run build' }, { error: 'exit code 1' }),
      { type: 'tool', name: 'edit_file', args: { path: 'a.js' } },
      { type: 'result', name: 'edit_file', output: null, error: null, open: true },
    ];
    const text = traceDigest(steps);
    expect(text).toContain('→ 失败：exit code 1');
    expect(text).toContain('（发起了，没执行完）');
  });

  it('末尾单列本轮动过的文件；只读工具不进那份清单', () => {
    const steps = [
      ...pair('read_file', { path: 'x.js' }),
      ...pair('edit_file', { path: 'y.js' }, { output: '已改' }),
      ...pair('write_file', { path: 'z.js' }, { output: '已写' }),
    ];
    const text = traceDigest(steps);
    expect(text).toContain('本轮动过的文件：y.js、z.js');
    expect(text).not.toMatch(/动过的文件：[^\n]*x\.js/);
  });

  it('note / text / compress 不算一步（以前 note 会混进步数里虚报）', () => {
    const steps = [
      { type: 'note', message: '429 限流，重试中' },
      { type: 'text', text: '我先看一眼' },
      { type: 'compress', phase: 'done' },
      ...pair('grep', { pattern: 'a' }),
    ];
    const text = traceDigest(steps);
    expect(text.split('\n').filter((l) => /^\d+\./.test(l))).toHaveLength(1);
    expect(text).not.toContain('限流');
  });

  it('超长输出与多行参数都压成一行并截断（清单是提示词，不是转储）', () => {
    const steps = [ ...pair('grep', { pattern: 'x' }, { output: `第一行\n第二行 ${'很'.repeat(500)}` }) ];
    const text = traceDigest(steps);
    const line = text.split('\n').find((l) => l.startsWith('1.'));
    expect(line).not.toContain('\n');
    expect(line.length).toBeLessThan(400);
    expect(line.endsWith('…')).toBe(true);
  });

  it('一步都没有时返回空串（调用方据此什么都不追加）', () => {
    expect(traceDigest([])).toBe('');
    expect(traceDigest([{ type: 'note', message: '只有过程提示' }])).toBe('');
    expect(traceDigest(null)).toBe('');
  });

  it('步数有上限：40 步之后收口，并说明还有更多', () => {
    const steps = [];
    for (let i = 0; i < DIGEST_MAX_STEPS + 30; i++) steps.push(...pair('read_file', { path: `f${i}.js` }, { output: 'ok' }));
    const text = traceDigest(steps);
    expect(text.split('\n').filter((l) => /^\d+\./.test(l))).toHaveLength(DIGEST_MAX_STEPS);
    expect(text).toContain('还有更多步骤未列出');
  });

  it('整段有硬上限：再长也不越过 8000 字（它是提示词的一部分，不是转储）', () => {
    const steps = [];
    for (let i = 0; i < 200; i++) steps.push(...pair('read_file', { path: `f${i}.js` }, { output: 'x'.repeat(300) }));
    const text = traceDigest(steps);
    expect(text.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    expect(text.endsWith('…（清单过长已截断）')).toBe(true);
  });

  it('标清「不是用户说的话」：这份清单是系统补记的，别让模型当成用户的指令', () => {
    const text = traceDigest([...pair('grep', { pattern: 'a' })]);
    expect(text).toMatch(/不是用户说的话/);
    expect(text).toMatch(/本轮未完成/);
  });
});
