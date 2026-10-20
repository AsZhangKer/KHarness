/**
 * AGENTS.md 占位符（{cwd} {time} {date} {os}）。
 *
 * 主人要的是「在编辑系统提示词时能写这几个记号，注入时换成当下的真值」。
 * 这里钉住四件事，都是后来者最容易无意改坏的：
 *
 *   ① 展开发生在**注入时**，不在读写时 —— 所以 read() 出来的仍是原文（编辑器要看到记号本身），
 *      promptBlock() 出来的才是真值。若有人把 renderVars 挪进 read()/write()，
 *      文件会被"定格"成第一次打开那天的路径与时间，第 1、4 条测试就会红。
 *   ② 只认白名单里那四个键：别的 {xxx} 一个字都不许动（用户会写 JSON 示例、写模板语法）。
 *   ③ {{cwd}} 是"我要一个字面量的 {cwd}"，必须还原成 {cwd}，不能连着两层都被吃掉。
 *   ④ 取不到值（调用方没给 cwd）时保留占位符原文，绝不换成空串 ——
 *      「工作目录是 」看着像正经信息，其实是坏的，比留着记号更糟。
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);
const agentsmd = nodeRequire('../utils/agentsmd.js');

const VARS = {
  cwd: 'D:\\proj\\demo',
  time: '09:41:07',
  date: '2026/10/16',
  os: 'Windows（win32 · 10.0.26100 · x64）',
};

describe('agentsmd 占位符', () => {
  it('四个白名单键都展开成真值', () => {
    const out = agentsmd.renderVars('目录 {cwd}｜时间 {time}｜日期 {date}｜系统 {os}', VARS);
    expect(out).toBe(`目录 ${VARS.cwd}｜时间 ${VARS.time}｜日期 ${VARS.date}｜系统 ${VARS.os}`);
    expect(out).not.toMatch(/\{(cwd|time|date|os)\}/);
  });

  it('同一段里重复出现也全部展开', () => {
    expect(agentsmd.renderVars('{cwd} / {cwd}', VARS)).toBe(`${VARS.cwd} / ${VARS.cwd}`);
  });

  it('白名单外的 {xxx} 一个字都不动（不掺和用户的 JSON 示例与模板语法）', () => {
    const raw = '{"a": 1} 与 {foo} 与 {cwdx} 与 裸的 { 和 }';
    expect(agentsmd.renderVars(raw, VARS)).toBe(raw);
  });

  it('{{cwd}} 是转义：还原成字面量的 {cwd}，不被当占位符吃掉', () => {
    expect(agentsmd.renderVars('写成 {{cwd}} 就能让模型看到这个记号本身', VARS)).toBe('写成 {cwd} 就能让模型看到这个记号本身');
    // 转义与真展开在同一段里并存时，各自归位
    expect(agentsmd.renderVars('{{os}} 是记号，{os} 是值', VARS)).toBe(`{os} 是记号，${VARS.os} 是值`);
  });

  it('取不到值（缺 cwd）时保留原文，绝不换成空串', () => {
    const out = agentsmd.renderVars('目录 {cwd}，时间 {time}', { time: '01:02:03' });
    expect(out).toBe('目录 {cwd}，时间 01:02:03');
  });

  it('没有花括号的文本原样返回（快速路径不改变内容）', () => {
    const raw = '# 项目背景\n\n不要硬编码密钥\n';
    expect(agentsmd.renderVars(raw, VARS)).toBe(raw);
  });

  it('promptBlock 展开内容，但**不改**磁盘上那份原文', () => {
    const files = [{ scope: '全局', path: 'C:\\Users\\x\\.kharness\\AGENTS.md', content: 'cwd={cwd}\n{{os}} 保持字面\n{foo} 不动' }];
    const out = agentsmd.promptBlock(files, VARS);
    expect(out).toContain(`cwd=${VARS.cwd}`);
    expect(out).toContain('{os} 保持字面');
    expect(out).toContain('{foo} 不动');
    expect(out).not.toContain('{cwd}');
    // 传进来的那两份 content 必须没被就地改写（同一个数组对象后面还要给别的调用方用）
    expect(files[0].content).toContain('{cwd}');
  });

  it('promptBlock 没给 vars 时不炸，占位符原样留着', () => {
    const out = agentsmd.promptBlock([{ scope: '全局', path: 'x', content: 'cwd={cwd}' }]);
    expect(out).toContain('cwd={cwd}');
  });

  it('promptVars 产出的值形状对（date=yyyy/mm/dd、time=hh:mm:ss、os 带平台）', () => {
    const v = agentsmd.promptVars('D:\\x', new Date(2026, 9, 16, 9, 41, 7));
    expect(v.date).toBe('2026/10/16');
    expect(v.time).toBe('09:41:07');
    expect(v.cwd).toBe('D:\\x');
    expect(v.os).toContain(process.platform);
    // 个位数月份/日期/时分秒都要补零（01 不是 1）
    const v2 = agentsmd.promptVars('', new Date(2026, 0, 5, 3, 4, 5));
    expect(v2.date).toBe('2026/01/05');
    expect(v2.time).toBe('03:04:05');
  });

  it('VAR_KEYS 与前端 AgentsEditor 的按钮清单同源（少一个就等于按钮插进去不展开）', () => {
    expect(agentsmd.VAR_KEYS).toEqual(['cwd', 'time', 'date', 'os']);
  });
});
