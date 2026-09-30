// 回收站：两类条目合在一个面板里
//  · 服务端快照（会话 / 项目）—— 删除前整份快照进 ai_trash，「恢复」是真能拿回消息的
//  · 本地台账（文件）—— 记的是撤销记录 undo_id，恢复走 /undo，只存在这台浏览器的 localStorage 里
import { reactive } from 'vue';
import { aiApi } from '../api';
import { toastErr } from '../utils/errText';

const KEY = 'nu_recycle_bin';

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]');
  } catch {
    return [];
  }
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state.items));
  } catch { /* ignore */ }
}

const state = reactive({ items: load(), open: false, server: [], stats: { items: 0, bytes: 0 }, loading: false });

export function recycleBin() {
  function add(item) {
    const rec = {
      id: item.id || `r-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      ...item,
      status: item.status || 'deleted',
      deleted_at: new Date().toISOString(),
    };
    // 同一 undo_id 只保留一条
    if (rec.undo_id) {
      const old = state.items.findIndex((x) => x.undo_id === rec.undo_id);
      if (old >= 0) state.items.splice(old, 1);
    }
    state.items.unshift(rec);
    persist();
    return rec;
  }
  function remove(id) {
    const i = state.items.findIndex((x) => x.id === id);
    if (i >= 0) state.items.splice(i, 1);
    persist();
  }
  function clear() {
    state.items = [];
    persist();
  }
  /**
   * 与撤销同步：文件从回收站恢复出去后，这一条就不再留在回收站列表里
   * （以前只把 status 改成 restored，行还挂在页面上，看着像没恢复成功）。
   */
  function markRestored(undoId) {
    if (!undoId) return;
    const before = state.items.length;
    state.items = state.items.filter((x) => x.undo_id !== undoId);
    if (state.items.length !== before) persist();
  }
  function find(undoId) {
    return state.items.find((x) => x.undo_id === undoId) || null;
  }

  /** 拉服务端那份（会话/项目快照）。失败只说明一声，本地那份照样能看 */
  async function refresh() {
    state.loading = true;
    try {
      const r = await aiApi.trashList();
      state.server = r?.items || [];
      state.stats = r?.stats || { items: 0, bytes: 0 };
    } catch (e) {
      toastErr(e, '回收站读取失败');
    } finally {
      state.loading = false;
    }
  }

  async function restoreTrash(item) {
    try {
      const r = await aiApi.trashRestore(item.id);
      await refresh();
      return r;
    } catch (e) {
      toastErr(e, '恢复失败');
      return null;
    }
  }

  async function removeTrash(item) {
    try {
      await aiApi.trashRemove(item.id);
      await refresh();
    } catch (e) {
      toastErr(e, '永久删除失败');
    }
  }

  async function clearTrash() {
    try {
      await aiApi.trashClear();
      await refresh();
    } catch (e) {
      toastErr(e, '清空失败');
    }
  }

  return { state, add, remove, clear, markRestored, find, refresh, restoreTrash, removeTrash, clearTrash };
}
