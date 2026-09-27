import { createApp } from 'vue';
import App from './App.vue';
import router from './router';
import './styles/tokens.css';
import './styles/themes.css';
import './styles/framebar.css';
import './stores/theme'; // 副作用：把上次选的主题写到 <html data-theme>
import { installErrLog } from './utils/errlog';

// 主进程去掉了系统标题栏（desktop/main.js 里 FRAMELESS）才挂这个类，
// styles/framebar.css 整套「拖拽把手 + 页头给三颗窗口键让位」的规则都以它为开关；浏览器里访问时不存在。
if (window.khDesktop && window.khDesktop.frameless) document.documentElement.classList.add('kh-frame');

// 第一件事就装报错台账：启动阶段的未捕获异常与 console.error 也要能进「点击复制」的报告里
installErrLog();

createApp(App).use(router).mount('#app');
