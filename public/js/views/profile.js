import { request } from '../core/api.js';
import { icon } from '../core/icons.js';
import { escapeHtml, formatDate, formatSize } from '../core/utils.js';
import { confirmDialog, copyText, errorView, loadingView, openOverlay, showToast } from '../core/ui.js';

const SHARE_STATUS = {
  active: { label: '生效中', className: 'share-badge active' },
  expired: { label: '已过期', className: 'share-badge muted' },
  revoked: { label: '已撤销', className: 'share-badge danger' },
  gone: { label: '已失效', className: 'share-badge muted' },
};

function showResetLink(path) {
  const panel = openOverlay({
    title: '新链接已生成',
    content: `
      <div class="share-result">
        <p class="field-hint">旧链接已失效，请立即复制保存新链接（仅展示一次）：</p>
        <input class="text-field" data-share-url readonly aria-label="分享链接">
        <button type="button" class="primary-button" data-copy>复制链接</button>
      </div>`,
  });
  const url = `${window.location.origin}${path}`;
  panel.overlay.querySelector('[data-share-url]').value = url;
  panel.overlay.querySelector('[data-copy]').addEventListener('click', async () => {
    await copyText(url);
    showToast('链接已复制');
  });
}

function openShareManager() {
  const panel = openOverlay({
    title: '我的分享',
    variant: 'full',
    content: '<div data-share-list></div>',
  });
  const listNode = panel.overlay.querySelector('[data-share-list]');

  async function load() {
    listNode.innerHTML = loadingView();
    try {
      const data = await request('/drive/shares');
      if (!data.items.length) {
        listNode.innerHTML = `<div class="share-state">${icon('share')}<h2>还没有分享</h2><p>在文件或文件夹的更多操作中选择「分享」即可创建链接</p></div>`;
        return;
      }
      listNode.innerHTML = `<div class="share-manage-list">${data.items.map((share) => {
        const status = SHARE_STATUS[share.status] || SHARE_STATUS.gone;
        const expiry = share.expiresAt ? `有效期至 ${formatDate(share.expiresAt)}` : '永久有效';
        const meta = [expiry, `被访问 ${share.useCount} 次`, share.hasPasscode ? '提取码' : '无提取码'].join(' · ');
        return `
          <section class="share-manage-row" data-share="${share.id}">
            <div class="share-manage-main">
              <span class="file-symbol ${share.itemType === 'folder' ? 'folder-symbol' : ''}">${icon(share.itemType === 'folder' ? 'folder' : 'file')}</span>
              <span class="drive-text">
                <strong>${escapeHtml(share.name || '（内容已删除）')}</strong>
                <small>${share.size ? formatSize(share.size) : ''}${share.size ? ' · ' : ''}${escapeHtml(meta)}</small>
              </span>
              <span class="${status.className}">${status.label}</span>
            </div>
            <div class="share-manage-actions">
              <button type="button" class="secondary-button" data-copy-share>复制链接</button>
              ${share.status === 'active' ? '<button type="button" class="secondary-button" data-reset>重置</button>' : ''}
              <button type="button" class="secondary-button danger-row" data-delete>删除</button>
            </div>
          </section>`;
      }).join('')}</div>`;
      listNode.querySelectorAll('[data-copy-share]').forEach((button) => button.addEventListener('click', async () => {
        const row = button.closest('[data-share]');
        const share = data.items.find((item) => String(item.id) === row.dataset.share);
        if (!share?.path) {
          showToast('此分享创建于旧版本，请先重置链接后再复制', 'error');
          return;
        }
        await copyText(`${window.location.origin}${share.path}`);
        showToast('链接已复制');
      }));
      listNode.querySelectorAll('[data-reset]').forEach((button) => button.addEventListener('click', async () => {
        const row = button.closest('[data-share]');
        const shareId = row.dataset.share;
        const accepted = await confirmDialog({ title: '重置链接', message: '重置后旧链接立即失效，确定继续吗？', confirmLabel: '重置' });
        if (!accepted) return;
        button.disabled = true;
        try {
          const result = await request(`/drive/share/${shareId}/reset`, { method: 'POST' });
          showResetLink(result.path);
          load();
        } catch (error) {
          showToast(error.message || '重置失败', 'error');
          button.disabled = false;
        }
      }));
      listNode.querySelectorAll('[data-delete]').forEach((button) => button.addEventListener('click', async () => {
        const row = button.closest('[data-share]');
        const shareId = row.dataset.share;
        const accepted = await confirmDialog({ title: '删除分享', message: '删除后该链接立即失效且记录不可恢复，确定继续吗？', confirmLabel: '删除' });
        if (!accepted) return;
        button.disabled = true;
        try {
          await request(`/drive/share/${shareId}`, { method: 'DELETE' });
          showToast('分享已删除');
          load();
        } catch (error) {
          showToast(error.message || '删除失败', 'error');
          button.disabled = false;
        }
      }));
    } catch (error) {
      listNode.innerHTML = errorView(error.message || '加载失败');
    }
  }

  load();
}

const INVITE_STATUS = {
  active: { label: '未使用', className: 'share-badge active' },
  used: { label: '已使用', className: 'share-badge muted' },
  expired: { label: '已过期', className: 'share-badge muted' },
};

function showInviteCode(formatted) {
  const panel = openOverlay({
    title: '邀请码已生成',
    content: `
      <div class="share-result">
        <p class="field-hint">把这枚邀请码发给朋友，对方注册时填写即可（一次性使用）：</p>
        <input class="text-field" data-invite-code readonly aria-label="邀请码">
        <button type="button" class="primary-button" data-copy>复制邀请码</button>
      </div>`,
  });
  panel.overlay.querySelector('[data-invite-code]').value = formatted;
  panel.overlay.querySelector('[data-copy]').addEventListener('click', async () => {
    await copyText(formatted);
    showToast('邀请码已复制');
  });
}

function openInviteManager() {
  let days = 'never';
  const panel = openOverlay({
    title: '邀请码',
    variant: 'full',
    content: `
      <div class="invite-create">
        <input class="text-field" data-invite-note maxlength="64" placeholder="备注（可选，如「给小李」）" aria-label="备注">
        <select class="invite-expiry" data-invite-expiry aria-label="邀请码有效期">
          <option value="never">永久有效</option>
          <option value="7">7 天有效</option>
          <option value="30">30 天有效</option>
        </select>
        <button type="button" class="primary-button" data-invite-create>生成邀请码</button>
      </div>
      <div data-invite-list></div>`,
  });
  const overlay = panel.overlay;
  const listNode = overlay.querySelector('[data-invite-list]');
  overlay.querySelector('[data-invite-expiry]').addEventListener('change', (event) => {
    days = event.target.value;
  });
  overlay.querySelector('[data-invite-create]').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await request('/drive/invite-codes', {
        method: 'POST',
        body: { note: overlay.querySelector('[data-invite-note]').value.trim() || undefined, expiresIn: days === 'never' ? undefined : days },
      });
      overlay.querySelector('[data-invite-note]').value = '';
      showInviteCode(result.formatted);
      load();
    } catch (error) {
      showToast(error.message || '生成失败', 'error');
    } finally {
      button.disabled = false;
    }
  });

  async function load() {
    listNode.innerHTML = loadingView();
    try {
      const data = await request('/drive/invite-codes');
      if (!data.items.length) {
        listNode.innerHTML = `<div class="share-state">${icon('key')}<h2>还没有邀请码</h2><p>生成一枚邀请码发给朋友，对方即可注册账号</p></div>`;
        return;
      }
      listNode.innerHTML = `<div class="share-manage-list">${data.items.map((invite) => {
        const status = INVITE_STATUS[invite.status] || INVITE_STATUS.expired;
        const expiry = invite.expiresAt ? `有效期至 ${formatDate(invite.expiresAt)}` : '永久有效';
        const meta = [expiry, invite.note ? escapeHtml(invite.note) : '', invite.usedByName ? `由 ${escapeHtml(invite.usedByName)} 使用` : ''].filter(Boolean).join(' · ');
        return `
          <section class="share-manage-row" data-invite="${invite.id}">
            <div class="share-manage-main">
              <span class="file-symbol">${icon('key')}</span>
              <span class="drive-text">
                <strong class="invite-code">${escapeHtml(invite.formatted)}</strong>
                <small>${escapeHtml(meta)}</small>
              </span>
              <span class="${status.className}">${status.label}</span>
            </div>
            <div class="share-manage-actions">
              ${invite.status === 'active' ? '<button type="button" class="secondary-button" data-invite-copy>复制</button>' : ''}
              ${invite.status !== 'used' ? '<button type="button" class="secondary-button danger-row" data-invite-delete>删除</button>' : ''}
            </div>
          </section>`;
      }).join('')}</div>`;
      listNode.querySelectorAll('[data-invite-copy]').forEach((button) => button.addEventListener('click', async () => {
        const row = button.closest('[data-invite]');
        const invite = data.items.find((item) => String(item.id) === row.dataset.invite);
        await copyText(invite.formatted);
        showToast('邀请码已复制');
      }));
      listNode.querySelectorAll('[data-invite-delete]').forEach((button) => button.addEventListener('click', async () => {
        const row = button.closest('[data-invite]');
        const accepted = await confirmDialog({ title: '删除邀请码', message: '删除后该邀请码立即失效，确定继续吗？', confirmLabel: '删除' });
        if (!accepted) return;
        button.disabled = true;
        try {
          await request(`/drive/invite-codes/${row.dataset.invite}`, { method: 'DELETE' });
          showToast('邀请码已删除');
          load();
        } catch (error) {
          showToast(error.message || '删除失败', 'error');
          button.disabled = false;
        }
      }));
    } catch (error) {
      listNode.innerHTML = errorView(error.message || '加载失败');
    }
  }

  load();
}

function openPasswordDialog(onPasswordChanged) {
  const panel = openOverlay({
    title: '修改密码',
    content: `
      <form class="dialog-form" data-password-form>
        <label class="field-label" for="current-password">当前密码</label>
        <input class="text-field" id="current-password" name="currentPassword" type="password" autocomplete="current-password" required>
        <label class="field-label" for="new-password">新密码</label>
        <input class="text-field" id="new-password" name="newPassword" type="password" minlength="8" autocomplete="new-password" required>
        <label class="field-label" for="new-password2">确认新密码</label>
        <input class="text-field" id="new-password2" name="newPassword2" type="password" minlength="8" autocomplete="new-password" required>
        <p class="form-message" data-password-message aria-live="polite"></p>
      </form>`,
    submitLabel: '保存新密码',
    dismissible: false,
    onSubmit: async ({ overlay, close }) => {
      const form = overlay.querySelector('[data-password-form]');
      const message = overlay.querySelector('[data-password-message]');
      const submit = overlay.querySelector('[data-submit]');
      if (!form.reportValidity()) return;
      if (form.elements.newPassword.value !== form.elements.newPassword2.value) {
        message.textContent = '两次密码不一致';
        message.className = 'form-message error';
        return;
      }
      submit.disabled = true;
      try {
        const data = await request('/auth/password/change', {
          method: 'POST',
          body: { currentPassword: form.elements.currentPassword.value, newPassword: form.elements.newPassword.value },
        });
        close(false);
        onPasswordChanged(data.token, data.user.email);
      } catch (error) {
        message.textContent = error.message || '密码修改失败';
        message.className = 'form-message error';
        submit.disabled = false;
      }
    },
  });
  panel.overlay.querySelector('[data-password-form]').addEventListener('submit', (event) => {
    event.preventDefault();
    panel.overlay.querySelector('[data-submit]').click();
  });
}

export function mountProfile(root, userEmail, onLogout, onPasswordChanged) {
  const initial = String(userEmail || '?').trim().slice(0, 1).toUpperCase();
  root.innerHTML = `
    <div class="top-bar no-back">
      <div><h1>我的</h1><div class="top-bar-subtitle">账户与登录状态</div></div>
      <span></span>
    </div>
    <div class="profile-content">
      <section class="profile-identity">
        <div class="avatar" aria-hidden="true">${escapeHtml(initial)}</div>
        <div><h2>${escapeHtml(userEmail)}</h2><p>已验证邮箱</p></div>
      </section>
      <section class="settings-list">
        <button type="button" class="settings-row" data-share-manager>
          <span class="settings-icon">${icon('share')}</span>
          <span><strong>我的分享</strong><small>管理已创建的分享链接</small></span>
        </button>
        <button type="button" class="settings-row" data-invite-manager>
          <span class="settings-icon">${icon('key')}</span>
          <span><strong>邀请码</strong><small>生成邀请码，邀请朋友注册</small></span>
        </button>
        <button type="button" class="settings-row" data-change-password>
          <span class="settings-icon">${icon('key')}</span>
          <span><strong>修改密码</strong><small>修改后其他设备需要重新登录</small></span>
        </button>
        <div class="settings-row">
          <span class="settings-icon">${icon('info')}</span>
          <span><strong>nFileSystem</strong><small>移动端文件管理器</small></span>
        </div>
        <button type="button" class="settings-row danger-row" data-logout>
          <span class="settings-icon">${icon('logout')}</span>
          <span><strong>退出登录</strong><small>清除当前设备的登录状态</small></span>
        </button>
      </section>
    </div>`;
  root.querySelector('[data-share-manager]').addEventListener('click', openShareManager);
  root.querySelector('[data-invite-manager]').addEventListener('click', openInviteManager);
  root.querySelector('[data-change-password]').addEventListener('click', () => openPasswordDialog(onPasswordChanged));
  root.querySelector('[data-logout]').addEventListener('click', onLogout);
}
