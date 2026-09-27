<template>
  <!-- 只在主进程去掉系统标题栏时才存在（frame:false → preload 的 khDesktop.frameless）。
       浏览器里访问 8317 时整条不渲染，页面布局跟以前一模一样。 -->
  <header v-if="show" ref="barEl" class="kh-winbar" @contextmenu.prevent>
    <div class="wb-brand">
      <img src="/icon.png" alt="" />
      <strong>KHarness</strong>
      <span class="wb-tag">NewUI</span>
    </div>

    <!-- 菜单栏：文件 / 编辑 / 视图 / 检查更新。整条 .kh-winbar 是系统拖拽区，
         菜单和右边的三颗键都写 no-drag 开洞（只有 drag 元素的子孙能开洞，盖在上面不算）。 -->
    <nav class="wb-menus">
      <div v-for="m in MENUS" :key="m.key" class="wb-menu">
        <button
          class="wb-mbtn"
          type="button"
          :class="{ on: open === m.key }"
          @click="toggle(m.key)"
          @mouseenter="hoverSwitch(m.key)"
        >{{ m.label }}</button>
        <div v-if="open === m.key" class="title-menu wb-pop" @click.stop>
          <template v-for="(it, i) in m.items" :key="m.key + '-' + i">
            <div v-if="it.sep" class="wb-sep"></div>
            <button
              v-else
              class="wb-item"
              type="button"
              :disabled="!!it.disabled"
              @click="run(it)"
            >{{ it.label }}</button>
          </template>
        </div>
      </div>
    </nav>

    <span class="wb-fill"></span>
    <div class="wb-keys">
      <button class="wb-key" type="button" title="最小化" aria-label="最小化" @click="act('minimize')">
        <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5h10" /></svg>
      </button>
      <button
        class="wb-key"
        type="button"
        :title="maximized ? '向下还原' : '最大化'"
        :aria-label="maximized ? '向下还原' : '最大化'"
        @click="act('toggle-maximize')"
      >
        <!-- 最大化 = 一个方框；还原 = 两个错开的方框（跟 Windows 自己那套一样） -->
        <svg v-if="!maximized" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" /></svg>
        <svg v-else viewBox="0 0 10 10" aria-hidden="true">
          <rect x="0.5" y="2.5" width="7" height="7" />
          <path d="M2.5 2.5V0.5h7v7H7" />
        </svg>
      </button>
      <button class="wb-key wb-close" type="button" title="关闭" aria-label="关闭" @click="act('close')">
        <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" /></svg>
      </button>
    </div>
  </header>
</template>

<script setup>
/**
 * 自绘窗口顶栏（第三十三轮）：左边 KHarness 标识，接着是文件/编辑/视图/检查更新四个菜单，
 * 中间空档拖窗口，右边三颗 Win11 自绘键。
 *
 * 为什么这条栏必须是 .app-root 的**兄弟**而不是它的孩子：.app-root 带 z-index:1 自己成一个层叠上下文，
 * 塞在它里面的元素无论写多大 z-index 都比不过挂在 body 上的弹窗遮罩（KModal 的 .k-modal-root 是
 * position:fixed; z-index:80）—— 一开弹窗三颗键和菜单就全被遮罩吃掉。
 *
 * 菜单动作全走主进程（kh:win 白名单）：编辑类是 webContents 的原生命令，视图类是缩放/重载，
 * 和快捷键（before-input-event 里同一套实现）走同一条路，不会出现「菜单能用快捷键不能用」。
 *
 * 最大化状态由主进程推（maximize/unmaximize 事件）：自己拿 screen 尺寸猜不可靠，多屏 + DPI 会骗人。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';

const api = typeof window !== 'undefined' ? window.khDesktop : null;
const show = ref(!!(api && api.frameless && typeof api.winCtl === 'function'));
const maximized = ref(false);
const open = ref('');
const barEl = ref(null);
// 顶栏底边（默认按 34px 那条栏），缩放/改高度时靠 resize 重量
let barBottom = 34;
function measureBar() {
  const el = barEl.value;
  if (el) barBottom = el.getBoundingClientRect().bottom;
}

const MENUS = [
  {
    key: 'file',
    label: '文件',
    items: [{ label: '关闭窗口 (Ctrl+W)', run: () => act('close') }],
  },
  {
    key: 'edit',
    label: '编辑',
    items: [
      { label: '撤销 (Ctrl+Z)', run: () => act('edit', 'undo') },
      { label: '重做 (Ctrl+Y)', run: () => act('edit', 'redo') },
      { sep: true },
      { label: '复制 (Ctrl+C)', run: () => act('edit', 'copy') },
      { label: '剪切 (Ctrl+X)', run: () => act('edit', 'cut') },
      { label: '粘贴 (Ctrl+V)', run: () => act('edit', 'paste') },
      { label: '全选 (Ctrl+A)', run: () => act('edit', 'selectAll') },
    ],
  },
  {
    key: 'view',
    label: '视图',
    items: [
      { label: '缩小 (Ctrl+-)', run: () => act('zoom', 'out') },
      { label: '放大 (Ctrl+=)', run: () => act('zoom', 'in') },
      { label: '恢复 (Ctrl+0)', run: () => act('zoom', 'reset') },
      { label: '刷新 (Ctrl+R)', run: () => act('reload') },
    ],
  },
  {
    // 还没有联网更新服务，先按他说的留一个「(空)」，别挂个点了没反应的假入口
    key: 'update',
    label: '检查更新',
    items: [{ label: '(空)', disabled: true }],
  },
];

async function act(action, what) {
  const res = await api.winCtl(action, what);
  if (res && typeof res.maximized === 'boolean') maximized.value = res.maximized;
  return res;
}

function toggle(key) {
  open.value = open.value === key ? '' : key;
}
// 菜单已经开着时，鼠标横着扫过别的菜单名就直接切过去（Windows 菜单栏的老习惯）
function hoverSwitch(key) {
  if (open.value && open.value !== key) open.value = key;
}
function run(item) {
  if (item.disabled) return;
  open.value = '';
  if (item.run) item.run();
}

function onDocDown(e) {
  if (!open.value) return;
  if (e.target && e.target.closest && e.target.closest('.wb-menu')) return;
  open.value = '';
}
/**
 * 开着菜单时，鼠标什么时候才算「走掉了」。
 * 不能只量纵坐标（第一版写的是 `clientY > 顶栏高 + 10` 就收）—— 弹层本来就长在顶栏下面，
 * 鼠标往下走去点菜单项，刚进弹层就被判成离开，永远点不着。
 * 弹层是 `.wb-menu` 的孩子，所以「指针还落在同一个 .wb-menu 子树里（菜单名或它自己的弹层）」就保持开着；
 * 顶栏那条带里（含弹层上面那 2px 缝）也保持。拖拽区里 Blink 不发鼠标事件，所以指针停在可拖的空档上
 * 不会触发这里，天然不会误收。
 */
function onMove(e) {
  if (!open.value) return;
  if (e.clientY <= barBottom + 8) return;
  const t = e.target;
  if (t && t.closest && t.closest('.wb-menu')) return;
  open.value = '';
}

let off = null;
onMounted(async () => {
  if (!show.value) return;
  measureBar();
  window.addEventListener('resize', measureBar);
  const st = await api.winCtl('state');
  if (st && typeof st.maximized === 'boolean') maximized.value = st.maximized;
  off = api.onWinState((s) => {
    if (!s) return;
    maximized.value = !!s.maximized;
  });
  document.addEventListener('mousedown', onDocDown, true);
  window.addEventListener('mousemove', onMove, { passive: true });
  window.addEventListener('blur', () => { open.value = ''; });
});
onBeforeUnmount(() => {
  if (typeof off === 'function') off();
  document.removeEventListener('mousedown', onDocDown, true);
  window.removeEventListener('mousemove', onMove);
  window.removeEventListener('resize', measureBar);
});
</script>

<style scoped>
.kh-winbar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 200; /* 高于弹窗遮罩（KModal 的 .k-modal-root 是 80）：原生标题栏永远浮在内容上 */
  display: flex;
  align-items: stretch;
  height: var(--kh-bar-h, 34px);
  background: var(--bg);
  border-bottom: 1px solid var(--border-soft);
  /* 整条就是系统标题栏：可拖、双击最大化（Windows 自己那套行为，Chromium 会翻成 HTCAPTION） */
  -webkit-app-region: drag;
  user-select: none;
}
.wb-brand {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 4px 0 11px;
}
.wb-brand img { width: 16px; height: 16px; border-radius: 4px; }
.wb-brand strong { font-size: 12.5px; font-weight: 650; letter-spacing: 0.02em; }
.wb-tag {
  font-size: 10px;
  line-height: 1;
  padding: 3px 6px;
  border-radius: 999px;
  color: var(--text-3);
  border: 1px solid var(--border-soft);
}

.wb-menus {
  display: flex;
  align-items: stretch;
  margin-left: 6px;
  -webkit-app-region: no-drag;
}
.wb-menu { position: relative; display: flex; }
.wb-mbtn {
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--text-2);
  font-size: 12.5px;
  padding: 0 11px;
  cursor: default;
  transition: background 0.12s ease, color 0.12s ease;
}
.wb-mbtn:hover { background: var(--bg-hover); color: var(--text); }
.wb-mbtn.on { background: var(--bg-active); color: var(--text); }

.wb-pop {
  position: absolute;
  top: calc(100% + 2px);
  left: 0;
  z-index: 10;
  min-width: 168px;
  /* 弹层是顶栏的孩子，跟着父级一起被当成拖拽区的话就点不动了 */
  -webkit-app-region: no-drag;
}
.wb-item {
  display: block;
  width: 100%;
  border: 0;
  border-radius: var(--radius-xs);
  background: transparent;
  padding: 7px 10px;
  color: var(--text-2);
  font-size: 12px;
  text-align: left;
  white-space: nowrap;
  cursor: default;
}
.wb-item:hover { background: var(--surface-hover); color: var(--text); }
.wb-item:disabled { color: var(--text-3); cursor: not-allowed; }
.wb-item:disabled:hover { background: transparent; }
.wb-sep { height: 1px; margin: 4px 2px; background: var(--border-soft); }

.wb-fill { flex: 1 1 auto; min-width: 20px; }
.wb-keys {
  display: flex;
  align-items: stretch;
  /* 三颗键要在拖拽区里开洞，不然点不着（只有 drag 元素的子孙能开洞） */
  -webkit-app-region: no-drag;
}
.wb-key {
  width: 46px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--text-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: default; /* Windows 那三颗键没有手型 */
  transition: background 0.12s ease, color 0.12s ease;
}
.wb-key svg { width: 10px; height: 10px; fill: none; stroke: currentColor; stroke-width: 1; }
.wb-key:hover { background: var(--bg-hover); color: var(--text); }
.wb-key:active { background: var(--bg-active); }
/* 关闭键 hover 变红、图标转白，和 Windows 一致 */
.wb-close:hover { background: #c42b1c; color: #fff; }
.wb-close:active { background: #b83124; color: #fff; }
</style>
