<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1>轨迹</h1>
        <p>思维链记录 + 跨会话检索</p>
      </div>
    </header>

    <section class="card">
      <div class="filters">
        <input v-model="kw" class="input grow" placeholder="关键词（支持正则）" @keydown.enter="search" />
        <label class="check"><input class="k-check" v-model="useRegex" type="checkbox" /> 正则</label>
        <KDropdown :items="KIND_ITEMS" v-model="kind" :label="kindLabel" width="150px" />
        <input v-model="modelFilter" class="input" placeholder="模型" />
        <button class="btn primary" type="button" :disabled="loading" @click="search">搜索</button>
      </div>

      <div v-if="loading" class="muted">检索中…</div>
      <div v-else-if="!results.length" class="muted">无结果</div>
      <div v-else class="results">
        <article v-for="(r, i) in results" :key="i" class="item">
          <div class="meta">
            <span class="badge">{{ r.role || r.kind }}</span>
            <span class="mono muted">{{ r.model_name || r.model || '' }}</span>
            <span class="muted">{{ r.created_at || r.time || '' }}</span>
            <button class="btn sm" type="button" @click="jump(r)">回跳会话</button>
          </div>
          <div class="body">{{ r.content || r.text || r.snippet }}</div>
        </article>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { aiApi } from '../../api';
import KDropdown from '../../ui/KDropdown.vue';

const KIND_ITEMS = [
  { value: '', label: '全部分类' },
  { value: 'user', label: '用户' },
  { value: 'assistant', label: '助手' },
  { value: 'tool', label: '工具' },
  { value: 'reason', label: '思考' },
];

const router = useRouter();
const route = useRoute();
const kw = ref('');
const useRegex = ref(false);
const kind = ref('');
const kindLabel = computed(() => KIND_ITEMS.find((x) => x.value === kind.value)?.label || '全部分类');
const modelFilter = ref('');
const results = ref([]);
const loading = ref(false);

onMounted(() => {
  // 支持 /trace?q=xxx 直接带词进来就搜
  if (route.query.q) { kw.value = String(route.query.q); search(); }
});

async function search() {
  loading.value = true;
  try {
    const params = {
      q: kw.value || undefined,
      keyword: kw.value || undefined,
      regex: useRegex.value ? 1 : undefined,
      kind: kind.value || undefined,
      model: modelFilter.value || undefined,
    };
    const res = await aiApi.searchTrace(params);
    results.value = res?.list || res?.items || res || [];
    if (!Array.isArray(results.value)) results.value = [];
  } finally {
    loading.value = false;
  }
}

function jump(r) {
  const id = r.chat_id || r.chatId;
  if (!id) return;
  // 带上消息 id，聊天页会展开历史、滚过去并闪一下
  const msg = r.message_id || r.msg_id || r.id || '';
  router.push({ name: 'Chat', params: { id: String(id) }, query: msg ? { msg: String(msg) } : undefined });
}
</script>

<style scoped>
.page { padding: 24px 28px 40px; max-width: 1000px; margin: 0 auto; }
.page-head { margin-bottom: 16px; }
.page-head h1 { margin: 0; font-size: 20px; }
.page-head p { margin: 4px 0 0; color: var(--text-3); font-size: 12px; }
.card {
  background: var(--bg-elev);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  padding: 14px;
}
.filters {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
  margin-bottom: 14px;
}
.input {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
}
.grow { flex: 1; min-width: 200px; }
.check { display: flex; gap: 6px; align-items: center; color: var(--text-3); font-size: 12px; }
.results { display: flex; flex-direction: column; gap: 10px; }
.item {
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  background: var(--bg-panel);
}
.meta {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
}
.body {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
}
.badge {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--bg-active);
  font-size: 11px;
}
.mono { font-family: var(--mono); font-size: 11px; }
.muted { color: var(--text-3); font-size: 12px; }
.btn {
  border: 1px solid var(--border);
  background: var(--bg-hover);
  color: var(--text);
  border-radius: var(--radius-xs);
  padding: 6px 12px;
  font-size: 12px;
}
.btn.sm { padding: 4px 8px; font-size: 11px; margin-left: auto; }
.btn.primary { background: var(--accent); border-color: transparent; color: var(--on-accent); font-weight: 600; }
</style>
