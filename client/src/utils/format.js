import { marked } from 'marked';
import DOMPurify from 'dompurify';
import '../styles/hljs.css';
import { highlightCode, normalizeLang, escapeHtml, langFromPath, highlightToLines } from './highlight';

marked.setOptions({ gfm: true, breaks: true });

function renderCode(code, lang) {
  const language = normalizeLang(lang);
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
  const html = marked.parse(md);
  const clean = DOMPurify.sanitize(html, {
    ADD_ATTR: ['target', 'rel'],
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'embed', 'object'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
  });
  return clean.replace(
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
