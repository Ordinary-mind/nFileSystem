const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// 实际生产环境请放到环境变量中
const JWT_SECRET = process.env.JWT_SECRET || 'replace-this-with-env-secret';

/**
 * 对密码进行 SHA256 摘要（演示用途，生产建议使用 bcrypt/argon2）
 */
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

/**
 * 生成登录 token
 */
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '2h' });
}

/**
 * 校验 token
 */
function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

module.exports = {
  hashPassword,
  signToken,
  verifyToken,
};
