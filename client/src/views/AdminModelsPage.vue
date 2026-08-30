<template>
  <div class="admin-models-page">
    <div class="page-header">
      <h1><i class="fas fa-screwdriver-wrench"></i> AI 模型管理</h1>
    </div>

    <div class="admin-header">
      <div class="header-actions">
        <button class="btn btn-primary" data-tour="model-test" @click="testAll" :disabled="testingAll">
          <i class="fas" :class="testingAll ? 'fa-spinner fa-spin' : 'fa-play'"></i>
          {{ testingAll ? '测试中...' : '测试全部模型' }}
        </button>
        <span style="display:flex;align-items:center;gap:.3rem;margin-left:.4rem">
          <input v-model.number="pingTimeout" type="number" min="1" max="30" style="width:60px;padding:.3rem .4rem;border:1px solid var(--border-light);border-radius:6px;font-size:.82rem">
          <span style="font-size:.82rem;color:var(--text-muted)">秒</span>
        </span>
        <button class="btn" @click="pingAll" :disabled="pinging">
          <i class="fas" :class="pinging ? 'fa-spinner fa-spin' : 'fa-satellite-dish'"></i>
          {{ pinging ? 'Ping 中...' : 'Ping 提供商域名' }}
        </button>
        <button class="btn btn-small" @click="toggleLatencyUnit" :title="'切换为' + (latencyUnit === 'ms' ? '秒' : '毫秒')"><i class="fas fa-stopwatch"></i> {{ latencyUnit }}</button>
      </div>
    </div>

    <div v-if="pingResults.length" class="ping-results">
      <h4><i class="fas fa-network-wired"></i> Ping 结果</h4>
      <table class="data-table" style="margin-top:.5rem">
        <thead><tr><th>提供商</th><th>BaseURL</th><th>状态</th><th>延迟</th><th>详情</th></tr></thead>
        <tbody>
          <tr v-for="r in pingResults" :key="r.id">
            <td>{{ r.name }}</td>
            <td class="mono" style="font-size:.8rem">{{ r.base_url }}</td>
            <td><span class="ai-badge" :class="r.status === 'ok' ? 'badge-ok' : 'badge-error'">{{ r.status === 'ok' ? '可达' : '失败' }}</span></td>
            <td>{{ formatLatency(r.latency_ms) }}</td>
            <td class="muted" style="max-width:260px;word-break:break-all;font-size:.8rem">{{ r.error || (r.http_status ? 'HTTP ' + r.http_status : '—') }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="message" :class="['alert', success ? 'alert-success' : 'alert-error']">{{ message }}</div>

    <!-- ============ 提供商管理 ============ -->
    <div class="ai-section">
      <div class="section-head">
        <h3><i class="fas fa-server"></i> 提供商</h3>
        <button class="btn btn-small" data-tour="prov-add" @click="openProviderForm()">
          <i class="fas fa-plus"></i> 新增提供商
        </button>
      </div>
      <table class="data-table">
        <thead>
          <tr>
            <th>ID</th><th>名称</th><th>BaseURL</th><th>API Key</th><th>官网</th><th>代理</th><th>模型数</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in providers" :key="p.id">
            <td>{{ p.id }}</td>
            <td>{{ p.name }}</td>
            <td class="mono">{{ p.base_url }}</td>
            <td class="mono">{{ maskKey(p.api_key) }}</td>
            <td>
              <a v-if="p.home_url" :href="p.home_url" target="_blank" rel="noopener noreferrer" class="home-link">
                <i class="fas fa-external-link-alt"></i> 链接
              </a>
              <span v-else class="muted">—</span>
            </td>
            <td>
              <span v-if="p.proxy_enabled" class="ai-badge badge-ok">开启 {{ p.proxy_host }}:{{ p.proxy_port }}</span>
              <span v-else class="ai-badge badge-untested">关闭</span>
            </td>
            <td>{{ p.model_count }}</td>
            <td class="actions">
              <button class="btn btn-small" @click="openProviderForm(p)">编辑</button>
              <button class="btn btn-small btn-danger" @click="removeProvider(p)">删除</button>
            </td>
          </tr>
          <tr v-if="providers.length === 0"><td colspan="8" class="empty-state">暂无提供商</td></tr>
        </tbody>
      </table>
    </div>

    <!-- ============ 模型管理 ============ -->
    <div class="ai-section">
      <div class="section-head">
        <h3><i class="fas fa-cubes"></i> 模型</h3>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap">
          <button class="btn btn-small" @click="openBatchForm" :disabled="providers.length === 0">
            <i class="fas fa-layer-group"></i> 批量添加
          </button>
          <button class="btn btn-small btn-danger" @click="batchDelete" :disabled="selectedIds.size === 0">
            <i class="fas fa-trash-can"></i> 批量删除{{ selectedIds.size ? ` (${selectedIds.size})` : '' }}
          </button>
          <button class="btn btn-small" data-tour="model-add" @click="openModelForm()" :disabled="providers.length === 0" :title="providers.length === 0 ? '请先添加提供商' : ''">
            <i class="fas fa-plus"></i> 新增模型
          </button>
        </div>
      </div>
      <div class="admin-toolbar">
        <div class="admin-search">
          <i class="fas fa-search"></i>
          <input v-model="modelSearch" placeholder="搜索模型ID / 展示名 / 提供商 / 备注">
        </div>
        <div class="admin-sort">
          <label>排序</label>
          <select v-model="modelSortBy">
            <option value="initial">首字母（A~Z）</option>
            <option value="status">可用性（可用→异常→未测试）</option>
            <option value="latency">首字延迟（快→慢）</option>
            <option value="provider">提供商（A~Z）</option>
          </select>
        </div>
        <div class="view-toggle">
          <button class="btn btn-small" :class="adminViewMode === 'list' ? 'btn-primary' : ''" @click="adminViewMode = 'list'" title="列表视图"><i class="fas fa-list"></i></button>
          <button class="btn btn-small" :class="adminViewMode === 'board' ? 'btn-primary' : ''" @click="adminViewMode = 'board'" title="平铺视图"><i class="fas fa-th-large"></i></button>
        </div>
      </div>
      <div v-if="testingAll || testProgress > 0" class="progress-wrap"><div class="progress-bar"><div class="progress-fill" :style="{ width: testProgress + '%' }"></div></div><span class="progress-text">测试中 {{ Math.round(testProgress) }}%</span></div>
      <div v-if="pinging || pingProgress > 0" class="progress-wrap"><div class="progress-bar"><div class="progress-fill ping-fill" :style="{ width: pingProgress + '%' }"></div></div><span class="progress-text">Ping {{ Math.round(pingProgress) }}%</span></div>
      <div v-if="adminViewMode === 'list'">
      <table class="data-table">
        <thead>
          <tr>
            <th style="width:36px"><input type="checkbox" :checked="allSelected" :indeterminate="someSelected" @change="toggleAll($event)"></th>
            <th>ID</th><th>展示名称</th><th>模型 ID</th><th>提供商</th><th>备注</th><th>状态</th><th>首字延迟</th><th>上次检测</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="m in filteredModels" :key="m.id">
            <tr>
              <td><input type="checkbox" :checked="selectedIds.has(m.id)" @change="toggleOne(m.id)"></td>
            <td>{{ m.id }}</td>
            <td>{{ m.display_name }}</td>
            <td class="mono ai-id-cell">
              <button class="fold-btn" :title="idOpen(m.id) ? '收起模型ID' : '展开模型ID'" @click="toggleId(m.id)">
                <i class="fas" :class="idOpen(m.id) ? 'fa-caret-down' : 'fa-caret-right'"></i>
              </button>
              <span v-if="idOpen(m.id)" class="ai-id-text">{{ m.model_id }}</span>
              <span v-else class="ai-id-dots">•••</span>
            </td>
            <td>{{ m.provider_name }}</td>
            <td class="remark-cell" :title="m.remark">{{ m.remark || '—' }}</td>
            <td>
              <span v-if="m.disabled" class="ai-badge badge-disabled">已禁用</span>
              <span v-else class="ai-badge" :class="'badge-' + (m.status || 'untested')">
                {{ m.status === 'ok' ? '可用' : m.status === 'error' ? '异常' : '未测试' }}
              </span>
              <button v-if="m.status === 'error' && !m.disabled" class="fold-btn" :title="errOpen(m.id) ? '收起报错' : '展开报错'" @click="toggleError(m.id)">
                <i class="fas" :class="errOpen(m.id) ? 'fa-caret-down' : 'fa-caret-right'"></i>
              </button>
            </td>
            <td>
              <span v-if="m.latency_ms != null" class="latency" :class="latencyClass(m.latency_ms)">{{ formatLatency(m.latency_ms) }}</span>
              <span v-else class="muted">—</span>
            </td>
            <td class="muted">{{ m.tested_at ? m.tested_at.replace('T', ' ').substring(0, 19) : '—' }}</td>
            <td class="actions">
              <button class="btn btn-small" @click="testOne(m)" :disabled="testingId === m.id || m.disabled">
                <i class="fas" :class="testingId === m.id ? 'fa-spinner fa-spin' : 'fa-bolt'"></i>
                {{ testingId === m.id ? '测试中' : '测试' }}
              </button>
              <button class="btn btn-small" @click="toggleDisabled(m)">{{ m.disabled ? '启用' : '禁用' }}</button>
              <button class="btn btn-small" @click="openModelForm(m)">编辑</button>
              <button class="btn btn-small btn-danger" @click="removeModel(m)">删除</button>
            </td>
          </tr>
          <tr v-if="m.status === 'error' && !m.disabled && errOpen(m.id)" class="ai-detail-row">
            <td colspan="10"><i class="fas fa-triangle-exclamation"></i> <span class="ai-error">{{ m.error }}</span></td>
          </tr>
          </template>
          <tr v-if="filteredModels.length === 0"><td colspan="10" class="empty-state">{{ models.length ? '无匹配模型' : '暂无模型' }}</td></tr>
        </tbody>
      </table>
      </div>
      <div v-else class="ai-board">
        <div v-for="m in filteredModels" :key="m.id" class="ai-board-card">
          <div class="ai-board-head">
            <span class="ai-provider">{{ m.provider_name }}</span>
            <span v-if="m.disabled" class="ai-badge badge-disabled">已禁用</span>
            <span v-else class="ai-badge" :class="'badge-' + (m.status || 'untested')">{{ m.status === 'ok' ? '可用' : m.status === 'error' ? '异常' : '未测试' }}</span>
          </div>
          <div class="ai-board-name">{{ m.display_name }}</div>
          <div class="ai-board-row">
            <span class="ai-board-label">模型 ID</span>
            <span class="ai-mono ai-board-value">
              <button class="fold-btn" @click="toggleId(m.id)"><i class="fas" :class="idOpen(m.id) ? 'fa-caret-down' : 'fa-caret-right'"></i></button>
              <span v-if="idOpen(m.id)" class="ai-id-text">{{ m.model_id }}</span><span v-else class="ai-id-dots">•••</span>
            </span>
          </div>
          <div class="ai-board-row">
            <span class="ai-board-label">延迟</span>
            <span v-if="m.latency_ms != null" class="latency" :class="latencyClass(m.latency_ms)">{{ formatLatency(m.latency_ms) }}</span><span v-else class="muted">—</span>
          </div>
          <div class="ai-board-row" v-if="m.remark">
            <span class="ai-board-label">备注</span>
            <span class="ai-remark" style="max-width:140px">{{ m.remark }}</span>
          </div>
          <div class="ai-board-actions">
            <button class="btn btn-small" @click="testOne(m)" :disabled="testingId === m.id || m.disabled"><i class="fas fa-bolt"></i></button>
            <button class="btn btn-small" @click="toggleDisabled(m)">{{ m.disabled ? '启用' : '禁用' }}</button>
            <button class="btn btn-small" @click="openModelForm(m)">编辑</button>
            <button class="btn btn-small btn-danger" @click="removeModel(m)">删除</button>
            <label style="margin-left:auto;display:flex;align-items:center;gap:.3rem;font-size:.8rem"><input type="checkbox" :checked="selectedIds.has(m.id)" @change="toggleOne(m.id)"> 选择</label>
          </div>
          <div v-if="m.status === 'error' && !m.disabled && errOpen(m.id)" class="ai-board-error"><i class="fas fa-triangle-exclamation"></i> {{ m.error }}</div>
        </div>
        <div v-if="filteredModels.length === 0" class="ai-board-empty">{{ models.length ? '无匹配模型' : '暂无模型' }}</div>
      </div>
    </div>

    <!-- ============ 提供商表单 ============ -->
    <div v-if="showProviderForm" class="modal-overlay" @click.self="showProviderForm = false">
      <div class="modal">
        <h3>{{ providerEditId ? '编辑提供商' : '新增提供商' }}</h3>
        <form @submit.prevent="saveProvider">
          <div class="form-group">
            <label>提供商名称 *</label>
            <input v-model="providerForm.name" required maxlength="100" placeholder="如：OpenAI / DeepSeek / 硅基流动">
          </div>
          <div class="form-group">
            <label>BaseURL（截止到 /v1）*</label>
            <input v-model="providerForm.base_url" required placeholder="https://api.example.com/v1">
          </div>
          <div class="form-group">
            <label>API Key *</label>
            <input v-model="providerForm.api_key" required placeholder="sk-...">
          </div>
          <div class="form-group">
            <label>官网首页 URL（模型列表「转到厂家官网」按钮指向）</label>
            <input v-model="providerForm.home_url" placeholder="https://www.example.com">
          </div>
          <div class="form-group">
            <label class="check-label">
              <input type="checkbox" v-model="providerForm.proxy_enabled">
              <span>启用 HTTP 代理</span>
            </label>
          </div>
          <div v-if="providerForm.proxy_enabled" class="form-row">
            <div class="form-group" style="flex: 2;">
              <label>代理 IP / 域名 *</label>
              <input v-model="providerForm.proxy_host" placeholder="127.0.0.1">
            </div>
            <div class="form-group" style="flex: 1;">
              <label>端口 *</label>
              <input v-model="providerForm.proxy_port" type="number" min="1" max="65535" placeholder="7890">
            </div>
          </div>
          <div class="form-actions">
            <button type="button" class="btn" @click="showProviderForm = false">取消</button>
            <button type="submit" class="btn btn-primary">保存</button>
          </div>
        </form>
      </div>
    </div>

    <!-- ============ 模型表单 ============ -->
    <div v-if="showModelForm" class="modal-overlay" @click.self="showModelForm = false">
      <div class="modal">
        <h3>{{ modelEditId ? '编辑模型' : '新增模型' }}</h3>
        <form @submit.prevent="saveModel">
          <div class="form-group">
            <label>所属提供商 *</label>
            <select v-model="modelForm.provider_id" required>
              <option value="" disabled>请选择提供商</option>
              <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}（{{ p.base_url }}）</option>
            </select>
          </div>
          <div class="form-group">
            <label>模型 ID（OpenAI 协议 model 参数）*</label>
            <div style="display:flex;gap:.5rem">
              <input v-model="modelForm.model_id" required maxlength="100" placeholder="如：gpt-4o-mini / deepseek-chat" style="flex:1">
              <button type="button" class="btn btn-small" @click="fetchSingleRemote" :disabled="!modelForm.provider_id || singleFetching" :title="!modelForm.provider_id ? '请先选择提供商' : ''">
                <i class="fas" :class="singleFetching ? 'fa-spinner fa-spin' : 'fa-cloud-arrow-down'"></i> {{ singleFetching ? '获取中' : '从接口获取' }}
              </button>
            </div>
            <div v-if="singleRemoteList.length" class="remote-picker">
              <div class="remote-picker-head">接口返回 {{ singleRemoteList.length }} 个模型（点击选择，仅单选）</div>
              <div class="remote-picker-list">
                <button v-for="item in singleRemoteList" :key="item.model_id" type="button" class="remote-item" :class="{ existed: item.existed, selected: modelForm.model_id === item.model_id }" @click="pickSingleModel(item)">
                  <span class="mono">{{ item.model_id }}</span>
                  <span v-if="item.existed" class="ai-badge badge-untested" style="font-size:.7rem">已存在</span>
                </button>
              </div>
            </div>
          </div>
          <div class="form-group">
            <label>展示名称</label>
            <input v-model="modelForm.display_name" maxlength="100" placeholder="留空则使用模型 ID">
          </div>
          <div class="form-group">
            <label>备注（展示在模型列表）</label>
            <textarea v-model="modelForm.remark" rows="2" maxlength="500" placeholder="如：免费额度 / 速度较快 / 需要代理..."></textarea>
          </div>
          <div class="form-group">
            <label>模型能力</label>
            <div style="display:flex;gap:1rem;flex-wrap:wrap;align-items:center">
              <label class="check-label"><input type="checkbox" v-model="modelForm.supports_search"> 支持联网搜索</label>
              <label class="check-label"><input type="checkbox" v-model="modelForm.supports_thinking"> 支持思考</label>
            </div>
            <div v-if="modelForm.supports_thinking" style="margin-top:.6rem">
              <label style="font-size:.85rem;color:var(--text-muted)">思考强度选项（逗号分隔，如 low,medium,high,max）</label>
              <input v-model="modelForm.thinking_levels" placeholder="如：low,medium,high,max">
            </div>
            <div style="margin-top:.6rem">
              <label style="font-size:.85rem;color:var(--text-muted)">最大上下文（0 表示未知，自动获取可填入）</label>
              <input v-model.number="modelForm.max_context" type="number" min="0" placeholder="如：128000">
            </div>
          </div>
          <div class="form-group">
            <label>计价（美元 / 100 万 tokens，用于用量统计的费用估算；缓存命中按缓存价单独计）</label>
            <div class="price-row">
              <label class="price-item">输入 $<input v-model.number="modelForm.price_in" type="number" step="0.0001" min="0" placeholder="如 5"></label>
              <label class="price-item">输出 $<input v-model.number="modelForm.price_out" type="number" step="0.0001" min="0" placeholder="如 15"></label>
              <label class="price-item">缓存读 $<input v-model.number="modelForm.price_cache" type="number" step="0.0001" min="0" placeholder="如 1.25"></label>
            </div>
          </div>
          <div class="form-actions">
            <button type="button" class="btn" @click="showModelForm = false">取消</button>
            <button type="submit" class="btn btn-primary">保存</button>
          </div>
        </form>
      </div>
    </div>

    <!-- ============ 批量添加模型 ============ -->
    <div v-if="showBatchForm" class="modal-overlay" @click.self="showBatchForm = false">
      <div class="modal" style="max-width:780px;width:95%">
        <h3><i class="fas fa-layer-group"></i> 批量添加模型</h3>
        <div class="form-group">
          <label>选择提供商 *</label>
          <div style="display:flex;gap:.5rem">
            <select v-model="batchProviderId" style="flex:1">
              <option value="" disabled>请选择提供商</option>
              <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}（{{ p.base_url }}）</option>
            </select>
            <button class="btn btn-primary btn-small" @click="fetchBatchRemote" :disabled="!batchProviderId || batchFetching">
              <i class="fas" :class="batchFetching ? 'fa-spinner fa-spin' : 'fa-cloud-arrow-down'"></i> {{ batchFetching ? '获取中' : '获取模型列表' }}
            </button>
          </div>
        </div>

        <div v-if="batchModels.length" style="margin-top:1rem">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem;flex-wrap:wrap;gap:.5rem">
            <span class="muted" style="font-size:.85rem">共 {{ batchModels.length }} 个模型，已选 {{ batchSelectedCount }} 个</span>
            <div style="display:flex;gap:.4rem">
              <button class="btn btn-small" @click="batchSelectAll(true)">全选</button>
              <button class="btn btn-small" @click="batchSelectAll(false)">全不选</button>
              <input v-model="batchSearch" placeholder="筛选模型 ID" style="width:160px;padding:.35rem .6rem;border:1px solid var(--border-light);border-radius:8px;font-size:.85rem">
            </div>
          </div>
          <div class="batch-list">
            <div v-for="(bm, idx) in batchFiltered" :key="bm.model_id" class="batch-item" :class="{ selected: bm.selected, existed: bm.existed }">
              <label class="batch-check">
                <input type="checkbox" :checked="bm.selected" :disabled="bm.existed" @change="bm.selected = $event.target.checked">
                <span class="mono" style="font-weight:600">{{ bm.model_id }}</span>
                <span v-if="bm.existed" class="ai-badge badge-error" style="font-size:.7rem">已存在</span>
              </label>
              <div v-if="bm.selected && !bm.existed" class="batch-fields">
                <input v-model="bm.display_name" placeholder="别名（留空=模型ID）" maxlength="100">
                <input v-model="bm.remark" placeholder="备注" maxlength="200">
                <div class="price-row" style="margin-top:.3rem">
                  <label class="price-item" style="font-size:.78rem">输入 $<input v-model.number="bm.price_in" type="number" step="0.0001" min="0" style="width:70px"></label>
                  <label class="price-item" style="font-size:.78rem">输出 $<input v-model.number="bm.price_out" type="number" step="0.0001" min="0" style="width:70px"></label>
                  <label class="price-item" style="font-size:.78rem">缓存 $<input v-model.number="bm.price_cache" type="number" step="0.0001" min="0" style="width:70px"></label>
                </div>
              </div>
            </div>
            <div v-if="batchFiltered.length === 0" class="empty-state" style="padding:1rem">无匹配模型</div>
          </div>
        </div>
        <div v-else-if="batchFetched && !batchFetching" class="empty-state" style="padding:1rem">暂无模型，请先获取列表</div>

        <div class="form-actions">
          <button class="btn" @click="showBatchForm = false">取消</button>
          <button class="btn btn-primary" :disabled="batchSelectedCount === 0 || batchSaving" @click="saveBatch">
            <i v-if="batchSaving" class="fas fa-spinner fa-spin"></i>
            {{ batchSaving ? '添加中...' : `添加 ${batchSelectedCount} 个模型` }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { aiApi } from '../api';
import { toast } from '../utils/toast';
import { fuzzyMatch } from '../utils/fuzzy';

const providers = ref([]);
const models = ref([]);
const message = ref('');
const success = ref(false);
const testingAll = ref(false);
const testingId = ref(null);

const showProviderForm = ref(false);
const providerEditId = ref(null);
const providerForm = ref(emptyProvider());

const showModelForm = ref(false);
const modelEditId = ref(null);
const modelForm = ref(emptyModel());
const adminViewMode = ref(localStorage.getItem('admin_models_view') || 'list');
watch(adminViewMode, v => { try { localStorage.setItem('admin_models_view', v); } catch(e) {} });
const testProgress = ref(0);
const pingProgress = ref(0);
let testTimer = null;
let pingTimer = null;

// 单条添加：从接口获取
const singleFetching = ref(false);
const singleRemoteList = ref([]);

// 批量添加
const showBatchForm = ref(false);
const batchProviderId = ref('');
const batchFetching = ref(false);
const batchFetched = ref(false);
const batchModels = ref([]); // [{model_id, existed, selected, display_name, remark, price_in, price_out, price_cache}]
const batchSearch = ref('');
const batchSaving = ref(false);

// 多选删除
const selectedIds = ref(new Set());
const allSelected = computed(() => models.value.length > 0 && selectedIds.value.size === models.value.length);
const someSelected = computed(() => selectedIds.value.size > 0 && selectedIds.value.size < models.value.length);

// Ping
const pinging = ref(false);
const pingResults = ref([]);
const pingTimeout = ref(5);
const latencyUnit = ref(localStorage.getItem('latency_unit') || 'ms');
const formatLatency = (ms) => {
  if (ms == null) return '—';
  if (latencyUnit.value === 's') return (ms / 1000).toFixed(ms >= 10000 ? 1 : 2) + ' s';
  return ms + ' ms';
};
const toggleLatencyUnit = () => {
  latencyUnit.value = latencyUnit.value === 'ms' ? 's' : 'ms';
  try { localStorage.setItem('latency_unit', latencyUnit.value); } catch(e) {}
};

// 搜索与排序（参考「免费LLM API」表格）
const modelSearch = ref('');
const modelSortBy = ref('initial');
const expandedIds = ref(new Set());
const expandedErrors = ref(new Set());
const idOpen = (id) => expandedIds.value.has(id);
const errOpen = (id) => expandedErrors.value.has(id);
const toggleId = (id) => { const s = new Set(expandedIds.value); s.has(id) ? s.delete(id) : s.add(id); expandedIds.value = s; };
const toggleError = (id) => { const s = new Set(expandedErrors.value); s.has(id) ? s.delete(id) : s.add(id); expandedErrors.value = s; };

const filteredModels = computed(() => {
  const q = modelSearch.value.trim();
  let list = models.value;
  if (q) {
    list = list.filter(m => [m.display_name, m.model_id, m.provider_name, m.remark, m.error].some(v => v && fuzzyMatch(String(v), q)));
  }
  const by = modelSortBy.value;
  const collator = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'zh-Hans-CN', { sensitivity: 'base' });
  return [...list].sort((a, b) => {
    if (by === 'initial') return collator(a.display_name || a.model_id, b.display_name || b.model_id);
    if (by === 'status') {
      const order = { ok: 0, error: 1, untested: 2 };
      const ao = order[a.status || 'untested'] ?? 2;
      const bo = order[b.status || 'untested'] ?? 2;
      if (ao !== bo) return ao - bo;
      return collator(a.display_name, b.display_name);
    }
    if (by === 'latency') {
      const la = a.latency_ms, lb = b.latency_ms;
      if (la == null && lb == null) return 0;
      if (la == null) return 1;
      if (lb == null) return -1;
      return la - lb;
    }
    if (by === 'provider') return collator(a.provider_name, b.provider_name) || collator(a.display_name, b.display_name);
    return 0;
  });
});

const batchFiltered = computed(() => {
  const kw = batchSearch.value.trim();
  if (!kw) return batchModels.value;
  return batchModels.value.filter(b => fuzzyMatch(b.model_id, kw));
});
const batchSelectedCount = computed(() => batchModels.value.filter(b => b.selected && !b.existed).length);

function emptyProvider() {
  return { name: '', base_url: '', api_key: '', home_url: '', proxy_enabled: false, proxy_host: '', proxy_port: '' };
}
function emptyModel() {
  return { provider_id: '', model_id: '', display_name: '', remark: '', price_in: null, price_out: null, price_cache: null, max_context: 0, supports_search: false, supports_thinking: false, thinking_levels: '' };
}

const maskKey = (key) => {
  if (!key) return '—';
  if (key.length <= 8) return key.slice(0, 2) + '****';
  return key.slice(0, 4) + '****' + key.slice(-4);
};

const latencyClass = (ms) => (ms < 1000 ? 'fast' : ms < 3000 ? 'mid' : 'slow');

const notify = (msg, ok = true) => {
  message.value = msg;
  success.value = ok;
  setTimeout(() => { message.value = ''; }, 4000);
};

const loadData = async () => {
  try {
    const [p, m] = await Promise.all([aiApi.getProviders(), aiApi.getModels()]);
    providers.value = p.data;
    models.value = m.data;
  } catch (e) {
    notify(e.response?.data?.message || '加载失败', false);
  }
};

/* ---------- 测试 ---------- */

const testAll = async () => {
  testingAll.value = true;
  testProgress.value = 0;
  if (testTimer) clearInterval(testTimer);
  testTimer = setInterval(() => { if (testProgress.value < 90) testProgress.value += Math.random() * 4 + 1; }, 400);
  try {
    const res = await aiApi.testAll();
    testProgress.value = 100;
    notify(res.message || '测试完成');
    await loadData();
  } catch (e) {
    notify(e.response?.data?.message || '测试失败', false);
  } finally {
    clearInterval(testTimer); testTimer = null;
    setTimeout(() => { testProgress.value = 0; testingAll.value = false; }, 800);
  }
};

const testOne = async (m) => {
  testingId.value = m.id;
  try {
    const res = await aiApi.testOne(m.id);
    const r = res.data.results?.[0];
    if (r?.status === 'ok') toast(`${m.display_name} 可用（${r.latency_ms}ms）`, 'success');
    else toast(`${m.display_name} 异常：${r?.error || '未知错误'}`, 'error', 6000);
    await loadData();
  } catch (e) {
    toast(e.response?.data?.message || '测试失败', 'error');
  } finally {
    testingId.value = null;
  }
};

/* ---------- 提供商 ---------- */

const openProviderForm = (p = null) => {
  providerEditId.value = p ? p.id : null;
  providerForm.value = p
    ? { name: p.name, base_url: p.base_url, api_key: p.api_key, home_url: p.home_url || '', proxy_enabled: !!p.proxy_enabled, proxy_host: p.proxy_host || '', proxy_port: p.proxy_port || '' }
    : emptyProvider();
  showProviderForm.value = true;
};

const saveProvider = async () => {
  try {
    if (providerEditId.value) {
      await aiApi.updateProvider(providerEditId.value, providerForm.value);
    } else {
      await aiApi.createProvider(providerForm.value);
    }
    toast('提供商已保存', 'success');
    showProviderForm.value = false;
    loadData();
  } catch (e) {
    notify(e.response?.data?.message || '保存失败', false);
  }
};

const removeProvider = async (p) => {
  if (!confirm(`确定删除提供商「${p.name}」？其下 ${p.model_count} 个模型及测试结果将一并删除。`)) return;
  try {
    await aiApi.deleteProvider(p.id);
    toast('已删除', 'success');
    loadData();
  } catch (e) {
    toast(e.response?.data?.message || '删除失败', 'error');
  }
};

/* ---------- 模型 ---------- */

const openModelForm = (m = null) => {
  modelEditId.value = m ? m.id : null;
  modelForm.value = m
    ? { provider_id: m.provider_id, model_id: m.model_id, display_name: m.display_name, remark: m.remark || '', price_in: m.price_in ?? null, price_out: m.price_out ?? null, price_cache: m.price_cache ?? null, max_context: m.max_context || 0, supports_search: !!m.supports_search, supports_thinking: !!m.supports_thinking, thinking_levels: m.thinking_levels || '' }
    : emptyModel();
  singleRemoteList.value = [];
  showModelForm.value = true;
};

const fetchSingleRemote = async () => {
  if (!modelForm.value.provider_id) { toast('请先选择提供商', 'info'); return; }
  singleFetching.value = true;
  try {
    const res = await aiApi.getRemoteModels(modelForm.value.provider_id);
    singleRemoteList.value = res.data.list || [];
    toast(res.message || `获取到 ${singleRemoteList.value.length} 个模型`, 'success');
  } catch (e) {
    toast(e.response?.data?.message || '获取失败', 'error');
  } finally { singleFetching.value = false; }
};

const pickSingleModel = (item) => {
  if (item.existed) { toast('该模型已存在', 'info'); return; }
  modelForm.value.model_id = item.model_id;
  if (!modelForm.value.display_name) modelForm.value.display_name = item.model_id;
};

const saveModel = async () => {
  try {
    const payload = { ...modelForm.value, display_name: modelForm.value.display_name || modelForm.value.model_id };
    if (modelEditId.value) {
      await aiApi.updateModel(modelEditId.value, payload);
    } else {
      await aiApi.createModel(payload);
    }
    toast('模型已保存', 'success');
    showModelForm.value = false;
    loadData();
  } catch (e) {
    notify(e.response?.data?.message || '保存失败', false);
  }
};

const removeModel = async (m) => {
  if (!confirm(`确定删除模型「${m.display_name}」？`)) return;
  try {
    await aiApi.deleteModel(m.id);
    toast('已删除', 'success');
    selectedIds.value.delete(m.id);
    selectedIds.value = new Set(selectedIds.value);
    loadData();
  } catch (e) {
    toast(e.response?.data?.message || '删除失败', 'error');
  }
};

// 批量添加
const openBatchForm = () => {
  batchProviderId.value = '';
  batchModels.value = [];
  batchFetched.value = false;
  batchSearch.value = '';
  showBatchForm.value = true;
};

const fetchBatchRemote = async () => {
  if (!batchProviderId.value) { toast('请选择提供商', 'info'); return; }
  batchFetching.value = true;
  try {
    const res = await aiApi.getRemoteModels(batchProviderId.value);
    const list = res.data.list || [];
    batchModels.value = list.map(x => ({
      model_id: x.model_id,
      existed: x.existed,
      selected: false,
      display_name: '',
      remark: '',
      price_in: null,
      price_out: null,
      price_cache: null
    }));
    batchFetched.value = true;
    toast(res.message || `获取到 ${list.length} 个模型`, 'success');
  } catch (e) {
    toast(e.response?.data?.message || '获取失败', 'error');
  } finally { batchFetching.value = false; }
};

const batchSelectAll = (val) => {
  batchModels.value.forEach(b => { if (!b.existed) b.selected = val; });
};

const saveBatch = async () => {
  const selected = batchModels.value.filter(b => b.selected && !b.existed);
  if (selected.length === 0) { toast('请至少选择一个未添加过的模型', 'info'); return; }
  batchSaving.value = true;
  try {
    const payload = {
      provider_id: parseInt(batchProviderId.value),
      models: selected.map(b => ({
        model_id: b.model_id,
        display_name: b.display_name || b.model_id,
        remark: b.remark || '',
        price_in: b.price_in ?? 0,
        price_out: b.price_out ?? 0,
        price_cache: b.price_cache ?? 0
      }))
    };
    const res = await aiApi.batchCreateModels(payload);
    toast(res.message || `已添加 ${res.data.added} 个模型`, 'success');
    if (res.data.errors && res.data.errors.length) {
      toast(res.data.errors.slice(0, 3).join('；'), 'info', 6000);
    }
    showBatchForm.value = false;
    loadData();
  } catch (e) {
    toast(e.response?.data?.message || '批量添加失败', 'error');
  } finally { batchSaving.value = false; }
};

// 多选删除
const toggleOne = (id) => {
  const s = new Set(selectedIds.value);
  if (s.has(id)) s.delete(id); else s.add(id);
  selectedIds.value = s;
};
const toggleAll = (e) => {
  if (e.target.checked) selectedIds.value = new Set(models.value.map(m => m.id));
  else selectedIds.value = new Set();
};
const batchDelete = async () => {
  if (selectedIds.value.size === 0) return;
  if (!confirm(`确定删除选中的 ${selectedIds.value.size} 个模型？`)) return;
  try {
    const res = await aiApi.batchDeleteModels([...selectedIds.value]);
    toast(res.message || '已删除', 'success');
    selectedIds.value = new Set();
    loadData();
  } catch (e) {
    toast(e.response?.data?.message || '删除失败', 'error');
  }
};

// Ping 提供商
const pingAll = async () => {
  pinging.value = true;
  pingProgress.value = 0;
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = setInterval(() => { if (pingProgress.value < 90) pingProgress.value += Math.random() * 5 + 2; }, 300);
  pingResults.value = [];
  try {
    const res = await aiApi.pingProviders(pingTimeout.value * 1000);
    pingProgress.value = 100;
    pingResults.value = res.data || [];
    toast(res.message || 'Ping 完成', 'success');
  } catch (e) {
    toast(e.response?.data?.message || 'Ping 失败', 'error');
  } finally {
    clearInterval(pingTimer); pingTimer = null;
    setTimeout(() => { pingProgress.value = 0; pinging.value = false; }, 800);
  }
};

const toggleDisabled = async (m) => {
  try {
    const res = await aiApi.toggleModelDisabled(m.id, m.disabled ? 0 : 1);
    toast(res.message || (m.disabled ? '已启用' : '已禁用'), 'success');
    loadData();
  } catch (e) {
    toast(e.response?.data?.message || '操作失败', 'error');
  }
};

onMounted(loadData);
</script>

<style scoped>
.admin-models-page {
  width: 100%;
  max-width: none;
  margin: 0;
}

.header-actions {
  display: flex;
  gap: 0.8rem;
  align-items: center;
  flex-wrap: wrap;
}

.admin-toolbar { display: flex; align-items: center; gap: .8rem; flex-wrap: wrap; margin-bottom: 1rem; }
.admin-search { flex: 1; min-width: 220px; display: flex; align-items: center; gap: .5rem; border: 2px solid var(--border-light); border-radius: 30px; padding: .45rem 1rem; background: var(--bg-card-solid); }
.admin-search input { flex: 1; border: none; outline: none; background: transparent; color: var(--text-dark); font-family: inherit; }
.admin-sort { display: flex; align-items: center; gap: .4rem; color: var(--text-muted); font-size: .88rem; white-space: nowrap; }
.admin-sort select { padding: .45rem .7rem; border: 2px solid var(--border-light); border-radius: 10px; background: var(--bg-card-solid); color: var(--text-dark); font-family: inherit; }

.fold-btn{border:none;background:0 0;color:var(--text-muted);cursor:pointer;padding:.1rem .25rem;font-size:.85rem;border-radius:4px;transition:all .15s}
.fold-btn:hover{color:var(--primary-gold);background:var(--accent-pink)}
.ai-id-cell{white-space:normal}
.ai-id-text{word-break:break-all;color:var(--text-dark)}
.ai-id-dots{color:var(--text-muted);letter-spacing:2px;font-size:.7rem}
.ai-detail-row td{background:var(--accent-pink);color:#e67e22;font-size:.85rem;padding:.6rem 1rem;word-break:break-all}
.ai-error{color:#e67e22}

.ai-section {
  margin-bottom: 2rem;
}

.section-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.8rem;
}

.section-head h3 {
  color: var(--primary-blue);
}

.section-head h3 i {
  color: var(--primary-gold);
  margin-right: 0.4rem;
}

.mono {
  font-family: Consolas, Menlo, monospace;
  font-size: 0.85rem;
}

.muted { color: var(--text-muted); }

.home-link {
  color: var(--primary-blue);
  text-decoration: none;
  font-size: 0.85rem;
}

.home-link:hover {
  color: var(--primary-gold);
}

.remark-cell {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
  font-size: 0.85rem;
}

.latency { font-family: Consolas, Menlo, monospace; }
.latency.fast { color: #27ae60; }
.latency.mid { color: #e4b85c; }
.latency.slow { color: #e67e22; }

.ai-badge {
  display: inline-block;
  border-radius: 10px;
  padding: 0.12rem 0.55rem;
  font-size: 0.78rem;
  white-space: nowrap;
}

.badge-ok { color: #fff; background: #27ae60; }
.badge-error { color: #fff; background: #c0392b; }
.badge-untested { color: var(--text-muted); background: var(--accent-pink); }
.badge-disabled { color: #fff; background: #95a5a6; }

.alert {
  padding: 0.8rem 1rem;
  border-radius: 10px;
  margin-bottom: 1.2rem;
}

.alert-success { background: #d4edda; color: #155724; }
.alert-error { background: #f8d7da; color: #721c24; }

.modal-overlay {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1200;
}

.modal {
  background: var(--bg-card-solid);
  border-radius: 20px;
  padding: 2rem;
  width: 90%;
  max-width: 520px;
  max-height: 90vh;
  overflow-y: auto;
}

.modal h3 {
  color: var(--primary-blue);
  margin-bottom: 1.5rem;
}

.form-group {
  margin-bottom: 1rem;
}

.form-group label {
  display: block;
  color: var(--primary-blue);
  margin-bottom: 0.4rem;
  font-size: 0.9rem;
  font-weight: 500;
}

.form-group input,
.form-group select {
  width: 100%;
  padding: 0.65rem 1rem;
  border: 2px solid var(--border-light);
  border-radius: 12px;
  background: var(--bg-card-solid);
  color: var(--text-dark);
  font-family: inherit;
}

.form-group input:focus,
.form-group select:focus {
  outline: none;
  border-color: var(--primary-gold);
}

.price-row {
  display: flex;
  gap: 0.8rem;
  flex-wrap: wrap;
}

.price-item {
  display: flex !important;
  align-items: center;
  gap: 0.4rem;
  color: var(--text-dark) !important;
  font-size: 0.85rem !important;
  flex: 1;
  min-width: 140px;
}

.price-item input {
  width: auto !important;
  flex: 1;
  min-width: 80px;
}

.check-label {
  display: flex !important;
  align-items: center;
  gap: 0.6rem;
  cursor: pointer;
}

.form-row {
  display: flex;
  gap: 0.8rem;
}

.form-actions {
  display: flex;
  gap: 0.8rem;
  justify-content: flex-end;
  margin-top: 1.5rem;
}

.ping-results { background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 12px; padding: 1rem 1.2rem; margin-bottom: 1.2rem; }
.ping-results h4 { color: var(--primary-blue); margin: 0; font-size: .95rem; }
.ping-results h4 i { color: var(--primary-gold); margin-right: .4rem; }

.remote-picker { margin-top: .6rem; border: 1px solid var(--border-light); border-radius: 10px; overflow: hidden; }
.remote-picker-head { background: var(--accent-pink); color: var(--text-muted); font-size: .78rem; padding: .4rem .7rem; }
.remote-picker-list { max-height: 200px; overflow-y: auto; display: flex; flex-direction: column; }
.remote-item { display: flex; justify-content: space-between; align-items: center; padding: .45rem .7rem; border: none; background: var(--bg-card-solid); color: var(--text-dark); cursor: pointer; text-align: left; border-bottom: 1px dashed var(--border-light); }
.remote-item:hover { background: var(--bg-card); }
.remote-item.selected { background: var(--accent-pink); color: var(--text-dark); }
.remote-item.existed { opacity: .6; cursor: not-allowed; }

.batch-list { max-height: 420px; overflow-y: auto; border: 1px solid var(--border-light); border-radius: 10px; }
.batch-item { padding: .6rem .7rem; border-bottom: 1px dashed var(--border-light); }
.batch-item:last-child { border-bottom: none; }
.batch-item.selected { background: rgba(232, 184, 92, 0.08); }
.batch-item.existed { opacity: .55; }
.batch-check { display: flex; align-items: center; gap: .5rem; cursor: pointer; font-size: .88rem; }
.batch-fields { margin-top: .5rem; display: flex; flex-direction: column; gap: .4rem; }
.batch-fields input { padding: .4rem .6rem; border: 1px solid var(--border-light); border-radius: 8px; font-size: .85rem; background: var(--bg-card-solid); color: var(--text-dark); }
.batch-fields input:focus { outline: none; border-color: var(--primary-gold); }

.ai-board{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1rem}
.ai-board-card{background:var(--bg-card);border:1px solid var(--border-light);border-radius:14px;padding:1rem 1.1rem;display:flex;flex-direction:column;gap:.55rem;transition:transform .15s,box-shadow .15s}
.ai-board-card:hover{transform:translateY(-2px);box-shadow:var(--shadow-soft)}
.ai-board-head{display:flex;justify-content:space-between;align-items:center;gap:.5rem}
.ai-board-name{font-weight:600;color:var(--primary-blue)}
.ai-board-row{display:flex;justify-content:space-between;align-items:center;gap:.5rem;font-size:.85rem;min-width:0}
.ai-board-label{color:var(--text-muted);font-size:.78rem;flex-shrink:0}
.ai-board-value{flex:1;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.ai-board-actions{display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.2rem}
.ai-board-error{background:var(--accent-pink);color:#e67e22;border-radius:8px;padding:.5rem .7rem;font-size:.8rem;word-break:break-all}
.ai-board-empty{grid-column:1/-1;text-align:center;padding:2rem;color:var(--text-muted)}
.progress-wrap{display:flex;align-items:center;gap:.6rem;margin-bottom:.8rem}
.progress-bar{flex:1;height:8px;background:var(--border-light);border-radius:4px;overflow:hidden}
.progress-fill{height:100%;background:var(--primary-blue);border-radius:4px;transition:width .3s;width:0}
.progress-fill.ping-fill{background:var(--primary-gold)}
.progress-text{font-size:.78rem;color:var(--text-muted);white-space:nowrap}
</style>
