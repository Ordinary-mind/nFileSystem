import { request, uploadForm } from '../core/api.js';

function calculateFileMd5(file) {
  return new Promise((resolve, reject) => {
    if (!window.SparkMD5) {
      reject(new Error('文件指纹组件加载失败'));
      return;
    }
    const chunkSize = 2 * 1024 * 1024;
    const spark = new window.SparkMD5.ArrayBuffer();
    const reader = new FileReader();
    let offset = 0;
    reader.onload = (event) => {
      spark.append(event.target.result);
      offset += chunkSize;
      if (offset < file.size) readNext();
      else resolve(spark.end());
    };
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    function readNext() {
      reader.readAsArrayBuffer(file.slice(offset, offset + chunkSize));
    }
    readNext();
  });
}

export async function uploadFiles(files, folderId, onProgress) {
  const input = Array.from(files || []);
  if (!input.length) return { count: 0 };
  const prepared = [];
  for (let index = 0; index < input.length; index++) {
    onProgress({ percent: Math.round(((index + 1) / input.length) * 30), label: `正在计算指纹 ${index + 1}/${input.length}` });
    prepared.push({
      file: input[index],
      md5: await calculateFileMd5(input[index]),
      originalName: input[index].name,
    });
  }

  onProgress({ percent: 35, label: '正在检查重复文件' });
  const instant = await request('/files/instant', {
    method: 'POST',
    body: {
      files: prepared.map(({ md5, originalName }) => ({ md5, originalName })),
      folderId,
    },
  });
  const pendingMd5 = new Set((instant.results || []).filter((item) => !item.success).map((item) => item.md5));
  const pending = prepared.filter((item) => pendingMd5.has(item.md5));
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
