/**
 * 「跟着选中项滑动的胶囊」——把设置页标签页（KTabs）那套高亮动效搬到侧栏列表上。
 *
 * 用法：容器要 position: relative，胶囊是容器的第一个子节点，本函数只驱动它的
 * translateY / height / opacity；横向宽度交给各组件自己的 CSS（left/right 跟容器内边距对齐）。
 *
 * 为什么量 rect 而不是 offsetTop：列表在滚动容器里时 offsetTop 不含 scrollTop，
 * 滚一下高亮就飘了；rect 差值再补上 scrollTop 与边框宽度，滚动、折叠、换主题都不会错位。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

/**
 * @param getContainer 返回胶囊要贴的那个容器（position:relative）
 * @param getActive    返回当前选中项元素；返回 null 时胶囊淡出
 */
export function useSlidingPill(getContainer, getActive) {
  const style = ref({ opacity: 0, transform: 'translateY(0px)', height: '0px' });

  function measure() {
    const c = getContainer();
    const a = getActive();
    if (!c || !a || !a.offsetParent) {
      // 没有选中项（或列表被收起来了）：只把透明度收掉，位置留着，下次出现不至于从 0 弹过来
      style.value = { ...style.value, opacity: 0 };
      return;
    }
    const cr = c.getBoundingClientRect();
    const ar = a.getBoundingClientRect();
    const y = ar.top - cr.top + (c.scrollTop || 0) - (c.clientTop || 0);
    style.value = {
      transform: `translateY(${Math.round(y)}px)`,
      height: `${Math.round(ar.height)}px`,
      opacity: 1,
    };
  }

  let ro = null;
  function onResize() { measure(); }

  onMounted(() => {
    measure();
    window.addEventListener('resize', onResize);
    const c = getContainer();
    if (c && typeof ResizeObserver !== 'undefined') {
      // 列表项增删、图片字体加载完导致行高变化，都靠这个补一次测量
      ro = new ResizeObserver(() => measure());
      ro.observe(c);
    }
  });
  onBeforeUnmount(() => {
    window.removeEventListener('resize', onResize);
    if (ro) ro.disconnect();
  });

  return { style, measure, remeasure: () => nextTick(measure) };
}
