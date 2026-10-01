/**
 * markdown 渲染结果的按内容缓存（#231）。
 *
 * 为什么要缓存：模板里每个文本条目都直接 `renderMarkdown(item.text)`，而流式那一下整轮条目会全部重算。
 * 实测读数（client/__tests__/render-cost.test.js）：一轮 10 个文本条目时，
 * 30 个增量 = 300 次 renderMarkdown —— 会话越长每一下越贵，正是「上下文长了才卡」的那条路。
 * 切页更直接：整屏历史每条都要重算一遍（20 条长回复 ≈ 100ms 纯渲染，还没算布局）。
 *
 * 缓存以**正文本身**为 key（不是条目对象）：条目对象每次重算 computed 都是新的，
 * 按对象缓存等于没缓存；而切回同一个会话时正文一字未变，按内容才命中得了。
 * 上限 300 条、超了就整表重来 —— 这是给人看的加速表，不是必须保住的资产，宁可全 miss 也不许吃内存。
 */
import { renderMarkdown } from './format';

const MAX = 300;
const cache = new Map();

export function renderMarkdownCached(text) {
  const src = String(text || '');
  if (!src) return '';
  const hit = cache.get(src);
  if (hit !== undefined) return hit;
  const html = renderMarkdown(src);
  if (cache.size >= MAX) cache.clear();
  cache.set(src, html);
  return html;
}

/** 只给测试用：换用例时别带着上一轮的读数 */
export function clearMarkdownCache() {
  cache.clear();
}
