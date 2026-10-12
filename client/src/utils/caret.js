/* 流式光标只有一个来源：把 .caret-dot 贴到「最后一个实义字符」之后。
   两件事必须同时成立，缺一条就是他报的那两种形状：
   ① 末尾是工具卡/note 时也得有光标 —— 早先只往「最后一条是正文」那个分支插，AI 一调工具光标就整枚消失；
   ② 不许另起一行 —— 内联 span 落在 </p>、</pre> 这类闭标签之后就会独自占一行，
      所以要跳过末尾那串闭标签和空白，插到最后一个字后面（原来那句正则用 (.*) 不跨行，
      碰到以代码块结尾的正文只会匹配到上面那个 <p>，光标跑到「例子：」后面去了）。
   调用方传的是「这一条消息正在流式」，插不插由这段是不是全消息最后的可见内容决定（caretGoesHere）。 */

const TAIL_CLOSE = /<\/?[a-zA-Z][a-zA-Z0-9-]*\s*\/?>\s*$/;

/** 这段 HTML 里该不该放光标：是时间线的最后一条就放 */
export function caretHere(i, timeline) {
  return !!timeline && i === timeline.length - 1;
}

/** 已有正文时：插到最后一个实义字符之后（跳过尾随空白与一串闭标签） */
export function withCaret(html) {
  const s = String(html == null ? '' : html);
  if (!s) return '<span class="caret-dot"></span>';
  let i = s.length;
  for (;;) {
    while (i > 0 && /\s/.test(s[i - 1])) i--;
    if (i === 0) break;
    const m = TAIL_CLOSE.exec(s.slice(0, i));
    // 只跳闭标签（</p>）与自闭合（<br>）；开标签后面必然还有内容，不该越过它
    if (m && m[0].trimStart().startsWith('</')) { i -= m[0].trimEnd().length; continue; }
    if (m && /^(<br|<hr|<img)\b/i.test(m[0].trimStart())) { i -= m[0].trimEnd().length; continue; }
    break;
  }
  const dot = '<span class="caret-dot"></span>';
  return i >= s.length ? s + dot : s.slice(0, i) + dot + s.slice(i);
}
