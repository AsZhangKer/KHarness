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
          v-for="m in modeChoices"
          :key="m"
          class="btn"
          :class="{ primary: approvalMode === m, 'cp-fs': m === 'fullsend' }"
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
import { computed, onMounted, ref } from 'vue';
import { aiApi } from '../../api';
import { toast } from '../../stores/toast';
import { confirmDialog } from '../../stores/confirm';
import { uiPrefs } from '../../stores/prefs';

const status = ref({});
const shell = ref('');
const approvalMode = ref('default');

// FULL-SEND 只有实验室总闸开着才摆出来（和会话那条下拉同一个判据，别在这儿另立一套）
const modeChoices = computed(() =>
  (uiPrefs.state.fullSend ? ['default', 'strict', 'exempt', 'fullsend'] : ['default', 'strict', 'exempt'])
);

onMounted(async () => {
  await uiPrefs.load();
  load();
});

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
    // 库里存的是原值；实验室总闸关着时这一档根本不生效，界面不能还写着 FULL-SEND
    const raw = am?.mode || 'default';
    approvalMode.value = raw === 'fullsend' && !uiPrefs.state.fullSend ? 'default' : raw;
  } catch { /* ignore */ }
}

function labelOf(m) {
  return { default: '默认', strict: '严格', exempt: '免除', fullsend: 'FULL-SEND' }[m] || m;
}

function hintOf(m) {
  return {
    default: '默认：部分修改操作需审批',
    strict: '严格：一切修改都需确认',
    exempt: '免除：过高权限外自动放行',
    fullsend: 'FULL-SEND：任何操作一律自动放行（含全屏截取），黑名单与系统关键位置、项目根边界全部越过；只保留 KHarness 自己数据目录的隐身墙',
  }[m] || '';
}

async function setMode(mode) {
  if (mode === 'fullsend') {
    const okGo = await confirmDialog(
      '把「全局默认审批」设成 FULL-SEND：此后**每条没单独设过审批模式的会话**都直接执行一切操作，'
      + '跳过黑名单、高权限底线（含全屏截取）、Computer Use 放行与项目根边界。'
      + '只有 KHarness 自己的数据目录仍然挡着。\n\n确定要把全局默认设成这一档吗？',
      { title: '全局默认 → FULL-SEND', danger: true, okText: '设为全局默认' }
    );
    if (!okGo) return;
  }
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
/* FULL-SEND 那颗按钮常态就标红，选中时更狠一档 —— 这一档什么都不问，不能长得像普通档 */
.btn.cp-fs { color: var(--danger, #e5484d); border-color: var(--danger, #e5484d); }
.btn.cp-fs.primary { background: var(--danger, #e5484d); color: #fff; border-color: transparent; }
</style>
