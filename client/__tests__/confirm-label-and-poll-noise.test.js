/**
 * 第六十二轮之后他真机撞到的两条（2026-10-11）：
 * ① 启用 FULL-SEND 的确认弹窗，按钮上写着「删除」；
 * ② 后台长轮询 GET /ai/browser/poll 一超时，就当「请求失败」弹红色报错窗。
 *
 * ①用真挂载验文案，②用源码扫验「这条必须是 silent 且余量够」——
 * 因为根子都是「一个标志被顺手当成两件事用」：danger 既当红按钮又当删除，
 * 拦截器把每一个失败请求都当成用户操作失败。下次再加红按钮/加后台轮询，
 * 少配一样就会被这里抓到，而不是等他真机再撞一次。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import fs from 'node:fs';
import path from 'node:path';
import ConfirmDialog from '../src/ui/ConfirmDialog.vue';
import { confirmDialog, confirmState } from '../src/stores/confirm';

const SRC = path.resolve(__dirname, '../src');

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(vue|js)$/.test(name)) out.push(p);
  }
  return out;
}

function confirmCallSites() {
  const hits = [];
  for (const file of walk(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    const re = /confirmDialog\s*\(/g;
    let m;
    while ((m = re.exec(text))) {
      // 选项对象是这一调用的最后一个花括号段，取到配对闭合为止就够（源码里没有嵌套对象）
      const tail = text.slice(m.index, m.index + 1500);
      const opt = tail.match(/\{[^{}]*\}/g) || [];
      const withDanger = opt.find((o) => /danger:\s*true/.test(o));
      if (withDanger) hits.push({ file: path.relative(SRC, file), snippet: withDanger });
    }
  }
  return hits;
}

let inst = null;
function mountConfirm() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp({ render: () => h(ConfirmDialog) });
  app.mount(host);
  inst = { app, host };
  return nextTick();
}

afterEach(() => {
  if (inst) { inst.app.unmount(); inst.host.remove(); inst = null; }
  document.querySelectorAll('.k-modal-root, .k-modal').forEach((n) => n.remove());
});

function footerBtn() {
  const d = [...document.querySelectorAll('.k-modal')].pop();
  return d.querySelector('.k-modal-foot button:last-child').textContent.trim();
}

describe('确认弹窗的按钮文案', () => {
  it('danger 只决定红不红，不决定写什么字（不传 okText 就是「确定」）', async () => {
    await mountConfirm();
    confirmDialog('打开 FULL-SEND 审批档？', { title: '启用 FULL-SEND', danger: true });
    await nextTick();
    expect(footerBtn()).toBe('确定');
    expect(confirmState().danger).toBe(true);
  });

  it('调用点给了 okText 就照它显示（启用类与删除类各验一条）', async () => {
    await mountConfirm();
    confirmDialog('启用？', { danger: true, okText: '开启这一档' });
    await nextTick();
    expect(footerBtn()).toBe('开启这一档');
    confirmDialog('删除？', { danger: true, okText: '删除' });
    await nextTick();
    expect(footerBtn()).toBe('删除');
  });

  it('源码里每一个红按钮确认都自带 okText（不许再退回「danger=删除」）', () => {
    const sites = confirmCallSites();
    expect(sites.length).toBeGreaterThan(0);
    const missing = sites.filter((s) => !/okText:/.test(s.snippet)).map((s) => `${s.file} :: ${s.snippet.slice(0, 80)}`);
    expect(missing, '这些 danger 确认没给按钮文案：\n' + missing.join('\n')).toEqual([]);
  });
});

describe('后台长轮询不许刷报错窗', () => {
  const apiSrc = fs.readFileSync(path.join(SRC, 'api/index.js'), 'utf8');

  it('browser/poll 标了 silent，且客户端超时明显长于服务端 25s 的挂起', () => {
    const line = apiSrc.split('\n').find((l) => l.includes("'/ai/browser/poll'"));
    expect(line).toBeTruthy();
    expect(line).toMatch(/silent:\s*true/);
    const ms = Number((line.match(/timeout:\s*(\d+)/) || [])[1]);
    expect(ms).toBeGreaterThanOrEqual(60000);
  });

  it('另两条长轮询（Computer Use 事件流）也保持 silent', () => {
    const line = apiSrc.split('\n').find((l) => l.includes('/computer/events'));
    expect(line).toMatch(/silent:\s*true/);
  });
});
