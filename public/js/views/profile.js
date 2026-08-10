import { icon } from '../core/icons.js';
import { escapeHtml } from '../core/utils.js';

export function mountProfile(root, userName, onLogout) {
  const initial = String(userName || '?').trim().slice(0, 1).toUpperCase();
  root.innerHTML = `
    <div class="top-bar no-back">
      <div><h1>我的</h1><div class="top-bar-subtitle">账户与登录状态</div></div>
      <span></span>
    </div>
    <div class="profile-content">
      <section class="profile-identity">
        <div class="avatar" aria-hidden="true">${escapeHtml(initial)}</div>
        <div><h2>${escapeHtml(userName)}</h2><p>当前登录账户</p></div>
      </section>
      <section class="settings-list">
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
  root.querySelector('[data-logout]').addEventListener('click', onLogout);
}
