<template>
  <div class="jump-rail" aria-label="消息快速定位">
    <div class="ticks" @mouseleave="hover = -1">
      <button
        v-for="(t, i) in shownTurns"
        :key="t.id"
        class="tick"
        type="button"
        :class="{ peak: i === hover }"
        :style="{ '--w': wave(i), '--d': dist(i) }"
        :title="t.preview"
        @click="$emit('goto', t.id)"
        @mouseenter="hover = i"
      >
        <span class="dot"></span>
      </button>
    </div>
    <div v-if="hover >= 0 && shownTurns[hover]" class="peek">
      <div class="peek-q">{{ shownTurns[hover].q }}</div>
      <div class="peek-a">{{ shownTurns[hover].a }}</div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';

const props = defineProps({
  messages: { type: Array, default: () => [] },
});
defineEmits(['goto']);

const hover = ref(-1);
const MAX_TICKS = 32;
// 鼠标上下各约 3 条跟着抬起来，越远抬得越少 —— 移到哪，波峰就跟到哪
const WAVE_SPAN = 3;

/** 0~1 的抬升量：指数衰减，比线性更像一道滚过去的浪 */
function wave(i) {
  if (hover.value < 0) return 0;
  const d = Math.abs(i - hover.value);
  if (d > WAVE_SPAN) return 0;
  return Number((1 - d / (WAVE_SPAN + 1)) ** 1.6);
}

/** 离波峰几格：CSS 用它算 transition-delay，让远处的条晚一点跟上 */
function dist(i) {
  return hover.value < 0 ? 0 : Math.abs(i - hover.value);
}

const turns = computed(() => {
  const list = props.messages || [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (m.role !== 'user') continue;
    const ai = list[i + 1] && list[i + 1].role === 'assistant' ? list[i + 1] : null;
    const q = clip(m.content, 48);
    const a = clip(ai?.content || '…', 64);
    out.push({
      id: m.id != null ? m.id : i,
      q,
      a,
      preview: `${q}\n${a}`,
    });
  }
  return out;
});

/** 过多时优先展示最近的 */
const shownTurns = computed(() =>
  turns.value.length > MAX_TICKS ? turns.value.slice(-MAX_TICKS) : turns.value
);

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}
</script>

<style scoped>
.jump-rail {
  position: relative;
  /* 20px 宽刚好容得下波峰那一条（18px），不用 overflow 探到消息区上 */
  width: 20px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.ticks {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0;
}
.tick {
  display: block;
  padding: 5px 0;
  line-height: 0;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}
/* 横向胶囊，上下更窄。--w 是这一条的抬升量（0~1），--d 是离波峰几格 */
.dot {
  display: block;
  flex-shrink: 0; /* 不写这条，窄栏里 flex 会把胶囊压扁，动画就看不见了 */
  width: calc(12px + var(--w, 0) * 6px);
  height: 3px;
  border-radius: 999px;
  background: var(--text-3);
  opacity: calc(0.5 + var(--w, 0) * 0.5);
  /* 厚度靠 scaleY：胶囊两端是圆的，直接加高度会显得笨 */
  transform: scaleY(calc(1 + var(--w, 0) * 1.6));
  /* 越远的条延后一点起步，看着就像浪从指尖往外推 */
  transition:
    width 0.26s cubic-bezier(0.34, 1.56, 0.64, 1) calc(var(--d, 0) * 18ms),
    transform 0.26s cubic-bezier(0.34, 1.56, 0.64, 1) calc(var(--d, 0) * 18ms),
    opacity 0.2s linear calc(var(--d, 0) * 10ms),
    background 0.2s linear;
}
.tick:hover .dot {
  background: var(--text);
}
/* 波峰单独上色，写在 :hover 之后才盖得住（两者特异性相同） */
.tick.peak .dot {
  background: var(--accent);
}
.peek {
  position: absolute;
  left: 22px;
  top: 50%;
  transform: translateY(-50%);
  width: 260px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow);
  padding: 10px 12px;
  z-index: 30;
  pointer-events: none;
}
.peek-q {
  font-size: 12px;
  color: var(--text);
  margin-bottom: 6px;
}
.peek-a {
  font-size: 11px;
  color: var(--text-3);
  white-space: pre-wrap;
}
/* 系统里关了动画的人：波浪只留宽度和颜色，不做缩放、也不逐级延迟 */
@media (prefers-reduced-motion: reduce) {
  .dot {
    width: calc(12px + var(--w, 0) * 4px);
    transform: none;
    transition: width 0.12s linear, background 0.12s linear;
  }
}
</style>
