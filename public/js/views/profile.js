import { request } from '../core/api.js';
import { icon } from '../core/icons.js';
import { escapeHtml } from '../core/utils.js';
import { openOverlay } from '../core/ui.js';

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
  root.querySelector('[data-change-password]').addEventListener('click', () => openPasswordDialog(onPasswordChanged));
  root.querySelector('[data-logout]').addEventListener('click', onLogout);
}
