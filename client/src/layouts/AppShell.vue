<template>
  <div class="app-shell" :class="{ 'shell-chat': isChat }">
    <nav v-if="!isChat" ref="navEl" class="shell-nav">
      <!-- 跟着选中项滑的高亮胶囊：和设置页标签页同一套动效 -->
      <span class="nav-pill" :style="navPillStyle"></span>
      <div class="brand">
        <img src="/icon.png" alt="" />
        <span>KHarness</span>
      </div>
      <!-- 二级页（模型/控制台/用量/设置）左上角统一是「返回」，点了回主页聊天；
           只有聊天页自己不显示（那里本来就没有「回去」的地方） -->
      <div v-if="backLabel" class="group">
        <div class="group-label">{{ backLabel.group }}</div>
        <button class="nav-link back" type="button" title="返回主页（聊天）" @click="goBack">
          <i class="fas fa-arrow-left"></i>
          <span>{{ backLabel.text }}</span>
        </button>
      </div>
      <div v-for="g in shownGroups" :key="g.label" class="group">
        <div class="group-label">{{ g.label }}</div>
        <router-link
          v-for="item in g.items"
          :key="item.to"
          class="nav-link"
          :class="{ active: isActive(item) }"
          :to="item.to"
        >
          <i :class="item.icon"></i>
          <span>{{ item.label }}</span>
        </router-link>
      </div>
    </nav>
    <main class="shell-main">
      <!-- 换页只给「新页面入场」的 CSS 动画。
           别改回 <Transition mode="out-in">：路由页是组件 vnode，实测它的离开钩子根本不触发，
           isLeaving 一旦置位就再也清不掉，Transition 从此永远渲染占位注释 —— 从聊天页进设置会整块白屏。 -->
      <router-view v-slot="{ Component }">
        <!-- key 只能用 route.name，不能带 path：/chat/6 → /chat/7 是同一个 name，
             带 path 会让整棵 ChatPage 在每次切会话时销毁重建（实测一个 333ms 的长任务，
             就是他说的「莫名的卡顿」）。ChatPage 自己 watch route.params.id，复用实例没问题。 -->
        <div :key="route.name || route.path" class="page-anim">
          <component :is="Component" />
        </div>
      </router-view>
    </main>
  </div>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useSlidingPill } from '../ui/useSlidingPill';

const route = useRoute();
const router = useRouter();
const isChat = computed(() => route.path.startsWith('/chat'));

/* 左导航的滑动高亮：换路由、以及「返回」那一格出现/消失（进/出设置页）之后都要重量一次。
   注意要解构出来用：模板只会自动拆「顶层」的 ref，navPill.style 这种嵌套写法会把 Ref 对象本身
   当样式绑上去，结果一个像素都不动。 */
const navEl = ref(null);
const { style: navPillStyle, measure: measureNavPill } = useSlidingPill(
  () => navEl.value,
  () => navEl.value?.querySelector('.nav-link.active') || null
);
watch(
  () => route.fullPath,
  () => nextTick(() => measureNavPill())
);

const groups = [
  {
    label: '工作台',
    items: [{ to: '/chat', label: '聊天', icon: 'fas fa-comments' }],
  },
  {
    label: '模型',
    items: [
      { to: '/models/manage', label: '模型', icon: 'fas fa-cubes' },
    ],
  },
  {
    label: '运行',
    items: [
      { to: '/control', label: '控制台', icon: 'fas fa-gauge' },
      { to: '/usage', label: '用量', icon: 'fas fa-chart-column' },
      // 轨迹页保留在路由里（/trace 直连还能看），但导航不再占一格：
      // 步骤明细已经内联在每条回复里，独立一页没什么人进去
    ],
  },
  {
    label: '系统',
    items: [{ to: '/settings', label: '设置', icon: 'fas fa-gear' }],
  },
];

function isActive(item) {
  if (item.to === '/models') return route.path === '/models';
  return route.path.startsWith(item.to);
}

/**
 * 二级页导航：首格一律换成「返回」，点了直接回主页（聊天）。
 * 之前只在设置页这么做、而且用 history.back()，结果从模型页进设置再点返回会退回模型页 ——
 * 他要的是「回主页」。history.back() 还有个毛病：来路是外部直接打开 /settings 时它是空的。
 */
const inSecondary = computed(() => !isChat.value);
const shownGroups = computed(() => (inSecondary.value ? groups.filter((g) => g.label !== '工作台') : groups));
const backLabel = computed(() => (inSecondary.value ? { group: '工作台', text: '返回' } : null));

function goBack() {
  if (isChat.value) return;
  router.push('/chat');
}
</script>

<style scoped>
.app-shell {
  display: flex;
  height: 100%;
  min-height: 0;
}
.shell-chat {
  display: block;
}
.shell-nav {
  position: relative; /* 高亮胶囊的定位基准 */
  width: 220px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  background: var(--bg);
  padding: 14px 10px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
/* 选中项背后那块跟着滑的胶囊（和 KTabs 的高亮框同一套手感：过冲 + 200ms 内收住） */
.nav-pill {
  position: absolute;
  left: 10px;
  right: 10px;
  top: 0;
  z-index: 0;
  border-radius: var(--radius-sm);
  background: var(--bg-active);
  box-shadow: inset 0 0 0 1px var(--border);
  pointer-events: none;
  transition: transform 0.2s cubic-bezier(0.34, 1.32, 0.64, 1), height 0.2s var(--ease, ease),
    opacity 0.15s ease;
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 10px;
  font-weight: 650;
  letter-spacing: 0.02em;
}
.brand img { width: 22px; height: 22px; border-radius: 6px; }
.group-label {
  font-size: 11px;
  color: var(--text-3);
  padding: 4px 10px 6px;
}
.nav-link {
  position: relative; /* 压在高亮胶囊上面（胶囊 z-index:0），文字不会被它盖住 */
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  color: var(--text-2);
}
.nav-link:hover { background: var(--bg-hover); color: var(--text); }
/* 「返回」和别的导航项同形，只是图标朝左、按下时有回弹感 */
.nav-link.back { border: 0; text-align: left; font: inherit; cursor: pointer; width: 100%; }
.nav-link.back:active i { transform: translateX(-3px); }
.nav-link.back i { transition: transform 0.16s var(--ease, ease); }

/* 二级页入场：一点点横向位移 + 淡入，200ms 内收干净；离场不做动画，新页面盖上去就是 */
.page-anim { animation: page-in 0.2s var(--ease, ease); }
@keyframes page-in {
  from { opacity: 0; transform: translateX(12px); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .page-anim { animation: none; }
}
.nav-link.active {
  /* 底色交给滑动的胶囊，这里只改文字色，否则选中态会有两块背景 */
  color: var(--text);
}
.group, .brand { position: relative; z-index: 1; }
.nav-link i { width: 16px; text-align: center; }
.shell-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
}
</style>
