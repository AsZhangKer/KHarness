/**
 * 公式出图（#221）。与 utils/mermaid.js 同一套路子：
 * markdown 那边只留 `<span class="md-math" data-src="...">原文</span>`，
 * 这里在 DOM 挂上之后把库 import 进来（katex 258KB + 它的字体），一条公式都没有就永远不加载。
 *
 * 失败的形状要说清楚：渲染不了（式子写错、不支持的命令）就**保留原文**并在下面标一行原因，
 * 绝不能把整条回复变成一片红字 —— 模型经常连着输出十几段数学，一处错不该带崩全篇。
 */
let loading = null;

function load() {
  if (!loading) {
    loading = Promise.all([import('katex'), import('katex/dist/katex.min.css')])
      .then(([m]) => (m.default || m))
      .catch((e) => { loading = null; throw e; });
  }
  return loading;
}

/** 把 root 里所有没画过的公式span 画出来；同一批只画一次（data-done 去过重） */
export function renderMath(root) {
  if (!root || !root.querySelectorAll) return;
  const todo = [...root.querySelectorAll('.md-math[data-src]')].filter((el) => !el.dataset.done);
  if (!todo.length) return;
  for (const el of todo) el.dataset.done = '1';
  load().then((katex) => {
    for (const el of todo) {
      if (!el.isConnected) continue;
      const src = el.dataset.src || '';
      try {
        el.textContent = '';
        el.innerHTML = katex.renderToString(src, {
          throwOnError: false,
          displayMode: el.dataset.display === '1',
          output: 'html',
          strict: 'ignore',        // 未知命令（\RR 之类）只降级不报警，模型写的式子经常带自定义宏
        });
        el.classList.add('md-math-ok');
      } catch (e) {
        // renderToString 里 throwOnError:false 基本不抛；真抛了（非字符串等）就退回原文，原文本来就在 textContent 里
        el.dataset.done = '';
        el.classList.add('md-math-failed');
      }
    }
  }).catch(() => { /* 库没加载进来：留着原文，读者看到的还是 $...$，不是空白 */ });
}
