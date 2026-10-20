/**
 * 用户气泡里的附图标记 [[img:token]]（第八十一轮，Linux issue 2 查出来的真因）。
 *
 * 发送时把标记拼进正文（ChatPage.onSend），服务端 buildUpstreamContent 认它 —— 模型真收到了图；
 * 但显示侧以前没人认，所以你发出去的图在自己气泡里只剩一对方括号，看上去像「图片预览坏了」。
 * 判据按用户看得见的那件东西写：图必须画出来，标记字符串必须消失。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import ChatMessage from '../src/features/chat/ChatMessage.vue';

const hosts = [];
afterEach(() => {
  for (const x of hosts.splice(0)) {
    x.app.unmount();
    x.host.remove();
  }
});

function mountUser(content) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp({
    render: () => h(ChatMessage, { role: 'user', content, cwd: 'D:\\projects\\proj', remote: false }),
  });
  app.mount(host);
  hosts.push({ host, app });
  return host;
}

describe('用户消息里的附图', () => {
  it('附图画成缩略图，正文里不再留下 [[img:…]] 字样', async () => {
    const host = mountUser('看一下这个\n[[img:ab12cd34]]');
    await nextTick();
    const img = host.querySelector('.user-shot img');
    expect(img).toBeTruthy();
    expect(img.getAttribute('src')).toBe('/api/ai/chat/image/ab12cd34');
    expect(host.textContent).toContain('看一下这个');
    expect(host.textContent).not.toContain('[[img:');
  });

  it('两张图按发送顺序各画一颗，中间不留空行残渣', async () => {
    const host = mountUser('[[img:aaa1]]\n[[img:bbb2]]');
    await nextTick();
    const shots = [...host.querySelectorAll('.user-shot img')];
    expect(shots.map((e) => e.getAttribute('src'))).toEqual([
      '/api/ai/chat/image/aaa1',
      '/api/ai/chat/image/bbb2',
    ]);
    expect(host.querySelector('.user-body').textContent.trim()).toBe('');
  });

  it('图 token 过期后换成一句人话，不再留破图（与工具截图同一口径）', async () => {
    const host = mountUser('[[img:deadbeef]]');
    await nextTick();
    host.querySelector('.user-shot img').dispatchEvent(new Event('error'));
    await nextTick();
    const shot = host.querySelector('.user-shot');
    expect(shot.querySelector('img')).toBe(null);
    expect(shot.querySelector('.shot-dead').textContent.trim()).toBe('图片已被清理');
    expect(shot.getAttribute('role')).not.toBe('button');
  });

  it('@文件提及和附图混排时互不吃掉对方', async () => {
    const host = mountUser('参考 @README.md 这张 [[img:cafe01]]');
    await nextTick();
    expect(host.querySelector('.at-chip').textContent).toContain('@README.md');
    expect(host.querySelector('.user-shot img').getAttribute('src')).toBe('/api/ai/chat/image/cafe01');
    expect(host.textContent).not.toContain('[[img:');
  });

  it('没有附图的普通消息一字不动（反证：别把正常正文卷进切片）', async () => {
    const host = mountUser('普通一句话，里面有个方括号 [示例] 和 markdown');
    await nextTick();
    expect(host.querySelectorAll('.user-shot').length).toBe(0);
    expect(host.querySelector('.user-body').textContent.trim()).toBe('普通一句话，里面有个方括号 [示例] 和 markdown');
  });
});
