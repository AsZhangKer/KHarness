/**
 * 文案表入口（第六十八轮）。
 *
 * `txt('settings.shell.note')` 取一句，`txt('x', { n: 3 })` 填 `{n}` 占位。
 * **找不到键时不许静默出空白**：那等于「界面上少了一行字但没人知道」，
 * 所以取不到时返回一个显眼的 `⟦键名⟧` 并 console.error 一条 —— 报错会被 logbus 收进「调试」悬浮窗，
 * 他开着自己那份 v…d 就能当场看见缺了哪条。
 *
 * 新增一个板块的表：在本目录建 `<板块>.js`（default 导出扁平键对象），加进下面 MODULES 即可。
 */
import common from './common';
import settings from './settings';
import chat from './chat';

const MODULES = { common, settings, chat };

const TABLE = new Map();
export const DUP_KEYS = [];
for (const [name, obj] of Object.entries(MODULES)) {
  for (const [k, v] of Object.entries(obj)) {
    if (TABLE.has(k)) DUP_KEYS.push(`${k}（同时出现在 ${TABLE.get(k).__from} 与 ${name}）`);
    TABLE.set(k, { text: String(v), __from: name });
  }
}

export function has(key) { return TABLE.has(String(key)); }
export function keys() { return [...TABLE.keys()].sort(); }

export function txt(key, params) {
  const hit = TABLE.get(String(key));
  if (!hit) {
    console.error(`[copy] 文案表里没有这个键：${key}`);
    return `⟦${key}⟧`;
  }
  let s = hit.text;
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  }
  return s;
}
