import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

/**
 * 一排 flex 子项「实际需要多宽」：直接把子项宽度加起来。
 * 为什么不用 el.scrollWidth：overflow:visible 的容器里，scrollWidth 在 Chrome 下
 * 不保证把溢出到盒子外面的子项算进来（实测会漏报，于是明明挤了却判定成放得下）。
 */
export function rowNeed(el, gap = 8) {
  const kids = Array.from(el.children).filter((c) => getComputedStyle(c).display !== 'none');
  if (!kids.length) return el.scrollWidth;
  return kids.reduce((s, c) => s + c.offsetWidth, 0) + Math.max(0, kids.length - 1) * gap;
}

/**
 * 「按容器实测决定要不要把文字收掉只留图标」——一个很小的复用件。
 *
 * 为什么不用 @media 断点：同一排按钮在不同会话下需要的宽度不一样（模型名长短、有没有
 * 分支按钮、标题多长），断点只能瞎猜，要么提前收起该收的文字，要么挤到换行/溢出。
 *
 * 为什么要「冻一次测量值 + 滞回」：收掉文字之后这一排自然就宽裕了，如果当场重量，
 * 就会「展开→溢出→收起→宽裕→又展开」来回抖。所以 needed 只在未降级状态下刷新，
 * 想恢复展开必须宽出 recover 这么多，恢复后再 nextTick 重量一次。
 *
 * need 默认量「容器自己的 scrollWidth」（适合子项不许缩的一整行）；
 * 如果这一排里有个会自己缩的兄弟（比如顶栏的标题），就传自定义 need 把真实需求算出来。
 */
export function useBarOverflow(barRef, opts = {}) {
  const { margin = 2, recover = 48, need = null } = opts;
  const compact = ref(false);
  let needed = 0;
  let ro = null;
  let settleTimer = null;

  const widthNeeded = (el) => (need ? need(el) : el.scrollWidth);

  function measure() {
    const el = barRef.value;
    if (!el) return;
    // clientWidth 是「内容 + 内边距」，不减掉 padding 就会把可用宽度报大，
    // 于是明明挤了却判定成放得下。第三十三轮自绘顶栏给顶栏右侧留了 144px 窗口键的位置，
    // 这 144px 是不能摆按钮的，必须扣掉 —— 扣之前那排按钮会一路溢到窗口角上，被三颗键盖住。
    const cs = getComputedStyle(el);
    const avail = el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    if (!avail) return;                       // 折叠/未挂载时 clientWidth=0，别乱判
    if (ro) for (const c of el.children) ro.observe(c);   // 子项自己变宽（比如多出 tok/s 文本）也要重量一次
    const before = compact.value;
    if (!compact.value) {
      needed = widthNeeded(el);
      if (needed > avail + margin) compact.value = true;
    } else if (needed <= avail - recover) {
      compact.value = false;
      needed = 0;
    }
    // 每次改状态后一定再量一遍：降级会改变这一排需要的宽度，
    // 而「尺寸变了」不一定真的触发 ResizeObserver（曾经就这么卡在错误状态下）
    if (before !== compact.value) settle();
  }

  function settle() {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => { settleTimer = null; measure(); }, 120);
  }

  /** 内容变了（换模型、切会话、分支名长度变化）之后叫一声，重新评估 */
  function remeasure() { nextTick(measure); }

  onMounted(() => {
    if (typeof ResizeObserver !== 'undefined' && barRef.value) {
      ro = new ResizeObserver(measure);
      ro.observe(barRef.value);
      for (const c of barRef.value.children) ro.observe(c);
    }
    window.addEventListener('resize', measure);
    measure();
    settle();                                 // 栏宽、字体、主题都是挂载后才定型的，稍后再量一次
  });
  onBeforeUnmount(() => {
    if (ro) ro.disconnect();
    if (settleTimer) clearTimeout(settleTimer);
    window.removeEventListener('resize', measure);
  });

  return { compact, remeasure };
}
