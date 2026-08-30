// 剪贴板复制：优先 navigator.clipboard（需 HTTPS/localhost），
// HTTP 环境（如 http://192.168.x.x:8317）自动降级为隐藏 textarea + execCommand
export async function copyText(text) {
  const s = String(text ?? '');
  if (!s) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch (e) { /* 降级 */ }
  const ta = document.createElement('textarea');
  ta.value = s;
  ta.style.cssText = 'position:fixed;top:-999px;left:-999px;opacity:0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  document.body.removeChild(ta);
  return ok;
}
