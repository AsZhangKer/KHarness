/**
 * ⑤「管理模型」弹窗（第六十二轮）。
 *
 * 挂的是真组件、真点击处理：打开弹窗 → 已有的必须默认勾上 → 取消勾选 = 将删除 →
 * 勾上远程新项 = 将新增 → 点确定真的把两个接口都打出去（不弹二次确认）。
 * 只挂起来看不点一遍是不够的：这一改动把「删除」藏进了一个本来只会「添加」的弹窗里，
 * 勾错方向不会报错，只会静默少删或多删。
 *
 * 说明：jsdom 的 click 不走命中测试，所以这条只证明接线对，不证明他点得到 ——
 * 视口里的真手感仍由他在装机版上点。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import ManageModelsPage from '../src/features/models/ManageModelsPage.vue';

const REMOTE = [{ id: 'mock-a' }, { id: 'mock-b' }, { id: 'mock-new' }];

let models, calls;

vi.mock('../src/api', () => ({
  aiApi: {
    getProviders: async () => [{ id: 1, name: '假上游', base_url: 'http://127.0.0.1:1/v1', api_style: 'openai', model_count: 2 }],
    getModels: async () => models,
    getRemoteModels: async () => ({ list: REMOTE }),
    batchCreateModels: async (b) => {
      calls.create.push(b);
      return { added: b.models.length, skipped: 0, errors: calls.createErrors };
    },
    batchDeleteModels: async (ids) => {
      calls.remove.push([...ids]);
      return { deleted: ids.length, chats_affected: ids.length };
    },
  },
  settingsApi: { get: async () => ({}), update: async () => ({}) },
}));

const live = [];

function mountPage() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp({ render: () => h(ManageModelsPage) });
  app.mount(host);
  live.push({ app, host });
  return host;
}

afterEach(() => {
  while (live.length) {
    const { app, host } = live.pop();
    app.unmount();
    host.remove();
  }
  // 弹窗是 Teleport 到 body 的，还带 <Transition>：退场节点可能滞留在 body 里，
  // 不清干净，下一个用例查到的就是上一份 DOM（我第一次跑就是这样全绿变全红）。
  document.querySelectorAll('.k-modal-root, .k-modal').forEach((n) => n.remove());
});

const wait = () => nextTick().then(() => nextTick());

function dialog() {
  const all = [...document.querySelectorAll('.k-modal')];
  return all[all.length - 1];
}

function rows() {
  return [...dialog().querySelectorAll('.remote-item')].map((el) => ({
    text: el.textContent.trim(),
    checked: !!el.querySelector('input[type=checkbox]')?.checked,
    line: el.className.includes('dying'),
  }));
}

async function openDialog(host) {
  const btn = [...host.querySelectorAll('button')].find((b) => b.textContent.trim() === '管理模型');
  btn.click();
  await wait();
  return dialog();
}

function toggleRow(id) {
  const el = [...dialog().querySelectorAll('.remote-item')].find((x) => x.textContent.includes(id));
  const box = el.querySelector('input[type=checkbox]');
  box.checked = !box.checked;
  box.dispatchEvent(new Event('change'));
  return nextTick();
}

function footer() {
  return [...dialog().querySelectorAll('.mg-sum')].map((e) => e.textContent.trim()).join('');
}

async function clickBtn(label) {
  const btn = [...dialog().querySelectorAll('button')].find((b) => b.textContent.trim() === label);
  expect(btn, `找不到按钮 ${label}`).toBeTruthy();
  btn.click();
  await wait();
}

beforeEach(() => {
  models = [
    { id: 11, provider_id: 1, model_id: 'mock-a', display_name: 'A 模型', disabled: 0 },
    { id: 12, provider_id: 1, model_id: 'mock-b', display_name: 'mock-b', disabled: 0 },
  ];
  calls = { create: [], remove: [], createErrors: [] };
});

describe('管理模型弹窗', () => {
  it('已有的默认勾上并带「已有」牌，远程新项默认不勾', async () => {
    const host = mountPage();
    await wait();
    await openDialog(host);
    const r = rows();
    expect(r.map((x) => x.checked)).toEqual([true, true, false]);
    expect(r[0].text).toContain('已有');
    expect(r[0].text).toContain('A 模型');       // 显示名用库里那份，不是远程的裸 id
    expect(r[2].text).toContain('mock-new');
    expect(footer()).toBe('将新增 0 / 将删除 0');
  });

  it('取消勾选一个已有的 = 将删除，点确定直接办完、不弹二次确认', async () => {
    const host = mountPage();
    await wait();
    await openDialog(host);
    await toggleRow('mock-b');
    const row = rows().find((x) => x.text.includes('mock-b'));
    expect(row.checked).toBe(false);
    expect(row.line).toBe(true);
    expect(row.text).toContain('将删除');
    expect(footer()).toBe('将新增 0 / 将删除 1');
    await clickBtn('确定');
    expect(calls.remove).toEqual([[12]]);
    expect(document.querySelectorAll('.k-modal').length).toBeLessThanOrEqual(1);   // 没有多出一步确认
  });

  it('勾上远程新项 = 将新增，一次确定把加和删都提交', async () => {
    const host = mountPage();
    await wait();
    await openDialog(host);
    await toggleRow('mock-new');
    await toggleRow('mock-a');
    expect(footer()).toBe('将新增 1 / 将删除 1');
    await clickBtn('确定');
    expect(calls.create[0].provider_id).toBe(1);
    expect(calls.create[0].models.map((m) => m.model_id)).toEqual(['mock-new']);
    // 没单独设参数的项也要显式带上默认（支持思考 + native），否则服务端默认一改这里就静默跟着变
    expect(calls.create[0].models[0]).toMatchObject({ model_id: 'mock-new', display_name: 'mock-new', supports_thinking: 1, tool_style: 'native' });
    expect(calls.remove).toEqual([[11]]);
  });

  it('服务端逐条回执原样回显，弹窗不关', async () => {
    calls.createErrors = ['mock-new: 已存在'];
    const host = mountPage();
    await wait();
    await openDialog(host);
    await toggleRow('mock-new');
    await clickBtn('确定');
    const errs = [...dialog().querySelectorAll('.mg-errors .err-text')].map((e) => e.textContent.trim());
    expect(errs).toEqual(['mock-new: 已存在']);
    expect(rows().length).toBe(3);   // 还开着，看得见是哪几条没进去
  });

  it('筛选框按 ID 与显示名模糊过滤，全选/清空只作用在筛出来的那批', async () => {
    const host = mountPage();
    await wait();
    await openDialog(host);
    const input = dialog().querySelector('.remote-head input');
    input.value = 'A 模型';
    input.dispatchEvent(new Event('input'));
    await wait();
    expect(rows().map((x) => x.text)).toEqual([expect.stringContaining('A 模型')]);
    await clickBtn('清空');                     // 只清筛出来的这条 → 将删除 1，没筛出来的不能被顺手带上
    expect(footer()).toBe('将新增 0 / 将删除 1');
    await clickBtn('只留已有');
    expect(footer()).toBe('将新增 0 / 将删除 0');
    await clickBtn('全选');                     // 筛着的时候全选也只勾筛出来的（这里筛出来的本来就是勾着的）
    expect(footer()).toBe('将新增 0 / 将删除 0');
  });

  it('手动粘贴那批当场预览有几个是库里没有的，确定时一起加', async () => {
    const host = mountPage();
    await wait();
    await openDialog(host);
    const manual = dialog().querySelector('.k-input');
    // 单行 input 会把值里的换行吃掉（HTML 规范如此），所以这里按界面真实能粘进来的样子测：逗号混全角逗号
    manual.value = 'mock-a，hand-one, hand-two';
    manual.dispatchEvent(new Event('input'));
    await wait();
    expect(dialog().textContent).toContain('解析出 3 个，其中 2 个库里还没有');
    expect(footer()).toBe('将新增 2 / 将删除 0');
    await clickBtn('确定');
    expect(calls.create[0].models.map((m) => m.model_id)).toEqual(['hand-one', 'hand-two']);
  });

  it('一条都没改时点确定什么都不发', async () => {
    const host = mountPage();
    await wait();
    await openDialog(host);
    await clickBtn('确定');
    expect(calls.create).toEqual([]);
    expect(calls.remove).toEqual([]);
  });
});
