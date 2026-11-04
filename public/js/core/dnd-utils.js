function toTypeList(types) {
  if (!types) return [];
  if (typeof types[Symbol.iterator] === 'function') return Array.from(types);
  if (typeof types.length === 'number') {
    return Array.from({ length: types.length }, (_, index) => types[index]);
  }
  return [];
}

export function hasFileDrag(types) {
  if (typeof types?.contains === 'function' && types.contains('Files')) return true;
  return toTypeList(types).some((type) => String(type).toLowerCase() === 'files');
}

export function extractDroppedFiles(dataTransfer) {
  if (!dataTransfer) return { files: [], ignoredFolders: 0 };
  const items = dataTransfer.items;
  if (!items || !items.length) {
    return { files: Array.from(dataTransfer.files || []), ignoredFolders: 0 };
  }
  const files = [];
  let ignoredFolders = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.kind !== 'file') continue;
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
    if (entry?.isDirectory) {
      ignoredFolders += 1;
      continue;
    }
    const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null;
    if (file) files.push(file);
  }
  if (!files.length && !ignoredFolders) {
    return { files: Array.from(dataTransfer.files || []), ignoredFolders: 0 };
  }
  return { files, ignoredFolders };
}

export function isDropTargetValid(source, targetRow) {
  if (!source || !targetRow || targetRow.type !== 'folder') return false;
  if (source.type === 'folder' && String(source.id) === String(targetRow.id)) return false;
  return true;
}
