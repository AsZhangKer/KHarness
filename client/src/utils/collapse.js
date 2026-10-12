/**
 * 左栏「哪几行被手动折叠了」的落点：localStorage，存的是一份**折叠清单**（不在清单里 = 展开）。
 *
 * 为什么存折叠而不是存展开：新出现的项目/连接默认就该展开。存展开清单的话「第一次见到这一行」
 * 必须猜一次默认值 —— remoteStore 原来那句 `had.size === 0 ? true : opened.has(id)` 猜的就是它，
 * 而刷新一次页面在它眼里也算「第一次」，于是折叠全丢（他第七十四轮报的「项目、远程服务器折叠没持久化」，
 * 另一半原因是 chatStore.refreshTree 每轮都直接写 open:true —— 发一条消息就全展开回来）。
 * 存折叠清单没有这个歧义，清单本身也短。
 *
 * 键前缀：p = 项目（含远程主机下面的远端项目，都是 projects 表的行），h = 远程连接。
 */
const KEY = 'kh.rail_collapsed';

function readSet() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw.map(String) : []);
  } catch {
    return new Set();
  }
}

/** 这一行现在是不是折叠的（没存过 = 展开） */
export function isCollapsed(kind, id) {
  return readSet().has(`${kind}${Number(id) || 0}`);
}

/** 记住一次折叠/展开（on=true 表示折叠起来） */
export function setCollapsed(kind, id, on) {
  const key = `${kind}${Number(id) || 0}`;
  const set = readSet();
  if (on) set.add(key);
  else set.delete(key);
  try {
    localStorage.setItem(KEY, JSON.stringify([...set]));
  } catch { /* 存不上也只是这次不记，不该打断界面 */ }
}
