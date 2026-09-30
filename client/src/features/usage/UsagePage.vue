<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1><i class="fas fa-chart-column"></i> 用量统计</h1>
        <p>按日 token / 按模型费用估算</p>
      </div>
      <div class="page-actions">
        <button class="k-pill" type="button" :title="compact ? '切换完整数字' : '切换 K/M 缩写'" @click="compact = !compact">
          <i class="fas fa-arrow-down-9-1"></i> {{ compact ? 'K/M' : '完整' }}
        </button>
        <KDropdown :items="DAYS_ITEMS" v-model="days" width="120px" />
      </div>
    </header>

    <section class="card">
      <h3><i class="fas fa-sigma"></i> 汇总</h3>
      <div class="grid">
        <div class="stat"><div class="label">输入 token</div><div class="value">{{ fmt(summary.prompt) }}</div></div>
        <div class="stat"><div class="label">输出 token</div><div class="value">{{ fmt(summary.completion) }}</div></div>
        <div class="stat"><div class="label">缓存 token</div><div class="value">{{ fmt(summary.cached) }}</div></div>
        <div class="stat"><div class="label">费用(估算)</div><div class="value">¥ {{ summary.cost.toFixed(4) }}</div></div>
      </div>
    </section>

    <section class="card">
      <h3><i class="fas fa-chart-simple"></i> 按日</h3>
      <div class="chart" role="img" aria-label="按日 token 柱形图">
        <div v-for="d in daily" :key="d.day" class="bar-col" :title="barTitle(d)">
          <div class="bars">
            <div class="bar out" :style="{ height: barH(d, 'completion') }"></div>
            <div class="bar inp" :style="{ height: barH(d, 'prompt') }"></div>
          </div>
          <div class="bar-label">{{ shortDate(d.day) }}</div>
        </div>
        <div v-if="!daily.length" class="muted">暂无数据</div>
      </div>
      <div class="legend">
        <span><i class="swatch inp"></i> 输入</span>
        <span><i class="swatch out"></i> 输出</span>
      </div>
    </section>

    <section class="card">
      <h3><i class="fas fa-calendar-day"></i> 按日明细</h3>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>日期</th><th>输入</th><th>输出</th><th>缓存</th><th>费用</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in daily" :key="d.day">
              <td class="mono">{{ d.day }}</td>
              <td>{{ fmt(d.prompt) }}</td>
              <td>{{ fmt(d.completion) }}</td>
              <td>{{ fmt(d.cached) }}</td>
              <td>¥ {{ Number(d.cost || 0).toFixed(4) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="card">
      <h3><i class="fas fa-cube"></i> 按模型</h3>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>模型</th><th>输入</th><th>输出</th><th>缓存</th><th>费用</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in byModel" :key="m.model_row_id || m.name">
              <td>{{ m.name || m.model || m.model_id || '—' }}</td>
              <td>{{ fmt(m.prompt) }}</td>
              <td>{{ fmt(m.completion) }}</td>
              <td>{{ fmt(m.cached) }}</td>
              <td>¥ {{ Number(m.cost || 0).toFixed(4) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <KEmpty v-if="!byModel.length" title="暂无数据" />
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { aiApi } from '../../api';
import { formatTokens, formatCompact } from '../../utils/format';
import KEmpty from '../../ui/KEmpty.vue';
import KDropdown from '../../ui/KDropdown.vue';

const DAYS_ITEMS = [
  { value: 7, label: '近 7 天' },
  { value: 14, label: '近 14 天' },
  { value: 30, label: '近 30 天' },
];

const days = ref(7);
const compact = ref(true);
const data = ref({});

const daily = computed(() => data.value.daily || data.value.days || []);
const byModel = computed(() => data.value.models || data.value.by_model || []);

const summary = computed(() => {
  const s = data.value.total || data.value.summary || {};
  return {
    prompt: s.prompt ?? s.prompt_tokens ?? 0,
    completion: s.completion ?? s.completion_tokens ?? 0,
    cached: s.cached ?? s.cached_tokens ?? 0,
    cost: Number(s.cost ?? 0),
  };
});

const maxTok = computed(() => {
  let m = 1;
  for (const d of daily.value) {
    m = Math.max(m, Number(d.prompt ?? 0), Number(d.completion ?? 0));
  }
  return m;
});

onMounted(load);
watch(days, load);

async function load() {
  data.value = (await aiApi.getUsage(days.value)) || {};
}

function fmt(n) {
  return compact.value ? formatCompact(n || 0) : formatTokens(n || 0);
}

function val(d, key) {
  return Number(d[key] ?? 0);
}

function barH(d, key) {
  const pct = (val(d, key) / maxTok.value) * 100;
  return `${Math.max(pct > 0 ? 4 : 0, Math.min(100, pct))}%`;
}

function barTitle(d) {
  return `${d.day || d.date} · 入 ${formatTokens(val(d, 'prompt'))} · 出 ${formatTokens(val(d, 'completion'))}`;
}

function shortDate(s) {
  const t = String(s || '');
  return t.length > 5 ? t.slice(5) : t;
}
</script>

<style scoped>
.page { padding: 24px 28px 40px; max-width: 1100px; margin: 0 auto; }
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 16px;
}
.page-head h1 {
  margin: 0;
  font-size: 20px;
  display: flex;
  align-items: center;
  gap: 10px;
}
.page-head h1 i { color: var(--text-2); font-size: 16px; }
.page-head p { margin: 4px 0 0; color: var(--text-3); font-size: 12px; }
.page-actions { display: flex; gap: 8px; align-items: center; }
.card {
  background: var(--bg-elev);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  padding: 14px;
  margin-bottom: 16px;
}
.card h3 {
  margin: 0 0 12px;
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.card h3 i { color: var(--text-3); }
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
}
.stat {
  background: var(--bg-panel);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  padding: 12px;
}
.label { color: var(--text-3); font-size: 12px; }
.value { font-size: 22px; font-weight: 600; margin-top: 6px; }

.chart {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  height: 160px;
  padding: 8px 4px 0;
}
.bar-col {
  flex: 1;
  min-width: 28px;
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 100%;
}
.bars {
  flex: 1;
  width: 100%;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: 3px;
}
.bar {
  width: 10px;
  border-radius: 3px 3px 0 0;
  min-height: 0;
  transition: height 0.35s var(--ease);
}
.bar.inp { background: var(--bar-a); }
.bar.out { background: var(--bar-b); }
.bar-label {
  margin-top: 6px;
  font-size: 10px;
  color: var(--text-3);
  font-family: var(--mono);
}
.legend {
  display: flex;
  gap: 14px;
  margin-top: 10px;
  color: var(--text-3);
  font-size: 11px;
}
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  display: inline-block;
}
.swatch.inp { background: var(--bar-a); }
.swatch.out { background: var(--bar-b); }
.muted { color: var(--text-3); }
.table-wrap { overflow: auto; }
.table { width: 100%; border-collapse: collapse; }
.table th, .table td {
  padding: 8px;
  border-bottom: 1px solid var(--border-soft);
  text-align: left;
  font-size: 12px;
}
.mono { font-family: var(--mono); }
</style>
