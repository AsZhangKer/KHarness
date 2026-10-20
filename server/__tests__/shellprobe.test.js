/**
 * Shell 探测与手填路径解析。
 *
 * 他报的三条：
 *   ① Windows 扫不到 Git Bash（Git 安装器默认「仅为我安装」→ %LOCALAPPDATA%\Programs\Git，
 *      而老实现只硬编码了 C:\Program Files\Git）
 *   ② Linux 扫不到 zsh（只硬编码 /bin/zsh）
 *   ③ Linux 手填 zsh 提示「不是可执行文件」（ENOENT 与 EACCES 被糊成一句；`~` 不展开；裸名不解析）
 * 探测逻辑全部走注入的 opts（platform/env/exists），不碰真实文件系统，所以在哪儿都能跑。
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import path from 'node:path';

const nodeRequire = createRequire(import.meta.url);
const shellprobe = nodeRequire('../utils/shellprobe');

/** 造一个假文件系统：给一组存在的路径，其余不存在 */
const fsOf = (files) => {
  const set = new Set(files.map((f) => (process.platform === 'win32' ? f.toLowerCase() : f)));
  return (p) => set.has(process.platform === 'win32' ? String(p).toLowerCase() : String(p));
};

describe('Windows 探测', () => {
  const env = {
    SystemRoot: 'C:\\Windows',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    PATH: 'C:\\Windows\\system32;C:\\Users\\me\\AppData\\Local\\Programs\\Git\\cmd',
  };
  const base = { platform: 'win32', env };

  it('Git 装在「仅为我安装」的 %LOCALAPPDATA%\\Programs\\Git 也能探到（他报的那条）', () => {
    const exists = fsOf([
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'C:\\Windows\\System32\\cmd.exe',
      'C:\\Users\\me\\AppData\\Local\\Programs\\Git\\cmd\\git.exe',
      'C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe',
    ]);
    const list = shellprobe.probeShells({ ...base, exists });
    const bash = list.find((s) => s.kind === 'bash');
    expect(bash).toBeTruthy();
    expect(bash.file).toContain('AppData\\Local\\Programs\\Git');
  });

  it('PATH 上有 git.exe 就顺着它反推同级的 bin\\bash.exe', () => {
    const exists = fsOf([
      'D:\\Tools\\Git\\cmd\\git.exe',
      'D:\\Tools\\Git\\usr\\bin\\bash.exe',
    ]);
    const env2 = { ...env, PATH: 'D:\\Tools\\Git\\cmd' };
    const list = shellprobe.probeShells({ platform: 'win32', env: env2, exists });
    expect(list.some((s) => s.file === 'D:\\Tools\\Git\\usr\\bin\\bash.exe')).toBe(true);
  });

  it('PATH 上的 pwsh 优先于固定路径（用户自己装的那份）', () => {
    const exists = fsOf([
      'C:\\Users\\me\\scoop\\apps\\pwsh\\pwsh.exe',
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    ]);
    const env2 = { ...env, PATH: 'C:\\Users\\me\\scoop\\apps\\pwsh' };
    const list = shellprobe.probeShells({ platform: 'win32', env: env2, exists });
    expect(list.find((s) => s.kind === 'powershell').file).toBe('C:\\Users\\me\\scoop\\apps\\pwsh\\pwsh.exe');
  });

  it('WSL 走 wsl.exe 归到 wsl，不跟 Git Bash 混为一谈', () => {
    const exists = fsOf(['C:\\Windows\\System32\\wsl.exe']);
    const list = shellprobe.probeShells({ ...base, exists });
    // 大小写不敏感比较：PATH 里 system32 常常是小写，拼出来的路径大小写跟固定写法不一致
    expect(list.find((s) => s.kind === 'wsl')?.file?.toLowerCase()).toBe('c:\\windows\\system32\\wsl.exe');
  });

  it('System32\\bash.exe 与 Git 的 bash 指向同一份时只留一条（去重不重复列）', () => {
    const exists = fsOf(['C:\\Program Files\\Git\\bin\\bash.exe']);
    const env2 = { ...env, PATH: '' };
    const list = shellprobe.probeShells({ platform: 'win32', env: env2, exists });
    expect(list.filter((s) => /bash\.exe$/i.test(s.file)).length).toBe(1);
  });

  it('agentShellCandidates 只回存在的，且都是 missing:false', () => {
    const exists = fsOf(['C:\\Windows\\System32\\cmd.exe']);
    const cands = shellprobe.agentShellCandidates({ ...base, exists });
    expect(cands.length).toBeGreaterThan(0);
    expect(cands.every((c) => c.missing === false)).toBe(true);
    expect(cands.some((c) => /cmd\.exe$/i.test(c.value))).toBe(true);
  });
});

describe('Linux/macOS 探测', () => {
  const env = { HOME: '/home/me', PATH: '/usr/local/bin:/usr/bin:/bin', SHELL: '/bin/bash' };
  const base = { platform: 'linux', env };

  it('读 /etc/shells：发行版里装到 /usr/local/bin 的 zsh 也扫得到', () => {
    const exists = fsOf(['/usr/local/bin/zsh', '/bin/bash']);
    const readFile = (p) => (p === '/etc/shells' ? '# comment\n/bin/bash\n/usr/local/bin/zsh\n\n' : '');
    const list = shellprobe.probeShells({ ...base, exists, readFile });
    expect(list.some((s) => s.file === '/usr/local/bin/zsh')).toBe(true);
  });

  it('没有 /etc/shells 时扫 PATH 与常见目录（/usr/bin/zsh）', () => {
    const exists = fsOf(['/usr/bin/bash', '/usr/bin/zsh']);
    const list = shellprobe.probeShells({ ...base, exists, readFile: () => '' });
    expect(list.find((s) => s.kind === 'zsh').file).toBe('/usr/bin/zsh');
  });

  it('/bin/bash 与 /usr/bin/bash 是同一个文件，只留一条', () => {
    const exists = fsOf(['/bin/bash', '/usr/bin/bash']);
    // usrmerge 下 /bin 是 /usr/bin 的软链：realpath 归到同一个
    const realpath = (p) => (p === '/bin/bash' ? '/usr/bin/bash' : p);
    const list = shellprobe.probeShells({ ...base, exists, realpath, readFile: () => '/bin/bash\n/usr/bin/bash\n' });
    expect(list.filter((s) => /(^|\/)bash$/.test(s.file)).length).toBe(1);
  });

  it('NixOS 那种 /run/current-system/sw/bin/zsh 也在候选目录里', () => {
    const exists = fsOf(['/run/current-system/sw/bin/zsh']);
    const list = shellprobe.probeShells({ ...base, exists, readFile: () => '' });
    expect(list.some((s) => s.file === '/run/current-system/sw/bin/zsh')).toBe(true);
  });
});

describe('手填路径解析（他报的「不是可执行文件」）', () => {
  it('裸名 zsh 解析成 PATH/探测结果里的真实路径', () => {
    const exists = fsOf(['/usr/bin/zsh']);
    const r = shellprobe.resolveShellInput('zsh', {
      platform: 'linux', env: { PATH: '/usr/bin:/bin', HOME: '/root' }, exists, readFile: () => '',
    });
    expect(r.ok).toBe(true);
    expect(r.path).toBe('/usr/bin/zsh');
  });

  it('~ 会展开成 HOME（以前原样丢给 accessSync，必然 ENOENT）', () => {
    const home = '/home/me';
    const want = '/home/me/.local/bin/zsh';   // 别用 path.join：宿主是 Windows 时会拼出反斜杠
    const exists = fsOf([want]);
    const r = shellprobe.resolveShellInput('~/.local/bin/zsh', {
      platform: 'linux', env: { HOME: home, PATH: '/bin' }, exists,
    });
    expect(r.ok).toBe(true);
    expect(r.path).toBe(want);
  });

  it('路径不存在 → 明确说「不存在」，并给出本机探测到的同名 shell', () => {
    const exists = fsOf(['/usr/bin/zsh']);
    const r = shellprobe.resolveShellInput('/bin/zsh', {
      platform: 'linux', env: { PATH: '/usr/bin', HOME: '/root' }, exists, readFile: () => '',
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ENOENT');
    expect(r.message).toContain('不存在');
    expect(r.message).toContain('/usr/bin/zsh');   // 建议里带上正确位置
  });

  it('文件在但没有执行位 → 说「没有执行权限」，不再和「不存在」糊成一句', () => {
    const exists = fsOf(['/opt/zsh/bin/zsh']);
    const r = shellprobe.resolveShellInput('/opt/zsh/bin/zsh', {
      platform: 'linux', env: { PATH: '/bin' }, exists, readFile: () => '', canExec: () => false,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('EACCES');
    expect(r.message).toContain('权限');
  });

  it('Windows 不按执行位判（X_OK 在那边等价于存在性，判了会误杀）', () => {
    const exists = fsOf(['C:\\Program Files\\Git\\bin\\bash.exe']);
    const r = shellprobe.resolveShellInput('C:\\Program Files\\Git\\bin\\bash.exe', {
      platform: 'win32', env: { PATH: '' }, exists, canExec: () => false,
    });
    expect(r.ok).toBe(true);
  });

  it('带引号的路径（从资源管理器复制来的）能去掉引号', () => {
    const exists = fsOf(['/usr/bin/fish']);
    const r = shellprobe.resolveShellInput('"/usr/bin/fish"', { platform: 'linux', env: { PATH: '/bin' }, exists });
    expect(r.ok).toBe(true);
    expect(r.path).toBe('/usr/bin/fish');
  });

  it('空串 = 恢复默认，直接放行', () => {
    expect(shellprobe.resolveShellInput('').ok).toBe(true);
    expect(shellprobe.resolveShellInput('   ').path).toBe('');
  });
});
