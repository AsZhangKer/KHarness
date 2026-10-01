import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../src/utils/format.js';

/**
 * 公式与流程图的「留容器」那一半（第五十三轮 #221）。
 * 出图本身是懒加载的（utils/math.js / utils/mermaid.js 要在浏览器里跑），
 * 这里锁的是 markdown 侧：什么该被摘成公式容器、什么绝对不许碰。
 */
describe('公式摘取', () => {
  it('行内 $...$ 变成 md-math 容器，data-src 里是原式子', () => {
    const html = renderMarkdown('结论是 $x^2 + y^2$ 成立');
    expect(html).toContain('class="md-math"');
    expect(html).toContain('data-src="x^2 + y^2"');
    expect(html).toContain('$x^2 + y^2$');            // 原文留在里面：库没到也看得见东西
  });

  it('块级 $$...$$ 带 md-math-block', () => {
    const html = renderMarkdown('前面\n\n\\[\\int_0^1 x\\,dx = \\frac{1}{2}\\]\n\n后面');
    expect(html).toContain('md-math-block');
    expect(html).toContain('data-display="1"');
  });

  it('代码围栏里的 $ 不是公式', () => {
    const html = renderMarkdown('装依赖：\n```bash\nnpm i $PKG --registry http://127.0.0.1:4873\n```\n');
    expect(html).not.toContain('md-math');
    expect(html).toContain('$PKG');                   // 高亮会把它包进 span，所以只查这个片段
  });

  it('行内代码里的 $ 不是公式', () => {
    const html = renderMarkdown('变量写成 `$host` 和 `$1$` 就行');
    expect(html).not.toContain('md-math');
  });

  it('钱不是公式', () => {
    const html = renderMarkdown('花 $5 买了 $10 的东西');
    expect(html).not.toContain('md-math');
  });

  it('混排：代码块 + 公式各归各', () => {
    const html = renderMarkdown('见 $a^2$：\n```\n$env:PATH\n```\n');
    expect(html).toContain('md-math');
    expect(html).toContain('$env:PATH');
    expect(html.match(/data-src=/g).length).toBe(1);
  });
});

describe('流程图容器', () => {
  it('```mermaid 块只留源码容器，不在这里出图', () => {
    const html = renderMarkdown('```mermaid\ngraph TD; A-->B;\n```');
    expect(html).toContain('class="md-mermaid"');
    expect(html).toContain('graph TD; A--&gt;B;');     // 源码就在容器里（DOMPurify 会剥 data-*，所以不靠属性）
    expect(html).not.toContain('<svg');               // 同步渲染阶段绝不会有 SVG
  });

  it('普通代码块照旧走高亮，不会被误当流程图', () => {
    const html = renderMarkdown('```js\nconst a = 1;\n```');
    expect(html).toContain('md-code');
    expect(html).not.toContain('md-mermaid');
  });
});
