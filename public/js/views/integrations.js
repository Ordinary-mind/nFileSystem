import { request } from '../core/api.js';
import { icon } from '../core/icons.js';
import { escapeHtml, parseScopes, scopeLabel } from '../core/utils.js';
import { confirmDialog, copyText, errorView, loadingView, openOverlay, showToast } from '../core/ui.js';

const ALL_SCOPES = ['files:upload', 'files:read', 'files:delete', 'links:create'];

function scopeOptions(selected) {
  const active = new Set(parseScopes(selected));
  return ALL_SCOPES.map((scope) => `
    <label class="check-row"><input type="checkbox" name="scopes" value="${scope}" ${active.has(scope) ? 'checked' : ''}><span>${scopeLabel(scope)}</span></label>`).join('');
}

function scopeChips(scopes) {
  return parseScopes(scopes).map((scope) => `<span class="scope-chip">${escapeHtml(scopeLabel(scope))}</span>`).join('');
}

function showTokenOnce(value) {
  const panel = openOverlay({
    title: '保存 API Token',
    content: `
      <div class="token-notice">
        <p>此 Token 只显示一次</p>
        <code data-token>${escapeHtml(value)}</code>
        <button type="button" class="secondary-button" data-copy>${icon('copy')}<span>复制 Token</span></button>
      </div>`,
  });
  panel.overlay.querySelector('[data-copy]').addEventListener('click', async () => {
    try { await copyText(value); showToast('Token 已复制'); }
    catch { showToast('复制失败，请手动选择', 'error'); }
  });
}

export function mountIntegrations(root, integrationId, navigate) {
  root.innerHTML = integrationId
    ? `<div class="top-bar"><button type="button" class="icon-button" data-back aria-label="返回应用列表">${icon('back')}</button><div><h1 data-title>应用详情</h1><div class="top-bar-subtitle">API Token 与权限</div></div><button type="button" class="icon-button" data-add-token aria-label="新建 Token">${icon('plus')}</button></div><div class="integrations-page" data-content>${loadingView()}</div>`
    : `<div class="top-bar no-back"><div><h1>接入应用</h1><div class="top-bar-subtitle">外部系统访问授权</div></div><button type="button" class="icon-button" data-add-app aria-label="新建应用">${icon('plus')}</button></div><div class="integrations-page" data-content>${loadingView()}</div>`;
  const content = root.querySelector('[data-content]');
  let activeIntegration = null;
  let tokens = [];

  async function loadList() {
    content.innerHTML = loadingView();
    try {
      const data = await request('/integrations');
      const items = data.integrations || [];
      if (!items.length) {
        content.innerHTML = `<div class="empty-drive">${icon('apps')}<h2>还没有接入应用</h2><p>点击右上角创建应用</p></div>`;
        return;
      }
      content.innerHTML = `<div class="integration-list">${items.map((item) => `
        <article class="integration-card" data-id="${item.id}">
          <button type="button" class="integration-main" data-open>
            <span class="app-symbol">${icon('apps')}</span>
            <span class="integration-copy"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.root_folder_name || `目录 ${item.root_folder_id}`)}</small><span class="chip-row">${scopeChips(item.scopes)}</span></span>
            ${icon('chevron')}
          </button>
          <div class="integration-footer"><span class="status-badge ${item.enabled === 1 ? 'enabled' : 'disabled'}">${item.enabled === 1 ? '已启用' : '已停用'}</span><button type="button" class="text-button" data-toggle data-enabled="${item.enabled}">${item.enabled === 1 ? '停用' : '启用'}</button></div>
        </article>`).join('')}</div>`;
      content.querySelectorAll('[data-open]').forEach((button) => button.addEventListener('click', () => navigate(`apps/${button.closest('[data-id]').dataset.id}`)));
      content.querySelectorAll('[data-toggle]').forEach((button) => button.addEventListener('click', async () => {
        const card = button.closest('[data-id]');
        try {
          await request(`/integrations/${card.dataset.id}`, { method: 'PUT', body: { enabled: button.dataset.enabled !== '1' } });
          showToast(button.dataset.enabled === '1' ? '应用已停用' : '应用已启用');
          loadList();
        } catch (error) { showToast(error.message, 'error'); }
      }));
    } catch (error) { content.innerHTML = errorView(error.message); }
  }

  function openCreateApp() {
    const panel = openOverlay({
      title: '新建接入应用',
      content: `
        <form class="dialog-form" data-form>
          <div class="field-group"><label class="field-label">应用名称</label><input class="text-field" name="name" placeholder="例如 music-app" required></div>
          <div class="field-group"><label class="field-label">根目录名称</label><input class="text-field" name="rootFolderName" placeholder="默认与应用名称相同"></div>
          <fieldset class="scope-field"><legend>应用权限</legend>${scopeOptions(['files:upload', 'files:read', 'links:create'])}</fieldset>
        </form>`,
      submitLabel: '创建应用',
      onSubmit: async ({ overlay, close }) => {
        const form = overlay.querySelector('[data-form]');
        const scopes = Array.from(form.querySelectorAll('[name="scopes"]:checked')).map((input) => input.value);
        if (!form.name.value.trim() || !scopes.length) { showToast('请填写名称并选择权限', 'error'); return; }
        try {
          const data = await request('/integrations', { method: 'POST', body: { name: form.name.value.trim(), rootFolderName: form.rootFolderName.value.trim(), scopes, createToken: true } });
          close();
          if (data.token && data.token.token) showTokenOnce(data.token.token);
          showToast('应用创建成功');
          loadList();
        } catch (error) { showToast(error.message, 'error'); }
      },
    });
    panel.overlay.querySelector('[data-form]').addEventListener('submit', (event) => { event.preventDefault(); panel.overlay.querySelector('[data-submit]').click(); });
  }

  async function loadDetail() {
    content.innerHTML = loadingView();
    try {
      const [appsData, tokenData] = await Promise.all([
        request('/integrations'), request(`/integrations/${integrationId}/tokens`),
      ]);
      activeIntegration = (appsData.integrations || []).find((item) => String(item.id) === String(integrationId));
      if (!activeIntegration) throw new Error('接入应用不存在');
      tokens = tokenData.tokens || [];
      root.querySelector('[data-title]').textContent = activeIntegration.name;
      renderDetail();
    } catch (error) { content.innerHTML = errorView(error.message); }
  }

  function renderDetail() {
    content.innerHTML = `
      <section class="integration-detail-head">
        <div class="detail-icon">${icon('apps')}</div>
        <div><h2>${escapeHtml(activeIntegration.name)}</h2><p>根目录：${escapeHtml(activeIntegration.root_folder_name || activeIntegration.root_folder_id)}</p></div>
        <span class="status-badge ${activeIntegration.enabled === 1 ? 'enabled' : 'disabled'}">${activeIntegration.enabled === 1 ? '已启用' : '已停用'}</span>
      </section>
      <div class="chip-row detail-scopes">${scopeChips(activeIntegration.scopes)}</div>
      <div class="section-heading"><h2>API Token</h2><span>${tokens.length} 个</span></div>
      <div class="token-list">${tokens.length ? tokens.map((token) => `
        <article class="token-card" data-token-id="${token.id}" data-name="${escapeHtml(token.name || '')}" data-scopes="${escapeHtml(token.scopes || '')}">
          <span class="token-symbol">${icon('key')}</span>
          <span class="token-copy"><strong>${escapeHtml(token.name || `Token ${token.id}`)}</strong><small>${escapeHtml(parseScopes(token.scopes).map(scopeLabel).join('、'))}</small><small>${token.last_used_at ? `最近使用 ${escapeHtml(token.last_used_at)}` : '尚未使用'}</small></span>
          <button type="button" class="icon-button" data-token-more aria-label="Token 操作">${icon('more')}</button>
        </article>`).join('') : `<div class="empty-inline">${icon('key')}<p>还没有 API Token</p></div>`}</div>`;
    content.querySelectorAll('[data-token-more]').forEach((button) => button.addEventListener('click', () => {
      const card = button.closest('[data-token-id]');
      const token = tokens.find((item) => String(item.id) === card.dataset.tokenId);
      openTokenForm(token);
    }));
  }

  function openTokenForm(token = null) {
    const isEdit = Boolean(token);
    const allowedScopes = parseScopes(activeIntegration.scopes);
    const selectedScopes = isEdit ? parseScopes(token.scopes) : allowedScopes;
    const panel = openOverlay({
      title: isEdit ? '编辑 API Token' : '新建 API Token',
      content: `
        <form class="dialog-form" data-form>
          <div class="field-group"><label class="field-label">Token 名称</label><input class="text-field" name="name" value="${escapeHtml(token ? token.name : '')}" placeholder="例如 production" required></div>
          <fieldset class="scope-field"><legend>Token 权限</legend>${allowedScopes.map((scope) => `<label class="check-row"><input type="checkbox" name="scopes" value="${scope}" ${selectedScopes.includes(scope) ? 'checked' : ''}><span>${scopeLabel(scope)}</span></label>`).join('')}</fieldset>
          ${isEdit ? '<button type="button" class="delete-token-button" data-delete-token>删除此 Token</button>' : ''}
        </form>`,
      submitLabel: isEdit ? '保存修改' : '创建 Token',
      onSubmit: async ({ overlay, close }) => {
        const form = overlay.querySelector('[data-form]');
        const scopes = Array.from(form.querySelectorAll('[name="scopes"]:checked')).map((input) => input.value);
        if (!form.name.value.trim() || !scopes.length) { showToast('请填写名称并选择权限', 'error'); return; }
        try {
          const path = isEdit ? `/integrations/${integrationId}/tokens/${token.id}` : `/integrations/${integrationId}/tokens`;
          const data = await request(path, { method: isEdit ? 'PUT' : 'POST', body: { name: form.name.value.trim(), scopes } });
          close();
          if (!isEdit && data.token && data.token.token) showTokenOnce(data.token.token);
          showToast(isEdit ? 'Token 已更新' : 'Token 已创建');
          loadDetail();
        } catch (error) { showToast(error.message, 'error'); }
      },
    });
    panel.overlay.querySelector('[data-form]').addEventListener('submit', (event) => { event.preventDefault(); panel.overlay.querySelector('[data-submit]').click(); });
    if (isEdit) panel.overlay.querySelector('[data-delete-token]').addEventListener('click', async () => {
      const accepted = await confirmDialog({ title: '删除 API Token', message: '使用此 Token 的外部系统将立即无法访问。', confirmLabel: '删除', danger: true });
      if (!accepted) return;
      try {
        await request(`/integrations/${integrationId}/tokens/${token.id}`, { method: 'DELETE' });
        panel.close();
        showToast('Token 已删除');
        loadDetail();
      } catch (error) { showToast(error.message, 'error'); }
    });
  }

  if (integrationId) {
    root.querySelector('[data-back]').addEventListener('click', () => navigate('apps'));
    root.querySelector('[data-add-token]').addEventListener('click', () => activeIntegration && openTokenForm());
    loadDetail();
  } else {
    root.querySelector('[data-add-app]').addEventListener('click', openCreateApp);
    loadList();
  }
}
