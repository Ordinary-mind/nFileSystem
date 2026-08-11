const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfilesystem-test-'));
const dataDir = path.join(testRoot, 'data');
const uploadDir = path.join(testRoot, 'uploads');
const legacyContent = Buffer.from('legacy file content');
const legacyMd5 = crypto.createHash('md5').update(legacyContent).digest('hex');

process.env.DATA_DIR = dataDir;
process.env.UPLOAD_DIR = uploadDir;
process.env.JWT_SECRET = 'test-only-secret-that-is-longer-than-32-bytes';
process.env.AUTH_CODE_SECRET = 'test-only-code-secret-that-is-longer-than-32-bytes';
process.env.TOKEN_EXPIRES_IN = '10m';
process.env.ALLOW_REGISTER = 'true';
process.env.USER_QUOTA_BYTES = String(1024 * 1024 * 1024);
process.env.MIN_FREE_BYTES = '0';
process.env.DRIVE_PAGE_SIZE = '200';
process.env.NODE_ENV = 'test';

let appModule;
let dbModule;
let storageModule;
let mailerModule;
let baseUrl;
let legacyToken;
let aliceToken;
let bobToken;

function legacyRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      return resolve({ lastID: this.lastID });
    });
  });
}

function legacyExec(db, sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => (err ? reject(err) : resolve()));
  });
}

function legacyClose(db) {
  return new Promise((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())));
}

async function createLegacyFixture() {
  await fs.promises.mkdir(dataDir, { recursive: true });
  const db = new sqlite3.Database(path.join(dataDir, 'app.db'));
  await legacyExec(db, `
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
    CREATE TABLE files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stored_name TEXT NOT NULL,
      md5 TEXT NOT NULL UNIQUE,
      size INTEGER NOT NULL,
      mime_type TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
    CREATE TABLE user_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      parent_id INTEGER DEFAULT NULL,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
    CREATE TABLE user_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      folder_id INTEGER DEFAULT NULL,
      file_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
  `);
  const password = await bcrypt.hash('legacy-pass', 10);
  const user = await legacyRun(db, 'INSERT INTO users(name, password) VALUES (?, ?)', ['legacy', password]);
  const storedName = `${legacyMd5}.txt`;
  const file = await legacyRun(
    db,
    'INSERT INTO files(stored_name, md5, size, mime_type) VALUES (?, ?, ?, ?)',
    [storedName, legacyMd5, legacyContent.length, 'text/plain']
  );
  await legacyRun(
    db,
    'INSERT INTO user_files(user_id, folder_id, file_id, name) VALUES (?, NULL, ?, ?)',
    [user.lastID, file.lastID, 'legacy.txt']
  );
  await legacyClose(db);

  const legacyDir = path.join(uploadDir, legacyMd5.slice(0, 2), legacyMd5.slice(2, 4));
  await fs.promises.mkdir(legacyDir, { recursive: true });
  await fs.promises.writeFile(path.join(legacyDir, storedName), legacyContent);
}

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

before(async () => {
  await createLegacyFixture();
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

test('旧数据库与 MD5 存储路径可自动升级并继续下载', async () => {
  const version = await dbModule.get('PRAGMA user_version');
  assert.equal(version.user_version, 3);
  const record = await dbModule.get('SELECT storage_key, sha256 FROM files WHERE md5 = ?', [legacyMd5]);
  assert.equal(record.storage_key, legacyMd5);
  assert.equal(record.sha256, null);

  const legacyUser = await dbModule.get("SELECT id, credential_version FROM users WHERE name = 'legacy'");
  assert.equal(legacyUser.credential_version, 1);
  await dbModule.run(
    "INSERT INTO user_identities(user_id, provider, provider_subject, verified_at) VALUES (?, 'email', 'legacy@example.com', datetime('now'))",
    [legacyUser.id]
  );
  const login = await api('/auth/login', { method: 'POST', body: { email: 'legacy@example.com', password: 'legacy-pass' } });
  assert.equal(login.response.status, 200);
  legacyToken = login.data.token;
  const download = await api(`/files/${legacyMd5}/download`, { token: legacyToken });
  assert.equal(download.response.status, 200);
  assert.deepEqual(download.data, legacyContent);
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
  const duplicateCode = await api('/auth/email-codes', {
    method: 'POST', body: { email: 'legacy@example.com', purpose: 'register' },
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

test('秒传不能通过全局 MD5 取得其他用户文件', async () => {
  aliceToken = await registerAndLogin('alice');
  bobToken = await registerAndLogin('bob');
  const content = Buffer.from('alice private content');
  const md5 = crypto.createHash('md5').update(content).digest('hex');
  const uploaded = await upload(aliceToken, 'private.txt', content);
  assert.equal(uploaded.response.status, 200);

  const instant = await api('/files/instant', {
    method: 'POST',
    token: bobToken,
    body: { files: [{ md5, originalName: 'stolen.txt' }], folderId: null },
  });
  assert.equal(instant.response.status, 200);
  assert.equal(instant.data.results[0].success, false);
  const download = await api(`/files/${md5}/download`, { token: bobToken });
  assert.equal(download.response.status, 404);
});

test('正常上传取得的共享内容不会被其他用户删除操作误回收', async () => {
  const content = Buffer.from('alice private content');
  const md5 = crypto.createHash('md5').update(content).digest('hex');
  const bobUpload = await upload(bobToken, 'owned-copy.txt', content);
  assert.equal(bobUpload.response.status, 200);

  const alice = await dbModule.get('SELECT id FROM users WHERE name = ?', ['alice@example.com']);
  const aliceReference = await dbModule.get(`
    SELECT uf.id FROM user_files uf JOIN files f ON f.id = uf.file_id
    WHERE uf.user_id = ? AND f.md5 = ? LIMIT 1
  `, [alice.id, md5]);
  const deleted = await api(`/drive/file/${aliceReference.id}`, { method: 'DELETE', token: aliceToken });
  assert.equal(deleted.response.status, 200);
  assert.notEqual(await dbModule.get('SELECT id FROM files WHERE md5 = ?', [md5]), undefined);

  const bobDownload = await api(`/files/${md5}/download`, { token: bobToken });
  assert.equal(bobDownload.response.status, 200);
  assert.deepEqual(bobDownload.data, content);
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

  const tokens = await api(`/integrations/${created.data.integration.id}/tokens`, { token: aliceToken });
  assert.equal(tokens.response.status, 200);
  assert.equal(tokens.data.tokens.length, 1);
  assert.equal(tokens.data.tokens[0].token_hash, undefined);
});

test('相同内容不同扩展名只产生一个 SHA-256 物理文件', async () => {
  const content = Buffer.from('same content with different names');
  const md5 = crypto.createHash('md5').update(content).digest('hex');
  const first = await upload(aliceToken, 'same.pdf', content);
  const second = await upload(aliceToken, 'same.txt', content);
  assert.equal(first.response.status, 200);
  assert.equal(second.response.status, 200);

  const rows = await dbModule.all('SELECT * FROM files WHERE md5 = ?', [md5]);
  assert.equal(rows.length, 1);
  assert.match(rows[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(rows[0].stored_name, rows[0].sha256);
  assert.equal(await storageModule.verifyFileRecord(rows[0], true).then((result) => result.ok), true);
});

test('等长损坏的去重文件不会覆盖正确上传内容', async () => {
  const content = Buffer.from('same content with different names');
  const md5 = crypto.createHash('md5').update(content).digest('hex');
  const record = await dbModule.get('SELECT * FROM files WHERE md5 = ?', [md5]);
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
  const md5 = crypto.createHash('md5').update(temporary).digest('hex');
  const sha256 = crypto.createHash('sha256').update(temporary).digest('hex');
  assert.equal(await dbModule.get('SELECT id FROM files WHERE md5 = ?', [md5]), undefined);
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

test('删除最后一个引用会回收数据库记录和物理文件', async () => {
  const folderId = await createFolder(aliceToken, 'delete-with-content');
  const content = Buffer.from(`delete-me-${crypto.randomUUID()}`);
  const md5 = crypto.createHash('md5').update(content).digest('hex');
  const uploaded = await upload(aliceToken, 'delete-me.bin', content, folderId);
  assert.equal(uploaded.response.status, 200);
  const record = await dbModule.get('SELECT * FROM files WHERE md5 = ?', [md5]);
  const filePath = storageModule.getStoragePath(record);
  assert.equal(fs.existsSync(filePath), true);

  const deleted = await api(`/drive/folder/${folderId}`, { method: 'DELETE', token: aliceToken });
  assert.equal(deleted.response.status, 200);
  assert.equal(await dbModule.get('SELECT id FROM files WHERE id = ?', [record.id]), undefined);
  assert.equal(fs.existsSync(filePath), false);
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
