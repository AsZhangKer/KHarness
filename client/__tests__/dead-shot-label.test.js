/**
 * ⑤ 已被清理的截图要老实说「图片已被清理」（本轮他点名的措辞）。
 *
 * 图是服务端内存里的 30 分钟 token：重启或超时之后 <img> 拿 404。
 * 以前留一个破图图标 + 「截图」两个字，看着像「AI 截了张打不开的图」；
 * 现在换成一句人话，并且那块区域不再是可点/可双击的按钮（点它没意义）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import ChatMessage from '../src/features/chat/ChatMessage.vue';

let hosts = [];
afterEach(() => { for (const x of hosts.splice(0)) x.host.remove(); });

function mountStep(step) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp({
    render: () => h(ChatMessage, {
      role: 'assistant', busy: false, content: '', reasoning: '',
      steps: [step], timeline: null, usage: null, model_name: '', msgId: 1, index: 0,
    }),
  });
  app.mount(host);
  hosts.push({ host, app });
  return host;
}

describe('过期截图的显示口径', () => {
  it('图片加载失败后：只剩「图片已被清理」，没有破图图标、也不再是可点按钮', async () => {
    const host = mountStep({ type: 'result', name: 'screen_capture', output: '已截取全屏', image_token: 'tok-dead' });
    await nextTick();
    const img = host.querySelector('.step-shot img');
    expect(img).toBeTruthy();
    img.dispatchEvent(new Event('error'));
    await nextTick();

    const shot = host.querySelector('.step-shot');
    expect(shot.querySelector('img')).toBe(null);
    expect(shot.querySelector('.shot-dead').textContent.trim()).toBe('图片已被清理');
    expect(shot.querySelector('i')).toBe(null);                 // 不再摆一个占位图标
    expect(shot.getAttribute('role')).not.toBe('button');       // 死图不给点，免得以为能放大
    expect(shot.getAttribute('title')).toBeFalsy();
  });

  it('图还在的时候仍然是可双击查看的（别把好的那条路一起改掉）', async () => {
    const host = mountStep({ type: 'result', name: 'screen_capture', output: '已截取全屏', image_token: 'tok-alive' });
    await nextTick();
    const shot = host.querySelector('.step-shot');
    expect(shot.getAttribute('role')).toBe('button');
    expect(shot.getAttribute('title')).toContain('双击');
    expect(shot.querySelector('img').getAttribute('src')).toContain('/api/ai/chat/image/tok-alive');
  });
});
