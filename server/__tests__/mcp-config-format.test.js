/**
 * MCP 表单解析：宽松输入、明确报错，**绝不静默改写**。
 *
 * 「格式不规范」的来由是三套规则并存：前端 args 按行拆、后端字符串形态按空白拆
 * （会把 `C:\Program Files\x` 拆碎）、而官方 mcp.json 的写法是「JSON 数组 或 空格分隔」。
 * 现在只有一份实现（server/utils/mcp.js），且解析不了就报错 —— 以前是静默变 [] / {}，
 * 表现成「工具起不来但完全看不出为什么」。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);
let tmpDir;
let mcp;

beforeAll(() => {
  // 数据目录要在 require 之前换掉：桌面外壳会把 KH_DATA_DIR 指向主人的真实数据目录
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-mcp-'));
  process.env.KH_DATA_DIR = tmpDir;
  mcp = nodeRequire('../utils/mcp');
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* 清不掉不影响结论 */ }
});

describe('parseArgsInput', () => {
  it('JSON 数组', () => {
    expect(mcp.parseArgsInput('["-y","server-filesystem","C:\\\\dir"]'))
      .toEqual(['-y', 'server-filesystem', 'C:\\dir']);
  });

  it('一行一个参数（推荐写法）：行内空格原样保留', () => {
    expect(mcp.parseArgsInput('-y\n@modelcontextprotocol/server-filesystem\nC:\\Program Files\\mcp'))
      .toEqual(['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Program Files\\mcp']);
  });

  it('单行空格分隔（官方文档也这么写）', () => {
    expect(mcp.parseArgsInput('-y server-filesystem /tmp/dir'))
      .toEqual(['-y', 'server-filesystem', '/tmp/dir']);
  });

  it('单行里含空格的参数用引号括起来', () => {
    expect(mcp.parseArgsInput('-y server-filesystem "C:\\Program Files\\mcp"'))
      .toEqual(['-y', 'server-filesystem', 'C:\\Program Files\\mcp']);
  });

  it('以 [ 开头的普通参数不再被误判成 JSON（旧实现会直接抛）', () => {
    expect(mcp.parseArgsInput('[abc]*.txt')).toEqual(['[abc]*.txt']);
  });

  it('说是 JSON 数组却写坏了 → 明确报错（不静默变空数组）', () => {
    expect(() => mcp.parseArgsInput('["a", ]')).toThrow(/写法有误/);
  });

  it('传数组直接用，且每项转字符串', () => {
    expect(mcp.parseArgsInput(['a', 1, true])).toEqual(['a', '1', 'true']);
  });

  it('空输入 → 空数组', () => {
    expect(mcp.parseArgsInput('')).toEqual([]);
    expect(mcp.parseArgsInput(null)).toEqual([]);
    expect(mcp.parseArgsInput('   \n  ')).toEqual([]);
  });
});

describe('parseObjInput（env / headers）', () => {
  it('JSON 对象', () => {
    expect(mcp.parseObjInput('{"API_KEY":"sk-1"}', 'env')).toEqual({ API_KEY: 'sk-1' });
  });

  it('每行一条 KEY=VALUE（大家按 .env 的习惯写，旧实现会静默吃成 {}）', () => {
    expect(mcp.parseObjInput('API_KEY=sk-1\nBASE_URL=http://x\ny=2', 'env'))
      .toEqual({ API_KEY: 'sk-1', BASE_URL: 'http://x', y: '2' });
  });

  it('注释行与空行忽略', () => {
    expect(mcp.parseObjInput('# 说明\n\nA=1', 'env')).toEqual({ A: '1' });
  });

  it('值里的 = 不算分隔（只按第一个 = 切）', () => {
    expect(mcp.parseObjInput('TOKEN=a=b=c', 'env')).toEqual({ TOKEN: 'a=b=c' });
  });

  it('值带引号时去引号', () => {
    expect(mcp.parseObjInput('A="has space"', 'env')).toEqual({ A: 'has space' });
  });

  it('数组 → 报错（旧实现静默变 {}）', () => {
    expect(() => mcp.parseObjInput(['A=1'], 'env')).toThrow(/不是数组/);
  });

  it('既不是 JSON 也不是 KEY=VALUE 的行 → 报错并指出那一行', () => {
    expect(() => mcp.parseObjInput('这不是键值对', 'env')).toThrow(/KEY=VALUE/);
  });

  it('值一律转字符串（process.env 只认字符串）', () => {
    expect(mcp.parseObjInput({ A: 1, B: null }, 'env')).toEqual({ A: '1', B: '' });
  });
});

describe('normalizeTransport', () => {
  it('空 → stdio（唯一允许的默认值）', () => {
    expect(mcp.normalizeTransport({})).toBe('stdio');
  });

  it('认官方 mcp.json 的 type 字段（旧实现只认 transport）', () => {
    expect(mcp.normalizeTransport({ type: 'http' })).toBe('http');
    expect(mcp.normalizeTransport({ type: 'stdio' })).toBe('stdio');
  });

  it('streamable-http 等写法归一到 http', () => {
    expect(mcp.normalizeTransport({ transport: 'Streamable-HTTP' })).toBe('http');
    expect(mcp.normalizeTransport({ transport: 'streamable_http' })).toBe('http');
  });

  it('非法值报错，不再静默变 stdio（那样会报「stdio 必须填 command」，看不出真因）', () => {
    const r = mcp.normalizeTransport({ transport: 'sse' });
    expect(r.error).toMatch(/不支持的 transport：sse/);
  });
});

describe('normalizeBody', () => {
  const base = { name: 'demo', transport: 'stdio', command: 'npx' };

  it('args 三种写法都能存成同一个归一结果', () => {
    const a = mcp.normalizeBody({ ...base, args: '-y srv /tmp' });
    const b = mcp.normalizeBody({ ...base, args: '-y\nsrv\n/tmp' });
    const c = mcp.normalizeBody({ ...base, args: ['-y', 'srv', '/tmp'] });
    expect(a.args).toBe(b.args);
    expect(b.args).toBe(c.args);
    expect(JSON.parse(a.args)).toEqual(['-y', 'srv', '/tmp']);
  });

  it('env 用 KEY=VALUE 写也能存进对象（以前会被吃成 {}）', () => {
    const v = mcp.normalizeBody({ ...base, env: 'A=1\nB=2' });
    expect(JSON.parse(v.env)).toEqual({ A: '1', B: '2' });
  });

  it('args 超过 24 项报错，不再静默截断', () => {
    const many = Array.from({ length: 25 }, (_, i) => 'a' + i);
    const v = mcp.normalizeBody({ ...base, args: many });
    expect(v.error).toMatch(/最多 24 项/);
  });

  it('解析失败时带回明确原因，而不是存下一个空配置', () => {
    const v = mcp.normalizeBody({ ...base, args: '["bad", ]' });
    expect(v.error).toMatch(/写法有误/);
  });

  it('名称必填', () => {
    expect(mcp.normalizeBody({ ...base, name: '  ' }).error).toMatch(/名称/);
  });
});
