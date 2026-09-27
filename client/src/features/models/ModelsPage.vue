<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1>模型库</h1>
        <p>可用状态、首字延迟、搜索排序、批量测试</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="$router.push('/models/manage')">模型管理</button>
        <button class="btn" type="button" @click="ping">Ping</button>
        <button class="btn" type="button" :disabled="!selected.length" @click="testMany">测试选中</button>
        <button class="btn primary" type="button" :disabled="loading" @click="testAll">测试全部</button>
      </div>
    </header>

    <div class="toolbar">
      <input v-model="q" class="input" placeholder="搜索模型 / 提供商" />
      <KDropdown :items="SORT_ITEMS" v-model="sortBy" width="140px" />
    </div>

    <KEmpty v-if="!loading && !rows.length" title="还没有模型" desc="先到「模型管理」导入提供商与模型。" />

    <div v-else class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th style="width:36px" class="c-center"><input class="k-check" type="checkbox" :checked="allChecked" @change="toggleAll" /></th>
            <th>模型</th>
            <th>提供商</th>
            <th>延迟</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in filtered" :key="m.id">
            <td class="c-center"><input class="k-check" type="checkbox" :checked="selected.includes(m.id)" @change="toggle(m.id)" /></td>
            <td>
              <div class="name">{{ m.display_name || m.model_id }}</div>
              <div class="mono muted">{{ m.model_id }}</div>
            </td>
            <td>{{ m.provider_name || providerName(m.provider_id) }}</td>
            <td class="mono">{{ m.latency_ms != null ? m.latency_ms + ' ms' : '—' }}</td>
            <td>
              <span class="badge" :class="statusOf(m)">{{ statusOf(m) }}</span>
            </td>
            <td class="row-actions">
              <button class="btn sm" type="button" @click="testOne(m)">测试</button>
              <button class="btn sm" type="button" @click="$router.push('/chat?model=' + m.id)">对话</button>
              <button class="btn sm" type="button" @click="toggleDisabled(m)">{{ m.disabled ? '启用' : '禁用' }}</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { aiApi } from '../../api';
import { toast } from '../../stores/toast';
import KEmpty from '../../ui/KEmpty.vue';
import KDropdown from '../../ui/KDropdown.vue';

const SORT_ITEMS = [
  { value: 'latency', label: '按延迟' },
  { value: 'name', label: '按名称' },
  { value: 'status', label: '按状态' },
];

const rows = ref([]);
const providers = ref([]);
const q = ref('');
const sortBy = ref('latency');
const selected = ref([]);
const loading = ref(false);

const filtered = computed(() => {
  let list = rows.value.slice();
  if (q.value.trim()) {
    const k = q.value.trim().toLowerCase();
    list = list.filter(
      (m) =>
        String(m.display_name || m.model_id).toLowerCase().includes(k) ||
        String(m.provider_name || providerName(m.provider_id)).toLowerCase().includes(k)
    );
  }
  if (sortBy.value === 'latency') list.sort((a, b) => (a.latency_ms ?? 1e9) - (b.latency_ms ?? 1e9));
  else if (sortBy.value === 'name') list.sort((a, b) => String(a.display_name || a.model_id).localeCompare(String(b.display_name || b.model_id)));
  else list.sort((a, b) => String(statusOf(a)).localeCompare(String(statusOf(b))));
  return list;
});

const allChecked = computed(() => filtered.value.length > 0 && filtered.value.every((m) => selected.value.includes(m.id)));

onMounted(load);

async function load() {
  loading.value = true;
  try {
    const res = await aiApi.getModels();
    rows.value = res?.list || [];
    providers.value = (await aiApi.getProviders()) || [];
  } finally {
    loading.value = false;
  }
}

function providerName(id) {
  return providers.value.find((p) => p.id === id)?.name || '';
}

function statusOf(m) {
  if (m.disabled) return 'disabled';
  if (m.status === 'ok' || m.test_status === 'ok') return 'ok';
  if (m.status === 'error' || m.test_status === 'error') return 'error';
  return 'untested';
}

function toggle(id) {
  const i = selected.value.indexOf(id);
  if (i >= 0) selected.value.splice(i, 1);
  else selected.value.push(id);
}

function toggleAll(e) {
  selected.value = e.target.checked ? filtered.value.map((m) => m.id) : [];
}

async function testOne(m) {
  loading.value = true;
  try {
    await aiApi.testOne(m.id);
    await load();
    toast('测试完成', 'success');
  } finally {
    loading.value = false;
  }
}

async function testMany() {
  loading.value = true;
  try {
    await aiApi.testMany(selected.value);
    await load();
    toast('批量测试完成', 'success');
  } finally {
    loading.value = false;
  }
}

async function testAll() {
  loading.value = true;
  try {
    await aiApi.testAll();
    await load();
    toast('全部测试完成', 'success');
  } finally {
    loading.value = false;
  }
}

async function ping() {
  await aiApi.pingProviders();
  await load();
}

async function toggleDisabled(m) {
  await aiApi.toggleModelDisabled(m.id, !m.disabled);
  await load();
}
</script>

<style scoped>
.page { padding: 24px 28px 40px; max-width: 1200px; margin: 0 auto; }
.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}
.page-head h1 { margin: 0; font-size: 20px; }
.page-head p { margin: 4px 0 0; color: var(--text-3); font-size: 12px; }
.page-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.toolbar { display: flex; gap: 8px; margin-bottom: 12px; }
.input {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
}
.table-wrap {
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  overflow: auto;
  background: var(--bg-elev);
}
.table { width: 100%; border-collapse: collapse; }
.table th, .table td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-soft);
  text-align: left;
  font-size: 12px;
}
.table th { color: var(--text-3); font-weight: 500; }
.name { font-weight: 500; }
.mono { font-family: var(--mono); font-size: 11px; }
.muted { color: var(--text-3); }
.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  background: var(--bg-active);
  color: var(--text-2);
}
.badge.ok { color: var(--ok); }
.badge.error { color: var(--danger); }
.badge.disabled { color: var(--text-3); }
.row-actions { display: flex; gap: 6px; }
.btn {
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  border-radius: var(--radius-xs);
  padding: 6px 12px;
  font-size: 12px;
}
.btn.sm { padding: 4px 8px; font-size: 11px; }
.btn.primary { background: var(--accent); border-color: transparent; color: var(--on-accent); font-weight: 600; }
</style>
