const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  // eslint-disable-next-line no-console
  console.error('错误: 必须设置环境变量 JWT_SECRET');
  process.exit(1);
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
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

/**
 * 校验 token
 */
function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

module.exports = {
  hashPassword,
  comparePassword,
  signToken,
  verifyToken,
};
