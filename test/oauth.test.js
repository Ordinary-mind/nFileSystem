const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nfilesystem-oauth-test-'));
const dataDir = path.join(testRoot, 'data');
const uploadDir = path.join(testRoot, 'uploads');

process.env.DATA_DIR = dataDir;
process.env.UPLOAD_DIR = uploadDir;
process.env.JWT_SECRET = 'test-only-secret-that-is-longer-than-32-bytes';
process.env.AUTH_CODE_SECRET = 'test-only-code-secret-that-is-longer-than-32-bytes';
process.env.TOKEN_EXPIRES_IN = '10m';
process.env.MIN_FREE_BYTES = '0';
process.env.AUTH_RATE_LIMIT = '1000';
process.env.NODE_ENV = 'test';

const REDIRECT_URI = 'https://blog.example.com/api/auth/oauth/callback';

let appModule;
let dbModule;
let securityModule;
let baseUrl;
let loginToken;
let userId;
let clientId;
let clientSecret;

async function api(urlPath, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.fileToken) headers['n-file-token'] = options.fileToken;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  return { response, data };
}

before(async () => {
  appModule = require('../src/app');
  dbModule = require('../src/db');
  storageModule = require('../src/storage');
  securityModule = require('../src/utils/security');
  const server = await appModule.bootstrap(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const user = await dbModule.run('INSERT INTO users(name, password) VALUES (?, ?)', ['owner@example.com', 'unused']);
  userId = user.lastID;
  await dbModule.run(
    "INSERT INTO user_identities(user_id, provider, provider_subject, verified_at) VALUES (?, 'email', ?, datetime('now'))",
    [userId, 'owner@example.com']
  );
  loginToken = securityModule.signToken({ id: userId, credentialVersion: 1 });
});

after(async () => {
  if (appModule) await appModule.shutdown();
  await fs.promises.rm(testRoot, { recursive: true, force: true });
});

test('创建接入应用时签发 OAuth 凭证', async () => {
  const created = await api('/integrations', {
    method: 'POST',
    token: loginToken,
    body: {
      name: 'prettyblog',
      scopes: ['files:upload', 'files:read', 'links:create', 'user:read'],
      redirectUris: [REDIRECT_URI],
      createToken: true,
    },
  });
  assert.equal(created.response.status, 200);
  assert.match(created.data.oauth.clientId, /^nfs_client_/);
  assert.match(created.data.oauth.clientSecret, /^nfs_cs_/);
  assert.equal(created.data.token.token.startsWith('nfs_pat_'), true);
  clientId = created.data.oauth.clientId;
  clientSecret = created.data.oauth.clientSecret;

  const listed = await api('/integrations', { token: loginToken });
  const record = listed.data.integrations[0];
  assert.equal(record.clientId, clientId);
  assert.deepEqual(record.redirectUris, [REDIRECT_URI]);
  assert.equal(record.client_secret_hash, undefined);
});

test('未登记的回跳地址被拒绝', async () => {
  const context = await api(
    `/oauth/authorize/context?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent('https://evil.example.com/cb')}&scope=user:read`,
    { token: loginToken }
  );
  assert.equal(context.response.status, 400);
});

test('超出应用权限的 scope 被拒绝', async () => {
  const context = await api(
    `/oauth/authorize/context?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=files:delete`,
    { token: loginToken }
  );
  assert.equal(context.response.status, 400);
});

test('授权码换 token 并读取用户信息', async () => {
  const consent = await api('/oauth/authorize', {
    method: 'POST',
    token: loginToken,
    body: {
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: 'user:read files:read',
      state: 'state-1',
      approve: true,
    },
  });
  assert.equal(consent.response.status, 200);
  const redirect = new URL(consent.data.redirectUrl);
  assert.equal(redirect.searchParams.get('state'), 'state-1');
  const code = redirect.searchParams.get('code');
  assert.match(code, /^nfs_code_/);

  const wrongSecret = await api('/api/v1/oauth/token', {
    method: 'POST',
    body: { grant_type: 'authorization_code', code, client_id: clientId, client_secret: 'nfs_cs_wrong' },
  });
  assert.equal(wrongSecret.response.status, 401);

  const exchanged = await api('/api/v1/oauth/token', {
    method: 'POST',
    body: { grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret, redirect_uri: REDIRECT_URI },
  });
  assert.equal(exchanged.response.status, 200);
  assert.equal(exchanged.data.user.email, 'owner@example.com');
  assert.equal(exchanged.data.scope, 'user:read files:read');
  assert.equal(exchanged.data.token_type, 'Bearer');

  const userinfo = await api('/api/v1/oauth/userinfo', { token: exchanged.data.access_token });
  assert.equal(userinfo.response.status, 200);
  assert.equal(userinfo.data.email, 'owner@example.com');
  assert.equal(userinfo.data.name, 'owner');

  const reused = await api('/api/v1/oauth/token', {
    method: 'POST',
    body: { grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret },
  });
  assert.equal(reused.response.status, 400);
});

test('取消授权会回跳 access_denied', async () => {
  const denied = await api('/oauth/authorize', {
    method: 'POST',
    token: loginToken,
    body: {
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: 'user:read',
      state: 'state-2',
      approve: false,
    },
  });
  assert.equal(denied.response.status, 200);
  const redirect = new URL(denied.data.redirectUrl);
  assert.equal(redirect.searchParams.get('error'), 'access_denied');
  assert.equal(redirect.searchParams.get('state'), 'state-2');
  assert.equal(redirect.searchParams.get('code'), null);
});

test('缺少 user:read 的 access token 无法读取用户信息', async () => {
  const consent = await api('/oauth/authorize', {
    method: 'POST',
    token: loginToken,
    body: {
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: 'files:read',
      approve: true,
    },
  });
  const code = new URL(consent.data.redirectUrl).searchParams.get('code');
  const exchanged = await api('/api/v1/oauth/token', {
    method: 'POST',
    body: { grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret },
  });
  assert.equal(exchanged.response.status, 200);

  const userinfo = await api('/api/v1/oauth/userinfo', { token: exchanged.data.access_token });
  assert.equal(userinfo.response.status, 403);
});

test('重置凭证后旧 secret 失效', async () => {
  const integration = await dbModule.get('SELECT id FROM integrations WHERE client_id = ?', [clientId]);
  const reset = await api(`/integrations/${integration.id}/client`, { method: 'POST', token: loginToken });
  assert.equal(reset.response.status, 200);
  assert.notEqual(reset.data.oauth.clientSecret, clientSecret);

  const consent = await api('/oauth/authorize', {
    method: 'POST',
    token: loginToken,
    body: {
      client_id: reset.data.oauth.clientId,
      redirect_uri: REDIRECT_URI,
      scope: 'user:read',
      approve: true,
    },
  });
  const code = new URL(consent.data.redirectUrl).searchParams.get('code');

  const stale = await api('/api/v1/oauth/token', {
    method: 'POST',
    body: { grant_type: 'authorization_code', code, client_id: reset.data.oauth.clientId, client_secret: clientSecret },
  });
  assert.equal(stale.response.status, 401);

  const fresh = await api('/api/v1/oauth/token', {
    method: 'POST',
    body: { grant_type: 'authorization_code', code, client_id: reset.data.oauth.clientId, client_secret: reset.data.oauth.clientSecret },
  });
  assert.equal(fresh.response.status, 200);

  clientId = reset.data.oauth.clientId;
  clientSecret = reset.data.oauth.clientSecret;
});

test('停用应用后授权码与 token 均失效', async () => {
  const integration = await dbModule.get("SELECT id FROM integrations WHERE name = 'prettyblog'");
  const disabled = await api(`/integrations/${integration.id}`, { method: 'PUT', token: loginToken, body: { enabled: false } });
  assert.equal(disabled.response.status, 200);

  const context = await api(
    `/oauth/authorize/context?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=user:read`,
    { token: loginToken }
  );
  assert.equal(context.response.status, 401);
});
