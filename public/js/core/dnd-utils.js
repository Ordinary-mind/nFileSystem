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

async function walkEntry(entry, parentPath, entries, dirs, stats) {
  if (!entry) return;
  if (entry.isDirectory) {
    const path = [...parentPath, entry.name];
    let children = [];
    try {
      children = await readAllEntries(entry.createReader());
    } catch {
      stats.unreadable += 1;
      return;
    }
    if (!children.length) {
      dirs.push(path);
      return;
    }
    for (const child of children) await walkEntry(child, path, entries, dirs, stats);
    return;
  }
  if (entry.isFile && typeof entry.file === 'function') {
    const file = await new Promise((resolve) => entry.file(resolve, () => resolve(null)));
    if (file) entries.push({ path: [...parentPath, entry.name], file });
    else stats.unreadable += 1;
    return;
  }
  stats.unreadable += 1;
}

export async function collectDroppedEntries(dataTransfer) {
  if (!dataTransfer) return { entries: [], dirs: [], unreadable: 0 };
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
  const dirs = [];
  const stats = { unreadable: 0 };
  for (const root of roots) {
    const isEntry = typeof root.isFile === 'boolean' || typeof root.isDirectory === 'boolean';
    if (!isEntry) {
      entries.push({ path: [root.name], file: root });
      continue;
    }
    await walkEntry(root, [], entries, dirs, stats);
  }
  return { entries, dirs, ...stats };
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
