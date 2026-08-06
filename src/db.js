const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'app.db');
const db = new sqlite3.Database(dbPath);
const busyTimeout = Number.parseInt(process.env.SQLITE_BUSY_TIMEOUT_MS || '5000', 10);
db.configure('busyTimeout', Number.isFinite(busyTimeout) ? busyTimeout : 5000);

let operationQueue = Promise.resolve();

function enqueue(operation) {
  const result = operationQueue.then(operation);
  operationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function rawRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      return resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function rawGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      return resolve(row);
    });
  });
}

function rawAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      return resolve(rows);
    });
  });
}

function rawExec(sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => {
      if (err) return reject(err);
      return resolve();
    });
  });
}

function run(sql, params = []) {
  return enqueue(() => rawRun(sql, params));
}

function get(sql, params = []) {
  return enqueue(() => rawGet(sql, params));
}

function all(sql, params = []) {
  return enqueue(() => rawAll(sql, params));
}

function transaction(work) {
  return enqueue(async () => {
    await rawRun('BEGIN IMMEDIATE');
    const tx = { run: rawRun, get: rawGet, all: rawAll };
    try {
      const value = await work(tx);
      await rawRun('COMMIT');
      return value;
    } catch (err) {
      try {
        await rawRun('ROLLBACK');
      } catch (rollbackErr) {
        err.rollbackError = rollbackErr;
      }
      throw err;
    }
  });
}

async function addMissingFileColumns() {
  const columns = await rawAll('PRAGMA table_info(files)');
  const names = new Set(columns.map((column) => column.name));
  if (!names.has('sha256')) {
    await rawRun('ALTER TABLE files ADD COLUMN sha256 TEXT');
  }
  if (!names.has('storage_key')) {
    await rawRun('ALTER TABLE files ADD COLUMN storage_key TEXT');
  }
  await rawRun('UPDATE files SET storage_key = md5 WHERE storage_key IS NULL OR storage_key = ?', ['']);
}

async function createIntegrityTriggers() {
  await rawExec(`
    DROP TRIGGER IF EXISTS trg_folder_parent_insert;
    DROP TRIGGER IF EXISTS trg_folder_parent_update;
    DROP TRIGGER IF EXISTS trg_folder_cycle_update;
    DROP TRIGGER IF EXISTS trg_folder_duplicate_insert;
    DROP TRIGGER IF EXISTS trg_folder_duplicate_update;
    DROP TRIGGER IF EXISTS trg_user_file_insert;
    DROP TRIGGER IF EXISTS trg_user_file_update;
    DROP TRIGGER IF EXISTS trg_user_file_duplicate_insert;
    DROP TRIGGER IF EXISTS trg_user_file_duplicate_update;

    CREATE TRIGGER trg_folder_parent_insert
    BEFORE INSERT ON user_folders
    WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id)
      OR (NEW.parent_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM user_folders
        WHERE id = NEW.parent_id AND user_id = NEW.user_id
      ))
    BEGIN
      SELECT RAISE(ABORT, 'invalid folder parent');
    END;

    CREATE TRIGGER trg_folder_parent_update
    BEFORE UPDATE OF parent_id, user_id ON user_folders
    WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id)
      OR (NEW.parent_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM user_folders
        WHERE id = NEW.parent_id AND user_id = NEW.user_id
      ))
    BEGIN
      SELECT RAISE(ABORT, 'invalid folder parent');
    END;

    CREATE TRIGGER trg_folder_cycle_update
    BEFORE UPDATE OF parent_id ON user_folders
    WHEN NEW.parent_id IS NOT NULL
    BEGIN
      SELECT CASE WHEN EXISTS (
        WITH RECURSIVE descendants(id) AS (
          SELECT OLD.id
          UNION
          SELECT f.id
          FROM user_folders f
          JOIN descendants d ON f.parent_id = d.id
          WHERE f.user_id = OLD.user_id
        )
        SELECT 1 FROM descendants WHERE id = NEW.parent_id
      ) THEN RAISE(ABORT, 'folder cycle') END;
    END;

    CREATE TRIGGER trg_folder_duplicate_insert
    BEFORE INSERT ON user_folders
    WHEN EXISTS (
      SELECT 1 FROM user_folders
      WHERE user_id = NEW.user_id AND parent_id IS NEW.parent_id AND name = NEW.name
    )
    BEGIN
      SELECT RAISE(ABORT, 'duplicate folder name');
    END;

    CREATE TRIGGER trg_folder_duplicate_update
    BEFORE UPDATE OF parent_id, name, user_id ON user_folders
    WHEN EXISTS (
      SELECT 1 FROM user_folders
      WHERE user_id = NEW.user_id AND parent_id IS NEW.parent_id
        AND name = NEW.name AND id != OLD.id
    )
    BEGIN
      SELECT RAISE(ABORT, 'duplicate folder name');
    END;

    CREATE TRIGGER trg_user_file_insert
    BEFORE INSERT ON user_files
    WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id)
      OR NOT EXISTS (SELECT 1 FROM files WHERE id = NEW.file_id)
      OR (NEW.folder_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM user_folders
        WHERE id = NEW.folder_id AND user_id = NEW.user_id
      ))
    BEGIN
      SELECT RAISE(ABORT, 'invalid user file reference');
    END;

    CREATE TRIGGER trg_user_file_update
    BEFORE UPDATE OF user_id, folder_id, file_id ON user_files
    WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id)
      OR NOT EXISTS (SELECT 1 FROM files WHERE id = NEW.file_id)
      OR (NEW.folder_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM user_folders
        WHERE id = NEW.folder_id AND user_id = NEW.user_id
      ))
    BEGIN
      SELECT RAISE(ABORT, 'invalid user file reference');
    END;

    CREATE TRIGGER trg_user_file_duplicate_insert
    BEFORE INSERT ON user_files
    WHEN EXISTS (
      SELECT 1 FROM user_files
      WHERE user_id = NEW.user_id AND folder_id IS NEW.folder_id
        AND file_id = NEW.file_id AND name = NEW.name
    )
    BEGIN
      SELECT RAISE(ABORT, 'duplicate user file');
    END;

    CREATE TRIGGER trg_user_file_duplicate_update
    BEFORE UPDATE OF user_id, folder_id, file_id, name ON user_files
    WHEN EXISTS (
      SELECT 1 FROM user_files
      WHERE user_id = NEW.user_id AND folder_id IS NEW.folder_id
        AND file_id = NEW.file_id AND name = NEW.name AND id != OLD.id
    )
    BEGIN
      SELECT RAISE(ABORT, 'duplicate user file');
    END;
  `);
}

async function initDb() {
  return enqueue(async () => {
    await rawGet('PRAGMA journal_mode = WAL');
    await rawRun('PRAGMA synchronous = FULL');
    await rawRun('PRAGMA foreign_keys = ON');

    await rawRun('BEGIN IMMEDIATE');
    try {
      await rawExec(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          password TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          stored_name TEXT NOT NULL,
          storage_key TEXT NOT NULL,
          md5 TEXT NOT NULL UNIQUE,
          sha256 TEXT,
          size INTEGER NOT NULL CHECK (size >= 0),
          mime_type TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS user_folders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          parent_id INTEGER REFERENCES user_folders(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS user_files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          folder_id INTEGER REFERENCES user_folders(id) ON DELETE CASCADE,
          file_id INTEGER NOT NULL REFERENCES files(id),
          name TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER,
          action TEXT NOT NULL,
          target_type TEXT,
          target_id INTEGER,
          detail TEXT,
          ip TEXT,
          user_agent TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
      `);

      await addMissingFileColumns();
      await rawExec(`
        CREATE INDEX IF NOT EXISTS idx_files_md5 ON files(md5);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_files_sha256 ON files(sha256) WHERE sha256 IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_user_folders_list ON user_folders(user_id, parent_id, name);
        CREATE INDEX IF NOT EXISTS idx_user_files_list ON user_files(user_id, folder_id, id DESC);
        CREATE INDEX IF NOT EXISTS idx_user_files_duplicate ON user_files(user_id, folder_id, file_id, name);
        CREATE INDEX IF NOT EXISTS idx_user_files_file ON user_files(file_id);
        CREATE INDEX IF NOT EXISTS idx_logs_user ON logs(user_id);
        CREATE INDEX IF NOT EXISTS idx_logs_action ON logs(action);
        CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at);
      `);
      await createIntegrityTriggers();
      await rawRun('PRAGMA user_version = 2');
      await rawRun('COMMIT');
    } catch (err) {
      await rawRun('ROLLBACK');
      throw err;
    }

    await rawRun('PRAGMA foreign_keys = ON');
  });
}

function closeDb() {
  return enqueue(() => new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) return reject(err);
      return resolve();
    });
  }));
}

module.exports = {
  run,
  get,
  all,
  transaction,
  initDb,
  closeDb,
  db,
  dbPath,
};
