<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1><i class="fas fa-chart-column"></i> 用量统计</h1>
        <p>估算不保证准确</p>
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
      <h3>
        <i class="fas fa-chart-simple"></i> 按日
        <span v-if="daily.length && !isEndfield" class="head-note">峰值 {{ fmt(niceMax) }} / 天</span>
      </h3>
      <!-- 终末地：直接搬母本 FORM/价格走势图表.html 的 .ef-price（只读，不拖动），
           数据换成「按日 token 总量」，基线 = 日均。其余六套主题仍走下面这套柱形图。 -->
      <EndfieldPriceChart v-if="isEndfield && daily.length" :points="chartPoints" />
      <template v-else>
      <!-- 读数条：把「悬停那一天的具体数字」摆在图上方。
           以前只有每个柱子上的 title（要悬停等一秒才出来），图上既没有刻度也没有数字 ——
           他说的「根本看不出来具体数据」就是这条。 -->
      <div class="chart-tip" :class="{ on: !!hoverDay }">
        <template v-if="hoverDay">
          <b class="mono">{{ hoverDay.day }}</b>
          <span><i class="swatch inp"></i>入 {{ fmt(val(hoverDay, 'prompt')) }}</span>
          <span><i class="swatch out"></i>出 {{ fmt(val(hoverDay, 'completion')) }}</span>
          <span class="tot">合计 {{ fmt(dayTotal(hoverDay)) }}</span>
          <span v-if="hoverDay.cost">¥ {{ Number(hoverDay.cost).toFixed(4) }}</span>
        </template>
        <template v-else>
          <span>鼠标移到某一天看具体数字</span>
          <span class="dim">刻度按上面的峰值等比缩放</span>
        </template>
      </div>
      <div class="chart-wrap">
        <!-- y 轴刻度：0 / 中 / 峰（峰取整到 1·2·5×10ⁿ，所以刻度值本身是好读的数） -->
        <div class="y-axis" aria-hidden="true">
          <span v-for="t in yTicks" :key="'y' + t" :style="{ bottom: gridPct(t) }">{{ fmt(t) }}</span>
        </div>
        <div class="chart" role="img" :aria-label="`按日 token 柱形图，峰值 ${formatTokens(niceMax)}，共 ${daily.length} 天`">
          <div class="plot">
            <div v-for="t in yGrid" :key="'g' + t" class="grid-line" :style="{ bottom: gridPct(t) }"></div>
            <div class="cols">
              <div
                v-for="d in daily"
                :key="d.day"
                class="bar-col"
                :class="{ 'is-hover': hoverDay && hoverDay.day === d.day }"
                :title="barTitle(d)"
                @mouseenter="hoverDay = d"
                @mouseleave="hoverDay = null"
              >
                <div class="bars">
                  <div class="bar inp" :style="{ height: barH(d, 'prompt') }"></div>
                  <div class="bar out" :style="{ height: barH(d, 'completion') }"></div>
                </div>
              </div>
            </div>
          </div>
          <div class="x-axis">
            <div v-for="d in daily" :key="'x' + d.day" class="bar-label">{{ shortDate(d.day) }}</div>
          </div>
        </div>
      </div>
      <div class="legend">
        <span><i class="swatch inp"></i> 输入</span>
        <span><i class="swatch out"></i> 输出</span>
        <span class="dim">点数字看整表：下面「按日明细」是精确值</span>
      </div>
      </template>
      <div v-if="!daily.length" class="muted">暂无数据</div>
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
import { themeState } from '../../stores/theme';
import KEmpty from '../../ui/KEmpty.vue';
import KDropdown from '../../ui/KDropdown.vue';
import EndfieldPriceChart from './EndfieldPriceChart.vue';

const DAYS_ITEMS = [
  { value: 7, label: '近 7 天' },
  { value: 14, label: '近 14 天' },
  { value: 30, label: '近 30 天' },
];

const days = ref(7);
const compact = ref(true);
const data = ref({});
// 悬停中的那一天（读数条与高亮共用）—— 比只靠 title 提示语直观得多
const hoverDay = ref(null);

const daily = computed(() => data.value.daily || data.value.days || []);
const byModel = computed(() => data.value.models || data.value.by_model || []);

const isEndfield = computed(() => themeState.id === 'endfield');

/**
 * 喂给母本那张图的点：按日 token 总量，最多 12 列（母本 layout 的 12 列上限，
 * 再多标签就会互相压）。daily 是「最旧 → 最新」，母本也是这个方向，最后一个是高亮列。
 *
 * 必须**补零**：后端 GROUP BY 只返回有量的日期，近 7 天只有一天用过就只剩一列，
 * 母本那种「七列围绕日均线起伏」的节奏完全出不来。以最后一条数据的日期为锚点往回推，
 * 不拿 new Date() 当锚点 —— SQLite 的 DATE() 是 UTC，本地可能差一天。
 */
const chartPoints = computed(() => {
  const list = daily.value;
  if (!list.length) return [];
  const n = Math.min(12, Math.max(1, Number(days.value) || 7));
  const keyOf = (d) => String(d.day || '').slice(0, 10);
  const byDay = new Map(list.map((d) => [keyOf(d), d]));
  // 锚点默认取**今天**（最后一列 = 今天，高亮）。数据日期比今天晚才用数据日期
  // （SQLite 的 DATE() 可能是 UTC，本地时区靠东时会出现「明天」的那条）。
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const lastData = new Date(`${keyOf(list[list.length - 1])}T00:00:00`);
  const anchor = lastData > today ? lastData : today;
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const dt = new Date(anchor);
    dt.setDate(dt.getDate() - i);
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    const d = byDay.get(key) || { day: key, prompt: 0, completion: 0, cached: 0, cost: 0 };
    const prompt = val(d, 'prompt');
    const completion = val(d, 'completion');
    out.push({ day: key, prompt, completion, total: prompt + completion });
  }
  return out;
});

const summary = computed(() => {
  const s = data.value.total || data.value.summary || {};
  return {
    prompt: s.prompt ?? s.prompt_tokens ?? 0,
    completion: s.completion ?? s.completion_tokens ?? 0,
    cached: s.cached ?? s.cached_tokens ?? 0,
    cost: Number(s.cost ?? 0),
  };
});

/**
 * 柱子的上限取「好看的整数」（1·2·5×10ⁿ），刻度值才是人读得懂的 0 / 500 / 1K / 2K…
 * 直接用真实最大值当上限的话，刻度会变成 13947 这种没法一眼换算的数。
 */
function niceCeil(v) {
  const n = Number(v) || 0;
  if (n <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(n)));
  const r = n / p;
  const step = r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10;
  return step * p;
}

const niceMax = computed(() => {
  let m = 0;
  for (const d of daily.value) {
    m = Math.max(m, Number(d.prompt ?? 0), Number(d.completion ?? 0));
  }
  return niceCeil(m);   // 全为 0 时是 1，柱子自然全贴地
});

/** y 轴标签：0 / 半 / 峰 */
const yTicks = computed(() => [0, Math.round(niceMax.value / 2), niceMax.value]);
/** 网格线：0 那条就是底边，不重复画 */
const yGrid = computed(() => [Math.round(niceMax.value / 2), niceMax.value].filter((t) => t > 0));

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

function dayTotal(d) {
  return val(d, 'prompt') + val(d, 'completion');
}

function gridPct(t) {
  return `${(Number(t) / niceMax.value) * 100}%`;
}

function barH(d, key) {
  const pct = (val(d, key) / niceMax.value) * 100;
  // 有量但极小的（比如只有几十 token）也给 2% 高，否则柱子在图上等于不存在
  return `${Math.max(pct > 0 ? 2 : 0, Math.min(100, pct))}%`;
}

function barTitle(d) {
  return `${d.day || d.date} · 入 ${formatTokens(val(d, 'prompt'))} · 出 ${formatTokens(val(d, 'completion'))} · 合计 ${formatTokens(dayTotal(d))}`;
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

.head-note { margin-left: 8px; font-size: 11px; font-weight: 400; color: var(--text-3); font-family: var(--mono); }
/* 读数条：固定一行高度，不悬停时也留一句提示（否则那块地方看着像空的） */
.chart-tip {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  min-height: 26px;
  margin-bottom: 8px;
  padding: 4px 8px;
  border-radius: var(--radius-xs);
  font-size: 12px;
  color: var(--text-2);
  transition: background var(--dur) var(--ease);
}
.chart-tip.on { background: var(--surface-hover); }
.chart-tip .mono { font-family: var(--mono); }
.chart-tip .tot { font-weight: 600; }
.chart-tip .dim { color: var(--text-3); }
.chart-tip .swatch { margin-right: 4px; }

.chart-wrap { display: flex; gap: 8px; align-items: flex-start; }
/* y 轴刻度：与 plot 同高，刻度绝对定位，好跟网格线严丝合缝对上 */
.y-axis { position: relative; flex: none; width: 56px; height: 160px; }
.y-axis span {
  position: absolute;
  right: 0;
  transform: translateY(50%);
  font-size: 10px;
  color: var(--text-3);
  font-family: var(--mono);
  white-space: nowrap;
}
.chart { flex: 1; min-width: 0; }
.plot { position: relative; height: 160px; }
.grid-line {
  position: absolute;
  left: 0;
  right: 0;
  border-top: 1px dashed var(--border);
  opacity: .45;
  pointer-events: none;
}
/* 柱子层：把高度百分比换算到 160px 上，与网格线同一坐标系 */
.cols { position: absolute; inset: 0; display: flex; align-items: flex-end; gap: 10px; padding: 0 4px; }
.bar-col {
  flex: 1;
  min-width: 20px;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  border-radius: var(--radius-xs);
  transition: background var(--dur) var(--ease);
}
.bar-col.is-hover { background: var(--surface-hover); }
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
/* x 轴单独一行，但 flex/gap/padding 与 .cols 完全一致，这样标签正对各自的柱子 */
.x-axis { display: flex; gap: 10px; padding: 0 4px; }
.x-axis .bar-label { flex: 1; min-width: 20px; text-align: center; }
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
