/**
 * 远程会话下 AI 工具的执行层（阶段 5）。
 *
 * 为什么单独一个文件：execTool 那个 switch 已经 300 多行、被审批/只读门/边界守卫包着，
 * 再往里塞一套「所有 fs 调用换成 SFTP」的分支会让两条路互相踩。这里只接管
 * 与「工作目录在哪」有关的工具（命令 + 文件），其余（web_fetch、记忆、子智能体、MCP、
 * 内置浏览器）返回 undefined 让 execTool 继续走本地实现。
 *
 * 与本地对齐的地方刻意做到一样，前端与模型都不用特判远程：
 *  - 返回形状 { output } / { error } / { diff, path, undo_id }；
 *  - 写/改/删都先记 undo_ops 快照（快照字节存在本机，恢复时推回远端）；
 *  - 删除不真删，先移到远端 ~/.kh-undo/<时间戳>/。
 * 不一样的只有一处：路径是 posix，且 edit_file 的换行符自适应省掉（远端 Linux 基本只有 LF）。
 */
const remote = require('./remote');
const undoStore = require('./undo');

// buildFileDiff / buildNewFileDiff / decodeTextSmart / getCmdTimeoutMs 留在 routes/ai.js 里，
// 用 setHost 注入（和 orchestrator 同一套做法），避免把差异算法复制两份。
let host = {};
function setHost(deps) { host = Object.assign({}, host, deps || {}); }

const posix = remote.posixPath;

/** 相对路径按远端 cwd 拼接；绝对路径直接归一。绝不使用本地 path.resolve。 */
function rj(cwd, p) {
  const raw = String(p || '').trim().replace(/\\/g, '/');
  if (!raw || raw === '.') return posix(cwd || '/');
  if (raw.startsWith('/')) return posix(raw);
  return posix(`${posix(cwd || '/')}/${raw}`);
}
const base = (p) => p.replace(/\/+$/, '').split('/').pop() || p;

/**
 * 是不是一个「远端能解释」的绝对路径。
 * 判据刻意保守：Windows 盘符（D:\ 或 D:/）与 UNC（\\srv\share）都算本机路径，
 * 一旦让它们混进远程会话的 cwd，后面每条命令都会变成 `cd /D:/... → 远端没这目录 → 整轮全废`。
 */
function posixAbs(x) {
  const raw = String(x || '').trim();
  if (!raw || /^[A-Za-z]:/.test(raw) || raw.includes('\\')) return '';
  const p = posix(raw);
  return p.startsWith('/') ? p : '';
}

/**
 * 远程会话这一轮的工作目录怎么定：候选顺序与本机同构，但**只认远端路径**。
 * 早先这里借用了本机的 fs.statSync 校验，'/home/user' 在 Windows 上被看成 'D:\home\user'，
 * 判成「目录不存在」后掉回本机默认目录（装机版里就是 resources/server），
 * 于是 run_command 的 cd 前置、read_file 的相对解析全部指向远端不存在的路径。
 * 库里已经存了 Windows 路径的旧行，这里会被跳过 —— 下一次发送即自愈。
 */
function resolveCwd({ agent, bodyCwd, chatCwd, projectRoot, host } = {}) {
  const cands = [];
  if (agent) cands.push(posixAbs(bodyCwd));
  cands.push(posixAbs(chatCwd), posixAbs(projectRoot), posixAbs(host && host.default_cwd), posixAbs(host && host.home));
  const cwd = cands.find(Boolean) || '/';
  const root = posixAbs(projectRoot);
  // 项目会话照旧锁在项目根内（posix 前缀判断，不用本地 path 模块）
  return (root && cwd !== root && !cwd.startsWith(root + '/')) ? root : cwd;
}

/**
 * 远程版路径边界：项目会话锁在项目根内（软链逃逸用远端 realpath 兜），
 * 自由会话只要求绝对路径 —— 与本地 guardTargetPath 同一意图，实现换成 SFTP。
 */
async function guardRemotePath(target, projectRoot) {
  if (!target || target === '/') return { error: '远程会话：路径不能为空' };
  if (!projectRoot) return null;
  const root = posix(projectRoot);
  let real = target;
  try { real = await remote.sftp.realPath(hostRowCache.current, target); } catch (e) { /* 目标还不存在（新建），按字面判 */ }
  const norm = posix(real);
  if (norm !== root && !norm.startsWith(root + '/')) {
    return { error: `远程会话被限制在项目根内：${root}（你请求的 ${target} 解析后是 ${norm}）。请改用项目内的路径。` };
  }
  return null;
}

// guardRemotePath 需要当前主机行；由 execRemoteTool 每次调用前塞进来（避免到处传参）
const hostRowCache = { current: null };

function recordRemote(hostRow, fields, chatId, label) {
  return undoStore.record(Object.assign({ remoteId: hostRow.id, chatId: Number.isInteger(chatId) ? chatId : null, label }, fields));
}

/** 远端 grep：直接让远端跑 grep -R，比把整棵目录树经 SFTP 读进内存快两个数量级 */
async function remoteGrep(hostRow, args, cwd) {
  const pattern = String(args.pattern || '');
  if (!pattern) return { error: 'grep:pattern 不能为空' };
  const baseArg = args.path && args.path !== '.' ? rj(cwd, args.path) : posix(cwd || '/');
  const skip = ['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', '.kh-undo']
    .map((d) => `--exclude-dir=${d}`).join(' ');
  const maxHits = Math.min(Math.max(parseInt(args.limit) || 200, 1), 400);
  const cmd = `grep -R -n -I --binary-files=without-match ${skip} -e ${remote.shellQuote(pattern)} ${remote.shellQuote(baseArg)} 2>/dev/null | head -${maxHits}`;
  const r = await remote.runRemoteCommand(hostRow, cmd, { timeoutMs: (host.getCmdTimeoutMs ? host.getCmdTimeoutMs() : 120000) });
  if (r.error) return { error: r.error };
  const lines = String(r.output || '').split('\n').filter((l) => l.includes(':'));
  if (!lines.length) return { output: `没有匹配：${pattern}` };
  return { output: lines.slice(0, maxHits).map((l) => l.substring(0, 400)).join('\n') + `\n\n共 ${lines.length} 处匹配` };
}

/** 远端 glob：远端 find 出路径清单，再在本地用同一套通配符语义筛 */
async function remoteGlob(hostRow, args, cwd) {
  const pattern = String(args.pattern || '');
  if (!pattern) return { error: 'glob:pattern 不能为空' };
  const baseArg = args.path && args.path !== '.' ? rj(cwd, args.path) : posix(cwd || '/');
  const prune = ['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', '.kh-undo']
    .map((d) => `-name ${remote.shellQuote(d)} -prune -o`).join(' ');
  const namePart = pattern.includes('/') ? '' : ` -name ${remote.shellQuote(pattern)}`;
  const cmd = `find ${remote.shellQuote(baseArg)} ${prune} \\( -type f -o -type d \\) ${namePart} -print 2>/dev/null | head -800`;
  const r = await remote.runRemoteCommand(hostRow, cmd, { timeoutMs: (host.getCmdTimeoutMs ? host.getCmdTimeoutMs() : 120000) });
  if (r.error) return { error: r.error };
  let paths = String(r.output || '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (pattern.includes('/')) {
    const rx = globToRx(pattern);
    paths = paths.filter((p) => rx.test(p.replace(/^\//, '')) || rx.test(base(p)));
  }
  if (!paths.length) return { output: `没有匹配 ${pattern}` };
  return { output: paths.slice(0, 500).map((p) => p.replace(baseArg.replace(/\/+$/, '') + '/', '')).join('\n') + `\n\n共 ${paths.length} 个路径` };
}

/** 与 routes/ai.js 的 globToRx 同语义（通配符 → 正则，* 不跨 /） */
function globToRx(pattern) {
  let out = '';
  for (const ch of String(pattern)) {
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else if (/[.+^${}()|[\]\\]/.test(ch)) out += '\\' + ch;
    else out += ch;
  }
  return new RegExp(`(^|/)${out}$`, 'i');
}

/**
 * 入口：远程工具能处理就返回结果，处理不了返回 undefined（execTool 继续走本地 switch）。
 */
async function execRemoteTool(hostRow, name, args, cwd, opts = {}) {
  const { projectRoot = null, chatId = null, holder = {} } = opts;
  hostRowCache.current = hostRow;
  // 兜一层：上游（回合级 cwd 解析、子智能体、监工）只要漏进一个本机 Windows 路径，
  // 后面每条命令都会变成「cd 到远端不存在的路径」。这里重解成远端能解释的绝对路径。
  cwd = resolveCwd({ chatCwd: cwd, projectRoot, host: hostRow });
  const target = (p) => rj(cwd, p);

  if (name === 'run_command') {
    const timeoutMs = host.getCmdTimeoutMs ? host.getCmdTimeoutMs() : 120000;
    return await remote.runRemoteCommand(hostRow, String(args.command || ''), { cwd: posix(cwd || '/'), holder, timeoutMs });
  }
  if (name === 'read_file') {
    const p = target(args.path);
    const guard = await guardRemotePath(p, projectRoot);
    if (guard) return guard;
    try {
      const buf = await remote.sftp.readFile(hostRow, p);
      const text = host.decodeTextSmart ? host.decodeTextSmart(buf) : buf.toString('utf8');
      return { output: text || '(空文件)' };
    } catch (e) {
      return { error: `read_file:读不到远端 ${p}：${e.message}` };
    }
  }
  if (name === 'write_file') {
    const p = target(args.path);
    const guard = await guardRemotePath(p, projectRoot);
    if (guard) return guard;
    const content = String(args.content ?? '');
    let prev = null;
    try { prev = (host.decodeTextSmart ? host.decodeTextSmart(await remote.sftp.readFile(hostRow, p)) : (await remote.sftp.readFile(hostRow, p)).toString('utf8')); } catch (e) { /* 新建 */ }
    const opId = recordRemote(hostRow, { path: p, type: 'file', existed: !!prev, isDir: false, buf: prev ? Buffer.from(prev, 'utf8') : null }, chatId, `写入远端 ${base(p)}`);
    try {
      await remote.sftp.writeFile(hostRow, p, content);
    } catch (e) {
      return { error: `write_file:写不进远端 ${p}：${e.message}`, path: p, undo_id: opId };
    }
    return {
      output: `已${prev === null ? '创建' : '覆盖'}远端 ${p}（${content.length} 字符）`,
      diff: host.buildNewFileDiff && host.buildFileDiff ? (prev === null ? host.buildNewFileDiff(content) : host.buildFileDiff(prev, content)) : null,
      path: p, new_file: prev === null, undo_id: opId, remote: true,
    };
  }
  if (name === 'edit_file') {
    const p = target(args.path);
    const guard = await guardRemotePath(p, projectRoot);
    if (guard) return guard;
    const oldText = String(args.old_text ?? '');
    const newText = String(args.new_text ?? '');
    if (!oldText) return { error: 'edit_file:old_text 不能为空', path: p };
    let prev;
    try { prev = host.decodeTextSmart ? host.decodeTextSmart(await remote.sftp.readFile(hostRow, p)) : (await remote.sftp.readFile(hostRow, p)).toString('utf8'); }
    catch (e) { return { error: `edit_file:远端目标文件不存在:${p}`, path: p }; }
    const matched = prev.indexOf(oldText);
    if (matched === -1) return { error: 'edit_file:未找到要替换的原文(请先 read_file 确认内容一致)', path: p };
    if (prev.indexOf(oldText, matched + oldText.length) !== -1) return { error: 'edit_file:原文出现多次,匹配不唯一,未做任何修改,请给出更长的唯一片段', path: p };
    const next = prev.slice(0, matched) + newText + prev.slice(matched + oldText.length);
    const opId = recordRemote(hostRow, { path: p, type: 'file', existed: true, isDir: false, buf: Buffer.from(prev, 'utf8') }, chatId, `编辑远端 ${base(p)}`);
    try {
      await remote.sftp.writeFile(hostRow, p, next);
    } catch (e) {
      return { error: `edit_file:写回远端失败：${e.message}`, path: p, undo_id: opId };
    }
    return {
      output: `已编辑远端 ${p}`,
      diff: host.buildFileDiff ? host.buildFileDiff(prev, next) : null,
      path: p, new_file: false, undo_id: opId, remote: true,
    };
  }
  if (name === 'list_dir') {
    const p = target(args.path || '.');
    const guard = await guardRemotePath(p, projectRoot);
    if (guard) return guard;
    try {
      const items = await remote.sftp.list(hostRow, p);
      if (!items.length) return { output: `${p} 是空目录` };
      return { output: items.map((i) => (i.type === 'dir' ? i.name + '/' : i.name)).join('\n') + `\n\n共 ${items.length} 项` };
    } catch (e) {
      return { error: `list_dir:列不动远端 ${p}：${e.message}` };
    }
  }
  if (name === 'grep') {
    const p = args.path && args.path !== '.' ? target(args.path) : posix(cwd || '/');
    const guard = await guardRemotePath(p, projectRoot);
    if (guard) return guard;
    return await remoteGrep(hostRow, args, cwd);
  }
  if (name === 'glob') {
    const p = args.path && args.path !== '.' ? target(args.path) : posix(cwd || '/');
    const guard = await guardRemotePath(p, projectRoot);
    if (guard) return guard;
    return await remoteGlob(hostRow, args, cwd);
  }
  if (name === 'delete_file' || name === 'delete_dir') {
    const wantDir = name === 'delete_dir';
    const p = target(args.path);
    const guard = await guardRemotePath(p, projectRoot);
    if (guard) return guard;
    if (p === '/') return { error: `${name}:拒绝删除远端根目录` };
    let st = null;
    try { st = await remote.sftp.stat(hostRow, p); } catch (e) { return { error: `${name}:远端不存在 ${p}` }; }
    if (wantDir && st.type !== 'dir') return { error: `${name}:目标不是目录（删除单个文件请用 delete_file）`, path: p };
    if (!wantDir && st.type === 'dir') return { error: `${name}:目标是目录(${p})，本工具只删除文件`, path: p };
    let buf = null;
    if (st.type !== 'dir') { try { buf = await remote.sftp.readFile(hostRow, p); } catch (e) { /* 读不到就只靠暂存区恢复 */ } }
    const { moved } = await remote.sftp.trash(hostRow, p, st.type === 'dir');
    const opId = recordRemote(hostRow, {
      path: p, type: st.type === 'dir' ? 'delete_dir' : 'delete', existed: true, isDir: st.type === 'dir', buf, note: moved,
    }, chatId, `删除远端 ${st.type === 'dir' ? '目录 ' : ''}${base(p)}`);
    return { output: `已删除远端 ${p}（暂存于 ${moved}，可撤销恢复）`, path: p, undo_id: opId, deleted: true, remote: true };
  }
  if (name === 'create_dir') {
    const p = target(args.path);
    const guard = await guardRemotePath(p, projectRoot);
    if (guard) return guard;
    try {
      const st = await remote.sftp.stat(hostRow, p).catch(() => null);
      if (st && st.type === 'dir') return { error: `create_dir:远端目录已存在:${p}`, path: p };
      await remote.sftp.mkdirP(hostRow, p);
      const opId = recordRemote(hostRow, { path: p, type: 'dir', existed: false, isDir: true, buf: null }, chatId, `创建远端目录 ${base(p)}`);
      return { output: `已创建远端目录 ${p}`, path: p, undo_id: opId, remote: true };
    } catch (e) {
      return { error: `create_dir:建不出来 ${p}：${e.message}` };
    }
  }
  if (name === 'rename_file') {
    const p = target(args.path);
    const np = target(args.new_path || args.to);
    const guard = await guardRemotePath(np, projectRoot);
    if (guard) return guard;
    try {
      await remote.sftp.stat(hostRow, p);
    } catch (e) {
      return { error: `rename_file:远端原文件不存在:${p}`, path: p };
    }
    const opId = recordRemote(hostRow, { path: np, oldPath: p, type: 'rename', existed: true, isDir: false, buf: null }, chatId, `重命名远端 ${base(p)}`);
    try {
      await remote.sftp.move(hostRow, p, np);
    } catch (e) {
      return { error: `rename_file:改名失败：${e.message}`, path: p, undo_id: opId };
    }
    return { output: `已重命名远端 ${p} → ${np}`, path: np, new_file: false, undo_id: opId, remote: true };
  }
  return undefined;   // 与文件系统无关的工具：交回 execTool 走本地实现
}

module.exports = {
  setHost, execRemoteTool, rj, guardRemotePath, resolveCwd, posixAbs,
  _internal: { globToRx, remoteGrep, remoteGlob },
};
