import { createApp } from 'vue';
import App from './App.vue';
import router from './router';
import './styles/main.css';
import { loadAppFont } from './utils/appFont';

// 恢复用户选择的全局字体（写入 --app-font CSS 变量）
loadAppFont();

const app = createApp(App);

// v-reveal 进场动画指令：元素进入视口时添加 reveal-visible（支持 v-reveal="延迟毫秒"）
if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches && 'IntersectionObserver' in window) {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('reveal-visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -30px 0px' });

  app.directive('reveal', {
    mounted(el, binding) {
      el.classList.add('reveal');
      if (binding.value) el.style.transitionDelay = `${binding.value}ms`;
      observer.observe(el);
    },
    unmounted(el) {
      observer.unobserve(el);
    }
  });
} else {
  app.directive('reveal', {});
}

app.use(router);
app.mount('#app');
