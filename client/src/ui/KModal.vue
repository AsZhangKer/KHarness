<template>
  <Teleport to="body">
    <Transition name="kpop">
      <!-- 终末地：**母本的 DOM 原样渲染**，只把面板里的占位文字换成真内容。
           四份母本（设计稿 WINDOW 目录）：
             banner → 弹窗 · 普通长条横幅按钮框.html
             dialog → 弹窗 · 危险解锁框.html
             panel  → 弹窗 · 更多文字面板框.html
             form   → 重命名对话框.html
           结构、类名、装饰件数量都照母本；面板 CSS 在 styles/endfield-dialogs.css（逐字搬入）。 -->
      <div v-if="open && ef" class="k-modal-root k-modal-root--ef" @click.self="$emit('close')">
        <!-- ── 横幅框 ─────────────────────────────────────────────── -->
        <div v-if="board === 'banner'" class="efd-banner" :style="kStyle">
          <section class="d1">
            <i class="l0"></i><i class="l1"></i>
            <i class="c1"></i><i class="c2"></i><i class="c3"></i>
            <i class="tri"></i><span class="tag">{{ code }}</span>
            <i class="s0"></i><i class="s1"></i><i class="s2"></i><i class="s3"></i>
            <h1 class="ttl">{{ title }}</h1>
            <!-- 内容宿主必须是 div：<p> 不能包含列表/div 这类块级元素，浏览器会当场把 <p> 闭合，
                 slot 内容就掉到 .msg 外面（绝对定位的 .b3 里没有它该在的位置）。 -->
            <div class="msg"><slot /></div>
            <i class="ln a"></i><i class="ln m"></i><i class="ln b"></i>
            <!-- 关闭钮照搬 BUTTON/按钮控件陈列.html 的 .ef-icon--exit：
                 42u 白圆盘 + 虚线细边 + 黑色 X（fill evenodd），hover 压暗、按下缩到 .94。
                 位置钉在各自板的右上角（不是视口右上），四块板各放一颗。 -->
            <button class="ef-close" type="button" title="关闭" aria-label="关闭" @click.stop="$emit('close')">
              <svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="50" fill="#fff"/><circle cx="50" cy="50" r="48.4" fill="none" stroke="#d8d8d8" stroke-width=".35" stroke-dasharray="1 .8"/><path d="M75.2,14.9 51.2,38.9 49.5,38.9 26.5,15.9 16.4,25.9 39.2,49.1 39.2,50.9 15.5,74.7 25.4,84.7 49.6,60.8 51.1,60.8 76.6,86.3 86.7,76.2 61.4,50.9 61.4,49.0 85.4,25.0Z M49.5,41.6 51.2,41.6 58.7,49.1 58.7,50.8 51.2,58.4 49.5,58.4 41.9,50.8 41.9,49.1Z" fill="#0c0c0a" fill-rule="evenodd"/></svg>
            </button>
          </section>
          <div class="efd-actions">
            <slot name="footer">
              <button v-if="!hideCancel" class="ef-pill ef-pill--float" type="button" @click="$emit('close')">
                <i class="ef-pill__tex"></i><i class="ef-pill__line"></i>
                <span class="ef-pill__label">{{ cancelText }}</span>
                <span class="ef-pill__ico" v-html="ICO_X"></span>
              </button>
              <button class="ef-pill ef-pill--yellow ef-pill--float" type="button" :disabled="okDisabled" @click="$emit('ok')">
                <i class="ef-pill__tex"></i><i class="ef-pill__line"></i>
                <span class="ef-pill__label">{{ okText }}</span>
                <span class="ef-pill__ico" v-html="ICO_LOOP"></span>
              </button>
            </slot>
          </div>
        </div>

        <!-- ── 居中框（黄标头 + 挂锁） ─────────────────────────────── -->
        <div v-else-if="board === 'dialog'" class="efd-dialog" :class="{ tall }" :style="kStyle">
          <section class="u4">
            <div class="hd">
              <span class="lg">{{ code || 'CONFIRM.DIALOG' }}</span>
              <h1>{{ title }}</h1>
              <!-- 母本这里还有一块 `.tag`（`// ▬▬ ▬ ▬▬` 的深色小签）。
                   它设计在 1920 画布上（102u×10u、6u 字号），等比缩到弹窗尺度后只剩一条 82×8 的黑条，
                   正好压在标题下沿，看着像把字切了 ⇒ 按他的要求去掉，不改其它任何值。 -->
              <i class="sh"></i><i class="lk"></i>
            </div>
            <i class="gc gc1"></i><i class="gc gc2"></i><i class="gc gc3"></i>
            <svg class="ck ck1" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="none" stroke="#444" stroke-width="2.2"/><path d="M7.2 12.4l3.2 3.2 6.2-7.4" fill="none" stroke="#444" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <span class="tx tx1"><slot /></span>
            <template v-if="note">
              <i class="dv"></i>
              <svg class="ck ck2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="none" stroke="#444" stroke-width="2.2"/><path d="M7.2 12.4l3.2 3.2 6.2-7.4" fill="none" stroke="#444" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              <span class="tx tx2">{{ note }}</span>
            </template>
            <button class="ef-close" type="button" title="关闭" aria-label="关闭" @click.stop="$emit('close')">
              <svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="50" fill="#fff"/><circle cx="50" cy="50" r="48.4" fill="none" stroke="#d8d8d8" stroke-width=".35" stroke-dasharray="1 .8"/><path d="M75.2,14.9 51.2,38.9 49.5,38.9 26.5,15.9 16.4,25.9 39.2,49.1 39.2,50.9 15.5,74.7 25.4,84.7 49.6,60.8 51.1,60.8 76.6,86.3 86.7,76.2 61.4,50.9 61.4,49.0 85.4,25.0Z M49.5,41.6 51.2,41.6 58.7,49.1 58.7,50.8 51.2,58.4 49.5,58.4 41.9,50.8 41.9,49.1Z" fill="#0c0c0a" fill-rule="evenodd"/></svg>
            </button>
          </section>
          <div class="efd-actions">
            <slot name="footer">
              <button v-if="!hideCancel" class="ef-pill ef-pill--sm ef-pill--float" type="button" @click="$emit('close')">
                <i class="ef-pill__tex"></i><i class="ef-pill__line"></i>
                <span class="ef-pill__label">{{ cancelText }}</span>
                <span class="ef-pill__ico" v-html="ICO_X"></span>
              </button>
              <button class="ef-pill ef-pill--yellow ef-pill--sm ef-pill--float" type="button" :disabled="okDisabled" @click="$emit('ok')">
                <i class="ef-pill__tex"></i><i class="ef-pill__line"></i>
                <span class="ef-pill__label">{{ okText }}</span>
                <span class="ef-pill__ico" v-html="ICO_LOOP"></span>
              </button>
            </slot>
          </div>
        </div>

        <!-- ── 面板框（深标头 + 点阵） ─────────────────────────────── -->
        <div v-else-if="board === 'panel'" class="efd-panel" :class="{ tall }" :style="kStyle">
          <section class="b3">
            <i class="dots"></i>
            <div class="hd">
              <span class="gh">{{ ghost }}</span>
              <h1>{{ title }}</h1>
              <small>{{ code }}</small>
            </div>
            <i class="lbl"></i>
            <!-- 同 banner：内容宿主用 div，不能用 <p> —— 模型选择器那种「搜索条 + 分组 + 一排按钮」
                 全是块级元素，放进 <p> 会被浏览器自动闭合、整块掉出面板的绝对定位坐标系，
                 表现就是「弹窗打开了但列表点不动 / 看不见」。 -->
            <div class="desc"><slot /></div>
          </section>
          <button class="ef-close" type="button" title="关闭" aria-label="关闭" @click.stop="$emit('close')">
            <svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="50" fill="#fff"/><circle cx="50" cy="50" r="48.4" fill="none" stroke="#d8d8d8" stroke-width=".35" stroke-dasharray="1 .8"/><path d="M75.2,14.9 51.2,38.9 49.5,38.9 26.5,15.9 16.4,25.9 39.2,49.1 39.2,50.9 15.5,74.7 25.4,84.7 49.6,60.8 51.1,60.8 76.6,86.3 86.7,76.2 61.4,50.9 61.4,49.0 85.4,25.0Z M49.5,41.6 51.2,41.6 58.7,49.1 58.7,50.8 51.2,58.4 49.5,58.4 41.9,50.8 41.9,49.1Z" fill="#0c0c0a" fill-rule="evenodd"/></svg>
          </button>
          <!-- 动作行留在板外：母本那颗胶囊本来就是压在板底往外凸一截的（他确认过）。
               放在 .b3 里会被 max-height 一起裁掉。
               调用点没给 #footer 时（autoFooter=true）渲染母本那对长条胶囊：
               左「取消」右「确认」，右侧圆盘里分别是叉与循环箭头。 -->
          <div v-if="$slots.footer || autoFooter" class="efd-actions">
            <slot name="footer">
              <button v-if="!hideCancel" class="ef-pill ef-pill--float" type="button" @click="$emit('close')">
                <i class="ef-pill__tex"></i><i class="ef-pill__line"></i>
                <span class="ef-pill__label">{{ cancelText }}</span>
                <span class="ef-pill__ico" v-html="ICO_X"></span>
              </button>
              <button class="ef-pill ef-pill--yellow ef-pill--float" type="button" :disabled="okDisabled" @click="$emit('ok')">
                <i class="ef-pill__tex"></i><i class="ef-pill__line"></i>
                <span class="ef-pill__label">{{ okText }}</span>
                <span class="ef-pill__ico" v-html="ICO_LOOP"></span>
              </button>
            </slot>
          </div>
        </div>

        <!-- ── 表单框（白卡 + 胶囊输入） ───────────────────────────── -->        <div v-else class="efd-form" :style="kStyle">
          <div class="form-group">
            <div class="form-title">{{ title }}</div>
            <slot />
            <div class="efd-actions">
              <slot name="footer">
                <button v-if="!hideCancel" class="ef-pill ef-pill--float" type="button" @click="$emit('close')">
                  <i class="ef-pill__tex"></i><i class="ef-pill__line"></i>
                  <span class="ef-pill__label">{{ cancelText }}</span>
                  <span class="ef-pill__ico" v-html="ICO_X"></span>
                </button>
                <button class="ef-pill ef-pill--yellow ef-pill--float" type="button" :disabled="okDisabled" @click="$emit('ok')">
                  <i class="ef-pill__tex"></i><i class="ef-pill__line"></i>
                  <span class="ef-pill__label">{{ okText }}</span>
                  <span class="ef-pill__ico" v-html="ICO_LOOP"></span>
                </button>
              </slot>
            </div>
          </div>
          <button class="ef-close" type="button" title="关闭" aria-label="关闭" @click.stop="$emit('close')">
            <svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="50" fill="#fff"/><circle cx="50" cy="50" r="48.4" fill="none" stroke="#d8d8d8" stroke-width=".35" stroke-dasharray="1 .8"/><path d="M75.2,14.9 51.2,38.9 49.5,38.9 26.5,15.9 16.4,25.9 39.2,49.1 39.2,50.9 15.5,74.7 25.4,84.7 49.6,60.8 51.1,60.8 76.6,86.3 86.7,76.2 61.4,50.9 61.4,49.0 85.4,25.0Z M49.5,41.6 51.2,41.6 58.7,49.1 58.7,50.8 51.2,58.4 49.5,58.4 41.9,50.8 41.9,49.1Z" fill="#0c0c0a" fill-rule="evenodd"/></svg>
          </button>
        </div>
      </div>
      <!-- 其余六套主题：原来那一套 -->
      <div v-else-if="open" class="k-modal-root" @click.self="$emit('close')">
        <div class="k-modal" :style="{ width: legacyWidth }" role="dialog" :aria-label="title">
          <header class="k-modal-head">
            <h3>{{ title }}</h3>
            <button type="button" class="k-icon-btn" @click="$emit('close')" aria-label="关闭">
              <i class="fas fa-xmark"></i>
            </button>
          </header>
          <div class="k-modal-body"><slot /></div>
          <!-- 调用点给了 #footer 就用它（绝大多数）；没给才用下面这对兜底按钮。
               兜底是为了 ConfirmDialog / PromptDialog 这类全局对话框——它们要照顾终末地
               的母本胶囊，把 footer 交给了 KModal 自己渲染；但另外六套主题下如果不兜，
               footer 就不存在，弹窗会变成「有关闭钮、没有确定/取消」的死盒子。 -->
          <footer v-if="$slots.footer || autoFooter" class="k-modal-foot">
            <slot name="footer">
              <button v-if="!hideCancel" class="k-btn ghost" type="button" @click="$emit('close')">{{ cancelText }}</button>
              <button class="k-btn primary" type="button" :disabled="okDisabled" @click="$emit('ok')">{{ okText }}</button>
            </slot>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
/**
 * 弹窗外壳。终末地主题下渲染母本那四块板；其它主题保持原来的 .k-modal。
 *
 * 缩放：母本外壳上的 --k（默认 .1rem = 设计稿 1px）就是它的等比旋钮。
 * 这里按「面板设计宽 / 该板的设计宽」算出 k 交给外壳，母本的比例关系一个数不改：
 *   banner 1920k · dialog 1206k · panel 1842k · form 1600k
 */
import { computed } from 'vue';
import { themeState } from '../stores/theme';

const props = defineProps({
  open: Boolean,
  title: { type: String, default: '' },
  /** 板上的编号文案（母本写作 "// PROMPT.DIALOG" / "BOX // 03" 那种） */
  code: { type: String, default: '' },
  /** banner（横幅）| dialog（居中，黄标头）| panel（面板，深标头）| form（白卡表单）
      —— 这四个只有终末地认；其余六套主题走 .k-modal，不看 board */
  board: { type: String, default: 'dialog' },
  /** **非终末地主题**的弹窗宽度，必须带单位（默认 480px）。
      终末地不用这个值——它按 ef-width 算母本的等比旋钮 --k，两者语义不同，
      所以绝对不能共用同一个 prop（早前共用过一次，终末地为了拿大板宽把这里填成
      无单位数字 1280，CSS 判为非法值直接丢弃 ⇒ 另外六套主题的弹窗全部撑满屏幕）。 */
  width: { type: [String, Number], default: '480px' },
  /** **终末地专用**的面板设计宽（无单位数字 = 设计稿 px，也可以是 "900px"）。
      不给就沿用 width。例：确认框传 960 让黄标头板够宽，而非终末地那边仍是 420px。 */
  efWidth: { type: [String, Number], default: '' },
  cancelText: { type: String, default: '取消' },
  okText: { type: String, default: '确定' },
  okDisabled: Boolean,
  hideCancel: Boolean,
  /** **非终末地主题**：调用点没给 #footer 时，是否由 KModal 自己渲染「取消 / 确定」。
      全局对话框（ConfirmDialog / PromptDialog）要传 true —— 它们为了终末地的母本胶囊
      把 footer 交给了 KModal，另六套主题下若不兜底就会变成一个没有按钮的死盒子。 */
  autoFooter: Boolean,
  /** 居中框的第二行小字（母本 .tx2：那一行「且无法撤销」） */
  note: { type: String, default: '' },
  /** 面板框深标头上的大字水印（母本 .gh） */
  ghost: { type: String, default: '' },
  /** 面板框 / 居中框：内容比母本那句占位话长时，让板纵向生长、内容区改回文档流
      （宽/圆角/标头/字号/挂锁一个数都不动） */
  tall: Boolean,
});
defineEmits(['close', 'ok']);

const ef = computed(() => themeState.id === 'endfield');

/* 四块板的设计宽（母本原文里的 width:calc(--k*N)） */
const DESIGN_W = { banner: 1920, dialog: 1206, panel: 1842, form: 1600 };
/* 终末地不给 ef-width 时的默认外形宽（panel/form 要窄一点才不像整块画布） */
const DEFAULT_W = { banner: '100vw', dialog: 480, panel: 1120, form: 420 };

/* 终末地的板宽：只认 efWidth，没给才回落 width —— 这样调用点可以同时给出
   「终末地要多大板」和「其余主题要多宽窗」两个互不干扰的值。 */
const px = computed(() => {
  const raw = props.efWidth || props.width || DEFAULT_W[props.board] || 480;
  if (typeof raw === 'number') return raw;
  if (String(raw).endsWith('vw')) return (parseFloat(raw) / 100) * 1280; // vw 走一个稳定的参考宽，实际面板由 max-width 兜
  return parseFloat(raw) || 480;
});
/* 非终末地那条路的宽度：一律补成合法 CSS 值。
   Vue 把数字写进 style 时不会替你加单位，`width:1280` 是非法声明、浏览器直接丢弃，
   .k-modal 的 width:100% 就生效了 —— 表现就是弹窗横贯整屏。这里兜住这种传法。 */
const legacyWidth = computed(() => {
  const w = props.width;
  if (w == null || w === '') return '480px';
  if (typeof w === 'number') return w + 'px';
  const s = String(w).trim();
  return /^\d+(\.\d+)?$/.test(s) ? s + 'px' : s;
});
/* 母本的 --k 是「设计稿 1px」的等比旋钮：板宽、字号、按钮、内距全跟着它走。
   调用点给的 width 若比母本设计宽小太多，k 会掉到 .4 以下 —— 那时胶囊只剩 24 高、文字 9px，
   读不出来（实测 width 480 的居中框 k=.398）。所以给一个下限：宁可比调用点要的宽，
   也不能小到看不清。母本自己的设计宽（k=1）不受影响。 */
const MIN_K = 0.5;
const k = computed(() => Math.max(px.value / (DESIGN_W[props.board] || 1206), MIN_K));
const kStyle = computed(() => ({ '--k': k.value + 'px' }));

/* 母本 body 里那两颗 svg：取消/危险 = 两条 3.6 描边的叉；确认 = 6.7 半径的双弧循环箭 */
const ICO_X = '<svg viewBox="0 0 24 24"><path d="M7.4 7.4l9.2 9.2M16.6 7.4l-9.2 9.2" fill="none" stroke="#454444" stroke-width="3.6" stroke-linecap="round"/></svg>';
const ICO_LOOP = '<svg viewBox="0 0 24 24"><g fill="none" stroke="#ffef01" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 9.6A6.7 6.7 0 0 0 6.5 8.6M6 14.4a6.7 6.7 0 0 0 11.5 1"/><path d="M18.4 5.6v4h-4M5.6 18.4v-4h4"/></g></svg>';
</script>

<style scoped>
.k-modal-root {
  position: fixed;
  inset: 0;
  background: var(--scrim);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 80;
  padding: 24px;
}
/* 终末地的板可能比视口高（母本板是定高定宽的样板），允许整层滚动；
   其余六套主题保持原样（.k-modal 自己有 max-height + body 内滚，不需要它）。 */
.k-modal-root--ef { overflow: auto; }
/* 关闭钮 = 母本 BUTTON/按钮控件陈列.html 的 .ef-icon--exit：
   42u 白圆盘（100×100 SVG：白底圆 + 0.35 描边虚线内圈 + 黑 X 路径 evenodd）。
   hover 压暗到 .88、按下缩到 .94、键盘聚焦一圈 2u 亮黄 —— 母本三态原样。
   位置：绝对定位在各自板的右上角（--k 从板上继承），不是在视口右上角。 */
.ef-close {
  position: absolute;
  top: calc(var(--k) * 20);
  right: calc(var(--k) * 22);
  z-index: 5;
  width: calc(var(--k) * 42);
  height: calc(var(--k) * 42);
  padding: 0;
  margin: 0;
  border: 0;
  border-radius: 50%;
  background: none;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: filter 0.12s linear, transform 0.06s linear;
}
.ef-close svg { display: block; width: 100%; height: 100%; }
.ef-close:hover { filter: brightness(0.88); }
.ef-close:active { transform: scale(0.94); }
.ef-close:focus-visible { outline: calc(var(--k) * 2) solid #ffe500; outline-offset: calc(var(--k) * 2); }
.k-modal {
  background: var(--surface-pop);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  max-height: min(80vh, 720px);
  display: flex;
  flex-direction: column;
  width: 100%;
}
/* 开：底板只淡入，面板本身从下方升起 + 两下衰减的抖动；关：面板快速下落渐隐。
   注意根节点的过渡时长必须 ≥ 面板动画时长：Vue 到点会摘掉 *-active 类，
   类一没，面板那条 animation 就被掐断、直接弹回中间态，看着就是抖到一半卡住。 */
.kpop-enter-active { transition: opacity 0.28s ease; }
.kpop-enter-from { opacity: 0; }
.kpop-leave-active { transition: opacity 0.18s ease; }
.kpop-leave-to { opacity: 0; }
.kpop-enter-active .k-modal,
.kpop-enter-active .efd-banner,
.kpop-enter-active .efd-dialog,
.kpop-enter-active .efd-panel,
.kpop-enter-active .efd-form { animation: kh-pop-in 0.24s cubic-bezier(0.22, 1.08, 0.36, 1); }
.kpop-leave-active .k-modal,
.kpop-leave-active .efd-banner,
.kpop-leave-active .efd-dialog,
.kpop-leave-active .efd-panel,
.kpop-leave-active .efd-form { animation: kh-pop-out 0.16s cubic-bezier(0.4, 0, 0.9, 0.35) forwards; }

/* 设置里关掉「动效」时，所有主题的弹窗都不许动（这条是全局的，不能只在终末地生效） */
html[data-motion='off'] .kpop-enter-active .k-modal,
html[data-motion='off'] .kpop-enter-active .efd-banner,
html[data-motion='off'] .kpop-enter-active .efd-dialog,
html[data-motion='off'] .kpop-enter-active .efd-panel,
html[data-motion='off'] .kpop-enter-active .efd-form,
html[data-motion='off'] .kpop-leave-active .k-modal,
html[data-motion='off'] .kpop-leave-active .efd-banner,
html[data-motion='off'] .kpop-leave-active .efd-dialog,
html[data-motion='off'] .kpop-leave-active .efd-panel,
html[data-motion='off'] .kpop-leave-active .efd-form { animation: none; }

.k-modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-soft);
}
.k-modal-head h3 { margin: 0; font-size: 14px; font-weight: 600; }
.k-modal-body { padding: 16px; overflow: auto; }
.k-modal-foot {
  padding: 12px 16px;
  border-top: 1px solid var(--border-soft);
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.k-icon-btn {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-xs);
  color: var(--text-2);
}
.k-icon-btn:hover { background: var(--bg-hover); }
</style>
