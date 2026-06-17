const { verifyToken } = require('../utils/security');
const { get, run } = require('../db');
const crypto = require('crypto');

function hashApiToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function parseScopes(scopes) {
  return String(scopes || '')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function hasRequiredScopes(grantedScopes, requiredScopes) {
  if (!requiredScopes.length) return true;
  return requiredScopes.every((scope) => grantedScopes.includes(scope));
}

function getApiTokenFromRequest(req) {
  const fileToken = req.headers['n-file-token'];
  if (fileToken) return String(fileToken).trim();

  const authHeader = req.headers.authorization || '';
  const [type, token] = authHeader.split(' ');
  if (type === 'Bearer' && token) return token;

  return '';
}

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

function apiTokenRequired(requiredScopes = []) {
  return async (req, res, next) => {
    try {
      const token = getApiTokenFromRequest(req);

      if (!token) {
        return res.status(401).json({ message: 'API token 缺失' });
      }

      const tokenHash = hashApiToken(token);
      const record = await get(
        `SELECT t.id AS token_id, t.user_id, t.integration_id, t.scopes AS token_scopes,
                t.expires_at, t.revoked_at,
                i.name AS integration_name, i.root_folder_id, i.scopes AS integration_scopes, i.enabled
         FROM api_tokens t
         JOIN integrations i ON t.integration_id = i.id
         WHERE t.token_hash = ?`,
        [tokenHash]
      );

      if (!record || record.revoked_at || record.enabled !== 1) {
        return res.status(401).json({ message: 'API token 无效' });
      }
      if (record.expires_at && new Date(record.expires_at).getTime() <= Date.now()) {
        return res.status(401).json({ message: 'API token 已过期' });
      }

      const tokenScopes = parseScopes(record.token_scopes);
      const integrationScopes = parseScopes(record.integration_scopes);
      const effectiveScopes = tokenScopes.filter((scope) => integrationScopes.includes(scope));

      if (!hasRequiredScopes(effectiveScopes, requiredScopes)) {
        return res.status(403).json({ message: 'API token 权限不足' });
      }

      req.apiAuth = {
        tokenId: record.token_id,
        userId: record.user_id,
        integrationId: record.integration_id,
        integrationName: record.integration_name,
        rootFolderId: record.root_folder_id,
        scopes: effectiveScopes,
      };
      req.user = { id: record.user_id };

      run('UPDATE api_tokens SET last_used_at = datetime(\'now\', \'localtime\') WHERE id = ?', [record.token_id])
        .catch(() => {});

      return next();
    } catch (err) {
      return res.status(401).json({ message: 'API token 校验失败' });
    }
  };
}

module.exports = {
  authRequired,
  apiTokenRequired,
  hashApiToken,
};
