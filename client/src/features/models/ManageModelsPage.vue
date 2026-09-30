<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1>模型管理</h1>
        <p>可以在该模型列表查询全部模型</p>
      </div>
      <div class="page-actions">
        <button class="k-btn sm" type="button" @click="openProvider()"><i class="fas fa-plus"></i> 新建提供商</button>
        <button class="k-btn sm" type="button" @click="openModel()"><i class="fas fa-cube"></i> 添加模型</button>
        <button class="k-btn sm" type="button" :disabled="testing" @click="testAll">
          <i class="fas fa-vial"></i> 测试全部
        </button>
        <button class="k-btn sm" type="button" :disabled="!sel.length || testing" @click="testSelected">
          <i class="fas fa-flask"></i> 测试选中 {{ sel.length ? `(${sel.length})` : '' }}
        </button>
        <button class="k-btn sm" type="button" :disabled="!sel.length" @click="openBatchEdit">
          <i class="fas fa-pen-to-square"></i> 批量修改信息
        </button>
        <button class="k-btn sm" type="button" :disabled="!sel.length" @click="tsOpen = true">
          <i class="fas fa-wand-magic-sparkles"></i> 修改Tool风格 {{ sel.length ? `(${sel.length})` : '' }}
        </button>
        <button class="k-btn sm danger" type="button" :disabled="!sel.length" @click="batchDelete">批量删除</button>
      </div>
    </header>

    <section class="card">
      <div class="prov-head">
        <button class="prov-title" type="button" :title="provOpen ? '折叠提供商列表' : '展开提供商列表'" @click="provOpen = !provOpen">
          <i class="fas" :class="provOpen ? 'fa-caret-down' : 'fa-caret-right'"></i> 提供商
        </button>
        <template v-if="provOpen">
          <input v-model="qProvList" class="nu-input prov-search" placeholder="搜索提供商名称 / 地址…" />
          <span class="muted">{{ shownProviders.length }} / {{ providers.length }}</span>
        </template>
      </div>
      <div v-if="provOpen">
        <div
          v-for="p in shownProviders"
          :key="p.id"
          class="row"
          title="右键可复制该提供商的参数新建一个"
          @contextmenu.prevent="provCtx = { p, x: $event.clientX, y: $event.clientY }"
        >
          <div class="grow">
            <div class="name">
              {{ p.name }}
              <span class="badge" :class="'badge-' + (p.api_style || 'openai')">{{ styleLabel(p.api_style) }}</span>
              <span v-if="p.proxy_enabled" class="badge">代理</span>
            </div>
            <div class="mono muted">{{ p.base_url }} · {{ p.model_count ?? 0 }} 个模型</div>
          </div>
          <button class="btn sm" type="button" @click="pullRemote(p)">批量添加</button>
          <button class="btn sm" type="button" @click="openProvider(p)">编辑</button>
          <button class="btn sm danger" type="button" @click="removeProvider(p)">删除</button>
        </div>
        <KEmpty v-if="!shownProviders.length" :title="providers.length ? '没有匹配的提供商' : '还没有提供商'" :desc="providers.length ? '' : '先新建提供商再添加模型。'" />
      </div>
      <!-- 提供商右键：复制参数是这条菜单存在的理由（同一家多入口/多密钥时不必重配协议） -->
      <template v-if="provCtx">
        <div class="ctx-mask" @mousedown="provCtx = null" @contextmenu.prevent="provCtx = null"></div>
        <div class="ctx-menu" :style="{ left: provCtx.x + 'px', top: provCtx.y + 'px' }" @contextmenu.prevent="provCtx = null">
          <button type="button" @click="duplicateProvider(provCtx.p)">复制提供商参数</button>
          <button type="button" @click="openProvider(provCtx.p)">编辑</button>
          <button type="button" @click="pullRemote(provCtx.p)">批量添加模型</button>
          <button type="button" class="danger" @click="removeProviderFromCtx">删除</button>
        </div>
      </template>
    </section>

    <section class="card">
      <h3>模型</h3>
      <div class="toolbar">
        <input v-model="qProv" class="nu-input" placeholder="搜索提供商…" />
        <input v-model="qModel" class="nu-input" placeholder="搜索模型…" />
        <KDropdown :items="SORT_ITEMS" v-model="sortBy" width="150px" />
        <span class="muted">{{ shownModels.length }} / {{ models.length }}</span>
        <button class="k-btn sm" type="button" @click="toggleView">
          <i class="fas" :class="viewMode === 'list' ? 'fa-table-cells-large' : 'fa-list'"></i>
          {{ viewMode === 'list' ? '网格' : '横列' }}
        </button>
      </div>

      <!-- 横条（表格） -->
      <div v-if="viewMode === 'list'" class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th style="width:36px" class="c-center">
                <input class="k-check" type="checkbox" :checked="allSelected" @change="toggleAll" />
              </th>
              <th>模型</th>
              <th>提供商</th>
              <th class="c-right">单价（入/出/缓存）</th>
              <th class="c-right">延迟</th>
              <th class="c-right">工具风格</th>
              <th class="c-right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in shownModels" :key="m.id" :class="{ picked: sel.includes(m.id) }">
              <td class="c-center">
                <input class="k-check" type="checkbox" :checked="sel.includes(m.id)" @change="toggleSel(m.id)" />
              </td>
              <td>
                <div class="name">{{ m.display_name || m.model_id }}</div>
                <div class="mono muted">{{ m.model_id }}</div>
              </td>
              <td>{{ m.provider_name || providerName(m.provider_id) }}</td>
              <td class="mono c-right">{{ m.price_in ?? '—' }} / {{ m.price_out ?? '—' }} / {{ m.price_cache ?? '—' }}</td>
              <td class="mono c-right" :class="latClass(m)">{{ latText(m) }}</td>
              <td class="mono c-right">{{ m.tool_style || 'auto' }}</td>
              <td class="c-right">
                <div class="row-actions">
                  <button class="btn sm" type="button" :disabled="testing || oneTesting === m.id" @click="testOneModel(m)">
                    {{ oneTesting === m.id ? '测试中…' : '单测' }}
                  </button>
                  <button class="btn sm" type="button" @click="openModel(m)">编辑</button>
                  <button class="btn sm danger" type="button" @click="removeModel(m)">删除</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 方格 -->
      <div v-else class="grid">
        <div v-for="m in shownModels" :key="m.id" class="cell" :class="{ picked: sel.includes(m.id), err: m.status === 'error' }">
          <label class="cell-top">
            <input class="k-check" type="checkbox" :checked="sel.includes(m.id)" @change="toggleSel(m.id)" />
            <div class="grow">
              <div class="name" :title="m.display_name || m.model_id">{{ m.display_name || m.model_id }}</div>
              <div class="mono muted ellip" :title="m.model_id">{{ m.model_id }}</div>
            </div>
          </label>
          <div class="cell-meta mono">
            <span>{{ providerName(m.provider_id) }}</span>
            <span :class="latClass(m)">{{ latText(m) }}</span>
          </div>
          <div class="cell-meta mono muted">
            <span>{{ m.price_in ?? '—' }}/{{ m.price_out ?? '—' }}/{{ m.price_cache ?? '—' }}</span>
            <span>{{ m.tool_style || 'auto' }}</span>
          </div>
          <div class="cell-actions">
            <button class="btn sm" type="button" :disabled="testing || oneTesting === m.id" @click="testOneModel(m)">
              {{ oneTesting === m.id ? '测试中…' : '单测' }}
            </button>
            <button class="btn sm" type="button" @click="openModel(m)">编辑</button>
            <button class="btn sm danger" type="button" @click="removeModel(m)">删除</button>
          </div>
        </div>
        <KEmpty v-if="!shownModels.length" title="没有匹配的模型" />
      </div>
      <KEmpty v-if="!models.length" title="还没有模型" />

      <!-- 异常模型（status=error 且未禁用）：默认折叠，不参与上面列表/方格排序（旧版行为） -->
      <div v-if="errorModels.length" class="err-fold">
        <button class="err-fold-head" type="button" @click="showErrors = !showErrors">
          <i class="fas" :class="showErrors ? 'fa-caret-down' : 'fa-caret-right'"></i>
          <i class="fas fa-triangle-exclamation err-ico"></i>
          <span>异常模型 ({{ errorModels.length }})</span>
          <span class="muted tip">失效的模型默认折叠，点击展开查看</span>
        </button>
        <div v-if="showErrors" class="table-wrap err-fold-body">
          <table class="table">
            <thead>
              <tr>
                <th style="width:36px" class="c-center">
                  <input
                    class="k-check"
                    type="checkbox"
                    :checked="errorModels.every((m) => sel.includes(m.id))"
                    @change="toggleErrorAll"
                  />
                </th>
                <th>模型</th>
                <th>提供商</th>
                <th>报错</th>
                <th class="c-right">上次检测</th>
                <th class="c-right">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in errorModels" :key="'e' + m.id" :class="{ picked: sel.includes(m.id) }">
                <td class="c-center">
                  <input class="k-check" type="checkbox" :checked="sel.includes(m.id)" @change="toggleSel(m.id)" />
                </td>
                <td>
                  <div class="name">{{ m.display_name || m.model_id }}</div>
                  <div class="mono muted">{{ m.model_id }}</div>
                </td>
                <td>{{ m.provider_name || providerName(m.provider_id) }}</td>
                <td>
                  <button class="btn sm err-toggle" type="button" @click="toggleErr(m.id)">
                    <i class="fas" :class="errOpen(m.id) ? 'fa-caret-down' : 'fa-caret-right'"></i>
                  </button>
                  <span v-if="errOpen(m.id)" class="mono err-text">{{ m.error || '—' }}</span>
                  <span v-else class="muted">点击展开报错</span>
                </td>
                <td class="mono c-right muted">{{ fmtTested(m.tested_at) }}</td>
                <td class="c-right">
                  <div class="row-actions">
                    <button class="btn sm" type="button" :disabled="testing || oneTesting === m.id" @click="testOneModel(m)">
                      {{ oneTesting === m.id ? '测试中…' : '重测' }}
                    </button>
                    <button class="btn sm" type="button" @click="openModel(m)">编辑</button>
                    <button class="btn sm danger" type="button" @click="removeModel(m)">删除</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- 提供商编辑（含上游协议） -->
    <KModal :open="pOpen" :title="pForm.id ? '编辑提供商' : '新建提供商'" width="620px" @close="pOpen = false">
      <div class="form">
        <KInput v-model="pForm.name" label="提供商名称 *" block />
        <KInput v-model="pForm.base_url" label="Base URL（截止到 /v1）*" block placeholder="https://api.example.com/v1" />
        <KInput v-model="pForm.api_key" label="API Key *" type="password" block />
        <label class="field">
          <span>上游接口协议 *</span>
          <KDropdown :items="STYLE_ITEMS" v-model="pForm.api_style" block width="100%" @change="onStyleChange" />
        </label>
        <KInput
          v-if="pForm.api_style === 'anthropic'"
          v-model="pForm.max_tokens"
          label="max_tokens（单次回复长度上限，若使用 Anthropic 协议格式则为必选项）"
          type="number"
          block
          placeholder="留空 = 8192；填 0 = 不发送该参数"
        />
        <KInput v-model="pForm.home_url" label="官网首页 URL（模型列表「转到厂家官网」按钮指向）" block />
        <label class="field inline">
          <input class="k-check" type="checkbox" v-model="pForm.proxy_enabled" />
          <span>启用 HTTP 代理</span>
        </label>
        <div v-if="pForm.proxy_enabled" class="grid-2">
          <KInput v-model="pForm.proxy_host" label="代理 IP / 主机" block />
          <KInput v-model="pForm.proxy_port" label="代理端口" type="number" block />
        </div>

        <div v-if="pForm.api_style === 'custom'" class="custom-proto">
          <div class="cp-head">
            <strong>自定义接口字段</strong>
            <span class="muted">带 ＊ 的必填；所有字段都要显式填写，宿主不自动探测</span>
            <button class="btn sm" type="button" @click="fillCustomTemplate">填入 OpenAI 模板</button>
          </div>
          <p class="muted">可用变量：{{ placeholderHint }}</p>
          <label v-for="fld in CUSTOM_TEXT_FIELDS" :key="fld.key" class="cp-item">
            <span>
              {{ fld.label }}
              <em v-if="fld.req">＊必填</em>
              <i v-if="fld.hint">{{ fld.hint }}</i>
            </span>
            <input class="k-input" v-model="customForm[fld.key]" :placeholder="fld.ph" />
          </label>
          <label class="cp-item">
            <span>HTTP 方法</span>
            <KDropdown :items="METHOD_ITEMS" v-model="customForm.method" block width="100%" />
          </label>
          <label class="cp-item">
            <span>headers（JSON 对象）＊必填</span>
            <textarea class="nu-textarea" rows="3" v-model="customHeadersText" :placeholder="customHeadersPlaceholder"></textarea>
          </label>
          <label class="cp-item">
            <span>body（JSON 模板）＊必填</span>
            <textarea class="nu-textarea" rows="7" v-model="customBodyText" :placeholder="customBodyPlaceholder"></textarea>
          </label>
        </div>
      </div>
      <template #footer>
        <button class="btn" type="button" @click="pOpen = false">取消</button>
        <button class="btn primary" type="button" @click="saveProvider">保存</button>
      </template>
    </KModal>

    <!-- 模型编辑 -->
    <KModal :open="mOpen" :title="mForm.id ? '编辑模型' : '添加模型'" width="560px" @close="mOpen = false">
      <div class="form">
        <label class="field">
          <span>提供商</span>
          <KDropdown :items="providerItems" v-model="mForm.provider_id" block width="100%" />
        </label>
        <KInput v-model="mForm.model_id" label="模型 ID" block />
        <KInput v-model="mForm.display_name" label="显示名" block />
        <KInput v-model="mForm.max_context" label="最大上下文（token）" type="number" block />
        <div class="grid-3">
          <KInput v-model="mForm.price_in" label="输入价" type="number" />
          <KInput v-model="mForm.price_out" label="输出价" type="number" />
          <KInput v-model="mForm.price_cache" label="缓存价" type="number" />
        </div>
        <label class="field inline">
          <input class="k-check" type="checkbox" v-model="mForm.supports_thinking" />
          <span>支持思考</span>
        </label>
        <KInput v-model="mForm.thinking_levels" label="思考强度档位（逗号分隔）" block placeholder="low, medium, high" />
        <label class="field">
          <span>工具风格</span>
          <KDropdown :items="TOOL_STYLE_ITEMS" v-model="mForm.tool_style" block width="100%" />
        </label>
        <label class="field">
          <span>备注</span>
          <textarea class="nu-textarea" rows="2" v-model="mForm.remark"></textarea>
        </label>
      </div>
      <template #footer>
        <button class="btn" type="button" @click="mOpen = false">取消</button>
        <button class="btn primary" type="button" @click="saveModel">保存</button>
      </template>
    </KModal>

    <!-- 批量改别名 / 价格：逐条填，一次提交 -->
    <KModal :open="bOpen" :title="`批量编辑 ${batchRows.list.length} 个模型`" width="760px" @close="bOpen = false">
      <p class="muted">别名留空则保持原样；价格不勾「改」就不会提交该列。</p>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>模型</th>
              <th>提供商</th>
              <th style="width:220px">新别名</th>
              <th class="c-center" style="width:36px"><input class="k-check" type="checkbox" v-model="batchRows.editPrice" />价格</th>
              <th style="width:90px">入</th>
              <th style="width:90px">出</th>
              <th style="width:90px">缓存</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in batchRows.list" :key="r.id">
              <td><div class="mono">{{ r.model_id }}</div></td>
              <td class="muted">{{ providerName(r.provider_id) }}</td>
              <td><input class="k-input" v-model="r.display_name" :placeholder="r.display_name_old || '保持原样'" /></td>
              <td class="c-center"><input class="k-check" type="checkbox" v-model="r.priceOn" :disabled="!batchRows.editPrice" /></td>
              <td><input class="k-input" type="number" v-model="r.price_in" :disabled="!batchRows.editPrice || !r.priceOn" /></td>
              <td><input class="k-input" type="number" v-model="r.price_out" :disabled="!batchRows.editPrice || !r.priceOn" /></td>
              <td><input class="k-input" type="number" v-model="r.price_cache" :disabled="!batchRows.editPrice || !r.priceOn" /></td>
            </tr>
          </tbody>
        </table>
      </div>
      <template #footer>
        <button class="btn" type="button" @click="bOpen = false">取消</button>
        <button class="btn primary" type="button" @click="applyBatchEdit">应用到全部</button>
      </template>
    </KModal>

    <!-- 批量改工具风格：所选模型一次定调 -->
    <KModal :open="tsOpen" :title="`批量改工具风格 · 已选 ${sel.length} 个`" width="480px" @close="tsOpen = false">
      <div class="form">
        <label class="field">
          <span>工具风格</span>
          <KDropdown :items="TOOL_STYLE_ITEMS" v-model="tsStyle" block width="100%" />
        </label>
        <p class="muted ts-tip">
          native＝只走原生 function calling，不会因响应异常自动降级成文本协议；auto＝先试原生，失败两次后转文本；
          text＝强制按 JSON 文本发起调用。改动会同时清掉「文本调用」失败计数。
        </p>
        <label class="field row-line">
          <input class="k-check" type="checkbox" v-model="tsResetThinking" />
          <span>同时清掉自动学到的思考参数样式（换协议后思考字段常要重探）</span>
        </label>
      </div>
      <template #footer>
        <button class="btn" type="button" @click="tsOpen = false">取消</button>
        <button class="btn primary" type="button" :disabled="tsBusy" @click="applyToolStyle">
          {{ tsBusy ? '应用中…' : `应用到 ${sel.length} 个模型` }}
        </button>
      </template>
    </KModal>

    <!-- 远程模型批量导入 -->
    <KModal :open="rOpen" :title="'批量添加 · ' + (rProvider?.name || '')" width="560px" @close="rOpen = false">
      <div class="form">
        <div v-if="rLoading" class="muted">拉取中…</div>
        <template v-else>
          <div class="remote-head">
            <button class="btn sm" type="button" @click="batchIds = remoteModels.map(remoteVal)">全选</button>
            <button class="btn sm" type="button" @click="batchIds = []">清空</button>
            <span class="muted">已选 {{ batchIds.length }} / {{ remoteModels.length }}（已存在的会跳过）</span>
          </div>
          <p class="muted">右键某一项可为它单独设置详细参数（价格 / 工具风格 / 显示名 / 思考 / 上下文 / 备注）；设过的项会带「已设」标记。</p>
          <div class="remote-list">
            <label
              v-for="item in remoteModels"
              :key="remoteVal(item)"
              class="remote-item"
              :class="{ 'has-detail': batchDetail[remoteVal(item)] }"
              title="右键设置该模型的详细参数"
              @contextmenu.prevent="openBatchDetail(remoteVal(item))"
            >
              <input
                class="k-check"
                type="checkbox"
                :checked="batchIds.includes(remoteVal(item))"
                @change="toggleBatch(remoteVal(item))"
              />
              <span>{{ remoteLabel(item) }}</span>
              <span v-if="batchDetail[remoteVal(item)]" class="detail-tag">已设</span>
            </label>
            <div v-if="!remoteModels.length" class="muted">没拉到模型列表；可在下面手动粘贴模型 ID。</div>
          </div>
          <p class="muted">也可手动粘贴模型 ID，逗号分隔</p>
          <KInput v-model="batchManual" label="手动模型 ID" block placeholder="gpt-4o, claude-x" />
        </template>
      </div>
      <template #footer>
        <button class="btn" type="button" @click="rOpen = false">取消</button>
        <button class="btn primary" type="button" @click="importBatch">添加</button>
      </template>
    </KModal>

    <!-- 批量添加时的单项详细参数：一次填完直接进库，省掉「先加进来再逐个编辑」 -->
    <KModal :open="bdOpen" :title="'详细参数 · ' + (bdId || '')" width="560px" @close="bdOpen = false">
      <div class="form">
        <KInput v-model="bdForm.display_name" label="显示名" block :placeholder="bdId || '留空 = 用模型 ID'" />
        <KInput v-model="bdForm.max_context" label="最大上下文（token）" type="number" block />
        <div class="grid-3">
          <KInput v-model="bdForm.price_in" label="输入价" type="number" />
          <KInput v-model="bdForm.price_out" label="输出价" type="number" />
          <KInput v-model="bdForm.price_cache" label="缓存价" type="number" />
        </div>
        <label class="field inline">
          <input class="k-check" type="checkbox" v-model="bdForm.supports_thinking" />
          <span>支持思考（取消勾选后该模型不会收到任何思考参数）</span>
        </label>
        <KInput v-model="bdForm.thinking_levels" label="思考强度档位（逗号分隔）" block placeholder="low, medium, high" />
        <label class="field">
          <span>工具风格</span>
          <KDropdown :items="TOOL_STYLE_ITEMS" v-model="bdForm.tool_style" block width="100%" />
        </label>
        <label class="field">
          <span>备注</span>
          <textarea class="nu-textarea" rows="2" v-model="bdForm.remark"></textarea>
        </label>
        <p v-if="batchIds.length > 1" class="muted">下面这个按钮会把这份参数套到当前已选的 {{ batchIds.length }} 个模型上。</p>
      </div>
      <template #footer>
        <button class="btn" type="button" @click="bdOpen = false">取消</button>
        <button v-if="batchIds.length > 1" class="btn" type="button" @click="applyBatchDetailToAll">应用到所有已选</button>
        <button class="btn primary" type="button" @click="saveBatchDetail">保存到这一项</button>
      </template>
    </KModal>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { aiApi } from '../../api';
import { toast } from '../../stores/toast';
import { toastErr } from '../../utils/errText';
import KModal from '../../ui/KModal.vue';
import KInput from '../../ui/KInput.vue';
import KEmpty from '../../ui/KEmpty.vue';
import KDropdown from '../../ui/KDropdown.vue';

const SORT_ITEMS = [
  { value: 'id', label: '按添加时间' },
  { value: 'name', label: '按名称' },
  { value: 'latency', label: '按延迟' },
  { value: 'status', label: '按状态' },
];
const STYLE_ITEMS = [
  { value: 'openai', label: 'OpenAI 兼容' },
  { value: 'anthropic', label: 'Anthropic 兼容' },
  { value: 'custom', label: '自定义接口' },
];
const METHOD_ITEMS = ['POST', 'GET', 'PUT', 'PATCH'].map((m) => ({ value: m, label: m }));
const TOOL_STYLE_ITEMS = [
  { value: 'auto', label: 'auto（自动判定）' },
  { value: 'native', label: 'native（强制函数调用）' },
  { value: 'text', label: 'text（强制文本协议）' },
];

const providers = ref([]);
const models = ref([]);
const qProv = ref('');
const qModel = ref('');
const sortBy = ref('id');
const viewMode = ref(localStorage.getItem('nu_mm_view') || 'list');
const sel = ref([]);
const testing = ref(false);
const oneTesting = ref(null);
/** 异常模型折叠区：默认收起（迁移后 280 个模型里 135 个异常，铺开会把页面撑满） */
const showErrors = ref(false);
const openErrIds = ref(new Set());

function isBad(m) {
  return m.status === 'error' && !m.disabled;
}

function errOpen(id) {
  return openErrIds.value.has(id);
}
function toggleErr(id) {
  const s = new Set(openErrIds.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  openErrIds.value = s;
}

function fmtTested(t) {
  return t ? String(t).replace('T', ' ').substring(0, 19) : '—';
}

function toggleErrorAll(e) {
  const ids = errorModels.value.map((m) => m.id);
  if (e?.target?.checked) sel.value = [...new Set([...sel.value, ...ids])];
  else sel.value = sel.value.filter((id) => !ids.includes(id));
}

const shownModels = computed(() => {
  const qp = qProv.value.trim().toLowerCase();
  const qm = qModel.value.trim().toLowerCase();
  let list = models.value.filter((m) => {
    if (isBad(m)) return false; // 异常模型统一放到底部折叠区
    if (qp && !String(m.provider_name || providerName(m.provider_id) || '').toLowerCase().includes(qp)) return false;
    if (qm && !`${m.model_id} ${m.display_name || ''}`.toLowerCase().includes(qm)) return false;
    return true;
  });
  const key = sortBy.value;
  list = list.slice().sort((a, b) => {
    if (key === 'name') return String(a.display_name || a.model_id).localeCompare(String(b.display_name || b.model_id));
    if (key === 'latency') return (a.latency_ms ?? 1e9) - (b.latency_ms ?? 1e9);
    if (key === 'status') return String(a.status || '').localeCompare(String(b.status || ''));
    return (a.id || 0) - (b.id || 0);
  });
  return list;
});

/** 折叠区里的异常模型：跟随同一个搜索词，方便「搜某提供商 → 看它挂了哪些」 */
const errorModels = computed(() => {
  const qp = qProv.value.trim().toLowerCase();
  const qm = qModel.value.trim().toLowerCase();
  return models.value.filter((m) => {
    if (!isBad(m)) return false;
    if (qp && !String(m.provider_name || providerName(m.provider_id) || '').toLowerCase().includes(qp)) return false;
    if (qm && !`${m.model_id} ${m.display_name || ''} ${m.error || ''}`.toLowerCase().includes(qm)) return false;
    return true;
  });
});

const providerItems = computed(() =>
  providers.value.map((p) => ({ value: p.id, label: `${p.name}（${styleLabel(p.api_style)}）` }))
);

const allSelected = computed(() => shownModels.value.length > 0 && shownModels.value.every((m) => sel.value.includes(m.id)));

function toggleAll() {
  if (allSelected.value) {
    const ids = new Set(shownModels.value.map((m) => m.id));
    sel.value = sel.value.filter((id) => !ids.has(id));
  } else {
    sel.value = [...new Set([...sel.value, ...shownModels.value.map((m) => m.id)])];
  }
}

function styleLabel(s) {
  return { openai: 'OpenAI', anthropic: 'Anthropic', custom: '自定义' }[(s || 'openai').toLowerCase()] || 'OpenAI';
}

function toggleView() {
  viewMode.value = viewMode.value === 'list' ? 'grid' : 'list';
  try { localStorage.setItem('nu_mm_view', viewMode.value); } catch { /* ignore */ }
}

function latText(m) {
  if (m.status === 'error') return m.error ? String(m.error).substring(0, 40) : '异常';
  if (m.latency_ms == null) return '未测';
  return `${m.latency_ms}ms`;
}
function latClass(m) {
  // 旧版：≤1500 绿 / ≤4000 金 / 更大 橙 / error 红 / 未知灰
  if (m.status === 'error') return 'lat-err';
  if (m.latency_ms == null) return 'lat-unk';
  if (m.latency_ms <= 1500) return 'lat-ok';
  if (m.latency_ms <= 4000) return 'lat-mid';
  return 'lat-slow';
}

onMounted(loadAll);

async function loadAll() {
  const [ps, ms] = await Promise.all([aiApi.getProviders(), aiApi.getModels()]);
  providers.value = Array.isArray(ps) ? ps : ps?.list || [];
  models.value = Array.isArray(ms) ? ms : ms?.list || [];
}

function providerName(id) {
  return providers.value.find((p) => p.id === id)?.name || '';
}

/* ---------------- 测试 ---------------- */

async function runTests(label, fn) {
  testing.value = true;
  try {
    await fn();
    await loadAll();
    toast(label, 'success');
  } catch (e) {
    toastErr(e, '测试失败');
  } finally {
    testing.value = false;
    oneTesting.value = null;
  }
}

function testAll() {
  return runTests('全部测试完成', () => aiApi.testAll());
}
function testSelected() {
  return runTests(`已测试 ${sel.value.length} 个模型`, () => aiApi.testMany(sel.value));
}
function testOneModel(m) {
  oneTesting.value = m.id;
  return runTests(`${m.display_name || m.model_id} 测试完成`, () => aiApi.testOne(m.id));
}

/* ---------------- 提供商 ---------------- */

/** 列表整块折叠（提供商多的时候这一屏能占半页；状态记本地，跟视图模式同一个路子） */
const provOpen = ref(localStorage.getItem('nu_mm_prov') !== '0');
const qProvList = ref('');
const provCtx = ref(null);

watch(provOpen, (v) => localStorage.setItem('nu_mm_prov', v ? '1' : '0'));

const shownProviders = computed(() => {
  const q = qProvList.value.trim().toLowerCase();
  if (!q) return providers.value;
  return providers.value.filter((p) => `${p.name || ''} ${p.base_url || ''}`.toLowerCase().includes(q));
});

/** 复制整行参数新建一个「原名_序号」：同一家换密钥/换入口时不必重配协议 */
async function duplicateProvider(p) {
  provCtx.value = null;
  try {
    const r = await aiApi.duplicateProvider(p.id);
    await loadAll();
    toast(`已复制为「${r?.name || p.name + '_2'}」，参数与原提供商一致（模型未复制，用「批量添加」现拉）`, 'success', 5000);
  } catch (e) {
    toastErr(e, '复制提供商失败');
  }
}

function removeProviderFromCtx() {
  const p = provCtx.value?.p;
  provCtx.value = null;
  if (p) removeProvider(p);
}

const pOpen = ref(false);
const emptyProvider = () => ({
  id: null, name: '', base_url: '', api_key: '', home_url: '',
  proxy_enabled: false, proxy_host: '', proxy_port: '',
  api_style: 'openai', max_tokens: '',
});
const pForm = reactive(emptyProvider());

/* 自定义协议：字段一律由用户填写（占位符串放在 script 里，避免和 Vue 模板插值冲突） */
const ph = (k) => '{' + '{' + k + '}' + '}';
const placeholderHint = ['model', 'messages', 'prompt', 'system', 'stream', 'temperature', 'max_tokens', 'tools', 'key', 'base']
  .map(ph).join(' ');
const CUSTOM_TEXT_FIELDS = [
  { key: 'chat_url', label: 'chat_url 对话端点', req: true, ph: `${ph('base')}/v2/chat 或 https://full.url/chat`, hint: '以 http(s):// 开头视为完整地址，否则相对 BaseURL' },
  { key: 'list_url', label: 'list_url 模型列表端点', req: true, ph: `${ph('base')}/v2/models`, hint: '「批量添加」按钮用' },
  { key: 'list_path', label: 'list_path 列表数组路径', req: true, ph: '$.data', hint: '指向模型数组的位置' },
  { key: 'content_path', label: 'content_path 正文路径（非流式）', req: true, ph: '$.data.answer', hint: '测速/压缩等一次性请求按此取值' },
  { key: 'stream_content_path', label: 'stream_content_path 正文路径（流式）', req: true, ph: '$.choices[0].delta.content', hint: '每个 SSE 帧里正文增量的位置' },
  { key: 'reasoning_path', label: 'reasoning_path 思考路径（非流式）', ph: '$.data.reasoning', hint: '上游没有就留空' },
  { key: 'stream_reasoning_path', label: 'stream_reasoning_path 思考路径（流式）', ph: '$.choices[0].delta.reasoning_content', hint: '留空则思考按正文输出' },
  { key: 'error_path', label: 'error_path 错误信息路径', ph: '$.error.message', hint: '留空则只按 HTTP 状态码判错' },
  { key: 'usage_prompt_path', label: 'usage_prompt_path 输入 token 路径', ph: '$.usage.prompt_tokens', hint: '留空则不记用量' },
  { key: 'usage_completion_path', label: 'usage_completion_path 输出 token 路径', ph: '$.usage.completion_tokens', hint: '留空则不记用量' },
  { key: 'done_value', label: 'done_value 流结束标记', ph: '[DONE]', hint: '该帧按结束处理，不当 JSON 解析' },
];
const customBodyPlaceholder = `{"model":"${ph('model')}","messages":"${ph('messages')}","stream":true}`;
const customHeadersPlaceholder = `{"Content-Type":"application/json","Authorization":"Bearer ${ph('key')}"}`;

function emptyCustom() {
  const o = {};
  for (const f of CUSTOM_TEXT_FIELDS) o[f.key] = '';
  o.method = 'POST';
  return o;
}
const customForm = reactive(emptyCustom());
const customHeadersText = ref('{\n  "Content-Type": "application/json",\n  "Authorization": "Bearer ' + ph('key') + '"\n}');
const customBodyText = ref('{\n  "model": "' + ph('model') + '",\n  "messages": "' + ph('messages') + '",\n  "stream": true\n}');

function fillCustomTemplate() {
  Object.assign(customForm, emptyCustom(), {
    chat_url: `${ph('base')}/chat/completions`,
    list_url: `${ph('base')}/models`,
    list_path: '$.data',
    content_path: '$.choices[0].message.content',
    stream_content_path: '$.choices[0].delta.content',
    reasoning_path: '$.choices[0].message.reasoning_content',
    stream_reasoning_path: '$.choices[0].delta.reasoning_content',
    error_path: '$.error.message',
    usage_prompt_path: '$.usage.prompt_tokens',
    usage_completion_path: '$.usage.completion_tokens',
    done_value: '[DONE]',
    method: 'POST',
  });
  customHeadersText.value = '{\n  "Content-Type": "application/json",\n  "Authorization": "Bearer ' + ph('key') + '"\n}';
  customBodyText.value = '{\n  "model": "' + ph('model') + '",\n  "messages": "' + ph('messages') + '",\n  "stream": true\n}';
}

function onStyleChange() {
  if (pForm.api_style === 'custom' && !customForm.chat_url) fillCustomTemplate();
}

function applyProviderCustom(p) {
  const cfg = emptyCustom();
  let raw = p.custom;
  if (typeof raw === 'string' && raw.trim()) {
    try { raw = JSON.parse(raw); } catch { raw = null; }
  }
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(cfg)) if (raw[k] !== undefined && raw[k] !== null) cfg[k] = String(raw[k]);
    cfg.method = raw.method || 'POST';
    customHeadersText.value = JSON.stringify(raw.headers || {}, null, 2);
    customBodyText.value = JSON.stringify(raw.body || {}, null, 2);
  }
  Object.assign(customForm, cfg);
}

/** headers/body 两个 JSON 文本域 → 对象；不合法就报出来 */
function parseCustomForm() {
  let headers = null;
  let body = null;
  try { headers = JSON.parse(customHeadersText.value || '{}'); } catch { return { error: 'headers 不是合法 JSON' }; }
  try { body = JSON.parse(customBodyText.value || '{}'); } catch { return { error: 'body 不是合法 JSON' }; }
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return { error: 'headers 必须是 JSON 对象' };
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body 必须是 JSON 对象模板' };
  const cfg = {};
  for (const f of CUSTOM_TEXT_FIELDS) cfg[f.key] = String(customForm[f.key] ?? '').trim();
  cfg.method = customForm.method || 'POST';
  return { value: { ...cfg, headers, body } };
}

function openProvider(p) {
  Object.assign(pForm, emptyProvider());
  if (p) {
    Object.assign(pForm, {
      id: p.id, name: p.name || '', base_url: p.base_url || '', api_key: p.api_key || '',
      home_url: p.home_url || '', proxy_enabled: !!p.proxy_enabled,
      proxy_host: p.proxy_host || '', proxy_port: p.proxy_port || '',
      api_style: (p.api_style || 'openai').toLowerCase(),
      max_tokens: p.max_tokens === null || p.max_tokens === undefined ? '' : String(p.max_tokens),
    });
    applyProviderCustom(p);
  } else {
    Object.assign(customForm, emptyCustom());
  }
  pOpen.value = true;
}

async function saveProvider() {
  if (!pForm.name.trim() || !pForm.base_url.trim() || !pForm.api_key.trim()) {
    return toast('名称、Base URL、API Key 都要填', 'warn');
  }
  const body = {
    name: pForm.name.trim(),
    base_url: pForm.base_url.trim(),
    api_key: pForm.api_key.trim(),
    home_url: pForm.home_url || '',
    proxy_enabled: pForm.proxy_enabled ? 1 : 0,
    proxy_host: pForm.proxy_host || '',
    proxy_port: pForm.proxy_port || 0,
    api_style: pForm.api_style || 'openai',
  };
  if (pForm.api_style === 'anthropic') {
    const t = String(pForm.max_tokens ?? '').trim();
    if (t !== '') body.max_tokens = Number(t);
  }
  if (pForm.api_style === 'custom') {
    const c = parseCustomForm();
    if (c.error) return toast(c.error, 'error');
    body.custom = c.value;
  }
  try {
    if (pForm.id) await aiApi.updateProvider(pForm.id, body);
    else await aiApi.createProvider(body);
    pOpen.value = false;
    await loadAll();
    toast('已保存', 'success');
  } catch (e) {
    toastErr(e, '保存失败');
  }
}

async function removeProvider(p) {
  if (!window.confirm(`删除提供商「${p.name}」及其 ${p.model_count ?? ''} 个模型？`)) return;
  try {
    await aiApi.deleteProvider(p.id);
    await loadAll();
  } catch (e) {
    toastErr(e, '删除失败');
  }
}

/* ---------------- 模型 ---------------- */

const mOpen = ref(false);
// 新建默认：支持思考 + 走原生 function calling。思考现在是真的有作用 ——
// 取消勾选后上游一个思考参数都收不到（见 routes/ai.js 的 supports_thinking 判定）。
const modelDefaults = () => ({
  id: null, provider_id: null, model_id: '', display_name: '',
  price_in: 0, price_out: 0, price_cache: 0, max_context: 0, remark: '',
  supports_thinking: true, thinking_levels: '', tool_style: 'native',
});
const mForm = reactive(modelDefaults());

function openModel(m) {
  const base = { ...modelDefaults(), provider_id: providers.value[0]?.id ?? null };
  if (m) {
    Object.assign(base, m, {
      supports_thinking: !!m.supports_thinking,
      thinking_levels: m.thinking_levels || '',
    });
  }
  Object.assign(mForm, base);
  mOpen.value = true;
}

async function saveModel() {
  if (!mForm.provider_id) return toast('请选择提供商', 'warn');
  if (!String(mForm.model_id || '').trim()) return toast('请填写模型 ID', 'warn');
  const body = {
    provider_id: mForm.provider_id,
    model_id: String(mForm.model_id).trim(),
    display_name: mForm.display_name || mForm.model_id,
    price_in: Number(mForm.price_in) || 0,
    price_out: Number(mForm.price_out) || 0,
    price_cache: Number(mForm.price_cache) || 0,
    max_context: Number(mForm.max_context) || 0,
    remark: mForm.remark || '',
    supports_thinking: mForm.supports_thinking ? 1 : 0,
    thinking_levels: mForm.thinking_levels || '',
    tool_style: mForm.tool_style || 'native',
  };
  try {
    if (mForm.id) await aiApi.updateModel(mForm.id, body);
    else await aiApi.createModel(body);
    if (mForm.id) {
      try { await aiApi.setModelToolStyle(mForm.id, mForm.tool_style || 'native', false); } catch { /* optional */ }
    }
    mOpen.value = false;
    await loadAll();
    toast('已保存', 'success');
  } catch (e) {
    toastErr(e, '保存失败');
  }
}

async function removeModel(m) {
  if (!window.confirm(`删除模型「${m.display_name || m.model_id}」？`)) return;
  try {
    await aiApi.deleteModel(m.id);
    await loadAll();
  } catch (e) {
    toastErr(e, '删除失败');
  }
}

function toggleSel(id) {
  const i = sel.value.indexOf(id);
  if (i >= 0) sel.value.splice(i, 1);
  else sel.value.push(id);
}

async function batchDelete() {
  if (!window.confirm(`删除选中的 ${sel.value.length} 个模型？`)) return;
  try {
    await aiApi.batchDeleteModels(sel.value);
    sel.value = [];
    await loadAll();
    toast('已删除', 'success');
  } catch (e) {
    toastErr(e, '删除失败');
  }
}

/* ---------------- 批量改别名 / 价格 ---------------- */

const bOpen = ref(false);
const batchRows = reactive({ list: [], editPrice: true });

function openBatchEdit() {
  const picked = models.value.filter((m) => sel.value.includes(m.id));
  if (!picked.length) return toast('先勾选模型', 'warn');
  batchRows.list = picked.map((m) => ({
    id: m.id,
    model_id: m.model_id,
    provider_id: m.provider_id,
    display_name: m.display_name || '',
    display_name_old: m.display_name || '',
    priceOn: true,
    price_in: m.price_in ?? 0,
    price_out: m.price_out ?? 0,
    price_cache: m.price_cache ?? 0,
    supports_thinking: m.supports_thinking ? 1 : 0,
    thinking_levels: m.thinking_levels || '',
    max_context: m.max_context ?? 0,
    remark: m.remark || '',
    tool_style: m.tool_style || 'auto',
  }));
  batchRows.editPrice = true;
  bOpen.value = true;
}

async function applyBatchEdit() {
  let done = 0;
  const errs = [];
  for (const r of batchRows.list) {
    const body = {
      provider_id: r.provider_id,
      model_id: r.model_id,
      display_name: (r.display_name || '').trim() || r.display_name_old || r.model_id,
      max_context: Number(r.max_context) || 0,
      price_in: batchRows.editPrice && r.priceOn ? Number(r.price_in) || 0 : undefined,
      price_out: batchRows.editPrice && r.priceOn ? Number(r.price_out) || 0 : undefined,
      price_cache: batchRows.editPrice && r.priceOn ? Number(r.price_cache) || 0 : undefined,
      remark: r.remark || '',
      supports_thinking: r.supports_thinking ? 1 : 0,
      thinking_levels: r.thinking_levels || '',
      tool_style: r.tool_style || 'auto',
    };
    for (const k of ['price_in', 'price_out', 'price_cache']) if (body[k] === undefined) delete body[k];
    try {
      await aiApi.updateModel(r.id, body);
      done += 1;
    } catch (e) {
      errs.push(`${r.model_id}：${e?.response?.data?.message || e.message}`);
    }
  }
  await loadAll();
  bOpen.value = false;
  if (errs.length) toast(`${done} 个已更新，${errs.length} 个失败（${errs[0]}）`, 'warn', 6000);
  else toast(`已更新 ${done} 个模型`, 'success');
}

/* ---------------- 批量改工具风格 ---------------- */

const tsOpen = ref(false);
const tsStyle = ref('native');
const tsResetThinking = ref(false);
const tsBusy = ref(false);

async function applyToolStyle() {
  if (!sel.value.length) return toast('先勾选模型', 'warn');
  tsBusy.value = true;
  try {
    const r = await aiApi.batchModelToolStyle({ ids: sel.value, tool_style: tsStyle.value, reset_thinking: tsResetThinking.value });
    tsOpen.value = false;
    await loadAll();
    toast(`已把 ${r?.updated ?? sel.value.length} 个模型的工具风格改为 ${r?.style || tsStyle.value}`, 'success');
  } catch (e) {
    toastErr(e, '批量修改失败', 6000);
  } finally {
    tsBusy.value = false;
  }
}

/* ---------------- 远程拉取 ---------------- */

const rOpen = ref(false);
const rLoading = ref(false);
const rProvider = ref(null);
const remoteModels = ref([]);
const batchIds = ref([]);
const batchManual = ref('');

function remoteVal(item) {
  if (item == null) return '';
  if (typeof item === 'string') {
    const t = item.trim();
    if (t.startsWith('{')) {
      try {
        const o = JSON.parse(t);
        return o.id || o.model || o.name || o.model_id || t;
      } catch { /* raw */ }
    }
    return t;
  }
  return String(item.id || item.model || item.name || item.model_id || '');
}

function remoteLabel(item) {
  if (typeof item === 'string' && !item.trim().startsWith('{')) return item;
  const o = typeof item === 'string' ? safeParse(item) : item;
  if (!o || typeof o !== 'object') return String(item);
  return o.display_name || o.displayName || o.name || o.id || o.model || o.model_id || JSON.stringify(o).slice(0, 80);
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

async function pullRemote(p) {
  rProvider.value = p;
  rOpen.value = true;
  rLoading.value = true;
  batchIds.value = [];
  for (const k of Object.keys(batchDetail)) delete batchDetail[k];   // 换提供商就别带着上一份参数
  try {
    const res = await aiApi.getRemoteModels(p.id);
    const list = res?.list || res?.models || res?.data || res || [];
    remoteModels.value = Array.isArray(list) ? list : [];
  } catch {
    remoteModels.value = [];
  } finally {
    rLoading.value = false;
  }
}

function toggleBatch(id) {
  const i = batchIds.value.indexOf(id);
  if (i >= 0) batchIds.value.splice(i, 1);
  else batchIds.value.push(id);
}

/* 批量添加时的逐项详细参数：键是远程模型 ID，值是待提交的字段。
   没设过的项走服务端默认（支持思考 + native），设过的项整份覆盖。 */
const batchDetail = reactive({});
const bdOpen = ref(false);
const bdId = ref('');
const bdForm = reactive(modelDefaults());

function openBatchDetail(id) {
  if (!id) return;
  if (!batchIds.value.includes(id)) batchIds.value = [...batchIds.value, id];
  bdId.value = id;
  Object.assign(bdForm, modelDefaults(), batchDetail[id] || {}, {
    id: null, provider_id: rProvider.value?.id ?? null, model_id: id,
    display_name: (batchDetail[id] && batchDetail[id].display_name) || id,
  });
  bdOpen.value = true;
}

function bdSnapshot() {
  return {
    model_id: bdId.value,
    display_name: bdForm.display_name || bdId.value,
    price_in: Number(bdForm.price_in) || 0,
    price_out: Number(bdForm.price_out) || 0,
    price_cache: Number(bdForm.price_cache) || 0,
    max_context: Number(bdForm.max_context) || 0,
    remark: bdForm.remark || '',
    supports_thinking: bdForm.supports_thinking ? 1 : 0,
    thinking_levels: bdForm.thinking_levels || '',
    tool_style: bdForm.tool_style || 'native',
  };
}

function saveBatchDetail() {
  batchDetail[bdId.value] = bdSnapshot();
  bdOpen.value = false;
}

/** 一份参数套到所有已选：批量导入几十个模型时，这是「一次操作」而不是逐条点 */
function applyBatchDetailToAll() {
  const one = bdSnapshot();
  for (const id of batchIds.value) {
    batchDetail[id] = { ...one, model_id: id, display_name: one.model_id === id ? one.display_name : id };
  }
  bdOpen.value = false;
  toast(`已把这套参数记到 ${batchIds.value.length} 个模型上，点「添加」后写入`, 'success', 5000);
}

async function importBatch() {
  const manual = batchManual.value.split(',').map((s) => s.trim()).filter(Boolean);
  const existed = new Set(models.value.filter((m) => m.provider_id === rProvider.value?.id).map((m) => m.model_id));
  const ids = [...new Set([...batchIds.value.map((x) => String(x)).filter(Boolean), ...manual])].filter((id) => !existed.has(id));
  if (!ids.length) return toast('没有可添加的模型（可能都已存在）', 'warn');
  if (!rProvider.value?.id) return toast('缺少提供商', 'warn');
  const payload = ids.map((id) => {
    const d = batchDetail[id];
    // 没单独设过的项也要显式给 defaults：批量接口不传 supports_thinking 时服务端按「支持」处理，
    // 这里写清楚，免得过几天默认值又改了而这里静默跟着变
    return d ? { model_id: id, ...d } : { model_id: id, display_name: id, supports_thinking: 1, tool_style: 'native' };
  });
  try {
    await aiApi.batchCreateModels({ provider_id: rProvider.value.id, models: payload });
    rOpen.value = false;
    batchIds.value = [];
    batchManual.value = '';
    for (const k of Object.keys(batchDetail)) delete batchDetail[k];
    await loadAll();
    toast(`已添加 ${ids.length} 个模型`, 'success');
  } catch (e) {
    toastErr(e, '添加失败');
  }
}
</script>

<style scoped>
.page { padding: 24px 28px 40px; max-width: 1100px; margin: 0 auto; }
.page-head { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
.page-head h1 { margin: 0; font-size: 20px; }
.page-head p { margin: 4px 0 0; color: var(--text-3); font-size: 12px; }
.page-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.card {
  background: var(--bg-elev);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  padding: 14px;
  margin-bottom: 16px;
}
.card h3 { margin: 0 0 12px; font-size: 14px; }
.prov-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.prov-title {
  background: none; border: 0; padding: 0; cursor: pointer; color: var(--text-1);
  font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 6px;
}
.prov-title i { color: var(--text-3); font-size: 12px; width: 12px; }
.prov-search { flex: 1; max-width: 320px; }
.row { display: flex; align-items: center; gap: 8px; padding: 10px 0; border-bottom: 1px solid var(--border-soft); }
.row:last-child { border-bottom: 0; }
.grow { flex: 1; min-width: 0; }
.name { font-weight: 500; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mono { font-family: var(--mono); font-size: 11px; word-break: break-all; }
.muted { color: var(--text-3); font-size: 12px; }
.ellip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge { font-size: 10px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--border-strong); color: var(--text-3); }
.badge-openai { color: var(--text-2); }
.badge-anthropic { color: var(--terra); border-color: currentColor; }
.badge-custom { color: var(--accent); border-color: currentColor; }
.toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
.table-wrap { overflow: auto; }
.table { width: 100%; border-collapse: collapse; }
.table th, .table td {
  padding: 10px 8px;
  border-bottom: 1px solid var(--border-soft);
  text-align: left;
  font-size: 12px;
  vertical-align: middle;
}
.table th { color: var(--text-3); font-weight: 500; white-space: nowrap; }
.c-right, .table td.c-right { text-align: right; }
.c-center, .table td.c-center { text-align: center; }
tr.picked { background: var(--state-layer); }
.row-actions { display: flex; gap: 6px; align-items: center; justify-content: flex-end; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
.cell {
  display: flex; flex-direction: column; gap: 6px;
  padding: 10px 12px;
  background: var(--bg-panel);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
}
.cell.picked { border-color: var(--accent); }
.cell.err { border-color: var(--danger-line); }
.cell-top { display: flex; gap: 8px; align-items: flex-start; }
.cell-meta { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; }
.cell-actions { display: flex; gap: 6px; margin-top: 2px; }
.form { display: flex; flex-direction: column; gap: 12px; }
.field { display: flex; flex-direction: column; gap: 6px; }
/* 批量改工具风格弹窗里：勾选框 + 说明 */
.field.row-line { flex-direction: row; align-items: flex-start; gap: 8px; }
.field.row-line span { font-size: 12px; line-height: 1.5; }
.ts-tip { margin: 0; font-size: 11px; line-height: 1.6; }
.field.inline { flex-direction: row; align-items: center; gap: 8px; }
.field span { font-size: 12px; color: var(--text-3); }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
.custom-proto {
  display: flex; flex-direction: column; gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  background: var(--bg-panel);
}
.cp-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.cp-head .btn { margin-left: auto; }
.cp-item { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.cp-item span { color: var(--text-3); }
.cp-item em { font-style: normal; color: var(--danger); margin-left: 4px; }
.cp-item i { font-style: normal; opacity: 0.75; margin-left: 6px; font-size: 11px; }
.cp-item .k-input, .cp-item .k-select, .cp-item .nu-textarea { padding: 6px 8px; font-size: 12px; }
.nu-textarea {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px;
  font-family: var(--mono);
  font-size: 11px;
  resize: vertical;
  width: 100%;
}
.remote-head { display: flex; gap: 8px; align-items: center; }
.remote-list {
  max-height: 280px; overflow: auto;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  padding: 8px;
}
.remote-item { display: flex; gap: 8px; align-items: center; padding: 6px 4px; }
.remote-item.has-detail { background: color-mix(in srgb, var(--accent) 10%, transparent); border-radius: 6px; }
.detail-tag { font-size: 10px; color: var(--accent); border: 1px solid currentColor; border-radius: 999px; padding: 0 6px; }
.btn {
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  border-radius: var(--radius-xs);
  padding: 6px 12px;
  font-size: 12px;
}
.btn.sm { padding: 4px 8px; font-size: 11px; }
.btn:disabled { opacity: 0.5; cursor: default; }
.btn.primary { background: var(--accent); border-color: transparent; color: var(--on-accent); font-weight: 600; }
.btn.danger { color: var(--danger); }
.lat-ok { color: var(--ok); }
.lat-mid { color: var(--warn); }
.lat-slow { color: var(--danger); }
.lat-err { color: var(--danger); }
.lat-unk { color: var(--text-3); }

/* 异常模型折叠区 */
.err-fold { margin-top: 14px; border-top: 1px solid var(--border-soft); }
.err-fold-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 4px;
  color: var(--text-2);
  font-size: 13px;
  text-align: left;
}
.err-fold-head:hover { color: var(--text); }
.err-fold-head .tip { margin-left: auto; font-size: 11px; }
.err-ico { color: var(--warn); }
.err-fold-body { max-height: 420px; overflow: auto; border: 1px solid var(--border-soft); border-radius: var(--radius-sm); }
.err-toggle { padding: 2px 6px; margin-right: 6px; }
.err-text {
  color: var(--danger);
  font-size: 11px;
  white-space: normal;
  word-break: break-all;
}
</style>
