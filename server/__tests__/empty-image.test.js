/**
 * ② 截图回喂「空图片 / 已失效图片」（#240）。
 *
 * 两层各挡一次，缺一不可：
 *  · shotfeed：文件层面 —— 0 字节、小到不像截图、文件头不是图片格式的，一律不产 token，
 *    只回一句「图片未回喂：原因」，让模型知道自己没看到图（而不是看着一张黑图瞎说）。
 *  · protocols.onlyLatestImage：请求层面 —— 「只带最近一张」必须挑最近一张**有效**的，
 *    空图不能当选（否则它会把更早那张有效图挤成 [过期的图片]），也不能原样发给上游
 *    （Anthropic 侧空 base64 的块会被正则整个丢掉，结果是请求里一张图都没有）。
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = path.join(os.tmpdir(), `kh-empty-image-test-${process.pid}`);
process.env.KH_DATA_DIR = DATA;   // config.js 在 require 时读它，所以必须先设再 import

fs.mkdirSync(path.join(DATA, 'screen-shots'), { recursive: true });
const shotfeed = await import('../utils/shotfeed.js');
const { onlyLatestImage } = (await import('../utils/protocols.js'))._internal;

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
function write(name, buf) {
  const f = path.join(DATA, 'screen-shots', name);
  fs.writeFileSync(f, buf);
  return f;
}
const putStub = () => 'tok-' + Math.random().toString(36).slice(2, 8);
const imgOf = (b64) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } });

describe('shotfeed：不像截图的文件不产 token', () => {
  it('0 字节 → 只回原因，不发 token', () => {
    const f = write('empty.png', Buffer.alloc(0));
    const r = shotfeed.shotFromFile(f, putStub);
    expect(r.token).toBeFalsy();
    expect(r.note).toContain('文件是空的');
  });

  it('100 字节的“PNG”（被截断）→ 挡下', () => {
    const f = write('tiny.png', PNG_HEAD.subarray(0, 8));
    const r = shotfeed.shotFromFile(f, putStub);
    expect(r.token).toBeFalsy();
    expect(r.note).toMatch(/不像一张完整截图/);
  });

  it('内容是文本却叫 .png → 文件头不对，挡下', () => {
    const f = write('fake.png', Buffer.from('x'.repeat(4096)));
    const r = shotfeed.shotFromFile(f, putStub);
    expect(r.token).toBeFalsy();
    expect(r.note).toMatch(/文件头不是任何已知图片格式/);
  });

  it('正常 PNG 头 + 够大 → 照样出 token（别把好的也挡了）', () => {
    const f = write('good.png', Buffer.concat([PNG_HEAD, Buffer.alloc(4096, 7)]));
    const r = shotfeed.shotFromFile(f, putStub);
    expect(r.token).toBeTruthy();
    expect(r.marker).toBe(`[[img:${r.token}]]`);
    expect(r.mime).toBe('image/png');
  });

  it('JPEG 魔数认得（实验室转码后落的是 .jpg）', () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4096, 3)]);
    const f = write('good.jpg', buf);
    const r = shotfeed.shotFromFile(f, putStub);
    expect(r.token).toBeTruthy();
    expect(r.mime).toBe('image/jpeg');
  });
});

describe('onlyLatestImage：只带最近两张有效图', () => {
  const VALID = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64') + 'AAAAAAAA';

  it('空图不能当选「最近一张」，更早的有效图要留下', () => {
    const msgs = [
      { role: 'user', content: [imgOf(VALID), { type: 'text', text: '第一张' }] },
      { role: 'tool', content: [imgOf('')] },   // 这张是空的
    ];
    const out = onlyLatestImage(msgs);
    expect(out[0].content[0].type).toBe('image_url');           // 有效那张仍然是图
    expect(out[0].content[1].text).toBe('第一张');
    expect(out[1].content[0]).toEqual({ type: 'text', text: '[过期的图片]' });  // 空图换成文字
  });

  it('两张有效图：两张都带上（只带一张时，上一张可能模型还没看过就被挤掉）', () => {
    const msgs = [
      { role: 'user', content: [imgOf(VALID)] },
      { role: 'tool', content: [imgOf(VALID + 'BBBB')] },
    ];
    const out = onlyLatestImage(msgs);
    expect(out[0].content[0].type).toBe('image_url');
    expect(out[1].content[0].type).toBe('image_url');
  });

  it('三张有效图：只留最近两张，第三张（模型早看过的那张）才换占位', () => {
    const msgs = [
      { role: 'user', content: [imgOf(VALID)] },
      { role: 'tool', content: [imgOf(VALID + 'BBBB')] },
      { role: 'tool', content: [imgOf(VALID + 'CCCC')] },
    ];
    const out = onlyLatestImage(msgs);
    expect(out[0].content[0]).toEqual({ type: 'text', text: '[过期的图片]' });
    expect(out[1].content[0].type).toBe('image_url');
    expect(out[2].content[0].type).toBe('image_url');
  });

  it('一张有效图都没有：全部换占位，不把空 dataURL 发给上游', () => {
    const msgs = [{ role: 'tool', content: [imgOf(''), imgOf('')] }];
    const out = onlyLatestImage(msgs);
    expect(out[0].content.every((p) => p.type === 'text')).toBe(true);
  });

  it('没有图的请求原样返回（不白拷贝）', () => {
    const msgs = [{ role: 'user', content: '纯文字' }];
    expect(onlyLatestImage(msgs)).toBe(msgs);
  });
});

afterAll(() => { fs.rmSync(DATA, { recursive: true, force: true }); });
