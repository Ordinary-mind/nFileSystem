import { request, requestBlob } from '../core/api.js';
import { fileIconName, icon } from '../core/icons.js';
import { escapeHtml, formatDate, formatSize, getExtension, hasPressMoved, selectionKey } from '../core/utils.js';
import { confirmDialog, errorView, loadingView, openActionSheet, openOverlay, promptText, showToast } from '../core/ui.js';
import { uploadFiles } from '../features/upload.js';
import { mountImageViewer } from '../features/image-viewer.js';

const TEXT_EXTENSIONS = new Set(['txt', 'md', 'json', 'js', 'ts', 'css', 'html', 'xml', 'yml', 'yaml', 'conf', 'ini', 'sh', 'bat', 'log', 'csv', 'env']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico']);

export function mountDrive(root, folderId, navigate, route = {}) {
  let folders = [];
  let files = [];
  let offset = 0;
  let search = String(route.search || '');
  let searchScope = route.scope === 'current' ? 'current' : 'all';
  let searchCursor = null;
  let searchResults = [];
  let hasMore = false;
  let requestId = 0;
  const currentFolderId = folderId || null;
  const selected = new Map();
  let longPressTimer = null;
  let longPressRow = null;
  let longPressStart = null;
  let suppressClickUntil = 0;
  const routeKey = window.location.hash;
  const cachedState = JSON.parse(sessionStorage.getItem(`drive:${routeKey}`) || 'null');

  root.innerHTML = `
    <div class="top-bar ${currentFolderId ? '' : 'no-back'}" data-normal-bar>
      ${currentFolderId ? `<button type="button" class="icon-button" data-back aria-label="返回上级">${icon('back')}</button>` : ''}
      <div><h1 data-title>${currentFolderId ? '文件夹' : '我的文件'}</h1><div class="top-bar-subtitle" data-summary>正在加载</div></div>
      <button type="button" class="icon-button" data-search-toggle aria-label="搜索">${icon('search')}</button>
    </div>
    <div class="top-bar selection-bar hidden" data-selection-bar>
      <button type="button" class="icon-button" data-selection-cancel aria-label="取消选择">${icon('close')}</button>
      <div><h1 data-selection-summary>已选择 0 项</h1><div class="top-bar-subtitle">长按或点按选择项目</div></div>
      <button type="button" class="icon-button danger-icon" data-selection-delete aria-label="删除选中项">${icon('trash')}</button>
    </div>
    <div class="search-panel ${search ? '' : 'hidden'}" data-search-panel>
      ${icon('search')}<input type="search" value="${escapeHtml(search)}" placeholder="搜索全部文件" aria-label="搜索文件"><select aria-label="搜索范围"><option value="all" ${searchScope === 'all' ? 'selected' : ''}>全部</option><option value="current" ${searchScope === 'current' ? 'selected' : ''}>当前目录</option></select><button type="button" data-clear>关闭</button>
    </div>
    <div class="breadcrumb-strip" data-breadcrumb></div>
    <div class="drive-list" data-list>${loadingView()}</div>
    <button type="button" class="fab" data-create aria-label="新建或上传">${icon('plus')}</button>
    <input type="file" multiple class="hidden" data-file-input>`;

  const list = root.querySelector('[data-list]');
  const title = root.querySelector('[data-title]');
  const summary = root.querySelector('[data-summary]');
  const breadcrumb = root.querySelector('[data-breadcrumb]');
  const searchPanel = root.querySelector('[data-search-panel]');
  const searchInput = searchPanel.querySelector('input');
  const searchSelect = searchPanel.querySelector('select');
  const fileInput = root.querySelector('[data-file-input]');
  const normalBar = root.querySelector('[data-normal-bar]');
  const selectionBar = root.querySelector('[data-selection-bar]');
  const selectionSummary = root.querySelector('[data-selection-summary]');
  const selectionDelete = root.querySelector('[data-selection-delete]');
  const selectionCancel = root.querySelector('[data-selection-cancel]');
  const createButton = root.querySelector('[data-create]');

  function goFolder(id) {
    sessionStorage.setItem(`drive:${window.location.hash}`, JSON.stringify({
      folders, files, searchResults, offset, searchCursor, hasMore, scrollY: window.scrollY,
    }));
    navigate(id ? `files/${id}` : 'files');
  }

  function renderBreadcrumb(items) {
    const crumbs = [{ id: '', name: '根目录' }, ...(items || [])];
    breadcrumb.innerHTML = crumbs.map((item, index) => `
      ${index ? '<span class="breadcrumb-separator">/</span>' : ''}
      <button type="button" data-id="${item.id}">${index === 0 ? icon('home') : ''}<span>${escapeHtml(item.name)}</span></button>`).join('');
    breadcrumb.classList.toggle('hidden', !currentFolderId);
    breadcrumb.querySelectorAll('[data-id]').forEach((button) => button.addEventListener('click', () => goFolder(button.dataset.id)));
    const last = crumbs[crumbs.length - 1];
    title.textContent = last.name;
    const parent = crumbs.length > 1 ? crumbs[crumbs.length - 2] : null;
    const back = root.querySelector('[data-back]');
    if (back) back.onclick = () => goFolder(parent ? parent.id : '');
  }

  function renderList() {
    if (search) {
      summary.textContent = `找到 ${searchResults.length} 项`;
      if (!searchResults.length && !hasMore) {
        list.innerHTML = `<div class="empty-drive">${icon('search')}<h2>没有匹配项</h2><p>尝试其他关键词</p></div>`;
        return;
      }
      list.innerHTML = `${searchResults.map((item) => rowTemplate(item)).join('')}${hasMore ? '<button type="button" class="load-more-button" data-load-more>加载更多</button>' : ''}`;
      list.querySelector('[data-load-more]')?.addEventListener('click', (event) => { event.currentTarget.disabled = true; load(true); });
      mountThumbnails();
      return;
    }
    summary.textContent = `${folders.length} 个文件夹，${files.length} 个文件`;
    if (!folders.length && !files.length && !hasMore) {
      list.innerHTML = `<div class="empty-drive">${icon('folder')}<h2>${search ? '没有匹配项' : '这里还没有文件'}</h2><p>${search ? '尝试其他关键词' : '点击右下角添加内容'}</p></div>`;
      return;
    }
    const folderRows = folders.map((item) => rowTemplate({ ...item, type: 'folder' })).join('');
    const fileRows = files.map((item) => rowTemplate({ ...item, type: 'file' })).join('');
    list.innerHTML = `${folderRows}${fileRows}${hasMore ? '<button type="button" class="load-more-button" data-load-more>加载更多</button>' : ''}`;
    mountThumbnails();
    list.querySelector('[data-load-more]')?.addEventListener('click', (event) => {
      event.currentTarget.disabled = true;
      load(true);
    });
  }

  function rowTemplate(item) {
    const isFolder = item.type === 'folder';
    const meta = search
      ? `${isFolder ? '文件夹' : formatSize(item.size)} · ${escapeHtml(item.path || '/')}`
      : (isFolder ? `文件夹 · ${formatDate(item.created_at)}` : `${formatSize(item.size)} · ${escapeHtml(getExtension(item.name).toUpperCase() || '文件')} · ${formatDate(item.created_at)}`);
    const thumbnail = !isFolder && /^image\/(jpeg|png|webp|gif|avif)$/i.test(item.mime_type || '')
      ? ` data-thumbnail="${escapeHtml(item.md5)}"` : '';
    return `
      <article class="drive-row ${selected.has(selectionKey(item)) ? 'selected' : ''}" data-type="${item.type}" data-id="${item.id}" data-name="${escapeHtml(item.name)}" data-md5="${escapeHtml(item.md5 || '')}" data-mime-type="${escapeHtml(item.mime_type || '')}">
        <button type="button" class="drive-main" data-open>
          <span class="file-symbol ${isFolder ? 'folder-symbol' : ''}"${thumbnail}>${icon(isFolder ? 'folder' : fileIconName(item.name))}</span>
          <span class="drive-text"><strong>${escapeHtml(item.name)}</strong><small>${meta}</small></span>
        </button>
        <span class="selection-indicator" aria-hidden="true">${icon('check')}</span>
        <button type="button" class="icon-button more-button" data-more aria-label="更多操作">${icon('more')}</button>
      </article>`;
  }

  function mountThumbnails() {
    if (!('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver((entries) => {
      entries.filter((entry) => entry.isIntersecting).forEach(async (entry) => {
        const symbol = entry.target;
        observer.unobserve(symbol);
        const controller = new AbortController();
        try {
          const blob = await requestBlob(`/files/${symbol.dataset.thumbnail}/thumbnail`, { signal: controller.signal });
          if (!symbol.isConnected) return;
          const url = URL.createObjectURL(blob);
          const image = new Image();
          image.alt = '';
          image.onload = () => URL.revokeObjectURL(url);
          image.onerror = () => URL.revokeObjectURL(url);
          image.src = url;
          symbol.replaceChildren(image);
          symbol.classList.add('has-thumbnail');
        } catch {
          // 不支持或损坏的图片保留原文件图标。
        }
      });
    }, { rootMargin: '240px 0px' });
    list.querySelectorAll('[data-thumbnail]').forEach((node) => observer.observe(node));
  }

  function updateSelectionView() {
    const active = selected.size > 0;
    normalBar.classList.toggle('hidden', active);
    selectionBar.classList.toggle('hidden', !active);
    createButton.classList.toggle('hidden', active);
    if (active) searchPanel.classList.add('hidden');
    list.classList.toggle('selection-active', active);
    selectionSummary.textContent = `已选择 ${selected.size} 项`;
    list.querySelectorAll('.drive-row').forEach((row) => {
      const isSelected = selected.has(selectionKey(row.dataset));
      row.classList.toggle('selected', isSelected);
      const openButton = row.querySelector('[data-open]');
      if (active) openButton.setAttribute('aria-pressed', String(isSelected));
      else openButton.removeAttribute('aria-pressed');
    });
  }

  function toggleSelection(item) {
    const key = selectionKey(item);
    if (selected.has(key)) selected.delete(key);
    else selected.set(key, item);
    updateSelectionView();
  }

  function clearSelection() {
    selected.clear();
    updateSelectionView();
  }

  async function load(append = false, preserveDisplay = false) {
    if (search) return loadSearch(append);
    if (!append) {
      offset = 0;
      if (!preserveDisplay) {
        folders = [];
        files = [];
        list.innerHTML = loadingView();
      }
    }
    const activeRequest = ++requestId;
    const params = new URLSearchParams({ offset: String(offset) });
    if (currentFolderId) params.set('folderId', currentFolderId);
    if (search) params.set('name', search);
    try {
      const data = await request(`/drive?${params}`);
      if (activeRequest !== requestId) return;
      folders = append ? folders.concat(data.folders || []) : (data.folders || []);
      files = append ? files.concat(data.files || []) : (data.files || []);
      offset += (data.page && data.page.limit) || 200;
      hasMore = Boolean(data.page && data.page.hasMore);
      renderBreadcrumb(data.breadcrumb || []);
      renderList();
    } catch (error) {
      if (activeRequest === requestId) list.innerHTML = errorView(error.message || '加载失败');
    }
  }

  async function loadSearch(append = false) {
    if (!append) {
      searchResults = [];
      searchCursor = null;
      list.innerHTML = loadingView();
    }
    const activeRequest = ++requestId;
    const params = new URLSearchParams({ q: search, scope: searchScope, limit: '50' });
    if (currentFolderId) params.set('folderId', currentFolderId);
    if (searchCursor) params.set('cursor', searchCursor);
    try {
      const data = await request(`/drive/search?${params}`);
      if (activeRequest !== requestId) return;
      searchResults = append ? searchResults.concat(data.results || []) : (data.results || []);
      searchCursor = data.page?.nextCursor || null;
      hasMore = Boolean(searchCursor);
      breadcrumb.classList.add('hidden');
      title.textContent = '搜索';
      renderList();
    } catch (error) {
      if (activeRequest === requestId) list.innerHTML = errorView(error.message || '搜索失败');
    }
  }

  async function createFolder() {
    const name = await promptText({ title: '新建文件夹', label: '文件夹名称', submitLabel: '创建' });
    if (!name) return;
    try {
      await request('/drive/folder', { method: 'POST', body: { name, parentId: currentFolderId } });
      showToast('文件夹创建成功');
      load();
    } catch (error) { showToast(error.message, 'error'); }
  }

  async function renameItem(item) {
    let name;
    if (item.type === 'file') {
      name = await promptFileName(item.name);
    } else {
      name = await promptText({ title: '重命名文件夹', label: '新名称', value: item.name, submitLabel: '保存' });
    }
    if (!name || name === item.name) return;
    try {
      await request(`/drive/${item.type}/${item.id}`, { method: 'PUT', body: { name } });
      showToast('重命名成功');
      load();
    } catch (error) { showToast(error.message, 'error'); }
  }

  function promptFileName(originalName) {
    return new Promise((resolve) => {
      const lastDot = originalName.lastIndexOf('.');
      const hasExtension = lastDot > 0 && lastDot < originalName.length - 1;
      const baseName = hasExtension ? originalName.slice(0, lastDot) : originalName;
      const extension = hasExtension ? originalName.slice(lastDot) : '';
      const panel = openOverlay({
        title: '重命名文件',
        content: `
          <form class="dialog-form" data-rename-form>
            <label class="field-label" for="rename-base">文件名</label>
            <div class="filename-field">
              <input id="rename-base" class="text-field" name="base" value="${escapeHtml(baseName)}" autocomplete="off" required>
              ${extension ? `<span data-extension>${escapeHtml(extension)}</span>` : ''}
            </div>
            ${extension ? '<button type="button" class="text-button filename-extension-toggle" data-edit-extension>修改扩展名</button>' : ''}
            <p class="field-hint">扩展名决定文件类型，默认保持不变。</p>
          </form>`,
        submitLabel: '保存',
        onClose: () => resolve(null),
        onSubmit: ({ overlay, close }) => {
          const base = overlay.querySelector('[name="base"]').value.trim();
          const enteredExtension = overlay.querySelector('[name="extension"]')?.value.trim();
          const suffix = enteredExtension === undefined || enteredExtension === ''
            ? (enteredExtension === undefined ? extension : '')
            : (enteredExtension.startsWith('.') ? enteredExtension : `.${enteredExtension}`);
          if (!base) return overlay.querySelector('[name="base"]').focus();
          close(false);
          resolve(`${base}${suffix}`);
        },
      });
      const submit = () => panel.overlay.querySelector('[data-submit]').click();
      panel.overlay.querySelector('[data-rename-form]').addEventListener('submit', (event) => { event.preventDefault(); submit(); });
      panel.overlay.querySelector('[data-edit-extension]')?.addEventListener('click', (event) => {
        const wrapper = panel.overlay.querySelector('.filename-field');
        wrapper.querySelector('[data-extension]').outerHTML = `<input class="text-field filename-extension-input" name="extension" value="${escapeHtml(extension)}" aria-label="扩展名">`;
        event.currentTarget.remove();
        wrapper.querySelector('[name="extension"]').focus();
      });
    });
  }

  async function deleteItem(item) {
    const accepted = await confirmDialog({
      title: `删除${item.type === 'folder' ? '文件夹' : '文件'}`,
      message: item.type === 'folder' ? '文件夹内的所有内容也会被删除，此操作无法撤销。' : '此文件将从当前账户中删除，此操作无法撤销。',
      confirmLabel: '删除', danger: true,
    });
    if (!accepted) return;
    try {
      await request(`/drive/${item.type}/${item.id}`, { method: 'DELETE' });
      showToast('删除成功');
      load();
    } catch (error) { showToast(error.message, 'error'); }
  }

  async function deleteSelected() {
    const items = Array.from(selected.values());
    if (!items.length) return;
    const folderCount = items.filter((item) => item.type === 'folder').length;
    const accepted = await confirmDialog({
      title: `删除 ${items.length} 项`,
      message: folderCount ? `包含 ${folderCount} 个文件夹，文件夹内的所有内容也会被删除，此操作无法撤销。` : '选中的文件将从当前账户中删除，此操作无法撤销。',
      confirmLabel: '全部删除', danger: true,
    });
    if (!accepted) return;
    selectionDelete.disabled = true;
    let deleted = 0;
    let failed = 0;
    try {
      for (const item of items) {
        selectionSummary.textContent = `正在删除 ${deleted + failed + 1}/${items.length}`;
        try {
          await request(`/drive/${item.type}/${item.id}`, { method: 'DELETE' });
          deleted++;
        } catch {
          failed++;
        }
      }
      clearSelection();
      await load();
      if (failed) showToast(`已删除 ${deleted} 项，${failed} 项删除失败`, 'error');
      else showToast(`已删除 ${deleted} 项`);
    } finally {
      selectionDelete.disabled = false;
    }
  }

  async function downloadFile(item) {
    try {
      const blob = await requestBlob(`/files/${item.md5}/download?name=${encodeURIComponent(item.name)}`);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = item.name;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { showToast(error.message, 'error'); }
  }

  async function previewFile(item) {
    const ext = getExtension(item.name).toLowerCase();
    let objectUrl = '';
    let destroyViewer = () => {};
    const panel = openOverlay({
      title: item.name,
      content: loadingView('正在加载文件'),
      variant: 'full',
      onClose: () => {
        destroyViewer();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        if (window.history.state?.drivePreview) window.history.back();
      },
    });
    const previewState = { ...(window.history.state || {}), drivePreview: true };
    window.history.pushState(previewState, '', window.location.href);
    const onPopState = () => {
      panel.close();
    };
    window.addEventListener('popstate', onPopState, { once: true });
    const body = panel.overlay.querySelector('.overlay-body');
    try {
      const blob = await requestBlob(`/files/${item.md5}/download`);
      if (!panel.overlay.isConnected) return;
      if (IMAGE_EXTENSIONS.has(ext)) {
        const previewBlob = ext === 'svg' && blob.type !== 'image/svg+xml'
          ? new Blob([blob], { type: 'image/svg+xml' })
          : blob;
        objectUrl = URL.createObjectURL(previewBlob);
        body.classList.add('image-preview-body');
        destroyViewer = mountImageViewer(body, objectUrl, item.name);
      } else if (TEXT_EXTENSIONS.has(ext)) {
        body.innerHTML = `<pre class="text-preview">${escapeHtml(await blob.text())}</pre>`;
      } else {
        body.innerHTML = `<div class="empty-drive">${icon('file')}<h2>暂不支持预览</h2><button type="button" class="primary-button" data-download>下载文件</button></div>`;
        body.querySelector('[data-download]').addEventListener('click', () => downloadFile(item));
      }
    } catch (error) { body.innerHTML = errorView(error.message); }
  }

  function openItemActions(item) {
    const actions = item.type === 'folder'
      ? [
          { label: '打开', icon: 'folder', run: () => goFolder(item.id) },
          { label: '重命名', icon: 'edit', run: () => renameItem(item) },
          { label: '移动到', icon: 'move', run: () => openMove(item) },
          { label: '多选', icon: 'check', run: () => toggleSelection(item) },
          { label: '删除', icon: 'trash', danger: true, run: () => deleteItem(item) },
        ]
      : [
          { label: '预览', icon: 'eye', run: () => previewFile(item) },
          { label: '下载', icon: 'download', run: () => downloadFile(item) },
          { label: '重命名', icon: 'edit', run: () => renameItem(item) },
          { label: '移动到', icon: 'move', run: () => openMove(item) },
          { label: '多选', icon: 'check', run: () => toggleSelection(item) },
          { label: '删除', icon: 'trash', danger: true, run: () => deleteItem(item) },
        ];
    openActionSheet(item.name, actions);
  }

  function openMove(item) {
    let targetFolderId = null;
    let targetPath = '根目录';
    let folderLoaded = false;
    const panel = openOverlay({
      title: '移动到', variant: 'full', submitLabel: '移动到此处', content: `<div data-move-breadcrumb></div><div data-move-list>${loadingView()}</div>`,
      onSubmit: async ({ close }) => {
        if (!folderLoaded) return;
        const submitButton = panel.overlay.querySelector('[data-submit]');
        submitButton.disabled = true;
        try {
          await request('/drive/move', { method: 'POST', body: { type: item.type, id: item.id, targetFolderId } });
          close();
          showToast(`已移动到${targetPath}`);
          load();
        } catch (error) {
          showToast(error.message, 'error');
          submitButton.disabled = !folderLoaded;
        }
      },
    });
    const moveList = panel.overlay.querySelector('[data-move-list]');
    const moveBreadcrumb = panel.overlay.querySelector('[data-move-breadcrumb]');
    const moveSubmit = panel.overlay.querySelector('[data-submit]');
    moveSubmit.disabled = true;
    async function loadFolders() {
      folderLoaded = false;
      moveSubmit.disabled = true;
      moveList.innerHTML = loadingView();
      const params = new URLSearchParams({ limit: '500' });
      if (targetFolderId) params.set('folderId', targetFolderId);
      try {
        const data = await request(`/drive?${params}`);
        const crumbs = [{ id: '', name: '根目录' }, ...(data.breadcrumb || [])];
        targetPath = crumbs.map((crumb) => crumb.name).join(' / ');
        moveBreadcrumb.className = 'breadcrumb-strip move-breadcrumb';
        moveBreadcrumb.innerHTML = crumbs.map((crumb) => `<button type="button" data-id="${crumb.id}">${escapeHtml(crumb.name)}</button>`).join('<span>/</span>');
        moveBreadcrumb.querySelectorAll('[data-id]').forEach((button) => button.addEventListener('click', () => { targetFolderId = button.dataset.id || null; loadFolders(); }));
        const available = (data.folders || []).filter((folder) => !(item.type === 'folder' && String(folder.id) === String(item.id)));
        moveList.innerHTML = available.length ? available.map((folder) => `<button type="button" class="move-folder-row" data-id="${folder.id}">${icon('folder')}<span>${escapeHtml(folder.name)}</span>${icon('chevron')}</button>`).join('') : '<div class="state-view"><p>此处没有子文件夹</p></div>';
        moveList.querySelectorAll('.move-folder-row').forEach((button) => button.addEventListener('click', () => { targetFolderId = button.dataset.id; loadFolders(); }));
        folderLoaded = true;
        moveSubmit.disabled = false;
      } catch (error) {
        moveList.innerHTML = `${errorView(error.message)}<button type="button" class="secondary-button move-retry" data-retry>重新加载</button>`;
        moveList.querySelector('[data-retry]').addEventListener('click', loadFolders);
      }
    }
    loadFolders();
  }

  function showUploadProgress() {
    return openOverlay({
      title: '上传文件',
      content: '<div class="upload-progress"><div class="progress-track"><div class="progress-value" data-progress></div></div><p data-progress-label>准备中</p></div>',
      variant: 'sheet',
      dismissible: false,
    });
  }

  async function handleFiles(selectedFiles) {
    if (!selectedFiles.length) return;
    const panel = showUploadProgress();
    panel.overlay.querySelector('[data-close]').disabled = true;
    try {
      const result = await uploadFiles(selectedFiles, currentFolderId, ({ percent, label }) => {
        panel.overlay.querySelector('[data-progress]').style.width = `${percent}%`;
        panel.overlay.querySelector('[data-progress-label]').textContent = label;
      });
      await new Promise((resolve) => window.setTimeout(resolve, 350));
      panel.close();
      showToast(`已处理 ${result.count} 个文件`);
      load();
    } catch (error) {
      panel.close();
      showToast(error.message || '上传失败', 'error');
    } finally { fileInput.value = ''; }
  }

  list.addEventListener('click', (event) => {
    if (Date.now() < suppressClickUntil) {
      event.preventDefault();
      return;
    }
    const row = event.target.closest('.drive-row');
    if (!row) return;
    const item = { type: row.dataset.type, id: row.dataset.id, name: row.dataset.name, md5: row.dataset.md5, mime_type: row.dataset.mimeType };
    if (selected.size) toggleSelection(item);
    else if (event.target.closest('[data-more]')) openItemActions(item);
    else if (event.target.closest('[data-open]')) item.type === 'folder' ? goFolder(item.id) : previewFile(item);
  });
  list.addEventListener('pointerdown', (event) => {
    const row = event.target.closest('.drive-row');
    if (!row || !event.target.closest('[data-open]') || selected.size) return;
    longPressRow = row;
    longPressStart = { x: event.clientX, y: event.clientY };
    window.clearTimeout(longPressTimer);
    longPressTimer = window.setTimeout(() => {
      if (!longPressRow?.isConnected) return;
      const item = { type: row.dataset.type, id: row.dataset.id, name: row.dataset.name, md5: row.dataset.md5, mime_type: row.dataset.mimeType };
      toggleSelection(item);
      suppressClickUntil = Date.now() + 700;
      navigator.vibrate?.(25);
    }, 500);
  });
  list.addEventListener('pointermove', (event) => {
    if (longPressStart && hasPressMoved(longPressStart.x, longPressStart.y, event.clientX, event.clientY)) {
      window.clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((eventName) => list.addEventListener(eventName, () => {
    window.clearTimeout(longPressTimer);
    longPressTimer = null;
    longPressRow = null;
    longPressStart = null;
  }));
  selectionCancel.addEventListener('click', clearSelection);
  selectionDelete.addEventListener('click', deleteSelected);
  createButton.addEventListener('click', () => openActionSheet('添加内容', [
    { label: '上传文件', icon: 'upload', run: () => fileInput.click() },
    { label: '新建文件夹', icon: 'folder', run: createFolder },
  ]));
  fileInput.addEventListener('change', () => handleFiles(Array.from(fileInput.files || [])));
  root.querySelector('[data-search-toggle]').addEventListener('click', () => {
    searchPanel.classList.toggle('hidden');
    if (!searchPanel.classList.contains('hidden')) searchInput.focus();
  });
  let searchTimer = null;
  searchInput.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      search = searchInput.value.trim();
      const params = new URLSearchParams();
      if (search) params.set('q', search);
      if (searchScope === 'current') params.set('scope', 'current');
      const path = currentFolderId ? `files/${currentFolderId}` : 'files';
      window.history.replaceState(null, '', `#/${path}${params.size ? `?${params}` : ''}`);
      load();
    }, 300);
  });
  searchSelect.addEventListener('change', () => {
    searchScope = searchSelect.value;
    searchInput.dispatchEvent(new Event('input'));
  });
  searchPanel.querySelector('[data-clear]').addEventListener('click', () => {
    searchInput.value = '';
    search = '';
    searchPanel.classList.add('hidden');
    const path = currentFolderId ? `files/${currentFolderId}` : 'files';
    window.history.replaceState(null, '', `#/${path}`);
    load();
  });
  if (cachedState) {
    ({ folders = [], files = [], searchResults = [], offset = 0, searchCursor = null, hasMore = false } = cachedState);
    if (search) renderList();
    else {
      request(`/drive${currentFolderId ? `?folderId=${currentFolderId}` : ''}`).then((data) => renderBreadcrumb(data.breadcrumb || []));
      renderList();
    }
    requestAnimationFrame(() => window.scrollTo(0, cachedState.scrollY || 0));
    sessionStorage.removeItem(`drive:${routeKey}`);
    // 缓存只负责立即恢复界面，随后静默校准移动、重命名等最新变更。
    if (!search) load(false, true);
  } else load();
}
