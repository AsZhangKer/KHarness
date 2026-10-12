// diff 行的归一与高亮：消息流里的工具卡（ChatMessage）和侧栏「审阅」弹窗共用这一份。
// 两边以前各写一套颜色和取语言的规则，改一处漏一处（同一份改动在卡里是绿的、在弹窗里就没了）。
import { escapeHtml, highlightToLines } from './highlight';

/** 路径末段（Windows 与 POSIX 都吃）：审阅弹窗和侧栏卡片标题都只显示文件名，路径单独一行 */
export function baseName(p) {
  return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
}

/** 服务端 diff 行有两种形状：{t:'add'|'del'|'ctx', text} 与 +/- 开头的字符串；也兼容 {kind}/{type} */
export function normDiffLine(l) {
  if (typeof l === 'string') {
    if (l.startsWith('+++') || l.startsWith('---')) return { kind: 'meta', mark: ' ', text: l };
    if (l.startsWith('+')) return { kind: 'add', mark: '+', text: l.slice(1) };
    if (l.startsWith('-')) return { kind: 'del', mark: '-', text: l.slice(1) };
    return { kind: 'ctx', mark: ' ', text: l };
  }
  if (l && typeof l === 'object') {
    const text = String(l.text ?? l.line ?? '');
    const k = String(l.t || l.kind || l.type || '').toLowerCase();
    if (k === 'add' || k === 'insert') return { kind: 'add', mark: '+', text };
    if (k === 'del' || k === 'delete' || k === 'remove') return { kind: 'del', mark: '-', text };
    if (l.mark === '+') return { kind: 'add', mark: '+', text };
    if (l.mark === '-') return { kind: 'del', mark: '-', text };
    return { kind: k === 'meta' ? 'meta' : 'ctx', mark: ' ', text };
  }
  return { kind: 'ctx', mark: ' ', text: String(l ?? '') };
}

/**
 * 整段一起高亮再按行拆开（逐行 highlight 会把跨行的字符串/注释切断），
 * 返回每行 {kind, mark, html}；html 已转义，可直接 v-html。
 */
export function diffView(rows, lang) {
  const norm = (rows || []).map(normDiffLine);
  const htmls = highlightToLines(norm.map((r) => r.text).join('\n'), lang);
  norm.forEach((r, i) => { r.html = htmls[i] || escapeHtml(r.text); });
  return norm;
}
