<template>
  <KModal :open="open" title="选择模型" width="640px" @close="$emit('close')">
    <div ref="listEl" class="picker-body">
      <div class="picker-bar">
        <input v-model="q" class="nu-input search" placeholder="搜索模型 / 提供商…" />
        <button
          v-if="badCount"
          class="k-btn sm fold"
          type="button"
          :title="showBad ? '隐藏异常模型' : '展开查看异常模型'"
          @click="showBad = !showBad"
        >
          <i class="fas" :class="showBad ? 'fa-eye-slash' : 'fa-eye'"></i>
          {{ showBad ? '收起异常' : `展开异常 (${badCount})` }}
        </button>
      </div>
      <div class="pinned" v-if="pinnedModels.length">
        <div class="sec-label">固定</div>
        <button
          v-for="m in pinnedModels"
          :key="'p' + m.id"
          class="row"
          :class="{ active: m.id === modelId, err: m.status === 'error' }"
          type="button"
          @click="pick(m)"
          @contextmenu.prevent="togglePin(m, false)"
        >
          <i class="fas fa-thumbtack pin"></i>
          <span class="name">{{ m.display_name || m.model_id }}</span>
          <span class="prov">{{ m.provider_name }}</span>
          <span class="lat" :class="latCls(m)">{{ latText(m) }}</span>
        </button>
      </div>

      <div v-for="g in groups" :key="g.provider" class="group">
        <div class="sec-label">{{ g.provider }}</div>
        <button
          v-for="m in g.items"
          :key="m.id"
          class="row"
          :class="{ active: m.id === modelId, err: m.status === 'error' }"
          type="button"
          @click="pick(m)"
          @contextmenu.prevent="togglePin(m, !m.pinned)"
        >
          <i class="fas thumb" :class="m.pinned ? 'fa-thumbtack pin' : 'fa-circle'"></i>
          <span class="name">{{ m.display_name || m.model_id }}</span>
          <span class="mid">{{ m.model_id }}</span>
          <span class="badge" :class="m.status || ''">{{ statusText(m) }}</span>
          <span class="lat" :class="latCls(m)">{{ latText(m) }}</span>
        </button>
      </div>
      <p v-if="!groups.length && !pinnedModels.length && badCount" class="muted fold-hint">
        匹配的 {{ badCount }} 个模型均为异常，已折叠
        <button class="k-btn sm" type="button" @click="showBad = true">展开异常模型</button>
      </p>
      <p v-else-if="!groups.length && !pinnedModels.length" class="muted">无匹配模型</p>
    </div>
  </KModal>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import KModal from '../../ui/KModal.vue';

const props = defineProps({
  open: Boolean,
  models: { type: Array, default: () => [] },
  modelId: { type: Number, default: null },
});
const emit = defineEmits(['close', 'select', 'pin']);

const q = ref('');
const showBad = ref(false);
const listEl = ref(null);

watch(
  () => props.open,
  (v) => {
    if (!v) return;
    q.value = '';
    showBad.value = false;
    // 打开时把当前模型滚到中间（异常模型会被折叠，所以当前模型始终保留在列表里）
    nextTick(() => scrollToActive());
  }
);

function scrollToActive() {
  const el = listEl.value?.querySelector?.('.row.active');
  if (el) el.scrollIntoView({ block: 'center' });
}

const matched = computed(() => {
  const s = q.value.trim().toLowerCase();
  if (!s) return props.models;
  return props.models.filter((m) =>
    [m.display_name, m.model_id, m.provider_name].some((x) => String(x || '').toLowerCase().includes(s))
  );
});

/** 异常模型默认折叠（旧版行为）；当前正在用的那个不折叠，否则无法定位 */
const listed = computed(() =>
  showBad.value ? matched.value : matched.value.filter((m) => m.status !== 'error' || m.id === props.modelId)
);

const badCount = computed(() => matched.value.length - listed.value.length);

const pinnedModels = computed(() => listed.value.filter((m) => m.pinned));

const groups = computed(() => {
  const map = new Map();
  for (const m of listed.value) {
    const k = m.provider_name || '其他';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(m);
  }
  return [...map.entries()].map(([provider, items]) => ({
    provider,
    items: items.slice().sort((a, b) => String(a.display_name || a.model_id).localeCompare(String(b.display_name || b.model_id))),
  }));
});

function pick(m) {
  emit('select', m);
  emit('close');
}
function togglePin(m, on) {
  emit('pin', m, on);
}
function statusText(m) {
  return { ok: '可用', error: '异常', untested: '未测' }[m.status] || '未测';
}
function latText(m) {
  if (m.status === 'error') return '异常';
  if (m.latency_ms == null) return '';
  return `${m.latency_ms}ms`;
}
function latCls(m) {
  if (m.status === 'error') return 'bad';
  if (m.latency_ms == null) return '';
  if (m.latency_ms <= 1500) return 'ok';
  if (m.latency_ms <= 4000) return 'mid';
  return 'slow';
}
</script>

<style scoped>
.picker-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  /* 搜索框 + 「展开异常」钉在弹窗正上方，列表往下滚也不跟着走。
     真正的滚动容器是 KModal 的 .k-modal-body（overflow:auto + padding:16px），
     所以这里用 top:-16px 抵掉那段 padding，再用负 margin 让条子铺满整宽 ——
     这样滚过来的行是从它底下穿过去的，不会从 padding 缝里露出一截。 */
  position: sticky;
  top: -16px;
  z-index: 2;
  margin: -16px -16px 10px;
  padding: 16px 16px 8px;
  background: var(--surface-pop);
}
.search { flex: 1; min-width: 0; margin-bottom: 0; }
.fold { flex-shrink: 0; white-space: nowrap; }
.fold-hint { display: flex; align-items: center; gap: 10px; }
.sec-label {
  font-size: 11px;
  color: var(--text-3);
  padding: 8px 4px 4px;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border-radius: var(--radius-xs);
  text-align: left;
  color: var(--text-2);
}
.row:hover { background: var(--bg-hover); color: var(--text); }
.row.active { background: var(--bg-active); color: var(--text); }
.row.err { opacity: 0.7; }
.name { font-weight: 500; color: var(--text); min-width: 120px; }
.mid {
  flex: 1;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.prov { font-size: 11px; color: var(--text-3); }
.badge {
  font-size: 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 6px;
}
.badge.ok { color: var(--ok); border-color: var(--ok-line); }
.badge.error { color: var(--danger); border-color: var(--danger-line); }
.lat { font-family: var(--mono); font-size: 11px; width: 56px; text-align: right; }
.lat.ok { color: var(--ok); }
.lat.mid { color: var(--warn); }
.lat.slow { color: var(--danger); }
.lat.bad { color: var(--danger); }
.pin { color: var(--text-2); font-size: 11px; }
.thumb { width: 12px; opacity: 0.35; font-size: 8px; }
.muted { color: var(--text-3); }
</style>
