import { request } from '../core/api.js';
import { icon } from '../core/icons.js';

export function mountAuth(root, onAuthenticated) {
  root.innerHTML = `
    <main class="auth-screen">
      <section class="auth-panel">
        <div class="brand-mark">${icon('files')}</div>
        <h1>文件管理器</h1>
        <p class="auth-subtitle">登录后管理你的文件</p>
        <div class="segmented-control" role="tablist">
          <button type="button" class="segment active" data-tab="login" role="tab">登录</button>
          <button type="button" class="segment" data-tab="register" role="tab" id="register-tab">注册</button>
        </div>
        <form class="auth-form" data-form="login">
          <div class="field-group">
            <label class="field-label" for="login-name">用户名</label>
            <input class="text-field" id="login-name" name="name" autocomplete="username" required>
          </div>
          <div class="field-group">
            <label class="field-label" for="login-password">密码</label>
            <div class="password-field">
              <input class="text-field" id="login-password" name="password" type="password" autocomplete="current-password" required>
              <button type="button" class="password-toggle" aria-label="显示密码">${icon('eye')}</button>
            </div>
          </div>
          <button class="primary-button auth-submit" type="submit">登录</button>
        </form>
        <form class="auth-form hidden" data-form="register">
          <div class="field-group">
            <label class="field-label" for="register-name">用户名</label>
            <input class="text-field" id="register-name" name="name" autocomplete="username" required>
          </div>
          <div class="field-group">
            <label class="field-label" for="register-password">密码</label>
            <div class="password-field">
              <input class="text-field" id="register-password" name="password" type="password" minlength="8" autocomplete="new-password" required>
              <button type="button" class="password-toggle" aria-label="显示密码">${icon('eye')}</button>
            </div>
          </div>
          <div class="field-group">
            <label class="field-label" for="register-password2">确认密码</label>
            <div class="password-field">
              <input class="text-field" id="register-password2" name="password2" type="password" minlength="8" autocomplete="new-password" required>
              <button type="button" class="password-toggle" aria-label="显示密码">${icon('eye')}</button>
            </div>
          </div>
          <button class="primary-button auth-submit" type="submit">注册</button>
        </form>
        <p class="form-message" aria-live="polite"></p>
      </section>
    </main>`;

  const message = root.querySelector('.form-message');
  const showMessage = (text, type = '') => {
    message.textContent = text;
    message.className = `form-message ${type}`;
  };

  root.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      root.querySelectorAll('[data-tab]').forEach((item) => item.classList.toggle('active', item === button));
      root.querySelectorAll('[data-form]').forEach((form) => form.classList.toggle('hidden', form.dataset.form !== button.dataset.tab));
      showMessage('');
    });
  });

  root.querySelectorAll('.password-toggle').forEach((button) => {
    button.addEventListener('click', () => {
      const input = button.parentElement.querySelector('input');
      input.type = input.type === 'password' ? 'text' : 'password';
      button.classList.toggle('active', input.type === 'text');
      button.setAttribute('aria-label', input.type === 'text' ? '隐藏密码' : '显示密码');
    });
  });

  root.querySelector('[data-form="login"]').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    showMessage('正在登录...');
    try {
      const data = await request('/auth/login', {
        method: 'POST', auth: false, body: { name: form.name.value.trim(), password: form.password.value },
      });
      onAuthenticated(data.token, data.user.name);
    } catch (error) {
      showMessage(error.message || '登录失败', 'error');
    } finally {
      submit.disabled = false;
    }
  });

  root.querySelector('[data-form="register"]').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (form.password.value !== form.password2.value) {
      showMessage('两次密码不一致', 'error');
      return;
    }
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    showMessage('正在注册...');
    try {
      await request('/auth/register', {
        method: 'POST', auth: false, body: { name: form.name.value.trim(), password: form.password.value },
      });
      showMessage('注册成功，请登录', 'success');
      root.querySelector('[data-tab="login"]').click();
    } catch (error) {
      showMessage(error.message || '注册失败', 'error');
    } finally {
      submit.disabled = false;
    }
  });

  request('/auth/register-status', { auth: false })
    .then((data) => {
      if (!data.allowed) root.querySelector('#register-tab').classList.add('hidden');
    })
    .catch(() => {});
}
