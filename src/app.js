require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const { initDb, run, get, all } = require('./db');
const { hashPassword, comparePassword, signToken } = require('./utils/security');
const { authRequired } = require('./middleware/auth');

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
app.set('trust proxy', true);
app.use(express.static(path.join(__dirname, '..', 'public')));

const uploader = multer({
  dest: tempRoot,
  limits: {
    files: 20,
    fileSize: 50 * 1024 * 1024,
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
    await fs.promises.rename(file.path, targetPath);
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

app.get('/files/:md5/download', async (req, res) => {
  try {
    const { md5 } = req.params;
    const record = await get('SELECT stored_name FROM files WHERE md5 = ?', [md5]);
    if (!record) return res.status(404).json({ message: '文件不存在' });

    const filePath = getFilePath(md5, record.stored_name);
    if (!(await fileExists(filePath))) {
      return res.status(404).json({ message: '文件物理路径不存在' });
    }

    // 尝试从 query 获取文件名
    const fileName = req.query.name || record.stored_name;
    return res.download(filePath, fileName);
  } catch (err) {
    return res.status(500).json({ message: '下载失败', error: err.message });
  }
});

// ===== 根路由 =====

app.get('/', (_req, res) => {
  res.json({ message: '文件管理系统服务运行中' });
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
