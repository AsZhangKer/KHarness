import { createRouter, createWebHistory } from 'vue-router';

// KHarness 四页：控制页 / 聊天（默认）/ 模型列表 / 管理模型
const routes = [
  {
    path: '/',
    name: 'Chat',
    component: () => import('../views/ChatPage.vue')
  },
  {
    path: '/models',
    name: 'Models',
    component: () => import('../views/ModelsPage.vue')
  },
  {
    path: '/admin-models',
    name: 'AdminModels',
    component: () => import('../views/AdminModelsPage.vue')
  },
  {
    path: '/control',
    name: 'Control',
    component: () => import('../views/ControlPage.vue')
  },
  {
    path: '/usage',
    name: 'Usage',
    component: () => import('../views/UsagePage.vue')
  },
  {
    path: '/trace',
    name: 'Trace',
    component: () => import('../views/TracePage.vue')
  },
  {
    path: '/settings',
    name: 'Settings',
    component: () => import('../views/SettingsPage.vue')
  },
  { path: '/:pathMatch(.*)*', redirect: '/' }
];

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior(to, from, savedPosition) {
    if (savedPosition) {
      return savedPosition;
    }
    return { top: 0 };
  }
});

export default router;
