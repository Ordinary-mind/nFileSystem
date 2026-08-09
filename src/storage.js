const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const uploadRoot = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, '..', 'uploads');
const tempRoot = path.join(uploadRoot, 'tmp');

let storageQueue = Promise.resolve();

function withStorageLock(operation) {
  const result = storageQueue.then(operation);
  storageQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function ensureStorageDirs() {
  await fs.promises.mkdir(tempRoot, { recursive: true });
}

function isDigest(value, length) {
  return typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
}

function getStoragePath(record) {
  const storageKey = record.storage_key || record.sha256 || record.md5;
  if (!isDigest(storageKey, 32) && !isDigest(storageKey, 64)) {
    throw new Error('存储键不合法');
  }
  if (!record.stored_name || path.basename(record.stored_name) !== record.stored_name) {
    throw new Error('存储文件名不合法');
  }
  return path.join(uploadRoot, storageKey.slice(0, 2), storageKey.slice(2, 4), record.stored_name);
}

function getSha256StoragePath(sha256) {
  if (!isDigest(sha256, 64)) throw new Error('SHA-256 不合法');
  return path.join(uploadRoot, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
}

function calculateHashes(filePath) {
  return new Promise((resolve, reject) => {
    const md5 = crypto.createHash('md5');
    const sha256 = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    let size = 0;

    stream.on('data', (chunk) => {
      md5.update(chunk);
      sha256.update(chunk);
      size += chunk.length;
    });
    stream.on('end', () => resolve({
      md5: md5.digest('hex'),
      sha256: sha256.digest('hex'),
      size,
    }));
    stream.on('error', reject);
  });
}

async function syncFile(filePath) {
  // Windows 对只读文件句柄执行 fsync 会返回 EPERM，使用可写句柄保持落盘语义。
  const handle = await fs.promises.open(filePath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(dirPath) {
  let handle;
  try {
    handle = await fs.promises.open(dirPath, 'r');
    await handle.sync();
  } catch (err) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(err.code)) throw err;
  } finally {
    if (handle) await handle.close();
  }
}

async function unlinkIfExists(filePath) {
  try {
    await fs.promises.unlink(filePath);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

async function assertExistingBlob(targetPath, expectedSize, expectedSha256) {
  const stat = await fs.promises.stat(targetPath);
  if (!stat.isFile() || stat.size !== expectedSize) {
    const err = new Error('内容地址对应的物理文件不完整');
    err.code = 'STORAGE_INTEGRITY_ERROR';
    throw err;
  }
  const hashes = await calculateHashes(targetPath);
  if (hashes.sha256 !== expectedSha256) {
    const err = new Error('内容地址对应的物理文件摘要不匹配');
    err.code = 'STORAGE_INTEGRITY_ERROR';
    throw err;
  }
}

async function copyAcrossDevices(sourcePath, targetPath, expectedSize, expectedSha256) {
  const stagingPath = `${targetPath}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.copyFile(sourcePath, stagingPath, fs.constants.COPYFILE_EXCL);
    await syncFile(stagingPath);
    try {
      await fs.promises.link(stagingPath, targetPath);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      await assertExistingBlob(targetPath, expectedSize, expectedSha256);
    }
  } finally {
    await unlinkIfExists(stagingPath);
  }
}

async function finalizeTempFile(tempPath, sha256, expectedSize) {
  const targetPath = getSha256StoragePath(sha256);
  const targetDir = path.dirname(targetPath);
  await fs.promises.mkdir(targetDir, { recursive: true });

  let created = false;
  try {
    await fs.promises.link(tempPath, targetPath);
    created = true;
    await syncFile(targetPath);
  } catch (err) {
    if (err.code === 'EEXIST') {
      await assertExistingBlob(targetPath, expectedSize, sha256);
    } else if (err.code === 'EXDEV') {
      const existedBefore = await fileExists(targetPath);
      await copyAcrossDevices(tempPath, targetPath, expectedSize, sha256);
      created = !existedBefore;
    } else {
      throw err;
    }
  }

  await unlinkIfExists(tempPath);
  if (created) await syncDirectory(targetDir);
  return { targetPath, storedName: sha256, storageKey: sha256, created };
}

async function fileExists(filePath) {
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function cleanupTempFiles(files) {
  await Promise.all((files || []).map(async (file) => {
    if (!file || !file.path) return;
    try {
      await unlinkIfExists(file.path);
    } catch (err) {
      console.error('清理临时文件失败:', err.message);
    }
  }));
}

async function cleanupStaleTempFiles(maxAgeMs) {
  await ensureStorageDirs();
  const now = Date.now();
  const entries = await fs.promises.readdir(tempRoot, { withFileTypes: true });
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(tempRoot, entry.name);
    const stat = await fs.promises.stat(filePath);
    if (now - stat.mtimeMs < maxAgeMs) continue;
    if (await unlinkIfExists(filePath)) removed++;
  }
  return removed;
}

async function verifyFileRecord(record, strong = false) {
  let filePath;
  try {
    filePath = getStoragePath(record);
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return { ok: false, reason: 'not_file', filePath };
    if (stat.size !== record.size) return { ok: false, reason: 'size_mismatch', filePath };
    if (strong) {
      const hashes = await calculateHashes(filePath);
      const md5Matches = hashes.md5 === record.md5;
      const sha256Matches = !record.sha256 || hashes.sha256 === record.sha256;
      if (!md5Matches || !sha256Matches) return { ok: false, reason: 'hash_mismatch', filePath };
    }
    return { ok: true, filePath };
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, reason: 'missing', filePath };
    throw err;
  }
}

module.exports = {
  uploadRoot,
  tempRoot,
  ensureStorageDirs,
  withStorageLock,
  calculateHashes,
  getStoragePath,
  finalizeTempFile,
  fileExists,
  unlinkIfExists,
  cleanupTempFiles,
  cleanupStaleTempFiles,
  verifyFileRecord,
  isDigest,
};
