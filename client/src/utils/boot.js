/* 开屏板的报点桥。
 *
 * 板子本体（DOM / 样式 / 时钟 / 保险栓）内联在 client/index.html 里，因为只有在那里它才能
 * 赶在 549KB 的 ChatPage chunk 到齐之前画出来 —— 写成 Vue 组件就等于「bundle 到位才开始播」，
 * 最该盖的那段空档反而漏掉了。这里只留一个守卫过的入口给应用侧调用。
 *
 * 三条硬约定：
 *  1. 报点失败绝不能拖累启动。板子是一层视觉，它自己出任何问题都该被吞掉，
 *     所以每个出口都包 try/catch，且 window.__khBoot 在板子已销毁后是 null。
 *  2. 里程碑名两边要一致：板子里那张表在 index.html 的 MILESTONES，
 *     这里是 MILESTONE 常量。对不上时报点静默无效（进度会停在时间线的 90% 等 fuse 收尾），
 *     所以改名要同时改两处 —— 这条就是 client/__tests__/boot-plate-round79.test.js 里那条字符串断言在盯的东西。
 *  3. 开关的真相在服务端 settings（boot_plate），由服务端在发出 index.html 时注入，
 *     不走 uiPrefs.load()：异步读回来时首帧已经过去了（见 server/index.js 的注释）。
 */

export const MILESTONE = {
  module: 'module',   // main.js 跑到了（前端 bundle 到位）
  app: 'app',         // 首屏 mounted 完成
  prefs: 'prefs',     // uiPrefs 从服务端读回
  route: 'route'      // 首个路由落地（那一页的懒加载块到手了）
};

/** 报一个里程碑。板子不在（关了 / 已经播完 / 独立浏览器窗）就是空操作。 */
export function bootMark(id) {
  try {
    const b = window.__khBoot;
    if (b && typeof b.mark === 'function') b.mark(id);
  } catch (e) {
    // 视觉层出错不能把启动带崩，也不能冒红条
  }
}

/**
 * 设置页那颗「预览」：整窗重载一次。
 * 不做「原地重播」是因为板子内的状态（时钟句柄、里程碑表、淡出到哪一帧）全在闭包里，
 * 原地重启很容易留下半截状态；而重载本身就是这个动画要模拟的东西，最诚实。
 */
export function bootReplay() {
  location.reload();
}
