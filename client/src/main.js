import { createApp } from 'vue';
import App from './App.vue';
import router from './router';
import './styles/tokens.css';
import './styles/themes.css';
import './styles/framebar.css';
import './styles/endfield.css';   // 终末地（第八套）：令牌与形状层，只在 [data-theme='endfield'] 下生效
import './styles/endfield-parts.css';   // 件表（旧）：只剩左栏树与状态条两段，它们的母本还没切进来
import './styles/endfield-masters.css';   // 母本原文：由 design/endfield/ef_port.js 按行号从母本目录切出来，禁止手打
import './styles/endfield-dialogs.css';   // 弹窗四份母本的 CSS 逐字搬入（外壳 --k 等比缩放）
import './styles/endfield-overrides.css'; // 覆盖层：必须最后一份（同特异度时后加载者赢，见文件头注释）
import './stores/theme'; // 副作用：把上次选的主题写到 <html data-theme>
import './stores/motion'; // 副作用：把「界面动效」开关写到 <html data-motion>（降级不再由系统自动决定）
import { installErrLog } from './utils/errlog';
import { bootMark } from './utils/boot';
import { installImeSelfHeal } from './utils/ime';
import { debugLog } from './stores/debuglog';

/* 开屏板的第一个真报点：跑到这一行 = 前端 bundle 真的到位了。
   板子本体在内联的 index.html 里（要赶在 ChatPage 那个 549KB chunk 之前画出来），
   这里只是把「做到哪了」回报给它，见 client/index.html 的 MILESTONES。 */
bootMark('module');

// 主进程去掉了系统标题栏（desktop/main.js 里 FRAMELESS）才挂这个类，
// styles/framebar.css 整套「拖拽把手 + 页头给三颗窗口键让位」的规则都以它为开关；浏览器里访问时不存在。
if (window.khDesktop && window.khDesktop.frameless) document.documentElement.classList.add('kh-frame');

// 第一件事就装报错台账：启动阶段的未捕获异常与 console.error 也要能进「点击复制」的报告里
installErrLog();

/* 输入法合成卡死的兜底自愈（详见 utils/ime.js 末尾那一段）。
   装在这么早的位置，是因为卡死的框恰恰是「已经打不进字」的那个，越早兜住越好。
   自愈本身与版本无关（正式版照样跑），只有「记一行证据」是开发版专属 ——
   正式版没有调试通道，写进去也没人看得见。 */
installImeSelfHeal({
  onHeal: (text, level) => {
    if (debugLog.state.dev) debugLog.pushLocal('ime', text, level);
  },
});

const app = createApp(App);
// 浏览器独立窗口（?kh=browser）不参与路由：装了 router 会照着当前路径去懒加载整页聊天界面，
// 那一扇窗只要浏览器栏，多拉的那些 chunk 还会跟它抢浏览器视图的动作队列
if (!new URLSearchParams(window.location.search).has('kh')) app.use(router);
app.mount('#app');
bootMark('app');
/* 首屏挂完了。剩下两格由别处报：设置读回见 stores/prefs.js，首个路由落地在这里。
   第四格必须认路由而不是「会话树到手」：启动停在设置页 / 浏览器页 / 任意非聊天路由时
   ChatPage 根本不会挂载，refreshTree 也就永远不会跑，那种启动就只能干等 5 秒的 fuse 收尾。
   isReady() 在初始导航解析完（也就是那一页的懒加载 chunk 真到了）才 resolve，正是这一格要的量。 */
router.isReady()
  .then(() => bootMark('route'))
  .catch(() => { /* 导航失败由路由自己报错，板子这一格交给 fuse */ });
