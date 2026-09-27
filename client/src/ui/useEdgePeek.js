/**
 * 收起态下「鼠标贴边 → 临时探出来」的共用逻辑（左栏与右栏同一份，只是方向相反）。
 *
 * 为什么要专门留一条死区：把手是贴在栏边上的那颗圆钮。如果「贴边就弹」，鼠标正往把手
 * 上赶的途中栏会突然弹开、把手跟着挪走，反而点不到它 —— 用户会觉得收起之后打不开了。
 * 所以把手所在位置、以及它向下延伸 8 倍把手高度的那一整条通道里一律不弹，把这条路让给点击。
 * 想临时展开，就从这条通道的下方（或上方）贴边进来。
 *
 * 死区**只管开门，不管关门**：一旦已经探出来了，就只有鼠标离开整块栏才收回去。
 * 否则鼠标在探出的栏里往上挪去点把手，半路撞进那条通道又会把栏收掉，永远点不着。
 *
 * 两个刻意的设计：
 * 1) 判定用的边是**栏自己的外沿**，不是屏幕边 —— 右栏右边还压着浏览器栏/远端文件栏，
 *    按屏幕边判会判到别人身上。
 * 2) 死区按「收起状态下」的把手位置算一次记下来：临时展开时把手已经跟着栏挪走了，
 *    拿实时位置算会算出另一个矩形，正好漏掉要保护的那条路。
 */
import { nextTick, onUnmounted, ref, watch } from 'vue';

const EDGE_PX = 12;      // 距栏体外沿多少像素算「贴边」
const PAD = 6;           // 死区四周多让一点，别贴着像素边界判
const DEAD_BELOW = 8;    // 死区向下延伸 = 把手高度的 8 倍

/**
 * @param collapsed  ref：栏是不是被收起来了
 * @param side       'left' | 'right'
 * @param hostEl     栏本体（aside）的 ref，用来取「自己的外沿」
 * @param toggleEl   把手的 ref
 * @param widthOf    展开态占多宽（判断「指针已经离开探出来的栏体」）
 * @returns { peek }  ref：true = 临时展开中，调用方把它并进显示状态里
 */
export function useEdgePeek({ collapsed, side, hostEl, toggleEl, widthOf }) {
  const peek = ref(false);
  const dead = ref(null);

  function snapDead() {
    const t = toggleEl.value && toggleEl.value.getBoundingClientRect();
    if (!t || !t.height) { dead.value = null; return; }
    dead.value = side === 'left'
      ? { x0: 0, x1: t.right + PAD, y0: t.top - PAD, y1: t.top + t.height * DEAD_BELOW }
      : { x0: t.left - PAD, x1: window.innerWidth, y0: t.top - PAD, y1: t.top + t.height * DEAD_BELOW };
  }

  function inDead(x, y) {
    const d = dead.value;
    return !!d && x >= d.x0 && x <= d.x1 && y >= d.y0 && y <= d.y1;
  }

  function onMove(e) {
    if (!collapsed.value) { if (peek.value) peek.value = false; return; }
    const x = e.clientX;
    const y = e.clientY;
    const host = hostEl.value && hostEl.value.getBoundingClientRect();
    if (!host || !host.width) return;
    if (peek.value) {
      // 已经探出来了：只有整块栏都出去了才收回去。
      // 死区只管「开门」这一件事 —— 不然鼠标在探出的栏里往上挪去点把手，
      // 半路撞上那条 8 倍高的通道就把栏收了，等于永远点不着。
      const w = (widthOf && widthOf()) || 260;
      const outside = side === 'left' ? x > host.left + w + PAD : x < host.right - w - PAD;
      if (outside) peek.value = false;
      return;
    }
    if (inDead(x, y)) return;   // 收起态：去点把手的那条通道不算贴边
    const edge = side === 'left' ? host.left : host.right;
    if (Math.abs(x - edge) <= EDGE_PX) peek.value = true;
  }

  function onWinResize() { if (collapsed.value && !peek.value) snapDead(); }

  let listening = false;
  function bind(on) {
    if (on === listening) return;
    listening = on;
    if (on) {
      window.addEventListener('mousemove', onMove, { passive: true });
      window.addEventListener('resize', onWinResize);
    } else {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('resize', onWinResize);
    }
  }

  // 只在收起时挂监听：展开态这条逻辑一点用都没有，别白跑 mousemove
  watch(collapsed, (v) => {
    peek.value = false;
    if (v) nextTick(snapDead);
    bind(v);
  }, { immediate: true });
  watch(peek, (v) => { if (!v) nextTick(snapDead); });
  onUnmounted(() => bind(false));

  return { peek };
}
