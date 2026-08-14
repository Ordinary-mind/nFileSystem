
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const validator = require('validator');

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
const { authRequired, apiTokenRequired, hashApiToken } = require('./middleware/auth');
const { initializeMailer } = require('./utils/mailer');
const { getOrCreateThumbnail, removeThumbnail } = require('./thumbnail');
const {
  VerificationError,
  requestVerificationCode,
  consumeVerificationCode,
  cleanupVerificationChallenges,
} = require('./utils/email-verification');

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
const TRASH_RETENTION_DAYS = parseIntegerEnv('TRASH_RETENTION_DAYS', 7, 1, 3650);
const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;

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

function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().normalize('NFC').toLowerCase();
  if (!email || email.length > 254 || Buffer.byteLength(email, 'utf8') > 254) return null;
  if (!validator.isEmail(email, { allow_utf8_local_part: false, require_tld: true })) return null;
  return email;
}

function getPassword(value, fieldName = '密码') {
  if (typeof value !== 'string' || value.length < 8) {
    throw new HttpError(400, `${fieldName}至少 8 位`);
  }
  if (Buffer.byteLength(value, 'utf8') > 72) {
    throw new HttpError(400, `${fieldName} UTF-8 编码后不能超过 72 字节`);
  }
  return value;
}

function getVerificationCode(value) {
  if (typeof value !== 'string' || !/^\d{6}$/.test(value)) {
    throw new HttpError(400, '验证码必须是 6 位数字');
  }
  return value;
}

function maskEmail(email) {
  const [local, domain] = String(email).split('@');
  if (!domain) return '***';
  return `${local.slice(0, 2)}***@${domain}`;
}

function createLoginResponse(user) {
  const token = signToken({ id: user.id, credentialVersion: user.credential_version });
  return { token, user: { id: user.id, email: user.email } };
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

function randomToken(prefix) {
  return `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
}

function normalizeScopes(scopes, fallback) {
  const values = Array.isArray(scopes)
    ? scopes
    : (typeof scopes === 'string' ? scopes.split(',') : fallback);
  return [...new Set(values.map((scope) => String(scope).trim()).filter(Boolean))].join(',');
}

function toExpiresAt(expiresInSeconds) {
  const seconds = Number(expiresInSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(Date.now() + seconds * 1000).toISOString();
}

async function isFolderInsideRoot(folderId, rootFolderId, userId, query = get) {
  let currentId = folderId;
  while (currentId) {
    if (Number(currentId) === Number(rootFolderId)) return true;
    const folder = await query('SELECT parent_id FROM user_folders WHERE id = ? AND user_id = ?', [currentId, userId]);
    currentId = folder ? folder.parent_id : null;
  }
  return false;
}

async function requireFolderInsideRoot(folderId, rootFolderId, userId) {
  const targetFolderId = folderId || rootFolderId;
  const allowed = await isFolderInsideRoot(targetFolderId, rootFolderId, userId);
  if (!allowed) {
    const err = new Error('target_folder_forbidden');
    err.status = 403;
    throw err;
  }
  return targetFolderId;
}

async function requireUserFileInsideRoot(userFileId, rootFolderId, userId) {
  const file = await get(
    `SELECT uf.id, uf.folder_id, uf.name, f.id AS file_id, f.sha256, f.size, f.mime_type
     FROM user_files uf
     JOIN files f ON uf.file_id = f.id
     WHERE uf.id = ? AND uf.user_id = ? AND uf.deleted_at IS NULL`,
    [userFileId, userId]
  );
  if (!file) return null;
  const allowed = await isFolderInsideRoot(file.folder_id, rootFolderId, userId);
  return allowed ? file : null;
}

async function createAccessLink({ userId, integrationId, userFileId, expiresInSeconds, maxUses, disposition = 'inline' }) {
  const token = randomToken('nfs_al');
  const expiresAt = toExpiresAt(expiresInSeconds);
  const normalizedDisposition = disposition === 'download' ? 'download' : 'inline';
  const normalizedMaxUses = Number.isFinite(Number(maxUses)) && Number(maxUses) > 0 ? Number(maxUses) : null;

  const result = await run(
    `INSERT INTO access_links(user_id, integration_id, user_file_id, token_hash, disposition, expires_at, max_uses)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [userId, integrationId, userFileId, hashApiToken(token), normalizedDisposition, expiresAt, normalizedMaxUses]
  );

  const accessPath = `/n_file_system_api/access/${token}`;
  return {
    id: result.lastID,
    path: accessPath,
    expiresAt,
    maxUses: normalizedMaxUses,
    disposition: normalizedDisposition,
  };
}

/**
 * 获取客户端真实 IP（考虑反向代理）
 */
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
    WHERE uf.user_id = ? AND uf.deleted_at IS NULL
  `, [userId]);
  return Number(row.total || 0);
}

async function findFileRecordForUpload(tx, prepared) {
  const record = await tx.get(`
    SELECT id, sha256, size, mime_type
    FROM files WHERE sha256 = ?
  `, [prepared.sha256]);
  if (record) {
    const verification = await verifyFileRecord(record, true);
    if (!verification.ok) {
      throw new HttpError(409, '已有物理文件完整性异常，请先运行存储校验', 'STORAGE_INTEGRITY_ERROR');
    }
    return record;
  }

  return null;
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
              INSERT INTO files(sha256, size, mime_type)
              VALUES (?, ?, ?)
            `, [
              prepared.sha256,
              prepared.size,
              prepared.mimeType,
            ]);
            fileRecord = {
              id: inserted.lastID,
              sha256: prepared.sha256,
              size: prepared.size,
              mime_type: prepared.mimeType,
            };
          }

          const duplicate = await tx.get(`
            SELECT id FROM user_files
            WHERE user_id = ? AND folder_id IS ? AND file_id = ? AND name = ? AND deleted_at IS NULL
          `, [userId, folderId, fileRecord.id, prepared.originalName]);
          if (duplicate) {
            saved.push({
              id: duplicate.id,
              name: prepared.originalName,
              sha256: prepared.sha256,
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
            sha256: prepared.sha256,
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
      await removeThumbnail(record);
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
      WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM user_files WHERE file_id = files.id AND deleted_at IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM user_files
          WHERE file_id = files.id AND deleted_at IS NOT NULL
            AND datetime(deleted_at, ?) > datetime('now')
        )
    `, [record.id, `+${TRASH_RETENTION_DAYS} days`]);
    if (result.changes) removed.push(record);
  }
  return removed;
}

async function garbageCollectUnreferencedFiles() {
  return withStorageLock(async () => {
    const removed = await transaction(async (tx) => {
      await tx.run(`DELETE FROM user_files WHERE deleted_at IS NOT NULL AND datetime(deleted_at, ?) <= datetime('now')`, [`+${TRASH_RETENTION_DAYS} days`]);
      await tx.run(`DELETE FROM user_folders WHERE deleted_at IS NOT NULL AND datetime(deleted_at, ?) <= datetime('now')`, [`+${TRASH_RETENTION_DAYS} days`]);
      await tx.run(`DELETE FROM trash_batches
        WHERE datetime(deleted_at, ?) <= datetime('now')
          OR (item_type = 'file' AND NOT EXISTS (SELECT 1 FROM user_files WHERE id = trash_batches.item_id AND trash_batch_id = trash_batches.id))
          OR (item_type = 'folder' AND NOT EXISTS (SELECT 1 FROM user_folders WHERE id = trash_batches.item_id AND trash_batch_id = trash_batches.id))`, [`+${TRASH_RETENTION_DAYS} days`]);
      const records = await tx.all(`
        SELECT id, sha256, size FROM files f
        WHERE NOT EXISTS (SELECT 1 FROM user_files uf WHERE uf.file_id = f.id AND uf.deleted_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM user_files uf WHERE uf.file_id = f.id AND uf.deleted_at IS NOT NULL AND datetime(uf.deleted_at, ?) > datetime('now'))
      `, [`+${TRASH_RETENTION_DAYS} days`]);
      return deleteUnreferencedRecords(tx, records);
    });
    await removePhysicalFiles(removed);
    return removed.length;
  });
}

async function markTrashBatch(tx, userId, type, id) {
  const deletedAt = new Date().toISOString();
  const batch = await tx.run(
    'INSERT INTO trash_batches(user_id, item_type, item_id, deleted_at) VALUES (?, ?, ?, ?)',
    [userId, type, id, deletedAt]
  );
  if (type === 'file') {
    await tx.run('UPDATE user_files SET deleted_at = ?, trash_batch_id = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [deletedAt, batch.lastID, id, userId]);
  } else {
    await tx.run(`
      WITH RECURSIVE tree(id) AS (
        SELECT id FROM user_folders WHERE id = ? AND user_id = ? AND deleted_at IS NULL
        UNION ALL SELECT f.id FROM user_folders f JOIN tree t ON f.parent_id = t.id
        WHERE f.user_id = ? AND f.deleted_at IS NULL
      )
      UPDATE user_folders SET deleted_at = ?, trash_batch_id = ? WHERE user_id = ? AND id IN (SELECT id FROM tree)
    `, [id, userId, userId, deletedAt, batch.lastID, userId]);
    await tx.run(`
      WITH RECURSIVE tree(id) AS (
        SELECT id FROM user_folders WHERE id = ? AND user_id = ?
        UNION ALL SELECT f.id FROM user_folders f JOIN tree t ON f.parent_id = t.id WHERE f.user_id = ?
      )
      UPDATE user_files SET deleted_at = ?, trash_batch_id = ? WHERE user_id = ? AND folder_id IN (SELECT id FROM tree) AND deleted_at IS NULL
    `, [id, userId, userId, deletedAt, batch.lastID, userId]);
  }
  await tx.run('DELETE FROM access_links WHERE user_id = ? AND user_file_id IN (SELECT id FROM user_files WHERE trash_batch_id = ?)', [userId, batch.lastID]);
  return batch.lastID;
}

async function listTrash(userId) {
  return all(`
    SELECT b.id AS batch_id, b.item_type, b.item_id, b.deleted_at,
      CASE WHEN b.item_type = 'file' THEN uf.name ELSE fo.name END AS name,
      CASE WHEN b.item_type = 'file' THEN f.size ELSE NULL END AS size,
      CASE WHEN b.item_type = 'file' THEN f.sha256 ELSE NULL END AS sha256
    FROM trash_batches b
    LEFT JOIN user_files uf ON b.item_type = 'file' AND uf.id = b.item_id
    LEFT JOIN files f ON uf.file_id = f.id
    LEFT JOIN user_folders fo ON b.item_type = 'folder' AND fo.id = b.item_id
    WHERE b.user_id = ? ORDER BY b.id DESC
  `, [userId]);
}

async function permanentlyDeleteTrashBatch(tx, userId, batchId) {
  const batch = await tx.get('SELECT id FROM trash_batches WHERE id = ? AND user_id = ?', [batchId, userId]);
  if (!batch) throw new HttpError(404, '回收站项目不存在');
  // 保留独立删除批次的子树，避免父目录的外键级联越过批次边界。
  await tx.run(`UPDATE user_folders SET parent_id = NULL
    WHERE user_id = ? AND trash_batch_id != ?
      AND parent_id IN (SELECT id FROM user_folders WHERE trash_batch_id = ?)`, [userId, batchId, batchId]);
  await tx.run('DELETE FROM user_files WHERE trash_batch_id = ?', [batchId]);
  await tx.run('DELETE FROM user_folders WHERE trash_batch_id = ?', [batchId]);
  await tx.run('DELETE FROM trash_batches WHERE id = ?', [batchId]);
}


// ===== 接入应用管理 =====

function parseScopesForRoute(scopes) {
  return String(scopes || '')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function normalizeTokenName(name) {
  const value = String(name || '').trim();
  if (!value || value.length > 64) return null;
  return value;
}

app.get('/integrations', authRequired, async (req, res) => {
  try {
    const integrations = await all(
      `SELECT i.id, i.name, i.root_folder_id, i.scopes, i.enabled, i.created_at,
              f.name AS root_folder_name
       FROM integrations i
       LEFT JOIN user_folders f ON i.root_folder_id = f.id
       WHERE i.user_id = ?
       ORDER BY i.id DESC`,
      [req.user.id]
    );
    return res.json({ integrations });
  } catch (err) {
    return res.status(500).json({ message: '获取接入应用失败', error: err.message });
  }
});

app.post('/integrations', authRequired, async (req, res) => {
  try {
    const { name, rootFolderName, rootFolderId, scopes, createToken = true } = req.body;
    if (!name || typeof name !== 'string' || name.length > 64) {
      return res.status(400).json({ message: '接入应用名称不合法' });
    }

    let appRootFolderId = rootFolderId || null;
    if (appRootFolderId) {
      const folder = await get('SELECT id FROM user_folders WHERE id = ? AND user_id = ?', [appRootFolderId, req.user.id]);
      if (!folder) return res.status(400).json({ message: '应用根目录不存在' });
    } else {
      const folderName = rootFolderName || name;
      if (!normalizeFileName(folderName)) {
        return res.status(400).json({ message: '应用根目录名称不合法' });
      }

      const existing = await get(
        'SELECT id FROM user_folders WHERE user_id = ? AND parent_id IS NULL AND name = ?',
        [req.user.id, folderName]
      );
      if (existing) {
        appRootFolderId = existing.id;
      } else {
        const folderResult = await run(
          'INSERT INTO user_folders(user_id, parent_id, name) VALUES (?, NULL, ?)',
          [req.user.id, folderName]
        );
        appRootFolderId = folderResult.lastID;
      }
    }

    const normalizedScopes = normalizeScopes(scopes, ['files:upload', 'files:read', 'files:delete', 'links:create']);
    const result = await run(
      'INSERT INTO integrations(user_id, name, root_folder_id, scopes) VALUES (?, ?, ?, ?)',
      [req.user.id, name, appRootFolderId, normalizedScopes]
    );

    let tokenInfo = null;
    if (createToken) {
      const token = randomToken('nfs_pat');
      const tokenResult = await run(
        'INSERT INTO api_tokens(integration_id, user_id, name, token_hash, scopes) VALUES (?, ?, ?, ?, ?)',
        [result.lastID, req.user.id, 'default', hashApiToken(token), normalizedScopes]
      );
      tokenInfo = { id: tokenResult.lastID, token };
    }

    return res.json({
      message: '创建接入应用成功',
      integration: {
        id: result.lastID,
        name,
        rootFolderId: appRootFolderId,
        scopes: normalizedScopes.split(','),
      },
      token: tokenInfo,
    });
  } catch (err) {
    return res.status(500).json({ message: '创建接入应用失败', error: err.message });
  }
});

app.post('/integrations/:id/tokens', authRequired, async (req, res) => {
  try {
    const { id } = req.params;
    const integration = await get('SELECT id, scopes FROM integrations WHERE id = ? AND user_id = ?', [id, req.user.id]);
    if (!integration) return res.status(404).json({ message: '接入应用不存在' });

    const { scopes, expiresInSeconds } = req.body;
    const name = normalizeTokenName(req.body.name);
    if (!name) return res.status(400).json({ message: 'API Token 名称不能为空，且不能超过 64 个字符' });
    const sameName = await get(
      'SELECT id FROM api_tokens WHERE integration_id = ? AND user_id = ? AND name = ?',
      [id, req.user.id, name]
    );
    if (sameName) return res.status(409).json({ message: '同一接入应用下已存在同名 API Token' });

    const allowedScopes = parseScopesForRoute(integration.scopes);
    const requestedScopes = scopes ? parseScopesForRoute(normalizeScopes(scopes, [])) : allowedScopes;
    const finalScopes = requestedScopes.filter((scope) => allowedScopes.includes(scope));
    if (!finalScopes.length) return res.status(400).json({ message: 'token 权限不能为空' });

    const token = randomToken('nfs_pat');
    const result = await run(
      'INSERT INTO api_tokens(integration_id, user_id, name, token_hash, scopes, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, req.user.id, name, hashApiToken(token), finalScopes.join(','), toExpiresAt(expiresInSeconds)]
    );
    return res.json({ message: '创建 API Token 成功', token: { id: result.lastID, token, scopes: finalScopes } });
  } catch (err) {
    return res.status(500).json({ message: '创建 API Token 失败', error: err.message });
  }
});

app.get('/integrations/:id/tokens', authRequired, async (req, res) => {
  try {
    const { id } = req.params;
    const integration = await get('SELECT id FROM integrations WHERE id = ? AND user_id = ?', [id, req.user.id]);
    if (!integration) return res.status(404).json({ message: '接入应用不存在' });

    const tokens = await all(
      `SELECT id, name, scopes, expires_at, revoked_at, last_used_at, created_at
       FROM api_tokens
       WHERE integration_id = ? AND user_id = ?
       ORDER BY id DESC`,
      [id, req.user.id]
    );
    return res.json({ tokens });
  } catch (err) {
    return res.status(500).json({ message: '获取 API Token 失败', error: err.message });
  }
});

app.put('/integrations/:integrationId/tokens/:tokenId', authRequired, async (req, res) => {
  try {
    const { integrationId, tokenId } = req.params;
    const integration = await get('SELECT id, scopes FROM integrations WHERE id = ? AND user_id = ?', [integrationId, req.user.id]);
    if (!integration) return res.status(404).json({ message: '接入应用不存在' });

    const tokenRecord = await get(
      'SELECT id FROM api_tokens WHERE id = ? AND integration_id = ? AND user_id = ?',
      [tokenId, integrationId, req.user.id]
    );
    if (!tokenRecord) return res.status(404).json({ message: 'API Token 不存在' });

    const name = normalizeTokenName(req.body.name);
    if (!name) return res.status(400).json({ message: 'API Token 名称不能为空，且不能超过 64 个字符' });
    const sameName = await get(
      'SELECT id FROM api_tokens WHERE integration_id = ? AND user_id = ? AND name = ? AND id != ?',
      [integrationId, req.user.id, name, tokenId]
    );
    if (sameName) return res.status(409).json({ message: '同一接入应用下已存在同名 API Token' });

    const allowedScopes = parseScopesForRoute(integration.scopes);
    const requestedScopes = req.body.scopes ? parseScopesForRoute(normalizeScopes(req.body.scopes, [])) : allowedScopes;
    const finalScopes = requestedScopes.filter((scope) => allowedScopes.includes(scope));
    if (!finalScopes.length) return res.status(400).json({ message: 'API Token 权限不能为空' });

    await run(
      'UPDATE api_tokens SET name = ?, scopes = ?, expires_at = ? WHERE id = ? AND integration_id = ? AND user_id = ?',
      [name, finalScopes.join(','), toExpiresAt(req.body.expiresInSeconds), tokenId, integrationId, req.user.id]
    );
    return res.json({ message: 'API Token 已更新', token: { id: Number(tokenId), name, scopes: finalScopes } });
  } catch (err) {
    return res.status(500).json({ message: '更新 API Token 失败', error: err.message });
  }
});

app.put('/integrations/:id', authRequired, async (req, res) => {
  try {
    const { id } = req.params;
    const enabled = req.body.enabled === true || req.body.enabled === 1 ? 1 : 0;
    const result = await run(
      'UPDATE integrations SET enabled = ? WHERE id = ? AND user_id = ?',
      [enabled, id, req.user.id]
    );
    if (!result.changes) return res.status(404).json({ message: '接入应用不存在' });
    return res.json({ message: enabled ? '接入应用已启用' : '接入应用已禁用', enabled: Boolean(enabled) });
  } catch (err) {
    return res.status(500).json({ message: '更新接入应用失败', error: err.message });
  }
});

app.delete('/integrations/:integrationId/tokens/:tokenId', authRequired, async (req, res) => {
  try {
    const { integrationId, tokenId } = req.params;
    const result = await run(
      'DELETE FROM api_tokens WHERE id = ? AND integration_id = ? AND user_id = ?',
      [tokenId, integrationId, req.user.id]
    );
    if (!result.changes) return res.status(404).json({ message: 'API Token 不存在或已撤销' });
    return res.json({ message: 'API Token 已撤销' });
  } catch (err) {
    return res.status(500).json({ message: '撤销 API Token 失败', error: err.message });
  }
});


app.get('/healthz', asyncRoute(async (_req, res) => {
  await get('SELECT 1 AS ok');
  await fs.promises.access(tempRoot, fs.constants.R_OK | fs.constants.W_OK);
  res.json({ status: 'ok' });
}));

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/auth/register-status', (_req, res) => {
  res.json({ allowed: process.env.ALLOW_REGISTER === 'true' });
});

app.post('/auth/email-codes', authRateLimit, asyncRoute(async (req, res) => {
  const body = getRequestBody(req);
  const email = normalizeEmail(body.email);
  const purpose = body.purpose;
  if (!email) throw new HttpError(400, '邮箱格式不合法');
  if (!['register', 'reset_password'].includes(purpose)) throw new HttpError(400, '验证码用途不合法');
  if (purpose === 'register' && process.env.ALLOW_REGISTER !== 'true') {
    throw new HttpError(403, '当前不允许注册');
  }
  const identity = await get(
    "SELECT user_id FROM user_identities WHERE provider = 'email' AND provider_subject = ?",
    [email]
  );
  const deliver = purpose === 'register' ? !identity : Boolean(identity);
  await requestVerificationCode({ email, purpose, ip: getClientIp(req).slice(0, 128), deliver });
  addLog({
    userId: identity ? identity.user_id : null,
    action: 'verification_code_requested',
    targetType: 'user',
    targetId: identity ? identity.user_id : null,
    detail: JSON.stringify({ email: maskEmail(email), purpose }),
  }, req);
  res.status(202).json({ message: '如果该操作可用，验证码将发送到邮箱' });
}));

app.post('/auth/register', authRateLimit, asyncRoute(async (req, res) => {
  if (process.env.ALLOW_REGISTER !== 'true') throw new HttpError(403, '当前不允许注册');
  const body = getRequestBody(req);
  const email = normalizeEmail(body.email);
  if (!email) throw new HttpError(400, '邮箱格式不合法');
  const password = getPassword(body.password);
  const code = getVerificationCode(body.code);
  const hashed = await hashPassword(password);
  const userId = await consumeVerificationCode({ email, purpose: 'register', code }, async (tx) => {
    const existing = await tx.get(
      "SELECT user_id FROM user_identities WHERE provider = 'email' AND provider_subject = ?",
      [email]
    );
    if (existing) throw new HttpError(409, '该邮箱已注册');
    const result = await tx.run(
      'INSERT INTO users(name, password, credential_version) VALUES (?, ?, 1)',
      [email, hashed]
    );
    await tx.run(
      "INSERT INTO user_identities(user_id, provider, provider_subject, verified_at) VALUES (?, 'email', ?, datetime('now'))",
      [result.lastID, email]
    );
    return result.lastID;
  });
  addLog({ userId, action: 'register', targetType: 'user', targetId: userId }, req);
  res.status(201).json({ message: '注册成功，请登录' });
}));

app.post('/auth/login', authRateLimit, asyncRoute(async (req, res) => {
  const body = getRequestBody(req);
  const email = normalizeEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password || password.length > 4096) {
    throw new HttpError(400, 'email 和 password 格式不合法');
  }

  const user = await get(
    `SELECT u.id, u.name, u.password, u.credential_version, i.provider_subject AS email
     FROM user_identities i JOIN users u ON u.id = i.user_id
     WHERE i.provider = 'email' AND i.provider_subject = ?`,
    [email]
  );
  if (!user || !(await comparePassword(password, user.password))) {
    addLog({
      userId: user ? user.id : null,
      action: 'login_failed',
      targetType: user ? 'user' : null,
      targetId: user ? user.id : null,
      detail: JSON.stringify({ email: maskEmail(email || '') }),
    }, req);
    throw new HttpError(401, '邮箱或密码错误');
  }

  authAttempts.delete(getClientIp(req));
  const login = createLoginResponse(user);
  addLog({ userId: user.id, action: 'login', targetType: 'user', targetId: user.id }, req);
  res.json({ message: '登录成功', ...login });
}));

app.post('/auth/password/reset', authRateLimit, asyncRoute(async (req, res) => {
  const body = getRequestBody(req);
  const email = normalizeEmail(body.email);
  if (!email) throw new HttpError(400, '邮箱格式不合法');
  const code = getVerificationCode(body.code);
  const newPassword = getPassword(body.newPassword, '新密码');
  const hashed = await hashPassword(newPassword);
  const userId = await consumeVerificationCode({ email, purpose: 'reset_password', code }, async (tx) => {
    const user = await tx.get(
      `SELECT u.id, u.password FROM user_identities i JOIN users u ON u.id = i.user_id
       WHERE i.provider = 'email' AND i.provider_subject = ?`,
      [email]
    );
    if (!user) throw new HttpError(400, '验证码无效或已过期');
    if (await comparePassword(newPassword, user.password)) throw new HttpError(400, '新密码不能与原密码相同');
    await tx.run('UPDATE users SET password = ?, credential_version = credential_version + 1 WHERE id = ?', [hashed, user.id]);
    return user.id;
  });
  addLog({ userId, action: 'password_reset', targetType: 'user', targetId: userId }, req);
  res.json({ message: '密码已重置，请重新登录' });
}));

app.post('/auth/password/change', authRequired, asyncRoute(async (req, res) => {
  const body = getRequestBody(req);
  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const newPassword = getPassword(body.newPassword, '新密码');
  if (!currentPassword || currentPassword.length > 4096) throw new HttpError(400, '当前密码格式不合法');
  const user = await get('SELECT id, password, credential_version FROM users WHERE id = ?', [req.user.id]);
  if (!user || !(await comparePassword(currentPassword, user.password))) {
    throw new HttpError(400, '当前密码错误');
  }
  if (currentPassword === newPassword) throw new HttpError(400, '新密码不能与原密码相同');
  const hashed = await hashPassword(newPassword);
  const changed = await run(
    `UPDATE users SET password = ?, credential_version = credential_version + 1
     WHERE id = ? AND password = ? AND credential_version = ?`,
    [hashed, user.id, user.password, user.credential_version]
  );
  if (!changed.changes) throw new HttpError(409, '账号状态已变化，请重新登录后再试');
  const updated = await get(
    `SELECT u.id, u.credential_version, i.provider_subject AS email
     FROM users u JOIN user_identities i ON i.user_id = u.id AND i.provider = 'email'
     WHERE u.id = ?`,
    [user.id]
  );
  const login = createLoginResponse(updated);
  addLog({ userId: user.id, action: 'password_change', targetType: 'user', targetId: user.id }, req);
  res.json({ message: '密码修改成功', ...login });
}));


// ===== 应用接入 API =====

app.get('/api/v1/files', apiTokenRequired(['files:read']), async (req, res) => {
  try {
    const folderId = req.query.folderId || req.apiAuth.rootFolderId;
    const targetFolderId = await requireFolderInsideRoot(folderId, req.apiAuth.rootFolderId, req.apiAuth.userId);
    const files = await all(
      `SELECT uf.id, uf.name, uf.created_at, f.sha256, f.size, f.mime_type
       FROM user_files uf
       JOIN files f ON uf.file_id = f.id
       WHERE uf.user_id = ? AND uf.folder_id IS ?
       ORDER BY uf.id DESC`,
      [req.apiAuth.userId, targetFolderId]
    );
    const folders = await all(
      'SELECT id, name, created_at FROM user_folders WHERE user_id = ? AND parent_id IS ? ORDER BY name',
      [req.apiAuth.userId, targetFolderId]
    );
    return res.json({ rootFolderId: req.apiAuth.rootFolderId, folderId: targetFolderId, folders, files });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({ message: status === 403 ? '目标目录不在应用根目录内' : '获取应用文件失败', error: err.message });
  }
});

app.post('/api/v1/folders', apiTokenRequired(['files:upload']), async (req, res) => {
  try {
    const { name, parentId } = req.body;
    if (!normalizeFileName(name)) return res.status(400).json({ message: '文件夹名称不合法' });

    const targetParentId = await requireFolderInsideRoot(parentId || req.apiAuth.rootFolderId, req.apiAuth.rootFolderId, req.apiAuth.userId);
    const existing = await get(
      'SELECT id FROM user_folders WHERE user_id = ? AND parent_id IS ? AND name = ?',
      [req.apiAuth.userId, targetParentId, name]
    );
    if (existing) return res.status(409).json({ message: '同名文件夹已存在', id: existing.id });

    const result = await run(
      'INSERT INTO user_folders(user_id, parent_id, name) VALUES (?, ?, ?)',
      [req.apiAuth.userId, targetParentId, name]
    );
    return res.json({ message: '创建文件夹成功', folder: { id: result.lastID, name, parentId: targetParentId } });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({ message: status === 403 ? '目标目录不在应用根目录内' : '创建应用文件夹失败', error: err.message });
  }
});

app.post('/api/v1/files/upload',
  apiTokenRequired(['files:upload']),
  asyncRoute(uploadCapacity),
  uploadMiddleware,
  asyncRoute(async (req, res) => {
    const files = req.files || [];
    try {
      if (!files.length) throw new HttpError(400, '请至少上传一个文件，字段名为 files');
      const totalSize = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
      if (totalSize > MAX_UPLOAD_BYTES) throw new HttpError(413, '单次上传总大小超出限制');

      const folderId = parseOptionalId(getRequestBody(req).folderId, 'folderId');
      const targetFolderId = await requireFolderInsideRoot(folderId, req.apiAuth.rootFolderId, req.apiAuth.userId);
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

      const saved = await persistUploadBatch(req.apiAuth.userId, targetFolderId, prepared);
      const body = getRequestBody(req);
      const withAccessLink = body.withAccessLink === 'true' || body.withAccessLink === true;
      if (withAccessLink && req.apiAuth.scopes.includes('links:create')) {
        for (const item of saved) {
          item.accessLink = await createAccessLink({
            userId: req.apiAuth.userId,
            integrationId: req.apiAuth.integrationId,
            userFileId: item.id,
            expiresInSeconds: body.expiresInSeconds,
            disposition: body.disposition,
          });
        }
      }

      addLog({
        userId: req.apiAuth.userId,
        action: 'integration_upload',
        targetType: 'file',
        detail: JSON.stringify({ count: saved.length, folderId: targetFolderId, integrationId: req.apiAuth.integrationId }),
      }, req);
      res.json({
        message: '上传成功',
        rootFolderId: req.apiAuth.rootFolderId,
        folderId: targetFolderId,
        count: saved.length,
        files: saved,
      });
    } finally {
      await cleanupTempFiles(files);
    }
  }));

app.post('/api/v1/files/:id/access-links', apiTokenRequired(['links:create']), async (req, res) => {
  try {
    const file = await requireUserFileInsideRoot(req.params.id, req.apiAuth.rootFolderId, req.apiAuth.userId);
    if (!file) return res.status(404).json({ message: '文件不存在或不在应用根目录内' });

    const link = await createAccessLink({
      req,
      userId: req.apiAuth.userId,
      integrationId: req.apiAuth.integrationId,
      userFileId: file.id,
      expiresInSeconds: req.body.expiresInSeconds,
      maxUses: req.body.maxUses,
      disposition: req.body.disposition,
    });
    return res.json({ message: '创建访问链接成功', file: { id: file.id, name: file.name, sha256: file.sha256 }, accessLink: link });
  } catch (err) {
    return res.status(500).json({ message: '创建访问链接失败', error: err.message });
  }
});

app.delete('/api/v1/files/:id', apiTokenRequired(['files:delete']), asyncRoute(async (req, res) => {
  const id = parseRequiredId(req.params.id, 'id');
  const batchId = await transaction(async (tx) => {
      const file = await tx.get('SELECT id, folder_id FROM user_files WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [id, req.apiAuth.userId]);
      const query = (sql, params) => tx.get(sql, params);
      if (!file || !(await isFolderInsideRoot(file.folder_id, req.apiAuth.rootFolderId, req.apiAuth.userId, query))) {
        throw new HttpError(404, '文件不存在或不在应用根目录内');
      }
      return markTrashBatch(tx, req.apiAuth.userId, 'file', id);
  });
  addLog({
    userId: req.apiAuth.userId,
    action: 'integration_file_delete',
    targetType: 'file',
    targetId: id,
    detail: JSON.stringify({ integrationId: req.apiAuth.integrationId, trashBatchId: batchId }),
  }, req);
  res.json({ message: '删除成功' });
}));

async function serveAccessLink(req, res, next) {
  try {
    const token = String(req.params.token || '');
    const link = await transaction(async (tx) => {
      const record = await tx.get(
        `SELECT al.id, al.disposition, al.expires_at, al.max_uses, al.use_count, al.revoked_at,
                uf.name, f.id AS file_id, f.sha256,
                f.size, f.mime_type
         FROM access_links al
         JOIN user_files uf ON al.user_file_id = uf.id
         JOIN files f ON uf.file_id = f.id
         WHERE al.token_hash = ? AND uf.deleted_at IS NULL`,
        [hashApiToken(token)]
      );
      if (!record || record.revoked_at) throw new HttpError(404, '访问链接不存在');
      if (record.expires_at && new Date(record.expires_at).getTime() <= Date.now()) throw new HttpError(410, '访问链接已过期');
      if (record.max_uses && record.use_count >= record.max_uses) throw new HttpError(410, '访问链接已超过使用次数');
      await tx.run('UPDATE access_links SET use_count = use_count + 1 WHERE id = ?', [record.id]);
      return record;
    });

    const verification = await verifyFileRecord(link, false);
    if (!verification.ok) throw new HttpError(404, '文件物理内容不存在或已损坏');
    const fileName = normalizeFileName(req.query.name) || normalizeFileName(link.name) || `${link.sha256}.bin`;
    if (link.mime_type) res.type(link.mime_type);
    if (link.disposition === 'download') {
      return res.download(verification.filePath, fileName, (err) => {
        if (err && !res.headersSent) next(err);
      });
    }
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    return res.sendFile(verification.filePath, (err) => {
      if (err && !res.headersSent) next(err);
    });
  } catch (err) {
    return next(err);
  }
}

app.get('/n_file_system_api/access/:token', serveAccessLink);


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
      const sha256 = typeof item.sha256 === 'string' ? item.sha256.toLowerCase() : '';
      const originalName = normalizeFileName(item.originalName);
      if (!isDigest(sha256, 64) || !originalName) {
        output.push({ sha256, originalName: item.originalName, success: false, message: 'sha256 或 originalName 不合法' });
        continue;
      }

      // 秒传只复用当前用户已经持有的内容，避免通过摘要取得他人文件。
      const fileRecord = await tx.get(`
        SELECT DISTINCT f.id, f.sha256, f.size
        FROM files f
        JOIN user_files owned ON owned.file_id = f.id
        WHERE f.sha256 = ? AND owned.user_id = ? AND owned.deleted_at IS NULL
      `, [sha256, req.user.id]);
      if (!fileRecord) {
        output.push({ sha256, originalName, success: false, message: '当前账号没有该文件，请走正常上传' });
        continue;
      }

      const verification = await verifyFileRecord(fileRecord, false);
      if (!verification.ok) {
        output.push({ sha256, originalName, success: false, message: '物理文件异常，请重新上传' });
        continue;
      }
      const duplicate = await tx.get(`
        SELECT id FROM user_files
        WHERE user_id = ? AND folder_id IS ? AND file_id = ? AND name = ? AND deleted_at IS NULL
      `, [req.user.id, folderId, fileRecord.id, originalName]);
      if (duplicate) {
        output.push({ sha256, originalName, success: true, id: duplicate.id, size: fileRecord.size, duplicate: true });
        continue;
      }
      if (USER_QUOTA_BYTES > 0 && usage + fileRecord.size > USER_QUOTA_BYTES) {
        output.push({ sha256, originalName, success: false, message: '用户存储配额不足' });
        continue;
      }

      const inserted = await tx.run(
        'INSERT INTO user_files(user_id, folder_id, file_id, name) VALUES (?, ?, ?, ?)',
        [req.user.id, folderId, fileRecord.id, originalName]
      );
      usage += fileRecord.size;
      output.push({ sha256, originalName, success: true, id: inserted.lastID, size: fileRecord.size });
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
      WHERE user_id = ? AND parent_id IS ? AND deleted_at IS NULL${searchFolderSql}
      ORDER BY name
      LIMIT ? OFFSET ?
    `, folderParams);
    const files = await tx.all(`
      SELECT uf.id, uf.name, uf.created_at, f.sha256, f.size, f.mime_type
      FROM user_files uf
      JOIN files f ON uf.file_id = f.id
      WHERE uf.user_id = ? AND uf.folder_id IS ? AND uf.deleted_at IS NULL${searchFileSql}
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

function encodeSearchCursor(row) {
  return Buffer.from(JSON.stringify([row.name_key, row.type, Number(row.id)]), 'utf8').toString('base64url');
}

function decodeSearchCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 3 || typeof parsed[0] !== 'string'
      || !['file', 'folder'].includes(parsed[1]) || !Number.isSafeInteger(parsed[2])) throw new Error();
    return parsed;
  } catch {
    throw new HttpError(400, 'cursor 不合法');
  }
}

app.get('/drive/search', authRequired, asyncRoute(async (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.normalize('NFC').trim() : '';
  if (!query) return res.json({ results: [], page: { limit: 50, nextCursor: null } });
  if (query.length > 100) throw new HttpError(400, '搜索词过长');
  const scope = req.query.scope === undefined ? 'all' : String(req.query.scope);
  if (!['all', 'current'].includes(scope)) throw new HttpError(400, 'scope 不合法');
  const folderId = parseOptionalId(req.query.folderId, 'folderId');
  const limit = req.query.limit === undefined ? 50 : parseRequiredId(req.query.limit, 'limit');
  if (limit > 100) throw new HttpError(400, 'limit 不能超过 100');
  const cursor = decodeSearchCursor(req.query.cursor);

  const results = await transaction(async (tx) => {
    if (scope === 'current' && folderId !== null) await assertFolder(tx, folderId, req.user.id);
    const conditions = ['ds.user_id = ?'];
    const params = [req.user.id];
    if (scope === 'current') {
      conditions.push('ds.parent_id IS ?');
      params.push(folderId);
    }
    if (query.length >= 3) {
      conditions.push('drive_search MATCH ?');
      params.push(`"${query.replace(/"/g, '""')}"`);
    } else {
      conditions.push("ds.name LIKE ? ESCAPE '\\'");
      params.push(`%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
    }
    if (cursor) {
      conditions.push('(lower(ds.name) > ? OR (lower(ds.name) = ? AND (ds.entity_type > ? OR (ds.entity_type = ? AND ds.entity_id > ?))))');
      params.push(cursor[0], cursor[0], cursor[1], cursor[1], cursor[2]);
    }
    params.push(limit + 1);
    return tx.all(`
      WITH RECURSIVE folder_paths(id, path) AS (
        SELECT id, '/' || name FROM user_folders WHERE user_id = ? AND parent_id IS NULL
        UNION ALL
        SELECT f.id, fp.path || '/' || f.name
        FROM user_folders f JOIN folder_paths fp ON f.parent_id = fp.id
        WHERE f.user_id = ?
      )
      SELECT CAST(ds.entity_id AS INTEGER) AS id, ds.entity_type AS type, ds.name, lower(ds.name) AS name_key,
             CAST(ds.parent_id AS INTEGER) AS folder_id, COALESCE(fp.path, '/') AS path,
             f.sha256, f.size, f.mime_type
      FROM drive_search ds
      LEFT JOIN user_files uf ON ds.entity_type = 'file' AND uf.id = ds.entity_id
      LEFT JOIN files f ON uf.file_id = f.id
      LEFT JOIN folder_paths fp ON fp.id = ds.parent_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY lower(ds.name), ds.entity_type, ds.entity_id
      LIMIT ?
    `, [req.user.id, req.user.id, ...params]);
  });
  const pageRows = results.slice(0, limit);
  res.json({
    results: pageRows.map(({ name_key, ...item }) => item),
    page: { limit, nextCursor: results.length > limit ? encodeSearchCursor(pageRows.at(-1)) : null },
  });
}));

app.get('/drive/trash', authRequired, asyncRoute(async (req, res) => {
  const items = await listTrash(req.user.id);
  res.json({ items, retentionDays: TRASH_RETENTION_DAYS });
}));

app.get('/api/v1/trash', apiTokenRequired(['files:read']), asyncRoute(async (req, res) => {
  const items = await listTrash(req.apiAuth.userId);
  res.json({ items, retentionDays: TRASH_RETENTION_DAYS });
}));

app.post('/api/v1/trash/:batchId/restore', apiTokenRequired(['files:upload']), asyncRoute(async (req, res) => {
  const batchId = parseRequiredId(req.params.batchId, 'batchId');
  const restored = await transaction(async (tx) => {
    const batch = await tx.get('SELECT * FROM trash_batches WHERE id = ? AND user_id = ? AND item_type = ?', [batchId, req.apiAuth.userId, 'file']);
    if (!batch || Date.now() - new Date(batch.deleted_at).getTime() >= TRASH_RETENTION_MS) throw new HttpError(404, '回收站项目不存在或已过期');
    const file = await tx.get('SELECT id, folder_id FROM user_files WHERE id = ? AND trash_batch_id = ?', [batch.item_id, batchId]);
    const query = (sql, params) => tx.get(sql, params);
    if (!file || !(await isFolderInsideRoot(file.folder_id, req.apiAuth.rootFolderId, req.apiAuth.userId, query))) throw new HttpError(403, '回收站项目不在应用根目录内');
    await tx.run('UPDATE user_files SET deleted_at = NULL, trash_batch_id = NULL WHERE id = ?', [file.id]);
    await tx.run('DELETE FROM trash_batches WHERE id = ?', [batchId]);
    return file.id;
  });
  res.json({ message: '恢复成功', id: restored });
}));

app.delete('/api/v1/trash/:batchId', apiTokenRequired(['files:delete']), asyncRoute(async (req, res) => {
  const batchId = parseRequiredId(req.params.batchId, 'batchId');
  await transaction(async (tx) => {
    await permanentlyDeleteTrashBatch(tx, req.apiAuth.userId, batchId);
  });
  await garbageCollectUnreferencedFiles();
  res.json({ message: '已永久删除' });
}));

app.delete('/api/v1/trash', apiTokenRequired(['files:delete']), asyncRoute(async (req, res) => {
  await transaction(async (tx) => {
    await tx.run('DELETE FROM user_files WHERE user_id = ? AND deleted_at IS NOT NULL', [req.apiAuth.userId]);
    await tx.run('DELETE FROM user_folders WHERE user_id = ? AND deleted_at IS NOT NULL', [req.apiAuth.userId]);
    await tx.run('DELETE FROM trash_batches WHERE user_id = ?', [req.apiAuth.userId]);
  });
  await garbageCollectUnreferencedFiles();
  res.json({ message: '回收站已清空' });
}));

app.post('/drive/trash/:batchId/restore', authRequired, asyncRoute(async (req, res) => {
  const batchId = parseRequiredId(req.params.batchId, 'batchId');
  const result = await transaction(async (tx) => {
    const batch = await tx.get('SELECT * FROM trash_batches WHERE id = ? AND user_id = ?', [batchId, req.user.id]);
    if (!batch) throw new HttpError(404, '回收站项目不存在');
    if (Date.now() - new Date(batch.deleted_at).getTime() >= TRASH_RETENTION_MS) throw new HttpError(410, '回收站项目已过期');
    if (batch.item_type === 'file') {
      const file = await tx.get('SELECT id, folder_id, name FROM user_files WHERE id = ? AND trash_batch_id = ?', [batch.item_id, batchId]);
      if (!file) throw new HttpError(410, '文件内容已清理');
      await tx.run('UPDATE user_files SET deleted_at = NULL, trash_batch_id = NULL WHERE id = ?', [file.id]);
    } else {
      await tx.run('UPDATE user_folders SET deleted_at = NULL, trash_batch_id = NULL WHERE trash_batch_id = ?', [batchId]);
      await tx.run('UPDATE user_files SET deleted_at = NULL, trash_batch_id = NULL WHERE trash_batch_id = ?', [batchId]);
    }
    await tx.run('DELETE FROM trash_batches WHERE id = ?', [batchId]);
    return batch;
  });
  res.json({ message: '恢复成功', itemType: result.item_type });
}));

app.delete('/drive/trash/:batchId', authRequired, asyncRoute(async (req, res) => {
  const batchId = parseRequiredId(req.params.batchId, 'batchId');
  await transaction(async (tx) => {
    await permanentlyDeleteTrashBatch(tx, req.user.id, batchId);
  });
  await garbageCollectUnreferencedFiles();
  res.json({ message: '已永久删除' });
}));

app.delete('/drive/trash', authRequired, asyncRoute(async (req, res) => {
  await transaction(async (tx) => {
    await tx.run('DELETE FROM user_files WHERE user_id = ? AND deleted_at IS NOT NULL', [req.user.id]);
    await tx.run('DELETE FROM user_folders WHERE user_id = ? AND deleted_at IS NOT NULL', [req.user.id]);
    await tx.run('DELETE FROM trash_batches WHERE user_id = ?', [req.user.id]);
  });
  await garbageCollectUnreferencedFiles();
  res.json({ message: '回收站已清空' });
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
  const batchId = await transaction(async (tx) => {
    const folder = await tx.get('SELECT id FROM user_folders WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [id, req.user.id]);
    if (!folder) throw new HttpError(404, '文件夹不存在');
    return markTrashBatch(tx, req.user.id, 'folder', id);
  });
  addLog({
    userId: req.user.id,
    action: 'folder_delete',
    targetType: 'folder',
    targetId: id,
    detail: JSON.stringify({ trashBatchId: batchId }),
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
  const batchId = await transaction(async (tx) => {
    const file = await tx.get('SELECT id FROM user_files WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [id, req.user.id]);
    if (!file) throw new HttpError(404, '文件不存在');
    return markTrashBatch(tx, req.user.id, 'file', id);
  });
  addLog({
    userId: req.user.id,
    action: 'file_delete',
    targetType: 'file',
    targetId: id,
    detail: JSON.stringify({ trashBatchId: batchId }),
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

app.get('/files/:sha256/download', authRequired, asyncRoute(async (req, res, next) => {
  const sha256 = String(req.params.sha256 || '').toLowerCase();
  if (!isDigest(sha256, 64)) throw new HttpError(400, 'sha256 不合法');
  const record = await get(`
    SELECT uf.name, f.id, f.sha256, f.size
    FROM user_files uf
    JOIN files f ON uf.file_id = f.id
    WHERE f.sha256 = ? AND uf.user_id = ? AND uf.deleted_at IS NULL
    ORDER BY uf.id LIMIT 1
  `, [sha256, req.user.id]);
  if (!record) throw new HttpError(404, '文件不存在');
  const verification = await verifyFileRecord(record, false);
  if (!verification.ok) throw new HttpError(409, '文件物理内容异常，请联系管理员');
  const requestedName = normalizeFileName(req.query.name);
  const fileName = requestedName || normalizeFileName(record.name) || `${sha256}.bin`;

  addLog({ userId: req.user.id, action: 'download', targetType: 'file', targetId: record.id }, req);
  res.download(verification.filePath, fileName, (err) => {
    if (err && !res.headersSent) return next(err);
    return undefined;
  });
}));

app.get('/files/:sha256/thumbnail', authRequired, asyncRoute(async (req, res) => {
  const sha256 = String(req.params.sha256 || '').toLowerCase();
  if (!isDigest(sha256, 64)) throw new HttpError(400, 'sha256 不合法');
  const record = await get(`
    SELECT f.id, f.sha256, f.mime_type
    FROM user_files uf JOIN files f ON uf.file_id = f.id
    WHERE f.sha256 = ? AND uf.user_id = ? AND uf.deleted_at IS NULL LIMIT 1
  `, [sha256, req.user.id]);
  if (!record) throw new HttpError(404, '文件不存在');
  const thumbnailPath = await getOrCreateThumbnail(record);
  if (!thumbnailPath) throw new HttpError(415, '该文件无法生成缩略图');
  const etag = `"thumbnail-v1-${record.sha256}"`;
  res.set({
    'Content-Type': 'image/webp',
    'Cache-Control': 'private, max-age=31536000, immutable',
    ETag: etag,
  });
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  return res.sendFile(thumbnailPath);
}));

app.use((err, _req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof HttpError || err instanceof VerificationError) {
    if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
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
  await initializeMailer();
  await ensureStorageDirs();
  await initDb();
  await cleanupVerificationChallenges();
  const staleCount = await cleanupStaleTempFiles(STALE_TEMP_MAX_AGE_MS);
  const orphanCount = await garbageCollectUnreferencedFiles();
  if (staleCount || orphanCount) {
    console.log(`启动清理完成: 临时文件 ${staleCount} 个, 无引用文件 ${orphanCount} 个`);
  }

  maintenanceTimer = setInterval(() => {
    cleanupStaleTempFiles(STALE_TEMP_MAX_AGE_MS)
      .catch((err) => console.error('定期清理临时文件失败:', err.message));
    cleanupVerificationChallenges()
      .catch((err) => console.error('定期清理验证码失败:', err.message));
    garbageCollectUnreferencedFiles()
      .catch((err) => console.error('定期清理回收站失败:', err.message));
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
