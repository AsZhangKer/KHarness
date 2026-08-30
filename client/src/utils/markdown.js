import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({
  gfm: true,
  breaks: true
});

// Markdown 渲染统一入口：解析后经 DOMPurify 白名单净化，杜绝存储型 XSS
export function renderMarkdown(md) {
  if (typeof md !== 'string' || !md) return '';
  const html = marked.parse(md);
  const clean = DOMPurify.sanitize(html, {
    ADD_ATTR: ['target', 'rel'],
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'embed', 'object'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover']
  });
  // 代码块加复制按钮（净化后注入受控静态标记；内容由事件委托从相邻 pre 的 textContent 读取）
  return clean.replace(/<pre>/g, '<div class="md-code"><button type="button" class="md-copy" title="复制代码"><i class="far fa-copy"></i><span>复制</span></button><pre>');
}
