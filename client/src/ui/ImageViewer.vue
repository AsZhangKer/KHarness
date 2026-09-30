<template>
  <Teleport to="body">
    <Transition name="iv-fade">
      <div v-if="vs.open" class="iv-mask" @click.self="close" @wheel.prevent="onWheel">
        <header class="iv-bar">
          <span class="iv-title ellip" :title="vs.title">{{ vs.title || '图片' }}</span>
          <span class="iv-zoom mono">{{ Math.round(scale * 100) }}%</span>
          <button class="icon-btn sm" type="button" title="缩小" @click="zoomBy(1 / 1.25)"><i class="fas fa-minus"></i></button>
          <button class="icon-btn sm" type="button" title="放大" @click="zoomBy(1.25)"><i class="fas fa-plus"></i></button>
          <button class="icon-btn sm" type="button" title="实际大小（100%）" @click="setZoom(1)">1:1</button>
          <button class="icon-btn sm" type="button" title="适应窗口" @click="fit()"><i class="fas fa-expand"></i></button>
          <button class="icon-btn sm" type="button" title="关闭（Esc）" @click="close"><i class="fas fa-xmark"></i></button>
        </header>
        <div
          ref="stageEl"
          class="iv-stage"
          :class="{ grabbing: dragging }"
          @pointerdown="onDown"
          @pointermove="onMove"
          @pointerup="onUp"
          @pointercancel="onUp"
        >
          <img
            v-if="vs.url"
            ref="imgEl"
            class="iv-img"
            :src="vs.url"
            :alt="vs.title || '图片'"
            :style="imgStyle"
            draggable="false"
            @load="fit()"
          />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
/**
 * 内置图片查看器：只做缩放 + 拖拽平移 + 关闭（按他定的口径，不做旋转/下载/多图）。
 *
 * 三处入口都往 stores/viewer 里丢一个 url：暂存区的附图、工具回执里的截图（含 AI 截的图）、
 * 远程文件栏里的图片。url 可以是 /api/... 也可以是 data:URL，组件不关心来源。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { imageViewer as iv } from '../stores/viewer';

const vs = iv.state;
const stageEl = ref(null);
const imgEl = ref(null);
const scale = ref(1);
const ox = ref(0);
const oy = ref(0);
const dragging = ref(false);
let startX = 0, startY = 0, baseX = 0, baseY = 0;

const imgStyle = computed(() => ({
  transform: `translate(${ox.value}px, ${oy.value}px) scale(${scale.value})`,
}));

function close() { iv.closeViewer(); }

function fit() {
  const el = stageEl.value, img = imgEl.value;
  if (!el || !img || !img.naturalWidth) return;
  const pad = 48;
  const w = Math.max(80, el.clientWidth - pad);
  const h = Math.max(80, el.clientHeight - pad);
  scale.value = Math.min(w / img.naturalWidth, h / img.naturalHeight, 8);
  ox.value = 0; oy.value = 0;
}

function setZoom(v) { scale.value = Math.min(20, Math.max(0.05, v)); }
function zoomBy(k) { setZoom(scale.value * k); }

/** 滚轮以光标为不动点缩放：不然放大后想看的细节会被甩出屏幕 */
function onWheel(e) {
  const el = stageEl.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const cx = e.clientX - r.left - r.width / 2;
  const cy = e.clientY - r.top - r.height / 2;
  const k = e.deltaY < 0 ? 1.18 : 1 / 1.18;
  const next = Math.min(20, Math.max(0.05, scale.value * k));
  const real = next / scale.value;
  ox.value = cx - (cx - ox.value) * real;
  oy.value = cy - (cy - oy.value) * real;
  scale.value = next;
}

function onDown(e) {
  if (e.button !== 0) return;
  dragging.value = true;
  startX = e.clientX; startY = e.clientY;
  baseX = ox.value; baseY = oy.value;
  e.currentTarget.setPointerCapture?.(e.pointerId);
}
function onMove(e) {
  if (!dragging.value) return;
  ox.value = baseX + (e.clientX - startX);
  oy.value = baseY + (e.clientY - startY);
}
function onUp() { dragging.value = false; }

function onKey(e) {
  if (!vs.open) return;
  if (e.key === 'Escape') { e.stopPropagation(); close(); }
  else if (e.key === '+' || e.key === '=') zoomBy(1.25);
  else if (e.key === '-') zoomBy(1 / 1.25);
  else if (e.key === '0') setZoom(1);
}

onMounted(() => window.addEventListener('keydown', onKey, true));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true));
</script>

<style scoped>
.iv-mask {
  position: fixed; inset: 0; z-index: 4000;
  background: rgba(8, 10, 14, 0.82);
  display: flex; flex-direction: column;
}
.iv-bar {
  flex: 0 0 auto; height: 40px; display: flex; align-items: center; gap: 8px;
  padding: 0 12px; color: #e8eaf0;
  background: rgba(20, 23, 30, 0.9); border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.iv-title { flex: 1 1 auto; min-width: 0; font-size: 12px; opacity: 0.85; }
.iv-zoom { font-size: 11px; min-width: 44px; text-align: right; opacity: 0.75; }
.iv-bar .icon-btn { color: #dfe3ec; border: 1px solid rgba(255, 255, 255, 0.14); background: rgba(255, 255, 255, 0.06); }
.iv-bar .icon-btn:hover { background: rgba(255, 255, 255, 0.14); }
.iv-stage {
  flex: 1 1 auto; position: relative; overflow: hidden;
  display: flex; align-items: center; justify-content: center;
  cursor: grab; touch-action: none;
}
.iv-stage.grabbing { cursor: grabbing; }
.iv-img {
  max-width: none; max-height: none;
  transform-origin: center center;
  user-select: none;
  box-shadow: 0 8px 40px rgba(0, 0, 0, 0.5);
  background:
    linear-gradient(45deg, #2a2f3a 25%, transparent 25%),
    linear-gradient(-45deg, #2a2f3a 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #2a2f3a 75%),
    linear-gradient(-45deg, transparent 75%, #2a2f3a 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
}
.ellip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mono { font-family: var(--mono); }
.iv-fade-enter-active, .iv-fade-leave-active { transition: opacity 0.16s ease; }
.iv-fade-enter-from, .iv-fade-leave-to { opacity: 0; }
</style>
