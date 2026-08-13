import { request, uploadForm } from '../core/api.js';

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
