import { request } from '../core/api.js';
import { icon } from '../core/icons.js';
import { escapeHtml, formatDate, formatSize } from '../core/utils.js';
import { confirmDialog, errorView, loadingView, showToast } from '../core/ui.js';

export function mountTrash(root, navigate) {
  root.innerHTML = `<div class="top-bar"><div><h1>回收站</h1><div class="top-bar-subtitle" data-summary>正在加载</div></div><button type="button" class="icon-button danger-icon" data-empty aria-label="清空回收站">${icon('trash')}</button></div><div class="drive-list" data-list>${loadingView()}</div>`;
  const list = root.querySelector('[data-list]');
  const summary = root.querySelector('[data-summary]');
  let items = [];
  async function load() {
    try {
      const data = await request('/drive/trash');
      items = data.items || [];
      summary.textContent = `保留 ${data.retentionDays} 天，共 ${items.length} 项`;
      list.innerHTML = items.length ? items.map((item) => `<div class="drive-row"><button type="button" class="drive-main" data-restore="${item.batch_id}">${icon(item.item_type === 'folder' ? 'folder' : 'file')}<span class="drive-copy"><strong>${escapeHtml(item.name || '已过期项目')}</strong><small>删除于 ${formatDate(item.deleted_at)}${item.size ? ` · ${formatSize(item.size)}` : ''}</small></span></button><button type="button" class="icon-button danger-icon" data-delete="${item.batch_id}" aria-label="永久删除">${icon('trash')}</button></div>`).join('') : `<div class="empty-drive">${icon('trash')}<h2>回收站为空</h2><button type="button" class="secondary-button" data-files>返回文件</button></div>`;
      list.querySelector('[data-files]')?.addEventListener('click', () => navigate('files'));
      list.querySelectorAll('[data-restore]').forEach((button) => button.addEventListener('click', () => restore(button.dataset.restore)));
      list.querySelectorAll('[data-delete]').forEach((button) => button.addEventListener('click', () => remove(button.dataset.delete)));
    } catch (error) { list.innerHTML = errorView(error.message); }
  }
  async function restore(id) { try { await request(`/drive/trash/${id}/restore`, { method: 'POST' }); showToast('恢复成功'); load(); } catch (error) { showToast(error.message, 'error'); } }
  async function remove(id) { if (await confirmDialog({ title: '永久删除', message: '此操作无法撤销。', confirmLabel: '永久删除', danger: true })) { try { await request(`/drive/trash/${id}`, { method: 'DELETE' }); showToast('已永久删除'); load(); } catch (error) { showToast(error.message, 'error'); } } }
  root.querySelector('[data-empty]').addEventListener('click', async () => { if (items.length && await confirmDialog({ title: '清空回收站', message: '所有回收站内容将被永久删除。', confirmLabel: '清空', danger: true })) { await request('/drive/trash', { method: 'DELETE' }); showToast('回收站已清空'); load(); } });
  load();
}
