/**
 * ⑦ 多模型池挪进实验室（第六十二轮）：半废弃的入口必须真的收起来。
 *
 * 挂真 ChatComposer，输入 '/' 看补全列表：闸关着时 /pool 和 /supervise 都不该出现，
 * 开了才回来。这一条之所以要挂起来点：这两项是靠一个 computed 过滤掉的，
 * 漏改一处不会出现报错，只会出现「列表里看不到但敲进去照样能用」或者反过来。
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { createApp, h, nextTick, ref } from 'vue';
import ChatComposer from '../src/features/chat/ChatComposer.vue';
import { uiPrefs } from '../src/stores/prefs';

vi.mock('../src/api', () => ({
  aiApi: new Proxy({}, { get: () => async () => ({}) }),
  settingsApi: { get: async () => ({}), update: async () => ({}) },
}));

beforeAll(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});

let inst = null;
const draftText = ref('/');

function mountComposer() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp({
    render: () => h(ChatComposer, {
      modelValue: draftText.value,
      'onUpdate:modelValue': (v) => { draftText.value = v; },
    }),
  });
  app.mount(host);
  inst = { app, host };
  return nextTick().then(() => nextTick());
}

afterEach(() => {
  if (inst) { inst.app.unmount(); inst.host.remove(); inst = null; }
  uiPrefs.state.poolOn = false;
  uiPrefs.state.supervisorOn = false;
});

function cmdNames() {
  return [...document.querySelectorAll('.cmd-item .cmd-name')].map((e) => e.textContent.trim());
}

describe('实验室闸与 / 命令补全', () => {
  it('两道闸都关着时，/pool 与 /supervise 不进补全列表，常用命令照常在', async () => {
    uiPrefs.state.poolOn = false;
    uiPrefs.state.supervisorOn = false;
    await mountComposer();
    const names = cmdNames();
    expect(names).not.toContain('/pool');
    expect(names).not.toContain('/supervise');
    expect(names).toContain('/mode');
    expect(names.length).toBeGreaterThan(3);
  });

  it('实验室打开多模型池后 /pool 回来，且只影响这一项', async () => {
    uiPrefs.state.poolOn = true;
    uiPrefs.state.supervisorOn = false;
    await mountComposer();
    const names = cmdNames();
    expect(names).toContain('/pool');
    expect(names).not.toContain('/supervise');
  });

  it('筛成 /po 时关着闸仍然搜不到它（不是只是不显示首屏前 8 条）', async () => {
    uiPrefs.state.poolOn = false;
    draftText.value = '/po';
    await mountComposer();
    expect(cmdNames()).toEqual([]);
    draftText.value = '/po';
    uiPrefs.state.poolOn = true;
    await nextTick();
    expect(cmdNames()).toEqual(['/pool']);
  });
});
