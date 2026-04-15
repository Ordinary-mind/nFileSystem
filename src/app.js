const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const { initDb, run, get, all } = require('./db');
const { hashPassword, signToken } = require('./utils/security');
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
 * 根据文件内容计算 md5
 */
async function calculateMD5(filePath) {
  const buffer = await fs.promises.readFile(filePath);
  return crypto.createHash('md5').update(buffer).digest('hex');
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

  // 若文件已存在（同 MD5 + 同扩展名），直接复用；否则移动到目标目录
  if (!fs.existsSync(targetPath)) {
    await fs.promises.rename(file.path, targetPath);
  } else {
    await fs.promises.unlink(file.path);
  }

  return {
    md5,
    storedName,
    relativePath: path.join(level1, level2, storedName).replace(/\\/g, '/'),
    absolutePath: targetPath,
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

    const hashed = hashPassword(password);
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

    const hashed = hashPassword(password);
    if (user.password !== hashed) {
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
app.post('/files/upload', authRequired, uploader.array('files', 20), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ message: '请至少上传一个文件，字段名为 files' });
    }

    const saved = [];
    for (const file of files) {
      const archived = await persistFileByMD5(file);

      const result = await run(
        `INSERT INTO files(user_id, original_name, stored_name, relative_path, md5, size, mime_type)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          req.user.id,
          file.originalname,
          archived.storedName,
          archived.relativePath,
          archived.md5,
          file.size,
          file.mimetype,
        ]
      );

      saved.push({
        id: result.lastID,
        originalName: file.originalname,
        storedName: archived.storedName,
        relativePath: archived.relativePath,
        md5: archived.md5,
        size: file.size,
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
 * 文件列表（需要鉴权）
 * 方便拿到文件 id 后调用下载接口
 */
app.get('/files', authRequired, async (req, res) => {
  try {
    const rows = await all(
      `SELECT id, original_name, stored_name, relative_path, md5, size, mime_type, created_at
       FROM files
       WHERE user_id = ?
       ORDER BY id DESC`,
      [req.user.id]
    );

    return res.json({
      count: rows.length,
      files: rows,
    });
  } catch (err) {
    return res.status(500).json({ message: '获取文件列表失败', error: err.message });
  }
});

/**
 * 文件下载（需要鉴权，且只能下载自己的文件）
 */
app.get('/files/:id/download', authRequired, async (req, res) => {
  try {
    const { id } = req.params;

    const record = await get(
      'SELECT id, user_id, original_name, relative_path FROM files WHERE id = ? AND user_id = ?',
      [id, req.user.id]
    );

    if (!record) {
      return res.status(404).json({ message: '文件不存在或无权限' });
    }

    const filePath = path.join(uploadRoot, ...record.relative_path.split('/'));
    if (!fs.existsSync(filePath)) {
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
