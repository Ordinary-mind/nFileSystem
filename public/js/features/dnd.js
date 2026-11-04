import { collectDroppedEntries, hasFileDrag, isDropTargetValid } from '../core/dnd-utils.js';
import { showToast } from '../core/ui.js';

function rowInfo(row) {
  if (!row) return null;
  return {
    type: row.dataset.type,
    id: row.dataset.id,
    name: row.dataset.name,
    sha256: row.dataset.sha256,
    mime_type: row.dataset.mimeType,
  };
}

export function mountDragAndDrop({ root, list, onUpload, onMove, isInternalEnabled }) {
  const hint = root.querySelector('[data-drop-hint]');
  let draggingItem = null;
  let draggingRow = null;
  let targetRow = null;
  let dragDepth = 0;
  let busy = false;

  function showFileHint(active) {
    list.classList.toggle('is-file-drop', active);
    hint?.classList.toggle('hidden', !active);
  }

  function setTargetRow(row) {
    if (targetRow === row) return;
    targetRow?.classList.remove('is-drop-folder');
    targetRow = row;
    targetRow?.classList.add('is-drop-folder');
  }

  function resetDragState() {
    dragDepth = 0;
    showFileHint(false);
    setTargetRow(null);
    draggingRow?.classList.remove('is-dragging');
    draggingRow = null;
    draggingItem = null;
  }

  function runTask(task) {
    busy = true;
    Promise.resolve().then(task).catch(() => {}).finally(() => { busy = false; });
  }

  root.addEventListener('dragstart', (event) => {
    const row = event.target.closest?.('.drive-row');
    if (!row) return;
    if (busy || !isInternalEnabled()) {
      event.preventDefault();
      return;
    }
    draggingItem = rowInfo(row);
    draggingRow = row;
    row.classList.add('is-dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', draggingItem.name || '');
  });

  root.addEventListener('dragenter', (event) => {
    if (!hasFileDrag(event.dataTransfer?.types)) return;
    event.preventDefault();
    if (busy) return;
    dragDepth += 1;
    showFileHint(true);
  });

  root.addEventListener('dragleave', (event) => {
    if (!hasFileDrag(event.dataTransfer?.types)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) showFileHint(false);
  });

  root.addEventListener('dragover', (event) => {
    if (hasFileDrag(event.dataTransfer?.types)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
      if (!busy && !list.classList.contains('is-file-drop')) showFileHint(true);
      return;
    }
    if (!draggingItem) return;
    event.preventDefault();
    const row = event.target.closest?.('.drive-row');
    const valid = !busy && isInternalEnabled() && isDropTargetValid(draggingItem, rowInfo(row));
    event.dataTransfer.dropEffect = valid ? 'move' : 'none';
    setTargetRow(valid ? row : null);
  });

  root.addEventListener('drop', (event) => {
    const external = hasFileDrag(event.dataTransfer?.types);
    if (!external && !draggingItem) return;
    event.preventDefault();
    const source = draggingItem;
    const target = rowInfo(event.target.closest?.('.drive-row'));
    // collectDroppedEntries 对 items 的同步遍历必须在事件周期内完成，随后才能复位拖拽状态。
    const droppedPromise = external ? collectDroppedEntries(event.dataTransfer) : null;
    resetDragState();
    if (busy) return;
    if (external) {
      runTask(async () => {
        const dropped = await droppedPromise;
        if (dropped.unreadable) showToast(`${dropped.unreadable} 个文件无法读取，已跳过`, 'error');
        if (!dropped.entries.length) return;
        await onUpload(dropped.entries);
      });
      return;
    }
    if (!isInternalEnabled() || !isDropTargetValid(source, target)) return;
    runTask(() => onMove(source, target.id, target.name));
  });

  root.addEventListener('dragend', resetDragState);
}
