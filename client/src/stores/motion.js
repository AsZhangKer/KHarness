/**
 * 界面动效开关（第八十一轮）。
 *
 * 以前「有没有动效」完全交给系统的 prefers-reduced-motion —— 结果 Linux 桌面（Arch 常见：合成器/桌面把动画关了）
 * 一命中就把全站 16 处过渡与动画一起抹掉，用户看到的是「动画全没了」，且没有任何地方能关回来。
 * 现在只认设置-外观这一颗开关：默认开，桌面那套不再自动降级；关掉就是显式关掉。
 *
 * 落地方式：把值写到 <html data-motion="on|off">，CSS 侧原来的
 *   @media (prefers-reduced-motion: reduce) { 选择器 {…} }
 * 全部换成
 *   html[data-motion='off'] 选择器 {…}
 * 声明体一个字没动，改的只是「谁来触发降级」。
 */
import { reactive } from 'vue';

const KEY = 'kh.motion';

function readStored() {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export const motionState = reactive({ on: readStored() !== 'off' });

/** 把开关写到 <html>，CSS 与两处 JS（星空、回到底部）都读这一个属性 */
export function applyMotion() {
  document.documentElement.dataset.motion = motionState.on ? 'on' : 'off';
}

/** 返回落盘读回比对结果：没写上就别说开关拨过去了 */
export function setMotion(on) {
  motionState.on = !!on;
  try {
    localStorage.setItem(KEY, motionState.on ? 'on' : 'off');
  } catch {
    /* 隐私模式下写不进去，本次启动照旧生效 */
  }
  applyMotion();
  return readStored() === (motionState.on ? 'on' : 'off');
}

applyMotion();
