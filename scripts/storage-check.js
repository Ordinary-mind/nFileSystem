#!/usr/bin/env node

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const fs = require('fs');
const path = require('path');

const { initDb, get, all, closeDb } = require('../src/db');
const {
  uploadRoot,
  tempRoot,
  ensureStorageDirs,
  getStoragePath,
  verifyFileRecord,
  unlinkIfExists,
} = require('../src/storage');
const { thumbnailRoot, getThumbnailPath } = require('../src/thumbnail');

const quick = process.argv.includes('--quick');
const cleanOrphans = process.argv.includes('--clean-orphans');

async function collectPhysicalFiles(rootDir) {
  const files = [];
  if (!fs.existsSync(rootDir)) return files;
  const pending = [rootDir];
  while (pending.length) {
    const current = pending.pop();
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entryPath === tempRoot) continue;
      if (entry.isDirectory()) pending.push(entryPath);
      else files.push(entryPath);
    }
  }
  return files;
}

async function collectLogicalIssues() {
  const issues = [];
  const folderReferences = await all(`
    SELECT f.id,
      CASE WHEN u.id IS NULL THEN 'folder_missing_user' ELSE 'folder_invalid_parent' END AS reason
    FROM user_folders f
    LEFT JOIN users u ON u.id = f.user_id
    LEFT JOIN user_folders p ON p.id = f.parent_id AND p.user_id = f.user_id
    WHERE u.id IS NULL OR (f.parent_id IS NOT NULL AND p.id IS NULL)
  `);
  issues.push(...folderReferences);

  const folderCycles = await all(`
    WITH RECURSIVE ancestry(start_id, id, parent_id, path, cycle) AS (
      SELECT id, id, parent_id, printf('/%d/', id), 0 FROM user_folders
      UNION ALL
      SELECT a.start_id, p.id, p.parent_id, a.path || p.id || '/',
        instr(a.path, printf('/%d/', p.id)) > 0
      FROM ancestry a
      JOIN user_folders p ON p.id = a.parent_id
      WHERE a.parent_id IS NOT NULL AND a.cycle = 0
    )
    SELECT DISTINCT start_id AS id, 'folder_cycle' AS reason
    FROM ancestry WHERE cycle = 1
  `);
  issues.push(...folderCycles);

  const fileReferences = await all(`
    SELECT uf.id,
      CASE
        WHEN u.id IS NULL THEN 'user_file_missing_user'
        WHEN f.id IS NULL THEN 'user_file_missing_blob'
        ELSE 'user_file_invalid_folder'
      END AS reason
    FROM user_files uf
    LEFT JOIN users u ON u.id = uf.user_id
    LEFT JOIN files f ON f.id = uf.file_id
    LEFT JOIN user_folders d ON d.id = uf.folder_id AND d.user_id = uf.user_id
    WHERE u.id IS NULL OR f.id IS NULL OR (uf.folder_id IS NOT NULL AND d.id IS NULL)
  `);
  issues.push(...fileReferences);

  const duplicateFolders = await all(`
    SELECT MIN(id) AS id, 'duplicate_folder' AS reason
    FROM user_folders
    GROUP BY user_id, parent_id, name HAVING COUNT(*) > 1
  `);
  issues.push(...duplicateFolders);

  const duplicateFiles = await all(`
    SELECT MIN(id) AS id, 'duplicate_user_file' AS reason
    FROM user_files
    GROUP BY user_id, folder_id, file_id, name HAVING COUNT(*) > 1
  `);
  issues.push(...duplicateFiles);

  const unreferencedFiles = await all(`
    SELECT f.id, 'unreferenced_file_record' AS reason
    FROM files f
    WHERE NOT EXISTS (SELECT 1 FROM user_files uf WHERE uf.file_id = f.id)
  `);
  issues.push(...unreferencedFiles);

  const foreignKeyIssues = await all('PRAGMA foreign_key_check');
  for (const item of foreignKeyIssues) {
    issues.push({ id: item.rowid, reason: `foreign_key:${item.table}:${item.parent}` });
  }
  return issues;
}

async function main() {
  await ensureStorageDirs();
  await initDb();
  const integrity = await get('PRAGMA integrity_check');
  const integrityResult = integrity && integrity.integrity_check;
  if (integrityResult !== 'ok') {
    console.error(`SQLite 完整性检查失败: ${integrityResult || 'unknown'}`);
    process.exitCode = 1;
    return;
  }

  const records = await all(`
    SELECT id, sha256, size
    FROM files ORDER BY id
  `);
  const logicalIssues = await collectLogicalIssues();
  const expectedPaths = new Set();
  const invalid = [];

  for (const record of records) {
    try {
      expectedPaths.add(path.resolve(getStoragePath(record)));
      const result = await verifyFileRecord(record, !quick);
      if (!result.ok) invalid.push({ id: record.id, reason: result.reason, path: result.filePath });
    } catch (err) {
      invalid.push({ id: record.id, reason: err.message });
    }
  }

  const physicalFiles = await collectPhysicalFiles(uploadRoot);
  const orphans = physicalFiles.filter((filePath) => !expectedPaths.has(path.resolve(filePath)));
  const expectedThumbnails = new Set(records.map((record) => path.resolve(getThumbnailPath(record))));
  const thumbnailFiles = await collectPhysicalFiles(thumbnailRoot);
  const orphanThumbnails = thumbnailFiles.filter((filePath) => !expectedThumbnails.has(path.resolve(filePath)));
  let cleaned = 0;
  if (cleanOrphans) {
    // 只清理不在数据库期望集合中的普通文件，临时目录由服务按时效单独回收。
    for (const filePath of orphans) {
      if (await unlinkIfExists(filePath)) cleaned++;
    }
    for (const filePath of orphanThumbnails) {
      if (await unlinkIfExists(filePath)) cleaned++;
    }
  }

  console.log(`SQLite: ok`);
  console.log(`数据库文件记录: ${records.length}`);
  console.log(`逻辑引用异常: ${logicalIssues.length}`);
  console.log(`异常文件记录: ${invalid.length}`);
  console.log(`无引用物理文件: ${orphans.length}${cleanOrphans ? `，已清理 ${cleaned}` : ''}`);
  console.log(`无引用缩略图: ${orphanThumbnails.length}`);
  for (const item of invalid.slice(0, 20)) {
    console.error(`- file_id=${item.id}: ${item.reason}${item.path ? ` (${item.path})` : ''}`);
  }
  for (const item of logicalIssues.slice(0, 20)) {
    console.error(`- record_id=${item.id ?? 'unknown'}: ${item.reason}`);
  }
  for (const filePath of orphans.slice(0, 20)) console.error(`- orphan: ${filePath}`);
  for (const filePath of orphanThumbnails.slice(0, 20)) console.error(`- orphan thumbnail: ${filePath}`);
  if (invalid.length || logicalIssues.length || ((orphans.length || orphanThumbnails.length) && !cleanOrphans)) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('存储校验失败:', err);
    process.exitCode = 1;
  })
  .finally(() => closeDb().catch((err) => {
    console.error('关闭数据库失败:', err.message);
    process.exitCode = 1;
  }));
