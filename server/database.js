const Database = require('better-sqlite3');
const path = require('path');
const { DEFAULT_SETTINGS } = require('./data/defaults');

const dbPath = path.join(__dirname, 'kh.db');
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
  'ALTER TABLE ai_chats ADD COLUMN censored_words TEXT DEFAULT \'\''
];

function runMigrations() {
  for (const sql of MIGRATIONS) {
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

function initDatabase() {
  if (initialized) return;
  createSchema();
  runMigrations();
  insertDefaultData();
  initialized = true;
}

module.exports = { db, initDatabase };
