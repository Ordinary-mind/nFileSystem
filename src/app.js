require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const {
  initDb,
  run,
  get,
  all,
  transaction,
  closeDb,
} = require('./db');
const {
  uploadRoot,
  tempRoot,
  ensureStorageDirs,
  withStorageLock,
  calculateHashes,
  getStoragePath,
  finalizeTempFile,
  cleanupTempFiles,
  cleanupStaleTempFiles,
  unlinkIfExists,
  verifyFileRecord,
  isDigest,
} = require('./storage');
const { hashPassword, comparePassword, signToken } = require('./utils/security');
const { authRequired } = require('./middleware/auth');

const app = express();
const PORT = parseIntegerEnv('PORT', 3000, 1, 65535);
const MAX_FILES = parseIntegerEnv('MAX_UPLOAD_FILES', 20, 1, 100);
const MAX_FILE_SIZE = parseIntegerEnv('MAX_FILE_SIZE_BYTES', 50 * 1024 * 1024, 1024, 1024 * 1024 * 1024);
const MAX_UPLOAD_BYTES = parseIntegerEnv('MAX_UPLOAD_BYTES', MAX_FILES * MAX_FILE_SIZE, MAX_FILE_SIZE, 2 * 1024 * 1024 * 1024);
const MAX_UPLOAD_CONCURRENCY = parseIntegerEnv('MAX_UPLOAD_CONCURRENCY', 2, 1, 16);
const USER_QUOTA_BYTES = parseIntegerEnv('USER_QUOTA_BYTES', 10 * 1024 * 1024 * 1024, 0, Number.MAX_SAFE_INTEGER);
const MIN_FREE_BYTES = parseIntegerEnv('MIN_FREE_BYTES', 256 * 1024 * 1024, 0, Number.MAX_SAFE_INTEGER);
const DRIVE_PAGE_SIZE = parseIntegerEnv('DRIVE_PAGE_SIZE', 200, 20, 500);
const MAX_FOLDER_DEPTH = parseIntegerEnv('MAX_FOLDER_DEPTH', 128, 8, 512);
const STALE_TEMP_MAX_AGE_MS = parseIntegerEnv('STALE_TEMP_MAX_AGE_MS', 24 * 60 * 60 * 1000, 60 * 1000, 30 * 24 * 60 * 60 * 1000);

let activeUploads = 0;
let serverInstance = null;
let maintenanceTimer = null;

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function parseIntegerEnv(name, fallback, min, max) {
  const value = Number.parseInt(process.env[name] || String(fallback), 10);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function parseOptionalId(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value);
  if (!/^[1-9]\d*$/.test(text)) throw new HttpError(400, `${fieldName} 不合法`, 'INVALID_ID');
  const id = Number(text);
  if (!Number.isSafeInteger(id)) throw new HttpError(400, `${fieldName} 不合法`, 'INVALID_ID');
  return id;
}

function parseRequiredId(value, fieldName) {
  const id = parseOptionalId(value, fieldName);
  if (id === null) throw new HttpError(400, `${fieldName} 不合法`, 'INVALID_ID');
  return id;
}

function normalizeFileName(value) {
  if (typeof value !== 'string') return null;
  const name = value.normalize('NFC');
  if (!name || name !== name.trim()) return null;
  if (Buffer.byteLength(name, 'utf8') > 255) return null;
  if (/[/\\<>:"|?*\x00-\x1f\x7f]/.test(name)) return null;
  if (name === '.' || name === '..') return null;
  return name;
}

function getRequestBody(req) {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return {};
  return req.body;
}

function parseTrustProxy() {
  const value = process.env.TRUST_PROXY;
  if (!value || value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  if (['loopback', 'linklocal', 'uniquelocal'].includes(value)) return value;
  return false;
}

app.disable('x-powered-by');
app.set('trust proxy', parseTrustProxy());
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  next();
});
app.use(express.json({ limit: '128kb', strict: true }));

const uploader = multer({
  dest: tempRoot,
  limits: {
    files: MAX_FILES,
    fileSize: MAX_FILE_SIZE,
    fields: 4,
    fieldSize: 4096,
    parts: MAX_FILES + 4,
    headerPairs: 100,
  },
  fileFilter: (_req, file, cb) => {
    if (file.originalname) {
      file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    }
    const normalized = normalizeFileName(file.originalname);
    if (!normalized) {
      const err = new Error('文件名不合法');
      err.code = 'INVALID_FILE_NAME';
      return cb(err);
    }
    file.originalname = normalized;
    return cb(null, true);
  },
});

function uploadMiddleware(req, res, next) {
  uploader.array('files', MAX_FILES)(req, res, async (err) => {
    if (!err) return next();
    await cleanupTempFiles(req.files);
    if (err.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ message: '文件字段名必须为 files' });
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ message: `单个文件不能超过 ${Math.floor(MAX_FILE_SIZE / 1024 / 1024)}MB` });
    if (err.code === 'LIMIT_FILE_COUNT') return res.status(413).json({ message: `单次最多上传 ${MAX_FILES} 个文件` });
    if (err.code === 'LIMIT_FIELD_VALUE' || err.code === 'LIMIT_FIELD_COUNT' || err.code === 'LIMIT_PART_COUNT') {
      return res.status(400).json({ message: '上传表单过大或字段过多' });
    }
    if (err.code === 'INVALID_FILE_NAME') return res.status(400).json({ message: '文件名不合法' });
    return next(err);
  });
}

async function uploadCapacity(req, res, next) {
  if (activeUploads >= MAX_UPLOAD_CONCURRENCY) {
    return res.status(503).set('Retry-After', '3').json({ message: '当前上传任务较多，请稍后重试' });
  }

  const contentLength = Number(req.headers['content-length'] || 0);
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    return res.status(400).json({ message: 'Content-Length 不合法' });
  }
  if (contentLength > MAX_UPLOAD_BYTES + 1024 * 1024) {
    return res.status(413).json({ message: '单次上传总大小超出限制' });
  }

  if (MIN_FREE_BYTES > 0 && typeof fs.promises.statfs === 'function') {
    const stat = await fs.promises.statfs(uploadRoot);
    const available = Number(stat.bavail) * Number(stat.bsize);
    if (available < MIN_FREE_BYTES + contentLength) {
      return res.status(507).json({ message: '存储空间不足，请联系管理员' });
    }
  }

  activeUploads++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeUploads--;
  };
  res.once('finish', release);
  res.once('close', release);
  return next();
}

function getClientIp(req) {
  return req.ip || req.socket.remoteAddress || '';
}

function addLog({ userId = null, action, targetType = null, targetId = null, detail = null }, req) {
  const ip = getClientIp(req).slice(0, 128);
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 512);
  run(
    'INSERT INTO logs(user_id, action, target_type, target_id, detail, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [userId, action, targetType, targetId, detail, ip, userAgent]
  ).catch((err) => console.error('操作日志写入失败:', err.message));
}

const authAttempts = new Map();
const AUTH_RATE_LIMIT = parseIntegerEnv('AUTH_RATE_LIMIT', 10, 1, 1000);
const AUTH_RATE_WINDOW_MS = parseIntegerEnv('AUTH_RATE_WINDOW_MS', 60 * 1000, 1000, 60 * 60 * 1000);
const MAX_RATE_LIMIT_KEYS = 10000;

function pruneAuthAttempts(now = Date.now()) {
  for (const [key, record] of authAttempts) {
    if (now >= record.resetTime) authAttempts.delete(key);
  }
}

function authRateLimit(req, res, next) {
  const now = Date.now();
  const key = getClientIp(req);
  let record = authAttempts.get(key);
  if (!record || now >= record.resetTime) {
    if (authAttempts.size >= MAX_RATE_LIMIT_KEYS) pruneAuthAttempts(now);
    if (authAttempts.size >= MAX_RATE_LIMIT_KEYS) authAttempts.delete(authAttempts.keys().next().value);
    record = { count: 0, resetTime: now + AUTH_RATE_WINDOW_MS };
    authAttempts.set(key, record);
  }
  record.count++;
  if (record.count > AUTH_RATE_LIMIT) {
    const retryAfter = Math.max(1, Math.ceil((record.resetTime - now) / 1000));
    return res.status(429).set('Retry-After', String(retryAfter)).json({ message: '认证尝试过于频繁，请稍后再试' });
  }
  return next();
}

const rateLimitTimer = setInterval(pruneAuthAttempts, 5 * 60 * 1000);
rateLimitTimer.unref();

async function assertFolder(tx, folderId, userId, fieldName = '文件夹') {
  if (folderId === null) return null;
  const folder = await tx.get(
    'SELECT id, name, parent_id FROM user_folders WHERE id = ? AND user_id = ?',
    [folderId, userId]
  );
  if (!folder) throw new HttpError(400, `${fieldName}不存在`, 'FOLDER_NOT_FOUND');
  return folder;
}

async function getFolderDepth(tx, folderId, userId) {
  if (folderId === null) return 0;
  const row = await tx.get(`
    WITH RECURSIVE ancestors(id, parent_id, depth, path) AS (
      SELECT id, parent_id, 1, printf('/%d/', id)
      FROM user_folders WHERE id = ? AND user_id = ?
      UNION ALL
      SELECT f.id, f.parent_id, a.depth + 1, a.path || f.id || '/'
      FROM user_folders f
      JOIN ancestors a ON f.id = a.parent_id
      WHERE f.user_id = ? AND a.depth < ?
        AND instr(a.path, printf('/%d/', f.id)) = 0
    )
    SELECT MAX(depth) AS depth FROM ancestors
  `, [folderId, userId, userId, MAX_FOLDER_DEPTH + 1]);
  return row && row.depth ? row.depth : 0;
}

async function getSubtreeDepth(tx, folderId, userId) {
  const row = await tx.get(`
    WITH RECURSIVE descendants(id, depth, path) AS (
      SELECT id, 1, printf('/%d/', id)
      FROM user_folders WHERE id = ? AND user_id = ?
      UNION ALL
      SELECT f.id, d.depth + 1, d.path || f.id || '/'
      FROM user_folders f
      JOIN descendants d ON f.parent_id = d.id
      WHERE f.user_id = ? AND d.depth < ?
        AND instr(d.path, printf('/%d/', f.id)) = 0
    )
    SELECT MAX(depth) AS depth FROM descendants
  `, [folderId, userId, userId, MAX_FOLDER_DEPTH + 1]);
  return row && row.depth ? row.depth : 1;
}

async function getUserUsage(tx, userId) {
  const row = await tx.get(`
    SELECT COALESCE(SUM(f.size), 0) AS total
    FROM user_files uf
    JOIN files f ON f.id = uf.file_id
    WHERE uf.user_id = ?
  `, [userId]);
  return Number(row.total || 0);
}

async function findFileRecordForUpload(tx, prepared) {
  let record = await tx.get(`
    SELECT id, stored_name, storage_key, md5, sha256, size, mime_type
    FROM files WHERE sha256 = ?
  `, [prepared.sha256]);
  if (record) {
    const verification = await verifyFileRecord(record, true);
    if (!verification.ok) {
      throw new HttpError(409, '已有物理文件完整性异常，请先运行存储校验', 'STORAGE_INTEGRITY_ERROR');
    }
    return record;
  }

  record = await tx.get(`
    SELECT id, stored_name, storage_key, md5, sha256, size, mime_type
    FROM files WHERE md5 = ?
  `, [prepared.md5]);
  if (!record) return null;
  if (record.sha256 && record.sha256 !== prepared.sha256) {
    throw new HttpError(409, '检测到摘要冲突，已拒绝写入', 'HASH_COLLISION');
  }

  const existingPath = getStoragePath(record);
  const existingHashes = await calculateHashes(existingPath);
  if (existingHashes.size !== record.size || existingHashes.md5 !== record.md5) {
    throw new HttpError(409, '已有物理文件完整性异常，请先运行存储校验', 'STORAGE_INTEGRITY_ERROR');
  }
  if (existingHashes.sha256 !== prepared.sha256) {
    throw new HttpError(409, '检测到 MD5 冲突，已拒绝写入', 'HASH_COLLISION');
  }
  await tx.run('UPDATE files SET sha256 = ? WHERE id = ?', [prepared.sha256, record.id]);
  record.sha256 = prepared.sha256;
  return record;
}

async function persistUploadBatch(userId, folderId, preparedFiles) {
  return withStorageLock(async () => {
    const createdBlobPaths = [];
    try {
      return await transaction(async (tx) => {
        await assertFolder(tx, folderId, userId);
        let usage = await getUserUsage(tx, userId);
        const saved = [];

        for (const prepared of preparedFiles) {
          let fileRecord = await findFileRecordForUpload(tx, prepared);
          if (fileRecord) {
            await unlinkIfExists(prepared.path);
          } else {
            const finalized = await finalizeTempFile(prepared.path, prepared.sha256, prepared.size);
            if (finalized.created) createdBlobPaths.push(finalized.targetPath);
            const inserted = await tx.run(`
              INSERT INTO files(stored_name, storage_key, md5, sha256, size, mime_type)
              VALUES (?, ?, ?, ?, ?, ?)
            `, [
              finalized.storedName,
              finalized.storageKey,
              prepared.md5,
              prepared.sha256,
              prepared.size,
              prepared.mimeType,
            ]);
            fileRecord = {
              id: inserted.lastID,
              stored_name: finalized.storedName,
              storage_key: finalized.storageKey,
              md5: prepared.md5,
              sha256: prepared.sha256,
              size: prepared.size,
              mime_type: prepared.mimeType,
            };
          }

          const duplicate = await tx.get(`
            SELECT id FROM user_files
            WHERE user_id = ? AND folder_id IS ? AND file_id = ? AND name = ?
          `, [userId, folderId, fileRecord.id, prepared.originalName]);
          if (duplicate) {
            saved.push({
              id: duplicate.id,
              name: prepared.originalName,
              md5: prepared.md5,
              size: prepared.size,
              duplicate: true,
            });
            continue;
          }

          if (USER_QUOTA_BYTES > 0 && usage + fileRecord.size > USER_QUOTA_BYTES) {
            throw new HttpError(413, '用户存储配额不足', 'USER_QUOTA_EXCEEDED');
          }
          const inserted = await tx.run(
            'INSERT INTO user_files(user_id, folder_id, file_id, name) VALUES (?, ?, ?, ?)',
            [userId, folderId, fileRecord.id, prepared.originalName]
          );
          usage += fileRecord.size;
          saved.push({
            id: inserted.lastID,
            name: prepared.originalName,
            md5: prepared.md5,
            size: prepared.size,
            duplicate: false,
          });
        }
        return saved;
      });
    } catch (err) {
      for (const blobPath of createdBlobPaths) {
        try {
          await unlinkIfExists(blobPath);
        } catch (cleanupErr) {
          console.error('回滚物理文件失败:', cleanupErr.message);
        }
      }
      throw err;
    }
  });
}

async function removePhysicalFiles(records) {
  for (const record of records) {
    try {
      await unlinkIfExists(getStoragePath(record));
    } catch (err) {
      console.error(`清理物理文件失败 (file_id=${record.id}):`, err.message);
    }
  }
}

async function deleteUnreferencedRecords(tx, candidates) {
  const removed = [];
  const seen = new Set();
  for (const record of candidates) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    const result = await tx.run(`
      DELETE FROM files
      WHERE id = ? AND NOT EXISTS (SELECT 1 FROM user_files WHERE file_id = files.id)
    `, [record.id]);
    if (result.changes) removed.push(record);
  }
  return removed;
}

async function garbageCollectUnreferencedFiles() {
  return withStorageLock(async () => {
    const removed = await transaction(async (tx) => {
      const records = await tx.all(`
        SELECT id, stored_name, storage_key, md5, sha256, size
        FROM files f
        WHERE NOT EXISTS (SELECT 1 FROM user_files uf WHERE uf.file_id = f.id)
      `);
      return deleteUnreferencedRecords(tx, records);
    });
    await removePhysicalFiles(removed);
    return removed.length;
  });
}

app.get('/healthz', asyncRoute(async (_req, res) => {
  await get('SELECT 1 AS ok');
  await fs.promises.access(tempRoot, fs.constants.R_OK | fs.constants.W_OK);
  res.json({ status: 'ok' });
}));

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/auth/register-status', (_req, res) => {
  res.json({ allowed: process.env.ALLOW_REGISTER === 'true' });
});

app.post('/auth/register', authRateLimit, asyncRoute(async (req, res) => {
  if (process.env.ALLOW_REGISTER !== 'true') throw new HttpError(403, '当前不允许注册');
  const body = getRequestBody(req);
  const name = typeof body.name === 'string' ? body.name.normalize('NFC') : '';
  const password = body.password;
  if (!name || name !== name.trim() || name.length < 2 || name.length > 32) {
    throw new HttpError(400, '用户名长度需为 2-32 位且首尾不能有空格');
  }
  if (typeof password !== 'string' || password.length < 8) {
    throw new HttpError(400, '密码至少 8 位');
  }
  if (Buffer.byteLength(password, 'utf8') > 72) {
    throw new HttpError(400, '密码 UTF-8 编码后不能超过 72 字节');
  }

  const hashed = await hashPassword(password);
  let result;
  try {
    result = await run('INSERT INTO users(name, password) VALUES (?, ?)', [name, hashed]);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT') {
      addLog({ userId: null, action: 'register_failed', detail: JSON.stringify({ name, reason: '用户名已存在' }) }, req);
      throw new HttpError(409, '用户名已存在');
    }
    throw err;
  }
  addLog({ userId: result.lastID, action: 'register', targetType: 'user', targetId: result.lastID }, req);
  res.json({ message: '注册成功' });
}));

app.post('/auth/login', authRateLimit, asyncRoute(async (req, res) => {
  const body = getRequestBody(req);
  const name = typeof body.name === 'string' ? body.name : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!name || !password || name.length > 128 || password.length > 4096) {
    throw new HttpError(400, 'name 和 password 格式不合法');
  }

  const user = await get('SELECT id, name, password FROM users WHERE name = ?', [name]);
  if (!user || !(await comparePassword(password, user.password))) {
    addLog({
      userId: user ? user.id : null,
      action: 'login_failed',
      targetType: user ? 'user' : null,
      targetId: user ? user.id : null,
      detail: JSON.stringify({ name }),
    }, req);
    throw new HttpError(401, '用户名或密码错误');
  }

  authAttempts.delete(getClientIp(req));
  const token = signToken({ id: user.id, name: user.name });
  addLog({ userId: user.id, action: 'login', targetType: 'user', targetId: user.id }, req);
  res.json({ message: '登录成功', token, user: { id: user.id, name: user.name } });
}));

app.post('/files/upload', authRequired, asyncRoute(uploadCapacity), uploadMiddleware, asyncRoute(async (req, res) => {
  const files = req.files || [];
  try {
    if (!files.length) throw new HttpError(400, '请至少上传一个文件，字段名为 files');
    const totalSize = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
    if (totalSize > MAX_UPLOAD_BYTES) throw new HttpError(413, '单次上传总大小超出限制');
    const folderId = parseOptionalId(getRequestBody(req).folderId, 'folderId');

    const prepared = [];
    for (const file of files) {
      const hashes = await calculateHashes(file.path);
      if (hashes.size !== file.size) throw new HttpError(409, '临时文件大小校验失败', 'STORAGE_INTEGRITY_ERROR');
      prepared.push({
        path: file.path,
        originalName: file.originalname,
        mimeType: String(file.mimetype || 'application/octet-stream').slice(0, 255),
        ...hashes,
      });
    }

    const saved = await persistUploadBatch(req.user.id, folderId, prepared);
    addLog({
      userId: req.user.id,
      action: 'upload',
      targetType: 'file',
      detail: JSON.stringify({ count: saved.length, folderId }),
    }, req);
    res.json({ message: '上传成功', count: saved.length, files: saved });
  } finally {
    await cleanupTempFiles(files);
  }
}));

app.post('/files/instant', authRequired, asyncRoute(async (req, res) => {
  const body = getRequestBody(req);
  const { files: fileList } = body;
  if (!Array.isArray(fileList) || !fileList.length) throw new HttpError(400, 'files 必须是非空数组');
  if (fileList.length > 100) throw new HttpError(400, '单次最多秒传 100 个文件');
  const folderId = parseOptionalId(body.folderId, 'folderId');

  const results = await transaction(async (tx) => {
    await assertFolder(tx, folderId, req.user.id);
    let usage = await getUserUsage(tx, req.user.id);
    const output = [];

    for (const item of fileList) {
      if (!item || typeof item !== 'object') {
        output.push({ success: false, message: '文件参数不合法' });
        continue;
      }
      const md5 = typeof item.md5 === 'string' ? item.md5.toLowerCase() : '';
      const originalName = normalizeFileName(item.originalName);
      if (!isDigest(md5, 32) || !originalName) {
        output.push({ md5, originalName: item.originalName, success: false, message: 'md5 或 originalName 不合法' });
        continue;
      }

      // 秒传只复用当前用户已经持有的内容，避免通过摘要取得他人文件。
      const fileRecord = await tx.get(`
        SELECT DISTINCT f.id, f.stored_name, f.storage_key, f.md5, f.sha256, f.size
        FROM files f
        JOIN user_files owned ON owned.file_id = f.id
        WHERE f.md5 = ? AND owned.user_id = ?
      `, [md5, req.user.id]);
      if (!fileRecord) {
        output.push({ md5, originalName, success: false, message: '当前账号没有该文件，请走正常上传' });
        continue;
      }

      const verification = await verifyFileRecord(fileRecord, false);
      if (!verification.ok) {
        output.push({ md5, originalName, success: false, message: '物理文件异常，请重新上传' });
        continue;
      }
      const duplicate = await tx.get(`
        SELECT id FROM user_files
        WHERE user_id = ? AND folder_id IS ? AND file_id = ? AND name = ?
      `, [req.user.id, folderId, fileRecord.id, originalName]);
      if (duplicate) {
        output.push({ md5, originalName, success: true, id: duplicate.id, size: fileRecord.size, duplicate: true });
        continue;
      }
      if (USER_QUOTA_BYTES > 0 && usage + fileRecord.size > USER_QUOTA_BYTES) {
        output.push({ md5, originalName, success: false, message: '用户存储配额不足' });
        continue;
      }

      const inserted = await tx.run(
        'INSERT INTO user_files(user_id, folder_id, file_id, name) VALUES (?, ?, ?, ?)',
        [req.user.id, folderId, fileRecord.id, originalName]
      );
      usage += fileRecord.size;
      output.push({ md5, originalName, success: true, id: inserted.lastID, size: fileRecord.size });
    }
    return output;
  });

  const successCount = results.filter((item) => item.success).length;
  if (successCount) {
    addLog({
      userId: req.user.id,
      action: 'instant_upload',
      targetType: 'file',
      detail: JSON.stringify({ count: successCount, folderId }),
    }, req);
  }
  res.json({ message: `秒传完成，成功 ${successCount}/${results.length}`, results });
}));

app.get('/drive', authRequired, asyncRoute(async (req, res) => {
  const folderId = parseOptionalId(req.query.folderId, 'folderId');
  const search = typeof req.query.name === 'string' ? req.query.name.normalize('NFC') : '';
  if (search.length > 100) throw new HttpError(400, '搜索词过长');
  const limit = req.query.limit === undefined
    ? DRIVE_PAGE_SIZE
    : parseRequiredId(req.query.limit, 'limit');
  if (limit > 500) throw new HttpError(400, 'limit 不能超过 500');
  const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) throw new HttpError(400, 'offset 不合法');

  const data = await transaction(async (tx) => {
    if (folderId !== null) await assertFolder(tx, folderId, req.user.id);
    const escapedSearch = search.replace(/[\\%_]/g, (char) => `\\${char}`);
    const searchPattern = `%${escapedSearch}%`;
    const searchFolderSql = search ? " AND name LIKE ? ESCAPE '\\'" : '';
    const searchFileSql = search ? " AND uf.name LIKE ? ESCAPE '\\'" : '';
    const folderParams = search
      ? [req.user.id, folderId, searchPattern, limit + 1, offset]
      : [req.user.id, folderId, limit + 1, offset];
    const fileParams = search
      ? [req.user.id, folderId, searchPattern, limit + 1, offset]
      : [req.user.id, folderId, limit + 1, offset];

    const folders = await tx.all(`
      SELECT id, name, created_at
      FROM user_folders
      WHERE user_id = ? AND parent_id IS ?${searchFolderSql}
      ORDER BY name
      LIMIT ? OFFSET ?
    `, folderParams);
    const files = await tx.all(`
      SELECT uf.id, uf.name, uf.created_at, f.md5, f.size, f.mime_type
      FROM user_files uf
      JOIN files f ON uf.file_id = f.id
      WHERE uf.user_id = ? AND uf.folder_id IS ?${searchFileSql}
      ORDER BY uf.id DESC
      LIMIT ? OFFSET ?
    `, fileParams);

    let breadcrumb = [];
    if (folderId !== null) {
      breadcrumb = await tx.all(`
        WITH RECURSIVE ancestors(id, name, parent_id, depth, path) AS (
          SELECT id, name, parent_id, 0, printf('/%d/', id)
          FROM user_folders WHERE id = ? AND user_id = ?
          UNION ALL
          SELECT f.id, f.name, f.parent_id, a.depth + 1, a.path || f.id || '/'
          FROM user_folders f
          JOIN ancestors a ON f.id = a.parent_id
          WHERE f.user_id = ? AND a.depth < ?
            AND instr(a.path, printf('/%d/', f.id)) = 0
        )
        SELECT id, name FROM ancestors ORDER BY depth DESC
      `, [folderId, req.user.id, req.user.id, MAX_FOLDER_DEPTH]);
    }
    return {
      folders: folders.slice(0, limit),
      files: files.slice(0, limit),
      breadcrumb,
      page: { limit, offset, hasMore: folders.length > limit || files.length > limit },
    };
  });
  res.json(data);
}));

app.post('/drive/folder', authRequired, asyncRoute(async (req, res) => {
  const body = getRequestBody(req);
  const name = normalizeFileName(body.name);
  if (!name) throw new HttpError(400, '文件夹名不合法');
  const parentId = parseOptionalId(body.parentId, 'parentId');

  const result = await transaction(async (tx) => {
    await assertFolder(tx, parentId, req.user.id, '父文件夹');
    if (await getFolderDepth(tx, parentId, req.user.id) >= MAX_FOLDER_DEPTH) {
      throw new HttpError(400, `文件夹层级不能超过 ${MAX_FOLDER_DEPTH} 层`);
    }
    const existing = await tx.get(`
      SELECT id FROM user_folders WHERE user_id = ? AND parent_id IS ? AND name = ?
    `, [req.user.id, parentId, name]);
    if (existing) throw new HttpError(409, '同名文件夹已存在');
    return tx.run('INSERT INTO user_folders(user_id, parent_id, name) VALUES (?, ?, ?)', [req.user.id, parentId, name]);
  });
  addLog({ userId: req.user.id, action: 'folder_create', targetType: 'folder', targetId: result.lastID }, req);
  res.json({ message: '创建成功', id: result.lastID, name });
}));

app.put('/drive/folder/:id', authRequired, asyncRoute(async (req, res) => {
  const id = parseRequiredId(req.params.id, 'id');
  const name = normalizeFileName(getRequestBody(req).name);
  if (!name) throw new HttpError(400, '文件夹名不合法');

  await transaction(async (tx) => {
    const folder = await tx.get('SELECT id, parent_id FROM user_folders WHERE id = ? AND user_id = ?', [id, req.user.id]);
    if (!folder) throw new HttpError(404, '文件夹不存在');
    const existing = await tx.get(`
      SELECT id FROM user_folders
      WHERE user_id = ? AND parent_id IS ? AND name = ? AND id != ?
    `, [req.user.id, folder.parent_id, name, id]);
    if (existing) throw new HttpError(409, '同名文件夹已存在');
    await tx.run('UPDATE user_folders SET name = ? WHERE id = ? AND user_id = ?', [name, id, req.user.id]);
  });
  addLog({ userId: req.user.id, action: 'folder_rename', targetType: 'folder', targetId: id }, req);
  res.json({ message: '重命名成功' });
}));

app.delete('/drive/folder/:id', authRequired, asyncRoute(async (req, res) => {
  const id = parseRequiredId(req.params.id, 'id');
  const removedFiles = await withStorageLock(async () => {
    const records = await transaction(async (tx) => {
      const folder = await tx.get('SELECT id FROM user_folders WHERE id = ? AND user_id = ?', [id, req.user.id]);
      if (!folder) throw new HttpError(404, '文件夹不存在');
      const tree = `
        WITH RECURSIVE tree(id) AS (
          SELECT id FROM user_folders WHERE id = ? AND user_id = ?
          UNION
          SELECT f.id FROM user_folders f JOIN tree t ON f.parent_id = t.id
          WHERE f.user_id = ?
        )`;
      const candidates = await tx.all(`${tree}
        SELECT DISTINCT f.id, f.stored_name, f.storage_key, f.md5, f.sha256, f.size
        FROM files f JOIN user_files uf ON uf.file_id = f.id
        WHERE uf.user_id = ? AND uf.folder_id IN (SELECT id FROM tree)
      `, [id, req.user.id, req.user.id, req.user.id]);
      await tx.run(`${tree}
        DELETE FROM user_files WHERE user_id = ? AND folder_id IN (SELECT id FROM tree)
      `, [id, req.user.id, req.user.id, req.user.id]);
      await tx.run(`${tree}
        DELETE FROM user_folders WHERE user_id = ? AND id IN (SELECT id FROM tree)
      `, [id, req.user.id, req.user.id, req.user.id]);
      return deleteUnreferencedRecords(tx, candidates);
    });
    await removePhysicalFiles(records);
    return records;
  });
  addLog({
    userId: req.user.id,
    action: 'folder_delete',
    targetType: 'folder',
    targetId: id,
    detail: JSON.stringify({ physicalFilesRemoved: removedFiles.length }),
  }, req);
  res.json({ message: '删除成功' });
}));

app.put('/drive/file/:id', authRequired, asyncRoute(async (req, res) => {
  const id = parseRequiredId(req.params.id, 'id');
  const name = normalizeFileName(getRequestBody(req).name);
  if (!name) throw new HttpError(400, '文件名不合法');

  await transaction(async (tx) => {
    const file = await tx.get(`
      SELECT id, folder_id, file_id FROM user_files WHERE id = ? AND user_id = ?
    `, [id, req.user.id]);
    if (!file) throw new HttpError(404, '文件不存在');
    const duplicate = await tx.get(`
      SELECT id FROM user_files
      WHERE user_id = ? AND folder_id IS ? AND file_id = ? AND name = ? AND id != ?
    `, [req.user.id, file.folder_id, file.file_id, name, id]);
    if (duplicate) throw new HttpError(409, '同名文件已存在');
    await tx.run('UPDATE user_files SET name = ? WHERE id = ? AND user_id = ?', [name, id, req.user.id]);
  });
  addLog({ userId: req.user.id, action: 'file_rename', targetType: 'file', targetId: id }, req);
  res.json({ message: '重命名成功' });
}));

app.delete('/drive/file/:id', authRequired, asyncRoute(async (req, res) => {
  const id = parseRequiredId(req.params.id, 'id');
  const removedFiles = await withStorageLock(async () => {
    const records = await transaction(async (tx) => {
      const file = await tx.get(`
        SELECT uf.id, f.id AS file_id, f.stored_name, f.storage_key, f.md5, f.sha256, f.size
        FROM user_files uf JOIN files f ON f.id = uf.file_id
        WHERE uf.id = ? AND uf.user_id = ?
      `, [id, req.user.id]);
      if (!file) throw new HttpError(404, '文件不存在');
      await tx.run('DELETE FROM user_files WHERE id = ? AND user_id = ?', [id, req.user.id]);
      return deleteUnreferencedRecords(tx, [{ ...file, id: file.file_id }]);
    });
    await removePhysicalFiles(records);
    return records;
  });
  addLog({
    userId: req.user.id,
    action: 'file_delete',
    targetType: 'file',
    targetId: id,
    detail: JSON.stringify({ physicalFileRemoved: removedFiles.length > 0 }),
  }, req);
  res.json({ message: '删除成功' });
}));

app.post('/drive/move', authRequired, asyncRoute(async (req, res) => {
  const body = getRequestBody(req);
  const { type } = body;
  if (!['file', 'folder'].includes(type)) throw new HttpError(400, 'type 必须是 file 或 folder');
  const id = parseRequiredId(body.id, 'id');
  const targetFolderId = parseOptionalId(body.targetFolderId, 'targetFolderId');

  await transaction(async (tx) => {
    await assertFolder(tx, targetFolderId, req.user.id, '目标文件夹');
    if (type === 'folder') {
      const folder = await tx.get('SELECT id, name FROM user_folders WHERE id = ? AND user_id = ?', [id, req.user.id]);
      if (!folder) throw new HttpError(404, '文件夹不存在');
      if (id === targetFolderId) throw new HttpError(400, '不能移动到自身');
      if (targetFolderId !== null) {
        const descendant = await tx.get(`
          WITH RECURSIVE tree(id) AS (
            SELECT id FROM user_folders WHERE id = ? AND user_id = ?
            UNION
            SELECT f.id FROM user_folders f JOIN tree t ON f.parent_id = t.id
            WHERE f.user_id = ?
          )
          SELECT 1 AS found FROM tree WHERE id = ?
        `, [id, req.user.id, req.user.id, targetFolderId]);
        if (descendant) throw new HttpError(400, '不能移动到自身的子文件夹中');
      }
      const targetDepth = await getFolderDepth(tx, targetFolderId, req.user.id);
      const subtreeDepth = await getSubtreeDepth(tx, id, req.user.id);
      if (targetDepth + subtreeDepth > MAX_FOLDER_DEPTH) {
        throw new HttpError(400, `文件夹层级不能超过 ${MAX_FOLDER_DEPTH} 层`);
      }
      const duplicate = await tx.get(`
        SELECT id FROM user_folders
        WHERE user_id = ? AND parent_id IS ? AND name = ? AND id != ?
      `, [req.user.id, targetFolderId, folder.name, id]);
      if (duplicate) throw new HttpError(409, '目标位置存在同名文件夹');
      await tx.run('UPDATE user_folders SET parent_id = ? WHERE id = ? AND user_id = ?', [targetFolderId, id, req.user.id]);
    } else {
      const file = await tx.get(`
        SELECT id, file_id, name FROM user_files WHERE id = ? AND user_id = ?
      `, [id, req.user.id]);
      if (!file) throw new HttpError(404, '文件不存在');
      const duplicate = await tx.get(`
        SELECT id FROM user_files
        WHERE user_id = ? AND folder_id IS ? AND file_id = ? AND name = ? AND id != ?
      `, [req.user.id, targetFolderId, file.file_id, file.name, id]);
      if (duplicate) throw new HttpError(409, '目标位置存在同名文件');
      await tx.run('UPDATE user_files SET folder_id = ? WHERE id = ? AND user_id = ?', [targetFolderId, id, req.user.id]);
    }
  });
  addLog({
    userId: req.user.id,
    action: `${type}_move`,
    targetType: type,
    targetId: id,
    detail: JSON.stringify({ targetFolderId }),
  }, req);
  res.json({ message: '移动成功' });
}));

app.get('/files/:md5/download', authRequired, asyncRoute(async (req, res, next) => {
  const md5 = String(req.params.md5 || '').toLowerCase();
  if (!isDigest(md5, 32)) throw new HttpError(400, 'md5 不合法');
  const record = await get(`
    SELECT uf.name, f.id, f.stored_name, f.storage_key, f.md5, f.sha256, f.size
    FROM user_files uf
    JOIN files f ON uf.file_id = f.id
    WHERE f.md5 = ? AND uf.user_id = ?
    ORDER BY uf.id LIMIT 1
  `, [md5, req.user.id]);
  if (!record) throw new HttpError(404, '文件不存在');
  const verification = await verifyFileRecord(record, false);
  if (!verification.ok) throw new HttpError(409, '文件物理内容异常，请联系管理员');
  const requestedName = normalizeFileName(req.query.name);
  const fileName = requestedName || normalizeFileName(record.name) || `${md5}.bin`;

  addLog({ userId: req.user.id, action: 'download', targetType: 'file', targetId: record.id }, req);
  res.download(verification.filePath, fileName, (err) => {
    if (err && !res.headersSent) return next(err);
    return undefined;
  });
}));

app.use((err, _req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof HttpError) {
    res.status(err.status).json({ message: err.message, code: err.code });
    return;
  }
  if (err && err.code === 'SQLITE_CONSTRAINT') {
    const messages = {
      'duplicate folder name': '同名文件夹已存在',
      'duplicate user file': '同名文件已存在',
      'folder cycle': '不能形成循环文件夹结构',
      'invalid folder parent': '父文件夹不存在',
      'invalid user file reference': '文件引用不合法',
    };
    const matched = Object.keys(messages).find((key) => String(err.message).includes(key));
    res.status(409).json({ message: matched ? messages[matched] : '数据约束冲突' });
    return;
  }
  console.error('未捕获错误:', err);
  res.status(500).json({ message: '服务器内部错误' });
});

async function bootstrap(port = PORT) {
  await ensureStorageDirs();
  await initDb();
  const staleCount = await cleanupStaleTempFiles(STALE_TEMP_MAX_AGE_MS);
  const orphanCount = await garbageCollectUnreferencedFiles();
  if (staleCount || orphanCount) {
    console.log(`启动清理完成: 临时文件 ${staleCount} 个, 无引用文件 ${orphanCount} 个`);
  }

  maintenanceTimer = setInterval(() => {
    cleanupStaleTempFiles(STALE_TEMP_MAX_AGE_MS)
      .catch((err) => console.error('定期清理临时文件失败:', err.message));
  }, 6 * 60 * 60 * 1000);
  maintenanceTimer.unref();

  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      serverInstance = server;
      console.log(`Server running at http://localhost:${server.address().port}`);
      resolve(server);
    });
    server.once('error', reject);
  });
}

async function shutdown() {
  if (maintenanceTimer) clearInterval(maintenanceTimer);
  if (serverInstance) {
    await new Promise((resolve) => serverInstance.close(resolve));
    serverInstance = null;
  }
  await closeDb();
}

if (require.main === module) {
  bootstrap().catch((err) => {
    console.error('启动失败:', err);
    process.exitCode = 1;
  });

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      shutdown()
        .then(() => process.exit(0))
        .catch((err) => {
          console.error('关闭失败:', err);
          process.exit(1);
        });
    });
  }
}

module.exports = {
  app,
  bootstrap,
  shutdown,
  garbageCollectUnreferencedFiles,
};
