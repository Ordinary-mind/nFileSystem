require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const { initDb, run, get, all } = require('./db');
const { hashPassword, comparePassword, signToken } = require('./utils/security');
const { authRequired, apiTokenRequired, hashApiToken } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

const uploadRoot = path.join(__dirname, '..', 'uploads');
const tempRoot = path.join(uploadRoot, 'tmp');

if (!fs.existsSync(uploadRoot)) {
  fs.mkdirSync(uploadRoot, { recursive: true });
}
if (!fs.existsSync(tempRoot)) {
  fs.mkdirSync(tempRoot, { recursive: true });
}

app.use(express.json());
app.set('trust proxy', 1);
app.use(express.static(path.join(__dirname, '..', 'public')));

const uploader = multer({
  dest: tempRoot,
  limits: {
    files: 20,
    fileSize: 50 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    // 修复 Linux 下中文文件名乱码：multer/busboy 以 latin1 解码 filename，需还原为 UTF-8
    if (file.originalname) {
      file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    }
    cb(null, true);
  },
});

// ===== 工具函数 =====

function calculateMD5(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function fileExists(filePath) {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function persistFileByMD5(file) {
  const md5 = await calculateMD5(file.path);
  const level1 = md5.slice(0, 2);
  const level2 = md5.slice(2, 4);
  const ext = path.extname(file.originalname || '');
  const storedName = `${md5}${ext}`;

  const targetDir = path.join(uploadRoot, level1, level2);
  const targetPath = path.join(targetDir, storedName);

  await fs.promises.mkdir(targetDir, { recursive: true });

  if (!(await fileExists(targetPath))) {
    try {
      await fs.promises.rename(file.path, targetPath);
    } catch (err) {
      if (err.code === 'EXDEV') {
        await fs.promises.copyFile(file.path, targetPath);
        await fs.promises.unlink(file.path);
      } else {
        throw err;
      }
    }
  } else {
    await fs.promises.unlink(file.path);
  }

  return { md5, storedName, size: file.size, mimeType: file.mimetype };
}

function isValidFileName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.length > 255) return false;
  if (/[/\\<>:"|?*\x00-\x1f]/.test(name)) return false;
  if (name === '.' || name === '..') return false;
  return true;
}

function getFilePath(md5, storedName) {
  return path.join(uploadRoot, md5.slice(0, 2), md5.slice(2, 4), storedName);
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

function buildPublicUrl(req, pathname) {
  return `${req.protocol}://${req.get('host')}${pathname}`;
}

async function isFolderInsideRoot(folderId, rootFolderId, userId) {
  let currentId = folderId;
  while (currentId) {
    if (Number(currentId) === Number(rootFolderId)) return true;
    const folder = await get('SELECT parent_id FROM user_folders WHERE id = ? AND user_id = ?', [currentId, userId]);
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
    `SELECT uf.id, uf.folder_id, uf.name, f.id AS file_id, f.md5, f.size, f.mime_type, f.stored_name
     FROM user_files uf
     JOIN files f ON uf.file_id = f.id
     WHERE uf.id = ? AND uf.user_id = ?`,
    [userFileId, userId]
  );
  if (!file) return null;
  const allowed = await isFolderInsideRoot(file.folder_id, rootFolderId, userId);
  return allowed ? file : null;
}

async function saveUploadedFileReference(file, userId, folderId) {
  const archived = await persistFileByMD5(file);

  let fileRecord = await get('SELECT id FROM files WHERE md5 = ?', [archived.md5]);
  if (!fileRecord) {
    const result = await run(
      'INSERT INTO files(stored_name, md5, size, mime_type) VALUES (?, ?, ?, ?)',
      [archived.storedName, archived.md5, archived.size, archived.mimeType]
    );
    fileRecord = { id: result.lastID };
  }

  const duplicate = await get(
    'SELECT id FROM user_files WHERE user_id = ? AND folder_id IS ? AND file_id = ? AND name = ?',
    [userId, folderId, fileRecord.id, file.originalname]
  );

  if (duplicate) {
    return { id: duplicate.id, name: file.originalname, md5: archived.md5, size: archived.size, mimeType: archived.mimeType, duplicate: true };
  }

  const ufResult = await run(
    'INSERT INTO user_files(user_id, folder_id, file_id, name) VALUES (?, ?, ?, ?)',
    [userId, folderId, fileRecord.id, file.originalname]
  );

  return { id: ufResult.lastID, name: file.originalname, md5: archived.md5, size: archived.size, mimeType: archived.mimeType, duplicate: false };
}

async function createAccessLink({ req, userId, integrationId, userFileId, expiresInSeconds, maxUses, disposition = 'inline' }) {
  const token = randomToken('nfs_al');
  const expiresAt = toExpiresAt(expiresInSeconds);
  const normalizedDisposition = disposition === 'download' ? 'download' : 'inline';
  const normalizedMaxUses = Number.isFinite(Number(maxUses)) && Number(maxUses) > 0 ? Number(maxUses) : null;

  const result = await run(
    `INSERT INTO access_links(user_id, integration_id, user_file_id, token_hash, disposition, expires_at, max_uses)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [userId, integrationId, userFileId, hashApiToken(token), normalizedDisposition, expiresAt, normalizedMaxUses]
  );

  return {
    id: result.lastID,
    url: buildPublicUrl(req, `/access/${token}`),
    expiresAt,
    maxUses: normalizedMaxUses,
    disposition: normalizedDisposition,
  };
}

/**
 * 获取客户端真实 IP（考虑反向代理）
 */
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.headers['x-real-ip'] || req.connection.remoteAddress || req.ip;
}

/**
 * 记录操作日志
 * @param {object} options
 * @param {number|null} options.userId - 操作用户 ID（未登录时为 null）
 * @param {string} options.action - 操作类型：register, login, login_failed, upload, download, delete, rename, move, share, password_change 等
 * @param {string|null} options.targetType - 目标类型：user, file, folder 等
 * @param {number|null} options.targetId - 目标 ID
 * @param {string|null} options.detail - 额外描述（JSON 字符串或文本）
 * @param {object} req - Express request 对象
 */
function addLog({ userId = null, action, targetType = null, targetId = null, detail = null }, req) {
  const ip = getClientIp(req);
  const userAgent = req.headers['user-agent'] || '';
  // 异步写入，不阻塞响应
  run(
    'INSERT INTO logs(user_id, action, target_type, target_id, detail, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [userId, action, targetType, targetId, detail, ip, userAgent]
  ).catch(() => { /* 日志写入失败不影响业务 */ });
}

// ===== 认证接口 =====

// 简易登录限流：同一 IP 1 分钟内最多 10 次尝试
const loginAttempts = new Map(); // ip -> { count, resetTime }
const LOGIN_LIMIT = 10;
const LOGIN_WINDOW = 60 * 1000; // 1 分钟

function checkLoginRate(req) {
  const ip = getClientIp(req);
  const now = Date.now();
  const record = loginAttempts.get(ip);

  if (!record || now > record.resetTime) {
    loginAttempts.set(ip, { count: 1, resetTime: now + LOGIN_WINDOW });
    return true;
  }

  record.count++;
  if (record.count > LOGIN_LIMIT) {
    return false;
  }
  return true;
}

// 定期清理过期记录
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of loginAttempts) {
    if (now > record.resetTime) loginAttempts.delete(ip);
  }
}, 5 * 60 * 1000);

app.get('/auth/register-status', (_req, res) => {
  const allowed = process.env.ALLOW_REGISTER === 'true';
  res.json({ allowed });
});

app.post('/auth/register', async (req, res) => {
  try {
    if (process.env.ALLOW_REGISTER !== 'true') {
      return res.status(403).json({ message: '当前不允许注册' });
    }
    const { name, password } = req.body;
    if (!name || !password) {
      return res.status(400).json({ message: 'name 和 password 必填' });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: '密码至少 6 位' });
    }
    if (name.length < 2 || name.length > 32) {
      return res.status(400).json({ message: '用户名长度 2-32 位' });
    }
    const hashed = await hashPassword(password);
    const result = await run('INSERT INTO users(name, password) VALUES (?, ?)', [name, hashed]);
    addLog({ userId: result.lastID, action: 'register', targetType: 'user', targetId: result.lastID, detail: JSON.stringify({ name }) }, req);
    return res.json({ message: '注册成功' });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      addLog({ userId: null, action: 'register_failed', detail: JSON.stringify({ name: req.body.name, reason: '用户名已存在' }) }, req);
      return res.status(409).json({ message: '用户名已存在' });
    }
    return res.status(500).json({ message: '注册失败', error: err.message });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    if (!checkLoginRate(req)) {
      return res.status(429).json({ message: '登录尝试过于频繁，请稍后再试' });
    }

    const { name, password } = req.body;
    if (!name || !password) {
      return res.status(400).json({ message: 'name 和 password 必填' });
    }
    const user = await get('SELECT id, name, password FROM users WHERE name = ?', [name]);
    if (!user) {
      addLog({ userId: null, action: 'login_failed', detail: JSON.stringify({ name, reason: '用户不存在' }) }, req);
      return res.status(401).json({ message: '用户名或密码错误' });
    }
    const match = await comparePassword(password, user.password);
    if (!match) {
      addLog({ userId: user.id, action: 'login_failed', targetType: 'user', targetId: user.id, detail: JSON.stringify({ name, reason: '密码错误' }) }, req);
      return res.status(401).json({ message: '用户名或密码错误' });
    }
    const token = signToken({ id: user.id, name: user.name });
    addLog({ userId: user.id, action: 'login', targetType: 'user', targetId: user.id }, req);
    return res.json({ message: '登录成功', token, user: { id: user.id, name: user.name } });
  } catch (err) {
    return res.status(500).json({ message: '登录失败', error: err.message });
  }
});

// ===== 文件上传（写入 files 物理存储表）=====

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
      if (!isValidFileName(folderName)) {
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

app.post('/files/upload', authRequired, (req, res, next) => {
  uploader.array('files', 20)(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ message: '文件字段名必须为 files' });
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ message: '单个文件不能超过 50MB' });
      if (err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ message: '单次最多上传 20 个文件' });
      return res.status(400).json({ message: '上传出错', error: err.message });
    }
    next();
  });
}, async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ message: '请至少上传一个文件，字段名为 files' });
    }

    const folderId = req.body.folderId || null;

    // 如果指定了文件夹，验证归属
    if (folderId) {
      const folder = await get('SELECT id FROM user_folders WHERE id = ? AND user_id = ?', [folderId, req.user.id]);
      if (!folder) return res.status(400).json({ message: '文件夹不存在' });
    }

    const saved = [];
    for (const file of files) {
      const archived = await persistFileByMD5(file);

      // 写入 files 表（MD5 去重）
      let fileRecord = await get('SELECT id FROM files WHERE md5 = ?', [archived.md5]);
      if (!fileRecord) {
        const result = await run(
          'INSERT INTO files(stored_name, md5, size, mime_type) VALUES (?, ?, ?, ?)',
          [archived.storedName, archived.md5, archived.size, archived.mimeType]
        );
        fileRecord = { id: result.lastID };
      }

      // 写入 user_files（同文件夹下同名同文件不重复）
      const duplicate = await get(
        'SELECT id FROM user_files WHERE user_id = ? AND folder_id IS ? AND file_id = ? AND name = ?',
        [req.user.id, folderId, fileRecord.id, file.originalname]
      );

      if (duplicate) {
        saved.push({ id: duplicate.id, name: file.originalname, md5: archived.md5, size: archived.size, duplicate: true });
        continue;
      }

      const ufResult = await run(
        'INSERT INTO user_files(user_id, folder_id, file_id, name) VALUES (?, ?, ?, ?)',
        [req.user.id, folderId, fileRecord.id, file.originalname]
      );

      saved.push({ id: ufResult.lastID, name: file.originalname, md5: archived.md5, size: archived.size, duplicate: false });
    }

    return res.json({ message: '上传成功', count: saved.length, files: saved });
  } catch (err) {
    return res.status(500).json({ message: '上传失败', error: err.message });
  }
});

// ===== 秒传 =====

app.post('/files/instant', authRequired, async (req, res) => {
  try {
    const { files: fileList, folderId } = req.body;
    if (!Array.isArray(fileList) || !fileList.length) {
      return res.status(400).json({ message: 'files 必须是非空数组' });
    }
    if (fileList.length > 100) {
      return res.status(400).json({ message: '单次最多秒传 100 个文件' });
    }

    const targetFolderId = folderId || null;
    if (targetFolderId) {
      const folder = await get('SELECT id FROM user_folders WHERE id = ? AND user_id = ?', [targetFolderId, req.user.id]);
      if (!folder) return res.status(400).json({ message: '文件夹不存在' });
    }

    const results = [];
    for (const item of fileList) {
      const { md5, originalName } = item;
      if (!md5 || !originalName) {
        results.push({ md5, originalName, success: false, message: 'md5 和 originalName 必填' });
        continue;
      }
      if (!isValidFileName(originalName)) {
        results.push({ md5, originalName, success: false, message: '文件名不合法' });
        continue;
      }

      const fileRecord = await get('SELECT id, stored_name, size FROM files WHERE md5 = ?', [md5]);
      if (!fileRecord) {
        results.push({ md5, originalName, success: false, message: '该 md5 文件不存在，请走正常上传' });
        continue;
      }

      const filePath = getFilePath(md5, fileRecord.stored_name);
      if (!(await fileExists(filePath))) {
        results.push({ md5, originalName, success: false, message: '物理文件丢失，请走正常上传' });
        continue;
      }

      // 重复检查
      const duplicate = await get(
        'SELECT id FROM user_files WHERE user_id = ? AND folder_id IS ? AND file_id = ? AND name = ?',
        [req.user.id, targetFolderId, fileRecord.id, originalName]
      );
      if (duplicate) {
        results.push({ md5, originalName, success: true, id: duplicate.id, size: fileRecord.size, duplicate: true });
        continue;
      }

      const ufResult = await run(
        'INSERT INTO user_files(user_id, folder_id, file_id, name) VALUES (?, ?, ?, ?)',
        [req.user.id, targetFolderId, fileRecord.id, originalName]
      );
      results.push({ md5, originalName, success: true, id: ufResult.lastID, size: fileRecord.size });
    }

    const successCount = results.filter(r => r.success).length;
    return res.json({ message: `秒传完成，成功 ${successCount}/${results.length}`, results });
  } catch (err) {
    return res.status(500).json({ message: '秒传失败', error: err.message });
  }
});

// ===== 文件夹 CRUD =====

// 获取当前目录内容（文件夹 + 文件）
app.get('/drive', authRequired, async (req, res) => {
  try {
    const folderId = req.query.folderId || null;
    const search = req.query.name || '';

    // 获取子文件夹
    let folderSql = 'SELECT id, name, created_at FROM user_folders WHERE user_id = ? AND parent_id IS ?';
    const folderParams = [req.user.id, folderId];
    if (search) {
      folderSql += ' AND name LIKE ?';
      folderParams.push(`%${search}%`);
    }
    folderSql += ' ORDER BY name';
    const folders = await all(folderSql, folderParams);

    // 获取文件
    let fileSql = `SELECT uf.id, uf.name, uf.created_at, f.md5, f.size, f.mime_type
                   FROM user_files uf
                   JOIN files f ON uf.file_id = f.id
                   WHERE uf.user_id = ? AND uf.folder_id IS ?`;
    const fileParams = [req.user.id, folderId];
    if (search) {
      fileSql += ' AND uf.name LIKE ?';
      fileParams.push(`%${search}%`);
    }
    fileSql += ' ORDER BY uf.id DESC';
    const files = await all(fileSql, fileParams);

    // 面包屑路径
    const breadcrumb = [];
    let currentId = folderId;
    while (currentId) {
      const f = await get('SELECT id, name, parent_id FROM user_folders WHERE id = ? AND user_id = ?', [currentId, req.user.id]);
      if (!f) break;
      breadcrumb.unshift({ id: f.id, name: f.name });
      currentId = f.parent_id;
    }

    return res.json({ folders, files, breadcrumb });
  } catch (err) {
    return res.status(500).json({ message: '获取目录失败', error: err.message });
  }
});

// 创建文件夹
app.post('/drive/folder', authRequired, async (req, res) => {
  try {
    const { name, parentId } = req.body;
    if (!name || !isValidFileName(name)) {
      return res.status(400).json({ message: '文件夹名不合法' });
    }

    const targetParent = parentId || null;
    if (targetParent) {
      const parent = await get('SELECT id FROM user_folders WHERE id = ? AND user_id = ?', [targetParent, req.user.id]);
      if (!parent) return res.status(400).json({ message: '父文件夹不存在' });
    }

    // 同级同名检查
    const existing = await get(
      'SELECT id FROM user_folders WHERE user_id = ? AND parent_id IS ? AND name = ?',
      [req.user.id, targetParent, name]
    );
    if (existing) {
      return res.status(409).json({ message: '同名文件夹已存在' });
    }

    const result = await run(
      'INSERT INTO user_folders(user_id, parent_id, name) VALUES (?, ?, ?)',
      [req.user.id, targetParent, name]
    );
    return res.json({ message: '创建成功', id: result.lastID, name });
  } catch (err) {
    return res.status(500).json({ message: '创建文件夹失败', error: err.message });
  }
});

// 重命名文件夹
app.put('/drive/folder/:id', authRequired, async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    if (!name || !isValidFileName(name)) {
      return res.status(400).json({ message: '文件夹名不合法' });
    }

    const folder = await get('SELECT id, parent_id FROM user_folders WHERE id = ? AND user_id = ?', [id, req.user.id]);
    if (!folder) return res.status(404).json({ message: '文件夹不存在' });

    // 同级同名检查
    const existing = await get(
      'SELECT id FROM user_folders WHERE user_id = ? AND parent_id IS ? AND name = ? AND id != ?',
      [req.user.id, folder.parent_id, name, id]
    );
    if (existing) return res.status(409).json({ message: '同名文件夹已存在' });

    await run('UPDATE user_folders SET name = ? WHERE id = ?', [name, id]);
    return res.json({ message: '重命名成功' });
  } catch (err) {
    return res.status(500).json({ message: '重命名失败', error: err.message });
  }
});

// 删除文件夹（递归删除子文件夹和文件引用）
app.delete('/drive/folder/:id', authRequired, async (req, res) => {
  try {
    const { id } = req.params;
    const folder = await get('SELECT id FROM user_folders WHERE id = ? AND user_id = ?', [id, req.user.id]);
    if (!folder) return res.status(404).json({ message: '文件夹不存在' });

    // 递归收集所有子文件夹 ID
    async function collectFolderIds(folderId) {
      const ids = [folderId];
      const children = await all('SELECT id FROM user_folders WHERE parent_id = ? AND user_id = ?', [folderId, req.user.id]);
      for (const child of children) {
        const childIds = await collectFolderIds(child.id);
        ids.push(...childIds);
      }
      return ids;
    }

    const allFolderIds = await collectFolderIds(Number(id));
    const placeholders = allFolderIds.map(() => '?').join(',');

    // 删除这些文件夹下的所有文件引用
    await run(`DELETE FROM user_files WHERE user_id = ? AND folder_id IN (${placeholders})`, [req.user.id, ...allFolderIds]);
    // 删除文件夹
    await run(`DELETE FROM user_folders WHERE user_id = ? AND id IN (${placeholders})`, [req.user.id, ...allFolderIds]);

    return res.json({ message: '删除成功' });
  } catch (err) {
    return res.status(500).json({ message: '删除文件夹失败', error: err.message });
  }
});

// ===== 用户文件操作 =====

// 重命名文件
app.put('/drive/file/:id', authRequired, async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    if (!name || !isValidFileName(name)) {
      return res.status(400).json({ message: '文件名不合法' });
    }

    const file = await get('SELECT id FROM user_files WHERE id = ? AND user_id = ?', [id, req.user.id]);
    if (!file) return res.status(404).json({ message: '文件不存在' });

    await run('UPDATE user_files SET name = ? WHERE id = ?', [name, id]);
    return res.json({ message: '重命名成功' });
  } catch (err) {
    return res.status(500).json({ message: '重命名失败', error: err.message });
  }
});

// 删除文件（仅删除用户引用，不删物理文件）
app.delete('/drive/file/:id', authRequired, async (req, res) => {
  try {
    const { id } = req.params;
    const file = await get('SELECT id FROM user_files WHERE id = ? AND user_id = ?', [id, req.user.id]);
    if (!file) return res.status(404).json({ message: '文件不存在' });

    await run('DELETE FROM user_files WHERE id = ? AND user_id = ?', [id, req.user.id]);
    return res.json({ message: '删除成功' });
  } catch (err) {
    return res.status(500).json({ message: '删除失败', error: err.message });
  }
});

// 移动文件/文件夹到另一个文件夹
app.post('/drive/move', authRequired, async (req, res) => {
  try {
    const { type, id, targetFolderId } = req.body;
    const target = targetFolderId || null;

    if (target) {
      const folder = await get('SELECT id FROM user_folders WHERE id = ? AND user_id = ?', [target, req.user.id]);
      if (!folder) return res.status(400).json({ message: '目标文件夹不存在' });
    }

    if (type === 'folder') {
      const folder = await get('SELECT id FROM user_folders WHERE id = ? AND user_id = ?', [id, req.user.id]);
      if (!folder) return res.status(404).json({ message: '文件夹不存在' });
      if (Number(id) === Number(target)) return res.status(400).json({ message: '不能移动到自身' });

      // 检查目标是否是自己的子孙文件夹（防止循环）
      if (target) {
        let checkId = target;
        while (checkId) {
          if (Number(checkId) === Number(id)) {
            return res.status(400).json({ message: '不能移动到自身的子文件夹中' });
          }
          const parent = await get('SELECT parent_id FROM user_folders WHERE id = ? AND user_id = ?', [checkId, req.user.id]);
          checkId = parent ? parent.parent_id : null;
        }
      }

      await run('UPDATE user_folders SET parent_id = ? WHERE id = ?', [target, id]);
    } else {
      const file = await get('SELECT id FROM user_files WHERE id = ? AND user_id = ?', [id, req.user.id]);
      if (!file) return res.status(404).json({ message: '文件不存在' });
      await run('UPDATE user_files SET folder_id = ? WHERE id = ?', [target, id]);
    }

    return res.json({ message: '移动成功' });
  } catch (err) {
    return res.status(500).json({ message: '移动失败', error: err.message });
  }
});

// ===== 文件下载 =====

// ===== 应用接入 API =====

app.get('/api/v1/files', apiTokenRequired(['files:read']), async (req, res) => {
  try {
    const folderId = req.query.folderId || req.apiAuth.rootFolderId;
    const targetFolderId = await requireFolderInsideRoot(folderId, req.apiAuth.rootFolderId, req.apiAuth.userId);
    const files = await all(
      `SELECT uf.id, uf.name, uf.created_at, f.md5, f.size, f.mime_type
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
    if (!isValidFileName(name)) return res.status(400).json({ message: '文件夹名称不合法' });

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

app.post('/api/v1/files/upload', apiTokenRequired(['files:upload']), (req, res, next) => {
  uploader.array('files', 20)(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ message: '文件字段名必须为 files' });
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ message: '单个文件不能超过 50MB' });
      if (err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ message: '单次最多上传 20 个文件' });
      return res.status(400).json({ message: '上传出错', error: err.message });
    }
    next();
  });
}, async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ message: '请至少上传一个文件，字段名为 files' });

    const targetFolderId = await requireFolderInsideRoot(req.body.folderId, req.apiAuth.rootFolderId, req.apiAuth.userId);
    const withAccessLink = req.body.withAccessLink === 'true' || req.body.withAccessLink === true;
    const expiresInSeconds = req.body.expiresInSeconds ? Number(req.body.expiresInSeconds) : null;
    const saved = [];

    for (const file of files) {
      const item = await saveUploadedFileReference(file, req.apiAuth.userId, targetFolderId);
      if (withAccessLink && req.apiAuth.scopes.includes('links:create')) {
        item.accessLink = await createAccessLink({
          req,
          userId: req.apiAuth.userId,
          integrationId: req.apiAuth.integrationId,
          userFileId: item.id,
          expiresInSeconds,
          disposition: req.body.disposition,
        });
      }
      saved.push(item);
    }

    return res.json({ message: '上传成功', rootFolderId: req.apiAuth.rootFolderId, folderId: targetFolderId, count: saved.length, files: saved });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({ message: status === 403 ? '目标目录不在应用根目录内' : '应用上传失败', error: err.message });
  }
});

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
    return res.json({ message: '创建访问链接成功', file: { id: file.id, name: file.name, md5: file.md5 }, accessLink: link });
  } catch (err) {
    return res.status(500).json({ message: '创建访问链接失败', error: err.message });
  }
});

app.delete('/api/v1/files/:id', apiTokenRequired(['files:delete']), async (req, res) => {
  try {
    const file = await requireUserFileInsideRoot(req.params.id, req.apiAuth.rootFolderId, req.apiAuth.userId);
    if (!file) return res.status(404).json({ message: '文件不存在或不在应用根目录内' });
    await run('DELETE FROM user_files WHERE id = ? AND user_id = ?', [file.id, req.apiAuth.userId]);
    return res.json({ message: '删除成功' });
  } catch (err) {
    return res.status(500).json({ message: '删除应用文件失败', error: err.message });
  }
});

app.get('/access/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const link = await get(
      `SELECT al.id, al.user_file_id, al.disposition, al.expires_at, al.max_uses, al.use_count, al.revoked_at,
              uf.name, f.md5, f.stored_name, f.mime_type
       FROM access_links al
       JOIN user_files uf ON al.user_file_id = uf.id
       JOIN files f ON uf.file_id = f.id
       WHERE al.token_hash = ?`,
      [hashApiToken(token)]
    );

    if (!link || link.revoked_at) return res.status(404).json({ message: '访问链接不存在' });
    if (link.expires_at && new Date(link.expires_at).getTime() <= Date.now()) {
      return res.status(410).json({ message: '访问链接已过期' });
    }
    if (link.max_uses && link.use_count >= link.max_uses) {
      return res.status(410).json({ message: '访问链接已超过使用次数' });
    }

    const filePath = getFilePath(link.md5, link.stored_name);
    if (!(await fileExists(filePath))) return res.status(404).json({ message: '文件物理路径不存在' });

    await run('UPDATE access_links SET use_count = use_count + 1 WHERE id = ?', [link.id]);
    const fileName = req.query.name || link.name || link.stored_name;
    if (link.mime_type) res.type(link.mime_type);
    if (link.disposition === 'download') {
      return res.download(filePath, fileName);
    }
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`);
    return res.sendFile(filePath);
  } catch (err) {
    return res.status(500).json({ message: '访问文件失败', error: err.message });
  }
});

app.get('/files/:md5/download', authRequired, async (req, res) => {
  try {
    const { md5 } = req.params;

    // 验证该用户有引用此文件
    const userFile = await get(
      `SELECT uf.name FROM user_files uf JOIN files f ON uf.file_id = f.id WHERE f.md5 = ? AND uf.user_id = ? LIMIT 1`,
      [md5, req.user.id]
    );
    if (!userFile) return res.status(404).json({ message: '文件不存在' });

    const record = await get('SELECT stored_name FROM files WHERE md5 = ?', [md5]);
    if (!record) return res.status(404).json({ message: '文件不存在' });

    const filePath = getFilePath(md5, record.stored_name);
    if (!(await fileExists(filePath))) {
      return res.status(404).json({ message: '文件物理路径不存在' });
    }

    const fileName = req.query.name || userFile.name || record.stored_name;
    return res.download(filePath, fileName);
  } catch (err) {
    return res.status(500).json({ message: '下载失败', error: err.message });
  }
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('未捕获错误:', err);
  res.status(500).json({ message: '服务器内部错误' });
});

async function bootstrap() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

bootstrap().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
