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
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      md5 TEXT NOT NULL,
      size INTEGER NOT NULL,
      mime_type TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  await run('CREATE INDEX IF NOT EXISTS idx_files_md5 ON files(md5)');

  // 自动迁移：如果 files 表存在 relative_path 列则删除
  const columns = await all("PRAGMA table_info(files)");
  const hasRelativePath = columns.some((col) => col.name === 'relative_path');
  if (hasRelativePath) {
    await run('ALTER TABLE files DROP COLUMN relative_path');
    // eslint-disable-next-line no-console
    console.log('[迁移] 已删除 files.relative_path 列');
  }
}

module.exports = {
  run,
  get,
  all,
  initDb,
  db,
};
