import { request } from '../core/api.js';
import { icon } from '../core/icons.js';

function passwordField(id, name, autocomplete = 'new-password') {
  return `
    <div class="password-field">
      <input class="text-field" id="${id}" name="${name}" type="password" minlength="8" autocomplete="${autocomplete}" required>
      <button type="button" class="password-toggle" aria-label="显示密码">${icon('eye')}</button>
    </div>`;
}

export function mountAuth(root, onAuthenticated) {
  root.innerHTML = `
    <main class="auth-screen">
      <section class="auth-panel">
        <div class="brand-mark">${icon('files')}</div>
        <h1>文件管理器</h1>
        <p class="auth-subtitle">使用已验证邮箱管理你的文件</p>
        <div class="segmented-control" role="tablist" data-auth-tabs>
          <button type="button" class="segment active" data-tab="login" role="tab">登录</button>
          <button type="button" class="segment" data-tab="register" role="tab" id="register-tab">注册</button>
        </div>
        <form class="auth-form" data-form="login">
          <div class="field-group">
            <label class="field-label" for="login-email">邮箱</label>
            <input class="text-field" id="login-email" name="email" type="email" maxlength="254" autocomplete="email" required>
          </div>
          <div class="field-group">
            <label class="field-label" for="login-password">密码</label>
            ${passwordField('login-password', 'password', 'current-password')}
          </div>
          <button type="button" class="auth-link" data-forgot>忘记密码？</button>
          <button class="primary-button auth-submit" type="submit">登录</button>
        </form>
        <form class="auth-form hidden" data-form="invite">
          <button type="button" class="auth-link auth-back" data-invite-back>返回登录</button>
          <div class="field-group">
            <label class="field-label" for="invite-code">邀请码</label>
            <input class="text-field" id="invite-code" name="inviteCode" maxlength="14" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX" required>
            <p class="field-hint">注册需要邀请码，请向已注册的朋友索取</p>
          </div>
          <button class="primary-button auth-submit" type="submit">继续注册</button>
        </form>
        <form class="auth-form hidden" data-form="register">
          <div class="field-group">
            <label class="field-label" for="register-email">邮箱</label>
            <input class="text-field" id="register-email" name="email" type="email" maxlength="254" autocomplete="email" required>
          </div>
          <div class="field-group">
            <label class="field-label" for="register-code">邮箱验证码</label>
            <div class="code-field">
              <input class="text-field" id="register-code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required>
              <button type="button" class="secondary-button" data-send-code>发送验证码</button>
            </div>
          </div>
          <div class="field-group">
            <label class="field-label" for="register-password">密码</label>
            ${passwordField('register-password', 'password')}
          </div>
          <div class="field-group">
            <label class="field-label" for="register-password2">确认密码</label>
            ${passwordField('register-password2', 'password2')}
          </div>
          <button class="primary-button auth-submit" type="submit">注册</button>
        </form>
        <form class="auth-form hidden" data-form="reset">
          <button type="button" class="auth-link auth-back" data-back-login>返回登录</button>
          <div class="field-group">
            <label class="field-label" for="reset-email">邮箱</label>
            <input class="text-field" id="reset-email" name="email" type="email" maxlength="254" autocomplete="email" required>
          </div>
          <div class="field-group">
            <label class="field-label" for="reset-code">邮箱验证码</label>
            <div class="code-field">
              <input class="text-field" id="reset-code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required>
              <button type="button" class="secondary-button" data-send-code>发送验证码</button>
            </div>
          </div>
          <div class="field-group">
            <label class="field-label" for="reset-password">新密码</label>
            ${passwordField('reset-password', 'newPassword')}
          </div>
          <div class="field-group">
            <label class="field-label" for="reset-password2">确认新密码</label>
            ${passwordField('reset-password2', 'password2')}
          </div>
          <button class="primary-button auth-submit" type="submit">重置密码</button>
        </form>
        <p class="form-message" aria-live="polite"></p>
      </section>
    </main>`;

  const message = root.querySelector('.form-message');
  const tabs = root.querySelector('[data-auth-tabs]');
  let registerMode = 'invite';
  let verifiedInviteCode = '';
  const showMessage = (text, type = '') => {
    message.textContent = text;
    message.className = `form-message ${type}`;
  };
  const showForm = (name) => {
    tabs.classList.toggle('hidden', name === 'reset');
    root.querySelectorAll('[data-form]').forEach((form) => form.classList.toggle('hidden', form.dataset.form !== name));
    root.querySelectorAll('[data-tab]').forEach((item) => {
      item.classList.toggle('active', item.dataset.tab === name || (name === 'invite' && item.dataset.tab === 'register'));
    });
    showMessage('');
  };

  root.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => {
    if (button.dataset.tab === 'register' && registerMode === 'invite') showForm('invite');
    else showForm(button.dataset.tab);
  }));
  root.querySelector('[data-forgot]').addEventListener('click', () => {
    const loginEmail = root.querySelector('[data-form="login"] [name="email"]').value;
    root.querySelector('[data-form="reset"] [name="email"]').value = loginEmail;
    showForm('reset');
  });
  root.querySelector('[data-back-login]').addEventListener('click', () => showForm('login'));
  root.querySelector('[data-invite-back]').addEventListener('click', () => showForm('login'));

  root.querySelectorAll('.password-toggle').forEach((button) => {
    button.addEventListener('click', () => {
      const input = button.parentElement.querySelector('input');
      input.type = input.type === 'password' ? 'text' : 'password';
      button.classList.toggle('active', input.type === 'text');
      button.setAttribute('aria-label', input.type === 'text' ? '隐藏密码' : '显示密码');
    });
  });

  function attachCodeSender(formName, purpose) {
    const form = root.querySelector(`[data-form="${formName}"]`);
    const button = form.querySelector('[data-send-code]');
    button.addEventListener('click', async () => {
      const email = form.elements.email.value.trim();
      if (!email || !form.elements.email.checkValidity()) {
        form.elements.email.reportValidity();
        return;
      }
      button.disabled = true;
      showMessage('正在发送验证码...');
      try {
        const body = { email, purpose };
        if (purpose === 'register' && verifiedInviteCode) body.inviteCode = verifiedInviteCode;
        const data = await request('/auth/email-codes', { method: 'POST', auth: false, body });
        showMessage(data.message, 'success');
        let remaining = 60;
        button.textContent = `${remaining} 秒后重发`;
        const timer = window.setInterval(() => {
          remaining--;
          button.textContent = remaining > 0 ? `${remaining} 秒后重发` : '重新发送';
          if (remaining <= 0) {
            window.clearInterval(timer);
            button.disabled = false;
          }
        }, 1000);
      } catch (error) {
        showMessage(error.message || '验证码发送失败', 'error');
        button.disabled = false;
      }
    });
  }

  attachCodeSender('register', 'register');
  attachCodeSender('reset', 'reset_password');

  root.querySelector('[data-form="login"]').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    showMessage('正在登录...');
    try {
      const data = await request('/auth/login', {
        method: 'POST', auth: false, body: { email: form.elements.email.value.trim(), password: form.elements.password.value },
      });
      onAuthenticated(data.token, data.user.email);
    } catch (error) {
      showMessage(error.message || '登录失败', 'error');
    } finally {
      submit.disabled = false;
    }
  });

  root.querySelector('[data-form="invite"]').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    showMessage('正在验证邀请码...');
    try {
      const code = form.elements.inviteCode.value.trim();
      await request('/auth/invite/verify', { method: 'POST', auth: false, body: { code } });
      verifiedInviteCode = code;
      showForm('register');
      showMessage('邀请码有效，请继续完成注册', 'success');
    } catch (error) {
      showMessage(error.message || '邀请码无效', 'error');
    } finally {
      submit.disabled = false;
    }
  });

  root.querySelector('[data-form="register"]').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (form.elements.password.value !== form.elements.password2.value) {
      showMessage('两次密码不一致', 'error');
      return;
    }
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    showMessage('正在注册...');
    try {
      const payload = {
        email: form.elements.email.value.trim(),
        code: form.elements.code.value.trim(),
        password: form.elements.password.value,
      };
      if (verifiedInviteCode) payload.inviteCode = verifiedInviteCode;
      await request('/auth/register', { method: 'POST', auth: false, body: payload });
      verifiedInviteCode = '';
      root.querySelector('[data-form="login"] [name="email"]').value = payload.email;
      showForm('login');
      showMessage('注册成功，请登录', 'success');
    } catch (error) {
      showMessage(error.message || '注册失败', 'error');
    } finally {
      submit.disabled = false;
    }
  });

  root.querySelector('[data-form="reset"]').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (form.elements.newPassword.value !== form.elements.password2.value) {
      showMessage('两次密码不一致', 'error');
      return;
    }
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    showMessage('正在重置密码...');
    try {
      await request('/auth/password/reset', {
        method: 'POST', auth: false,
        body: { email: form.elements.email.value.trim(), code: form.elements.code.value.trim(), newPassword: form.elements.newPassword.value },
      });
      root.querySelector('[data-form="login"] [name="email"]').value = form.elements.email.value.trim();
      showForm('login');
      showMessage('密码已重置，请登录', 'success');
    } catch (error) {
      showMessage(error.message || '密码重置失败', 'error');
    } finally {
      submit.disabled = false;
    }
  });

  request('/auth/register-status', { auth: false })
    .then((data) => {
      registerMode = data.mode === 'bootstrap' ? 'bootstrap' : 'invite';
    })
    .catch(() => {});
}
