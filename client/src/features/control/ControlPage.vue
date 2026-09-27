<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1>控制台</h1>
        <p>运行状态与常用开关</p>
      </div>
    </header>

    <section class="grid">
      <div class="stat">
        <div class="label">提供商</div>
        <div class="value">{{ status._providers ?? '—' }}</div>
      </div>
      <div class="stat">
        <div class="label">模型</div>
        <div class="value">{{ status._models ?? '—' }}</div>
      </div>
      <div class="stat">
        <div class="label">可用模型</div>
        <div class="value">{{ status._usable ?? '—' }}</div>
      </div>
      <div class="stat">
        <div class="label">Shell</div>
        <div class="value small">{{ shell || status._shell || '—' }}</div>
      </div>
    </section>

    <section class="card">
      <h3>快捷入口</h3>
      <div class="links">
        <button class="btn" type="button" @click="$router.push('/chat')">聊天</button>
        <button class="btn" type="button" @click="$router.push('/models')">模型库</button>
        <button class="btn" type="button" @click="$router.push('/models/manage')">模型管理</button>
        <button class="btn" type="button" @click="$router.push('/usage')">用量</button>
        <button class="btn" type="button" @click="$router.push('/trace')">轨迹</button>
        <button class="btn" type="button" @click="$router.push('/settings')">设置</button>
      </div>
    </section>

    <section class="card">
      <h3>审批模式</h3>
      <div class="links">
        <button
          v-for="m in ['default', 'strict', 'exempt']"
          :key="m"
          class="btn"
          :class="{ primary: approvalMode === m }"
          type="button"
          @click="setMode(m)"
        >{{ labelOf(m) }}</button>
      </div>
      <p class="muted">{{ hintOf(approvalMode) }}</p>
    </section>

    <section class="card">
      <h3>系统通知</h3>
      <div class="links">
        <button class="btn" type="button" @click="notify">发送测试通知</button>
      </div>
    </section>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { aiApi } from '../../api';
import { toast } from '../../stores/toast';

const status = ref({});
const shell = ref('');
const approvalMode = ref('default');

onMounted(load);

async function load() {
  try {
    const s = (await aiApi.getStatus()) || {};
    status.value = s;
    // 兼容 list / counts 两种形态
    const list = s.list || s.models || [];
    const arr = Array.isArray(list) ? list : [];
    status.value = {
      ...s,
      _providers: s.providers ?? s.provider_count ?? new Set(arr.map((x) => x.provider_id || x.provider_name)).size,
      _models: s.models_count ?? s.model_count ?? arr.length,
      _usable: s.usable ?? s.ok_count ?? arr.filter((x) => x.status === 'ok').length,
      _shell: s.shell || s.shell_name || s.default_shell || '',
    };
    const sh = await aiApi.getShell();
    shell.value = sh?.current || sh?.shell || sh?.path || '';
    const am = await aiApi.getApprovalMode();
    approvalMode.value = am?.mode || 'default';
  } catch { /* ignore */ }
}

function labelOf(m) {
  return { default: '默认', strict: '严格', exempt: '免除' }[m] || m;
}

function hintOf(m) {
  return {
    default: '默认：部分修改操作需审批',
    strict: '严格：一切修改都需确认',
    exempt: '免除：过高权限外自动放行',
  }[m] || '';
}

async function setMode(mode) {
  await aiApi.setApprovalMode(mode);
  approvalMode.value = mode;
  toast('审批模式已切换', 'success');
}

async function notify() {
  await aiApi.systemNotify({ title: 'KHarness', body: '测试通知' });
  toast('已发送', 'success');
}
</script>

<style scoped>
.page { padding: 24px 28px 40px; max-width: 1000px; margin: 0 auto; }
.page-head { margin-bottom: 16px; }
.page-head h1 { margin: 0; font-size: 20px; }
.page-head p { margin: 4px 0 0; color: var(--text-3); font-size: 12px; }
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}
.stat {
  background: var(--bg-elev);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  padding: 14px;
}
.label { color: var(--text-3); font-size: 12px; }
.value { font-size: 28px; font-weight: 600; margin-top: 6px; }
.value.small { font-size: 13px; word-break: break-all; }
.card {
  background: var(--bg-elev);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  padding: 14px;
  margin-bottom: 16px;
}
.card h3 { margin: 0 0 12px; font-size: 14px; }
.links { display: flex; flex-wrap: wrap; gap: 8px; }
.muted { color: var(--text-3); font-size: 12px; margin: 10px 0 0; }
.btn {
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  border-radius: var(--radius-xs);
  padding: 6px 12px;
  font-size: 12px;
}
.btn.primary { background: var(--accent); border-color: transparent; color: var(--on-accent); font-weight: 600; }
</style>
