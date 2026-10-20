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
      model_row_id INTEGER,
      title TEXT DEFAULT '',
      project_id INTEGER,
      cwd TEXT DEFAULT '',
      plan_mode INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      -- 删模型只该让会话「暂时没选模型」（前端回落到全局默认），不该把整段对话一起带走
      FOREIGN KEY (model_row_id) REFERENCES ai_models(id) ON DELETE SET NULL
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

    -- 会话消息的「部件」（第一百一十五轮，照 opencode 的 message parts 落地）。
    --
    -- 为什么要这张表：以前工具调用与工具结果只活在内存里的 upstreamMsgs 里，回合结束即消失，
    -- 于是模型下一轮真的「忘了刚读的文件」，用量口径也被迫在「下一发」与「这一发」之间二选一 ——
    -- 显示要么虚高要么塌回去。现在工具往返和正文一样落库、一样参与下一发的装配。
    --
    -- turn_id = 这一部件所属回合的**用户消息行 id**（回合开始时就已经存在，所以不需要等回合结束
    -- 才有归属；跑崩了也不会留下一堆认领不到主人的孤儿部件）。
    -- 顺序靠自增 id：同一回合内 tool_call → tool_result → tool_call 必须严格按这个顺序重放，
    -- 否则上游会收到「tool 结果在 assistant 调用之前」这种非法序列。
    CREATE TABLE IF NOT EXISTS ai_chat_parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      turn_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('text', 'tool_call', 'tool_result')),
      call_id TEXT DEFAULT '',
      name TEXT DEFAULT '',
      payload TEXT DEFAULT '',
      meta TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (chat_id) REFERENCES ai_chats(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_ai_chat_parts_turn ON ai_chat_parts(turn_id);
    CREATE INDEX IF NOT EXISTS idx_ai_chat_parts_chat ON ai_chat_parts(chat_id);

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
  // 请求体里「正文之外」那部分（system 提示词 + 工具 schema + 固定头）的实测开销。
  // 锚点减掉当时的正文就得到它，于是撤回消息 / 导入会话时能按「开销 + 剩余正文」把用量
  // 绝对落回去 —— 以前只按正文扣，扣完还剩一大坨开销，右侧百分比看着像一点没降（第七十六轮他报的那条）。
  'ALTER TABLE ai_chats ADD COLUMN ctx_overhead_tokens INTEGER DEFAULT 0',
  'ALTER TABLE ai_chats ADD COLUMN ctx_anchor_msg_id INTEGER DEFAULT 0',
  // 上下文「高水位」：本会话见过的最大用量。他要的口径是「宁多不少、只涨不跌」——
  // 锚点被下一次真实回执校准回小值、或生成期那份整包估算过期时，界面用量不能往回缩；
  // 只有压缩（手动/自动）和撤回消息才允许把它降下来。
  'ALTER TABLE ai_chats ADD COLUMN ctx_high_water_tokens INTEGER DEFAULT 0',
  // 上下文账第八十二轮续：`estimateTokens` 那把尺和真实 tokenizer 差多少，没人知道，也不该猜。
  // 于是把「上一发的本地整包估算」与「同一发的上游真实回执」配成一对存下来 —— 比值就是这把尺的校准系数。
  // ctx_overhead_est 同理：每次真发请求前顺手量一次「system 提示词 + 工具 schema」那部分的本地估算
  // （不含任何工具结果），这样即使一条回执都没拿到，用量也不至于退回「只剩正文」那种离谱的小值。
  'ALTER TABLE ai_chats ADD COLUMN ctx_est_calib REAL DEFAULT 0',
  'ALTER TABLE ai_chats ADD COLUMN ctx_overhead_est INTEGER DEFAULT 0',
  // 「正文之外那坨」的**真实值**：拿上游回执的 prompt_tokens 减去「历史 + 本发工具结果」的估算得来。
  // ctx_overhead_est 是本地那把尺量出来的（system + 工具 schema），量级对但绝对值有偏差；
  // ctx_overhead_tokens 是「整包 − 当时正文」倒推的混合量（含工具结果，虚高好几倍，已降级为历史数据）。
  // 这一列是第三种：真实回执做锚、本地估算做差 —— 既不是纯估算，也不含工具结果。
  // 用量显示优先读它，退回 est，再退回全机参照值。
  'ALTER TABLE ai_chats ADD COLUMN ctx_overhead_real INTEGER DEFAULT 0',
  // 「上游实测出来的真实天花板」：只有当上游**真的以输入超长拒了一整包**时才写，
  // 值就是那一发的整包大小（本地估 × 校准系数）—— 它既然被拒，真实上限必定低于它。
  //
  // 为什么必须有这一列：模型的 max_context 常常是 0（一百多个模型全是 0，探测接口又探不到），
  // 于是窗口落到全局 default_context_limit，而它被设成了 1000000。60% 的自动压缩线就落在
  // 60 万 token —— 绝大多数真实模型根本装不下，压缩**永远不触发**，历史只能靠截断静默丢，
  // 表现就是「模型刚说完就忘」。有了这列，resolveContextWindow 会取
  // min(配置窗口, 实测天花板)，压缩线随之落到真实量级上，下一次就不会再撞墙。
  'ALTER TABLE ai_chats ADD COLUMN ctx_ceiling_tokens INTEGER DEFAULT 0',
  // 整包校准尺（第一百零七轮）：`ctx_est_calib` 只用「没有工具结果的那一发」校准（那样才不把
  // 工具结果的估偏算进正文的尺子里），但生成期「这一发整包」恰恰就是工具结果占大头 —— 拿正文那把尺
  // 去量它，实测低估 2.4 倍（真库 chat 73：本地估 82k，上游真实 prompt 194k）。于是压缩判定
  // 永远到不了 60%，真包一路涨到上游拒收，再被超长自救静默裁掉 —— 这就是「没压缩上下文也自己变小」。
  // 这一列是**整包**的校准尺（每一发都参与，含工具轮），只用于「生成期这一包」和压缩判定。
  'ALTER TABLE ai_chats ADD COLUMN ctx_pkg_calib REAL DEFAULT 0',
  // 真实见过的最大 prompt_tokens（上游回执）。用来给「全局默认」那个手填的假窗口封顶：
  // 出厂 default_context_limit = 1000000，而真实模型装不下，拿它当分母等于压缩永不触发。
  'ALTER TABLE ai_chats ADD COLUMN ctx_peak_prompt INTEGER DEFAULT 0',
  // 锚点配套的「正文估算」（第一百一十二轮，参考 opencode / deepseek-harness 的 token meter）：
  // 用量只回答一个问题 —— 下一发有多大。而「下一发」= 最近一次上游实测的 prompt（真 token）
  // + 自那一刻起本地新增的正文（估算）。所以光有锚点不够，还得记住**记锚点那一刻的正文有多大**，
  // 否则「新增量」无从算起。这一列配 ctx_anchor_tokens 使用：
  //   used = ctx_anchor_tokens + 尺 × (正文现在 − ctx_anchor_body) + 尺 × 未入库输出
  // 两个参照（真锚点 + 估算增量）各管一段，误差只随「增量」放大，不随整段历史放大。
  'ALTER TABLE ai_chats ADD COLUMN ctx_anchor_body INTEGER DEFAULT 0',
  // Agent / 只读 两个开关的会话级持久化（第六十二轮）：-1 = 这条会话从没手动开关过，跟随全局默认；
  // 0/1 = 用户在这条会话上显式选过。以前它们只有前端 localStorage 一份（nu_agent/nu_readonly），
  // 于是「切会话把别的会话的开关也改了」，刷新也只有一份全局值。
  'ALTER TABLE ai_chats ADD COLUMN agent_mode INTEGER DEFAULT -1',
  'ALTER TABLE ai_chats ADD COLUMN readonly INTEGER DEFAULT -1',
  // 本轮 token 明细（{prompt,completion,cached,reasoning,rounds} 一份 JSON）：
  // 右栏「用量信息」那四格以前只活在 SSE done 帧的内存里，一刷新就归零，
  // 也从来没有「上一轮的结果」可看（他第七十四轮报的那条）。回合末随 assistant 消息落库。
  'ALTER TABLE ai_chat_messages ADD COLUMN usage_json TEXT'
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
  // 早期回合级 cwd 校验借用了本机 fs.statSync：远程会话的 '/home/user' 在 Windows 上被看成
  // 'D:\home\user' → 判「目录不存在」→ 掉回本机默认目录并写回库里，之后每条远端命令的 cd 前置都失败。
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

/**
 * 「删模型不该连带删掉会话」（第六十二轮 ⑤）。
 *
 * 旧库的 ai_chats 把这一列写死成 `model_row_id INTEGER NOT NULL` +
 * `FOREIGN KEY ... ON DELETE CASCADE`，而 SQLite 既不能原地改列也不能改外键动作。
 * 三条捷径都实测过、全被库堵住：置空撞 NOT NULL，填 0 当「未指定」撞外键，
 * 只去掉 NOT NULL 而 CASCADE 还留着时删模型会话照样没（这个库的 foreign_keys 是 1，
 * better-sqlite3 这份编译默认就开着外键，全仓从没显式设过它）。
 * 所以只能按官方 safe-alter 流程重建一次这张表。
 *
 * 新 DDL 由 sqlite_master 里那份原文改写而来 —— 历史上 ALTER 加过的列全都在这段原文里，
 * 照抄比重新写一份 DDL 安全。改写结果必须同时不再含 NOT NULL 和 ON DELETE CASCADE，
 * 任一条不对就整体放弃：宁可保留旧行为，也不能建出一张缺列的表。
 * 备份没做成也不重建（这是会动的唯一一次，不能没有退路）。
 * 判据本身幂等：新形状的原文两个特征都不存在，第二次启动直接跳过。
 */
function migrateChatModelNullable() {
  let ddl = '';
  try {
    ddl = String(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ai_chats'").get()?.sql || '');
  } catch (e) { return; }
  const isNotNull = /model_row_id\s+INTEGER\s+NOT\s+NULL/i;
  const isCascade = /REFERENCES\s+ai_models\s*\(\s*id\s*\)\s+ON\s+DELETE\s+CASCADE/i;
  if (!isNotNull.test(ddl) && !isCascade.test(ddl)) return;

  const next = ddl
    .replace(isNotNull, 'model_row_id INTEGER')
    .replace(/FOREIGN KEY \(model_row_id\) REFERENCES ai_models\s*\(\s*id\s*\) ON DELETE CASCADE/i,
      'FOREIGN KEY (model_row_id) REFERENCES ai_models(id) ON DELETE SET NULL')
    .replace(/CREATE TABLE\s+(IF NOT EXISTS\s+)?(["`']?)ai_chats\2\s*\(/i, 'CREATE TABLE "ai_chats_new" (');
  if (next === ddl || isNotNull.test(next) || isCascade.test(next) || !/ai_chats_new/.test(next)) {
    console.error('[migration] ai_chats 的建表原文和预期形状不符，跳过重建：删模型仍会连带删掉会话（原文：' + ddl.slice(0, 200) + '）');
    return;
  }

  try {
    db.pragma('wal_checkpoint(TRUNCATE)');   // 先把 WAL 收进主文件，copyFile 才拿得到完整一份
    const bak = path.join(DATA_DIR, 'kh.db.bak-before-model-fk');
    if (!fs.existsSync(bak)) fs.copyFileSync(DB_PATH, bak);
  } catch (e) {
    console.error('[migration] 重建前的整库备份没做成，放弃本次重建（不备份不动这张表）：', e.message);
    return;
  }

  const cols = db.prepare('PRAGMA table_info(ai_chats)').all().map((c) => `"${c.name}"`).join(', ');
  const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='ai_chats' AND sql IS NOT NULL")
    .all().map((r) => r.sql);
  db.pragma('foreign_keys = OFF');   // 必须在事务外；事务里这句是空操作
  try {
    db.transaction(() => {
      db.exec(next);
      db.exec(`INSERT INTO "ai_chats_new" (${cols}) SELECT ${cols} FROM "ai_chats"`);
      db.exec('DROP TABLE "ai_chats"');            // 索引随表一起消失，下面按原 SQL 建回来
      db.exec('ALTER TABLE "ai_chats_new" RENAME TO "ai_chats"');
      for (const sql of indexes) db.exec(sql);
    })();
    const rows = db.prepare('SELECT COUNT(*) c FROM ai_chats').get().c;
    const bad = db.prepare('PRAGMA foreign_key_check').all();
    console.log(`[migration] ai_chats 已重建：model_row_id 可为空、删模型改为置空引用（${rows} 条会话原样保留${bad.length ? `；外键检查有 ${bad.length} 处不一致` : ''}）`);
  } catch (e) {
    console.error('[migration] ai_chats 重建失败，表保持原样：', e.message);
  } finally {
    db.pragma('foreign_keys = ON');
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
 * 「支持思考」这一列现在开始真正生效（勾掉就一个思考参数都不发，见 routes/ai.js）。
 * 但它建列以来一直被写入、从没被读过：老库里几乎全是默认 0，直接生效等于把用户所有模型的
 * 思考参数一夜之间停掉。所以启动时补一次 0→1，把「从没动过这个勾」和「明确说不要思考」分开。
 *
 * 只跑一次（用 settings 打标记）：否则用户后来真去取消勾选，下次启动又被补回来。
 */
function backfillThinkingSupport() {
  try {
    const marked = db.prepare("SELECT value FROM settings WHERE key = 'thinking_support_backfilled'").get();
    if (marked && String(marked.value) === '1') return;
    const upd = db.prepare('UPDATE ai_models SET supports_thinking = 1 WHERE supports_thinking = 0');
    const res = upd.run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('thinking_support_backfilled', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
    if (res.changes) console.log(`[fixup] ${res.changes} 个模型的「支持思考」补成默认开启（这一列此前不生效，0 全是历史默认值而非用户选择）`);
  } catch (e) { /* 补不上也不拦启动 */ }
}

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

/**
 * 上下文用量口径重定（第一百轮）：显示值从「锚点 / 高水位 / 生成期整包三者取大」
 * 改成「下一发真正要发出去的那一包」（= system 提示词 + 工具 schema + 摘要 + 未归档消息）。
 *
 * 问题是旧库里存着的 `ctx_high_water_tokens` 全是在旧口径下算出来的，而且它**只涨不落**：
 * 生成期那份含工具结果的整包估算把峰值钉在了几十万 token（实测装机版真库 chat 63 是 259794，
 * 按新口径只有 29213；chat 73 是 203013 对 41866）。新口径仍然靠高水位保证「同一条会话内不往回缩」，
 * 所以这些旧假峰值会继续顶在显示上，看着就跟没修一样。
 *
 * 一次性清零即可：高水位会被新口径在第一次读数时按真值重新抬起来（打开会话那次 GET 就会抬）。
 * 只跑一次（settings 打标记），否则用户以后压出来的正常峰值会被下次启动抹掉。
 */
function rebaseContextHighWater() {
  try {
    const marked = db.prepare("SELECT value FROM settings WHERE key = 'ctx_high_water_rebased'").get();
    if (marked && String(marked.value) === '1') return;
    const res = db.prepare('UPDATE ai_chats SET ctx_high_water_tokens = 0').run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('ctx_high_water_rebased', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
    if (res.changes) console.log(`[fixup] ${res.changes} 条会话的上下文高水位按新口径重定（旧值是「含工具结果那一发」的假峰值，会顶住显示不让它动）`);
  } catch (e) { /* 补不上也不拦启动 */ }
}

/**
 * 上下文口径重定（第一百一十五轮）：工具往返入库之后，锚点改成「整包」语义。
 *
 * 旧锚点的配套值 `ctx_anchor_body` 是「库内正文估算」（不含 system 与工具 schema），
 * 而新公式里的锚点是「那一发整包的本地估算」（含两者）。语义不同直接混用会让
 * used 多算一整坨开销（实测约 13k）。
 *
 * 处理：一次性把锚点清零 —— 下一条消息会把真值重新记上，中间这一小段退回「整包 × 尺」，
 * 那是量级正确的。只跑一次（settings 打标记），否则以后正常的锚点会被下次启动抹掉。
 */
function rebaseContextAnchors() {
  try {
    const marked = db.prepare("SELECT value FROM settings WHERE key = 'ctx_anchor_pkg_based'").get();
    if (marked && String(marked.value) === '1') return;
    const res = db.prepare('UPDATE ai_chats SET ctx_anchor_tokens = 0, ctx_anchor_body = 0').run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('ctx_anchor_pkg_based', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
    if (res.changes) console.log(`[fixup] ${res.changes} 条会话的上下文锚点按「整包」口径重定（旧值是只算正文的旧口径，混用会多算一整坨开销）`);
  } catch (e) { /* 补不上也不拦启动 */ }
}

function initDatabase() {
  if (initialized) return;
  createSchema();
  runMigrations();
  // 放在 runMigrations 之后：重建用的是「补齐所有历史列之后」的那份原文
  migrateChatModelNullable();
  insertDefaultData();
  backfillThinkingSupport();
  fixFreeChatDefaultCwd();
  rebaseContextHighWater();
  rebaseContextAnchors();
  unbakeChatContextLimit();
  // 第二遍（第一百一十轮）：上一遍跑完之后，用户那条会话又被老版本建会话时抄进了 1000000，
  // 于是它仍然卡在「会话自己设的窗口」那条分支上、压缩线落在 60 万永远够不着（真库 chat 73）。
  // 同一个动作按新标记再跑一次；行为不变（仍然取到同一个数），差别只是又能走「实测峰值封顶」那条路。
  unbakeChatContextLimit('ctx_chat_limit_unbaked2');
  backfillPeakPrompt();
  recleanContextOverheadReal();
  initialized = true;
}

/**
 * 「正文之外那坨」的存量脏值修复（第一百一十轮）。
 *
 * 病：`ctx_overhead_real` 以前**每一发**都反推一次，包括带工具结果的那几发 ——
 * 反推式里被减掉的「本发工具结果」是几十万 token，它的估算偏差全漏进「剩下的差」里，
 * 于是同一个会话的开销在 9k 与 47k 之间来回跳，界面就是「6% 掉到 3%」。
 * 真库 chat 73 存着 47244，而它第一发请求的真实 prompt 只有 13633。
 *
 * 修法分两步：代码侧改成「只由干净样本反推」（见 calibrateEstimate），这里把**已经写坏的值**清掉，
 * 让那几条会话按新口径从下一发干净轮重新学。判据故意给得宽（真值/估算本来就有 ±30% 的差，
 * val 与 est 的比值落在 0.5~2 之间算正常），只清明显跑飞的。只跑一次（settings 打标记）。
 */
function recleanContextOverheadReal() {
  try {
    const marked = db.prepare("SELECT value FROM settings WHERE key = 'ctx_overhead_real_reclean'").get();
    if (marked && String(marked.value) === '1') return;
    const rows = db.prepare('SELECT id, ctx_overhead_real AS r, ctx_overhead_est AS e FROM ai_chats WHERE ctx_overhead_real > 0').all();
    let n = 0;
    const upd = db.prepare('UPDATE ai_chats SET ctx_overhead_real = 0 WHERE id = ?');
    for (const x of rows) {
      const r = Number(x.r) || 0, e = Number(x.e) || 0;
      // 没有本地估算可比时不动（无从判断真假），只清「和同一发量出来的估算差 2 倍以上」的
      if (e > 0 && (r > e * 2 || r < e * 0.5)) { upd.run(x.id); n++; }
    }
    db.prepare("INSERT INTO settings (key, value) VALUES ('ctx_overhead_real_reclean', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
    if (n) console.log(`[fixup] ${n} 条会话的「正文之外开销」实测值被工具轨迹带偏过，已清零重学（显示会从下一发干净轮回到真值）`);
  } catch (e) { /* 补不上也不拦启动 */ }
}

/**
 * 用库里自己的历史回填「见过最大的那一发」（第一百一十轮）。
 *
 * `ctx_peak_prompt` 是 resolveContextWindow 推断窗口的唯一依据（窗口 = 峰值 × 1.5、压缩线 = 峰值 × 0.9），
 * 但这一列是后来才加的：老会话的历史全在 `usage_log` 里，列里只记着「加列之后」那个小值。
 * 不回填的后果是窗口被算小、压缩线提前 —— 在明明还装得多的模型上做有损摘要。
 * 真库 chat 73：列里 141,678，usage_log 里真实最大 382,656（窗口该是 573,984 而不是 212,517）。
 *
 * 只往上抬，绝不往下改（它的语义是「历史最大」）。只跑一次（settings 打标记）。
 */
function backfillPeakPrompt() {
  try {
    const marked = db.prepare("SELECT value FROM settings WHERE key = 'ctx_peak_prompt_backfilled'").get();
    if (marked && String(marked.value) === '1') return;
    const res = db.prepare(`
      UPDATE ai_chats
         SET ctx_peak_prompt = (SELECT MAX(prompt_tokens) FROM usage_log WHERE usage_log.chat_id = ai_chats.id)
       WHERE COALESCE(ctx_peak_prompt, 0) < (SELECT MAX(prompt_tokens) FROM usage_log WHERE usage_log.chat_id = ai_chats.id)
    `).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = '1'`).run('ctx_peak_prompt_backfilled');
    if (res.changes) console.log(`[fixup] ${res.changes} 条会话的「历史最大一发」按 usage_log 回填（窗口与压缩线据此重算，避免提前做有损摘要）`);
  } catch (e) { /* 补不上也不拦启动 */ }
}

/**
 * 「新建会话把全局默认窗口抄进了会话行」这件事的收尾（第一百零七轮）。
 *
 * 历史行为：新建会话时 `context_limit = default_context_limit`（出厂 1000000）。抄进去之后
 * `resolveContextWindow` 永远命中「会话自己设的」那条分支 —— 于是「按实测峰值给手填的假窗口封顶」
 * 那条路**永远走不到**：窗口一直是 100 万，压缩线落在 60 万 token，真实的包（实测 24 万）永远够不着，
 * 压缩从不触发；真包一路涨到上游拒收，再被超长自救静默裁掉 —— 用户看到的就是
 * 「没压缩，上下文自己变小」「AI 忘记刚读过的工具结果」。
 *
 * 一次把等于全局默认的那些会话行改回 0（= 跟随默认）。行为上**没有变化**（仍然取到同一个数），
 * 差别只是现在能走「实测峰值封顶」那条路了。只跑一次（settings 打标记），
 * 否则用户以后正正经经手填的那个数会被下次启动抹掉。
 */
function unbakeChatContextLimit(marker = 'ctx_chat_limit_unbaked') {
  try {
    const marked = db.prepare('SELECT value FROM settings WHERE key = ?').get(marker);
    if (marked && String(marked.value) === '1') return;
    /* 第一百一十三轮：**不再真的清值**，只打标记。
     *
     * 它当年要解决的问题是「新建会话把全局默认 1000000 抄进会话行，于是那条会话永远卡在
     * 『会话自己设了窗口』这条分支上，压缩线落在永远到不了的 60 万」。这个问题的**根**现在由
     * resolveContextWindow 的分母解决了（分母 = min(你设的, 实测能力)，抄进去多少都不影响压缩线）。
     *
     * 而它这个动作本身是有害的：它分不清「出厂时抄的默认值」和「用户刚刚亲手填的同一个数」，
     * 一律清成 0 —— 用户两次报「我设的 1000000 自己没了」，这就是其中一条路径。
     * 从此以后：会话窗口就是用户设的那个数，一个字节都不动。
     */
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = '1'`).run(marker);
  } catch (e) { /* 补不上也不拦启动 */ }
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
  // 测试用：旧库高水位的一次性重定（纯逻辑，单独钉住「只跑一次」这条约定）
  rebaseContextHighWater,
};
