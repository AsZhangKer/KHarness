<template>
  <!--
    100% 照搬母本 价格走势图表.html（终末地设计稿）
    的 .ef-price 结构与度量（929×313u，1u 由容器宽度反推），只做三件事：
      · 数据换成「按日 token 用量」；
      · 去掉拖动 / 双击改值（母本那是演示数据怎么动，实际这里只读）；
      · 去掉母本右下那颗「查看好友价格」按钮（与用量无关）。
    保留悬浮：每列标签带 title，鼠标停上去显示当天 入/出/合计。
  -->
  <div class="epc" ref="box">
    <div class="ef-price" :style="{ '--u': u + 'px' }" @mousemove="onMove" @mouseleave="hoverIdx = -1" @click="onClick">
      <h3 class="ef-price__title">{{ title }}</h3>

      <div class="ef-price__stats">
        <span>总计：</span>
        <i class="ef-price__tri" :class="{ 'is-down': !up }"></i>
        <span class="pv">{{ totalText }}<small>（{{ spanText }}）</small></span>
        <span class="g2">日均：</span>
        <span class="av">{{ avgText }}</span>
      </div>

      <div class="ef-price__panel"></div>

      <div class="ef-price__bands">
        <div
          v-for="(c, i) in cols"
          :key="'b' + i"
          class="ef-price__band"
          :class="{ 'is-hl': c.hl, 'is-hover': hoverIdx === i }"
          :style="c.band"
        ></div>
      </div>

      <!-- 整列热区：母本没有 hover 交互，但这里要「悬浮高亮 + 点击复制」。
           透明、盖在柱体上（z-index 1，低于数值标签的 2），鼠标进来就点亮这一列。 -->
      <!-- 悬停 / 点击整张图按 X 坐标就近取列：不再放一层层热区 ——
           母本的柱体、标签、刻度是三个绝对定位容器，热区很容易被标签盖住（实测点不动）。 -->

      <div class="ef-price__track"></div>
      <i class="ef-price__line"></i>
      <i class="ef-price__br ef-price__br--l"></i>
      <i class="ef-price__br ef-price__br--r"></i>

      <div class="ef-price__cost">
        <b>{{ costText }}</b>
        <span>{{ costLabel }}</span>
        <i></i>
      </div>

      <div class="ef-price__marks">
        <template v-for="(c, i) in cols" :key="'m' + i">
          <div v-if="c.stem" class="ef-price__stem" :style="c.stem"></div>
          <div class="ef-price__tick" :class="{ 'is-hl': c.hl }" :style="c.tick"></div>
        </template>
      </div>

      <div class="ef-price__labs">
        <div
          v-for="(c, i) in cols"
          :key="'l' + i"
          class="ef-price__lab"
          :class="{ 'is-hl': c.hl, 'is-hover': hoverIdx === i }"
          :style="c.lab"
          :title="c.tip"
        >{{ c.label }}</div>
        <i v-if="cols.length" class="ef-price__mk" :style="mkStyle"></i>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { formatCompact, formatTokens } from '../../utils/format';
import { toast } from '../../stores/toast';

const props = defineProps({
  /** [{ day, prompt, completion, total }]，按时间升序（最后一个是「最新」，会被高亮） */
  points: { type: Array, default: () => [] },
  title: { type: String, default: 'Token 用量走势' },
  costLabel: { type: String, default: '日均线' },
});

const box = ref(null);
const u = ref(1);
/** 鼠标悬停在哪一列（-1 = 没有）—— 整列热区点亮柱体 + 数值标签 */
const hoverIdx = ref(-1);
/** 1u = 容器宽 / 929，最宽按母本的 1px（1u）封顶，窄了就整体缩，绝不自己改布局数值 */
const U = (n) => `calc(var(--u) * ${n})`;

let ro = null;
onMounted(() => {
  ro = new ResizeObserver(() => {
    const w = box.value?.clientWidth || 929;
    u.value = Math.max(0.5, Math.min(1, w / 929));
  });
  if (box.value) ro.observe(box.value);
});
onBeforeUnmount(() => { if (ro) ro.disconnect(); });

const vals = computed(() => (props.points || []).map((p) => Number(p.total) || 0));
const sum = computed(() => vals.value.reduce((a, b) => a + b, 0));
const count = computed(() => vals.value.length);
/** 基线 = 日均（母本那条「成本价格线」的位置） */
const baseline = computed(() => (count.value ? sum.value / count.value : 0));
/**
 * 高亮列 = **最后一个有用量的日子**，不是「最后一列」。
 * 母本高亮的是「最新值」，而我们的时间轴补过零：今天还没用过时最后一列是 0，
 * 黑底黄字会显示成 `-0-`，还会把三角压成「跌」。整段都没量才退回最后一列。
 */
const hlIndex = computed(() => {
  const v = vals.value;
  for (let i = v.length - 1; i >= 0; i--) if (v[i] > 0) return i;
  return v.length ? v.length - 1 : 0;
});
const last = computed(() => (count.value ? vals.value[hlIndex.value] : 0));

const fmtShort = (n) => formatCompact(Number(n) || 0);
const fmtLong = (n) => formatTokens(Number(n) || 0);

const totalText = computed(() => fmtShort(sum.value));
const avgText = computed(() => fmtShort(Math.round(baseline.value)));
const costText = computed(() => fmtShort(Math.round(baseline.value)));
const spanText = computed(() => `${count.value} 天`);
const up = computed(() => last.value >= baseline.value);

/**
 * 逐列布局 —— 数值全部照抄母本 layout()：
 *   P     列距（最多 725u 摊给 N 列，12 列以上就会挤，所以调用方只喂最近 12 个点）
 *   k     值→像素的斜率：range = max(值, 基线+1) − 基线，封顶 0.2 u/token
 *   yc    列中心 y：基线在 196u，往上浮（最低 68u，非高亮列最高 40u）
 */
const cols = computed(() => {
  const N = count.value;
  if (!N) return [];
  const P = Math.min(92.8, 725 / N);
  const bandW = (72 * P) / 92.8;
  const labW = Math.min(71, P * 0.765);
  const fs = 17.5 * Math.min(1, labW / 62);
  const cost = baseline.value;
  const range = Math.max(Math.max(...vals.value, cost + 1) - cost, 1);
  const k = Math.min(128 / range, 0.2);

  return props.points.map((p, i) => {
    const hl = i === hlIndex.value;
    const x = 812 - (N - 1 - i) * P;
    const yc = Math.min(226, Math.max(hl ? 68 : 40, 196 - k * ((Number(p.total) || 0) - cost)));
    const h = hl ? 26 : 25;
    const w = hl ? labW + 1 : labW;
    const top = yc - h / 2;
    const above = top + h < 195.5;
    const below = top > 198.5;
    const tip = `${p.day || ''} · 入 ${fmtLong(p.prompt)} · 出 ${fmtLong(p.completion)} · 合计 ${fmtLong(p.total)}`;
    return {
      hl,
      label: fmtShort(p.total),
      tip,
      cx: x,   // 列心（u 坐标）：mousemove / click 用它做「就近取列」
      band: {
        left: U(x - bandW / 2),
        top: U(hl ? yc : 41),
        width: U(bandW),
        height: U(hl ? 232 - yc : 191),
      },
      tick: {
        left: U(hl ? x - 5 : x - 6),
        top: U(194),
        width: U(hl ? 10 : 12),
        height: U(4),
      },
      stem: above
        ? { left: U(x - 1.5), top: U(top + h), width: U(3), height: U(195 - (top + h)) }
        : below
          ? { left: U(x - 1.5), top: U(198), width: U(3), height: U(top - 198) }
          : null,
      lab: {
        left: U(x - w / 2),
        top: U(top),
        width: U(w),
        height: U(h),
        fontSize: U(fs),
      },
      mkLeft: x - 7,
      mkTop: top - 10,
    };
  });
});

const mkStyle = computed(() => {
  const c = cols.value[hlIndex.value];
  return c ? { left: U(c.mkLeft), top: U(c.mkTop) } : {};
});

/** 点某列复制当天的明细（入 / 出 / 合计都带完整数字，不是 K/M 缩写） */
async function copyPoint(p) {
  if (!p) return;
  const line = `${p.day || ''} · 入 ${fmtLong(p.prompt)} · 出 ${fmtLong(p.completion)} · 合计 ${fmtLong(p.total)}`;
  try {
    await navigator.clipboard.writeText(line);
    toast(`已复制：${line}`, 'success');
  } catch (e) {
    toast('复制失败（系统不允许写剪贴板）', 'warn');
  }
}

/** 鼠标 x → 最近一列的下标（超过 46u 视为落在空处，返回 -1） */
function nearestIndex(e) {
  const el = e.currentTarget;
  if (!el || !cols.value.length) return -1;
  const r = el.getBoundingClientRect();
  const x = (e.clientX - r.left) / (u.value || 1);
  let best = -1;
  let bestD = Infinity;
  cols.value.forEach((c, i) => {
    const d = Math.abs(x - c.cx);
    if (d < bestD) { bestD = d; best = i; }
  });
  return bestD <= 46 ? best : -1;
}
function onMove(e) {
  const i = nearestIndex(e);
  if (i !== hoverIdx.value) hoverIdx.value = i;
}
function onClick(e) {
  const i = nearestIndex(e);
  if (i >= 0) copyPoint(props.points[i]);
}
</script>

<style scoped>
/* 母本的局部变量（不改全局 token）：面板灰、描边灰、涨红跌绿、亮黄 */
.ef-price {
  --u: 1px;
  --ef-page: #eeecec;
  --ef-panel: #e9e7e8;
  --ef-band-top: #e9e7e8;
  --ef-band-mid: #dedcdd;
  --ef-band-low: #d6d3d4;
  --ef-label: #767578;
  --ef-ink: #2d2b2b;
  --ef-line: #9a9898;
  --ef-tick: #2a2829;
  --ef-yellow: #ffe61a;
  --ef-tick-y: #ffe546;
  --ef-up: #ff4031;
  --ef-down: #2fbf71;
  position: relative;
  width: calc(var(--u) * 929);
  height: calc(var(--u) * 313);
  margin: 0 auto;
  font-family: var(--font);
  color: var(--ef-ink);
  user-select: none;
  -webkit-user-select: none;
}
.ef-price > * { position: absolute; }

.ef-price__title {
  left: calc(var(--u) * 26);
  top: calc(var(--u) * 4);
  margin: 0;
  font: 500 calc(var(--u) * 29) / 1.2 var(--font);
  color: #bcbcbc;
  text-shadow: 0 calc(var(--u) * 1) 0 #fff;
  letter-spacing: 0.02em;
  white-space: nowrap;
}
.ef-price__stats {
  right: calc(var(--u) * 27);
  top: calc(var(--u) * 7);
  display: flex;
  align-items: center;
  /* 母本是 21u；去掉现金图标后整行缩到 18u，不再和左边的大标题抢（他：字体缩小一点） */
  font: 500 calc(var(--u) * 18) / calc(var(--u) * 22) var(--font);
  white-space: nowrap;
}
.ef-price__stats small { font-size: calc(var(--u) * 11); }
.ef-price__tri {
  width: calc(var(--u) * 12);
  height: calc(var(--u) * 11);
  margin: 0 calc(var(--u) * 6) 0 calc(var(--u) * 15);
  background: var(--ef-up);
  clip-path: polygon(50% 0, 100% 100%, 0 100%);
}
.ef-price__tri.is-down { background: var(--ef-down); clip-path: polygon(0 0, 100% 0, 50% 100%); }
.ef-price .g2 { margin-left: calc(var(--u) * 20); }
/* 现金图标已按他要求去掉（那个右下角的暗黄小块 #8d8a1c 就是他说的「黄色突破表格」），
   「日均：」和数值之间补回原来图标占的一段间距。 */
.ef-price .av { margin-left: calc(var(--u) * 10); }
/* 母本那颗「现金」小图标（灰块 + 右下角暗黄 #8d8a1c）已按他的要求拿掉：
   那个暗黄角就是他觉得「突破表格」的一块。样式一起删掉，别留死代码。 */
.ef-price__panel {
  left: calc(var(--u) * 14);
  top: calc(var(--u) * 41);
  width: calc(var(--u) * 886);
  height: calc(var(--u) * 188);
  border-radius: calc(var(--u) * 24);
  background: linear-gradient(var(--ef-panel), #e8e6e7 60%, #ecebeb);
}
.ef-price__bands,
.ef-price__marks,
.ef-price__labs { left: 0; top: 0; width: 0; height: 0; }
.ef-price__bands > *,
.ef-price__marks > *,
.ef-price__labs > * { position: absolute; }
/* 悬停/点击都在 .ef-price 根上按 x 坐标算（见 nearestIndex），这里只给标签提一层，
   让它不被柱体的斜纹压住。 */
.ef-price__labs { z-index: 2; }
.ef-price__band {
  background: linear-gradient(var(--ef-band-top), var(--ef-band-mid) 45%, var(--ef-band-low) 85%, #dcdadb);
}
/* 悬浮高亮：整列柱体提亮 + 一圈半透黄线（只在终末地这张图表里，是他点名要的） */
.ef-price__band.is-hover {
  filter: brightness(1.06);
  box-shadow: inset 0 0 0 calc(var(--u) * 2) rgba(255, 229, 0, 0.5);
}
.ef-price__lab.is-hover { box-shadow: 0 0 0 calc(var(--u) * 2) #ffe500; }
.ef-price__band.is-hl {
  background:
    repeating-linear-gradient(135deg, rgba(255, 255, 255, 0.1) 0 calc(var(--u) * 2), transparent calc(var(--u) * 2) calc(var(--u) * 5)),
    linear-gradient(#b7b7b7, #a2a2a2 18%, #9e9e9e 70%, #a9a9a9 90%, #d3d1d2);
}
.ef-price__track {
  left: calc(var(--u) * 165);
  top: calc(var(--u) * 169);
  width: calc(var(--u) * 733);
  height: calc(var(--u) * 53);
  border-radius: calc(var(--u) * 27);
  background: rgba(0, 0, 0, 0.035);
}
.ef-price__line {
  left: calc(var(--u) * 180);
  top: calc(var(--u) * 195);
  width: calc(var(--u) * 708);
  height: calc(var(--u) * 3);
  border-radius: calc(var(--u) * 1.5);
  background: var(--ef-line);
}
.ef-price__br {
  top: calc(var(--u) * 189);
  width: calc(var(--u) * 5);
  height: calc(var(--u) * 14);
  border: calc(var(--u) * 1.5) solid #9a9a9a;
}
.ef-price__br--l { left: calc(var(--u) * 175); border-right: 0; }
.ef-price__br--r { left: calc(var(--u) * 888); border-left: 0; }
.ef-price__cost { left: 0; top: 0; }
.ef-price__cost b {
  position: absolute;
  left: calc(var(--u) * 28);
  top: calc(var(--u) * 167);
  font: 500 calc(var(--u) * 28) / calc(var(--u) * 28) var(--font);
  color: #222;
  letter-spacing: 0.01em;
}
.ef-price__cost span {
  position: absolute;
  left: calc(var(--u) * 27);
  top: calc(var(--u) * 202);
  font: 500 calc(var(--u) * 20) / calc(var(--u) * 20) var(--font);
  color: #444;
  white-space: nowrap;
}
.ef-price__cost i {
  position: absolute;
  left: calc(var(--u) * 25);
  top: calc(var(--u) * 195);
  width: calc(var(--u) * 126);
  height: calc(var(--u) * 2);
  background: #d2cfd0;
}
.ef-price__stem { background: rgba(0, 0, 0, 0.11); width: calc(var(--u) * 3); }
.ef-price__tick {
  height: calc(var(--u) * 4);
  background: var(--ef-tick);
  border-radius: calc(var(--u) * 0.5);
}
.ef-price__tick.is-hl { background: var(--ef-tick-y); }
/* 数值标签：母本原本 cursor:ns-resize + touch-action:none（可拖动）。这里**只读**，
   拖动/双击改值的交互整段删掉；改成 pointer 是因为现在点一下会复制当天明细。 */
.ef-price__lab {
  height: calc(var(--u) * 25);
  border-radius: calc(var(--u) * 7);
  background: var(--ef-label);
  color: #fff;
  font: 500 calc(var(--u) * 17.5) / calc(var(--u) * 25) var(--font);
  text-align: center;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: visible;
  cursor: pointer;
  box-shadow: inset 0 calc(var(--u) * 1) 0 rgba(255, 255, 255, 0.2), 0 calc(var(--u) * 3) calc(var(--u) * 3) calc(var(--u) * -1) rgba(0, 0, 0, 0.22);
  outline: none;
}
.ef-price__lab::after {
  content: "";
  position: absolute;
  left: calc(var(--u) * 3);
  right: calc(var(--u) * 3);
  bottom: calc(var(--u) * -5);
  height: calc(var(--u) * 4);
  background: repeating-linear-gradient(135deg, rgba(0, 0, 0, 0.2) 0 calc(var(--u) * 1), transparent calc(var(--u) * 1) calc(var(--u) * 2.4));
  pointer-events: none;
}
.ef-price__lab.is-hl {
  height: calc(var(--u) * 26);
  background: #050505;
  color: var(--ef-yellow);
  font-weight: 700;
  box-shadow: none;
}
.ef-price__lab.is-hl::before { content: "- "; white-space: pre; }
.ef-price__lab.is-hl::after {
  content: " -";
  position: static;
  display: inline;
  background: none;
  height: auto;
  white-space: pre;
}
.ef-price__mk {
  width: calc(var(--u) * 14);
  height: calc(var(--u) * 7);
  background: #0a0a0a;
  clip-path: polygon(0 0, 100% 0, 50% 100%);
}
.epc { width: 100%; }
</style>
