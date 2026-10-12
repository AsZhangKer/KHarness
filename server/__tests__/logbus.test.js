/**
 * 日志总线与「开发版才有的调试通道」（第六十四轮）。
 *
 * 这里盯的是两件最容易静默坏掉的事：
 * ① 劫持 console 之后原输出还在不在（外壳 desktop.log 全靠 stdout，钩子把它吞了就是丢历史）；
 * ② 正式版判定为 packaged 时，调试通道必须整个关死 —— 这套服务没有鉴权，
 *    多一条能读走全部运行日志（里面有真实上游响应体）的路就多一分风险。
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const logbus = require('../utils/logbus');
const build = require('../utils/build');

describe('logbus 环形缓冲', () => {
  it('记满 MAX 条后只丢最老的，条数封顶', () => {
    logbus.clear();
    for (let i = 1; i <= 3000; i++) logbus.push({ level: 'info', tag: 'op', text: `第 ${i} 行` });
    expect(logbus.size()).toBe(logbus.MAX);
    const snap = logbus.snapshot();
    expect(snap[0].text).toBe(`第 ${3000 - logbus.MAX + 1} 行`);
    expect(snap[snap.length - 1].text).toBe('第 3000 行');
  });

  it('超长行截到 800 字，绝不把整块响应体塞进内存', () => {
    logbus.clear();
    const line = logbus.push({ level: 'error', tag: 'up', text: 'x'.repeat(5000) });
    expect(line.text.length).toBe(800);
  });

  it('劫持 console 之后原始输出照旧打出来（外壳那份 desktop.log 不能断）', () => {
    logbus.clear();
    const orig = console.log;
    const spy = vi.fn();
    console.log = spy;                       // 只替这一条，测完换回来
    logbus.hookConsole();
    const patched = console.log;
    patched('[mcp] 已连接', { tools: 3 });
    console.log = orig;
    expect(spy).toHaveBeenCalledTimes(1);    // 原函数被调了一次，没被吞
    const text = logbus.snapshot().map((l) => l.text).join('');
    expect(text).toContain('[mcp] 已连接');
    expect(text).toContain('"tools":3');     // 多参数拼一行，不是只取第一个
  });

  it('上游行按状态码分级，且只留 host 不带路径与查询串', () => {
    logbus.clear();
    const a = logbus.upstream({ model: 'ag-3', url: 'https://api.example.com/v1/chat/completions?key=SECRET', status: 429, ms: 1234 });
    const b = logbus.upstream({ model: 'ag-3', url: 'https://api.example.com/v1/chat', ms: 50, error: 'fetch failed｜ECONNRESET' });
    expect(a.level).toBe('warn');
    expect(a.text).toContain('HTTP 429');
    expect(a.text).not.toContain('SECRET');
    expect(a.text).not.toContain('chat/completions');
    expect(a.text).toContain('api.example.com');
    expect(b.level).toBe('error');
    expect(b.text).toContain('ECONNRESET');
  });

  it('订阅者能立刻收到新行，退订后不再收到', () => {
    logbus.clear();
    const got = [];
    const off = logbus.subscribe((l) => got.push(l.text), 5);
    logbus.push({ tag: 'op', text: '实时的一条' });
    expect(got).toContain('实时的一条');
    off();
    logbus.push({ tag: 'op', text: '退订后的一条' });
    expect(got).not.toContain('退订后的一条');
  });
});

describe('开发版判定', () => {
  const VER = path.join(__dirname, '..', 'version.json');

  it(' KH_APP_PACKAGED=1 才算正式版，开发版版本号结尾带 d', () => {
    const saved = { ...process.env };
    const hadFile = fs.existsSync(VER);
    const bak = hadFile ? fs.readFileSync(VER) : null;
    try {
      fs.rmSync(VER, { force: true });          // 这段验的是「没有载荷标记时外壳说了算」
      process.env.KH_APP_VERSION = '9.9.9';
      delete process.env.KH_APP_PACKAGED;
      let r = build.resolve();
      expect(r.packaged).toBe(false);
      expect(r.display).toBe('v9.9.9d');
      expect(build.isDev()).toBe(true);
      process.env.KH_APP_PACKAGED = '1';
      r = build.resolve();
      expect(r.packaged).toBe(true);
      expect(r.display).toBe('v9.9.9');       // 正式版去掉 d
      expect(build.isDev()).toBe(false);
    } finally {
      if (bak) fs.writeFileSync(VER, bak);
      for (const k of ['KH_APP_VERSION', 'KH_APP_PACKAGED']) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
    }
  });

  it('载荷里那份 version.json 压过外壳：装机版自用目录才能是开发版', () => {
    const saved = { ...process.env };
    const hadFile = fs.existsSync(VER);
    const bak = hadFile ? fs.readFileSync(VER) : null;
    try {
      // 外壳照旧只会喊「我是 packaged」（win-unpacked 和安装包在它眼里一模一样）
      process.env.KH_APP_VERSION = '9.9.9';
      process.env.KH_APP_PACKAGED = '1';
      fs.writeFileSync(VER, JSON.stringify({ version: '9.9.9', packaged: false }));
      let r = build.resolve();
      expect(r.packaged).toBe(false);              // pack-prep --dev 说了算
      expect(r.display).toBe('v9.9.9d');
      expect(build.isDev()).toBe(true);
      fs.writeFileSync(VER, JSON.stringify({ version: '9.9.9', packaged: true }));
      r = build.resolve();
      expect(r.packaged).toBe(true);               // 默认出包仍是正式版
      expect(r.display).toBe('v9.9.9');
      process.env.KH_APP_PACKAGED = '0';
      r = build.resolve();
      expect(r.packaged).toBe(true);               // env 说 0 也推翻不了正式版标记
    } finally {
      if (bak) fs.writeFileSync(VER, bak); else fs.rmSync(VER, { force: true });
      for (const k of ['KH_APP_VERSION', 'KH_APP_PACKAGED']) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
    }
  });
});

