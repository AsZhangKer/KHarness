<template>
  <div
    class="k-dropdown"
    :class="[{ block }, ef ? ['ef-dd', { 'is-open': open }, 'place-' + place] : '']"
    ref="rootEl"
    @keydown="onKey"
  >
    <!-- 终末地：触发条 = 母本 ai/WINDOW/整体 · hk设计.html 第 44–45 行的 .sel（白盘 + 2px 白边 + CSS 三角 .car），
         再叠一层 ai/DROPDOWN_MENU/下拉菜单.html 第 26–32 行的 .ef-dd__btn —— 那一层只带来三样东西：
         position:relative + z-index:2（把胶囊压在面板口上，连体的另一半）与母本那颗黄色焦点环；
         皮（面色/边框/字号/内距）仍由 .sel 说话（限定宿主后 (0,4,0) > .ef-dd__btn 的 (0,3,0)）。
         其余六套主题仍走 .pill-btn/.dropdown-panel 那套。 -->
    <button
      class="k-dd-trigger"
      :class="ef ? ['sel', 'ef-dd__btn', { open, disabled }] : ['pill-btn', { open, disabled }]"
      type="button"
      :disabled="disabled"
      aria-haspopup="listbox"
      :aria-expanded="open"
      ref="triggerEl"
      @click="toggle"
    >
      <span v-if="!$slots.trigger" class="k-dd-text" :class="{ ph: !hasValue }">{{ shownLabel }}</span>
      <slot v-else name="trigger" :open="open"></slot>
      <i v-if="ef" class="car" aria-hidden="true"></i>
      <i v-else class="fas fa-chevron-down caret"></i>
    </button>
    <!-- 面板默认 Teleport 到 body：右栏 .dock-inner 是 overflow:hidden（卡片四角要真的裁住行背景），
         以前面板做它的孩子就被裁掉 —— 「点了没反应」是这条的成因，和主题无关。
         但终末地这一件不能搬走：母本的连体写法是「面板 absolute 做胶囊的兄弟 + 胶囊 z-index:2 压在口上」，
         搬到 body 变 fixed 之后面板永远盖在按钮上面（.app-root 自己就是层叠上下文，按钮抬不过 z-index:80）
         ⇒ :disabled="ef" 让它留在原地，靠 composer 那层已登记的 overflow:visible 出头。 -->
    <Teleport to="body" :disabled="ef">
      <Transition name="kdd">
        <div
          v-if="open"
          ref="menuEl"
          class="k-dd-menu"
          :class="[ef ? ['pop', 'mnu', 'ef-dd__menu'] : ['dropdown-panel', 'light'], 'place-' + place]"
          role="listbox"
          :style="menuStyle"
        >
          <!-- 长列表的过滤框：只在 searchable 时出现（模型 180+ 条，纯滚动找不过来）。
               keydown.stop 交给 onKey 统一处理方向键/回车/Esc，避免和输入法抢键。 -->
          <div v-if="searchable" class="k-dd-search">
            <input
              ref="searchEl"
              v-model="q"
              type="text"
              :placeholder="searchPlaceholder"
              @keydown.stop="onKey"
              @click.stop
            />
          </div>
          <template v-for="(item, i) in visibleItems" :key="'kdd' + i">
            <!-- 分隔线：把一个菜单分成几段（Git 菜单要「分支 / 操作 / 远端」三组）。
                 不是可选项，键盘导航与点击都会跳过它。 -->
            <div v-if="item.sep" class="k-dd-sep" role="separator"></div>
            <button
              v-else
              class="k-dd-item"
              :data-i="i"
              :disabled="!!item.disabled"
              :class="ef
                ? ['mi', { on: isOn(item), danger: item.danger, disabled: item.disabled }]
                : ['list-item', { on: isOn(item), active: isOn(item), cursor: i === cursor, danger: item.danger, disabled: item.disabled }]"
              type="button"
              role="option"
              :aria-selected="isOn(item)"
              @mouseenter="cursor = i"
              @click="pick(item)"
            >
              <span :class="ef ? 'ef-dd__label' : ''">{{ item.label }}</span>
              <!-- 右侧小字（Git 菜单拿来显示「3 处改动」「领先 2」这类现成信息） -->
              <span v-if="item.hint" class="k-dd-hint">{{ item.hint }}</span>
              <!-- 勾 = 母本 .mnu .mi .ck（svg.i 那套 stroke=currentColor / stroke-width 2，选中才 display:block）；
                   显示与否由母本 CSS 决定，所以这里不再写 v-if -->
              <svg v-if="ef" class="i ck" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
              <i v-else-if="isOn(item)" class="fas fa-check"></i>
            </button>
          </template>
          <div v-if="!visibleItems.length" class="k-dd-empty">无选项</div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { isImeComposing } from '../utils/ime';
import { themeState } from '../stores/theme';

const props = defineProps({
  items: { type: Array, default: () => [] },
  modelValue: { type: [String, Number, Boolean, Object], default: '' },
  /** 覆盖触发器文案；不传则显示选中项的 label（表单里当 select 用） */
  label: { type: String, default: '' },
  placeholder: { type: String, default: '请选择' },
  width: { type: String, default: '220px' },
  disabled: { type: Boolean, default: false },
  /** auto = 下方空间不足时朝上开；也可强制 top / bottom */
  placement: { type: String, default: 'auto' },
  /** 撑满父容器宽度（放进表单行里用） */
  block: { type: Boolean, default: false },
  /** 长列表（模型 180+ 条）打开时在面板顶部给一个过滤框 —— 只在真的需要时传 true，
      普通 4~8 项的菜单不加，免得每次打开先看到一个输入框 */
  searchable: { type: Boolean, default: false },
  searchPlaceholder: { type: String, default: '搜索…' },
});
const emit = defineEmits(['update:modelValue', 'change', 'open', 'close']);
// 终末地走母本 .sel/.mnu，其余六套走 .pill-btn/.dropdown-panel —— 两套类名不能同时挂（会互相咬）
const ef = computed(() => themeState.id === 'endfield');
const open = ref(false);
const cursor = ref(0);
const rootEl = ref(null);
const triggerEl = ref(null);
const menuEl = ref(null);
const place = ref('bottom');

const current = computed(() => props.items.find((x) => isOn(x)) || null);
const hasValue = computed(() => !!current.value);
const shownLabel = computed(() => props.label || current.value?.label || props.placeholder);

/* 搜索过滤：只有 searchable 才生效。过滤时把分隔线一起去掉 —— 过滤后的列表里
   保留原分隔线会切出一堆空档（两段之间什么都没有，看着像列表坏了）。 */
const q = ref('');
const searchEl = ref(null);
const visibleItems = computed(() => {
  if (!props.searchable) return props.items;
  const kw = q.value.trim().toLowerCase();
  if (!kw) return props.items;
  // keywords：不在面板上显示、但参与匹配（模型下拉用它兜上「提供商名 / model_id」，
  // 否则用户按 OpenRouter 搜不到那一串别名）。
  return props.items.filter((it) => {
    if (!it || it.sep) return false;
    const hay = `${it.label || ''} ${it.keywords || ''}`.toLowerCase();
    return hay.includes(kw);
  });
});

function isOn(item) {
  return String(item.value) === String(props.modelValue) && props.modelValue !== '' && props.modelValue != null;
}

// 面板能用的横向空间：视口与「最近的裁切祖先」的交集。
// 终末地这一件的面板留在原地（不 Teleport），祖先里 .dock-inner 是 overflow:hidden
// —— 越过它的右沿就会被裁掉，所以上限不能只按视口算。
function clipBox() {
  let left = 0;
  let right = window.innerWidth;
  let n = rootEl.value?.parentElement || null;
  while (n && n !== document.body) {
    const cs = getComputedStyle(n);
    const ox = cs.overflowX;
    if (ox === 'hidden' || ox === 'clip' || ox === 'auto' || ox === 'scroll') {
      const r = n.getBoundingClientRect();
      left = Math.max(left, r.left);
      right = Math.min(right, r.right);
    }
    n = n.parentElement;
  }
  return { left, right };
}

// 面板挂到 body 上之后自己定位：宽度跟触发条对齐（件 5「面板与触发条同宽」），
// 朝上还是朝下看视口剩余空间，左右夹进视口里，窗口缩放或祖先滚动时跟着重算。
// 终末地不写这套：面板留在组件里、由母本 .ef-dd__menu 自己 absolute 定位（连体），
// 这里只留「向上还是向下」这一个判断给 place 类用。
const menuStyle = ref({});
function positionMenu() {
  const el = triggerEl.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (!r.width) return;
  const below = window.innerHeight - r.bottom;
  place.value = props.placement === 'top' ? 'top'
    : props.placement === 'bottom' ? 'bottom'
    : (below < 260 && r.top > below) ? 'top' : 'bottom';
  if (ef.value) {
    // 终末地：面板留在触发条里（母本连体写法），宽度交给 CSS 的 width:max-content ——
    // 文案比触发条长时面板横向自己变长，而不是一律砍成省略号。
    // 长在哪边：**取空间大的那一边**（母本只写了 left:0;right:0 的等宽情形，没规定方向）。
    //   · 输入区最右那颗「模型」胶囊：右边只剩 600、左边有 1160 ⇒ 往左长，正好留在输入框里，
    //     不会盖住发送钮、也不会伸到右栏去；
    //   · 右栏 .dock-inner 只有 290 宽且 overflow:hidden ⇒ 上限就是它，面板不会被裁。
    // 上限一律封在「裁切祖先 / 视口」之内，所以文字顶格时由 .ef-dd__label 的省略号收尾。
    const box = clipBox();
    const pad = 8;
    const roomRight = box.right - r.left - pad;
    const roomLeft = r.right - box.left - pad;
    if (roomLeft > roomRight) {
      menuStyle.value = { left: 'auto', right: '0px', maxWidth: Math.round(Math.max(160, roomLeft)) + 'px' };
    } else {
      menuStyle.value = { left: '0px', right: 'auto', maxWidth: Math.round(Math.max(160, roomRight)) + 'px' };
    }
    /*
     * 本体也要跟着变：母本 ai/DROPDOWN_MENU/下拉菜单.html 的连体款（.dropdown.combo）是
     *   .dropdown.combo{width:240px} + .pill-btn{width:240px} + 面板 width:auto(＝100%)
     * —— 按钮与面板**都由容器那一个宽度说话**，所以永远不会出现「面板变宽、按钮还是窄的」。
     * 我们这排是内容撑宽的胶囊，容器宽度只能等面板渲染出来才知道 ⇒ 在这里量面板的自然宽，
     * 写回容器（--dd-w），CSS 让 .sel 取 100%。
     * 量的时候必须先把 inline 的 max-width 摘掉：那一条是按「视口/裁切祖先余量」算的，
     * 会把面板压窄，量出来就成了"被裁后的宽度"而不是"内容本来需要多宽"。
     */
    const m = menuEl.value;
    if (m) {
      const prev = m.style.maxWidth;
      m.style.maxWidth = 'none';
      const nat = m.getBoundingClientRect().width;   // 同步读一次布局，拿 width:max-content 的自然宽
      m.style.maxWidth = prev;
      if (nat > 0) {
        // 不缩小：按钮自己也可能比面板内容宽（标签更长），取大者才不会被自己的文字撑破
        let want = Math.max(nat, r.width);
        /*
         * 但也不能让一次加宽把整行挤垮：实测模型那颗长到 333 时，Git 胶囊被压成了 0 宽
         * （它没有 .bar-txt，min-width 兜底也是 0）。所以这里按「整行可用宽 − 其他子项占位」
         * 给一个上限，超了就停在那儿 —— 面板该多宽还多宽（它是浮层，不占排版），
         * 只是按钮不再跟着无限长。
         */
        const bar = rootEl.value?.closest('.bar');
        if (bar) {
          const cs = getComputedStyle(bar);
          const gap = parseFloat(cs.columnGap) || parseFloat(cs.gap) || 0;
          let others = 0;
          let n = 0;
          for (const ch of bar.children) {
            if (ch === rootEl.value) continue;
            others += ch.getBoundingClientRect().width;
            n += 1;
          }
          const cap = bar.clientWidth - others - gap * n;
          if (cap > 0) want = Math.min(want, cap);
        }
        const w = Math.round(Math.max(want, r.width));
        rootEl.value?.style.setProperty('--dd-w', `${w}px`);
      }
    }
    return;
  }
  const gap = 4;
  const wanted = Math.max(r.width, parseFloat(props.width) || 0);
  const width = Math.min(wanted, window.innerWidth - 16);
  const style = {
    width: `${Math.round(width)}px`,
    left: `${Math.round(Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - width - 8)))}px`,
  };
  if (place.value === 'top') style.bottom = `${Math.round(window.innerHeight - r.top + gap)}px`;
  else style.top = `${Math.round(r.bottom + gap)}px`;
  menuStyle.value = style;
}

function toggle() {
  if (props.disabled) return;
  if (open.value) close();
  else open.value = true;
}
function close() {
  if (!open.value) return;
  open.value = false;
  emit('close');
}
function pick(item) {
  if (!item || item.sep || item.disabled) return;   // 分隔线 / 置灰项不响应
  emit('update:modelValue', item.value);
  emit('change', item.value);
  close();
}

/** 可选项的下标（跳过分隔线、置灰项）—— 键盘上下要能跨过它们 */
function pickableIndexes() {
  const out = [];
  visibleItems.value.forEach((it, i) => { if (it && !it.sep && !it.disabled) out.push(i); });
  return out;
}
/** 从 dir 方向找下一个可选项；一个都没有就返回 -1 */
function stepCursor(dir) {
  const idx = pickableIndexes();
  if (!idx.length) return -1;
  const at = idx.indexOf(cursor.value);
  return idx[at === -1 ? (dir > 0 ? 0 : idx.length - 1) : (at + dir + idx.length) % idx.length];
}

function onKey(e) {
  // 合成中（输入法候选词还没上屏）一个键都不接：这里 preventDefault 会把 compositionend 弄丢，
  // 之后这个框的 v-model 就再也收不到 input 事件（详见 utils/ime.js）
  if (isImeComposing(e)) return;
  // Esc 收菜单（原来挂在模板的 @keydown.esc 上，和 onKey 同时绑在这个元素上；
  // 合成中该交给输入法取消候选，所以并到这里统一判）
  if (e.key === 'Escape') { close(); return; }
  if (!open.value) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      open.value = true;
    }
    return;
  }
  const n = visibleItems.value.length;
  if (!n) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    const next = stepCursor(1);
    if (next >= 0) { cursor.value = next; nextTick(() => scrollTo(cursor.value)); }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    const next = stepCursor(-1);
    if (next >= 0) { cursor.value = next; nextTick(() => scrollTo(cursor.value)); }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    pick(visibleItems.value[cursor.value]);
  }
}

function onDoc(e) {
  // 面板现在挂在 body 上：点它里面的行不算「点外面」，否则 mousedown 先把面板摘掉、click 永远落不到那一行
  if (rootEl.value?.contains(e.target) || menuEl.value?.contains(e.target)) return;
  close();
}
onMounted(() => document.addEventListener('mousedown', onDoc));
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDoc);
  window.removeEventListener('resize', positionMenu);
  window.removeEventListener('scroll', positionMenu, true);
});
let settleTimer = 0;
watch(open, (v) => {
  if (!v) {
    window.removeEventListener('resize', positionMenu);
    window.removeEventListener('scroll', positionMenu, true);
    clearTimeout(settleTimer);
    // 收起即还原：--dd-w 是"这次打开时面板需要多宽"，只是打开期间的临时量。
    // 留着它，胶囊就一直挂在打开时那个宽度上（选了个长模型名，关掉之后还是那么宽，
    // 看着像"关不掉"）。清掉后容器回到 width:auto ⇒ 按当前标签的自然宽重排；
    // 若选中项的标签变长了，重排后自然就是新的宽度，不需要旧的 --dd-w 帮忙。
    if (ef.value) rootEl.value?.style.removeProperty('--dd-w');
    q.value = '';
    return;
  }
  const idx = visibleItems.value.findIndex((x) => isOn(x));
  cursor.value = idx >= 0 ? idx : 0;
  // 落点若正好是分隔线/置灰项，挪到最近的可选项上（否则回车会点了个寂寞）
  if (visibleItems.value[cursor.value]?.sep || visibleItems.value[cursor.value]?.disabled) {
    const next = stepCursor(1);
    cursor.value = next >= 0 ? next : 0;
  }
  positionMenu();
  nextTick(() => {
    positionMenu();
    // 可搜索的长列表：打开就聚焦过滤框（边打边筛，比滚 23 屏快得多）
    if (props.searchable) searchEl.value?.focus?.();
    else triggerEl.value?.focus?.();
    // 长列表（迁移后 280+ 模型）打开时必须落在当前选项上，否则要点开再滚很久
    scrollTo(cursor.value);
  });
  // 面板已经不在触发条的排版上下文里了：窗口改大小、栏里滚动，都得跟着重摆，不然它就留在原地
  window.addEventListener('resize', positionMenu);
  window.addEventListener('scroll', positionMenu, true);
  // 再补一次：composer 的 textarea 会随输入自己长高，触发条因此往上挪，面板得跟着落位（实测差 15px 就是这条）
  settleTimer = setTimeout(positionMenu, 220);
  emit('open');
});

function scrollTo(i) {
  const menu = menuEl.value;
  if (!menu) return;
  const el = menu.querySelector(`.k-dd-item[data-i="${i}"]`) || menu.querySelector('.k-dd-item.on');
  if (el) el.scrollIntoView({ block: 'center' });
}

/* 过滤后行数变了：游标回到第一项，面板宽度（max-content）也要重新量 */
watch(q, () => {
  cursor.value = 0;
  nextTick(() => { positionMenu(); scrollTo(0); });
});
</script>

<style scoped>
.k-dropdown { position: relative; display: inline-block; }
.k-dropdown.block { display: block; width: 100%; }
.k-dd-trigger {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 32px;
  padding: 5px 12px;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text-2);
  border-radius: var(--radius-sm);
  font-size: 12px;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease),
    border-color var(--dur) var(--ease);
}
.k-dd-trigger:hover,
.k-dd-trigger.open {
  color: var(--text);
  background: var(--bg-hover);
  border-color: var(--border-strong);
}
.k-dd-trigger:disabled,
.k-dd-trigger.disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.k-dd-text {
  flex: 1;
  min-width: 0;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.k-dd-text.ph { color: var(--text-3); }
.caret { font-size: 9px; opacity: 0.7; transition: transform var(--dur) var(--ease); flex-shrink: 0; }
.open .caret { transform: rotate(180deg); }
/* （旧终末地下拉族的箭头/勾 svg 已停用：这一套换成「整体 · hk设计」的 .sel/.mnu，见 endfield-masters.css） */
/* 弹层与右键菜单 / 命令面板 / 弹窗共用一套表面语言（见 tokens.css 的 .k-pop-*）。
   位置与宽度由 positionMenu() 写进 inline style（面板已 Teleport 到 body，只能视口定位）。 */
.k-dd-menu {
  position: fixed;
  z-index: 130;
  max-height: 280px;
  overflow: auto;
  background: var(--surface-pop);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow);
  padding: 4px;
}
.k-dd-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 7px 10px;
  border-radius: var(--radius-xs);
  color: var(--text-2);
  font-size: 12px;
  text-align: left;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.k-dd-item:hover,
.k-dd-item.cursor {
  background: var(--surface-hover);
  color: var(--text);
}
.k-dd-item.on {
  background: var(--surface-active);
  color: var(--text);
  font-weight: 600;
}
.k-dd-item i { color: var(--text-3); font-size: 10px; }
/* 危险档（如 FULL-SEND）：菜单里就该一眼红，不能和普通项长一个样 */
.k-dd-item.danger,
.k-dd-item.danger i { color: var(--danger, #e5484d); }
.k-dd-item.danger:hover,
.k-dd-item.danger.cursor { color: var(--danger, #e5484d); font-weight: 600; }
.k-dd-empty {
  padding: 10px;
  color: var(--text-3);
  font-size: 12px;
}
/* 长列表的过滤框（searchable）。普通下拉不渲染它，所以这里不用管「4 项菜单里多一个框」的问题。 */
.k-dd-search {
  padding: 6px 8px 4px;
}
.k-dd-search input {
  width: 100%;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xs);
  background: var(--bg-panel);
  color: var(--text);
  font-size: 12px;
  outline: none;
}
.k-dd-search input:focus { border-color: var(--accent); }
/* 终末地：面板是深灰 .mnu，白底输入框会跳出来。压成同一档深面 + 浅字。 */
:root[data-theme='endfield'] .mnu .k-dd-search input {
  height: 28px;
  padding: 0 10px;
  border: 1px solid #6a6968;
  border-radius: 6px;
  background: #3a3939;
  color: #f2f2f2;
  font-size: 12.5px;
}
:root[data-theme='endfield'] .mnu .k-dd-search input:focus { border-color: #ffe500; }
:root[data-theme='endfield'] .mnu .k-dd-search input::placeholder { color: #a5a3a3; }
/* 分隔线：把一个菜单分成几段（Git 菜单要「分支 / 操作 / 远端」几组）。
   不是可选项 —— .k-dd-sep 上不绑任何事件。 */
.k-dd-sep {
  height: 1px;
  margin: 5px 8px;
  background: var(--border-soft, var(--border));
  opacity: .8;
}
/* 右侧小字：现成信息（改动数 / 领先落后），不参与交互 */
.k-dd-item .k-dd-hint {
  margin-left: auto;
  color: var(--text-3);
  font-size: 11px;
  font-weight: 400;
  white-space: nowrap;
}
.k-dd-item:disabled,
.k-dd-item.disabled {
  opacity: .45;
  cursor: default;
}
.k-dd-item:disabled:hover,
.k-dd-item.disabled:hover {
  background: none;
  color: var(--text-2);
}
/* 下拉面板和别的弹窗同一套开合：升起 + 轻微抖动进场，下落渐隐收走 */
.kdd-enter-active { animation: kh-pop-in 0.22s cubic-bezier(0.22, 1.08, 0.36, 1); }
.kdd-leave-active { animation: kh-pop-out 0.14s cubic-bezier(0.4, 0, 0.9, 0.35) forwards; }

  html[data-motion='off'] .kdd-enter-active,

  html[data-motion='off'] .kdd-leave-active{ animation: none; }

</style>
