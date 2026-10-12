/**
 * 后台任务的会话归属（第七十四轮 ①：「后台任务还是串会话的，修一下，保证按照会话隔离」）。
 *
 * 病灶是整张任务表全局共用：A 会话起的 dev server 会出现在 B 会话的右栏「后台」里，
 * B 还能直接 background_kill 把它杀掉 —— 串的不只是界面，还有「读它的日志」和「杀它的进程」两样权限。
 * 这里用真模块 + 假任务条目（不 spawn 任何进程）量 owned / visibleFor / status / kill / list，
 * 再用接线断言确认 REST（右栏）与工具（模型侧）两条路都把 chatId 传了进去。
 *
 * 一条特别要紧：跨会话 kill 必须**在碰进程之前**就被挡下，所以断言里查了 killed 标记。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const bg = require('../utils/bg.js');

const live = [];

/** 造一条假任务塞进真表里：字段照 start() 建出来的形状，但 child/stream 都是 null，绝不会动到进程 */
function put(id, chatId, over = {}) {
  const t = {
    id, command: `node server/index.js`, cwd: 'D:\\proj', pid: 424242,
    state: 'running', exitCode: null, signal: null,
    startedAt: Date.now(), endedAt: 0, log: `C:\\tmp\\kh-bg\\${id}.log`,
    tail: ['第一行输出', '第二行输出'], bytes: 28, stream: null, child: null, killed: false,
    chatId,
    ...over,
  };
  bg.tasks.set(id, t);
  live.push(id);
  return t;
}

afterEach(() => {
  for (const id of live) {
    const t = bg.tasks.get(id);
    if (t) t.killed = false;
    bg.tasks.delete(id);
  }
  live.length = 0;
});

describe('会话归属判据 owned / visibleFor', () => {
  it('有归属的只得起它的会话看得见', () => {
    const mine = put('bg-t-own1', 7);
    const other = put('bg-t-own2', 8);
    expect(bg.owned(mine, 7)).toBe(true);
    expect(bg.owned(mine, 8)).toBe(false);
    expect(bg.owned(other, 7)).toBe(false);
    expect(bg.visibleFor(7).map((t) => t.id)).toEqual(['bg-t-own1']);
  });

  it('无归属（设置页「试跑」那类没带会话）= 公共，谁都看得见，别把试跑挡死', () => {
    const pub = put('bg-t-pub', null);
    expect(bg.owned(pub, 7)).toBe(true);
    expect(bg.visibleFor(7).map((t) => t.id)).toContain('bg-t-pub');
  });

  it('查询侧没有会话上下文时不过滤（chat_id 为空 = 全表）', () => {
    put('bg-t-a', 7);
    put('bg-t-b', 8);
    expect(bg.visibleFor(null).length).toBe(2);
    expect(bg.visibleFor(undefined).length).toBe(2);
  });

  it('归属是数字口径：SSE/HTTP 传来的字符串 "7" 不能把会话 7 的任务判成别人的', () => {
    const t = put('bg-t-str', 7);
    expect(bg.owned(t, '7')).toBe(true);
  });
});

describe('status / kill / list 都按会话收口', () => {
  it('跨会话查状态读不到日志，本会话查得到', () => {
    put('bg-t-s1', 7);
    put('bg-t-s2', 8);
    const cross = bg.status('bg-t-s2', 10, 7);
    expect(cross.error).toContain('找不到任务');
    expect(cross.error).toContain('按会话隔离');
    expect(cross.output).toBeUndefined();
    const own = bg.status('bg-t-s1', 10, 7);
    expect(own.output).toContain('node server/index.js');
  });

  it('跨会话杀不掉：在碰进程之前就返回，被杀的任务 killed 标记仍为 false', async () => {
    const victim = put('bg-t-k1', 8);
    const r = await bg.kill('bg-t-k1', 7);
    expect(r.error).toContain('按会话隔离');
    // 这一条才是要紧的：归属判定必须在 killTree 之前，否则界面报错了进程也照样被杀
    expect(victim.killed).toBe(false);
    expect(victim.state).toBe('running');
  });

  it('本会话的清单里不含别人的任务，并如实说明隐藏了多少条', () => {
    put('bg-t-l1', 7);
    put('bg-t-l2', 8);
    put('bg-t-l3', 8);
    const one = bg.list(7);
    expect(one.output).toContain('bg-t-l1');
    expect(one.output).not.toContain('bg-t-l2');
    expect(one.output).toContain('另有 2 个任务属于别的会话');
    const all = bg.list(null);
    expect(all.output).toContain('bg-t-l2');
    expect(all.output).not.toContain('属于别的会话');
  });

  it('本会话一条都没有时说的是「当前会话没有后台任务」，不是全局空表', () => {
    put('bg-t-none', 8);
    expect(bg.list(7).output).toContain('当前会话没有后台任务');
  });
});

describe('接线：两条消费路径都带上会话', () => {
  const routes = readFileSync(path.resolve(__dirname, '../routes/ai.js'), 'utf8');
  const extools = readFileSync(path.resolve(__dirname, '../utils/extools.js'), 'utf8');

  it('右栏 REST：列表按 chat_id 过滤并回报隐藏数，杀掉也带 chat_id', () => {
    const sec = routes.slice(routes.indexOf("router.get('/background'"));
    expect(sec).toContain('parseInt(req.query.chat_id)');
    expect(sec).toContain('bg.visibleFor(chatId)');
    expect(sec).toContain('hidden: chatId ? bg.tasks.size - rows.length : 0');
    const killSec = routes.slice(routes.indexOf("router.post('/background/kill'"));
    expect(killSec).toContain('bg.kill(id, parseInt(req.body?.chat_id) || null)');
  });

  it('模型侧四个工具（启动/查状态/清单/终止）都传 ctx.chatId，缺会话时退回公共', () => {
    expect((extools.match(/Number\(ctx\.chatId\) \|\| null/g) || []).length).toBeGreaterThanOrEqual(4);
    expect(extools).toContain('bg.visibleFor(Number(ctx.chatId) || null)');
  });

  it('bg.start 记下归属，别再回到全局一张无名表', () => {
    const src = readFileSync(path.resolve(__dirname, '../utils/bg.js'), 'utf8');
    expect(src).toMatch(/function start\(command, cwd, chatId = null\)/);
    expect(src).toContain('chatId: Number(chatId) || null');
  });
});
