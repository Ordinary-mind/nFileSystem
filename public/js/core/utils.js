export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function getExtension(name) {
  const parts = String(name || '').split('.');
  return parts.length > 1 ? parts.pop() : '';
}

export function formatSize(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return '-';
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(2)} GB`;
}

export function formatDate(value) {
  if (!value) return '-';
  const normalized = String(value).replace(' ', 'T') + (String(value).includes('Z') ? '' : 'Z');
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

export function parseRoute(hash = '') {
  const clean = String(hash || '').replace(/^#\/?/, '');
  const [pathname, query = ''] = clean.split('?');
  const parts = pathname.split('/').filter(Boolean);
  const section = ['files', 'apps', 'me'].includes(parts[0]) ? parts[0] : 'files';
  const params = new URLSearchParams(query);
  return {
    section,
    id: parts[1] || null,
    search: params.get('q') || '',
    scope: params.get('scope') === 'current' ? 'current' : 'all',
  };
}

export function scopeLabel(scope) {
  const labels = {
    'files:upload': '上传/建目录',
    'files:read': '读取列表',
    'files:delete': '删除文件',
    'links:create': '创建链接',
  };
  return labels[scope] || scope;
}

export function parseScopes(scopes) {
  if (Array.isArray(scopes)) return scopes;
  return String(scopes || '').split(',').map((scope) => scope.trim()).filter(Boolean);
}

export function selectionKey(item) {
  return `${String(item.type || '')}:${String(item.id || '')}`;
}

export function hasPressMoved(startX, startY, currentX, currentY, threshold = 10) {
  return Math.hypot(Number(currentX) - Number(startX), Number(currentY) - Number(startY)) > threshold;
}
