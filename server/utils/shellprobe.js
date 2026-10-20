/**
 * Shell 探测 —— Windows / Linux / macOS 共用的唯一一份实现。
 *
 * 为什么单独抽一份：以前 Agent Shell 的候选（routes/ai.js）和终端浮窗的候选（utils/term.js）
 * 各写了一半，两边各漏一半，他报的三条全是这么来的：
 *   ① Windows「扫不到 Git Bash」：Agent 那份是**纯硬编码路径 + fs.existsSync**，连 PATH 都不查。
 *      Git for Windows 的安装器默认勾的是「仅为我安装」→ 装到 %LOCALAPPDATA%\Programs\Git，
 *      而硬编码里只有 C:\Program Files\Git\bin\bash.exe → 明明装了却显示缺失。
 *   ② Linux「扫不到 zsh」：zsh 只硬编码了 /bin/zsh 一条。usrmerge 的发行版能撞上，
 *      NixOS / 手工装到 /usr/local/bin / Debian 9 这类就扫不到。
 *   ③ Linux 手选 zsh 报「不是可执行文件」：ENOENT 与 EACCES 被糊成同一句提示，
 *      `~` 不展开、裸名不解析，而且前端把 missing 的候选也照列不误。
 *
 * 三条硬规矩：
 *   · **一律不 spawn 外部命令**（where/which）。探测要能在最小环境里跑起来 ——
 *     Flatpak 沙箱里根本没有 `which`，spawn 失败被 catch 吞掉就等于「全都没检测到」。
 *   · **不依赖宿主平台的 path.***：本模块要能在 Windows 上算 POSIX 路径（反之亦然），
 *     否则「在 Windows 上测 Linux 分支」这种单测没法写。所以路径拼接/取名字全走下面几个小工具。
 *   · 全部走 `opts` 注入（platform/env/exists/readFile），纯逻辑，能直接单测。
 */

const fs = require('fs');

const DEFAULT_POSIX_DIRS = [
  '/bin', '/usr/bin', '/usr/local/bin', '/usr/local/sbin', '/sbin', '/usr/sbin',
  '/snap/bin', '/opt/homebrew/bin', '/opt/local/bin', '/run/current-system/sw/bin',
];

const POSIX_SHELLS = [
  ['bash', 'bash'], ['zsh', 'zsh'], ['fish', 'fish'], ['dash', 'dash'],
  ['ksh', 'ksh'], ['sh', 'sh'], ['nu', 'nushell'],
];

// ---------- 平台感知的路径小工具（不碰宿主 path.*）----------
const isWinPath = (p) => /^[a-zA-Z]:[\\/]/.test(String(p)) || String(p).includes('\\');

/** 取末段名：两种分隔符都认，所以 C:\a\b.exe 与 /a/b 都能取对 */
function pbase(p) {
  const s = String(p == null ? '' : p);
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i === -1 ? s : s.slice(i + 1);
}

/** 取上级目录（同样两种分隔符都认） */
function pdir(p) {
  const s = String(p == null ? '' : p);
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i <= 0 ? '' : s.slice(0, i);
}

/** 拼路径：按目标平台的分隔符，绝不用 path.join（它会跟宿主平台走） */
function pjoin(platform, dir, name) {
  const d = String(dir || '');
  if (!d) return String(name || '');
  const sep = platform === 'win32' ? '\\' : '/';
  const trimmed = d.replace(/[\\/]+$/, '');
  return trimmed + sep + String(name || '');
}

function pathSep(env, platform) {
  // Windows 的 PATH 用 ; 分隔。也顺手认一下「明明给了 POSIX 路径却跑在 win32 判定下」的异常输入。
  return platform === 'win32' ? ';' : ':';
}

function pathexts(env) {
  const raw = env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
  return raw.split(';').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** 在 PATH 各目录里找一个文件（Windows 会依次补 PATHEXT 后缀）；找不到返回 '' */
function findOnPath(names, { platform, env, exists }) {
  const dirs = String(env.PATH || '').split(pathSep(env, platform))
    .map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean);
  const exts = platform === 'win32' ? ['', ...pathexts(env)] : [''];
  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const p = pjoin(platform, dir, name + ext);
        if (exists(p)) return p;
      }
    }
  }
  return '';
}

/** POSIX：读 /etc/shells（发行版权威清单：每行一个绝对路径，# 注释） */
function etcShells(opts) {
  const read = opts.readFile || ((p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } });
  return String(read('/etc/shells') || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.startsWith('/') && opts.exists(l));
}

/**
 * Windows：从 `git.exe` 反推 Git Bash。
 * `…\Git\cmd\git.exe` → 同级上层的 `bin\bash.exe`、`usr\bin\bash.exe`。
 * 这一条能覆盖 %LOCALAPPDATA%\Programs\Git 与 scoop/chocolatey 这些「PATH 上能找到 git」的安装。
 */
function gitBashFromGit(opts) {
  const git = findOnPath(['git'], opts);
  if (!git) return '';
  const root = pdir(pdir(git));   // …\Git\cmd\git.exe → …\Git\cmd → …\Git
  if (!root) return '';
  for (const rel of ['bin\\bash.exe', 'usr\\bin\\bash.exe', 'bin\\sh.exe', 'usr/bin/bash.exe']) {
    const p = pjoin(opts.platform, root, rel);
    if (opts.exists(p)) return p;
  }
  return '';
}

/** 归一化去重：/bin/bash 与 /usr/bin/bash 是同一个文件，不该在下拉里出现两条 */
function dedupe(list, opts) {
  const realpath = opts.realpath || ((p) => { try { return fs.realpathSync(p); } catch (e) { return p; } });
  const win = opts.platform === 'win32';
  const seen = new Set();
  const out = [];
  for (const it of list) {
    if (!it || !it.file) continue;
    const key = win ? it.file.toLowerCase() : realpath(it.file).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

/** 把调用方给的可选注入补全成完整 opts */
function normOpts(userOpts) {
  const injectedExists = typeof userOpts.exists === 'function';
  const opts = {
    platform: userOpts.platform || process.platform,
    env: userOpts.env || process.env,
    exists: injectedExists
      ? userOpts.exists
      // 认「文件」不认目录：把目录当 shell 用是错误的（以前只判 existsSync，目录也能存进去）
      : ((p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }),
    readFile: userOpts.readFile,
    realpath: userOpts.realpath,
    // 注入了 exists（= 一个假文件系统视图）时，可执行位默认跟着它走 ——
    // 否则单测里明明「文件存在」，却因为真机上没这个文件而被判成 EACCES。
    _injectedExists: injectedExists,
    _canExec: userOpts.canExec,
  };
  opts.canExec = opts._canExec || (injectedExists
    ? ((p) => opts.exists(p))
    : ((p) => { try { fs.accessSync(p, fs.constants ? fs.constants.X_OK : 1); return true; } catch (e) { return false; } }));
  return opts;
}

/**
 * 探到本机真实存在的 shell：`[{ file, label, kind }]`
 * kind: powershell | cmd | bash | wsl | zsh | fish | …（前端拿它做图标/分组）
 * 只有「真的存在」才进来 —— 前端不必再自己判 missing。
 */
function probeShells(userOpts = {}) {
  const opts = normOpts(userOpts);
  const list = [];

  if (opts.platform === 'win32') {
    const sys = opts.env.SystemRoot || opts.env.windir || 'C:\\Windows';
    const pf = opts.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = opts.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = opts.env.LOCALAPPDATA || '';
    const push = (label, kind, ...files) => {
      for (const f of files) { if (f && opts.exists(f)) { list.push({ file: f, label, kind }); return; } }
    };
    // PATH 优先：用户自己装的、scoop 装的，PATH 上那份最可能是他想要的那个
    push('PowerShell 7（推荐）', 'powershell', findOnPath(['pwsh'], opts), pjoin('win32', pf, 'PowerShell\\7\\pwsh.exe'));
    push('PowerShell 5（系统自带）', 'powershell', findOnPath(['powershell'], opts), pjoin('win32', sys, 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'));
    push('CMD（传统）', 'cmd', opts.env.COMSPEC, pjoin('win32', sys, 'System32\\cmd.exe'));
    // Git Bash：PATH → 从 git.exe 反推 → 各家默认安装路径（含「仅为我安装」那一份）
    push('Git Bash', 'bash',
      findOnPath(['bash'], opts),
      gitBashFromGit(opts),
      pjoin('win32', pf, 'Git\\bin\\bash.exe'),
      pjoin('win32', pf, 'Git\\usr\\bin\\bash.exe'),
      local ? pjoin('win32', local, 'Programs\\Git\\bin\\bash.exe') : '',
      local ? pjoin('win32', local, 'Programs\\Git\\usr\\bin\\bash.exe') : '',
      pjoin('win32', pf86, 'Git\\bin\\bash.exe'));
    push('WSL Bash', 'wsl', findOnPath(['wsl'], opts), pjoin('win32', sys, 'System32\\bash.exe'));
  } else {
    const seen = new Set();
    // /etc/shells 是发行版权威清单，先收它
    for (const f of etcShells(opts)) {
      if (seen.has(f)) continue;
      seen.add(f);
      const base = pbase(f);
      list.push({ file: f, label: base, kind: base.replace(/[^a-z0-9]/gi, '') });
    }
    // 再扫 PATH 与常见目录（/etc/shells 缺条目、或 shell 装在别处的场景）
    for (const [bin, label] of POSIX_SHELLS) {
      const p = findOnPath([bin], opts) ||
        DEFAULT_POSIX_DIRS.map((d) => pjoin('posix', d, bin)).find((f) => opts.exists(f)) || '';
      if (p && !seen.has(p)) { seen.add(p); list.push({ file: p, label, kind: bin }); }
    }
    // pwsh 不在系统目录，看发行版装在哪
    const pwsh = findOnPath(['pwsh'], opts) ||
      ['/usr/bin/pwsh', '/usr/local/bin/pwsh', '/opt/microsoft/powershell/7/pwsh', '/snap/bin/pwsh']
        .find((f) => opts.exists(f));
    if (pwsh) list.push({ file: pwsh, label: 'PowerShell 7', kind: 'powershell' });
  }
  return dedupe(list, opts);
}

/** Agent Shell 下拉要的形状：{ value, label, missing } —— 只列存在的，missing 恒为 false */
function agentShellCandidates(userOpts = {}) {
  return probeShells(userOpts).map((s) => ({ value: s.file, label: String(s.label || pbase(s.file)), missing: false }));
}

/**
 * 把用户手填的 shell 解析成真正可用的路径。支持的写法（他报的「手选 zsh 说不是可执行文件」
 * 就是因为这些以前一个都没做）：
 *   · `~` / `~/…`        → 展开成 HOME（以前原样丢给 fs.accessSync，必然 ENOENT）
 *   · 裸名 `zsh`/`bash`  → 走探测结果与 PATH 解析成真实路径
 *   · `%VAR%`            → Windows 变量展开
 *   · 目录 / 无执行位文件 → 明确回是哪一种错，不再糊成一句「不可执行或不存在」
 * 返回 { ok:true, path } 或 { ok:false, code, message, suggest }
 */
function resolveShellInput(input, userOpts = {}) {
  const opts = normOpts(userOpts);
  let raw = String(input == null ? '' : input).trim();
  if (!raw) return { ok: true, path: '' };
  raw = raw.replace(/^"(.*)"$/, '$1').trim();   // 有人习惯从资源管理器「复制路径」
  if (!raw) return { ok: true, path: '' };

  const expand = (s) => {
    if (opts.platform === 'win32') {
      let out = s.replace(/%([^%]+)%/g, (m, k) => opts.env[k] || m);
      // Windows 上 %USERPROFILE% 之外，「~/」这种 Unix 习惯也顺手认一下
      if (out === '~' || out.startsWith('~/')) out = pjoin('win32', (opts.env.USERPROFILE || opts.env.HOME || ''), out.slice(2));
      return out;
    }
    if (s === '~' || s.startsWith('~/')) return pjoin('posix', (opts.env.HOME || '/root'), s.slice(2));
    return s;
  };
  const expanded = expand(raw);
  const hasSep = /[\\/]/.test(expanded);

  // 裸名：先在本机探到的 shell 里找同名（能落到真实路径上），再走 PATH
  if (!hasSep) {
    const norm = (f) => pbase(f).toLowerCase().replace(/\.exe$/, '');
    const known = probeShells(opts);
    const hit = known.find((s) => norm(s.file) === norm(expanded));
    if (hit) return { ok: true, path: hit.file };
    const onPath = findOnPath([expanded], opts) || findOnPath([norm(expanded)], opts);
    if (onPath) return { ok: true, path: onPath };
    const names = known.map((s) => pbase(s.file)).filter(Boolean);
    return {
      ok: false, code: 'ENOENT',
      message: `在 PATH 里找不到名为「${raw}」的可执行文件`
        + (names.length ? `（这台机器上探测到的 shell：${names.join('、')}）` : '（这台机器上没探测到任何 shell）'),
      suggest: known.map((s) => s.file),
    };
  }

  if (!opts.exists(expanded)) {
    const base = pbase(expanded).toLowerCase().replace(/\.exe$/, '');
    const same = probeShells(opts).filter((s) => pbase(s.file).toLowerCase().replace(/\.exe$/, '') === base);
    return {
      ok: false, code: 'ENOENT',
      message: `路径不存在：${expanded}` + (same.length ? `（本机探测到同名 shell 在 ${same.map((s) => s.file).join('、')}）` : ''),
      suggest: same.map((s) => s.file),
    };
  }
  // Windows 上 X_OK 等价于存在性（判了会误杀）；POSIX 上才真的要求可执行位
  if (opts.platform !== 'win32' && !opts.canExec(expanded)) {
    return {
      ok: false, code: 'EACCES',
      message: `文件在，但当前用户没有执行权限：${expanded}（给文件加执行位：chmod +x）`,
    };
  }
  return { ok: true, path: expanded };
}

module.exports = { probeShells, agentShellCandidates, resolveShellInput, findOnPath, _internals: { pbase, pdir, pjoin } };
