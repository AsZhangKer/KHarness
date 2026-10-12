/**
 * 窗口首显示前的「别落到所有屏幕之外」保险。
 *
 * 位置我们从不指定（只给宽高），是 Windows 按这扇窗上次的落点级联出来的；拔过屏、换过分辨率之后
 * 那个记忆落点可能整扇在每块屏之外 —— 那时抓不住、看不见，也没有任何报错。
 * 规则保守：只要还露得住够点的一条边就不动（他左边那块屏的 workArea 是 -1600,293 1600x900，
 * 负坐标完全正常），哪儿都不露才拉回最近那块屏。
 *
 * 顺手记一句免得后人误判：第七十七轮那次「打开是黑屏」不是这回事，也不是渲染被冻结，
 * 是我跑 `npm run sync:dev` 中途 EBUSY 失败，把包里的 `resources.pak` / `chrome_*.pak` /
 * `snapshot_blob.bin` / `locales/` 删掉了一半没补回来 —— 见 HANDOVER 的调试约定。
 */

const MIN_VISIBLE_X = 120;   // 横向至少要露出这么多像素才算「看得见、抓得住」
const MIN_VISIBLE_Y = 40;    // 纵向至少露出顶边一条

function norm(b) {
  return {
    x: Number(b && b.x) || 0,
    y: Number(b && b.y) || 0,
    width: Math.max(1, Number(b && b.width) || 1),
    height: Math.max(1, Number(b && b.height) || 1),
  };
}

function seg(a0, a1, b0, b1) { return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)); }

/** 工作区列表：既收 screen.getAllDisplays() 的 {workArea}，也收纯 {x,y,width,height}（测试用后者） */
function areas(displays) {
  return (displays || []).map((d) => (d && d.workArea ? d.workArea : d)).filter((w) => w && Number.isFinite(Number(w.width)));
}

/**
 * @returns 需要挪动时返回新 bounds（宽高可能被压到不超过工作区），不需要挪就返回 null
 */
function placeBounds(bounds, displays) {
  const b = norm(bounds);
  const list = areas(displays);
  if (!list.length) return null;
  const needX = Math.min(MIN_VISIBLE_X, b.width);
  const needY = Math.min(MIN_VISIBLE_Y, b.height);
  const visible = (w) => seg(b.x, b.x + b.width, w.x, w.x + w.width) >= needX
    && seg(b.y, b.y + b.height, w.y, w.y + w.height) >= needY;
  if (list.some(visible)) return null;

  // 落点在哪块屏附近就还给哪块（横跨不上就主屏优先，getAllDisplays 的第一条就是主屏）
  const home = list.find((w) => b.x + b.width / 2 >= w.x && b.x + b.width / 2 < w.x + w.width) || list[0];
  const width = Math.min(b.width, home.width);
  const height = Math.min(b.height, home.height);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
  return {
    width,
    height,
    x: clamp(b.x, home.x, home.x + home.width - width),
    y: clamp(b.y, home.y, home.y + home.height - height),
  };
}

module.exports = { placeBounds, MIN_VISIBLE_X, MIN_VISIBLE_Y };
