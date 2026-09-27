import { createRouter, createWebHistory } from 'vue-router';

const routes = [
  { path: '/', redirect: '/chat' },
  {
    path: '/chat/:id?',
    name: 'Chat',
    component: () => import('../features/chat/ChatPage.vue'),
  },
  {
    path: '/models',
    name: 'Models',
    component: () => import('../features/models/ManageModelsPage.vue'),
  },
  {
    path: '/models/manage',
    name: 'ManageModels',
    component: () => import('../features/models/ManageModelsPage.vue'),
  },
  { path: '/admin-models', redirect: '/models/manage' },
  {
    path: '/control',
    name: 'Control',
    component: () => import('../features/control/ControlPage.vue'),
  },
  {
    path: '/usage',
    name: 'Usage',
    component: () => import('../features/usage/UsagePage.vue'),
  },
  {
    path: '/trace',
    name: 'Trace',
    component: () => import('../features/trace/TracePage.vue'),
  },
  {
    path: '/settings',
    name: 'Settings',
    component: () => import('../features/settings/SettingsPage.vue'),
  },
  { path: '/:pathMatch(.*)*', redirect: '/chat' },
];

export default createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});
