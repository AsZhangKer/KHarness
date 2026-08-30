<template>
  <div class="ai-status-page">
    <div class="page-header ai-header">
      <h1><i class="fas fa-robot"></i> 免费LLM API</h1>
      <span class="ai-updated">上次检测：{{ lastTestedAt ? formatTime(lastTestedAt) : '尚未检测' }}</span>
    </div>

    <div class="ai-toolbar">
      <div class="ai-search">
        <i class="fas fa-search"></i>
        <input v-model="search" placeholder="搜索提供商 / 模型 / 备注 / 回复...">
      </div>
      <div class="ai-sort">
        <label>排序</label>
        <select v-model="sortBy">
          <option value="latency">首字延迟（快→慢）</option>
          <option value="provider">提供商（A~Z）</option>
          <option value="model">模型 ID（A~Z）</option>
          <option value="name">展示名称（A~Z）</option>
          <option value="created">添加时间（新→旧）</option>
        </select>
      </div>
      <div class="view-toggle">
        <button class="btn btn-small" :class="viewMode === 'list' ? 'btn-primary' : ''" @click="viewMode = 'list'" title="列表视图"><i class="fas fa-list"></i></button>
        <button class="btn btn-small" :class="viewMode === 'board' ? 'btn-primary' : ''" @click="viewMode = 'board'" title="平铺视图"><i class="fas fa-th-large"></i></button>
      </div>
      <button class="btn btn-small" @click="load" :disabled="loading">
        <i class="fas" :class="loading ? 'fa-spinner fa-spin' : 'fa-rotate-right'"></i> 刷新
      </button>
      <button class="btn btn-small" @click="openPlaygroundFromList" title="打开聊天界面（自动恢复上次会话）">
        <i class="fas fa-play"></i> Playground
      </button>
      <button class="btn btn-small" @click="goAdmin" title="管理提供商与模型（增删改、测试）">
        <i class="fas fa-screwdriver-wrench"></i> 管理模型
      </button>
    </div>

    <div v-if="filteredList.length">
      <div v-if="viewMode === 'list'" class="ai-table-wrap">
        <table class="data-table ai-table">
          <thead>
            <tr>
              <th>状态</th>
              <th>提供商</th>
              <th>模型名称</th>
              <th>模型 ID</th>
              <th>首字延迟</th>
              <th>备注</th>
              <th>官网</th>
              <th>API Key</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="m in filteredList" :key="m.id">
              <tr>
                <td>
                  <span class="ai-badge" :class="'badge-' + (m.status || 'untested')">
                    {{ m.status === 'ok' ? '可用' : m.status === 'error' ? '异常' : '未测试' }}
                  </span>
                  <button
                    v-if="m.status === 'error'"
                    class="fold-btn"
                    :title="errOpen(m.id) ? '收起报错详情' : '展开报错详情'"
                    @click="toggleError(m.id)"
                  >
                    <i class="fas" :class="errOpen(m.id) ? 'fa-caret-down' : 'fa-caret-right'"></i>
                  </button>
                </td>
                <td class="ai-provider">
                  {{ m.provider_name }}
                  <span class="ai-pid">(ID:{{ m.provider_id }})</span>
                </td>
                <td class="ai-name">
                  <span
                    class="ai-name-link"
                    :title="'打开聊天界面与 ' + m.display_name + ' 对话'"
                    @click="openPlayground(m)"
                  >{{ m.display_name }}</span>
                </td>
                <td class="ai-mono ai-id-cell">
                  <button
                    class="fold-btn"
                    :title="idOpen(m.id) ? '收起模型ID' : '展开模型ID'"
                    @click="toggleId(m.id)"
                  >
                    <i class="fas" :class="idOpen(m.id) ? 'fa-caret-down' : 'fa-caret-right'"></i>
                  </button>
                  <button class="copy-btn" title="复制模型ID" @click="copy(m.model_id, '模型ID')"><i class="far fa-copy"></i></button>
                  <span v-if="idOpen(m.id)" class="ai-id-text">{{ m.model_id }}</span>
                  <span v-else class="ai-id-dots">•••</span>
                </td>
                <td>
                  <span v-if="m.latency_ms != null" class="ai-latency" :class="latencyClass(m.latency_ms)">
                    {{ m.latency_ms }} ms
                    <button class="copy-btn" title="复制响应时间" @click="copy(String(m.latency_ms) + 'ms', '响应时间')"><i class="far fa-copy"></i></button>
                  </span>
                  <span v-else class="ai-muted">—</span>
                </td>
                <td class="ai-remark" :title="m.remark">{{ m.remark || '—' }}</td>
                <td>
                  <a
                    v-if="m.home_url"
                    :href="m.home_url"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="btn-mini"
                    title="转到厂家官网"
                  ><i class="fas fa-external-link-alt"></i> 官网</a>
                  <span v-else class="ai-muted">—</span>
                </td>
                <td class="ai-mono">
                  <span class="ai-key">{{ maskKey(m.api_key) }}</span>
                  <button class="copy-btn" title="复制API Key" @click="copy(m.api_key, 'API Key')"><i class="far fa-copy"></i></button>
                </td>
              </tr>
              <tr v-if="m.status === 'error' && errOpen(m.id)" class="ai-detail-row">
                <td colspan="8">
                  <i class="fas fa-triangle-exclamation"></i>
                  <span class="ai-error">{{ m.error }}</span>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
      <div v-else class="ai-board">
        <div v-for="m in filteredList" :key="m.id" class="ai-board-card">
          <div class="ai-board-head">
            <span class="ai-provider">{{ m.provider_name }} <span class="ai-pid">(ID:{{ m.provider_id }})</span></span>
            <span class="ai-badge" :class="'badge-' + (m.status || 'untested')">{{ m.status === 'ok' ? '可用' : m.status === 'error' ? '异常' : '未测试' }}</span>
          </div>
          <div class="ai-board-name" :title="'打开聊天界面与 ' + m.display_name + ' 对话'" @click="openPlayground(m)">{{ m.display_name }}</div>
          <div class="ai-board-row">
            <span class="ai-board-label">模型 ID</span>
            <span class="ai-mono ai-board-value">
              <button class="fold-btn" @click="toggleId(m.id)"><i class="fas" :class="idOpen(m.id) ? 'fa-caret-down' : 'fa-caret-right'"></i></button>
              <button class="copy-btn" @click="copy(m.model_id, '模型ID')"><i class="far fa-copy"></i></button>
              <span v-if="idOpen(m.id)" class="ai-id-text">{{ m.model_id }}</span><span v-else class="ai-id-dots">•••</span>
            </span>
          </div>
          <div class="ai-board-row">
            <span class="ai-board-label">延迟</span>
            <span v-if="m.latency_ms != null" class="ai-latency" :class="latencyClass(m.latency_ms)">{{ m.latency_ms }} ms</span>
            <span v-else class="ai-muted">—</span>
          </div>
          <div class="ai-board-row" v-if="m.remark">
            <span class="ai-board-label">备注</span>
            <span class="ai-remark">{{ m.remark }}</span>
          </div>
          <div class="ai-board-actions">
            <a v-if="m.home_url" :href="m.home_url" target="_blank" class="btn-mini"><i class="fas fa-external-link-alt"></i> 官网</a>
            <button class="copy-btn" @click="copy(m.api_key, 'API Key')"><i class="far fa-copy"></i> Key</button>
            <button v-if="m.status === 'error'" class="copy-btn" @click="toggleError(m.id)"><i class="fas fa-bug"></i> 报错</button>
          </div>
          <div v-if="m.status === 'error' && errOpen(m.id)" class="ai-board-error"><i class="fas fa-triangle-exclamation"></i> {{ m.error }}</div>
        </div>
      </div>
    </div>

    <div v-else-if="!loading" class="empty-state">
      <i class="fas fa-robot"></i>
      {{ models.length ? '没有匹配的模型' : '暂无模型数据，请前往「管理模型」添加并检测' }}
    </div>
    <div v-if="loading" class="loading">加载中...</div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { aiApi } from '../api';
import { toast } from '../utils/toast';
import { fuzzyMatch } from '../utils/fuzzy';

const router = useRouter();

const models = ref([]);
const lastTestedAt = ref('');
const loading = ref(true);
const search = ref('');
const sortBy = ref('latency');
const viewMode = ref(localStorage.getItem('models_view') || 'list');
watch(viewMode, v => { try { localStorage.setItem('models_view', v); } catch(e) {} });

const load = async () => {
  loading.value = true;
  try {
    const res = await aiApi.getStatus();
    models.value = res.data.list || [];
    lastTestedAt.value = res.data.last_tested_at || '';
  } catch (e) {
    toast(e.response?.data?.message || '加载失败', 'error');
  } finally {
    loading.value = false;
  }
};

// 跳转到聊天页并指定模型
const openPlayground = (m) => {
  router.push({ path: '/', query: { model: m.id } });
};

const openPlaygroundFromList = () => {
  // 聊天页会自动恢复上次使用的模型，无需传参
  router.push('/');
};

const goAdmin = () => {
  router.push('/admin-models');
};

// 模型ID / 报错详情 的折叠状态（默认全部折叠）
const expandedIds = ref(new Set());
const expandedErrors = ref(new Set());

const idOpen = (id) => expandedIds.value.has(id);
const errOpen = (id) => expandedErrors.value.has(id);

const toggleId = (id) => {
  const s = new Set(expandedIds.value);
  s.has(id) ? s.delete(id) : s.add(id);
  expandedIds.value = s;
};

const toggleError = (id) => {
  const s = new Set(expandedErrors.value);
  s.has(id) ? s.delete(id) : s.add(id);
  expandedErrors.value = s;
};

const filteredList = computed(() => {
  const q = search.value.trim().toLowerCase();
  let list = models.value;
  if (q) {
    list = list.filter(m =>
      [m.display_name, m.model_id, m.error, m.provider_name, m.remark]
        .some(v => v && fuzzyMatch(String(v), q))
    );
  }
  const by = sortBy.value;
  const collator = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'zh-Hans-CN', { sensitivity: 'base' });
  return [...list].sort((a, b) => {
    if (by === 'latency') {
      const la = a.latency_ms, lb = b.latency_ms;
      if (la == null && lb == null) return 0;
      if (la == null) return 1;
      if (lb == null) return -1;
      return la - lb;
    }
    if (by === 'provider') return collator(a.provider_name, b.provider_name) || collator(a.model_id, b.model_id);
    if (by === 'model') return collator(a.model_id, b.model_id);
    if (by === 'name') return collator(a.display_name, b.display_name);
    if (by === 'created') return String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));
    return 0;
  });
});

const maskKey = (key) => {
  if (!key) return '—';
  if (key.length <= 8) return key.slice(0, 2) + '****';
  return key.slice(0, 4) + '****' + key.slice(-4);
};

const copy = async (text, label) => {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label}已复制`, 'success');
  } catch {
    toast(`${label}复制失败`, 'error');
  }
};

const latencyClass = (ms) => (ms < 1000 ? 'fast' : ms < 3000 ? 'mid' : 'slow');

const formatTime = (t) => String(t).replace('T', ' ').substring(0, 19);

onMounted(load);
</script>

<style scoped>
.ai-status-page {
  max-width: 1150px;
  margin: 0 auto;
}

.ai-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.ai-updated {
  color: var(--text-muted);
  font-size: 0.85rem;
}

.ai-toolbar {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  flex-wrap: wrap;
  margin-bottom: 1.2rem;
}

.ai-search {
  flex: 1;
  min-width: 220px;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border: 2px solid var(--border-light);
  border-radius: 30px;
  padding: 0.5rem 1rem;
  background: var(--bg-card-solid);
}

.ai-search input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text-dark);
  font-family: inherit;
}

.ai-sort {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--text-muted);
  font-size: 0.9rem;
}

.ai-sort select {
  padding: 0.5rem 0.8rem;
  border: 2px solid var(--border-light);
  border-radius: 10px;
  background: var(--bg-card-solid);
  color: var(--text-dark);
  font-family: inherit;
}

.ai-table-wrap {
  overflow-x: auto;
  border: 1px solid var(--border-light);
  border-radius: 14px;
}

.ai-table {
  min-width: 1040px;
  margin: 0;
}

.ai-board{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1rem}
.ai-board-card{background:var(--bg-card);border:1px solid var(--border-light);border-radius:14px;padding:1rem 1.1rem;display:flex;flex-direction:column;gap:.55rem;transition:transform .15s,box-shadow .15s}
.ai-board-card:hover{transform:translateY(-2px);box-shadow:var(--shadow-soft)}
.ai-board-head{display:flex;justify-content:space-between;align-items:center;gap:.5rem}
.ai-board-name{font-weight:600;color:var(--primary-blue);cursor:pointer;border-bottom:1px dashed var(--primary-blue);align-self:flex-start;transition:color .15s}
.ai-board-name:hover{color:var(--primary-gold);border-color:var(--primary-gold)}
.ai-board-row{display:flex;justify-content:space-between;align-items:center;gap:.5rem;font-size:.85rem;min-width:0}
.ai-board-label{color:var(--text-muted);font-size:.78rem;flex-shrink:0}
.ai-board-value{flex:1;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.ai-board-actions{display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.2rem}
.ai-board-error{background:var(--accent-pink);color:#e67e22;border-radius:8px;padding:.5rem .7rem;font-size:.8rem;word-break:break-all}
.view-toggle{display:flex;gap:.3rem}

.ai-badge {
  display: inline-block;
  border-radius: 10px;
  padding: 0.15rem 0.6rem;
  font-size: 0.8rem;
  font-weight: 500;
  white-space: nowrap;
}

.badge-ok { color: #fff; background: #27ae60; }
.badge-error { color: #fff; background: #c0392b; }
.badge-untested { color: var(--text-muted); background: var(--accent-pink); }

.ai-name {
  font-weight: 500;
  min-width: 300px;
  max-width: 480px;
  white-space: normal;
  word-break: break-word;
}

.ai-name-link {
  color: var(--primary-blue);
  cursor: pointer;
  border-bottom: 1px dashed var(--primary-blue);
  transition: color 0.15s;
}

.ai-name-link:hover {
  color: var(--primary-gold);
  border-color: var(--primary-gold);
}

.ai-provider { white-space: nowrap; }
.ai-pid { color: var(--text-muted); font-size: 0.78rem; }

.ai-mono {
  font-family: 'SFMono-Regular', Consolas, Menlo, monospace;
  font-size: 0.85rem;
  white-space: nowrap;
}

.ai-key { opacity: 0.75; }

/* 折叠三角按钮 */
.fold-btn {
  border: none;
  background: 0 0;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0.1rem 0.25rem;
  font-size: 0.85rem;
  border-radius: 4px;
  transition: all 0.15s;
}

.fold-btn:hover {
  color: var(--primary-gold);
  background: var(--accent-pink);
}

/* 模型ID折叠单元格 */
.ai-id-cell { white-space: normal; }

.ai-id-text {
  word-break: break-all;
  color: var(--text-dark);
}

.ai-id-dots {
  color: var(--text-muted);
  letter-spacing: 2px;
  font-size: 0.7rem;
}

/* 报错详情展开行 */
.ai-detail-row td {
  background: var(--accent-pink);
  color: #e67e22;
  font-size: 0.85rem;
  padding: 0.6rem 1rem;
  word-break: break-all;
}

.ai-detail-row .fa-triangle-exclamation {
  margin-right: 0.4rem;
}

.copy-btn {
  border: 1px solid var(--border-light);
  background: var(--bg-card-solid);
  color: var(--text-muted);
  cursor: pointer;
  padding: 0.25rem 0.5rem;
  font-size: 0.78rem;
  border-radius: 6px;
  transition: all 0.15s;
  opacity: 0.85;
}

.copy-btn:hover {
  color: var(--primary-blue);
  border-color: var(--primary-gold);
  background: var(--accent-pink);
  opacity: 1;
  transform: translateY(-1px);
}

.btn-mini {
  border: 1px solid var(--border-light);
  color: var(--text-dark);
  cursor: pointer;
  background: 0 0;
  border-radius: 10px;
  padding: 0.35rem 0.7rem;
  font-family: inherit;
  font-size: 0.8rem;
  white-space: nowrap;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  transition: all 0.15s;
}

.btn-mini:hover {
  border-color: var(--primary-gold);
  color: var(--primary-gold);
}

.ai-error { color: #e67e22; }

.ai-remark {
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
  font-size: 0.85rem;
}

.ai-latency { font-family: Consolas, Menlo, monospace; font-size: 0.88rem; white-space: nowrap; }
.ai-latency.fast { color: #27ae60; }
.ai-latency.mid { color: #e4b85c; }
.ai-latency.slow { color: #e67e22; }

.ai-muted { color: var(--text-muted); font-size: 0.85rem; }
</style>
