<template>
  <aside ref="railEl" class="rail" :class="{ collapsed, peek: collapsed && peek }">
    <!-- 和右栏那颗一模一样的把手，只是箭头方向反过来：左栏收起到左边 -->
    <button ref="toggleEl" class="rail-toggle" type="button" :title="collapsed ? '展开会话栏（也可把鼠标贴到屏幕左边）' : '收起会话栏'" @click="collapsed = !collapsed">
      <i class="fas" :class="collapsed ? 'fa-chevron-right' : 'fa-chevron-left'"></i>
    </button>
    <!-- 收起时栏内内容整体让位，只剩这颗把手（和右栏 .dock / .dock-inner 同一套做法） -->
    <div v-show="!collapsed || peek" class="rail-inner">
      <div class="brand">
        <img src="/icon.png" alt="" />
        <strong>KHarness</strong>
        <span class="tag">NewUI</span>
      </div>

      <div class="actions">
        <button class="action primary" type="button" @click="$emit('new-project')">
          <i class="fas fa-folder-plus"></i> 新建项目
        </button>
        <button class="action" type="button" @click="$emit('new-chat')">
          <i class="fas fa-plus"></i> 新建会话
        </button>
      </div>

      <!-- 条目级搜索（#220，和设置页那条搜索同一思路）：会话/项目/主机一多就翻不到。
           只按标题过滤、命中即展开 —— 搜正文要走服务端检索，那是另一件事。 -->
      <div class="rail-search">
        <input
          v-model="rq"
          class="k-input"
          type="search"
          placeholder="搜索会话 / 项目 / 主机…"
          @keydown.esc="rq = ''"
        />
        <button v-if="rq" class="rail-search-x" type="button" title="清空搜索" @click="rq = ''">
          <i class="fas fa-xmark"></i>
        </button>
      </div>

      <div ref="treeEl" class="tree">
      <!-- 跟着当前会话滑的高亮胶囊：和设置页标签页同一套动效 -->
      <span class="tree-pill" :style="treePillStyle"></span>
      <div v-if="!filtering || shownProjects.length" class="tree-label">
        <span>项目</span>
        <button class="icon-btn" type="button" title="新建项目" @click="$emit('new-project')">
          <i class="fas fa-plus"></i>
        </button>
      </div>

      <div v-if="!localProjects.length && !localFreeChats.length && !filtering" class="tree-empty">
        暂无项目，请点击「新建项目」或「新建会话」。
      </div>

      <div v-for="p in shownProjects" :key="'p' + p.id" class="proj">
        <button
          class="proj-head"
          :class="{ 'drop-above': dropTarget === 'p' + p.id && dropPos === 'above', 'drop-below': dropTarget === 'p' + p.id && dropPos === 'below' }"
          type="button"
          draggable="true"
          @dragstart="onDragStart('project', p.id, $event)"
          @dragover="onDragOver('project', p.id, $event)"
          @drop.prevent="onDrop('project')"
          @dragend="onDragEnd"
          @click="$emit('toggle-project', p.id)"
          @contextmenu.prevent="$emit('menu', { kind: 'project', item: p, x: $event.clientX, y: $event.clientY })"
        >
          <i class="fas" :class="p.open ? 'fa-chevron-down' : 'fa-chevron-right'"></i>
          <i class="fas fa-folder"></i>
          <span class="name" :title="p.name">{{ p.name }}</span>
          <span class="row-x" title="删除项目" @click.stop="$emit('remove-project', p)">
            <i class="fas fa-xmark"></i>
          </span>
        </button>
        <div class="proj-body" :class="{ open: p.open || filtering }">
          <div class="proj-body-in">
            <button
              v-for="c in shownChatsOf(p.id)"
              :key="'c' + c.id"
              class="chat-row"
              :class="{ active: c.id === activeChatId, pinned: c.pinned, 'drop-above': dropTarget === 'c' + c.id && dropPos === 'above', 'drop-below': dropTarget === 'c' + c.id && dropPos === 'below' }"
              type="button"
              draggable="true"
              @dragstart="onDragStart('chat', c.id, $event)"
              @dragover="onDragOver('chat', c.id, $event)"
              @drop.prevent="onDrop('chat')"
              @dragend="onDragEnd"
              @click="$emit('select-chat', c.id)"
              @contextmenu.prevent="$emit('menu', { kind: 'chat', item: c, x: $event.clientX, y: $event.clientY })"
            >
              <i v-if="busyIds.includes(c.id)" class="fas fa-circle-notch fa-spin spin"></i>
              <i v-else-if="c.pinned" class="fas fa-thumbtack pin"></i>
              <span class="name" :title="p.name + ' / ' + (c.title || '新会话')">
                {{ p.name }} / {{ c.title || '新会话' }}
              </span>
              <span class="row-x" title="删除会话" @click.stop="$emit('remove-chat', c)">
                <i class="fas fa-xmark"></i>
              </span>
            </button>
            <div v-if="!shownChatsOf(p.id).length && !filtering" class="tree-empty indent">该项目下暂无会话</div>
          </div>
        </div>
      </div>

      <!-- 远程连接：与「项目」「最近」同级的一棵大树。展开后是这台机器下的远端项目与会话 -->
      <div v-if="!filtering || shownHosts.length" class="tree-label" style="margin-top:8px">
        <span>远程连接</span>
        <button class="icon-btn" type="button" title="新建 SSH 连接" @click="$emit('new-host')">
          <i class="fas fa-plus"></i>
        </button>
      </div>
      <div v-if="!hosts.length && !filtering" class="tree-empty">
        还没有远程主机，点击 + 新建SSH连接。
      </div>
      <div v-for="h in shownHosts" :key="'h' + h.id" class="proj">
        <button
          class="proj-head"
          type="button"
          @click="$emit('toggle-host', h.id)"
          @contextmenu.prevent="$emit('menu', { kind: 'host', item: h, x: $event.clientX, y: $event.clientY })"
        >
          <i class="fas" :class="h.open ? 'fa-chevron-down' : 'fa-chevron-right'"></i>
          <i class="fas fa-server"></i>
          <span class="name" :title="h.username + '@' + h.host + ':' + h.port">{{ h.name }}</span>
          <i v-if="h.testing" class="fas fa-circle-notch fa-spin state" title="正在测试连接"></i>
          <i v-else-if="h.last_error" class="fas fa-triangle-exclamation state bad" :title="'上次连接失败：' + h.last_error"></i>
          <i v-else-if="h.last_ok" class="fas fa-circle-check state ok" title="上次连接正常"></i>
          <span class="row-x" title="删除连接" @click.stop="$emit('remove-host', h)">
            <i class="fas fa-xmark"></i>
          </span>
        </button>
        <!-- 与「项目」同一套展开动画：grid-template-rows 0fr→1fr（v-if 硬挂载是没动画的） -->
        <div class="proj-body" :class="{ open: h.open || filtering }">
          <div class="proj-body-in">
          <div v-for="rp in shownRemoteProjects(h.id)" :key="'rp' + rp.id" class="proj">
            <button
              class="proj-head sub"
              type="button"
              @click="$emit('toggle-project', rp.id)"
              @contextmenu.prevent="$emit('menu', { kind: 'project', item: rp, x: $event.clientX, y: $event.clientY })"
            >
              <i class="fas" :class="rp.open ? 'fa-chevron-down' : 'fa-chevron-right'"></i>
              <i class="fas fa-folder-tree"></i>
              <span class="name" :title="rp.root_path">{{ rp.name }}</span>
              <span class="row-x" title="删除项目" @click.stop="$emit('remove-project', rp)">
                <i class="fas fa-xmark"></i>
              </span>
            </button>
            <div class="proj-body" :class="{ open: rp.open || filtering }">
              <div class="proj-body-in">
                <button
                  v-for="c in shownChatsOf(rp.id)"
                  :key="'rc' + c.id"
                  class="chat-row"
                  :class="{ active: c.id === activeChatId, pinned: c.pinned }"
                  type="button"
                  @click="$emit('select-chat', c.id)"
                  @contextmenu.prevent="$emit('menu', { kind: 'chat', item: c, x: $event.clientX, y: $event.clientY })"
                >
                  <i v-if="busyIds.includes(c.id)" class="fas fa-circle-notch fa-spin spin"></i>
                  <i v-else-if="c.pinned" class="fas fa-thumbtack pin"></i>
                  <span class="name" :title="rp.name + ' / ' + (c.title || '新会话')">{{ rp.name }} / {{ c.title || '新会话' }}</span>
                  <span class="row-x" title="删除会话" @click.stop="$emit('remove-chat', c)">
                    <i class="fas fa-xmark"></i>
                  </span>
                </button>
                <div v-if="!shownChatsOf(rp.id).length && !filtering" class="tree-empty indent">该远端项目下暂无会话</div>
              </div>
            </div>
          </div>
          <button
            v-for="c in shownRemoteFreeChats(h.id)"
            :key="'rf' + c.id"
            class="chat-row sub free"
            :class="{ active: c.id === activeChatId, pinned: c.pinned }"
            type="button"
            @click="$emit('select-chat', c.id)"
            @contextmenu.prevent="$emit('menu', { kind: 'chat', item: c, x: $event.clientX, y: $event.clientY })"
          >
            <i v-if="busyIds.includes(c.id)" class="fas fa-circle-notch fa-spin spin"></i>
            <i v-else class="fas fa-globe"></i>
            <span class="name" :title="c.title || '新会话'">{{ c.title || '新会话' }}</span>
            <span class="row-x" title="删除会话" @click.stop="$emit('remove-chat', c)">
              <i class="fas fa-xmark"></i>
            </span>
          </button>
          <div v-if="!shownRemoteProjects(h.id).length && !shownRemoteFreeChats(h.id).length && !filtering" class="tree-empty indent">
            这台机器下还没有项目。右键连接选「新建远端项目」，选好远端目录即可。
          </div>
          </div>
        </div>
      </div>

      <div v-if="!filtering || shownFreeChats.length" class="tree-label" style="margin-top:8px">最近</div>
      <button
        v-for="c in shownFreeChats"
        :key="'f' + c.id"
        class="chat-row free"
        :class="{ active: c.id === activeChatId, pinned: c.pinned, 'drop-above': dropTarget === 'f' + c.id && dropPos === 'above', 'drop-below': dropTarget === 'f' + c.id && dropPos === 'below' }"
        type="button"
        draggable="true"
        @dragstart="onDragStart('chat', c.id, $event)"
        @dragover="onDragOver('chat', c.id, $event)"
        @drop.prevent="onDrop('chat')"
        @dragend="onDragEnd"
        @click="$emit('select-chat', c.id)"
        @contextmenu.prevent="$emit('menu', { kind: 'chat', item: c, x: $event.clientX, y: $event.clientY })"
      >
        <i v-if="busyIds.includes(c.id)" class="fas fa-circle-notch fa-spin spin"></i>
        <i v-else-if="c.pinned" class="fas fa-thumbtack pin"></i>
        <span class="name" :title="c.title || '新会话'">{{ c.title || '新会话' }}</span>
        <span class="row-x" title="删除会话" @click.stop="$emit('remove-chat', c)">
          <i class="fas fa-xmark"></i>
        </span>
      </button>
      <div v-if="filtering && !hitCount" class="tree-empty">没有匹配「{{ rq.trim() }}」的会话、项目或连接</div>
    </div>

    <div class="foot">
      <!-- 桌面端的回收站入口在窗口顶栏「文件」菜单里（WindowBar）；浏览器打开时那条栏压根不渲染，
           所以这里只在非桌面端留一颗按钮，否则网页模式下就彻底没有入口了 -->
      <button v-if="!isDesktop" class="action" type="button" @click="$emit('open-recycle')">
        <i class="fas fa-trash-can"></i> 回收站
      </button>
      <!-- 这里叫「选项」不叫「设置」：系统里另有一页就叫「设置」（系统 → 设置），
           两个入口同名会让人以为点进去是同一个地方。路由和事件名照旧不动。 -->
      <button class="action" type="button" @click="$emit('open-settings')">
        <i class="fas fa-gear"></i> 选项
      </button>
    </div>
    </div>
  </aside>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { useSlidingPill } from '../../ui/useSlidingPill';
import { useEdgePeek } from '../../ui/useEdgePeek';

const props = defineProps({
  projects: { type: Array, default: () => [] },
  chats: { type: Array, default: () => [] },
  hosts: { type: Array, default: () => [] },
  activeChatId: { type: Number, default: null },
  busyIds: { type: Array, default: () => [] },
  /** 展开态的栏宽（父组件拖分栏那个值）：贴边临时展开时要按它判断「指针已经离开栏体」 */
  railW: { type: Number, default: 260 },
});

const emit = defineEmits(['new-project', 'new-chat', 'select-chat', 'toggle-project', 'open-settings', 'remove-project', 'remove-chat', 'menu', 'open-recycle', 'reorder', 'new-host', 'toggle-host', 'remove-host']);

/** 桌面端（自绘顶栏那条栏会渲染）与浏览器模式的区分：回收站入口只在一边出现，别两边都没有 */
const isDesktop = typeof window !== 'undefined' && !!(window.khDesktop && window.khDesktop.frameless);

/* ---- 当前会话背后滑动的胶囊（style 必须解构出来，模板不自动拆嵌套 ref） ---- */
const treeEl = ref(null);
const { style: treePillStyle, measure: measureTreePill } = useSlidingPill(
  () => treeEl.value,
  () => {
    const a = treeEl.value?.querySelector('.chat-row.active') || null;
    // 选中的会话在被折叠的项目里时，行其实还在 DOM 里（收起只是把 .proj-body 高度归零 +
    // visibility 关掉），它自己的尺寸还在 —— 胶囊照它量出来的位置就是上一次展开时的位置，
    // 看着像选框卡在别处。这种情况直接不显示，展开时再跟着滑回来。
    if (a && a.closest('.proj-body:not(.open)')) return null;
    return a;
  }
);
// 换会话、增删条目、展开/折叠某个项目，都会让选中行挪位置，都得重量一次。
// 远程主机（内网服务器）的折叠也要算进来：主机本身不在 projects 里，之前漏了这一路，
// 折叠主机时没人重新测量，胶囊就停在展开时量到的老位置上。
const layoutKey = computed(() => (props.projects || []).map((p) => `${p.id}:${p.open ? 1 : 0}`).join(',')
  + '|' + (props.hosts || []).map((h) => `${h.id}:${h.open ? 1 : 0}`).join(','));
watch(
  () => [props.activeChatId, (props.chats || []).length, (props.projects || []).length, layoutKey.value],
  () => {
    nextTick(() => measureTreePill());
    // 展开/折叠是 220ms 的高度动画，一开始量到的位置是旧的，动画收尾再量一次才落准
    setTimeout(() => measureTreePill(), 260);
  }
);

/* ---- 收起 / 展开整条左栏：把手在右边缘，箭头方向和右栏相反 ---- */
const collapsed = ref(false);
const railEl = ref(null);
const toggleEl = ref(null);
// 收起时鼠标贴屏幕左边临时探出来；把手那一条通道刻意排除在外（见 useEdgePeek 注释）
const { peek } = useEdgePeek({
  collapsed,
  side: 'left',
  hostEl: railEl,
  toggleEl,
  widthOf: () => props.railW || 260,
});
watch(() => [collapsed.value, peek.value], () => {
  // 展开（含临时探出）后行才量得到；收起时胶囊自己会淡掉
  nextTick(() => measureTreePill());
  setTimeout(() => measureTreePill(), 260);
});

/* ---- 拖拽排序：置顶项仍排最前，其余按 sort_order ---- */
const dragKind = ref('');
const dragId = ref(null);
const dropTarget = ref('');
const dropPos = ref('');

function orderVal(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 1e9;
}
function byOrder(a, b) {
  return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)
    || (orderVal(a.sort_order) - orderVal(b.sort_order))
    || (b.id - a.id);
}

/**
 * 「最近」只收本机的自由会话 —— 远程会话一律挂在它所属的那台连接下面，
 * 混进最近会让人分不清这条对话到底在动哪台机器。
 */
const localFreeChats = computed(() => (props.chats || []).filter((c) => !c.project_id && !c.remote_id).slice().sort(byOrder));
const freeChats = localFreeChats;
const localProjects = computed(() => (props.projects || []).filter((p) => !p.remote_id).slice().sort(byOrder));

function remoteProjects(hostId) {
  return (props.projects || []).filter((p) => p.remote_id === hostId).slice().sort(byOrder);
}
function remoteFreeChats(hostId) {
  return (props.chats || []).filter((c) => c.remote_id === hostId && !c.project_id).slice().sort(byOrder);
}

function chatsOf(pid) {
  return (props.chats || []).filter((c) => c.project_id === pid).slice().sort(byOrder);
}

/* ---- 条目级搜索（#220）：命中即展开 ----
   只过滤标题、不碰 props 那份数据：选中/拖拽/删除走的还是原路径，清空搜索框界面立刻回到平时的样子。
   命中的是项目名时整组会话都露出来（"这个项目"本身就是要找的东西）。 */
const rq = ref('');
const filtering = computed(() => rq.value.trim().length > 0);

function rqLower() {
  return rq.value.trim().toLowerCase();
}
function chatHit(c) {
  return String(c.title || '新会话').toLowerCase().includes(rqLower());
}
function projHit(p) {
  return `${p.name || ''} ${p.root_path || ''}`.toLowerCase().includes(rqLower());
}
function hostHit(h) {
  return `${h.name || ''} ${h.host || ''} ${h.username || ''}`.toLowerCase().includes(rqLower());
}
function projHasHitChat(p) {
  return chatsOf(p.id).some(chatHit);
}

function shownChatsOf(pid) {
  const list = chatsOf(pid);
  if (!filtering.value) return list;
  const p = (props.projects || []).find((x) => x.id === pid);
  if (p && projHit(p)) return list;
  return list.filter(chatHit);
}
function shownRemoteProjects(hostId) {
  return remoteProjects(hostId).filter((p) => projHit(p) || projHasHitChat(p));
}
function shownRemoteFreeChats(hostId) {
  const list = remoteFreeChats(hostId);
  return filtering.value ? list.filter(chatHit) : list;
}

const shownProjects = computed(() =>
  (filtering.value ? localProjects.value.filter((p) => projHit(p) || projHasHitChat(p)) : localProjects.value));
const shownFreeChats = computed(() =>
  (filtering.value ? localFreeChats.value.filter(chatHit) : localFreeChats.value));
const shownHosts = computed(() => {
  const list = props.hosts || [];
  if (!filtering.value) return list;
  return list.filter((h) => hostHit(h)
    || remoteProjects(h.id).some((p) => projHit(p) || projHasHitChat(p))
    || remoteFreeChats(h.id).some(chatHit));
});
const hitCount = computed(() => shownProjects.value.length + shownFreeChats.value.length
  + shownHosts.value.reduce((n, h) => n + shownRemoteProjects(h.id).length + shownRemoteFreeChats(h.id).length, 0));

// 过滤会增删整棵树里的行，选中行的位置跟着变 —— 胶囊得重量一次（和上面那个 watcher 同一套收尾时机）
watch(rq, () => {
  nextTick(() => measureTreePill());
  setTimeout(() => measureTreePill(), 260);
});

function onDragStart(kind, id, e) {
  dragKind.value = kind;
  dragId.value = id;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(id)); } catch { /* IE 兼容 */ }
  }
}

function onDragOver(kind, id, e) {
  if (!dragId.value || dragKind.value !== kind || dragId.value === id) return;
  e.preventDefault();
  const rect = e.currentTarget.getBoundingClientRect();
  dropTarget.value = (kind === 'project' ? 'p' : (id && !e.currentTarget.classList.contains('free') ? 'c' : 'f')) + id;
  dropPos.value = e.clientY - rect.top < rect.height / 2 ? 'above' : 'below';
}

function onDrop(kind) {
  if (!dragId.value || dragKind.value !== kind || !dropTarget.value) return onDragEnd();
  const targetId = Number(String(dropTarget.value).slice(1));
  // 只在同一列表内重排：会话按所属项目分组，项目按整体顺序
  const list = kind === 'project'
    ? localProjects.value
    : (() => {
      const t = (props.chats || []).find((c) => c.id === targetId);
      const d = (props.chats || []).find((c) => c.id === dragId.value);
      if (!t || !d || (t.project_id || null) !== (d.project_id || null)) return [];
      return t.project_id ? chatsOf(t.project_id) : freeChats.value;
    })();
  const ids = list.map((x) => x.id);
  const from = ids.indexOf(dragId.value);
  if (from < 0) return onDragEnd();
  ids.splice(from, 1);
  let to = ids.indexOf(targetId);
  if (to < 0) to = dropPos.value === 'below' ? ids.length : 0;
  else if (dropPos.value === 'below') to += 1;
  ids.splice(to, 0, dragId.value);
  // 置顶项不参与重排语义：把新顺序整组写回，服务端按数组下标落 sort_order
  emit('reorder', { kind, ids });
  onDragEnd();
}

function onDragEnd() {
  dragKind.value = '';
  dragId.value = null;
  dropTarget.value = '';
  dropPos.value = '';
}
</script>

<style scoped>
/* 拖拽排序：金线指示插入位置 */
.proj-head, .chat-row { position: relative; z-index: 1; /* 压在滑动胶囊上面 */ }
.proj-head[draggable="true"], .chat-row[draggable="true"] { cursor: grab; }
.proj-head:active, .chat-row:active { cursor: grabbing; }
.drop-above::before, .drop-below::after {
  content: '';
  position: absolute;
  left: 6px;
  right: 6px;
  height: 2px;
  background: var(--gold);
  border-radius: 2px;
  pointer-events: none;
}
.drop-above::before { top: -1px; }
.drop-below::after { bottom: -1px; }

/* 左栏：参考图侧栏——近黑底、弱分隔、小圆角列表 */
.rail {
  width: var(--rail-w, 260px);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border-soft);
  background: var(--bg);
  min-height: 0;
  position: relative;   /* 把手要挂在右边缘上 */
  transition: width var(--dur) var(--ease);
}
/* 收起 = 只剩一颗把手；宽度走过渡，栏内内容直接让位（和右栏 .dock 一致） */
.rail.collapsed { width: 36px; }
/* 贴边临时探出：老老实实占排版位置，把后面那一层推过去。
   原来用 position:absolute 盖在上面 —— 云母主题下 --bg 是半透明的，
   聊天记录会直接从栏背后透出来，两层文字叠在一起没法读。 */
.rail.collapsed.peek { width: var(--rail-w, 260px); }
.rail-inner {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  min-width: 0;
}
.rail-toggle {
  position: absolute;
  right: -14px;
  top: 18px;
  z-index: 5;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text-2);
  display: grid;
  place-items: center;
}
.rail-toggle:hover { color: var(--text); background: var(--bg-hover); }
.rail.collapsed .rail-toggle { right: 2px; }
/* 探出状态下把手回到展开时的位置（不然它会浮在栏内容上） */
.rail.collapsed.peek .rail-toggle { right: -14px; }
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 14px 10px;
}
.brand img { width: 22px; height: 22px; border-radius: 6px; }
.brand strong { font-size: 13px; }
.tag {
  margin-left: auto;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 999px;
  background: var(--bg-active);
  color: var(--text-2);
}
.actions {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 8px 10px;
}
.action {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 10px;
  border-radius: var(--radius-sm);
  color: var(--text);
  text-align: left;
}
.action:hover { background: var(--bg-hover); }
.action.primary { background: var(--bg-panel); }
.action i { width: 16px; text-align: center; color: var(--text-2); }
/* 条目级搜索框（#220）：贴着那两颗动作按钮，收栏时跟着一起让位 */
.rail-search { position: relative; padding: 0 8px 8px; }
.rail-search .k-input { padding: 7px 26px 7px 10px; font-size: 12px; }
.rail-search .k-input::-webkit-search-cancel-button { display: none; }
.rail-search-x {
  position: absolute;
  right: 14px;
  top: 50%;
  transform: translateY(-50%);
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  color: var(--text-3);
  font-size: 11px;
}
.rail-search-x:hover { color: var(--text); background: var(--bg-hover); }
.tree {
  position: relative; /* 高亮胶囊的定位基准 */
  flex: 1;
  overflow: auto;
  padding: 4px 8px 12px;
  min-height: 0;
}
/* 跟着当前会话滑的胶囊：和设置页标签页、左导航高亮同一套手感 */
.tree-pill {
  position: absolute;
  left: 8px;
  right: 8px;
  top: 0;
  z-index: 0;
  border-radius: var(--radius-xs);
  background: var(--bg-active);
  box-shadow: inset 0 0 0 1px var(--border);
  pointer-events: none;
  transition: transform 0.2s cubic-bezier(0.34, 1.32, 0.64, 1), height 0.2s var(--ease, ease),
    opacity 0.15s ease;
}
/* 项目展开/收起：grid-template-rows 0fr→1fr 是能动画的写法（height:auto 不行）。
   会话列表常驻 DOM（不再 v-if），靠内层 overflow:hidden 裁掉，收起时连 visibility 一起关掉，
   省得鼠标点到看不见的行、Tab 也跳不进去。 */
.proj-body {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  visibility: hidden;
  transition: grid-template-rows 0.22s var(--ease, ease), opacity 0.16s ease,
    visibility 0s linear 0.22s;
}
.proj-body.open {
  grid-template-rows: 1fr;
  opacity: 1;
  visibility: visible;
  transition-delay: 0s;
}
.proj-body-in {
  overflow: hidden;
  min-height: 0;
}
@media (prefers-reduced-motion: reduce) {
  .proj-body { transition: none; }
}
.tree-label {
  position: relative;
  z-index: 1;
  font-size: 11px;
  color: var(--text-3);
  padding: 8px 10px 6px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.tree-empty {
  color: var(--text-3);
  padding: 12px 10px;
  font-size: 12px;
}
.tree-empty.indent { padding-left: 28px; }
.proj-head,
.chat-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border-radius: var(--radius-xs);
  color: var(--text);
  text-align: left;
}
.proj-head:hover,
.chat-row:hover { background: var(--bg-hover); }
.chat-row {
  padding-left: 28px;
  color: var(--text-2);
  font-size: 12px;
}
.chat-row.free { padding-left: 10px; }
/* 远程连接树：主机 → 远端项目 → 会话，逐层缩进 */
.proj-head.sub { padding-left: 28px; }
.chat-row.sub { padding-left: 46px; }
.chat-row.sub.free { padding-left: 28px; }
.state { font-size: 10px; width: 12px; text-align: center; }
.state.ok { color: var(--ok); }
.state.bad { color: var(--danger); }
.proj-head .fa-server { color: var(--text-2); width: 14px; text-align: center; }
.spin {
  color: var(--ok);
  font-size: 10px;
  width: 12px;
}
.chat-row.active {
  /* 底色交给背后那块滑动的胶囊，这里只提文字色，避免叠出两层背景 */
  color: var(--text);
}
.name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-x {
  opacity: 0;
  color: var(--text-3);
  padding: 2px 4px;
  border-radius: 4px;
}
.proj-head:hover .row-x,
.chat-row:hover .row-x { opacity: 1; }
.row-x:hover { color: var(--danger); background: var(--bg-hover); }
.proj-head i.fa-chevron-down,
.proj-head i.fa-chevron-right {
  font-size: 10px;
  width: 12px;
  color: var(--text-3);
}
.icon-btn {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  color: var(--text-3);
}
.icon-btn:hover { background: var(--bg-hover); color: var(--text); }
.foot {
  border-top: 1px solid var(--border-soft);
  padding: 10px 8px;
}
</style>
