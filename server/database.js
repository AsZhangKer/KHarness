const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');   // fixFreeChatDefaultCwd 要算「旧默认目录」与桌面的路径
const { DEFAULT_SETTINGS } = require('./data/defaults');
const { DATA_DIR, DB_PATH } = require('./config');
const sqlitefile = require('./utils/sqlitefile');

/**
 * 数据目录不存在就建；库文件不存在就让它按 SQLite 自己的方式新建一份空库，
 * 后面 createSchema() + insertDefaultData() 会把结构和本机默认值补齐。
 *
 * 这里刻意不做「从项目里的 server/kh.db 自动复制」：那是隐式搬运别人的数据，
 * 一旦桌面端和仓库端各自演化，用户就说不清自己看到的到底是哪一份。
 * 搬数据只有一个显式入口：设置 → 关于 → 导入数据库（见 utils/dbio.js），
 * 导入落盘打标记，由下面这行在下次启动的最开头应用。
 */
function prepareDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* 权限问题交给下面的 open 报错 */ }
  const imported = sqlitefile.applyPendingImport();
  // 恢复出厂的标记后落，所以导入 + 恢复出厂同时挂着时，先用导入的结果再清一次不符合直觉 ——
  // 真会同时出现的唯一路径是「导入完立刻点恢复出厂」，那时清掉刚导入的库正是用户想要的
  const wiped = sqlitefile.applyPendingFactoryReset();
  if (!wiped) return imported;
  if (!imported) return { factoryReset: true, ok: wiped.ok, removed: wiped.removed, error: wiped.error };
  // 两件事都做了就都记一笔，别让启动日志只提导入、把清空说丢了；ok 以清空为准
  return { ...imported, factoryReset: true, ok: wiped.ok, removed: wiped.removed, error: wiped.error || imported.error };
}

const importResult = prepareDataDir();
const dbPath = DB_PATH;
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

// KHarness 数据表：模型/提供商/测试结果/对话 + 站点设置
// （桌面端 harness 去鉴权：ai_chats.user_id 保留列但恒为 1，无 users 表）
function createSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ai_providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key TEXT NOT NULL,
      proxy_enabled INTEGER DEFAULT 0,
      proxy_host TEXT DEFAULT '',
      proxy_port INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ai_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id INTEGER NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (provider_id) REFERENCES ai_providers(id) ON DELETE CASCADE,
      UNIQUE (provider_id, model_id)
    );

    -- 每个模型仅保留一次测试结果，新测试覆盖旧结果
    CREATE TABLE IF NOT EXISTS ai_model_results (
      model_row_id INTEGER PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'untested' CHECK(status IN ('ok', 'error')),
      reply TEXT,
      error TEXT,
      latency_ms INTEGER,
      tested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (model_row_id) REFERENCES ai_models(id) ON DELETE CASCADE
    );

    -- 项目：一个项目绑定一个工作目录（root_path），其下可挂多个会话
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ai_chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 1,
      model_row_id INTEGER NOT NULL,
      title TEXT DEFAULT '',
      project_id INTEGER,
      cwd TEXT DEFAULT '',
      plan_mode INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (model_row_id) REFERENCES ai_models(id) ON DELETE CASCADE
    );

    -- 任务列表（Plan 模式：<plan> 标签解析产物，与 ReAct 循环联动）
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','doing','done','failed')),
      error_summary TEXT DEFAULT '',
      seq INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (chat_id) REFERENCES ai_chats(id) ON DELETE CASCADE
    );

    -- token 用量流水（每次上游请求一条；费用按模型单价计算）
    CREATE TABLE IF NOT EXISTS usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER,
      project_id INTEGER,
      model_row_id INTEGER,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      cached_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_log(created_at);

    -- 敏感数据表（默认为空，用户维护）：工具结果进入 AI 上下文前按 pattern 脱敏
    CREATE TABLE IF NOT EXISTS secrets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern TEXT NOT NULL,
      label TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ai_chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (chat_id) REFERENCES ai_chats(id) ON DELETE CASCADE
    );

    -- 回收站：删掉的会话/项目先把整份数据快照进这里，再真删 —— 所以「恢复」是真能把消息拿回来的，
    -- 不是只留一条找不回来的墓碑。payload：kind=chat 时 {chat,messages,tasks}，kind=project 时 {project,chats:[…]}。
    CREATE TABLE IF NOT EXISTS ai_trash (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK(kind IN ('chat','project')),
      ref_id INTEGER NOT NULL,
      title TEXT DEFAULT '',
      path TEXT DEFAULT '',
      payload TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      restored_at DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_trash_created ON ai_trash(created_at);

    -- 撤销快照（落盘 + 建表；重启后历史步骤仍可撤销）
    -- payload 为 NULL 时表示原始内容体积过大，已单独存于 .kh-undo/<op_id>.bin
    CREATE TABLE IF NOT EXISTS undo_ops (
      op_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      path TEXT NOT NULL,
      old_path TEXT DEFAULT '',
      existed INTEGER DEFAULT 0,
      is_dir INTEGER DEFAULT 0,
      payload TEXT,
      payload_file TEXT DEFAULT '',
      chat_id INTEGER,
      label TEXT DEFAULT '',
      -- 已撤销墓碑：撤销后保留记录（快照体积释放），用于禁止重复撤销并持久标注「已撤销」
      undone INTEGER DEFAULT 0,
      undone_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_undo_created ON undo_ops(created_at);

    -- 权限规则：命令 / 路径 / 关键词 三类，黑名单拒绝、白名单免审
    -- list = 'black' | 'white'；match = 'exact' | 'prefix' | 'regex' | 'contains'
    CREATE TABLE IF NOT EXISTS perm_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK(kind IN ('command', 'path', 'keyword', 'tool')),
      list TEXT NOT NULL DEFAULT 'black' CHECK(list IN ('black', 'white')),
      pattern TEXT NOT NULL,
      match TEXT NOT NULL DEFAULT 'contains' CHECK(match IN ('exact', 'prefix', 'regex', 'contains')),
      enabled INTEGER NOT NULL DEFAULT 1,
      note TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 外部 API 工具（联网搜索等）的启用开关与各自的配置；默认无记录 = 关闭
    CREATE TABLE IF NOT EXISTS ai_tools (
      name TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      config TEXT DEFAULT '{}',
      calls INTEGER DEFAULT 0,
      last_call DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 远程 SSH 主机（阶段 5）：一个连接 = 一台机器，下面挂远程项目与远程会话。
    -- secret/private_key 与 ai_providers.api_key 同一口径：明文躺在本机 kh.db，
    -- 这个库本来就握着全部模型密钥，不再单独造一套加密；打包与 .gitignore 已排除 kh.db。
    CREATE TABLE IF NOT EXISTS ai_remote_hosts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 22,
      username TEXT NOT NULL DEFAULT 'root',
      auth TEXT NOT NULL DEFAULT 'password',      -- password | key
      secret TEXT DEFAULT '',                     -- 密码，或私钥的 passphrase
      private_key TEXT DEFAULT '',                -- auth=key 时的私钥正文
      default_cwd TEXT DEFAULT '',                -- 新建远程项目时的起始目录
      home TEXT DEFAULT '',                       -- 「测试连接」时探到的远端家目录，远端回收站放它下面
      sort_order INTEGER DEFAULT 0,
      last_ok DATETIME,
      last_error TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_ai_chats_user ON ai_chats(user_id);
    CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_chat ON ai_chat_messages(chat_id);
  `);
}

// 兼容旧库的增量迁移（try/catch 幂等，重复执行安全）
const MIGRATIONS = [
  'ALTER TABLE ai_providers ADD COLUMN home_url TEXT DEFAULT \'\'',
  'ALTER TABLE ai_models ADD COLUMN remark TEXT DEFAULT \'\'',
  'ALTER TABLE ai_chat_messages ADD COLUMN model_row_id INTEGER',
  'ALTER TABLE ai_chat_messages ADD COLUMN reasoning TEXT',
  'ALTER TABLE ai_chat_messages ADD COLUMN archived INTEGER DEFAULT 0',
  'ALTER TABLE ai_chat_messages ADD COLUMN steps_json TEXT',
  'ALTER TABLE ai_chats ADD COLUMN context_limit INTEGER DEFAULT 0',
  'ALTER TABLE ai_chats ADD COLUMN summary TEXT DEFAULT \'\'',
  'ALTER TABLE ai_chats ADD COLUMN project_id INTEGER',
  'ALTER TABLE ai_chats ADD COLUMN cwd TEXT DEFAULT \'\'',
  'ALTER TABLE ai_chats ADD COLUMN plan_mode INTEGER DEFAULT 0',
  'ALTER TABLE ai_models ADD COLUMN price_in REAL DEFAULT 0',
  'ALTER TABLE ai_models ADD COLUMN price_out REAL DEFAULT 0',
  'ALTER TABLE ai_models ADD COLUMN price_cache REAL DEFAULT 0',
  'ALTER TABLE ai_models ADD COLUMN disabled INTEGER DEFAULT 0',
  'ALTER TABLE ai_models ADD COLUMN max_context INTEGER DEFAULT 0',
  'ALTER TABLE ai_models ADD COLUMN supports_search INTEGER DEFAULT 0',
  'ALTER TABLE ai_models ADD COLUMN supports_thinking INTEGER DEFAULT 0',
  'ALTER TABLE ai_models ADD COLUMN thinking_levels TEXT DEFAULT \'\'',
  'ALTER TABLE ai_chats ADD COLUMN temperature REAL DEFAULT 0.7',
  'ALTER TABLE ai_chats ADD COLUMN frequency_penalty REAL DEFAULT 0',
  'ALTER TABLE ai_chats ADD COLUMN presence_penalty REAL DEFAULT 0',
  'ALTER TABLE ai_chats ADD COLUMN search_enabled INTEGER DEFAULT 0',
  'ALTER TABLE ai_chats ADD COLUMN search_strategy TEXT DEFAULT \'turbo\'',
  'ALTER TABLE ai_chats ADD COLUMN thinking_level TEXT DEFAULT \'\'',
  'ALTER TABLE ai_chats ADD COLUMN censored_words TEXT DEFAULT \'\'',
  'ALTER TABLE ai_chat_messages ADD COLUMN unfinished INTEGER DEFAULT 0',
  'ALTER TABLE ai_chats ADD COLUMN sort_order INTEGER DEFAULT 0',
  'ALTER TABLE projects ADD COLUMN sort_order INTEGER DEFAULT 0',
  // 工具调用风格：auto 自动（原生 function calling，失败回退文本协议）/ native 仅原生 / text 强制文本 JSON 协议
  'ALTER TABLE ai_models ADD COLUMN tool_style TEXT DEFAULT \'auto\'',
  'ALTER TABLE ai_models ADD COLUMN tool_fail_count INTEGER DEFAULT 0',
  // 该模型实测可用的思考参数样式（记住后不再逐次试错）
  'ALTER TABLE ai_models ADD COLUMN thinking_style TEXT DEFAULT \'\'',
  // 审批模式改为按会话持久化（不再用进程内 Map，避免多窗口互相覆盖）
  'ALTER TABLE ai_chats ADD COLUMN approval_mode TEXT DEFAULT \'\'',
  // 撤销快照与会话绑定（重启后仍可撤销历史步骤）
  'ALTER TABLE undo_ops ADD COLUMN chat_id INTEGER',
  'ALTER TABLE undo_ops ADD COLUMN label TEXT DEFAULT \'\'',
  // 用户侧命令：/insert 预埋提示词缓冲区（JSON 数组，安全边界注入后清空）、/skills-load 勾选的技能（JSON 数组，会话级持续注入）
  'ALTER TABLE ai_chats ADD COLUMN insert_buffer TEXT DEFAULT \'\'',
  'ALTER TABLE ai_chats ADD COLUMN loaded_skills TEXT DEFAULT \'\'',
  // 托管模式：一条会话里两种角色同屏，靠 speaker 区分。
  // 默认必须是空串而不是 'worker' —— ALTER 给存量行填的就是这个默认值，
  // 填 'worker' 会让所有旧对话的 AI 气泡一夜之间变成「执行」。
  'ALTER TABLE ai_chat_messages ADD COLUMN speaker TEXT DEFAULT \'\'',
  // 远程工作区（阶段 5）：不另起一套表，项目/会话都复用现有的那一套（列表、消息、轨迹、撤销、
  // 审批、监工全都跟着走），只靠 remote_id 区分这条记录属于哪台机器。NULL/0 = 本机。
  // root_path/cwd 存的是远端的绝对路径（如 /srv/app），只在 remote_id 非空时才有远端语义。
  'ALTER TABLE projects ADD COLUMN remote_id INTEGER',
  'ALTER TABLE ai_chats ADD COLUMN remote_id INTEGER',
  // 远程操作的撤销：remote_id 非空表示这条记录要「推回远端」而不是写本地磁盘；
  // note 存远端回收站的暂存全路径（删除目录没有本地快照，撤销就是把文件从那里 rename 回来）
  'ALTER TABLE undo_ops ADD COLUMN remote_id INTEGER',
  'ALTER TABLE undo_ops ADD COLUMN note TEXT DEFAULT \'\'',
  // 上下文真实锚点：上一轮上游回执的 prompt+completion（那一整包的实测 token）+ 当时最后一条消息 id。
  // 「已用上下文」与「达 80% 自动压缩」一律按「锚点 + 锚点之后新增正文的估算」算。
  // 只估正文会低估到离谱：实测三条短消息的会话正文 38 tok，而真正发给上游的整包 ≈ 5619 tok
  // （system 提示词 + 37 个工具的 schema 就有 ~3900 tok，正文之外全没算进去）。
  'ALTER TABLE ai_chats ADD COLUMN ctx_anchor_tokens INTEGER DEFAULT 0',
  'ALTER TABLE ai_chats ADD COLUMN ctx_anchor_msg_id INTEGER DEFAULT 0'
];

// 上游协议：openai（默认，现状行为）/ anthropic / custom（用户自填端点与字段映射）
// max_tokens 仅 anthropic 用（0 = 不发送该参数，空 = 8192）；custom 存自定义协议的 JSON 配置
const PROTOCOL_MIGRATIONS = [
  'ALTER TABLE ai_providers ADD COLUMN api_style TEXT DEFAULT \'openai\'',
  'ALTER TABLE ai_providers ADD COLUMN max_tokens INTEGER DEFAULT 0',
  'ALTER TABLE ai_providers ADD COLUMN custom TEXT DEFAULT \'\''
];

// 撤销墓碑：撤销后保留记录（快照体积已释放），用于禁止重复撤销并持久标注「已撤销」
const UNDO_MIGRATIONS = [
  'ALTER TABLE undo_ops ADD COLUMN undone INTEGER DEFAULT 0',
  'ALTER TABLE undo_ops ADD COLUMN undone_at DATETIME'
];

// 数据修复：早期版本把「空回复」也记为可用并记录了延迟，这里统一改判不可用并清掉延迟，
// 以免这些模型继续出现在测速统计 / 延迟排序里（幂等，可重复执行）
const DATA_FIXUPS = [
  "UPDATE ai_model_results SET status = 'error', latency_ms = NULL, " +
  "error = COALESCE(NULLIF(error, ''), '历史空回复记录，已按不可用处理') " +
  "WHERE status = 'ok' AND (reply IS NULL OR trim(reply) = '' OR reply LIKE '%空回复%')",
  // 早期回合级 cwd 校验借用了本机 fs.statSync：远程会话的 '/home/ker' 在 Windows 上被看成
  // 'D:\home\ker' → 判「目录不存在」→ 掉回本机默认目录并写回库里，之后每条远端命令的 cd 前置都失败。
  // 这里按「远端项目根 → 连接起始目录 → 家目录」重填；判据是首字符不是 '/'（含空串与盘符路径）。
  "UPDATE ai_chats SET cwd = COALESCE(" +
  "(SELECT CASE WHEN substr(p.root_path,1,1)='/' THEN p.root_path END FROM projects p WHERE p.id = ai_chats.project_id)," +
  "(SELECT CASE WHEN substr(h.default_cwd,1,1)='/' THEN h.default_cwd END FROM ai_remote_hosts h WHERE h.id = ai_chats.remote_id)," +
  "(SELECT CASE WHEN substr(h.home,1,1)='/' THEN h.home END FROM ai_remote_hosts h WHERE h.id = ai_chats.remote_id)," +
  "'/')" +
  " WHERE remote_id IS NOT NULL AND substr(COALESCE(cwd,''),1,1) <> '/'",
  // 终端的「管理员权限」开关撤了（走 UAC 代理会把新建终端整个卡住）；这行设置再没人读，顺手清掉，
  // 免得以后有人看见 term_admin='1' 以为还有这条能力。
  "DELETE FROM settings WHERE key = 'term_admin'"
];

function runMigrations() {
  for (const sql of [...MIGRATIONS, ...UNDO_MIGRATIONS, ...PROTOCOL_MIGRATIONS, ...DATA_FIXUPS]) {
    try {
      db.prepare(sql).run();
    } catch (e) {
      if (!/duplicate column/i.test(e.message)) {
        console.error('[migration] failed:', sql, e.message);
      }
    }
  }
}

function insertDefaultData() {
  const ensureSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    ensureSetting.run(key, value);
  }
}

let initialized = false;

/**
 * 自由会话（没挂项目、也不是远程）的默认工作目录从「程序根」改成了「当前用户桌面」。
 * 这里只补三种：cwd 空的、等于旧默认（程序根）的 —— 自己选过目录的一律不动，
 * 项目会话与远程会话不动。
 */
function fixFreeChatDefaultCwd() {
  try {
    const desk = require('./utils/userdir').desktop();
    if (!desk) return;
    const legacy = path.join(__dirname, '..');   // 旧 AGENT_DEFAULT_CWD：仓库根 / 装机版的 resources\server
    const upd = db.prepare('UPDATE ai_chats SET cwd = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    const hit = db.prepare('SELECT id, cwd FROM ai_chats WHERE project_id IS NULL AND remote_id IS NULL').all()
      .filter((r) => { const c = String(r.cwd || '').trim(); return !c || c === legacy || c === legacy + path.sep; });
    if (!hit.length) return;
    const tx = db.transaction(() => { for (const r of hit) upd.run(desk, r.id); });
    tx();
    console.log(`[fixup] ${hit.length} 条自由会话的默认工作目录改为桌面：${desk}`);
  } catch (e) { /* 修不上也不能拦启动 */ }
}

function initDatabase() {
  if (initialized) return;
  createSchema();
  runMigrations();
  insertDefaultData();
  fixFreeChatDefaultCwd();
  initialized = true;
}

/**
 * 把当前库整份复制到另一个目录（用 SQLite 的在线备份 API，不是拷文件 ——
 * WAL 开着的时候直接 copy 文件会拿出一份撕裂的库）。
 * 目标目录已有 kh.db 就什么都不做（「有则使用」），返回 used_existing 让上层告诉用户。
 */
async function copyDbTo(dir) {
  const to = path.resolve(String(dir || ''));
  if (!path.isAbsolute(to)) throw new Error('要一个绝对路径');
  try { fs.mkdirSync(to, { recursive: true }); } catch (e) { throw new Error(`建不出目录：${e.message}`); }
  const probe = path.join(to, '.kh-write-test');
  try { fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe); } catch (e) { throw new Error(`目标目录写不进去：${e.message}`); }
  const target = path.join(to, 'kh.db');
  if (fs.existsSync(target)) return { file: target, used_existing: true };
  await db.backup(target);
  const bytes = fs.existsSync(target) ? fs.statSync(target).size : 0;
  return { file: target, used_existing: false, bytes };
}

function dbFile() {
  let size = 0;
  try { size = fs.statSync(DB_PATH).size; } catch (e) { /* 还没建出来就是 0 */ }
  return { dir: DATA_DIR, file: DB_PATH, bytes: size };
}

// runMigrations 单独导出：DATA_FIXUPS 是幂等的，自测与「导入库后重建索引」这类
// 需要再跑一遍修复的场合不必绕开 initialized 标记重跑 initDatabase
module.exports = {
  db, initDatabase, runMigrations, runFreeChatFixup: fixFreeChatDefaultCwd,
  dataHome: { path: dbPath, importResult },
  dbFile, copyDbTo,
  markFactoryReset: sqlitefile.markFactoryReset,
};
