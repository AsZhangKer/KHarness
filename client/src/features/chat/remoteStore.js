/**
 * 远程主机（SSH/SFTP）的界面状态。
 *
 * 左栏「远程连接」这一棵树的数据源：连接列表 + 每台机器展开没有。
 * 项目与会话不在这里 —— 它们仍然走 chatStore 那一套（远程只是多带一个 remote_id），
 * 这样消息流、审批、撤销、监工全都不用为远程重写一遍。
 *
 * 展开状态存 localStorage：连接是长期资产，谁习惯展开哪几台不该每次重开都丢。
 */
import { reactive } from 'vue';
import { aiApi } from '../../api';
import { toast } from '../../stores/toast';

const OPEN_KEY = 'kh.remote_open_hosts';

const state = reactive({
  hosts: [],
  loaded: false,
  testingId: 0,
  busy: false,
});

function openSet() {
  try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || '[]')); } catch (e) { return new Set(); }
}
function saveOpen() {
  localStorage.setItem(OPEN_KEY, JSON.stringify(state.hosts.filter((h) => h.open).map((h) => h.id)));
}

async function refresh() {
  state.busy = true;
  try {
    const rows = (await aiApi.getRemoteHosts()) || [];
    const opened = openSet();
    // 第一次拿到某台机器时默认展开：只建了一条连接的人不想再多点一下
    const had = new Set(state.hosts.map((h) => h.id));
    state.hosts = rows.map((h) => ({ ...h, open: had.size === 0 ? true : opened.has(h.id) }));
    state.loaded = true;
  } catch (e) {
    /* api 拦截器已经弹过 toast */
  } finally {
    state.busy = false;
  }
}

function hostOf(id) {
  return state.hosts.find((h) => h.id === Number(id)) || null;
}

function toggle(id) {
  const h = hostOf(id);
  if (!h) return;
  h.open = !h.open;
  saveOpen();
}

async function create(form) {
  const r = await aiApi.createRemoteHost(form);
  toast(`已添加连接 ${r?.name || ''}`, 'success');
  await refresh();
  return r;
}

async function update(id, form) {
  const r = await aiApi.updateRemoteHost(id, form);
  toast('连接已更新', 'success');
  await refresh();
  return r;
}

/**
 * 删除连接。后端在它还挂着项目/会话时回 409，这里把「会带走多少东西」原样转成一次确认，
 * 确认过再带 confirm=1 级联删 —— 不留孤儿数据是硬要求。
 */
async function remove(host, confirmed = false) {
  if (!confirmed && (host.project_count || host.chat_count)) {
    const bits = [];
    if (host.project_count) bits.push(`${host.project_count} 个项目`);
    if (host.chat_count) bits.push(`${host.chat_count} 个会话`);
    if (!window.confirm(`删除连接「${host.name}」会连带删除它下面的 ${bits.join('、')}（本机记录，远端文件不动）。确定？`)) return false;
  }
  await aiApi.deleteRemoteHost(host.id, true);
  toast(`已删除连接「${host.name}」`, 'success');
  await refresh();
  return true;
}

/** 测试连接：成功回显远端信息并顺手把家目录填进起始目录；失败把真因留在 last_error 上（列表里黄三角悬浮可见） */
async function test(host) {
  if (state.testingId) return null;
  state.testingId = host.id;
  try {
    const r = await aiApi.testRemoteHost(host.id);
    if (r && r.ok) toast(`连接正常：${String(r.info || '').split('\n')[0]}`, 'success');
    else toast(String((r && r.error) || '连不上'), 'error');
    await refresh();
    return r;
  } catch (e) {
    return null;
  } finally {
    state.testingId = 0;
  }
}

export const remoteStore = { state, refresh, toggle, hostOf, create, update, remove, test };
