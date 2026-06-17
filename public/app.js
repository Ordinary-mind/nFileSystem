(() => {
  'use strict';

  const API = '';
  let token = localStorage.getItem('token') || '';
  let userName = localStorage.getItem('userName') || '';
  let currentFolderId = null;

  // DOM refs
  const authPage = document.getElementById('auth-page');
  const filePage = document.getElementById('file-page');
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');
  const registerTab = document.getElementById('register-tab');
  const authMessage = document.getElementById('auth-message');
  const fileList = document.getElementById('file-list');
  const fileInput = document.getElementById('file-input');
  const searchInput = document.getElementById('search-input');
  const userInfo = document.getElementById('user-info');
  const logoutBtn = document.getElementById('logout-btn');
  const newFolderBtn = document.getElementById('new-folder-btn');
  const breadcrumb = document.getElementById('breadcrumb');
  const uploadOverlay = document.getElementById('upload-overlay');
  const progressFill = document.getElementById('progress-fill');
  const uploadStatus = document.getElementById('upload-status');
  const previewOverlay = document.getElementById('preview-overlay');
  const previewTitle = document.getElementById('preview-title');
  const previewContent = document.getElementById('preview-content');
  const previewClose = document.getElementById('preview-close');
  const contextMenu = document.getElementById('context-menu');
  const moveOverlay = document.getElementById('move-overlay');
  const moveList = document.getElementById('move-list');
  const moveBreadcrumb = document.getElementById('move-breadcrumb');
  const moveClose = document.getElementById('move-close');
  const moveConfirm = document.getElementById('move-confirm');
  const integrationsBtn = document.getElementById('integrations-btn');
  const integrationsOverlay = document.getElementById('integrations-overlay');
  const integrationsClose = document.getElementById('integrations-close');
  const integrationForm = document.getElementById('integration-form');
  const integrationName = document.getElementById('integration-name');
  const integrationRoot = document.getElementById('integration-root');
  const integrationsList = document.getElementById('integrations-list');
  const tokensPanel = document.getElementById('tokens-panel');
  const newTokenBox = document.getElementById('new-token-box');
  const newTokenValue = document.getElementById('new-token-value');
  const copyTokenBtn = document.getElementById('copy-token-btn');

  // ===== Toast =====
  function showToast(text, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = text;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 1000);
  }

  // ===== Password Toggle =====
  document.querySelectorAll('.eye-toggle').forEach(toggle => {
    toggle.addEventListener('click', () => {
      const input = document.getElementById(toggle.dataset.target);
      if (input.type === 'password') {
        input.type = 'text';
        toggle.classList.add('active');
      } else {
        input.type = 'password';
        toggle.classList.remove('active');
      }
    });
  });

  // ===== Auth Tabs =====
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      loginForm.classList.toggle('hidden', target !== 'login');
      registerForm.classList.toggle('hidden', target !== 'register');
      showMessage('', '');
    });
  });

  async function checkRegisterStatus() {
    try {
      const res = await fetch(`${API}/auth/register-status`);
      const data = await res.json();
      if (!data.allowed) registerTab.style.display = 'none';
    } catch (e) { /* ignore */ }
  }

  function showMessage(text, type) {
    authMessage.textContent = text;
    authMessage.className = 'message ' + type;
  }

  // ===== Login =====
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('login-name').value.trim();
    const password = document.getElementById('login-password').value;
    try {
      const res = await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, password }),
      });
      const data = await res.json();
      if (!res.ok) { showMessage(data.message, 'error'); return; }
      token = data.token;
      userName = data.user.name;
      localStorage.setItem('token', token);
      localStorage.setItem('userName', userName);
      showToast(`欢迎回来，${userName}`, 'success');
      enterFileManager();
    } catch (err) {
      showMessage('网络错误', 'error');
    }
  });

  // ===== Register =====
  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('reg-name').value.trim();
    const password = document.getElementById('reg-password').value;
    const password2 = document.getElementById('reg-password2').value;
    if (password !== password2) { showMessage('两次密码不一致', 'error'); return; }
    if (password.length < 6) { showMessage('密码至少 6 位', 'error'); return; }

    try {
      const res = await fetch(`${API}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, password }),
      });
      const data = await res.json();
      if (!res.ok) { showMessage(data.message, 'error'); return; }
      showMessage('注册成功，请登录', 'success');
      showToast('注册成功，请登录', 'success');
      document.querySelector('[data-tab="login"]').click();
    } catch (err) {
      showMessage('网络错误', 'error');
    }
  });

  // ===== File Manager =====
  function enterFileManager() {
    authPage.classList.add('hidden');
    filePage.classList.remove('hidden');
    userInfo.textContent = `👤 ${userName}`;
    currentFolderId = null;
    loadDrive();
  }

  function logout() {
    token = '';
    userName = '';
    localStorage.removeItem('token');
    localStorage.removeItem('userName');
    filePage.classList.add('hidden');
    authPage.classList.remove('hidden');
    loginForm.reset();
    showMessage('', '');
  }

  logoutBtn.addEventListener('click', logout);

  // ===== Load Drive =====
  let searchTimer = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadDrive(searchInput.value.trim()), 300);
  });

  async function loadDrive(search) {
    try {
      let url = `${API}/drive?`;
      if (currentFolderId) url += `folderId=${currentFolderId}&`;
      if (search) url += `name=${encodeURIComponent(search)}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) { logout(); return; }
      const data = await res.json();
      renderBreadcrumb(data.breadcrumb || []);
      renderDrive(data.folders || [], data.files || []);
    } catch (err) {
      fileList.innerHTML = '<div class="empty-state"><div class="icon">⚠️</div>加载失败</div>';
    }
  }

  function renderBreadcrumb(crumbs) {
    let html = '<span class="breadcrumb-item" data-id="">🏠 根目录</span>';
    for (const c of crumbs) {
      html += '<span class="breadcrumb-sep">›</span>';
      html += `<span class="breadcrumb-item" data-id="${c.id}">${escapeHtml(c.name)}</span>`;
    }
    breadcrumb.innerHTML = html;

    breadcrumb.querySelectorAll('.breadcrumb-item').forEach(item => {
      item.addEventListener('click', () => {
        currentFolderId = item.dataset.id || null;
        loadDrive();
      });
    });
  }

  function renderDrive(folders, files) {
    if (!folders.length && !files.length) {
      fileList.innerHTML = '<div class="empty-state"><div class="icon">📂</div>空文件夹，右键可新建文件夹</div>';
      return;
    }

    let html = '';

    for (const f of folders) {
      html += `
        <div class="file-item folder" data-type="folder" data-id="${f.id}" data-name="${escapeAttr(f.name)}">
          <div class="col-name">
            <span class="file-icon">📁</span>
            <span class="file-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
          </div>
          <div class="col-size">-</div>
          <div class="col-type">文件夹</div>
          <div class="col-date">${f.created_at || '-'}</div>
        </div>`;
    }

    for (const f of files) {
      html += `
        <div class="file-item" data-type="file" data-id="${f.id}" data-name="${escapeAttr(f.name)}" data-md5="${f.md5}">
          <div class="col-name">
            <span class="file-icon">${getFileIcon(f.name)}</span>
            <span class="file-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
          </div>
          <div class="col-size">${formatSize(f.size)}</div>
          <div class="col-type">${getExtension(f.name)}</div>
          <div class="col-date">${f.created_at || '-'}</div>
        </div>`;
    }

    fileList.innerHTML = html;

    // 双击文件夹进入
    fileList.querySelectorAll('.file-item.folder').forEach(el => {
      el.addEventListener('dblclick', () => {
        currentFolderId = el.dataset.id;
        searchInput.value = '';
        loadDrive();
      });
    });

    // 双击文件预览
    fileList.querySelectorAll('.file-item[data-type="file"]').forEach(el => {
      el.addEventListener('dblclick', () => {
        previewFile(el.dataset.md5, el.dataset.name);
      });
    });
  }

  // ===== Context Menu =====
  let contextTarget = null;

  fileList.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const item = e.target.closest('.file-item');

    if (item) {
      contextTarget = {
        type: item.dataset.type,
        id: item.dataset.id,
        name: item.dataset.name,
        md5: item.dataset.md5 || null,
      };

      // 高亮选中
      fileList.querySelectorAll('.file-item').forEach(el => el.classList.remove('selected'));
      item.classList.add('selected');

      let menuHtml = '';
      if (contextTarget.type === 'folder') {
        menuHtml = `
          <div class="menu-item" data-action="open">📂 打开</div>
          <div class="menu-divider"></div>
          <div class="menu-item" data-action="rename">✏️ 重命名</div>
          <div class="menu-item" data-action="move">📦 移动到...</div>
          <div class="menu-divider"></div>
          <div class="menu-item danger" data-action="delete">🗑️ 删除</div>
        `;
      } else {
        menuHtml = `
          <div class="menu-item" data-action="preview">👁️ 查看</div>
          <div class="menu-item" data-action="download">⬇️ 下载</div>
          <div class="menu-divider"></div>
          <div class="menu-item" data-action="rename">✏️ 重命名</div>
          <div class="menu-item" data-action="move">📦 移动到...</div>
          <div class="menu-divider"></div>
          <div class="menu-item danger" data-action="delete">🗑️ 删除</div>
        `;
      }
      contextMenu.innerHTML = menuHtml;
    } else {
      // 右键空白区域
      contextTarget = null;
      fileList.querySelectorAll('.file-item').forEach(el => el.classList.remove('selected'));
      contextMenu.innerHTML = `
        <div class="menu-item" data-action="new-folder">📂 新建文件夹</div>
        <div class="menu-item" data-action="upload">⬆️ 上传文件</div>
      `;
    }

    // 定位菜单
    contextMenu.classList.remove('hidden');
    const menuW = contextMenu.offsetWidth;
    const menuH = contextMenu.offsetHeight;
    let x = e.clientX;
    let y = e.clientY;
    if (x + menuW > window.innerWidth) x = window.innerWidth - menuW - 4;
    if (y + menuH > window.innerHeight) y = window.innerHeight - menuH - 4;
    contextMenu.style.left = x + 'px';
    contextMenu.style.top = y + 'px';
  });

  // 菜单点击
  contextMenu.addEventListener('click', (e) => {
    const menuItem = e.target.closest('.menu-item');
    if (!menuItem) return;
    const action = menuItem.dataset.action;
    contextMenu.classList.add('hidden');

    switch (action) {
      case 'open':
        if (contextTarget) { currentFolderId = contextTarget.id; searchInput.value = ''; loadDrive(); }
        break;
      case 'preview':
        if (contextTarget) previewFile(contextTarget.md5, contextTarget.name);
        break;
      case 'download':
        if (contextTarget) downloadFile(contextTarget.md5, contextTarget.name);
        break;
      case 'rename':
        if (contextTarget) renameItem(contextTarget.type, contextTarget.id, contextTarget.name);
        break;
      case 'move':
        if (contextTarget) openMoveDialog(contextTarget.type, contextTarget.id);
        break;
      case 'delete':
        if (contextTarget) deleteItem(contextTarget.type, contextTarget.id);
        break;
      case 'new-folder':
        createFolder();
        break;
      case 'upload':
        fileInput.click();
        break;
    }
  });

  // 隐藏菜单
  document.addEventListener('click', (e) => {
    if (!contextMenu.contains(e.target)) {
      contextMenu.classList.add('hidden');
      fileList.querySelectorAll('.file-item').forEach(el => el.classList.remove('selected'));
    }
  });

  // ===== Folder/File Operations =====
  newFolderBtn.addEventListener('click', createFolder);

  async function createFolder() {
    const name = prompt('请输入文件夹名称：');
    if (!name || !name.trim()) return;
    try {
      const res = await fetch(`${API}/drive/folder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: name.trim(), parentId: currentFolderId }),
      });
      const data = await res.json();
      if (!res.ok) { showToast(data.message, 'error'); return; }
      showToast('文件夹创建成功', 'success');
      loadDrive();
    } catch (err) {
      showToast('创建失败', 'error');
    }
  }

  async function renameItem(type, id, oldName) {
    const label = type === 'folder' ? '文件夹' : '文件';
    const name = prompt(`请输入新${label}名：`, oldName);
    if (!name || !name.trim() || name.trim() === oldName) return;

    const endpoint = type === 'folder' ? `${API}/drive/folder/${id}` : `${API}/drive/file/${id}`;
    try {
      const res = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { showToast(data.message, 'error'); return; }
      showToast('重命名成功', 'success');
      loadDrive();
    } catch (err) {
      showToast('重命名失败', 'error');
    }
  }

  async function deleteItem(type, id) {
    const label = type === 'folder' ? '该文件夹及其所有内容' : '该文件';
    if (!confirm(`确定删除${label}？`)) return;

    const endpoint = type === 'folder' ? `${API}/drive/folder/${id}` : `${API}/drive/file/${id}`;
    try {
      const res = await fetch(endpoint, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) { showToast(data.message, 'error'); return; }
      showToast('删除成功', 'success');
      loadDrive();
    } catch (err) {
      showToast('删除失败', 'error');
    }
  }

  function downloadFile(md5, name) {
    // 需要带 token，用 fetch + blob 方式下载
    fetch(`${API}/files/${md5}/download?name=${encodeURIComponent(name)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(res => {
        if (!res.ok) throw new Error('下载失败');
        return res.blob();
      })
      .then(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
      })
      .catch(() => showToast('下载失败', 'error'));
  }

  // ===== Move Dialog =====
  let moveTarget = { type: null, id: null };
  let moveCurrentFolderId = null;

  function openMoveDialog(type, id) {
    moveTarget = { type, id };
    moveCurrentFolderId = null;
    moveOverlay.classList.remove('hidden');
    loadMoveFolders();
  }

  moveClose.addEventListener('click', () => {
    moveOverlay.classList.add('hidden');
  });

  moveOverlay.addEventListener('click', (e) => {
    if (e.target === moveOverlay) moveOverlay.classList.add('hidden');
  });

  moveConfirm.addEventListener('click', async () => {
    try {
      const res = await fetch(`${API}/drive/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          type: moveTarget.type,
          id: moveTarget.id,
          targetFolderId: moveCurrentFolderId,
        }),
      });
      const data = await res.json();
      if (!res.ok) { showToast(data.message, 'error'); return; }
      showToast('移动成功', 'success');
      moveOverlay.classList.add('hidden');
      loadDrive();
    } catch (err) {
      showToast('移动失败', 'error');
    }
  });

  async function loadMoveFolders() {
    try {
      let url = `${API}/drive?`;
      if (moveCurrentFolderId) url += `folderId=${moveCurrentFolderId}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();

      // 面包屑
      let bcHtml = '<span data-id="">🏠 根目录</span>';
      for (const c of (data.breadcrumb || [])) {
        bcHtml += ' › ';
        bcHtml += `<span data-id="${c.id}">${escapeHtml(c.name)}</span>`;
      }
      moveBreadcrumb.innerHTML = bcHtml;

      moveBreadcrumb.querySelectorAll('span').forEach(el => {
        el.addEventListener('click', () => {
          moveCurrentFolderId = el.dataset.id || null;
          loadMoveFolders();
        });
      });

      // 文件夹列表（排除正在移动的文件夹自身）
      const folders = (data.folders || []).filter(f => {
        if (moveTarget.type === 'folder' && String(f.id) === String(moveTarget.id)) return false;
        return true;
      });

      if (!folders.length) {
        moveList.innerHTML = '<div class="move-empty">此处没有子文件夹</div>';
      } else {
        moveList.innerHTML = folders.map(f => `
          <div class="move-folder-item" data-id="${f.id}">
            📁 ${escapeHtml(f.name)}
          </div>
        `).join('');

        moveList.querySelectorAll('.move-folder-item').forEach(el => {
          el.addEventListener('dblclick', () => {
            moveCurrentFolderId = el.dataset.id;
            loadMoveFolders();
          });
        });
      }
    } catch (err) {
      moveList.innerHTML = '<div class="move-empty">加载失败</div>';
    }
  }

  // ===== Integrations =====
  let integrations = [];
  let selectedIntegrationId = null;

  integrationsBtn.addEventListener('click', () => {
    integrationsOverlay.classList.remove('hidden');
    newTokenBox.classList.add('hidden');
    loadIntegrations();
  });

  integrationsClose.addEventListener('click', closeIntegrationsDialog);
  integrationsOverlay.addEventListener('click', (e) => {
    if (e.target === integrationsOverlay) closeIntegrationsDialog();
  });

  function closeIntegrationsDialog() {
    integrationsOverlay.classList.add('hidden');
    selectedIntegrationId = null;
  }

  integrationForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = integrationName.value.trim();
    const rootFolderName = integrationRoot.value.trim() || name;
    const scopes = Array.from(document.querySelectorAll('input[name="integration-scope"]:checked')).map(el => el.value);
    if (!name || !scopes.length) {
      showToast('请输入应用名称并至少选择一个权限', 'error');
      return;
    }

    try {
      const res = await fetch(`${API}/integrations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name, rootFolderName, scopes, createToken: true }),
      });
      if (res.status === 401) { logout(); return; }
      const data = await res.json();
      if (!res.ok) { showToast(data.message, 'error'); return; }
      integrationForm.reset();
      document.querySelectorAll('input[name="integration-scope"]').forEach(el => {
        el.checked = el.value !== 'files:delete';
      });
      showNewToken(data.token && data.token.token);
      selectedIntegrationId = data.integration.id;
      showToast('接入应用创建成功', 'success');
      await loadIntegrations();
      await loadIntegrationTokens(selectedIntegrationId);
    } catch (err) {
      showToast('创建接入应用失败', 'error');
    }
  });

  copyTokenBtn.addEventListener('click', async () => {
    const value = newTokenValue.textContent.trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      showToast('Token 已复制', 'success');
    } catch (err) {
      showToast('复制失败，请手动复制', 'error');
    }
  });

  async function loadIntegrations() {
    integrationsList.innerHTML = '<div class="tokens-empty">加载中...</div>';
    try {
      const res = await fetch(`${API}/integrations`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) { logout(); return; }
      const data = await res.json();
      if (!res.ok) { showToast(data.message, 'error'); return; }
      integrations = data.integrations || [];
      renderIntegrations();
      if (selectedIntegrationId) loadIntegrationTokens(selectedIntegrationId);
    } catch (err) {
      integrationsList.innerHTML = '<div class="tokens-empty">加载失败</div>';
    }
  }

  function renderIntegrations() {
    if (!integrations.length) {
      integrationsList.innerHTML = '<div class="tokens-empty">暂无接入应用</div>';
      tokensPanel.innerHTML = '<div class="tokens-empty">创建应用后可管理 Token</div>';
      return;
    }

    integrationsList.innerHTML = integrations.map(item => {
      const scopes = formatScopes(item.scopes);
      const active = String(item.id) === String(selectedIntegrationId) ? ' active' : '';
      const enabled = Number(item.enabled) === 1;
      return `
        <div class="integration-item${active}" data-id="${item.id}">
          <div class="integration-main">
            <div class="integration-name">${escapeHtml(item.name)}</div>
            <div class="integration-meta">根目录：${escapeHtml(item.root_folder_name || String(item.root_folder_id))}</div>
            <div class="integration-scopes">${escapeHtml(scopes)}</div>
          </div>
          <div class="integration-actions">
            <span class="integration-status ${enabled ? 'enabled' : 'disabled'}">${enabled ? '启用' : '禁用'}</span>
            <button data-action="toggle" data-id="${item.id}" data-enabled="${enabled ? '1' : '0'}">${enabled ? '禁用' : '启用'}</button>
          </div>
        </div>
      `;
    }).join('');

    integrationsList.querySelectorAll('.integration-item').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        selectedIntegrationId = el.dataset.id;
        renderIntegrations();
        loadIntegrationTokens(selectedIntegrationId);
      });
    });

    integrationsList.querySelectorAll('button[data-action="toggle"]').forEach(btn => {
      btn.addEventListener('click', () => toggleIntegration(btn.dataset.id, btn.dataset.enabled !== '1'));
    });
  }

  async function toggleIntegration(id, enabled) {
    try {
      const res = await fetch(`${API}/integrations/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ enabled }),
      });
      if (res.status === 401) { logout(); return; }
      const data = await res.json();
      if (!res.ok) { showToast(data.message, 'error'); return; }
      showToast(data.message, 'success');
      await loadIntegrations();
    } catch (err) {
      showToast('更新接入应用失败', 'error');
    }
  }

  async function loadIntegrationTokens(integrationId) {
    tokensPanel.innerHTML = '<div class="tokens-empty">加载 Token...</div>';
    try {
      const res = await fetch(`${API}/integrations/${integrationId}/tokens`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) { logout(); return; }
      const data = await res.json();
      if (!res.ok) { showToast(data.message, 'error'); return; }
      renderTokens(integrationId, data.tokens || []);
    } catch (err) {
      tokensPanel.innerHTML = '<div class="tokens-empty">Token 加载失败</div>';
    }
  }

  function renderTokens(integrationId, tokens) {
    const integration = integrations.find(item => String(item.id) === String(integrationId));
    const allowedScopes = parseScopes(integration ? integration.scopes : '');
    const scopeOptions = allowedScopes.map(scope => `
      <label><input type="checkbox" name="token-scope" value="${escapeAttr(scope)}" checked> ${escapeHtml(scopeLabel(scope))}</label>
    `).join('');

    const tokenRows = tokens.length ? tokens.map(item => {
      const revoked = Boolean(item.revoked_at);
      return `
        <div class="token-item">
          <div>
            <div class="token-name">${escapeHtml(item.name)}</div>
            <div class="token-meta">权限：${escapeHtml(formatScopes(item.scopes))}</div>
            <div class="token-meta">创建：${item.created_at || '-'}，最后使用：${item.last_used_at || '-'}</div>
            ${revoked ? '<div class="token-revoked">已撤销</div>' : ''}
          </div>
          <div class="token-actions">
            <button data-action="edit-token" data-id="${item.id}" data-name="${escapeAttr(item.name)}" data-scopes="${escapeAttr(item.scopes)}">编辑</button>
            <button data-action="delete-token" data-id="${item.id}" ${revoked ? 'disabled' : ''}>删除</button>
          </div>
        </div>
      `;
    }).join('') : '<div class="tokens-empty">暂无 Token</div>';

    tokensPanel.innerHTML = `
      <div class="tokens-header">
        <div>
          <div class="tokens-title">${escapeHtml(integration ? integration.name : 'Token')}</div>
          <div class="tokens-subtitle">Token 明文只在创建时显示</div>
        </div>
      </div>
      <form id="token-form" class="token-form">
        <input type="text" id="token-name" placeholder="Token 名称，例如 music-backend" required>
        <div class="scope-row compact">${scopeOptions}</div>
        <button type="submit">创建 Token</button>
      </form>
      <div class="token-list">${tokenRows}</div>
    `;

    const tokenForm = document.getElementById('token-form');
    tokenForm.addEventListener('submit', (e) => createIntegrationToken(e, integrationId));
    tokensPanel.querySelectorAll('button[data-action="edit-token"]').forEach(btn => {
      btn.addEventListener('click', () => editIntegrationToken(integrationId, btn.dataset.id, btn.dataset.name, btn.dataset.scopes));
    });
    tokensPanel.querySelectorAll('button[data-action="delete-token"]').forEach(btn => {
      btn.addEventListener('click', () => deleteIntegrationToken(integrationId, btn.dataset.id));
    });
  }

  async function createIntegrationToken(e, integrationId) {
    e.preventDefault();
    const name = document.getElementById('token-name').value.trim();
    const scopes = Array.from(tokensPanel.querySelectorAll('input[name="token-scope"]:checked')).map(el => el.value);
    if (!name) {
      showToast('API Token 名称不能为空', 'error');
      return;
    }
    if (!scopes.length) {
      showToast('请至少选择一个 Token 权限', 'error');
      return;
    }

    try {
      const res = await fetch(`${API}/integrations/${integrationId}/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name, scopes }),
      });
      if (res.status === 401) { logout(); return; }
      const data = await res.json();
      if (!res.ok) { showToast(data.message, 'error'); return; }
      showNewToken(data.token && data.token.token);
      showToast('Token 创建成功', 'success');
      await loadIntegrationTokens(integrationId);
    } catch (err) {
      showToast('创建 Token 失败', 'error');
    }
  }

  async function editIntegrationToken(integrationId, tokenId, oldName, oldScopes) {
    const name = prompt('请输入新的 API Token 名称：', oldName || '');
    if (!name || !name.trim()) return;

    const integration = integrations.find(item => String(item.id) === String(integrationId));
    const allowedScopes = parseScopes(integration ? integration.scopes : '');
    const currentScopes = new Set(parseScopes(oldScopes));
    const selectedScopes = [];
    for (const scope of allowedScopes) {
      if (confirm(`Token 是否启用权限「${scopeLabel(scope)}」？\n当前：${currentScopes.has(scope) ? '已启用' : '未启用'}`)) {
        selectedScopes.push(scope);
      }
    }
    if (!selectedScopes.length) {
      showToast('API Token 权限不能为空', 'error');
      return;
    }

    try {
      const res = await fetch(`${API}/integrations/${integrationId}/tokens/${tokenId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: name.trim(), scopes: selectedScopes }),
      });
      if (res.status === 401) { logout(); return; }
      const data = await res.json();
      if (!res.ok) { showToast(data.message, 'error'); return; }
      showToast('Token 已更新', 'success');
      await loadIntegrationTokens(integrationId);
    } catch (err) {
      showToast('更新 Token 失败', 'error');
    }
  }

  async function deleteIntegrationToken(integrationId, tokenId) {
    if (!confirm('确定删除这个 API Token 吗？删除后不可恢复。')) return;
    try {
      const res = await fetch(`${API}/integrations/${integrationId}/tokens/${tokenId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) { logout(); return; }
      const data = await res.json();
      if (!res.ok) { showToast(data.message, 'error'); return; }
      showToast('Token 已删除', 'success');
      await loadIntegrationTokens(integrationId);
    } catch (err) {
      showToast('删除 Token 失败', 'error');
    }
  }

  function showNewToken(value) {
    if (!value) return;
    newTokenValue.textContent = value;
    newTokenBox.classList.remove('hidden');
  }

  function parseScopes(scopes) {
    return String(scopes || '').split(',').map(scope => scope.trim()).filter(Boolean);
  }

  function formatScopes(scopes) {
    return parseScopes(scopes).map(scopeLabel).join('、') || '-';
  }

  function scopeLabel(scope) {
    const labels = {
      'files:upload': '上传/建目录',
      'files:read': '读取列表',
      'files:delete': '删除文件',
      'links:create': '创建访问链接',
    };
    return labels[scope] || scope;
  }

  // ===== Preview =====
  function previewFile(md5, name) {
    previewTitle.textContent = name;
    const ext = getExtension(name).toLowerCase();
    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico'];
    const textExts = ['txt', 'md', 'json', 'js', 'ts', 'css', 'html', 'xml', 'yml', 'yaml', 'conf', 'ini', 'sh', 'bat', 'log', 'csv', 'env'];

    if (imageExts.includes(ext)) {
      // 图片需要用 blob URL 展示（因为接口需要 token）
      fetch(`${API}/files/${md5}/download`, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.blob())
        .then(blob => {
          const url = URL.createObjectURL(blob);
          previewContent.innerHTML = `<img src="${url}" alt="${escapeHtml(name)}">`;
        })
        .catch(() => { previewContent.innerHTML = '<div class="no-preview">加载失败</div>'; });
    } else if (textExts.includes(ext)) {
      previewContent.innerHTML = '<div class="no-preview">加载中...</div>';
      fetch(`${API}/files/${md5}/download`, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.text())
        .then(text => { previewContent.innerHTML = `<pre>${escapeHtml(text)}</pre>`; })
        .catch(() => { previewContent.innerHTML = '<div class="no-preview">加载失败</div>'; });
    } else {
      previewContent.innerHTML = '<div class="no-preview">该文件类型不支持预览<br>请下载后查看</div>';
    }
    previewOverlay.classList.remove('hidden');
  }

  previewClose.addEventListener('click', () => {
    previewOverlay.classList.add('hidden');
    previewContent.innerHTML = '';
  });

  previewOverlay.addEventListener('click', (e) => {
    if (e.target === previewOverlay) {
      previewOverlay.classList.add('hidden');
      previewContent.innerHTML = '';
    }
  });

  // ===== MD5 Calculation =====
  async function calculateFileMD5(file) {
    return new Promise((resolve, reject) => {
      const chunkSize = 2 * 1024 * 1024;
      const spark = new SparkMD5.ArrayBuffer();
      const reader = new FileReader();
      let offset = 0;

      reader.onload = (e) => {
        spark.append(e.target.result);
        offset += chunkSize;
        if (offset < file.size) readNext();
        else resolve(spark.end());
      };
      reader.onerror = () => reject(reader.error);

      function readNext() {
        const slice = file.slice(offset, offset + chunkSize);
        reader.readAsArrayBuffer(slice);
      }
      readNext();
    });
  }

  // ===== Upload =====
  fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files);
    if (!files.length) return;

    uploadOverlay.classList.remove('hidden');
    progressFill.style.width = '0%';
    uploadStatus.textContent = '正在计算文件指纹...';

    try {
      const fileInfos = [];
      for (let i = 0; i < files.length; i++) {
        uploadStatus.textContent = `正在计算指纹 (${i + 1}/${files.length})...`;
        progressFill.style.width = Math.round(((i + 1) / files.length) * 30) + '%';
        const md5 = await calculateFileMD5(files[i]);
        fileInfos.push({ file: files[i], md5, originalName: files[i].name });
      }

      uploadStatus.textContent = '正在检查重复文件...';
      progressFill.style.width = '35%';

      const instantRes = await fetch(`${API}/files/instant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          files: fileInfos.map(f => ({ md5: f.md5, originalName: f.originalName })),
          folderId: currentFolderId,
        }),
      });

      if (instantRes.status === 401) { logout(); return; }
      const instantData = await instantRes.json();

      const failedMd5Set = new Set(
        (instantData.results || []).filter(r => !r.success).map(r => r.md5)
      );
      const toUpload = fileInfos.filter(f => failedMd5Set.has(f.md5));

      if (toUpload.length) {
        uploadStatus.textContent = `正在上传 ${toUpload.length} 个新文件...`;
        progressFill.style.width = '40%';

        const formData = new FormData();
        formData.append('folderId', currentFolderId || '');
        for (const f of toUpload) formData.append('files', f.file);

        await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', `${API}/files/upload`);
          xhr.setRequestHeader('Authorization', `Bearer ${token}`);
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              const pct = Math.round(40 + (e.loaded / e.total) * 60);
              progressFill.style.width = pct + '%';
              uploadStatus.textContent = `上传中... ${Math.round((e.loaded / e.total) * 100)}%`;
            }
          };
          xhr.onload = () => {
            if (xhr.status === 200) resolve();
            else if (xhr.status === 401) { logout(); reject(new Error('unauthorized')); }
            else { const d = JSON.parse(xhr.responseText); reject(new Error(d.message || '上传失败')); }
          };
          xhr.onerror = () => reject(new Error('网络错误'));
          xhr.send(formData);
        });
      } else {
        progressFill.style.width = '100%';
        uploadStatus.textContent = '全部秒传完成';
        await new Promise(r => setTimeout(r, 500));
      }

      uploadOverlay.classList.add('hidden');
      fileInput.value = '';
      showToast(`上传完成，共 ${files.length} 个文件`, 'success');
      loadDrive();
    } catch (err) {
      uploadOverlay.classList.add('hidden');
      fileInput.value = '';
      if (err.message !== 'unauthorized') showToast(err.message || '上传失败', 'error');
    }
  });

  // ===== Helpers =====
  function getFileIcon(name) {
    const ext = getExtension(name).toLowerCase();
    const icons = {
      pdf: '📕', doc: '📘', docx: '📘', xls: '📗', xlsx: '📗',
      ppt: '📙', pptx: '📙', zip: '🗜️', rar: '🗜️', '7z': '🗜️',
      png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', webp: '🖼️', svg: '🖼️',
      mp4: '🎬', avi: '🎬', mkv: '🎬', mov: '🎬',
      mp3: '🎵', wav: '🎵', flac: '🎵',
      js: '📜', ts: '📜', py: '📜', java: '📜', c: '📜', cpp: '📜',
      html: '🌐', css: '🎨', json: '📋', xml: '📋',
      txt: '📄', md: '📄', log: '📄',
      exe: '⚙️', msi: '⚙️', dmg: '⚙️',
    };
    return icons[ext] || '📄';
  }

  function getExtension(name) {
    const parts = (name || '').split('.');
    return parts.length > 1 ? parts.pop() : '-';
  }

  function formatSize(bytes) {
    if (!bytes) return '-';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ===== Init =====
  checkRegisterStatus();
  if (token) enterFileManager();
})();
