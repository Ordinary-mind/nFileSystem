import { icon, fileIconName } from '../core/icons.js';
import { escapeHtml, formatSize, getExtension } from '../core/utils.js';
import { openOverlay, openActionSheet, showToast } from '../core/ui.js';
import { requestPublic, requestPublicBlob } from '../core/api.js';
import { mountImageViewer } from '../features/image-viewer.js';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico']);
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'json', 'js', 'ts', 'css', 'html', 'xml', 'yml', 'yaml', 'conf', 'ini', 'sh', 'bat', 'log', 'csv', 'env']);

function stateView(iconName, title, message) {
  return `<div class="share-state">${icon(iconName)}<h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p></div>`;
}

function topbar(expiresAt) {
  const expiry = expiresAt ? `有效期至 ${new Date(expiresAt).toLocaleString('zh-CN', { hour12: false })}` : '永久有效';
  return `
    <header class="share-topbar">
      <div class="share-brand">${icon('files')}<span>nFileSystem</span></div>
      <span class="share-expiry">${escapeHtml(expiry)}</span>
    </header>`;
}

export function mountShareView(root, token) {
  let share = null;
  let activeFolderId = null;
  const encodedToken = encodeURIComponent(token);

  root.innerHTML = `<div class="share-screen" data-share><div class="share-state">${icon('info')}<p>正在加载分享内容</p></div></div>`;
  const screen = root.querySelector('[data-share]');

  function failView(message) {
    screen.innerHTML = `${topbar(null)}${stateView('info', '链接已失效或已过期', message || '请联系分享者重新发送链接')}`;
  }

  function requirePasscodeView(message = '') {
    screen.innerHTML = `
      ${topbar(share?.expiresAt)}
      <form class="share-passcode" data-pass-form>
        <h2>输入提取码</h2>
        <p>${share ? `「${escapeHtml(share.name)}」已开启提取码保护` : '该分享已开启提取码保护'}</p>
        <input class="text-field" data-pass-input maxlength="6" autocomplete="off" inputmode="numeric" required aria-label="提取码">
        <button type="submit" class="primary-button">验证并查看</button>
        <p class="form-message${message ? ' error' : ''}" data-pass-message aria-live="polite">${escapeHtml(message)}</p>
      </form>`;
    const form = screen.querySelector('[data-pass-form]');
    const input = screen.querySelector('[data-pass-input]');
    const messageNode = screen.querySelector('[data-pass-message]');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const passcode = input.value.trim();
      if (!passcode) return;
      messageNode.textContent = '';
      messageNode.className = 'form-message';
      try {
        await requestPublic(`/share/${encodedToken}/verify`, { method: 'POST', body: { passcode } });
        renderContent();
      } catch (error) {
        messageNode.textContent = error.message || '提取码不正确';
        messageNode.className = 'form-message error';
      }
    });
    input.focus();
  }

  async function hasPassSession() {
    const probe = share.itemType === 'file'
      ? `/share/${encodedToken}/file/${share.fileId}`
      : `/share/${encodedToken}/list`;
    try {
      const response = await fetch(probe, { method: 'HEAD' });
      return response.ok;
    } catch {
      return false;
    }
  }

  function fileHref(item, download) {
    return `/share/${encodedToken}/file/${item.id}${download ? '?dl=1' : ''}`;
  }

  function downloadShareFile(item) {
    const link = document.createElement('a');
    link.href = fileHref(item, true);
    link.download = item.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    showToast('已开始下载');
  }

  function previewShareFile(item) {
    const ext = getExtension(item.name).toLowerCase();
    const panel = openOverlay({
      title: item.name,
      content: `<div class="share-state">${icon('info')}<p>正在加载文件</p></div>`,
      variant: 'full',
      onClose: () => {
        if (panel.revoke) panel.revoke();
      },
    });
    const body = panel.overlay.querySelector('.overlay-body');
    requestPublicBlob(fileHref(item)).then(async (blob) => {
      if (!panel.overlay.isConnected) return;
      if (IMAGE_EXTENSIONS.has(ext)) {
        const previewBlob = ext === 'svg' && blob.type !== 'image/svg+xml'
          ? new Blob([blob], { type: 'image/svg+xml' })
          : blob;
        const objectUrl = URL.createObjectURL(previewBlob);
        panel.revoke = () => {
          URL.revokeObjectURL(objectUrl);
          panel.destroyViewer?.();
        };
        body.classList.add('image-preview-body');
        panel.destroyViewer = mountImageViewer(body, objectUrl, item.name);
      } else if (TEXT_EXTENSIONS.has(ext)) {
        body.innerHTML = `<pre class="text-preview">${escapeHtml(await blob.text())}</pre>`;
      } else {
        body.innerHTML = `<div class="share-state">${icon('file')}<h2>暂不支持预览</h2><button type="button" class="primary-button" data-download>下载文件</button></div>`;
        body.querySelector('[data-download]').addEventListener('click', () => downloadShareFile(item));
      }
    }).catch((error) => {
      if (!panel.overlay.isConnected) return;
      if (error.status === 401) requirePasscodeView('提取码验证已过期，请重新输入');
      else body.innerHTML = stateView('info', '加载失败', error.message || '文件加载失败');
    });
  }

  function fileRow(item, withThumb) {
    const ext = getExtension(item.name).toLowerCase();
    const previewable = IMAGE_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(ext);
    const thumb = withThumb && item.image
      ? `<img class="share-thumb" loading="lazy" src="/share/${encodedToken}/thumb/${item.id}" alt="" draggable="false">`
      : '';
    const symbol = thumb ? `<span class="file-symbol has-thumbnail">${thumb}</span>`
      : `<span class="file-symbol">${icon(fileIconName(item.name))}</span>`;
    return `
      <article class="drive-row share-row" data-share-file="${item.id}">
        <button type="button" class="drive-main" data-share-open="${item.id}">
          ${symbol}
          <span class="drive-text"><strong>${escapeHtml(item.name)}</strong><small>${formatSize(item.size)}</small></span>
        </button>
      </article>`;
  }

  function folderRow(item) {
    return `
      <article class="drive-row share-row">
        <button type="button" class="drive-main" data-share-folder="${item.id}">
          <span class="file-symbol folder-symbol">${icon('folder')}</span>
          <span class="drive-text"><strong>${escapeHtml(item.name)}</strong><small>文件夹</small></span>
        </button>
      </article>`;
  }

  function renderBreadcrumb(crumbs) {
    return `
      <nav class="breadcrumb-strip share-breadcrumb" aria-label="分享目录">
        ${crumbs.map((crumb, index) => `
          ${index ? '<span class="breadcrumb-separator">/</span>' : ''}
          <button type="button" data-share-crumb="${crumb.id ?? ''}">${index === 0 ? icon('folder') : ''}<span>${escapeHtml(crumb.name)}</span></button>`).join('')}
      </nav>`;
  }

  async function loadFolder(folderId) {
    activeFolderId = folderId;
    const list = screen.querySelector('[data-share-body]');
    list.innerHTML = `<div class="share-state">${icon('info')}<p>正在加载</p></div>`;
    try {
      const params = folderId === null ? '' : `?folderId=${encodeURIComponent(folderId)}`;
      const data = await requestPublic(`/share/${encodedToken}/list${params}`);
      const listHtml = data.folders.length || data.files.length
        ? `<div class="share-list">${data.folders.map(folderRow).join('')}${data.files.map((item) => fileRow(item, true)).join('')}</div>`
        : stateView('folder', '空文件夹', '这里没有可查看的内容');
      list.innerHTML = `${renderBreadcrumb(data.breadcrumb)}${listHtml}`;
      list.querySelectorAll('[data-share-folder]').forEach((button) => button.addEventListener('click', () => loadFolder(button.dataset.shareFolder || null)));
      list.querySelectorAll('[data-share-crumb]').forEach((button) => button.addEventListener('click', () => loadFolder(button.dataset.shareCrumb || null)));
      list.querySelectorAll('[data-share-open]').forEach((button) => button.addEventListener('click', () => {
        const item = data.files.find((entry) => String(entry.id) === button.dataset.shareOpen);
        if (!item) return;
        const ext = getExtension(item.name).toLowerCase();
        const previewable = IMAGE_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(ext);
        openActionSheet(item.name, [
          ...(previewable ? [{ label: '在线查看', icon: 'eye', run: () => previewShareFile(item) }] : []),
          { label: '下载文件', icon: 'download', run: () => downloadShareFile(item) },
        ]);
      }));
      // 缩略图加载失败时回退为文件图标，避免破图。
      list.addEventListener('error', (event) => {
        const image = event.target;
        if (!(image instanceof HTMLImageElement)) return;
        const symbol = image.closest('.file-symbol');
        if (symbol) symbol.innerHTML = icon('image');
      }, true);
    } catch (error) {
      if (error.status === 401) return requirePasscodeView('提取码验证已过期，请重新输入');
      list.innerHTML = stateView('info', '加载失败', error.message || '分享内容加载失败');
    }
  }

  function renderContent() {
    screen.innerHTML = `
      ${topbar(share.expiresAt)}
      <div data-share-body></div>`;
    const body = screen.querySelector('[data-share-body]');
    if (share.itemType === 'file') {
      const ext = getExtension(share.name).toLowerCase();
      const previewable = IMAGE_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(ext);
      const inlinePreview = IMAGE_EXTENSIONS.has(ext)
        ? `<img class="share-image" src="${fileHref({ id: share.fileId, name: share.name })}" alt="${escapeHtml(share.name)}" draggable="false">`
        : '';
      body.innerHTML = `
        <div class="share-file-card">
          ${inlinePreview || `<span class="share-file-symbol">${icon(IMAGE_EXTENSIONS.has(ext) ? 'image' : fileIconName(share.name))}</span>`}
          <h2>${escapeHtml(share.name)}</h2>
          <p>${formatSize(share.size)}</p>
          <div class="share-actions">
            ${previewable ? '<button type="button" class="secondary-button" data-view>在线查看</button>' : ''}
            <a class="primary-button" href="${fileHref({ id: share.fileId, name: share.name }, true)}" download="${escapeHtml(share.name)}">下载文件</a>
          </div>
        </div>`;
      body.querySelector('[data-view]')?.addEventListener('click', () => previewShareFile({ id: share.fileId, name: share.name, size: share.size }));
      const image = body.querySelector('.share-image');
      image?.addEventListener('click', () => previewShareFile({ id: share.fileId, name: share.name, size: share.size }));
      return;
    }
    loadFolder(null);
  }

  async function boot() {
    try {
      share = await requestPublic(`/share/${encodedToken}`);
    } catch (error) {
      return failView(error.message);
    }
    if (share.requiresPasscode && !(await hasPassSession())) {
      requirePasscodeView();
      return;
    }
    renderContent();
  }

  boot();
}
