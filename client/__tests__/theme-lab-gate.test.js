/**
 * 「开发到一半的主题」入口收进实验室这一刀的回归测试（第八十轮续12 之后）。
 *
 * 他要的是：终末地别再当正常主题摆在外观页里，但代码继续留着。落地成三条判据：
 *   1) 没点实验室开关 ⇒ 外观页的列表里没有它，且**上次存着 endfield 也要退回默认**
 *      （否则人会用着一个连切换入口都找不到的皮肤）；
 *   2) 点了开关 ⇒ 卡片当场出现（不刷新），能切过去；
 *   3) 关掉开关 ⇒ 正在用的人当场被退回默认，localStorage 里也不留 endfield。
 * 第 2、3 条走 setLabFlag —— 设置页那颗开关调的就是它，别再模拟「外部改了 localStorage」。
 * 「当场」只有 reactive 真的追踪到那个键才成立，所以断言全部读 visibleThemes.value：
 * 上一版浏览器实测就是栽在「拨了开关但卡片没出现」（读数：7 张变 6 张），见 stores/theme.js 顶部注释。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

async function freshStore() {
  vi.resetModules();
  return await import('../src/stores/theme.js');
}

const ids = (m) => m.visibleThemes.value.map((t) => t.id);

describe('实验室主题闸', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it('开关没点亮：列表里没有它，存过 endfield 也退回默认', async () => {
    localStorage.setItem('kh.theme', 'endfield');
    const m = await freshStore();
    expect(m.themeState.id).toBe('dark');
    expect(ids(m)).not.toContain('endfield');
    expect(m.visibleThemes.value).toHaveLength(6);
    m.setTheme('endfield');
    expect(m.themeState.id).toBe('dark');   // 认不得未解锁的 id
  });

  it('拨开开关：卡片当场出现并且切得过去；关掉：当场退回默认', async () => {
    const m = await freshStore();
    expect(m.visibleThemes.value).toHaveLength(6);

    expect(m.setLabFlag('endfieldTheme', true)).toBe(true);
    expect(JSON.parse(localStorage.getItem('nu_labs')).endfieldTheme).toBe(true);   // 落盘读回
    expect(ids(m)).toContain('endfield');
    expect(m.visibleThemes.value).toHaveLength(7);

    m.setTheme('endfield');
    expect(m.themeState.id).toBe('endfield');
    expect(document.documentElement.dataset.theme).toBe('endfield');

    expect(m.setLabFlag('endfieldTheme', false)).toBe(true);
    expect(m.themeState.id).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('kh.theme')).not.toBe('endfield');
    expect(m.visibleThemes.value).toHaveLength(6);
  });

  it('实验室里别的开关不能顺手把主题闸打开，也不能把老键抹掉（nu_labs 是共用的一本账）', async () => {
    localStorage.setItem('nu_labs', JSON.stringify({ gitPreview: true }));
    const m = await freshStore();
    expect(m.setLabFlag('computerUse', true)).toBe(true);
    expect(m.visibleThemes.value).toHaveLength(6);
    const saved = JSON.parse(localStorage.getItem('nu_labs'));
    expect(saved.gitPreview).toBe(true);      // 写之前先读整本，别处的键要留着
    expect(saved.computerUse).toBe(true);
  });
});
