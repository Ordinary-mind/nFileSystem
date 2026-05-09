(() => {
  'use strict';

  const API = '';
  let token = localStorage.getItem('token') || '';
  let userName = localStorage.getItem('userName') || '';

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
  const uploadOverlay = document.getElementById('upload-overlay');
  const progressFill = document.getElementById('progress-fill');
  const uploadStatus = document.getElementById('upload-status');
  const previewOverlay = document.getElementById('preview-overlay');
  const previewTitle = document.getElementById('preview-title');
  const previewContent = document.getElementById('preview-content');
  const previewClose = document.getElementById('preview-close');

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

  // ===== Check register status =====
  async function checkRegisterStatus() {
    try {
      const res = await fetch(`${API}/auth/register-status`);
      const data = await res.json();
      if (!data.allowed) {
        registerTab.style.display = 'none';
      }
    } catch (e) {
      // ignore
    }
  }

  // ===== Auth =====
  function showMessage(text, type) {
    authMessage.textContent = text;
    authMessage.className = 'message ' + type;
  }

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
      if (!res.ok) {
        showMessage(data.message, 'error');
        return;
      }
      token = data.token;
      userName = data.user.name;
      localStorage.setItem('token', token);
      localStorage.setItem('userName', userName);
      enterFileManager();
    } catch (err) {
      showMessage('网络错误', 'error');
    }
  });

  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('reg-name').value.trim();
    const password = document.getElementById('reg-password').value;
    const password2 = document.getElementById('reg-password2').value;

    if (password !== password2) {
      showMessage('两次密码不一致', 'error');
      return;
    }
    if (password.length < 4) {
      showMessage('密码至少 4 位', 'error');
      return;
    }

    try {
      const res = await fetch(`${API}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        showMessage(data.message, 'error');
        return;
      }
      showMessage('注册成功，请登录', 'success');
      // Switch to login tab
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
    loadFiles();
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

  // ===== Load Files =====
  let searchTimer = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadFiles(searchInput.value.trim()), 300);
  });

  async function loadFiles(search) {
    try {
      let url = `${API}/files`;
      if (search) url += `?name=${encodeURIComponent(search)}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) { logout(); return; }
      const data = await res.json();
      renderFiles(data.files || []);
    } catch (err) {
      fileList.innerHTML = '<div class="empty-state"><div class="icon">⚠️</div>加载失败</div>';
    }
  }

  function renderFiles(files) {
    if (!files.length) {
      fileList.innerHTML = '<div class="empty-state"><div class="icon">📂</div>暂无文件，点击上方上传</div>';
      return;
    }

    fileList.innerHTML = files.map(f => `
      <div class="file-item">
        <div class="col-name">
          <span class="file-icon">${getFileIcon(f.original_name)}</span>
          <span class="file-name" title="${escapeHtml(f.original_name)}">${escapeHtml(f.original_name)}</span>
        </div>
        <div class="col-size">${formatSize(f.size)}</div>
        <div class="col-type">${getExtension(f.original_name)}</div>
        <div class="col-date">${f.created_at || '-'}</div>
        <div class="col-action">
          <button class="btn-action" onclick="window._preview('${f.md5}', '${escapeHtml(f.original_name)}')">查看</button>
          <button class="btn-action download" onclick="window._download('${f.md5}')">下载</button>
        </div>
      </div>
    `).join('');
  }

  // ===== Upload =====
  fileInput.addEventListener('change', async () => {
    const files = fileInput.files;
    if (!files.length) return;

    uploadOverlay.classList.remove('hidden');
    progressFill.style.width = '0%';
    uploadStatus.textContent = `正在上传 ${files.length} 个文件...`;

    const formData = new FormData();
    for (const f of files) {
      formData.append('files', f);
    }

    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API}/files/upload`);
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          progressFill.style.width = pct + '%';
          uploadStatus.textContent = `上传中... ${pct}%`;
        }
      };

      xhr.onload = () => {
        uploadOverlay.classList.add('hidden');
        fileInput.value = '';
        if (xhr.status === 200) {
          loadFiles();
        } else if (xhr.status === 401) {
          logout();
        } else {
          const data = JSON.parse(xhr.responseText);
          alert(data.message || '上传失败');
        }
      };

      xhr.onerror = () => {
        uploadOverlay.classList.add('hidden');
        fileInput.value = '';
        alert('网络错误');
      };

      xhr.send(formData);
    } catch (err) {
      uploadOverlay.classList.add('hidden');
      fileInput.value = '';
      alert('上传失败');
    }
  });

  // ===== Download =====
  window._download = function(md5) {
    const a = document.createElement('a');
    a.href = `${API}/files/${md5}/download`;
    a.click();
  };

  // ===== Preview =====
  window._preview = async function(md5, name) {
    previewTitle.textContent = name;
    const ext = getExtension(name).toLowerCase();
    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico'];
    const textExts = ['txt', 'md', 'json', 'js', 'ts', 'css', 'html', 'xml', 'yml', 'yaml', 'conf', 'ini', 'sh', 'bat', 'log', 'csv', 'env'];

    if (imageExts.includes(ext)) {
      previewContent.innerHTML = `<img src="${API}/files/${md5}/download" alt="${escapeHtml(name)}">`;
    } else if (textExts.includes(ext)) {
      try {
        const res = await fetch(`${API}/files/${md5}/download`);
        const text = await res.text();
        previewContent.innerHTML = `<pre>${escapeHtml(text)}</pre>`;
      } catch {
        previewContent.innerHTML = '<div class="no-preview">加载失败</div>';
      }
    } else {
      previewContent.innerHTML = '<div class="no-preview">该文件类型不支持预览<br>请下载后查看</div>';
    }

    previewOverlay.classList.remove('hidden');
  };

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

  // ===== Init =====
  checkRegisterStatus();
  if (token) {
    enterFileManager();
  }
})();
