const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { after, before, test } = require('node:test');

const sqlite3 = require('sqlite3').verbose();
const sharp = require('sharp');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfilesystem-test-'));
const dataDir = path.join(testRoot, 'data');
const uploadDir = path.join(testRoot, 'uploads');

process.env.DATA_DIR = dataDir;
process.env.UPLOAD_DIR = uploadDir;
process.env.JWT_SECRET = 'test-only-secret-that-is-longer-than-32-bytes';
process.env.AUTH_CODE_SECRET = 'test-only-code-secret-that-is-longer-than-32-bytes';
process.env.TOKEN_EXPIRES_IN = '10m';
process.env.ALLOW_REGISTER = 'true';
process.env.USER_QUOTA_BYTES = String(1024 * 1024 * 1024);
process.env.MIN_FREE_BYTES = '0';
process.env.DRIVE_PAGE_SIZE = '200';
process.env.AUTH_RATE_LIMIT = '1000';
process.env.NODE_ENV = 'test';

let appModule;
let dbModule;
let storageModule;
let mailerModule;
let baseUrl;
let aliceToken;
let bobToken;

async function api(urlPath, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? options.form : JSON.stringify(options.body),
  });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
  return { response, data };
}

async function requestCode(email, purpose) {
  mailerModule.clearTestOutbox();
  const requested = await api('/auth/email-codes', { method: 'POST', body: { email, purpose } });
  assert.equal(requested.response.status, 202);
  const outbox = mailerModule.getTestOutbox();
  assert.equal(outbox.length, 1);
  return outbox[0].code;
}

async function registerAndLogin(label, password = 'password-123') {
  const email = `${label}@example.com`;
  const code = await requestCode(email, 'register');
  const registration = await api('/auth/register', { method: 'POST', body: { email, password, code } });
  assert.equal(registration.response.status, 201);
  const login = await api('/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(login.response.status, 200);
  return login.data.token;
}

async function upload(token, name, content, folderId = null) {
  const form = new FormData();
  form.append('folderId', folderId === null ? '' : String(folderId));
  form.append('files', new Blob([content], { type: 'application/octet-stream' }), name);
  return api('/files/upload', { method: 'POST', token, form });
}

async function createFolder(token, name, parentId = null) {
  const result = await api('/drive/folder', {
    method: 'POST',
    token,
    body: { name, parentId },
  });
  assert.equal(result.response.status, 200);
  return result.data.id;
}

function createVersionedDatabase(filePath, version) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filePath);
    db.exec(`CREATE TABLE files(id INTEGER PRIMARY KEY, md5 TEXT); PRAGMA user_version = ${version};`, (err) => {
      if (err) return db.close(() => reject(err));
      return db.close((closeErr) => (closeErr ? reject(closeErr) : resolve()));
    });
  });
}

before(async () => {
  appModule = require('../src/app');
  dbModule = require('../src/db');
  storageModule = require('../src/storage');
  mailerModule = require('../src/utils/mailer');
  const server = await appModule.bootstrap(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (appModule) await appModule.shutdown();
  await fs.promises.rm(testRoot, { recursive: true, force: true });
});

test('数据库使用 SHA-256 基线结构', async () => {
  const version = await dbModule.get('PRAGMA user_version');
  assert.equal(version.user_version, 2);
  const columns = await dbModule.all('PRAGMA table_info(files)');
  assert.deepEqual(columns.map((column) => column.name), ['id', 'sha256', 'size', 'mime_type', 'created_at', 'unreferenced_at']);
  await assert.rejects(
    dbModule.run('INSERT INTO files(sha256, size) VALUES (?, ?)', [`${'a'.repeat(63)}z`, 1]),
    /CHECK constraint failed/
  );
});

test('非基线数据库会拒绝启动', async () => {
  const oldDataDir = path.join(testRoot, 'old-schema');
  await fs.promises.mkdir(oldDataDir, { recursive: true });
  await createVersionedDatabase(path.join(oldDataDir, 'app.db'), 4);
  const result = spawnSync(process.execPath, ['-e', "require('./src/db').initDb().catch((err) => { console.error(err.message); process.exit(1); })"], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR: oldDataDir },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /数据库不是当前基线版本/);
});

test('安全响应头和健康检查可用', async () => {
  const health = await api('/healthz');
  assert.equal(health.response.status, 200);
  assert.equal(health.data.status, 'ok');
  assert.match(health.response.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(health.response.headers.get('x-content-type-options'), 'nosniff');
});

test('移动端模块化前端资源可正常访问', async () => {
  const index = await api('/');
  const entry = await api('/app.js');
  const main = await api('/js/main.js');
  const styles = await api('/style.css');
  assert.equal(index.response.status, 200);
  assert.match(index.data.toString(), /type="module" src="\/app\.js"/);
  assert.doesNotMatch(index.data.toString(), /id="file-page"/);
  assert.equal(entry.response.status, 200);
  assert.match(entry.data.toString(), /js\/main\.js/);
  assert.equal(main.response.status, 200);
  assert.match(main.data.toString(), /mountDrive/);
  assert.equal(styles.response.status, 200);
  assert.match(styles.data.toString(), /css\/views\.css/);
});

test('邮箱注册、重置密码和修改密码形成完整安全闭环', async () => {
  const email = 'account@example.com';
  const registerCode = await requestCode(email, 'register');
  const wrongCode = await api('/auth/register', {
    method: 'POST', body: { email, password: 'first-password', code: '000000' === registerCode ? '000001' : '000000' },
  });
  assert.equal(wrongCode.response.status, 400);
  const attempted = await dbModule.get(
    "SELECT attempts FROM verification_challenges WHERE provider_subject = ? AND purpose = 'register' AND status = 'active'",
    [email]
  );
  assert.equal(attempted.attempts, 1);

  const registered = await api('/auth/register', {
    method: 'POST', body: { email: 'Account@Example.com', password: 'first-password', code: registerCode },
  });
  assert.equal(registered.response.status, 201);
  const login = await api('/auth/login', {
    method: 'POST', body: { email: 'ACCOUNT@EXAMPLE.COM', password: 'first-password' },
  });
  assert.equal(login.response.status, 200);
  assert.equal(login.data.user.email, email);
  const firstToken = login.data.token;

  mailerModule.clearTestOutbox();
  await dbModule.run('UPDATE verification_challenges SET sent_at = 0 WHERE provider_subject = ?', [email]);
  const duplicateCode = await api('/auth/email-codes', {
    method: 'POST', body: { email, purpose: 'register' },
  });
  assert.equal(duplicateCode.response.status, 202);
  assert.equal(mailerModule.getTestOutbox().length, 0);

  mailerModule.clearTestOutbox();
  const unknownReset = await api('/auth/email-codes', {
    method: 'POST', body: { email: 'unknown@example.com', purpose: 'reset_password' },
  });
  assert.equal(unknownReset.response.status, 202);
  assert.equal(mailerModule.getTestOutbox().length, 0);

  const resetCode = await requestCode(email, 'reset_password');
  const reset = await api('/auth/password/reset', {
    method: 'POST', body: { email, code: resetCode, newPassword: 'second-password' },
  });
  assert.equal(reset.response.status, 200);
  const invalidatedByReset = await api('/drive', { token: firstToken });
  assert.equal(invalidatedByReset.response.status, 401);
  const oldPassword = await api('/auth/login', {
    method: 'POST', body: { email, password: 'first-password' },
  });
  assert.equal(oldPassword.response.status, 401);
  const secondLogin = await api('/auth/login', {
    method: 'POST', body: { email, password: 'second-password' },
  });
  assert.equal(secondLogin.response.status, 200);

  const wrongCurrent = await api('/auth/password/change', {
    method: 'POST', token: secondLogin.data.token,
    body: { currentPassword: 'wrong-password', newPassword: 'third-password' },
  });
  assert.equal(wrongCurrent.response.status, 400);
  const changed = await api('/auth/password/change', {
    method: 'POST', token: secondLogin.data.token,
    body: { currentPassword: 'second-password', newPassword: 'third-password' },
  });
  assert.equal(changed.response.status, 200);
  const invalidatedByChange = await api('/drive', { token: secondLogin.data.token });
  assert.equal(invalidatedByChange.response.status, 401);
  const replacementToken = await api('/drive', { token: changed.data.token });
  assert.equal(replacementToken.response.status, 200);

  const storedCode = await dbModule.get('SELECT code_hash FROM verification_challenges WHERE purpose = ? LIMIT 1', ['register']);
  assert.match(storedCode.code_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(storedCode.code_hash, registerCode);
});

test('邮箱验证码连续错误五次后锁定', async () => {
  const email = 'locked@example.com';
  const code = await requestCode(email, 'register');
  const wrongCode = code === '999999' ? '999998' : '999999';
  for (let attempt = 0; attempt < 5; attempt++) {
    const rejected = await api('/auth/register', {
      method: 'POST', body: { email, password: 'password-123', code: wrongCode },
    });
    assert.equal(rejected.response.status, 400);
  }
  const locked = await dbModule.get(
    "SELECT attempts, status FROM verification_challenges WHERE provider_subject = ? AND purpose = 'register'",
    [email]
  );
  assert.deepEqual(locked, { attempts: 5, status: 'locked' });
  const correctAfterLock = await api('/auth/register', {
    method: 'POST', body: { email, password: 'password-123', code },
  });
  assert.equal(correctAfterLock.response.status, 400);
});

test('秒传不能通过其他用户的 SHA-256 取得文件', async () => {
  aliceToken = await registerAndLogin('alice');
  bobToken = await registerAndLogin('bob');
  const content = Buffer.from('alice private content');
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  const uploaded = await upload(aliceToken, 'private.txt', content);
  assert.equal(uploaded.response.status, 200);

  const instant = await api('/files/instant', {
    method: 'POST',
    token: bobToken,
    body: { files: [{ sha256, originalName: 'stolen.txt' }], folderId: null },
  });
  assert.equal(instant.response.status, 200);
  assert.equal(instant.data.results[0].success, false);
  const download = await api(`/files/${sha256}/download`, { token: bobToken });
  assert.equal(download.response.status, 404);
});

test('正常上传取得的共享内容不会被其他用户删除操作误回收', async () => {
  const content = Buffer.from('alice private content');
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  const bobUpload = await upload(bobToken, 'owned-copy.txt', content);
  assert.equal(bobUpload.response.status, 200);

  const alice = await dbModule.get('SELECT id FROM users WHERE name = ?', ['alice@example.com']);
  const aliceReference = await dbModule.get(`
    SELECT uf.id FROM user_files uf JOIN files f ON f.id = uf.file_id
    WHERE uf.user_id = ? AND f.sha256 = ? LIMIT 1
  `, [alice.id, sha256]);
  const deleted = await api(`/drive/file/${aliceReference.id}`, { method: 'DELETE', token: aliceToken });
  assert.equal(deleted.response.status, 200);
  assert.notEqual(await dbModule.get('SELECT id FROM files WHERE sha256 = ?', [sha256]), undefined);

  const bobDownload = await api(`/files/${sha256}/download`, { token: bobToken });
  assert.equal(bobDownload.response.status, 200);
  assert.deepEqual(bobDownload.data, content);
});

test('全局搜索返回完整路径、隔离用户并同步重命名', async () => {
  const parentId = await createFolder(aliceToken, '搜索资料');
  const childId = await createFolder(aliceToken, '项目报告', parentId);
  const uploaded = await upload(aliceToken, '季度报告.txt', 'searchable report', childId);
  assert.equal(uploaded.response.status, 200);

  const global = await api('/drive/search?q=%E6%8A%A5%E5%91%8A&scope=all&limit=50', { token: aliceToken });
  assert.equal(global.response.status, 200);
  assert.deepEqual(global.data.results.map((item) => item.name).sort(), ['季度报告.txt', '项目报告']);
  const file = global.data.results.find((item) => item.type === 'file');
  assert.equal(file.path, '/搜索资料/项目报告');

  const current = await api(`/drive/search?q=%E6%8A%A5%E5%91%8A&scope=current&folderId=${parentId}`, { token: aliceToken });
  assert.deepEqual(current.data.results.map((item) => item.name), ['项目报告']);
  const isolated = await api('/drive/search?q=%E6%8A%A5%E5%91%8A', { token: bobToken });
  assert.equal(isolated.data.results.length, 0);

  const renamed = await api(`/drive/file/${file.id}`, { method: 'PUT', token: aliceToken, body: { name: '最终版本.txt' } });
  assert.equal(renamed.response.status, 200);
  const oldSearch = await api('/drive/search?q=%E5%AD%A3%E5%BA%A6%E6%8A%A5%E5%91%8A', { token: aliceToken });
  assert.equal(oldSearch.data.results.length, 0);
  const newSearch = await api('/drive/search?q=%E6%9C%80%E7%BB%88%E7%89%88%E6%9C%AC', { token: aliceToken });
  assert.equal(newSearch.data.results[0].name, '最终版本.txt');

  await createFolder(aliceToken, 'a%b_特殊');
  const special = await api('/drive/search?q=a%25b_%E7%89%B9%E6%AE%8A&limit=1', { token: aliceToken });
  assert.equal(special.response.status, 200);
  assert.equal(special.data.results[0].name, 'a%b_特殊');
  await createFolder(aliceToken, '报告归档');
  const firstPage = await api('/drive/search?q=%E6%8A%A5%E5%91%8A&limit=1', { token: aliceToken });
  assert.equal(typeof firstPage.data.page.nextCursor, 'string');
  const next = await api(`/drive/search?q=%E6%8A%A5%E5%91%8A&limit=1&cursor=${encodeURIComponent(firstPage.data.page.nextCursor)}`, { token: aliceToken });
  assert.equal(next.response.status, 200);
  assert.notEqual(next.data.results[0].id, firstPage.data.results[0].id);
});

test('文件夹 ID 可猜测但不能跨用户访问或修改', async () => {
  const aliceFolderId = await createFolder(aliceToken, 'alice-private-folder');
  const aliceChildId = await createFolder(aliceToken, 'alice-private-child', aliceFolderId);
  const uploaded = await upload(aliceToken, 'alice-private.txt', 'private folder content', aliceChildId);
  assert.equal(uploaded.response.status, 200);

  const bobFolderId = await createFolder(bobToken, 'bob-target-folder');
  const listed = await api(`/drive?folderId=${aliceFolderId}`, { token: bobToken });
  assert.equal(listed.response.status, 400);

  const renamed = await api(`/drive/folder/${aliceFolderId}`, {
    method: 'PUT',
    token: bobToken,
    body: { name: 'hijacked-folder' },
  });
  assert.equal(renamed.response.status, 404);

  const moved = await api('/drive/move', {
    method: 'POST',
    token: bobToken,
    body: { type: 'folder', id: aliceFolderId, targetFolderId: bobFolderId },
  });
  assert.equal(moved.response.status, 404);

  const deleted = await api(`/drive/folder/${aliceFolderId}`, { method: 'DELETE', token: bobToken });
  assert.equal(deleted.response.status, 404);

  const ownerView = await api(`/drive?folderId=${aliceFolderId}`, { token: aliceToken });
  assert.equal(ownerView.response.status, 200);
  assert.deepEqual(ownerView.data.folders.map((folder) => folder.id), [aliceChildId]);
  const childView = await api(`/drive?folderId=${aliceChildId}`, { token: aliceToken });
  assert.equal(childView.response.status, 200);
  assert.equal(childView.data.files.length, 1);
  assert.equal(childView.data.files[0].name, 'alice-private.txt');
});

test('图片缩略图按所有者鉴权并生成 160 像素 WebP 缓存', async () => {
  const image = await sharp({
    create: { width: 320, height: 180, channels: 3, background: { r: 30, g: 120, b: 210 } },
  }).png().toBuffer();
  const form = new FormData();
  form.append('folderId', '');
  form.append('files', new Blob([image], { type: 'image/png' }), 'thumbnail.png');
  const uploaded = await api('/files/upload', { method: 'POST', token: aliceToken, form });
  assert.equal(uploaded.response.status, 200);
  const sha256 = crypto.createHash('sha256').update(image).digest('hex');

  const denied = await api(`/files/${sha256}/thumbnail`, { token: bobToken });
  assert.equal(denied.response.status, 404);
  const [first, concurrent] = await Promise.all([
    api(`/files/${sha256}/thumbnail`, { token: aliceToken }),
    api(`/files/${sha256}/thumbnail`, { token: aliceToken }),
  ]);
  assert.equal(first.response.status, 200);
  assert.equal(concurrent.response.status, 200);
  assert.equal(first.response.headers.get('content-type'), 'image/webp');
  assert.match(first.response.headers.get('cache-control'), /immutable/);
  const metadata = await sharp(first.data).metadata();
  assert.equal(metadata.width, 160);
  assert.equal(metadata.height, 160);
  assert.equal(metadata.format, 'webp');
});

test('接入应用可通过独立 Token 隔离上传并创建访问链接', async () => {
  const created = await api('/integrations', {
    method: 'POST',
    token: aliceToken,
    body: {
      name: 'integration-test',
      rootFolderName: 'integration-root',
      scopes: ['files:upload', 'files:read', 'files:delete', 'links:create'],
      createToken: true,
    },
  });
  assert.equal(created.response.status, 200);
  assert.match(created.data.token.token, /^nfs_pat_/);

  const content = Buffer.from('integration isolated content');
  const form = new FormData();
  form.append('folderId', '');
  form.append('withAccessLink', 'true');
  form.append('files', new Blob([content], { type: 'text/plain' }), 'integration.txt');
  const uploaded = await api('/api/v1/files/upload', {
    method: 'POST',
    headers: { 'N-File-Token': created.data.token.token },
    form,
  });
  assert.equal(uploaded.response.status, 200);
  assert.equal(uploaded.data.files.length, 1);
  assert.match(uploaded.data.files[0].accessLink.path, /^\/n_file_system_api\/access\//);

  const accessed = await api(uploaded.data.files[0].accessLink.path);
  assert.equal(accessed.response.status, 200);
  assert.deepEqual(accessed.data, content);

  const outsideFolderId = await createFolder(aliceToken, 'outside-integration-root');
  const outside = await api(`/api/v1/files?folderId=${outsideFolderId}`, {
    headers: { 'N-File-Token': created.data.token.token },
  });
  assert.equal(outside.response.status, 403);

  const bearerFallback = await api('/api/v1/files', {
    headers: { Authorization: `Bearer ${created.data.token.token}` },
  });
  assert.equal(bearerFallback.response.status, 401);
  const oldAccessPath = uploaded.data.files[0].accessLink.path.replace('/n_file_system_api', '');
  const oldAccess = await api(oldAccessPath);
  assert.equal(oldAccess.response.status, 404);

  const tokens = await api(`/integrations/${created.data.integration.id}/tokens`, { token: aliceToken });
  assert.equal(tokens.response.status, 200);
  assert.equal(tokens.data.tokens.length, 1);
  assert.equal(tokens.data.tokens[0].token_hash, undefined);
});

test('相同内容不同扩展名只产生一个 SHA-256 物理文件', async () => {
  const content = Buffer.from('same content with different names');
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  const first = await upload(aliceToken, 'same.pdf', content);
  const second = await upload(aliceToken, 'same.txt', content);
  assert.equal(first.response.status, 200);
  assert.equal(second.response.status, 200);

  const rows = await dbModule.all('SELECT * FROM files WHERE sha256 = ?', [sha256]);
  assert.equal(rows.length, 1);
  assert.match(rows[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.keys(rows[0]).sort().join(','), 'created_at,id,mime_type,sha256,size,unreferenced_at');
  assert.equal(await storageModule.verifyFileRecord(rows[0], true).then((result) => result.ok), true);
});

test('等长损坏的去重文件不会覆盖正确上传内容', async () => {
  const content = Buffer.from('same content with different names');
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  const record = await dbModule.get('SELECT * FROM files WHERE sha256 = ?', [sha256]);
  const filePath = storageModule.getStoragePath(record);
  const before = await dbModule.get('SELECT COUNT(*) AS count FROM user_files WHERE file_id = ?', [record.id]);

  await fs.promises.writeFile(filePath, Buffer.alloc(content.length, 0x78));
  try {
    const rejected = await upload(aliceToken, 'corruption-check.bin', content);
    assert.equal(rejected.response.status, 409);
    assert.equal(rejected.data.code, 'STORAGE_INTEGRITY_ERROR');
    const afterCount = await dbModule.get('SELECT COUNT(*) AS count FROM user_files WHERE file_id = ?', [record.id]);
    assert.equal(afterCount.count, before.count);
    assert.deepEqual(await fs.promises.readdir(storageModule.tempRoot), []);
  } finally {
    await fs.promises.writeFile(filePath, content);
  }
  assert.equal(await storageModule.verifyFileRecord(record, true).then((result) => result.ok), true);
});

test('非法文件名和无效目录不会留下临时文件', async () => {
  const badName = await upload(aliceToken, 'bad.<script>.txt', Buffer.from('bad'));
  assert.equal(badName.response.status, 400);

  const temporary = Buffer.from('temporary');
  const invalidFolder = await upload(aliceToken, 'valid.txt', temporary, 999999);
  assert.equal(invalidFolder.response.status, 400);
  const sha256 = crypto.createHash('sha256').update(temporary).digest('hex');
  assert.equal(await dbModule.get('SELECT id FROM files WHERE sha256 = ?', [sha256]), undefined);
  assert.equal(fs.existsSync(path.join(uploadDir, sha256.slice(0, 2), sha256.slice(2, 4), sha256)), false);
  const tempEntries = await fs.promises.readdir(storageModule.tempRoot);
  assert.deepEqual(tempEntries, []);
});

test('并发反向移动不能形成文件夹环', async () => {
  const folderA = await createFolder(aliceToken, 'cycle-a');
  const folderB = await createFolder(aliceToken, 'cycle-b');
  const moves = await Promise.all([
    api('/drive/move', {
      method: 'POST', token: aliceToken, body: { type: 'folder', id: folderA, targetFolderId: folderB },
    }),
    api('/drive/move', {
      method: 'POST', token: aliceToken, body: { type: 'folder', id: folderB, targetFolderId: folderA },
    }),
  ]);
  assert.equal(moves.filter((item) => item.response.status === 200).length, 1);
  assert.equal(moves.filter((item) => item.response.status >= 400).length, 1);
  const rows = await dbModule.all('SELECT id, parent_id FROM user_folders WHERE id IN (?, ?)', [folderA, folderB]);
  assert.equal(rows.every((row) => row.parent_id !== row.id), true);
  assert.equal(rows.filter((row) => row.parent_id !== null).length, 1);
});

test('删除最后一个引用会移入回收站并保留物理文件', async () => {
  const folderId = await createFolder(aliceToken, 'delete-with-content');
  const content = Buffer.from(`delete-me-${crypto.randomUUID()}`);
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  const uploaded = await upload(aliceToken, 'delete-me.bin', content, folderId);
  assert.equal(uploaded.response.status, 200);
  const record = await dbModule.get('SELECT * FROM files WHERE sha256 = ?', [sha256]);
  const filePath = storageModule.getStoragePath(record);
  assert.equal(fs.existsSync(filePath), true);

  const deleted = await api(`/drive/folder/${folderId}`, { method: 'DELETE', token: aliceToken });
  assert.equal(deleted.response.status, 200);
  assert.notEqual(await dbModule.get('SELECT id FROM files WHERE id = ?', [record.id]), undefined);
  assert.equal(fs.existsSync(filePath), true);
  const trash = await api('/drive/trash', { token: aliceToken });
  assert.equal(trash.response.status, 200);
  assert.equal(trash.data.items.some((item) => item.item_type === 'folder' && item.name === 'delete-with-content'), true);
});

test('回收站恢复与永久删除遵循用户引用隔离', async () => {
  const content = Buffer.from(`trash-shared-${crypto.randomUUID()}`);
  const uploaded = await upload(aliceToken, 'trash-shared.bin', content);
  assert.equal(uploaded.response.status, 200);
  const aliceFileId = uploaded.data.files[0].id;
  const record = await dbModule.get('SELECT * FROM files WHERE sha256 = ?', [crypto.createHash('sha256').update(content).digest('hex')]);
  const bob = await dbModule.get('SELECT id FROM users WHERE name = ?', ['bob@example.com']);
  await dbModule.run('INSERT INTO user_files(user_id, folder_id, file_id, name) VALUES (?, NULL, ?, ?)', [bob.id, record.id, 'trash-shared.bin']);
  const deleted = await api(`/drive/file/${aliceFileId}`, { method: 'DELETE', token: aliceToken });
  assert.equal(deleted.response.status, 200);
  const bobView = await api('/drive', { token: bobToken });
  assert.equal(bobView.data.files.some((file) => file.sha256 === record.sha256), true);
  const trash = await api('/drive/trash', { token: aliceToken });
  const item = trash.data.items.find((entry) => entry.item_type === 'file' && entry.name === 'trash-shared.bin');
  assert.ok(item);
  const restored = await api(`/drive/trash/${item.batch_id}/restore`, { method: 'POST', token: aliceToken });
  assert.equal(restored.response.status, 200);
  const restoredView = await api('/drive', { token: aliceToken });
  assert.equal(restoredView.data.files.some((file) => file.id === aliceFileId), true);
});

test('回收站文件不能重新创建访问链接，恢复冲突会被拒绝', async () => {
  const created = await api('/integrations', { method: 'POST', token: aliceToken, body: {
    name: `trash-links-${crypto.randomUUID()}`, rootFolderName: `trash-links-root-${crypto.randomUUID()}`,
    scopes: ['files:upload', 'files:read', 'files:delete', 'links:create'], createToken: true,
  } });
  const content = Buffer.from(`trash-link-${crypto.randomUUID()}`);
  const uploaded = await upload(aliceToken, 'trash-link.bin', content);
  const fileId = uploaded.data.files[0].id;
  assert.equal((await api(`/drive/file/${fileId}`, { method: 'DELETE', token: aliceToken })).response.status, 200);
  const link = await api(`/api/v1/files/${fileId}/access-links`, { method: 'POST', headers: { 'N-File-Token': created.data.token.token }, body: {} });
  assert.equal(link.response.status, 404);
  const duplicate = await upload(aliceToken, 'trash-link-copy.bin', content);
  assert.equal(duplicate.response.status, 200);
  await dbModule.run('UPDATE user_files SET name = ? WHERE id = ?', ['trash-link.bin', duplicate.data.files[0].id]);
  const trash = await api('/drive/trash', { token: aliceToken });
  const item = trash.data.items.find((entry) => entry.item_type === 'file' && entry.item_id === fileId);
  const restored = await api(`/drive/trash/${item.batch_id}/restore`, { method: 'POST', token: aliceToken });
  assert.equal(restored.response.status, 409);
});

test('目录列表支持稳定分页', async () => {
  const parentId = await createFolder(aliceToken, 'paged');
  const user = await dbModule.get('SELECT id FROM users WHERE name = ?', ['alice@example.com']);
  await dbModule.transaction(async (tx) => {
    for (let index = 0; index < 205; index++) {
      await tx.run(
        'INSERT INTO user_folders(user_id, parent_id, name) VALUES (?, ?, ?)',
        [user.id, parentId, `folder-${String(index).padStart(3, '0')}`]
      );
    }
  });

  const first = await api(`/drive?folderId=${parentId}`, { token: aliceToken });
  const second = await api(`/drive?folderId=${parentId}&offset=200`, { token: aliceToken });
  assert.equal(first.data.folders.length, 200);
  assert.equal(first.data.page.hasMore, true);
  assert.equal(second.data.folders.length, 5);
  assert.equal(second.data.page.hasMore, false);
});

test('关闭注册时禁止注册验证码但保留密码找回入口', async () => {
  process.env.ALLOW_REGISTER = 'false';
  try {
    const registerCode = await api('/auth/email-codes', {
      method: 'POST', body: { email: 'closed@example.com', purpose: 'register' },
    });
    assert.equal(registerCode.response.status, 403);
    mailerModule.clearTestOutbox();
    const resetCode = await api('/auth/email-codes', {
      method: 'POST', body: { email: 'nobody@example.com', purpose: 'reset_password' },
    });
    assert.equal(resetCode.response.status, 202);
    assert.equal(mailerModule.getTestOutbox().length, 0);
  } finally {
    process.env.ALLOW_REGISTER = 'true';
  }
});
