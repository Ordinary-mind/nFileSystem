const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'app.db');
const db = new sqlite3.Database(dbPath);

/**
 * Promise 化 sqlite3#run
 */
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

/**
 * Promise 化 sqlite3#get
 */
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

/**
 * Promise 化 sqlite3#all
 */
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

/**
 * 初始化数据库表
 */
async function initDb() {
  // 用户表
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,                    -- 用户 ID
      name TEXT NOT NULL UNIQUE,                               -- 用户名（唯一）
      password TEXT NOT NULL,                                  -- 密码（bcrypt 哈希）
      created_at TEXT DEFAULT (datetime('now', 'localtime'))   -- 注册时间
    )
  `);

  // 文件物理存储表（按 MD5 去重，一个 MD5 只存一份物理文件）
  await run(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,                    -- 文件 ID
      stored_name TEXT NOT NULL,                               -- 存储文件名（md5 + 扩展名）
      md5 TEXT NOT NULL UNIQUE,                                -- 文件 MD5（唯一标识）
      size INTEGER NOT NULL,                                   -- 文件大小（字节）
      mime_type TEXT,                                          -- MIME 类型
      created_at TEXT DEFAULT (datetime('now', 'localtime'))   -- 入库时间
    )
  `);

  // 用户文件夹表（支持嵌套，parent_id 自引用）
  await run(`
    CREATE TABLE IF NOT EXISTS user_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,                    -- 文件夹 ID
      user_id INTEGER NOT NULL,                                -- 所属用户 ID
      parent_id INTEGER DEFAULT NULL,                          -- 父文件夹 ID（null = 根目录）
      name TEXT NOT NULL,                                      -- 文件夹名称
      created_at TEXT DEFAULT (datetime('now', 'localtime'))   -- 创建时间
    )
  `);

  // 用户文件引用表（关联用户、文件夹、物理文件）
  await run(`
    CREATE TABLE IF NOT EXISTS user_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,                    -- 记录 ID
      user_id INTEGER NOT NULL,                                -- 所属用户 ID
      folder_id INTEGER DEFAULT NULL,                          -- 所在文件夹 ID（null = 根目录）
      file_id INTEGER NOT NULL,                                -- 关联 files 表的物理文件 ID
      name TEXT NOT NULL,                                      -- 用户自定义文件名（可重命名）
      created_at TEXT DEFAULT (datetime('now', 'localtime'))   -- 创建时间
    )
  `);

  // 操作日志表（通用日志，支持各类操作记录）
  await run(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,                    -- 日志 ID
      user_id INTEGER,                                         -- 操作用户 ID（未登录时为 null）
      action TEXT NOT NULL,                                    -- 操作类型：register/login/login_failed/upload/download/delete/rename/move/share/password_change
      target_type TEXT,                                        -- 目标类型：user/file/folder
      target_id INTEGER,                                       -- 目标 ID
      detail TEXT,                                             -- 额外信息（JSON 格式，灵活扩展）
      ip TEXT,                                                 -- 客户端公网 IP
      user_agent TEXT,                                         -- 浏览器 User-Agent
      created_at TEXT DEFAULT (datetime('now', 'localtime'))   -- 记录时间
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS integrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      root_folder_id INTEGER NOT NULL,
      scopes TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS api_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      integration_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      scopes TEXT NOT NULL,
      expires_at TEXT,
      revoked_at TEXT,
      last_used_at TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS access_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      integration_id INTEGER NOT NULL,
      user_file_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      disposition TEXT DEFAULT 'inline',
      expires_at TEXT,
      max_uses INTEGER,
      use_count INTEGER DEFAULT 0,
      revoked_at TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);

  await run('CREATE INDEX IF NOT EXISTS idx_files_md5 ON files(md5)');
  await run('CREATE INDEX IF NOT EXISTS idx_user_folders_user ON user_folders(user_id, parent_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_user_files_user ON user_files(user_id, folder_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_logs_user ON logs(user_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_logs_action ON logs(action)');
  await run('CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at)');
  await run('CREATE INDEX IF NOT EXISTS idx_integrations_user ON integrations(user_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id, integration_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_access_links_token ON access_links(token_hash)');
  await run('CREATE INDEX IF NOT EXISTS idx_access_links_file ON access_links(user_file_id)');
}

module.exports = {
  run,
  get,
  all,
  initDb,
  db,
};
