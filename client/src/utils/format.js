import { marked } from 'marked';
import DOMPurify from 'dompurify';
import '../styles/hljs.css';
import { highlightCode, normalizeLang, escapeHtml, langFromPath, highlightToLines } from './highlight';

marked.setOptions({ gfm: true, breaks: true });

/**
 * 公式与流程图（#221）：这里只负责**留好容器**，真正的渲染在 utils/math.js、utils/mermaid.js，
 * 挂完 DOM 之后按需 import 那两个库。原因是 renderMarkdown 是同步的（computed 里直接算 HTML），
 * 而 katex 258KB / mermaid 2MB+ 都不该在没有公式/图的时候进首屏 —— 挂进 HTML 里的那个
 * `<span class="md-math">` 里带着原文，所以就算 JS 那边失败，用户看到的也还是原式子。
 *
 * 摘取必须在 marked 之前：`a_{i}` 的下划线、`\\{` 的转义会被 marked 先吃掉；
 * 同时必须跳过代码围栏，否则 `npm i $PKG` 里的 `$` 会被当公式。
 */
const MATH_PAD = '@@KH-MATH-';
const CODE_PAD = '@@KH-CODE-';

/** 按代码围栏把源码切成「正文 / 代码」两段交替，只有正文参与公式摘取 */
function splitFenced(md) {
  const out = [];
  const lines = String(md).split('\n');
  let buf = [];
  let fence = null;
  for (const line of lines) {
    const m = /^(\s*)(```+|~~~+)/.exec(line);
    if (fence) {
      buf.push(line);
      if (m && m[2][0] === fence[0] && m[2].length >= fence.length) { out.push({ code: true, text: buf.join('\n') }); buf = []; fence = null; }
      continue;
    }
    if (m) { out.push({ code: false, text: buf.join('\n') }); buf = []; fence = m[2]; buf.push(line); continue; }
    buf.push(line);
  }
  out.push({ code: !!fence, text: buf.join('\n') });
  return out;
}

function extractMath(md) {
  const store = [];
  const codes = [];
  const keep = (tex, display) => {
    store.push({ tex, display });
    return MATH_PAD + (store.length - 1) + '@@';
  };
  const parts = splitFenced(md).map((seg) => {
    if (seg.code || !/[\\$]/.test(seg.text)) return seg.text;
    let text = seg.text;
    // 行内代码先藏起来：反引号包着的 `` `$1$` `` 里出现 $ 不算公式（围栏代码由 splitFenced 管，这里管不到行内）
    text = text.replace(/(`+)([^`]*?)\1/g, (all) => { codes.push(all); return CODE_PAD + (codes.length - 1) + '@@'; });
    // 块级先行（$$..$$ 与 \[..\]），再处理行内，避免行内规则把块级的半截吃掉
    text = text.replace(/\$\$([\s\S]+?)\$\$/g, (all, tex) => keep(tex, true));
    text = text.replace(/\\\[([\s\S]+?)\\\]/g, (all, tex) => keep(tex, true));
    text = text.replace(/\\\(([\s\S]+?)\\\)/g, (all, tex) => keep(tex, false));
    // 行单 $：前后不许是空白，也不许挨着数字（$5 和 100$ 那是钱，不是公式）
    text = text.replace(/(^|[^\\$])\$([^\s$][^$\n]*?[^\s$])\$(?!\d)/g, (all, pre, tex) => pre + keep(tex, false));
    return text;
  });
  return { md: parts.join('\n'), store, codes };
}

/**
 * 代码占位必须在 marked **之前**还原：它本来就是 markdown 的一部分，
 * 晚还原的话 `` `$host` `` 会变成带反引号的普通文本，行内代码样式就丢了。
 */
function restoreCodes(src, codes) {
  if (!codes.length) return src;
  return src.replace(new RegExp(CODE_PAD + '(\\d+)@@', 'g'), (all, i) => codes[Number(i)] ?? all);
}

function putMathBack(html, store) {
  if (!store.length) return html;
  return html.replace(new RegExp(MATH_PAD + '(\\d+)@@', 'g'), (all, i) => {
    const m = store[Number(i)];
    if (!m) return all;
    const src = escapeHtml(m.tex);
    return `<span class="md-math${m.display ? ' md-math-block' : ''}" data-display="${m.display ? 1 : 0}" data-src="${src}">${escapeHtml((m.display ? '$$' : '$') + m.tex + (m.display ? '$$' : '$'))}</span>`;
  });
}

function renderCode(code, lang) {
  const raw = String(lang || '').trim().toLowerCase();
  const language = normalizeLang(lang);
  // mermaid 不在这里出图：出图要等 DOM 挂上、库还得分包懒加载（utils/mermaid.js），
  // 这里只留一个带源码的容器，渲染失败就永远是那段源码，不会出现空白块。
  // 判的是**原始 infostring**：normalizeLang 不认识的都归成 ''（→ 显示成 text），
  // 拿归一化后的值去比 mermaid 永远不成立（第一版就是这么错的，测试才抓出来）。
  if (raw === 'mermaid') {
    // 源码只放在容器内的 <pre> 里，不走 data-* —— DOMPurify 会把自定义属性剥掉，
    // 到那时图永远画不出来、还表现为「mermaid 没装好」，很难查（第一版就栽在这）。
    return `<div class="md-mermaid"><pre class="md-mermaid-src"><code>${escapeHtml(code)}</code></pre></div>`;
  }
  const body = language ? highlightCode(code, language) : escapeHtml(code);
  const cls = 'hljs' + (language ? ` language-${language}` : '');
  return (
    `<div class="md-code"><div class="md-code-bar"><span class="md-code-lang">${escapeHtml(language || 'text')}</span></div>` +
    `<pre><code class="${cls}">${body}</code></pre></div>`
  );
}

marked.use({
  renderer: {
    code(token, infostring) {
      const text = typeof token === 'object' && token !== null ? token.text : token;
      const lang = typeof token === 'object' && token !== null ? token.lang : infostring;
      return renderCode(String(text ?? ''), lang);
    },
  },
});

export function renderMarkdown(md) {
  if (typeof md !== 'string' || !md) return '';
  const picked = extractMath(md);
  const html = marked.parse(restoreCodes(picked.md, picked.codes));
  const clean = DOMPurify.sanitize(html, {
    ADD_ATTR: ['target', 'rel'],
    // KaTeX 出来的 HTML 全是 span 加 style/class，SVG 分支给 MathML 兜底用；
    // 白名单不加这些的话公式会被剥成纯文本，看起来就是「公式没渲染」。
    ADD_TAGS: ['use'],
    ADD_URI_SAFE_ATTR: ['style', 'class'],
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'embed', 'object'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
  });
  return putMathBack(clean, picked.store, picked.codes).replace(
    /<div class="md-code-bar">/g,
    '<div class="md-code-bar"><button type="button" class="md-copy" title="复制代码"><i class="far fa-copy"></i><span>复制</span></button>'
  );
}

export { highlightCode, highlightToLines, langFromPath, normalizeLang, escapeHtml };

export function formatTokens(n) {
  const v = Number(n) || 0;
  return v.toLocaleString();
}

/** K/M 缩写：1234 → 1.2K，1200000 → 1.2M */
export function formatCompact(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

export function formatCost(n) {
  const v = Number(n) || 0;
  return `¥ ${v.toFixed(4)}`;
}

export function shortPath(p) {
  if (!p) return '';
  const s = String(p);
  return s.length > 42 ? '…' + s.slice(-41) : s;
}
