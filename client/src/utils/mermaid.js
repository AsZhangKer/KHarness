/**
 * mermaid 出图（#221）。
 *
 * 两件事必须分开做：markdown 渲染是同步的（computed 里直接算 HTML），而 mermaid 是 2MB+ 的包、
 * 出图又是异步的。所以渲染层只留一个带源码的容器（utils/format.js 里的 .md-mermaid），
 * 挂上 DOM 之后由这里补图：
 *   · 库只在**真出现图**时才 dynamic import（不出现就一个字节都不进首屏）；
 *   · 先 parse 预检，语法错就直接把源码留着 + 写明原因，别画半张图糊弄人；
 *   · securityLevel:'strict' + suppressErrorRendering：第三方页面/模型给的图里嵌 HTML 或放大炸弹图都不接。
 * 一个消息里几张图要串行渲：mermaid 的 id/内部状态是全局的，并发 render 会互相踩。
 */
let loading = null;
let queue = Promise.resolve();

function isDarkTheme() {
  const t = document.documentElement.getAttribute('data-theme') || '';
  return !('light' === t || 'paper' === t || (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches && !t));
}

async function load() {
  if (!loading) {
    loading = import('mermaid').then((m) => {
      const mermaid = m.default || m;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        theme: isDarkTheme() ? 'dark' : 'default',
        fontFamily: 'inherit',
      });
      return mermaid;
    }).catch((e) => { loading = null; throw e; });
  }
  return loading;
}

function fail(el, mermaid, msg) {
  el.classList.add('md-mermaid-failed');
  const src = el.querySelector('pre') ? el.querySelector('pre').textContent : '';
  el.innerHTML = '';
  const note = document.createElement('div');
  note.className = 'md-mermaid-note';
  note.textContent = `流程图没能渲染：${String(msg || '未知错误').split('\n')[0].slice(0, 160)}`;
  const pre = document.createElement('pre');
  pre.className = 'md-mermaid-src';
  pre.textContent = src;                             // 源码本来就在容器里，失败时就原样留着
  el.append(note, pre);
}

async function renderOne(mermaid, el) {
  const pre = el.querySelector('pre');
  const src = String(pre ? pre.textContent : '').trim();   // 源码取自容器，不依赖 data-* 属性
  if (!src) return;
  try {
    await mermaid.parse(src);                        // 预检：语法错在这里就翻车，不进入画布
  } catch (e) {
    fail(el, mermaid, (e && e.message) || e);
    return;
  }
  try {
    const id = `kh-md-${Math.random().toString(36).slice(2, 10)}`;
    const out = await mermaid.render(id, src);
    const svg = out && (out.svg || out);
    el.classList.add('md-mermaid-ok');
    el.innerHTML = svg;
    // mermaid 会把临时节点塞到 body 上，渲染完不删就是越聊越多
    const tmp = document.getElementById(`d${id}`) || document.getElementById(id);
    if (tmp && tmp.parentElement === document.body) tmp.remove();
  } catch (e) {
    fail(el, mermaid, (e && e.message) || e);
  }
}

/** 把 root 里所有还没画过的 mermaid 容器补成图（同一容器只画一次） */
export function renderMermaid(root) {
  if (!root || !root.querySelectorAll) return;
  const todo = [...root.querySelectorAll('.md-mermaid')].filter((el) => !el.dataset.done);
  if (!todo.length) return;
  for (const el of todo) el.dataset.done = '1';
  queue = queue
    .then(async () => {
      let mermaid = null;
      try { mermaid = await load(); } catch (e) {
        for (const el of todo) fail(el, mermaid, (e && e.message) || e);
        return;
      }
      for (const el of todo) {
        if (!el.isConnected) continue;              // 消息已经被换掉/折叠掉了就别往回写
        await renderOne(mermaid, el);
      }
    })
    .catch(() => { /* 出图失败不影响正文 */ });
  return queue;
}
