// 代码高亮：markdown 代码块与 write/edit 的 diff 行共用
import hljs from 'highlight.js/lib/common';

const ALIAS = {
  vue: 'xml', html: 'xml', htm: 'xml', xml: 'xml',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  py: 'python', rb: 'ruby', sh: 'bash', zsh: 'bash', ps1: 'powershell', psm1: 'powershell',
  yml: 'yaml', md: 'markdown', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', go: 'go', rs: 'rust',
  json: 'json', sql: 'sql', css: 'css', scss: 'scss', less: 'less', ini: 'ini', toml: 'ini', dockerfile: 'dockerfile',
};

export function langFromPath(p) {
  const s = String(p || '');
  const base = s.split(/[\\/]/).pop().toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  const m = base.match(/\.([a-z0-9]+)$/);
  if (!m) return '';
  return ALIAS[m[1]] || (hljs.getLanguage(m[1]) ? m[1] : '');
}

export function normalizeLang(raw) {
  const s = String(raw || '').trim().toLowerCase().split(/\s+/)[0];
  if (!s) return '';
  if (ALIAS[s]) return ALIAS[s];
  return hljs.getLanguage(s) ? s : '';
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

export function highlightCode(code, lang) {
  const text = String(code ?? '');
  if (!text) return '';
  try {
    const l = normalizeLang(lang);
    if (l) return hljs.highlight(text, { language: l, ignoreIllegals: true }).value;
    return hljs.highlightAuto(text).value;
  } catch {
    return escapeHtml(text);
  }
}

/** 整段高亮后按行拆，保证跨行 token 不被切断 */
export function highlightToLines(code, lang) {
  const html = highlightCode(code, lang);
  const lines = [];
  let cur = '';
  const stack = [];
  for (let i = 0; i < html.length; ) {
    const ch = html[i];
    if (ch === '<') {
      const end = html.indexOf('>', i);
      if (end === -1) {
        cur += html.slice(i);
        break;
      }
      const tag = html.slice(i, end + 1);
      cur += tag;
      if (tag.startsWith('</')) stack.pop();
      else if (!tag.endsWith('/>')) stack.push(tag);
      i = end + 1;
      continue;
    }
    if (ch === '\n') {
      lines.push(cur + '</span>'.repeat(stack.length));
      cur = stack.join('');
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  lines.push(cur + '</span>'.repeat(stack.length));
  return lines;
}

export { hljs };
