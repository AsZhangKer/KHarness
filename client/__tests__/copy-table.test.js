/**
 * 文案表基建（第六十八轮）。
 *
 * 这张表归他管 —— 所以这里**不锁具体措辞**（锁了等于替他改文案），只锁三件事：
 * ① 取不到键时不许出空白（必须显眼地漏出键名并 console.error，错误会进「调试」悬浮窗）；
 * ② 键不许撞车（两张表写同一个键 = 后一张悄悄覆盖前一张）；
 * ③ 已经搬进表的那几处不许退回硬编码。
 */
import { describe, it, expect, vi } from 'vitest';
import { createApp, h } from 'vue';
import fs from 'node:fs';
import path from 'node:path';
import { txt, has, keys, DUP_KEYS } from '../src/copy';

const ChatMessage = (await import('../src/features/chat/ChatMessage.vue')).default;

const SRC = path.resolve(__dirname, '../src');

describe('取文案', () => {
  it('缺键不许静默：漏出键名 + 记一条错误', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const got = txt('nope.missing.key');
    expect(got).toContain('nope.missing.key');
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it('{n} 占位按参数填，能重复出现', () => {
    const table = { 'a.b': '共 {n} 条，其中 {n} 条已选' };
    // t() 读的是编译期合并好的表，这里直接验填充规则本身
    const fill = (s, p) => { let o = s; for (const [k, v] of Object.entries(p)) o = o.split(`{${k}}`).join(String(v)); return o; };
    expect(fill(table['a.b'], { n: 3 })).toBe('共 3 条，其中 3 条已选');
  });

  it('两张表的键没有撞车', () => {
    expect(DUP_KEYS).toEqual([]);
  });

  it('表不是空的，键名都带板块前缀', () => {
    expect(keys().length).toBeGreaterThan(0);
    // 键名：板块前缀小写，段内允许 camelCase（settings.unsetPlaceholder 这种）
    for (const k of keys()) expect(k).toMatch(/^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/);
  });
});

describe('第一批迁移：设置页那几处不许退回硬编码', () => {
  const s = fs.readFileSync(path.join(SRC, 'features/settings/SettingsPage.vue'), 'utf8');

  it('文案表里确实有这几条', () => {
    for (const k of ['settings.shell.customLabel', 'settings.shell.customPlaceholder', 'settings.shell.apply',
      'settings.shell.note', 'settings.whale.label', 'settings.whale.note', 'settings.whale.on', 'settings.whale.off', 'settings.compress.label']) {
      expect(has(k)).toBe(true);
    }
  });

  it('那几处都走表了', () => {
    expect(s).toMatch(/\{\{ txt\('settings\.shell\.customLabel'\) \}\}/);
    expect(s).toMatch(/:placeholder="txt\('settings\.shell\.customPlaceholder'\)"/);
    expect(s).toMatch(/\{\{ txt\('settings\.shell\.apply'\) \}\}/);
    expect(s).toMatch(/\{\{ txt\('settings\.shell\.note'\) \}\}/);
    expect(s).toMatch(/\{\{ txt\('settings\.whale\.label'\) \}\}/);
    expect(s).toMatch(/toast\(v \? txt\('settings\.whale\.on'\) : txt\('settings\.whale\.off'\)/);
  });

  it('聊天页那三处也走表了（右栏两处空态 + 内嵌浏览器那句回喂）', () => {
    const dock = fs.readFileSync(path.join(SRC, 'features/chat/ChatDock.vue'), 'utf8');
    const panel = fs.readFileSync(path.join(SRC, 'features/chat/BrowserPanel.vue'), 'utf8');
    expect(dock).toMatch(/\{\{ txt\('chat\.dock\.bgEmpty'\) \}\}/);
    expect(dock).toMatch(/txt\('chat\.dock\.insertEmpty1'\)/);
    expect(panel).toMatch(/txt\('chat\.browser\.initFail'/);
    // 旧说法一条都不许留
    expect(dock).not.toMatch(/模型可调用<code>run_background<\/code>启动后台异步构建/);
    expect(dock).not.toMatch(/无。可用 <code>\/insert<\/code> 预埋/);
    expect(panel).not.toMatch(/浏览器栏没能就位/);
  });

  it('旧的口语写法不许回来', () => {
    expect(s).not.toMatch(/>用这个</);
    expect(s).not.toMatch(/小鲸鱼挂件（/);
    expect(s).not.toMatch(/填了「用这个」后立刻生效/);
  });
});

/**
 * 第七十一轮：他给的文案对照表整页落地。
 * 两件要锁的事：① 页面里每一个 `txt('键')` 都必须取到（取不到就是屏幕上一个 ⟦键名⟧）；
 * ② 他点过名的那些旧说法不许哪天又回到硬编码里。
 */
describe('第七十一轮：设置页整页进表 + 旧说法不回来', () => {
  const s = fs.readFileSync(path.join(SRC, 'features/settings/SettingsPage.vue'), 'utf8');
  const dock = fs.readFileSync(path.join(SRC, 'features/chat/ChatDock.vue'), 'utf8');

  it('引用的键全都在表里（少一条屏幕上就显示 ⟦键名⟧）', () => {
    // 全树扫：凡是 import 了 txt 的文件都算，漏一个键就是界面上一个 ⟦键名⟧
    const files = [];
    const SKIP = path.join(SRC, 'copy');   // 表本身的文件里有 `txt('x', {n:3})` 这种举例，不算引用
    const walk = (dir) => {
      if (dir === SKIP) return;
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        const stt = fs.statSync(p);
        if (stt.isDirectory()) walk(p);
        else if (/\.(vue|js)$/.test(name)) files.push(p);
      }
    };
    walk(SRC);
    const refs = new Set();
    for (const f of files) {
      const srcTxt = fs.readFileSync(f, 'utf8');
      if (!srcTxt.includes('copy')) continue;
      for (const m of srcTxt.matchAll(/txt\('([a-zA-Z0-9_.]+)'/g)) refs.add(`${m[1]} ← ${path.basename(f)}`);
    }
    expect(refs.size).toBeGreaterThan(30);
    // 只报缺的那几条（带文件名），别让人对着一个 boolean 猜是哪个页面漏了
    const missing = [...refs].filter((one) => !has(one.split(' ← ')[0]));
    expect(missing).toEqual([]);
  });

  it('新搬进去的键在表里', () => {
    for (const k of ['settings.save', 'settings.retry.rl', 'settings.retry.gw', 'settings.agents.title',
      'settings.stall.label', 'settings.perm.kind', 'settings.perm.testRun', 'settings.skill.name',
      'settings.lab.img.desc', 'settings.about.desc', 'settings.db.moveTitle', 'settings.factory.confirmLabel',
      'chat.dock.planEmpty', 'chat.dock.agentEmpty']) {
      expect(has(k)).toBe(true);
    }
  });

  it('他点过的旧说法一条都不许在页面上', () => {
    for (const dead of ['保存上游设置', '全局提示词', '卡带检测（模型原地复读', '本轮工具结果自动落盘',
      '规则试跑（不执行', '试跑判定', '技能名（kebab-case', 'Markdown 正文', '请逐字输入下面这句话',
      '还没有 MCP 服务器', '改数据库位置', '上游 429 最大重试', '短名（可空）', '要它去查什么',
      '计划模式，使用任务栏', '按日 token / 按模型费用估算']) {
      expect(s + dock).not.toContain(dead);
    }
    // 关于页里那两行个人信息性质的说明（形态 / 文档）整行删掉了
    expect(s).not.toMatch(/README\.md \/ TOOLS-CALLING\.md/);
    expect(s).not.toMatch(/桌面端（Electron）/);
  });
});

/**
 * 压缩卡上那句「已达 X%」（第六十九轮：阈值可调）。
 * 挂真组件渲染，不看源码 —— 阈值必须来自后端随卡片带下来的那个数，前端写死 80% 就是假话，
 * 而且这张卡会落库，重载之后还得说得出当时生效的值。
 */
describe('压缩卡说得出当时生效的阈值', () => {
  function renderCard(step) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createApp({
      render: () => h(ChatMessage, { role: 'assistant', busy: false, timeline: [{ kind: 'step', ...step }], msgId: 1, index: 0 }),
    });
    app.mount(host);
    const text = host.querySelector('.step-note')?.textContent?.trim() || '';
    app.unmount();
    host.remove();
    return text;
  }
  const base = { type: 'compress', phase: 'start', used: 1000, limit: 1200, percent: 83, from: '模型上限' };

  it('后端给了 60% 就写 60%', () => {
    expect(renderCard({ ...base, threshold: 60 })).toContain('已达 60%');
  });

  it('老数据没这个字段就不报数：宁可少说半句，也不编一个 80% 出来', () => {
    const t = renderCard({ ...base });
    expect(t).toContain('已达压缩线');
    expect(t).not.toMatch(/已达 \d+%/);
  });

  it('手动压缩不提这条线（没有阈值可言）', () => {
    const t = renderCard({ ...base, manual: true });
    expect(t).toContain('正在压缩上下文');
    expect(t).not.toMatch(/已达 \d+%/);
  });
});
