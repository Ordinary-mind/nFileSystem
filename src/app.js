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

// Multer 临时存储目录，用于接收上传文件后再进行 MD5 归档
const uploader = multer({
  dest: tempRoot,
  limits: {
    files: 20,
    fileSize: 50 * 1024 * 1024, // 单文件最大 50MB
  },
});

/**
 * 流式计算文件 MD5，不会将整个文件读入内存
 */
function calculateMD5(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * 异步检查文件是否存在
 */
async function fileExists(filePath) {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 将临时文件归档为 md5 分层目录
 */
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

  return {
    md5,
    storedName,
  };
}

/**
 * 注册
 */
app.post('/auth/register', async (req, res) => {
  try {
    const { name, password } = req.body;
    if (!name || !password) {
      return res.status(400).json({ message: 'name 和 password 必填' });
    }

    const hashed = await hashPassword(password);
    await run('INSERT INTO users(name, password) VALUES (?, ?)', [name, hashed]);
    return res.json({ message: '注册成功' });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ message: '用户名已存在' });
    }
    return res.status(500).json({ message: '注册失败', error: err.message });
  }
});

/**
 * 登录
 */
app.post('/auth/login', async (req, res) => {
  try {
    const { name, password } = req.body;
    if (!name || !password) {
      return res.status(400).json({ message: 'name 和 password 必填' });
    }

    const user = await get('SELECT id, name, password FROM users WHERE name = ?', [name]);
    if (!user) {
      return res.status(401).json({ message: '用户名或密码错误' });
    }

    const match = await comparePassword(password, user.password);
    if (!match) {
      return res.status(401).json({ message: '用户名或密码错误' });
    }

    const token = signToken({ id: user.id, name: user.name });
    return res.json({
      message: '登录成功',
      token,
      user: { id: user.id, name: user.name },
    });
  } catch (err) {
    return res.status(500).json({ message: '登录失败', error: err.message });
  }
});

/**
 * 批量上传（需要鉴权）
 * form-data: files[]
 */
app.post('/files/upload', authRequired, (req, res, next) => {
  uploader.array('files', 20)(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ message: '文件字段名必须为 files' });
      }
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ message: '单个文件不能超过 50MB' });
      }
      if (err.code === 'LIMIT_FILE_COUNT') {
        return res.status(400).json({ message: '单次最多上传 20 个文件' });
      }
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

    const saved = [];
    for (const file of files) {
      const archived = await persistFileByMD5(file);

      // 同一用户、同一 md5、同一原始文件名视为重复，不再插入
      const existing = await get(
        `SELECT id FROM files WHERE user_id = ? AND md5 = ? AND original_name = ?`,
        [req.user.id, archived.md5, file.originalname]
      );

      if (existing) {
        saved.push({
          id: existing.id,
          originalName: file.originalname,
          storedName: archived.storedName,
          md5: archived.md5,
          size: file.size,
          duplicate: true,
        });
        continue;
      }

      const result = await run(
        `INSERT INTO files(user_id, original_name, stored_name, md5, size, mime_type)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          req.user.id,
          file.originalname,
          archived.storedName,
          archived.md5,
          file.size,
          file.mimetype,
        ]
      );

      saved.push({
        id: result.lastID,
        originalName: file.originalname,
        storedName: archived.storedName,
        md5: archived.md5,
        size: file.size,
        duplicate: false,
      });
    }

    return res.json({
      message: '上传成功',
      count: saved.length,
      files: saved,
    });
  } catch (err) {
    return res.status(500).json({ message: '上传失败', error: err.message });
  }
});

/**
 * 校验文件名是否合法
 */
function isValidFileName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.length > 255) return false;
  // 禁止路径分隔符和特殊控制字符
  if (/[/\\<>:"|?*\x00-\x1f]/.test(name)) return false;
  // 禁止 . 和 .. 作为文件名
  if (name === '.' || name === '..') return false;
  return true;
}

/**
 * 批量秒传确认（需要鉴权）
 * POST /files/instant
 * Body: { files: [{ md5: "abc123...", originalName: "report.pdf" }, ...] }
 * 文件已存在时，直接为当前用户创建文件记录，无需重新上传
 */
app.post('/files/instant', authRequired, async (req, res) => {
  try {
    const { files: fileList } = req.body;
    if (!Array.isArray(fileList) || !fileList.length) {
      return res.status(400).json({ message: 'files 必须是非空数组' });
    }

    if (fileList.length > 100) {
      return res.status(400).json({ message: '单次最多秒传 100 个文件' });
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

      const existing = await get(
        'SELECT stored_name, size, mime_type FROM files WHERE md5 = ? LIMIT 1',
        [md5]
      );

      if (!existing) {
        results.push({ md5, originalName, success: false, message: '该 md5 文件不存在，请走正常上传' });
        continue;
      }

      // 验证物理文件确实存在
      const filePath = path.join(
        uploadRoot,
        md5.slice(0, 2),
        md5.slice(2, 4),
        existing.stored_name
      );

      if (!(await fileExists(filePath))) {
        results.push({ md5, originalName, success: false, message: '物理文件丢失，请走正常上传' });
        continue;
      }

      const result = await run(
        `INSERT INTO files(user_id, original_name, stored_name, md5, size, mime_type)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          req.user.id,
          originalName,
          existing.stored_name,
          md5,
          existing.size,
          existing.mime_type,
        ]
      );

      results.push({
        md5,
        originalName,
        success: true,
        id: result.lastID,
        size: existing.size,
      });
    }

    const successCount = results.filter((r) => r.success).length;
    return res.json({
      message: `秒传完成，成功 ${successCount}/${results.length}`,
      results,
    });
  } catch (err) {
    return res.status(500).json({ message: '秒传失败', error: err.message });
  }
});

/**
 * 文件列表（需要鉴权）
 * Query: name - 模糊搜索文件名（可选）
 */
app.get('/files', authRequired, async (req, res) => {
  try {
    const { name } = req.query;
    let sql = `SELECT id, original_name, stored_name, md5, size, mime_type, created_at
               FROM files
               WHERE user_id = ?`;
    const params = [req.user.id];

    if (name && typeof name === 'string') {
      sql += ' AND original_name LIKE ?';
      params.push(`%${name}%`);
    }

    sql += ' ORDER BY id DESC';

    const rows = await all(sql, params);

    return res.json({
      count: rows.length,
      files: rows,
    });
  } catch (err) {
    return res.status(500).json({ message: '获取文件列表失败', error: err.message });
  }
});

/**
 * 文件下载（公开接口，知道md5即可下载）
 */
app.get('/files/:md5/download', async (req, res) => {
  try {
    const { md5 } = req.params;

    const record = await get(
      'SELECT id, original_name, stored_name, md5 FROM files WHERE md5 = ?',
      [md5]
    );

    if (!record) {
      return res.status(404).json({ message: '文件不存在' });
    }

    const filePath = path.join(
      uploadRoot,
      record.md5.slice(0, 2),
      record.md5.slice(2, 4),
      record.stored_name
    );

    if (!(await fileExists(filePath))) {
      return res.status(404).json({ message: '文件物理路径不存在' });
    }

    return res.download(filePath, record.original_name);
  } catch (err) {
    return res.status(500).json({ message: '下载失败', error: err.message });
  }
});

app.get('/', (_req, res) => {
  res.json({ message: '文件管理系统服务运行中' });
});

/**
 * 全局错误处理中间件
 */
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  // eslint-disable-next-line no-console
  console.error('未捕获错误:', err);
  res.status(500).json({ message: '服务器内部错误' });
});

async function bootstrap() {
  await initDb();
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('启动失败:', err);
  process.exit(1);
});
