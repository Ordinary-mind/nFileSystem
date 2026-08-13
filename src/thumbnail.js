const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { dataDir } = require('./db');
const { getStoragePath, unlinkIfExists } = require('./storage');

const thumbnailRoot = path.join(dataDir, 'thumbnails', 'v1');
const supportedMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const concurrency = Math.min(4, Math.max(1, Number.parseInt(process.env.THUMBNAIL_CONCURRENCY || '2', 10) || 2));
const pending = new Map();
const waiters = [];
let active = 0;

function cacheKey(record) {
  return record.sha256;
}

function getThumbnailPath(record) {
  const key = cacheKey(record);
  return path.join(thumbnailRoot, key.slice(0, 2), key.slice(2, 4), `${key}.webp`);
}

async function acquire() {
  if (active < concurrency) {
    active += 1;
    return;
  }
  await new Promise((resolve) => waiters.push(resolve));
  active += 1;
}

function release() {
  active -= 1;
  waiters.shift()?.();
}

async function generate(record, target) {
  await acquire();
  const temp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await sharp(getStoragePath(record), { animated: false, limitInputPixels: 80_000_000 })
      .rotate()
      .resize(160, 160, { fit: 'cover', position: 'centre' })
      .webp({ quality: 72 })
      .toFile(temp);
    try {
      await fs.promises.rename(temp, target);
    } catch (err) {
      if (err.code !== 'EEXIST' && err.code !== 'EPERM') throw err;
      await unlinkIfExists(temp);
    }
    return target;
  } catch (err) {
    await unlinkIfExists(temp).catch(() => {});
    if (['Input file contains unsupported image format', 'Input file has corrupt header'].some((text) => err.message.includes(text))) {
      return null;
    }
    if (err.code === 'ENOENT' || /image|pixel|corrupt|unsupported|invalid/i.test(err.message)) return null;
    throw err;
  } finally {
    release();
  }
}

async function getOrCreateThumbnail(record) {
  if (!supportedMimeTypes.has(String(record.mime_type || '').toLowerCase())) return null;
  const target = getThumbnailPath(record);
  try {
    await fs.promises.access(target, fs.constants.R_OK);
    return target;
  } catch {
    // 缓存未命中时才进入受控生成队列。
  }
  const key = cacheKey(record);
  if (!pending.has(key)) {
    const task = generate(record, target).finally(() => pending.delete(key));
    pending.set(key, task);
  }
  return pending.get(key);
}

async function removeThumbnail(record) {
  await unlinkIfExists(getThumbnailPath(record));
}

module.exports = {
  thumbnailRoot,
  getThumbnailPath,
  getOrCreateThumbnail,
  removeThumbnail,
};
