import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
// @vitejs/plugin-vue 只装在 client/ 下（它是前端的构建依赖），根配置按裸包名 import 不到，
// 只能顺路径取一次。少了它，测 .vue 组件会直接报 "Install @vitejs/plugin-vue"；
// 而只测 utils 的用例照样全绿 —— 这正是假绿的形状。
import vue from './client/node_modules/@vitejs/plugin-vue/dist/index.mjs';

/**
 * 两个 project：server 侧纯 node（不想要 DOM 的负担），client 侧要 jsdom
 * —— dompurify 在没有 window 的环境里根本没法跑，用 node 跑只会测出一个假绿。
 *
 * 只收 __tests__ 目录：_tmp_ssh / _tmp_kh53 下那些探针是「起真服务打真接口」的端到端脚本，
 * 不进这条命令（它们要端口和隔离数据目录），但一个新案例一个文件，能直接搬进来。
 */
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'server', environment: 'node', include: ['server/__tests__/**/*.test.js'] } },
      {
        root: 'client',
        plugins: [vue()],
        // 组件模板里的绝对资源（<img src="/icon.png">）在这里会被当成模块去 fs 读，
        // root 挪到 client/ 之后它拼出的是 file:///icon.png —— 直接炸。指到 public 里那份真文件。
        resolve: {
          alias: [{ find: /^\/icon\.png$/, replacement: fileURLToPath(new URL('./client/public/icon.png', import.meta.url)) }],
        },
        test: {
          name: 'client',
          environment: 'jsdom',
          include: ['__tests__/**/*.test.js'],
        },
      },
    ],
  },
});
