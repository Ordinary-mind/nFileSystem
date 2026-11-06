const bcrypt = require('bcrypt');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
const weakSecrets = new Set([
  'secret',
  'your-secret-key',
  'change-me-in-production',
  'my-dev-secret-change-in-production',
]);
if (!JWT_SECRET || Buffer.byteLength(JWT_SECRET, 'utf8') < 32 || weakSecrets.has(JWT_SECRET)) {
  throw new Error('JWT_SECRET 必须是至少 32 字节的非默认随机字符串');
}

const SALT_ROUNDS = 10;

/**
 * 对密码进行 bcrypt 哈希
 */
async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * 校验密码是否匹配
 */
async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

/**
 * 生成登录 token
 * 优先使用 TOKEN_EXPIRES_IN 环境变量，否则开发环境 7 天，生产环境 2 小时
 */
function signToken(payload) {
  const expiresIn = process.env.TOKEN_EXPIRES_IN || (process.env.NODE_ENV === 'production' ? '2h' : '7d');
  return jwt.sign(payload, JWT_SECRET, { expiresIn, algorithm: 'HS256' });
}

/**
 * 校验 token
 */
function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
}

function signDownloadToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '5m', algorithm: 'HS256', audience: 'file-download' });
}

function verifyDownloadToken(token) {
  return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'], audience: 'file-download' });
}

/**
 * 分享提取码验证凭证：短期签名，audience 绑定 share-pass，payload 中携带
 * share id 与 token 哈希版本号，重置链接后旧凭证自动失效。
 */
function signSharePass(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '12h', algorithm: 'HS256', audience: 'share-pass' });
}

function verifySharePass(token) {
  return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'], audience: 'share-pass' });
}

/**
 * 接入应用授权登录的访问令牌：只用于博客等外部系统在登录瞬间读取用户身份，
 * audience 绑定 oauth-app，避免与文件系统登录 token 混用。
 */
function signOAuthAccessToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h', algorithm: 'HS256', audience: 'oauth-app' });
}

function verifyOAuthAccessToken(token) {
  return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'], audience: 'oauth-app' });
}

/**
 * 分享链接的可逆加密存储：
 * - 优先使用独立的 SHARE_TOKEN_SECRET，未配置时回退 JWT_SECRET 派生密钥；
 * - AES-256-GCM，随机 IV + 认证标签，密文格式 v1.<iv>.<tag>.<密文>（base64url）。
 * 数据库泄露时无法还原明文链接；管理页仍可由服务端解密后展示与复制。
 */
const SHARE_TOKEN_KEY = crypto.createHash('sha256')
  .update(`share-token:${process.env.SHARE_TOKEN_SECRET || JWT_SECRET}`)
  .digest();

function encryptShareToken(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', SHARE_TOKEN_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

function decryptShareToken(value) {
  if (typeof value !== 'string' || !value.startsWith('v1.')) return null;
  const [version, ivPart, tagPart, dataPart] = value.split('.');
  if (version !== 'v1' || !ivPart || !tagPart || !dataPart) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', SHARE_TOKEN_KEY, Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataPart, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

module.exports = {
  hashPassword,
  comparePassword,
  signToken,
  verifyToken,
  signDownloadToken,
  verifyDownloadToken,
  signSharePass,
  verifySharePass,
  signOAuthAccessToken,
  verifyOAuthAccessToken,
  encryptShareToken,
  decryptShareToken,
};
