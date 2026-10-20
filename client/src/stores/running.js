import { reactive } from 'vue';

/**
 * 「现在有没有活儿在跑」的一份小账，只为一件事服务：关窗口之前问一句人。
 *
 * 为什么单开一个文件而不让顶栏直接 import chatStore：WindowBar 是外壳级的组件，
 * 拖进整个聊天模块（含 SSE、右栏各面板、托管监工）就等于把首屏包变大。
 * 数字由 chatStore 那边一处写入（见 chatStore 里那个 watch），这里只读不维护规则，
 * 所以不会出现「两处各自数一遍然后对不上」。
 */
export const running = reactive({ count: 0 });

/** 还在回答中的会话数（0 = 全都空闲） */
export function runningCount() { return running.count; }
