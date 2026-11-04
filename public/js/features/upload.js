import { request, uploadForm } from '../core/api.js';
import { buildFolderPlan } from '../core/dnd-utils.js';

async function calculateFileSha256(file) {
  if (!globalThis.crypto?.subtle) return null;
  try {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

function fingerprintKey(sha256, originalName) {
  return `${sha256}\0${originalName}`;
}

export async function uploadFiles(files, folderId, onProgress) {
  const input = Array.from(files || []);
  if (!input.length) return { count: 0 };
  const prepared = [];
  for (let index = 0; index < input.length; index++) {
    onProgress({ percent: Math.round(((index + 1) / input.length) * 30), label: `正在计算指纹 ${index + 1}/${input.length}` });
    prepared.push({
      file: input[index],
      sha256: await calculateFileSha256(input[index]),
      originalName: input[index].name,
    });
  }

  const fingerprinted = prepared.filter((item) => item.sha256);
  let completed = new Set();
  if (fingerprinted.length) {
    onProgress({ percent: 35, label: '正在检查重复文件' });
    const instant = await request('/files/instant', {
      method: 'POST',
      body: {
        files: fingerprinted.map(({ sha256, originalName }) => ({ sha256, originalName })),
        folderId,
      },
    });
    completed = new Set((instant.results || [])
      .filter((item) => item.success)
      .map((item) => fingerprintKey(item.sha256, item.originalName)));
  }
  const pending = prepared.filter((item) => !item.sha256 || !completed.has(fingerprintKey(item.sha256, item.originalName)));
  if (pending.length) {
    const form = new FormData();
    form.append('folderId', folderId || '');
    pending.forEach((item) => form.append('files', item.file));
    await uploadForm('/files/upload', form, (ratio) => {
      onProgress({ percent: Math.round(40 + ratio * 60), label: `正在上传 ${Math.round(ratio * 100)}%` });
    });
  }
  onProgress({ percent: 100, label: pending.length ? '上传完成' : '全部秒传完成' });
  return { count: input.length };
}

export function toEntries(files) {
  return Array.from(files || []).map((file) => ({ path: [file.name], file }));
}

async function ensureFolders(plan, baseFolderId, onProgress) {
  const folderIds = new Map([['', baseFolderId]]);
  const planEnd = Math.round((plan.length / (plan.length + 1)) * 15);
  for (let index = 0; index < plan.length; index += 1) {
    const path = plan[index];
    const key = path.join('/');
    const parentKey = path.slice(0, -1).join('/');
    const parentId = folderIds.get(parentKey);
    onProgress({ percent: Math.round(((index + 1) / plan.length) * planEnd), label: `正在创建文件夹 ${key}` });
    try {
      const created = await request('/drive/folder', { method: 'POST', body: { name: path[path.length - 1], parentId } });
      folderIds.set(key, created.id);
    } catch (error) {
      if (error?.status !== 409) throw error;
      const params = new URLSearchParams({ offset: '0' });
      if (parentId) params.set('folderId', parentId);
      const listing = await request(`/drive?${params}`);
      const match = (listing.folders || []).find((folder) => folder.name === path[path.length - 1]);
      if (!match) throw error;
      folderIds.set(key, match.id);
    }
  }
  return { folderIds, uploadStart: planEnd };
}

export async function uploadEntries(items, folderId, onProgress) {
  const input = Array.from(items || []).filter((item) => item && item.file);
  if (!input.length) return { count: 0 };
  const plan = buildFolderPlan(input.map((item) => item.path));
  const { folderIds, uploadStart } = await ensureFolders(plan, folderId, onProgress);

  const groups = new Map();
  for (const item of input) {
    const key = item.path.slice(0, -1).join('/');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item.file);
  }
  const groupList = Array.from(groups.values());
  const span = 100 - uploadStart;
  for (let index = 0; index < groupList.length; index += 1) {
    const base = uploadStart + Math.round((index / groupList.length) * span);
    const reach = uploadStart + Math.round(((index + 1) / groupList.length) * span);
    await uploadFiles(groupList[index], folderIds.get(Array.from(groups.keys())[index]), (progress) => {
      onProgress({ percent: base + Math.round((progress.percent / 100) * (reach - base)), label: progress.label });
    });
  }
  onProgress({ percent: 100, label: '上传完成' });
  return { count: input.length };
}
