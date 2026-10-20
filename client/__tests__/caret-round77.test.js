/**
 * 第七十七轮他报的那条：「AI 流式输出末尾的圆形光标没了，加回来，注意是跟随在最后一个字后面，而不是最新一行开头」。
 *
 * 一共三处形状会坏（都是挂真组件量出来的，不是读代码猜的）：
 *   1) 老正则 /^(.*)(<\/(?:p|li|pre|...)>)/i 里的 (.*) 不跨行，正文只要分了几段，
 *      它匹配到的是**第一段**的闭标签 —— 光标跑到上面那段末尾去了；
 *   2) 匹配不上就走兜底分支，把 .caret-dot 直接接在整段 HTML 之后，
 *      块级标签外面那枚 span 自己占一行，看着就是「最新一行开头有个圈」；
 *   3) 判「该不该放」用的是「这条是不是时间线最后一个条目」—— Agent 一说完话去调工具，
 *      尾部变成工具卡，于是**整段工具执行期间一个光标都没有**（他重启后追报的「还是没修好」就是这一条）。
 *      现在按「时间线里最后一条正文」放：跟随的仍然是他看得懂的最后一个字。
 * 现在光标只有 utils/caret.js 一个来源：从末尾往回跳闭标签与空白，插到最后一个实义字符后面。
 *
 * 断言刻意不看「有没有 span」，而是看它前面那个字是不是正文最后一个字 —— 位置错了就算坏。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createApp, h, nextTick } from 'vue';

vi.mock('../src/stores/toast', () => ({ toast: () => {} }));

const ChatMessage = (await import('../src/features/chat/ChatMessage.vue')).default;

const alive = [];
async function render(timeline, steps = [], busy = true) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp({
    render: () => h(ChatMessage, {
      role: 'assistant', content: '', steps, timeline, busy, index: 0, msgId: 1,
    }),
  });
  app.mount(host);
  for (let i = 0; i < 8; i++) { await nextTick(); await new Promise((r) => setTimeout(r, 15)); }
  alive.push(() => { app.unmount(); host.remove(); });
  return host;
}

/** 光标那枚 span 前后各截一点文字，位置对不对一眼就能判 */
function dotInfo(host) {
  const dots = [...host.querySelectorAll('.caret-dot')];
  return dots.map((d) => {
    const text = d.parentElement?.textContent || '';
    const at = text.length - (d.nextSibling && d.nextSibling.textContent ? String(d.nextSibling.textContent).length : 0);
    return {
      before: text.slice(Math.max(0, at - 20), at),
      after: String((d.nextSibling && d.nextSibling.textContent) || '').slice(0, 8),
      // span 前面紧邻的节点必须是文字，不能是空白或另一个标签（那才是「另起一行」）
      hugsChar: /[^\s]$/.test(text.slice(0, at)),
    };
  });
}

afterEach(() => { while (alive.length) { try { alive.pop()(); } catch (e) { /* 已收 */ } } });

describe('流式光标：贴在最后一个字后面', () => {
  it('单段正文结尾：光标跟着末尾那个字，且后面不再剩文字', async () => {
    const host = await render([{ kind: 'text', text: '第一句说完了。\n\n正在说的第二句' }]);
    const d = dotInfo(host);
    expect(d).toHaveLength(1);
    expect(d[0].before).toBe('正在说的第二句');
    expect(d[0].hugsChar).toBe(true);
  });

  it('分了几段时光标在**最后**那段末尾（老正则在这儿会跳到第一段去）', async () => {
    const host = await render([{ kind: 'text', text: '第一段。\n\n第二段。\n\n第三段还没说完' }]);
    const d = dotInfo(host);
    expect(d).toHaveLength(1);
    expect(d[0].before).toBe('第三段还没说完');
  });

  it('正文以围栏代码块结尾：光标落在代码最后一个字符后面，不在 ``` 那行开头', async () => {
    const host = await render([{ kind: 'text', text: '例子：\n\n```js\nconst a = 1;\n```' }]);
    const d = dotInfo(host);
    expect(d).toHaveLength(1);
    expect(d[0].before).toBe('const a = 1;');
    expect(d[0].hugsChar).toBe(true);
  });

  it('列表结尾：光标在最后一个 li 的字数后面', async () => {
    const host = await render([{ kind: 'text', text: '要点：\n\n- 甲\n- 乙还没写完' }]);
    const d = dotInfo(host);
    expect(d).toHaveLength(1);
    expect(d[0].before).toBe('乙还没写完');
  });

  it('整轮只有一颗（不许上下各冒一枚）', async () => {
    const host = await render([
      { kind: 'text', text: '前面说过的段落。' },
      { kind: 'step', type: 'result', name: 'grep', output: '命中一行' },
      { kind: 'text', text: '正在说的这句' },
    ]);
    expect(host.querySelectorAll('.caret-dot')).toHaveLength(1);
    expect(dotInfo(host)[0].before).toBe('正在说的这句');
  });

  it('尾部已经落成工具卡：光标退场（第八十三轮口径；「在跑」由 .phase 那行表示）', async () => {
    const host = await render([
      { kind: 'text', text: '先看一眼。' },
      { kind: 'step', type: 'result', name: 'read_file', output: '内容很长' },
    ]);
    /* 第八十三轮他重新拍过这一条：尾部是工具卡/note/压缩卡时**不放**光标。
       第七十七轮那套（跟到上面那段正文末尾）正是他报的「光标会卡在那」——
       一句话说完、接着去调工具，圆点还粘在已经说完的那句话末尾不动。 */
    expect(host.querySelectorAll('.caret-dot')).toHaveLength(0);
    expect(host.querySelector('.phase')).toBeTruthy();
  });

  it('一段正文都还没有（只在思考 / 上来就调工具）：不放光标，只有那行「在跑」', async () => {
    const host = await render([
      { kind: 'reason', text: '我在想要不要读文件' },
      { kind: 'step', type: 'tool', name: 'grep', args: { pattern: 'x' } },
    ]);
    expect(host.querySelectorAll('.caret-dot')).toHaveLength(0);
    expect(host.querySelector('.phase')).toBeTruthy();
  });

  it('回合结束（busy=false）就一颗都不留', async () => {
    const host = await render([{ kind: 'text', text: '这是最终回答。' }], [], false);
    expect(host.querySelectorAll('.caret-dot')).toHaveLength(0);
  });

  it('重进会话那条路（没有 timeline）：不显示光标（重载后不该有东西在闪）', async () => {
    /* 重建路径（content/reasoning/steps）天然不该有光标：
       它是「已经落库的历史」，不是「正在写的字」。第八十三轮的口径明确写了这一条。 */
    const host = await render(null, [{ type: 'text', text: '落库的正文尾巴' }]);
    expect(host.querySelectorAll('.caret-dot')).toHaveLength(0);
  });
});

/**
 * 第四处形状，也是他追报「光标也没修好啊」的真根因：点**一直插对了**，只是没有任何样式。
 * .caret-dot 是 v-html 注进正文的节点，Vue 的作用域样式不给这类节点打 data-v 属性，
 * 于是 <style scoped> 里的 .caret-dot 编译成 .caret-dot[data-v-xxx] —— 命中 0 个元素，
 * 一个没有宽高、没有背景的空 span，屏幕上等于不存在。jsdom 不会应用构建后的 CSS，
 * 这条只能守源码：样式必须在 tokens.css（全局），且不许回到 ChatMessage 的 scoped 块里。
 */
describe('流式光标的样式必须是全局样式（作用域样式命中不了 v-html 注入的节点）', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const globalCss = fs.readFileSync(path.resolve(__dirname, '../src/styles/tokens.css'), 'utf8');
  const scopedVue = fs.readFileSync(path.resolve(__dirname, '../src/features/chat/ChatMessage.vue'), 'utf8');

  it('tokens.css 里有 .caret-dot，且带着尺寸/背景/闪烁三样（缺一样就看不见或不闪）', () => {
    const rule = globalCss.match(/\.caret-dot\s*\{([^}]*)\}/);
    expect(rule, '.caret-dot 应当定义在 styles/tokens.css').toBeTruthy();
    const body = rule[1];
    expect(body).toMatch(/display:\s*inline-block/);
    expect(body).toMatch(/width:/);
    expect(body).toMatch(/background:/);
    expect(body).toMatch(/animation:\s*caret-blink/);
    expect(globalCss).toMatch(/@keyframes caret-blink\s*\{/);
  });

  it('ChatMessage.vue 的 <style scoped> 里不许再出现 .caret-dot 规则', () => {
    const scoped = scopedVue.split('<style scoped>')[1] || '';
    expect(scoped.split('</style>')[0]).not.toMatch(/\.caret-dot\s*\{/);
  });
});
