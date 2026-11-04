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

function readAllEntries(reader) {
  return new Promise((resolve, reject) => {
    const collected = [];
    const readBatch = () => {
      reader.readEntries((batch) => {
        if (!batch.length) {
          resolve(collected);
          return;
        }
        collected.push(...batch);
        readBatch();
      }, reject);
    };
    readBatch();
  });
}

async function walkEntry(entry, parentPath, entries) {
  if (!entry) return 0;
  if (entry.isDirectory) {
    const path = [...parentPath, entry.name];
    let children = [];
    try {
      children = await readAllEntries(entry.createReader());
    } catch {
      return 0;
    }
    let count = 0;
    for (const child of children) count += await walkEntry(child, path, entries);
    return count;
  }
  if (entry.isFile && typeof entry.file === 'function') {
    const file = await new Promise((resolve) => entry.file(resolve, () => resolve(null)));
    if (file) {
      entries.push({ path: [...parentPath, entry.name], file });
      return 1;
    }
  }
  return 0;
}

export async function collectDroppedEntries(dataTransfer) {
  if (!dataTransfer) return { entries: [], unreadable: 0 };
  const items = dataTransfer.items;
  const roots = [];
  // 必须在 drop 事件同步周期内完成 items 遍历，事件返回后 DataTransfer 会进入保护模式。
  if (items && items.length) {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item.kind !== 'file') continue;
      const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
      if (entry) roots.push(entry);
      else if (typeof item.getAsFile === 'function' && item.getAsFile()) roots.push(item.getAsFile());
    }
  }
  if (!roots.length) roots.push(...Array.from(dataTransfer.files || []));
  const entries = [];
  let collected = 0;
  for (const root of roots) {
    const isEntry = typeof root.isFile === 'boolean' || typeof root.isDirectory === 'boolean';
    if (!isEntry) {
      entries.push({ path: [root.name], file: root });
      collected += 1;
      continue;
    }
    collected += await walkEntry(root, [], entries);
  }
  return { entries, unreadable: roots.length - collected };
}

export function buildFolderPlan(paths) {
  const seen = new Map();
  for (const path of paths || []) {
    for (let depth = 1; depth < path.length; depth += 1) {
      const prefix = path.slice(0, depth);
      const key = prefix.join('/');
      if (!seen.has(key)) seen.set(key, prefix);
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.length - b.length);
}

export function isDropTargetValid(source, targetRow) {
  if (!source || !targetRow || targetRow.type !== 'folder') return false;
  if (source.type === 'folder' && String(source.id) === String(targetRow.id)) return false;
  return true;
}
