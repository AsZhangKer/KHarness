<template>
  <!-- 整块挂到 body：面板是浮在页面底下的，放在聊天列里会被祖先的 transform / overflow 牵连 -->
  <Teleport to="body">
    <!-- 收起态：底部正中一颗小胶囊。hover 有点过冲的膨胀，点一下把窗口从下面顶上来 -->
    <Transition name="tdp">
      <button
        v-if="!st.open"
        class="td-pill"
        type="button"
        :style="{ left: pillLeft }"
        :title="st.sessions.length ? `${st.sessions.length} 个终端会话，点开浮出终端窗口` : '打开终端（本地 cmd / PowerShell / Git Bash，远程 SSH shell，可开多个标签）'"
        @click="term.toggle(true)"
      >
        <i class="fas fa-terminal"></i>
        <span class="td-pill-t">终端</span>
        <span v-if="st.sessions.length" class="td-pill-n">{{ st.sessions.length }}</span>
      </button>
    </Transition>

    <Transition name="tdk" @after-enter="onPanelShown">
      <section v-show="st.open" class="td" :style="panelStyle">
        <div class="td-grip" title="拖动调整终端浮窗高度" @mousedown.prevent="startGrip"></div>
        <header class="td-bar" title="拖动边缘可移动窗口位置" @mousedown="startPanelDrag">
          <button class="icon-btn sm" type="button" title="收起" @click="term.toggle(false)">
            <i class="fas fa-angles-down"></i>
          </button>
          <div class="td-tabs">
            <button
              v-for="s in st.sessions"
              :key="s.id"
              class="td-tab"
              :class="{ on: s.id === st.activeId, dead: !s.alive }"
              type="button"
              :title="`${s.kind === 'remote' ? '远程 ' + s.host : '本地'} · ${s.shell}${s.cwd ? ' · ' + s.cwd : ''}`"
              @click="term.select(s.id)"
              @contextmenu.prevent="onTabMenu(s, $event)"
            >
              <i class="fas" :class="s.kind === 'remote' ? 'fa-server' : 'fa-desktop'"></i>
              <span class="ellip">{{ s.title }}</span>
              <i v-if="!s.alive" class="fas fa-power-off dead-i" title="进程已退出"></i>
              <i class="fas fa-xmark close-i" @click.stop="term.closeSession(s.id)"></i>
            </button>
            <div v-if="!st.sessions.length" class="muted td-none">还没有终端会话</div>
          </div>
          <span class="grow"></span>
          <KDropdown :items="newItems" :model-value="''" label="新建终端" width="250px" :disabled="st.loading" @change="onNew" />
          <button class="icon-btn sm" type="button" title="选项卡" @click="toggleSettings">
            <i class="fas fa-sliders"></i>
          </button>
          <button class="icon-btn sm" type="button" title="刷新会话列表" @click="term.refreshList()">
            <i class="fas fa-rotate"></i>
          </button>
        </header>

        <!-- 每个会话一个容器：切标签只改显示、不重新挂载，屏幕内容和 xterm 缓冲才不会对不上 -->
        <div ref="bodyEl" class="td-body">
          <div
            v-for="s in st.sessions"
            :key="s.id"
            v-show="s.id === st.activeId"
            class="td-host"
            :ref="(el) => bindSession(s.id, el)"
          ></div>
          <div v-if="!st.sessions.length" class="td-empty muted">
            没有正在运行的终端。点「新建终端」开一个；收起再展开时会自动按当前项目建一个初始终端。
          </div>
        </div>

        <div v-if="ptyBlocked" class="td-warn">
          <i class="fas fa-triangle-exclamation"></i> 本机终端不可用（{{ st.options?.pty_error || 'node-pty 未就绪' }}）。远程终端不受影响，可以开「远程 …」。
        </div>
      </section>
    </Transition>

    <Teleport to="body">
      <div v-if="st.menu" class="ctx-mask" @mousedown="term.closeMenu()" @contextmenu.prevent="term.closeMenu()"></div>
      <div
        v-if="st.menu"
        class="ctx-menu td-menu"
        :style="{ left: menuPos.x + 'px', top: menuPos.y + 'px' }"
        @contextmenu.prevent="term.closeMenu()"
      >
        <button type="button" @click="doRename"><i class="fas fa-pen"></i> 重命名</button>
        <button type="button" @click="doExport"><i class="fas fa-file-export"></i> 导出</button>
        <button type="button" class="danger" @click="doClose"><i class="fas fa-xmark"></i> 关闭</button>
      </div>

      <div v-if="st.settings" class="ctx-mask" @mousedown="st.settings = false"></div>
      <div
        v-if="st.settings"
        class="td-set"
        :style="setStyle"
        @mousedown.stop
      >
        <div class="td-set-row">
          <label class="lb">字体</label>
          <input v-model="prefs.termFont" class="nu-input sm grow" list="kh-term-fonts" placeholder="留空 = 默认等宽" @change="term.applyFont()" />
          <datalist id="kh-term-fonts">
            <option v-for="f in fontList" :key="f" :value="f"></option>
          </datalist>
        </div>
        <div class="td-set-row">
          <label class="lb">字号</label>
          <input v-model.number="prefs.termSize" class="nu-input sm w60" type="number" min="9" max="28" step="1" @change="term.applyFont()" />
          <span class="muted">px</span>
        </div>
        <div class="td-set-sep"></div>
        <div class="td-set-head">
          <span>新终端执行器……</span>
          <button class="icon-btn sm" type="button" title="添加一行" @click="addCustom"><i class="fas fa-plus"></i></button>
        </div>
        <div v-for="(c, i) in customList" :key="i" class="td-set-custom">
          <input v-model="c.name" class="nu-input sm w110" placeholder="名称" />
          <input v-model="c.exe" class="nu-input sm grow" placeholder="C:\path\to\terminal.exe" spellcheck="false" />
          <button class="icon-btn sm" type="button" title="删除" @click="customList.splice(i, 1)">
            <i class="fas fa-trash-can"></i>
          </button>
        </div>
        <div class="td-set-foot">
          <button class="k-btn sm ghost" type="button" @click="saveCustom">保存该终端执行器</button>
        </div>
      </div>
    </Teleport>
  </Teleport>
</template>

<script setup>
/**
 * 底部终端：收起时只是页面底部正中一颗小胶囊，点开才浮出窗口（不挤占消息区高度）。
 * 可开多个 tty 标签，本地（cmd / pwsh / Git Bash / 自定义 / 跟随设置）
 * 与远程（SSH 真 PTY）混着开。会话本体在 terminalStore 里，切会话、关掉窗口都不会杀掉正在跑构建的 shell。
 *
 * 浮窗用 v-show 而不是 v-if：v-if 会把 xterm 的画布拆掉，收起来再打开就是一片空白 ——
 * 进程还活着、流还在收，只是没地方画了，看着像终端死了。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import KDropdown from '../../ui/KDropdown.vue';
import { terminalStore as term } from './terminalStore';
import { promptDialog } from '../../stores/prompt';
import { aiApi } from '../../api';
import { toast } from '../../stores/toast';
import { toastErr } from '../../utils/errText';
import { useChatStore } from './chatStore';

const st = term.state;
const prefs = term.prefs;
const store = useChatStore();
const dragging = ref(false);
const customList = ref([]);
const bodyEl = ref(null);

const ptyBlocked = computed(() => st.options && st.options.pty_ok === false);
const fontList = computed(() => st.fonts || []);

const menuPos = computed(() => {
  const m = st.menu || { x: 0, y: 0 };
  // 贴着窗口右/下边缘时把菜单挪进来，别让「关闭」只剩半截能点
  return { x: Math.min(m.x, window.innerWidth - 260), y: Math.min(m.y, window.innerHeight - 150) };
});

/** 当前会话挂的远程主机：有 = 远程项目，初始终端开在那台机器上 */
const remoteHost = computed(() => {
  const id = store.state.chatId;
  const chat = (store.state.chats || []).find((c) => c.id === id) || store.activeChat?.value;
  const rid = chat?.remote_id;
  if (!rid) return null;
  return (st.options?.hosts || []).find((h) => h.id === rid) || null;
});

/** 下拉项：本地各 shell（未检测到的置灰）+ 每条远程连接 */
const newItems = computed(() => {
  const o = st.options || {};
  const items = [];
  for (const s of o.shells || []) {
    items.push({ value: `local:${s.id}`, label: s.detected ? `本地 · ${s.label}` : `本地 · ${s.label}（未检测到）` });
  }
  for (const h of o.hosts || []) items.push({ value: `remote:${h.id}`, label: `远程 · ${h.name}（${h.username}@${h.host}）` });
  if (!items.length) items.push({ value: '', label: '加载中…' });
  return items;
});

function localCwd() {
  const cwd = store.state.cwd || '';
  return cwd.startsWith('/') ? '' : cwd;   // 远程那种 posix 路径不能喂给本地 shell
}

async function onNew(v) {
  const [kind, arg] = String(v || '').split(':');
  if (!kind) return;
  if (kind === 'local') {
    await term.openSession({ kind: 'local', shell: arg || 'auto', cwd: localCwd() });
  } else {
    const host = (st.options?.hosts || []).find((h) => h.id === Number(arg));
    await term.openSession({ kind: 'remote', host_id: Number(arg), cwd: host?.default_cwd || host?.home || '' });
  }
  await nextTick();
  term.fitActive();
}

/** 会话容器到手就挂载（v-for + ref 回调；切标签不会重走这一步，所以不存在「重开一遍」） */
function bindSession(id, el) {
  if (el) term.mount(id, el);
}

/** 弹起动画走完再量一次：transform 期间容器尺寸没变，ResizeObserver 不会替我们触发 fit */
function onPanelShown() {
  term.fitActive();
}

/**
 * 小胶囊要钉在「输入框」的水平中线上，不是屏幕中线 —— 右边栏一开，输入框整体往左偏，
 * 按屏幕居中就会看着像飘到了旁边。量不到输入框（异常状态）时退回 50%。
 */
const anchorX = ref(0);
const pillLeft = computed(() => (anchorX.value ? `${anchorX.value}px` : '50%'));
let anchorRo = null;
const composerEl = () => document.querySelector('.composer');
function measureAnchor() {
  const el = composerEl();
  if (!el) { anchorX.value = 0; return; }
  const r = el.getBoundingClientRect();
  if (!r.width) return;                       // 抽屉/隐藏状态下宽度为 0，别把胶囊甩到左边
  anchorX.value = Math.round(r.left + r.width / 2);
}

function onTabMenu(s, e) {
  term.openMenu(s.id, e.clientX, e.clientY);
}

/* ---- 浮窗位置 ------------------------------------------------------------------
 * 默认位：贴屏幕底边、水平中线跟着输入框走（和那颗小胶囊同一条线）。
 * 按住标题条空白处可以拖到任意位置；**下一次打开自动回默认位** ——
 * 拖只是临时腾地方（比如想看被挡住的聊天内容），不该变成一个要人去修的持久状态。
 * ----------------------------------------------------------------------------- */
const vp = ref({ w: window.innerWidth, h: window.innerHeight });
const panelPos = ref(null);          // null = 用默认位
const panelW = () => Math.min(1100, vp.value.w - 36);

function defaultPos() {
  const w = panelW();
  const cx = anchorX.value || vp.value.w / 2;
  return {
    x: Math.round(Math.max(8, Math.min(cx - w / 2, vp.value.w - w - 8))),
    y: Math.round(Math.max(8, vp.value.h - st.height - 8)),
  };
}

const panelStyle = computed(() => {
  const p = panelPos.value || defaultPos();
  return { height: st.height + 'px', left: `${p.x}px`, top: `${p.y}px` };
});

/** 设置弹层跟着浮窗的右上角走（浮窗被拖走了它不能还钉在屏幕中间） */
const setStyle = computed(() => {
  const p = panelPos.value || defaultPos();
  return {
    right: `${Math.max(8, vp.value.w - (p.x + panelW()) + 14)}px`,
    bottom: `${Math.max(24, vp.value.h - p.y + 8)}px`,
    maxHeight: `${Math.max(180, p.y - 32)}px`,
  };
});

function startPanelDrag(e) {
  // 标题条上能点的东西不少（收起 / 标签 / 新建 / 设置 / 刷新），别让拖它们变成拖窗口
  if (e.button !== 0 || e.target.closest('button, input, .k-dropdown, .td-tab')) return;
  e.preventDefault();
  const p = panelPos.value || defaultPos();
  const w = panelW();
  const sx = e.clientX;
  const sy = e.clientY;
  const move = (ev) => {
    // 至少留 90px 在屏幕里、标题条不许拖到屏幕外：不然窗口自己就成了关不掉的东西
    const x = Math.min(Math.max(p.x + ev.clientX - sx, 90 - w), vp.value.w - 90);
    const y = Math.min(Math.max(p.y + ev.clientY - sy, 4), vp.value.h - 46);
    panelPos.value = { x: Math.round(x), y: Math.round(y) };
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

watch(() => st.open, (v) => { if (v) panelPos.value = null; });

async function doRename() {
  const id = st.menu?.id;
  term.closeMenu();
  const s = st.sessions.find((x) => x.id === id);
  if (!s) return;
  const name = await promptDialog({ title: '终端标签改名', label: `当前：${s.title}`, value: s.title, confirmText: '改名' });
  if (name) await term.renameSession(id, name);
}

function doExport() {
  const id = st.menu?.id;
  term.closeMenu();
  if (id) term.exportSession(id);
}

function doClose() {
  const id = st.menu?.id;
  term.closeMenu();
  if (id) term.closeSession(id);
}

function toggleSettings() {
  st.settings = !st.settings;
  if (!st.settings) return;
  term.loadFonts();
  customList.value = (st.options?.shells || [])
    .filter((s) => s.custom)
    .map((s) => ({ name: s.label, exe: s.file }));
}

function addCustom() {
  customList.value.push({ name: '', exe: '' });
}

async function saveCustom() {
  const rows = customList.value
    .map((c) => ({ name: String(c.name || '').trim(), exe: String(c.exe || '').trim() }))
    .filter((c) => c.name && c.exe);
  try {
    const r = await aiApi.termCustom(rows);
    customList.value = (r?.terminals || []).map((t) => ({ name: t.name, exe: t.exe }));
    await term.loadOptions(true);
    toast('自定义终端已保存，「新建终端」里可以直接选', 'success');
  } catch (e) {
    toastErr(e, '保存自定义终端失败');
  }
}

let ro = null;
function startGrip(e) {
  dragging.value = true;
  const startY = e.clientY;
  const startH = st.height;
  const move = (ev) => { st.height = Math.min(Math.max(startH + (startY - ev.clientY), 120), Math.floor(window.innerHeight * 0.8)); };
  const up = () => {
    dragging.value = false;
    term.saveHeight();          // 存服务端：localStorage 在桌面端换个端口就是另一个仓库
    term.fitActive();
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

function onWindowResize() {
  vp.value = { w: window.innerWidth, h: window.innerHeight };   // 默认位是照着视口算的，窗口变了要跟着算
  if (st.open) term.fitActive();
  measureAnchor();
}

onMounted(async () => {
  // 高度不用在这儿取：terminalStore 里有个跟着服务端偏好走的 watcher
  await term.loadOptions();
  window.addEventListener('resize', onWindowResize);
  // 输入框一改变宽度（开关右边栏、拖分栏、抽屉展开）就重算胶囊的水平位置
  measureAnchor();
  if (typeof ResizeObserver !== 'undefined') {
    anchorRo = new ResizeObserver(() => measureAnchor());
    const c = composerEl();
    if (c) anchorRo.observe(c);
  }
  // 抽屉从「收起」到「展开」时容器才第一次有尺寸；各会话内部的尺寸变化由 store 里的 per-entry observer 管
  if (typeof ResizeObserver !== 'undefined' && bodyEl.value) {
    ro = new ResizeObserver(() => { if (st.open && st.activeId) term.fitActive(); });
    ro.observe(bodyEl.value);
  }
});
onUnmounted(() => {
  window.removeEventListener('resize', onWindowResize);
  if (ro) ro.disconnect();
  if (anchorRo) anchorRo.disconnect();
});

watch(() => st.activeId, async () => {
  await nextTick();
  term.fitActive();
});

// 展开抽屉：一个终端都没有就按当前项目（本地用设置里的 Shell / 远程用挂的那台机器）自动开一个
watch(() => st.open, async (on) => {
  if (!on) return;
  await nextTick();
  if (bodyEl.value && !ro && typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => { if (st.open && st.activeId) term.fitActive(); });
    ro.observe(bodyEl.value);
  }
  await term.refreshList();
  if (!st.sessions.length) await term.openDefault({ remoteHost: remoteHost.value, cwd: store.state.cwd });
  await nextTick();
  term.fitActive();
});
</script>

<style scoped>
/* 收起态的小胶囊：贴着页面底部正中，hover 胀一点、点下去软一下，全靠带过冲的 bezier */
.td-pill {
  position: fixed; left: 50%; z-index: 69;
  transform: translateX(-50%);
  transform-origin: 50% 100%;
  display: inline-flex; align-items: center; gap: 7px;
  height: 27px; padding: 0 13px;
  /* 再往下沉一点：底部 6px 藏在屏幕外，只留上面 21px —— 12px 的字还在正中偏上，
     读得清，但视觉上像是从屏幕底边长出来的。形状按他的要求从胶囊改成圆角矩形。 */
  bottom: -6px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text-2);
  font-size: 12px;
  box-shadow: var(--shadow);
  transition: transform 0.26s cubic-bezier(0.34, 1.56, 0.64, 1),
    color 0.18s var(--ease), border-color 0.18s var(--ease);
}
.td-pill:hover { transform: translateX(-50%) scale(1.09); color: var(--text); border-color: var(--accent); }
.td-pill:active { transform: translateX(-50%) scale(0.94); transition-duration: 0.09s; }
.td-pill i { font-size: 11px; }
.td-pill-n {
  min-width: 16px; padding: 0 4px; line-height: 16px; height: 16px;
  border-radius: 999px; background: var(--bg-active); color: var(--text);
  font-size: 10px; text-align: center;
}
/* 展开态：浮在页面底下的窗口。位置由 panelStyle 给（left/top），
   默认「贴底 + 与输入框同中线」，拖过之后用拖到的地方，下次打开再回默认。 */
.td {
  position: fixed; z-index: 70;
  width: min(1100px, calc(100vw - 36px));
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  box-shadow: var(--shadow);
  overflow: hidden;
}
.tdk-enter-active { transition: transform 0.3s cubic-bezier(0.22, 1.12, 0.34, 1), opacity 0.18s ease; }
.tdk-leave-active { transition: transform 0.2s cubic-bezier(0.4, 0, 0.84, 0.36), opacity 0.16s ease; }
.tdk-enter-from, .tdk-leave-to { transform: translateY(calc(100% + 20px)); opacity: 0; }
.tdp-enter-active { transition: opacity 0.16s ease, transform 0.3s cubic-bezier(0.34, 1.62, 0.64, 1) 0.06s; }
.tdp-leave-active { transition: opacity 0.1s ease, transform 0.14s ease; }
.tdp-enter-from { opacity: 0; transform: translate(-50%, 16px) scale(0.7); }
.tdp-leave-to { opacity: 0; transform: translate(-50%, 8px) scale(0.92); }
@media (prefers-reduced-motion: reduce) {
  .td, .td-pill, .tdk-enter-active, .tdk-leave-active, .tdp-enter-active, .tdp-leave-active { transition: none; }
}
.td-grip { position: absolute; top: -2px; left: 0; right: 0; height: 7px; cursor: ns-resize; z-index: 3; }
.td-bar { display: flex; align-items: center; gap: 8px; padding: 4px 8px; min-height: 34px; flex-shrink: 0; }
.td-tabs { display: flex; align-items: center; gap: 4px; overflow-x: auto; max-width: 55%; }
.td-tab {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 8px; border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--bg);
  font-size: 11px; color: var(--text-2);
  max-width: 190px;
}
.td-tab.on { border-color: var(--accent); color: var(--text); }
.td-tab.dead { opacity: .6; }
.td-tab .ellip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.td-tab .close-i { opacity: 0; }
.td-tab:hover .close-i { opacity: 1; }
.td-tab .dead-i { color: var(--warn, #c9a227); font-size: 10px; }
.td-none { font-size: 11px; padding: 0 6px; }
.td-body { flex: 1; min-height: 0; position: relative; padding: 4px 8px 8px; }
/* ---- 云母·蓝 / 云母·紫：终端浮窗改磨砂玻璃 ------------------------------------
   面板本身是半透明的（--bg），但 xterm 的 .xterm-viewport 默认刷了一层不透明黑，
   不挑明它，浮窗永远是一块贴在极光上的黑板。
   挑明之后靠 backdrop-filter 把底下的极光糊成一片柔光，再叠一层主题色渐变：
   字仍落在足够深的底上（对比度没丢），但能看出是玻璃不是墨。
   只给这两套主题加 —— 亮色主题下面板是浅的，透明掉 viewport 会让 xterm 的浅色字看不见。 */
:root[data-theme='aurora-blue'] .td,
:root[data-theme='aurora-purple'] .td {
  background: linear-gradient(180deg, rgba(18, 28, 48, 0.34), rgba(8, 13, 24, 0.5));
  /* 只写不带前缀的那一条：和 -webkit- 版一起写，构建时的 CSS 压缩会把不前缀的当成重复项丢掉，
     而 Chromium 早就不认 -webkit-backdrop-filter 了 —— 结果是模糊整个失效，玻璃变回黑板子。 */
  backdrop-filter: blur(26px) saturate(165%);
  border-color: var(--border-strong);
}
:root[data-theme='aurora-purple'] .td {
  background: linear-gradient(180deg, rgba(28, 18, 50, 0.34), rgba(12, 8, 26, 0.5));
}
:root[data-theme='aurora-blue'] .td :deep(.xterm-viewport),
:root[data-theme='aurora-purple'] .td :deep(.xterm-viewport) {
  background: transparent !important;
}
:root[data-theme='aurora-blue'] .td-tab,
:root[data-theme='aurora-purple'] .td-tab { background: var(--bg-panel); }
@media (prefers-reduced-motion: reduce) {
  /* 关掉动画的人也不想要每帧重算的高斯模糊 */
  :root[data-theme='aurora-blue'] .td,
  :root[data-theme='aurora-purple'] .td { backdrop-filter: none; }
}
.td-host { position: absolute; inset: 4px 8px 8px; overflow: hidden; }
.td-empty { position: absolute; inset: 8px; display: flex; align-items: center; justify-content: center; font-size: 12px; text-align: center; padding: 0 24px; }
.td-warn { padding: 6px 10px; font-size: 11px; color: var(--danger); border-top: 1px solid var(--border-soft); }
.grow { flex: 1; }

.td-menu { z-index: 121; }
.td-set {
  /* 位置由 setStyle 现算（跟着浮窗右上角走），这里只定尺寸与外观 */
  position: fixed;
  z-index: 121;
  width: 340px; max-height: 62vh; overflow: auto;
  background: var(--bg-elev); border: 1px solid var(--border);
  border-radius: var(--radius-sm); box-shadow: var(--shadow);
  padding: 10px 12px;
  animation: kh-pop-in 0.2s cubic-bezier(0.22, 1.08, 0.36, 1);
}
.td-set-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 12px; }
.td-set-row .lb { width: 40px; color: var(--text-2); flex-shrink: 0; }
.td-set-row .ck { display: inline-flex; align-items: center; gap: 6px; color: var(--text); }
.td-set-note { font-size: 11px; color: var(--text-2); opacity: .8; line-height: 1.5; margin: 0 0 8px; }
.td-set-sep { height: 1px; background: var(--border-soft); margin: 8px 0; }
.td-set-head { display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: var(--text-2); margin-bottom: 6px; }
.td-set-custom { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.td-set-foot { display: flex; justify-content: flex-end; margin-top: 6px; }
.nu-input.sm { font-size: 12px; padding: 4px 6px; }
.w60 { width: 60px; }
.w110 { width: 110px; }
</style>
