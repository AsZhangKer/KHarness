/**
 * 「带 tool_calls 的 assistant 必须回传 reasoning_content」契约测试。
 *
 * 背景（他 2026-10-16 报的那个 400）：
 *   HTTP 400 The `reasoning_content` in the thinking mode must be passed back to the API.
 * 实测结论（拿 DeepSeek 官方 key 打过 12 个探针，见 protocols.js 注释）：
 *   · 只要 assistant 带了 tool_calls，就必须同时有 reasoning_content **字符串**；
 *     缺失或 null 一律 400，空串 '' 合法；
 *   · 同一包里每一条带 tool_calls 的都要有，漏一条整包被拒；
 *   · 纯文本 assistant（不带 tool_calls）不需要 —— 所以跨轮历史不必带思考。
 * 这里把这几条钉死，并加一条源码守卫防止将来又漏。
 */
import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

const protocols = nodeRequire('../utils/protocols');

describe('assistantToolCallMessage', () => {
  test('带 tool_calls 时一定给 reasoning_content 字符串（有思考就用真的）', () => {
    const calls = [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }];
    const m = protocols.assistantToolCallMessage('我来看一下。', calls, '用户要我读文件');
    expect(m.role).toBe('assistant');
    expect(m.content).toBe('我来看一下。');
    expect(m.reasoning_content).toBe('用户要我读文件');
    expect(m.tool_calls).toBe(calls);
  });

  test('这一轮没有思考时给空串，而不是 undefined/null（null 会被上游拒）', () => {
    const calls = [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }];
    for (const r of [undefined, null, '', 0]) {
      const m = protocols.assistantToolCallMessage('', calls, r);
      expect(typeof m.reasoning_content).toBe('string');
      expect(m.reasoning_content).toBe(r === 0 ? '0' : '');
    }
  });

  test('content 为空时补空串（上游不接受 null 正文）', () => {
    const m = protocols.assistantToolCallMessage(null, [], undefined);
    expect(m.content).toBe('');
  });
});

describe('isReasoningBackError', () => {
  test('认得上游那条原文', () => {
    const body = JSON.stringify({ error: { message: 'The `reasoning_content` in the thinking mode must be passed back to the API. (request_id: 027dc67b)' } });
    expect(protocols.isReasoningBackError(400, body)).toBe(true);
  });

  test('别把无关 400 认成这一类（避免乱重试）', () => {
    expect(protocols.isReasoningBackError(400, '{"error":{"message":"invalid api key"}}')).toBe(false);
    expect(protocols.isReasoningBackError(400, '{"error":{"message":"This model\'s maximum context length is 65536 tokens"}}')).toBe(false);
    expect(protocols.isReasoningBackError(500, 'reasoning_content must be passed back')).toBe(false);
  });
});

describe('ensureReasoningBack（400 兜底补齐）', () => {
  test('给缺字段的补齐，已带的原样保留', () => {
    const list = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'a' }] },
      { role: 'tool', tool_call_id: 'a', content: '结果' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'b' }], reasoning_content: '已有的思考' },
      { role: 'assistant', content: '纯文本，不需要这个字段' },
    ];
    const fixed = protocols.ensureReasoningBack(list);
    expect(fixed).toBe(1);
    expect(list[1].reasoning_content).toBe('');
    expect(list[3].reasoning_content).toBe('已有的思考');
    // 纯文本那条不该被动
    expect('reasoning_content' in list[4]).toBe(false);
    // 用户/tool 消息不碰
    expect('reasoning_content' in list[0]).toBe(false);
    expect('reasoning_content' in list[2]).toBe(false);
  });

  test('null 也算缺（上游只认字符串）', () => {
    const list = [{ role: 'assistant', content: '', tool_calls: [{ id: 'a' }], reasoning_content: null }];
    expect(protocols.ensureReasoningBack(list)).toBe(1);
    expect(list[0].reasoning_content).toBe('');
  });
});

describe('ensureReasoningBack({ all: true })——少数网关连纯文本 assistant 也要这个字段', () => {
  test('all 模式下纯文本 assistant 也补上空串', () => {
    const list = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '纯文本回复' },
      { role: 'tool', tool_call_id: 'a', content: '结果' },
    ];
    expect(protocols.ensureReasoningBack(list, { all: true })).toBe(1);
    expect(list[1].reasoning_content).toBe('');
    // 用户 / tool 消息永远不碰
    expect('reasoning_content' in list[0]).toBe(false);
    expect('reasoning_content' in list[2]).toBe(false);
  });
});

describe('isReasoningBackError 的措辞兼容（换网关不能失效）', () => {
  test('认得各种写法', () => {
    const bodies = [
      '{"error":{"message":"The `reasoning_content` in the thinking mode must be passed back to the API."}}',
      '{"error":{"message":"reasoning_content is required for assistant messages with tool_calls"}}',
      '{"error":{"message":"missing reasoning_content"}}',
      '{"error":{"message":"思考模式下需要传回 reasoning_content"}}',
      '{"error":{"message":"reasoning-content expected"}}',
    ];
    for (const b of bodies) expect(protocols.isReasoningBackError(400, b)).toBe(true);
    expect(protocols.isReasoningBackError(422, 'reasoning_content missing')).toBe(true);
  });

  test('不误伤：只认客户端 4xx，且必须点名 reasoning_content', () => {
    expect(protocols.isReasoningBackError(500, 'reasoning_content broken')).toBe(false);
    expect(protocols.isReasoningBackError(400, '{"error":{"message":"invalid api key"}}')).toBe(false);
  });
});

/**
 * ★ 核心守卫：buildChatRequest 是「每一次上游请求都必然经过」的唯一出口。
 * 只要它补齐了，任何路径（主循环 / 侧栏 / 子智能体 / 托管 / 压缩摘要）都不可能再漏。
 */
describe('buildChatRequest 统一出口：发出去之前一定补齐', () => {
  const provider = { api_style: 'openai', base_url: 'https://example.com/v1', api_key: 'k' };

  test('漏了字段的带 tool_calls 消息会在最后一刻补上（调用方不用管）', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '读一下文件' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'a', content: '内容' },
    ];
    const req = protocols.buildChatRequest(provider, { model: 'm', messages, stream: false });
    const sent = req.body.messages;
    expect(sent[2].reasoning_content).toBe('');
    expect('reasoning_content' in sent[3]).toBe(false);
    expect('reasoning_content' in sent[1]).toBe(false);
  });

  test('已有的真实思考不会被覆盖', () => {
    const messages = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'a' }], reasoning_content: '真的思考' },
    ];
    const req = protocols.buildChatRequest(provider, { model: 'm', messages, stream: false });
    expect(req.body.messages[0].reasoning_content).toBe('真的思考');
  });

  test('custom 协议同样补齐（多数自定义网关就是 OpenAI 兼容层）', () => {
    const p = { api_style: 'custom', base_url: 'https://example.com/v1', api_key: 'k', custom: { request_url: '/chat/completions' } };
    const messages = [{ role: 'assistant', content: '', tool_calls: [{ id: 'a' }] }];
    const req = protocols.buildChatRequest(p, { model: 'm', messages, stream: false });
    expect(req.body.messages[0].reasoning_content).toBe('');
  });

  test('anthropic 协议不动它（tool_use/tool_result 不吃这个字段）', () => {
    const p = { api_style: 'anthropic', base_url: 'https://example.com', api_key: 'k' };
    const messages = [{ role: 'assistant', content: 'x' }];
    const req = protocols.buildChatRequest(p, { model: 'm', messages, stream: false });
    const body = req.body;
    expect(JSON.stringify(body)).not.toContain('reasoning_content');
  });
});

describe('源码守卫：所有「要发给上游的带 tool_calls 的 assistant」都带了 reasoning_content', () => {
  // 命中 push({...tool_calls...}) 这种对象字面量（不跨两层嵌套，够用且不易误报）
  const RE = /(?:messages|upstreamMsgs)\s*\.push\(\{(?:[^{}]|\{[^{}]*\})*?tool_calls\s*:/gs;

  test.each([
    'routes/ai.js',
    'utils/subagent.js',
    'utils/sidebar.js',
    'utils/orchestrator.js',
  ])('%s 里每一处 tool_calls 推送都有 reasoning_content', (rel) => {
    const src = fs.readFileSync(path.join(HERE, '..', rel), 'utf8');
    const hits = src.match(RE) || [];
    const missing = hits.filter((h) => !/reasoning_content/.test(h));
    expect(missing).toEqual([]);
  });
});
