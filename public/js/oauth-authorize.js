import { clearSession, getSession } from './core/session.js';

const SCOPE_LABELS = {
  'files:upload': '上传文件与创建文件夹',
  'files:read': '读取文件与目录列表',
  'files:delete': '删除文件与文件夹',
  'links:create': '为文件创建公开访问链接',
  'user:read': '读取你的账号邮箱',
};

const params = new URLSearchParams(window.location.search);
const body = document.getElementById('oauth-body');

const clientId = params.get('client_id') || '';
const redirectUri = params.get('redirect_uri') || '';
const scope = params.get('scope') || '';
const state = params.get('state') || '';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function renderError(title, detail = '') {
  body.innerHTML = `
    <div class="oauth-state oauth-state-error">
      <p class="oauth-lead"><strong>${escapeHtml(title)}</strong></p>
      ${detail ? `<code>${escapeHtml(detail)}</code>` : ''}
      <p class="oauth-note">请回到发起授权的应用重新发起，或稍后再试。</p>
    </div>`;
}

function redirectToLogin() {
  try {
    sessionStorage.setItem('oauth_return', window.location.href);
  } catch {
    // 存储不可用时仍允许登录，但登录后无法自动回到授权页。
  }
  window.location.replace('/#/login');
}

function scopeItems(scopes) {
  return scopes.map((item) => `
    <li>${escapeHtml(SCOPE_LABELS[item] || item)}<span>${escapeHtml(item)}</span></li>`).join('');
}

async function requestContext(token) {
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, scope, state });
  const response = await fetch(`/oauth/authorize/context?${query.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (response.status === 401) {
    clearSession();
    return null;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || '授权信息读取失败');
  return data;
}

async function submitDecision(token, approve) {
  const response = await fetch('/oauth/authorize', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope,
      state,
      approve,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || '授权处理失败');
  if (data.redirectUrl) window.location.replace(data.redirectUrl);
}

function renderConsent(token, context) {
  const scopes = Array.isArray(context.scopes) ? context.scopes : [];
  body.innerHTML = `
    <p class="oauth-lead"><strong>${escapeHtml(context.app.name)}</strong> 希望访问你的文件系统账号</p>
    <div class="oauth-user">当前登录：${escapeHtml(context.user.email)}</div>
    <p class="oauth-title">该应用将获得以下权限</p>
    <ul class="oauth-scopes">${scopeItems(scopes)}</ul>
    <p class="oauth-note">授权只会在你同意后生效，应用不会获得你的密码。你可以随时在文件系统的「接入应用」中停用该应用。</p>
    <div class="oauth-actions">
      <button type="button" class="secondary-button" data-cancel>取消</button>
      <button type="button" class="primary-button" data-approve>同意授权</button>
    </div>`;

  const approveButton = body.querySelector('[data-approve]');
  const cancelButton = body.querySelector('[data-cancel]');
  const handle = async (approve) => {
    approveButton.disabled = true;
    cancelButton.disabled = true;
    try {
      await submitDecision(token, approve);
    } catch (error) {
      renderError(error.message);
    }
  };
  approveButton.addEventListener('click', () => handle(true));
  cancelButton.addEventListener('click', () => handle(false));
}

async function boot() {
  if (!clientId || !redirectUri) {
    renderError('授权请求不完整', '缺少 client_id 或 redirect_uri 参数');
    return;
  }

  const session = getSession();
  if (!session.token) {
    redirectToLogin();
    return;
  }

  try {
    const context = await requestContext(session.token);
    if (!context) {
      redirectToLogin();
      return;
    }
    renderConsent(session.token, context);
  } catch (error) {
    renderError(error.message);
  }
}

boot();
