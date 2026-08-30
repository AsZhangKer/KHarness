// 纯文本清洗：去掉尖括号防止标签注入，截断到 maxLen
function sanitizeText(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  // 去掉不可见控制字符（保留换行）
  return str.replace(/[<>]/g, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().substring(0, maxLen);
}

module.exports = { sanitizeText };
