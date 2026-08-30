<template>
  <div class="page">
    <div class="page-header" v-reveal>
      <h2><i class="fas fa-chart-column"></i> 用量统计</h2>
      <div class="range-picker">
        <button v-for="d in [7, 30, 90]" :key="d" class="btn btn-small" :class="days === d ? 'btn-primary' : 'btn-secondary'" @click="days = d">{{ d }} 天</button>
      </div>
    </div>

    <div class="stat-cards" v-reveal>
      <div class="stat-card">
        <div class="stat-label"><i class="fas fa-coins"></i> 预估总费用</div>
        <div class="stat-value">${{ total.cost.toFixed(4) }}</div>
        <div class="stat-sub" v-if="!hasPrices">未配置模型单价，费用为 0；在「管理模型」中填写 $/1M 单价</div>
      </div>
      <div class="stat-card">
        <div class="stat-label"><i class="fas fa-arrow-up"></i> 输入 tokens</div>
        <div class="stat-value">{{ fmt(total.prompt) }}</div>
        <div class="stat-sub">其中缓存命中 {{ fmt(total.cached) }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label"><i class="fas fa-arrow-down"></i> 输出 tokens</div>
        <div class="stat-value">{{ fmt(total.completion) }}</div>
      </div>
    </div>

    <div class="chart-card" v-reveal>
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.6rem;margin-bottom:.9rem">
        <h3 style="margin:0"><i class="fas fa-chart-simple"></i> 每日用量</h3>
        <div style="display:flex;align-items:center;gap:.6rem;flex-wrap:wrap">
          <span v-if="daily.length" class="avg-label">日均输入 {{ fmt(avgPrompt) }} · 日均输出 {{ fmt(avgCompletion) }} · 日均费用 ${{ avgCost.toFixed(4) }}</span>
          <button class="btn btn-small" @click="fmtMode = fmtMode === 'auto' ? 'full' : 'auto'" :title="fmtMode === 'auto' ? '切换为完整数字' : '切换为 K/M 缩写'"><i class="fas fa-exchange-alt"></i> {{ fmtMode === 'auto' ? 'K/M' : '完整' }}</button>
        </div>
      </div>
      <div v-if="!daily.length" class="chart-empty">暂无数据（发起对话后此处显示每日柱状图）</div>
      <div v-else>
        <div class="chart-tooltip-wrap">
          <div v-if="hoverDay" class="chart-tooltip">
            <b>{{ hoverDay.day }}</b> &nbsp; 输入 {{ fmt(hoverDay.prompt) }} · 输出 {{ fmt(hoverDay.completion) }} · 缓存 {{ fmt(hoverDay.cached) }}
            &nbsp;·&nbsp; ${{ hoverDay.cost.toFixed(4) }}
            <span v-if="hoverDay.prompt || hoverDay.completion" class="tooltip-compare">（{{ compareText(hoverDay) }}）</span>
          </div>
        </div>
        <div class="bar-chart">
          <div v-for="d in daily" :key="d.day" class="bar-col" :class="{ active: hoverDay && hoverDay.day === d.day }" @mouseenter="hoverDay = d" @mouseleave="hoverDay = null">
            <div class="bar-stack">
              <div class="bar bar-in" :style="{ height: pct(d.prompt, maxPrompt) }"></div>
              <div class="bar bar-out" :style="{ height: pct(d.completion, maxCompletion) }"></div>
            </div>
            <div class="bar-day">{{ d.day.slice(5) }}</div>
          </div>
        </div>
      </div>
      <div class="chart-legend">
        <span><i class="leg leg-in"></i> 输入</span>
        <span><i class="leg leg-out"></i> 输出</span>
        <span class="avg-hint">悬停柱状查看详情与对比</span>
      </div>
    </div>

    <div class="chart-card" v-reveal>
      <h3><i class="fas fa-robot"></i> 按模型统计（费用排序）</h3>
      <div v-if="!models.length" class="chart-empty">暂无数据</div>
      <table v-else class="usage-tbl">
        <thead>
          <tr><th>模型</th><th>调用次数</th><th>输入</th><th>输出</th><th>缓存</th><th>费用</th></tr>
        </thead>
        <tbody>
          <tr v-for="m in models" :key="m.model_row_id">
            <td>{{ m.name }}</td>
            <td>{{ m.calls }}</td>
            <td>{{ fmt(m.prompt) }}</td>
            <td>{{ fmt(m.completion) }}</td>
            <td>{{ fmt(m.cached) }}</td>
            <td>${{ m.cost.toFixed(4) }}</td>
          </tr>
        </tbody>
      </table>
      <p class="calc-note">计费公式：(输入−缓存)/1M×输入价 + 缓存/1M×缓存价 + 输出/1M×输出价，缓存命中不重复计费。</p>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { aiApi } from '../api';

const days = ref(30);
const daily = ref([]);
const models = ref([]);
const total = ref({ prompt: 0, completion: 0, cached: 0, cost: 0 });
const hasPrices = ref(true);
const hoverDay = ref(null);
const fmtMode = ref(localStorage.getItem('usage_fmt') || 'auto');
const fmt = (n) => {
  n = Number(n) || 0;
  if (fmtMode.value === 'full') return n.toLocaleString();
  if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 1 : 2).replace(/\.0+$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'K';
  return String(n);
};

const maxPrompt = computed(() => Math.max(1, ...daily.value.map(d => d.prompt)));
const maxCompletion = computed(() => Math.max(1, ...daily.value.map(d => d.completion)));
const avgPrompt = computed(() => daily.value.length ? Math.round(daily.value.reduce((s, d) => s + d.prompt, 0) / daily.value.length) : 0);
const avgCompletion = computed(() => daily.value.length ? Math.round(daily.value.reduce((s, d) => s + d.completion, 0) / daily.value.length) : 0);
const avgCost = computed(() => daily.value.length ? daily.value.reduce((s, d) => s + d.cost, 0) / daily.value.length : 0);
const pct = (v, max) => Math.max(v > 0 ? 4 : 0, Math.round(v / max * 100)) + '%';
const compareText = (d) => {
  const ap = avgPrompt.value, ac = avgCompletion.value;
  const dp = ap ? Math.round((d.prompt - ap) / ap * 100) : 0;
  const dc = ac ? Math.round((d.completion - ac) / ac * 100) : 0;
  const fmtDiff = (v) => (v > 0 ? `+${v}%` : `${v}%`);
  return `较日均 ${fmtDiff(dp)} / ${fmtDiff(dc)}`;
};

async function load() {
  try {
    const res = await aiApi.getUsage(days.value);
    daily.value = res.data.daily || [];
    models.value = res.data.models || [];
    total.value = res.data.total || total.value;
    hasPrices.value = !!res.data.has_prices;
  } catch (e) { /* 静默 */ }
}

watch(days, load);
watch(fmtMode, v => localStorage.setItem('usage_fmt', v));
onMounted(load);
</script>

<style scoped>
.page{width:100%;margin:0 auto}
.page-header{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.8rem;margin-bottom:1.2rem}
.page-header h2{margin:0;color:var(--text-dark);font-size:1.3rem}
.page-header h2 i{color:var(--primary-gold);margin-right:.4rem}
.range-picker{display:flex;gap:.4rem}

.stat-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1rem;margin-bottom:1.2rem}
.stat-card{background:var(--bg-card);border:1px solid var(--border-light);border-radius:14px;padding:1rem 1.2rem}
.stat-label{color:var(--text-muted);font-size:.82rem}
.stat-label i{color:var(--primary-gold);margin-right:.35rem}
.stat-value{font-size:1.6rem;font-weight:700;color:var(--text-dark);margin-top:.25rem;font-variant-numeric:tabular-nums}
.stat-sub{color:var(--text-muted);font-size:.74rem;margin-top:.2rem}

.chart-card{background:var(--bg-card);border:1px solid var(--border-light);border-radius:14px;padding:1rem 1.2rem;margin-bottom:1.2rem}
.chart-card h3{margin:0 0 .9rem;font-size:1rem;color:var(--text-dark)}
.chart-card h3 i{color:var(--primary-gold);margin-right:.4rem}
.chart-empty{color:var(--text-muted);text-align:center;padding:2rem 0;font-size:.9rem}
.bar-chart{display:flex;align-items:flex-end;gap:6px;height:180px;overflow-x:auto;padding-bottom:.3rem}
.bar-col{display:flex;flex-direction:column;align-items:center;gap:.3rem;min-width:34px;flex:1;cursor:default;border-radius:6px;padding:.2rem 0;transition:background .15s}
.bar-col.active{background:var(--accent-pink);}
.bar-stack{display:flex;align-items:flex-end;gap:3px;height:150px}
.bar{width:12px;border-radius:4px 4px 0 0;transition:height .4s}
.bar-in{background:var(--primary-blue)}
.bar-out{background:var(--primary-gold)}
.bar-day{color:var(--text-muted);font-size:.68rem;white-space:nowrap}
.chart-legend{display:flex;gap:1.2rem;color:var(--text-muted);font-size:.76rem;margin-top:.5rem;align-items:center;flex-wrap:wrap}
.avg-label{color:var(--text-muted);font-size:.78rem}
.avg-hint{margin-left:auto;color:var(--text-muted);font-size:.72rem}
.chart-tooltip{background:var(--bg-card-solid);border:1px solid var(--border-light);border-radius:8px;padding:.5rem .7rem;font-size:.8rem;color:var(--text-dark);box-shadow:var(--shadow-soft)}
.chart-tooltip-wrap{height:36px;margin-bottom:.4rem}
.chart-tooltip b{color:var(--primary-blue)}
.tooltip-compare{color:var(--text-muted);font-size:.75rem}
.leg{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:.3rem}
.leg-in{background:var(--primary-blue)}
.leg-out{background:var(--primary-gold)}

.usage-tbl{width:100%;border-collapse:collapse;font-size:.85rem}
.usage-tbl th{color:var(--text-muted);text-align:left;font-weight:500;padding:.4rem .5rem;border-bottom:1px solid var(--border-light)}
.usage-tbl td{padding:.45rem .5rem;border-bottom:1px dashed var(--border-light);color:var(--text-dark);font-variant-numeric:tabular-nums}
.calc-note{color:var(--text-muted);font-size:.74rem;margin:.7rem 0 0}
</style>
