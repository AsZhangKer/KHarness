import { describe, it, expect } from 'vitest';
import path from 'path';
import { guardPrivatePath, isPrivateEntry, DATA_DIR, SERVER_DIR } from '../utils/privatepaths.js';

/**
 * KHarness 自己的数据对模型隐身（第五十三轮 #211）。
 * 这里的断言全是「字符串进、结论出」的纯判断，不起服务、不碰文件系统 ——
 * 因为这条墙一旦漏，漏的是模型密钥和全部对话，所以它必须有一张能随时跑的网。
 */
const inData = (...seg) => path.join(DATA_DIR, ...seg);
const blocked = (abs, ctx) => guardPrivatePath(abs, ctx || {});

describe('privatepaths：该挡住的', () => {
  it('主库与它的临时/备份副本', () => {
    for (const f of ['kh.db', 'kh.db-wal', 'kh.db-shm', 'kh.db.bak-20260930', 'kh.db.pre-import']) {
      expect(blocked(inData(f)), f).toBeTruthy();
    }
  });
  it('.env 与日志', () => {
    expect(blocked(inData('.env'))).toBeTruthy();
    expect(blocked(inData('desktop.log'))).toBeTruthy();
    expect(blocked(inData('data', 'crash.log'))).toBeTruthy();
  });
  it('撤销快照与终端归档', () => {
    expect(blocked(inData('.kh-undo', 'a1b2.json'))).toBeTruthy();
    expect(blocked(inData('.kh-term', 'x.txt'))).toBeTruthy();
  });
  it('恢复出厂的标记文件', () => {
    expect(blocked(inData('kh.factory-reset-pending.json'))).toBeTruthy();
  });
});

describe('privatepaths：不该误杀的', () => {
  it('.env.example 是给人看的模板，不是密钥', () => {
    expect(blocked(inData('.env.example'))).toBeNull();
  });
  it('代码目录本身不挡（仓库跑法下 DATA_DIR 就是 server/，主人在里面开发）', () => {
    expect(blocked(path.join(SERVER_DIR, 'routes', 'ai.js'))).toBeNull();
    expect(blocked(path.join(SERVER_DIR, 'data', 'defaults.js'))).toBeNull();
  });
  it('根目录本身不挡，否则 list_dir "." 会被打死', () => {
    expect(blocked(DATA_DIR)).toBeNull();
    expect(blocked(SERVER_DIR)).toBeNull();
  });
  it('别的项目里的同名文件不受牵连（挡的是我们这两个根下面）', () => {
    expect(blocked(path.resolve(SERVER_DIR, '..', 'some-project', 'kh.db'))).toBeNull();
  });
});

describe('privatepaths：截图按会话隔离', () => {
  const shot = (name) => inData('screen-shots', name);

  it('扁平日期的老截图：谁都读不到（没有归属信息就不能放行）', () => {
    expect(blocked(shot('screen-1730000000000.png'), { chatId: 123 })).toBeTruthy();
  });
  it('本会话子目录里的：读得到', () => {
    expect(blocked(inData('screen-shots', '123', 'screen-1.png'), { chatId: 123 })).toBeNull();
  });
  it('别人会话子目录里的：读不到', () => {
    expect(blocked(inData('screen-shots', '456', 'screen-1.png'), { chatId: 123 })).toBeTruthy();
  });
  it('遍历里静默跳过（不报错、也不出现在结果里）', () => {
    expect(isPrivateEntry(inData('kh.db'))).toBe(true);
    expect(isPrivateEntry(path.join(SERVER_DIR, 'index.js'))).toBe(false);
  });
});

describe('privatepaths：拒绝文案要能拦住模型重试', () => {
  it('文案里必须写清「批准也没用」，否则模型会换条路再来一遍', () => {
    const msg = blocked(inData('kh.db'));
    expect(msg).toContain('永久隐身');
    expect(msg).toContain('用户批准');
  });
});
