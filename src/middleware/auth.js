const { verifyToken } = require('../utils/security');

/**
 * JWT 鉴权中间件
 * Header: Authorization: Bearer <token>
 */
function authRequired(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const [type, token] = authHeader.split(' ');

    if (type !== 'Bearer' || !token) {
      return res.status(401).json({ message: '未登录或 token 缺失' });
    }

    const payload = verifyToken(token);
    req.user = payload;
    return next();
  } catch (err) {
    return res.status(401).json({ message: 'token 无效或已过期' });
  }
}

module.exports = {
  authRequired,
};
