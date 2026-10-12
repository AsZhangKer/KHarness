<template>
  <Teleport to="body">
    <section
      v-if="s.open"
      class="logfloat"
      :style="{ left: pos.x + 'px', top: pos.y + 'px', width: pos.w + 'px', height: pos.h + 'px' }"
    >
      <header class="lf-head" @mousedown.prevent="startDrag">
        <span class="lf-title">后台日志</span>
        <span class="lf-ver mono">{{ s.version || '—' }}</span>
        <span class="lf-dot" :class="{ on: s.connected }" :title="s.connected ? '实时连接中' : '未连接（正式版没有这条通道，或后端没起来）'"></span>
        <span class="lf-count mono">{{ visible.length }} / {{ s.lines.length }}</span>
        <span class="grow"></span>
        <button type="button" class="lf-btn" :title="s.paused ? '继续跟随最新一行' : '暂停跟随（往上翻不会被顶走）'" @click.stop="s.paused = !s.paused">
          {{ s.paused ? '已暂停' : '跟随' }}
        </button>
        <button type="button" class="lf-btn" :class="{ act: s.showHb }" title="显示轮询 / SSE 这类心跳行" @click.stop="s.showHb = !s.showHb">心跳</button>
        <button type="button" class="lf-btn" title="复制当前筛出来的这些行" @click.stop="copy">复制</button>
        <button type="button" class="lf-btn" title="清空（服务端那份也清）" @click.stop="store.clear()">清空</button>
        <button type="button" class="lf-btn" title="关闭这条实时通道" @click.stop="store.close()">✕</button>
      </header>

      <div class="lf-filters">
        <button
          v-for="f in FILTERS"
          :key="f.key"
          type="button"
          class="lf-chip"
          :class="{ on: s.filter === f.key }"
          @click="s.filter = f.key"
        >{{ f.label }}<span class="mono n">{{ counts[f.key] ?? 0 }}</span></button>
      </div>

      <div ref="bodyEl" class="lf-body" @scroll="onScroll">
        <div v-for="l in visible" :key="l.id" class="lf-line" :class="'lv-' + l.level">
          <span class="mono t">{{ l.at.slice(11) }}</span>
          <span class="mono g">{{ l.tag }}</span>
          <span v-if="l.ms" class="mono ms">{{ l.ms }}ms</span>
          <span class="tx">{{ l.text }}</span>
        </div>
        <div v-if="!visible.length" class="lf-empty">
          {{ s.connected ? '眼下没有符合筛选的日志行。' : '没连上日志通道：正式版（版本号不带 d）没有这条通道。' }}
        </div>
      </div>
    </section>
  </Teleport>
</template>

<script setup>
/**
 * 后台日志悬浮窗（第六十四轮，开发版专属）。
 *
 * 拖动只挂在标题栏上，窗体本身留给原生 resize 边（Chromium 的 resize:both 自带右下角手柄，
 * 比自己算四条边少一套状态）。位置与尺寸记进 localStorage，下次打开还在老地方 ——
 * 这扇窗通常会开着跟一整轮任务，每次都重新摆很烦。
 */
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { debugLog as store } from '../stores/debuglog';
import { toast } from '../stores/toast';

const s = store.state;
const visible = store.visible;
const counts = store.counts;
const bodyEl = ref(null);
const LS = 'nu_logfloat';

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'op', label: '操作' },
  { key: 'net', label: '网络' },
  { key: 'warn', label: '警告' },
  { key: 'error', label: '报错' },
];

function defaultPos() {
  const w = 620;
  const h = 340;
  return { x: Math.max(12, window.innerWidth - w - 24), y: Math.max(56, window.innerHeight - h - 32), w, h };
}

function readPos() {
  try {
    const o = JSON.parse(localStorage.getItem(LS) || '');
    if (o && Number.isFinite(o.x) && Number.isFinite(o.y)) {
      // 存过的位置可能已经在现在这块屏外面（换过显示器/分辨率），拉回可视区
      return {
        x: Math.min(Math.max(0, o.x), Math.max(0, window.innerWidth - 120)),
        y: Math.min(Math.max(0, o.y), Math.max(0, window.innerHeight - 60)),
        w: Math.min(Math.max(360, o.w || 620), Math.max(360, window.innerWidth - 16)),
        h: Math.min(Math.max(180, o.h || 340), Math.max(180, window.innerHeight - 60)),
      };
    }
  } catch (e) { /* 没存过或存的不是 JSON */ }
  return defaultPos();
}

const pos = ref(readPos());

function persist() {
  try { localStorage.setItem(LS, JSON.stringify(pos.value)); } catch (e) { /* 存不上不影响用 */ }
}

let drag = null;
function startDrag(e) {
  drag = { dx: e.clientX - pos.value.x, dy: e.clientY - pos.value.y };
  window.addEventListener('mousemove', onDrag);
  window.addEventListener('mouseup', endDrag);
}
function onDrag(e) {
  if (!drag) return;
  const p = pos.value;
  p.x = Math.min(Math.max(0, e.clientX - drag.dx), window.innerWidth - 80);
  p.y = Math.min(Math.max(0, e.clientY - drag.dy), window.innerHeight - 40);
}
function endDrag() {
  drag = null;
  window.removeEventListener('mousemove', onDrag);
  window.removeEventListener('mouseup', endDrag);
  persist();
}
onBeforeUnmount(endDrag);

// 用户自己往上翻了就不要再强行拽回底部，等 ta 翻回来（距离底部 <40px 才算「在跟」）
const nearBottom = ref(true);
function onScroll(ev) {
  const el = ev.target;
  nearBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

watch(
  () => [visible.value.length, visible.value[visible.value.length - 1]?.text?.length || 0],
  async () => {
    if (s.paused || !nearBottom.value) return;
    await nextTick();
    const el = bodyEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  }
);

watch(() => s.open, (o) => { if (o) { pos.value = readPos(); nearBottom.value = true; nextTick(() => { const el = bodyEl.value; if (el) el.scrollTop = el.scrollHeight; }); } });

async function copy() {
  const text = store.textOf(visible.value);
  if (!text) return toast('这一屏是空的，没什么可复制', 'warn');
  try {
    await navigator.clipboard.writeText(text);
    toast(`已复制 ${visible.value.length} 行`, 'success');
  } catch (e) {
    toast('剪贴板没写进去（浏览器权限），可手动选中标题后 Ctrl+A', 'error', 5000, String(e?.message || e));
  }
}
</script>

<style scoped>
.logfloat {
  position: fixed;
  z-index: 92;            /* 比 KModal 的 80 高一档：调试窗要能压在弹窗上面看现场 */
  display: flex;
  flex-direction: column;
  min-width: 360px;
  min-height: 180px;
  resize: both;
  overflow: hidden;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 18px 48px rgba(0, 0, 0, .38);
}
.lf-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  cursor: move;
  border-bottom: 1px solid var(--border-soft);
  background: var(--bg-panel);
  user-select: none;
  flex: 0 0 auto;
}
.lf-title { font-size: 12px; font-weight: 600; }
.lf-ver, .lf-count { font-size: 11px; color: var(--text-3); }
.lf-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-3); opacity: .5; }
.lf-dot.on { background: var(--ok); opacity: 1; }
.grow { flex: 1; }
.lf-btn {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-2);
  font-size: 11px;
  padding: 2px 7px;
  border-radius: var(--radius-xs);
  cursor: pointer;
}
.lf-btn:hover { color: var(--text-1); border-color: var(--accent); }
.lf-btn.act { color: var(--accent); border-color: var(--accent); }
.lf-filters { display: flex; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--border-soft); flex: 0 0 auto; }
.lf-chip {
  border: 1px solid var(--border-soft);
  background: transparent;
  color: var(--text-3);
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  cursor: pointer;
}
.lf-chip.on { color: var(--text-1); border-color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); }
.lf-chip .n { margin-left: 5px; opacity: .7; }
.lf-body { flex: 1 1 auto; overflow: auto; padding: 6px 10px 12px; font-size: 11.5px; line-height: 1.55; }
.lf-line { display: flex; gap: 7px; align-items: baseline; white-space: pre-wrap; word-break: break-all; }
.lf-line .t { color: var(--text-3); flex: 0 0 auto; }
.lf-line .g { color: var(--text-3); flex: 0 0 auto; opacity: .8; }
.lf-line .ms { color: var(--text-3); flex: 0 0 auto; }
.lf-line.lv-warn .tx { color: var(--warn); }
.lf-line.lv-error .tx { color: var(--danger); font-weight: 600; }
.lf-empty { color: var(--text-3); font-size: 12px; padding: 14px 2px; }
.mono { font-family: var(--mono); }
</style>
