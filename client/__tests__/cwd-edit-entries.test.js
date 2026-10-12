/**
 * 第六十七轮：自由会话工作目录的「谁说了算」与两个右键入口。
 *
 * 他这次的口径：自由会话**只在建立时**默认桌面，之后可以改，改完不许被自动改回去；
 * 项目可以右键「编辑项目」改名与改工作目录，**两种改动都不许动磁盘上的任何文件/目录**。
 * 端到端读数在 _tmp_kh67/round67_test.js（隔离实例 + 假上游，24/24）；
 * 这里锁的是接线，防止下次有人把那两条又写回去：
 *   ① 发消息的 UPDATE 里不许再出现 cwd；
 *   ② 会话右键那颗键必须只对自由会话出现，且走的是「指定 chat_id」的接口（不是当前会话）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../src');
const pageSrc = fs.readFileSync(path.join(SRC, 'features/chat/ChatPage.vue'), 'utf8');
const storeSrc = fs.readFileSync(path.join(SRC, 'features/chat/chatStore.js'), 'utf8');
const aiSrc = fs.readFileSync(path.resolve(__dirname, '../../server/routes/ai.js'), 'utf8');

describe('工作目录的事实源', () => {
  it('服务端：发消息不再把请求体的目录写回会话行', () => {
    expect(aiSrc).toMatch(/UPDATE ai_chats SET model_row_id = \?, updated_at = CURRENT_TIMESTAMP WHERE id = \?/);
    expect(aiSrc).not.toMatch(/UPDATE ai_chats SET model_row_id = \?, cwd = \?/);
  });

  it('服务端：会话目录失效时报错指路，不静默掉回默认目录', () => {
    expect(aiSrc).toMatch(/会话的工作目录不存在或不可访问/);
    expect(aiSrc).toMatch(/设置工作目录/);
  });

  it('服务端：项目改名/改目录只写库，没有任何移动或重命名', () => {
    const put = aiSrc.slice(aiSrc.indexOf("router.put('/projects/:id'"), aiSrc.indexOf('// 删除项目'));
    expect(put).toMatch(/UPDATE projects SET name = \?, root_path = \?/);
    expect(put).toMatch(/chats_reset/);
    for (const bad of ['renameSync', 'rmSync', 'mkdirSync', 'cpSync', 'moveSync']) {
      expect(put).not.toContain(bad);
    }
  });
});

describe('左栏两个右键入口', () => {
  it('会话右键「设置工作目录」只给自由会话（项目会话被锁在项目根内）', () => {
    expect(pageSrc).toMatch(/<button v-if="!menu\.item\.project_id"[^>]*@click="menuSetCwd"[^>]*>[\s\S]{0,60}设置工作目录/);
  });

  it('项目右键「编辑项目」排在「新建会话」之后', () => {
    const a = pageSrc.indexOf('在项目中新建会话');
    const b = pageSrc.indexOf('menuEditProject');
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(pageSrc).toMatch(/function menuEditProject\(\)/);
  });

  it('改目录走带 chat_id 的接口，不是「当前会话」那条（右键点的可能是别的会话）', () => {
    expect(pageSrc).toMatch(/aiApi\.setCwd\(p, cwdForm\.id\)/);
    // 会话 id 在函数开头就先钉住（发出去之后人才可能切走，回写状态时要按它比对）
    expect(storeSrc).toMatch(/async function setCwd\(path\)\s*\{\s*const chatId = state\.chatId;\s*const res = await aiApi\.setCwd\(path, chatId\)/);
  });

  it('编辑态复用同一个弹窗：标题、按钮文案与保存分支都要跟着 editingId 走', () => {
    expect(pageSrc).toMatch(/editingId: 0/);
    expect(pageSrc).toMatch(/projForm\.editingId \? '编辑项目'/);
    expect(pageSrc).toMatch(/projForm\.editingId \? '保存' : '创建'/);
    expect(pageSrc).toMatch(/store\.editProject\(projForm\.editingId/);
    expect(storeSrc).toMatch(/async function editProject\(id, patch\)/);
    expect(storeSrc).toMatch(/aiApi\.updateProject\(id, patch\)/);
    expect(storeSrc).toMatch(/editProject,/);
  });

  it('编辑态弹窗里要写明「不动磁盘」这条承诺', () => {
    expect(pageSrc).toMatch(/不会重命名、移动或创建任何文件\/目录/);
  });
});
