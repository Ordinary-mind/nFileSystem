import { setUnauthorizedHandler } from './core/api.js';
import { clearSession, getSession, saveSession } from './core/session.js';
import { icon } from './core/icons.js';
import { parseRoute } from './core/utils.js';
import { confirmDialog, showToast } from './core/ui.js';
import { mountAuth } from './views/auth.js';
import { mountDrive } from './views/drive.js';
import { mountIntegrations } from './views/integrations.js';
import { mountProfile } from './views/profile.js';

function navigate(path, replace = false) {
  const hash = `#/${path.replace(/^\//, '')}`;
  if (replace) window.history.replaceState(null, '', hash);
  else window.location.hash = hash;
}

export function startApp() {
  const app = document.getElementById('app');

  const logout = async (confirm = false) => {
    if (confirm) {
      const accepted = await confirmDialog({ title: '退出登录', message: '确定退出当前账户吗？', confirmLabel: '退出' });
      if (!accepted) return;
    }
    clearSession();
    document.getElementById('overlay-root').innerHTML = '';
    document.body.classList.remove('overlay-open');
    render();
  };

  setUnauthorizedHandler(() => logout(false));

  function renderShell(route) {
    app.innerHTML = `
      <main class="app-screen">
        <section id="view-root" class="screen-content"></section>
        <nav class="bottom-nav" aria-label="主导航">
          <button class="nav-button ${route.section === 'files' ? 'active' : ''}" data-nav="files">${icon('files')}<span>文件</span></button>
          <button class="nav-button ${route.section === 'apps' ? 'active' : ''}" data-nav="apps">${icon('apps')}<span>应用</span></button>
          <button class="nav-button ${route.section === 'me' ? 'active' : ''}" data-nav="me">${icon('user')}<span>我的</span></button>
        </nav>
      </main>`;
    app.querySelector('.bottom-nav').addEventListener('click', (event) => {
      const button = event.target.closest('[data-nav]');
      if (button) navigate(button.dataset.nav);
    });

    const root = app.querySelector('#view-root');
    if (route.section === 'files') mountDrive(root, route.id, navigate, route);
    else if (route.section === 'apps') mountIntegrations(root, route.id, navigate);
    else mountProfile(root, getSession().userEmail, () => logout(true), (token, email) => {
      saveSession(token, email);
      showToast('密码修改成功');
      render();
    });
  }

  function render() {
    const session = getSession();
    if (!session.token) {
      mountAuth(app, (token, email) => {
        saveSession(token, email);
        showToast(`欢迎回来，${email}`);
        navigate('files', true);
        render();
      });
      return;
    }
    const route = parseRoute(window.location.hash);
    if (!window.location.hash) navigate('files', true);
    renderShell(route);
  }

  window.addEventListener('hashchange', render);
  render();
}
