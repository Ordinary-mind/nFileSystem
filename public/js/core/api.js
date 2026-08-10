import { getSession } from './session.js';

let unauthorizedHandler = () => {};

export class ApiError extends Error {
  constructor(message, status, data = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

export function setUnauthorizedHandler(handler) {
  unauthorizedHandler = typeof handler === 'function' ? handler : () => {};
}

function buildHeaders(headers, auth, body) {
  const result = new Headers(headers || {});
  if (auth) {
    const { token } = getSession();
    if (token) result.set('Authorization', `Bearer ${token}`);
  }
  if (body !== undefined && !(body instanceof FormData) && !result.has('Content-Type')) {
    result.set('Content-Type', 'application/json');
  }
  return result;
}

async function parseResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return response.json();
  return response.text();
}

export async function request(path, options = {}) {
  const { method = 'GET', body, auth = true, headers } = options;
  const response = await fetch(path, {
    method,
    headers: buildHeaders(headers, auth, body),
    body: body === undefined || body instanceof FormData ? body : JSON.stringify(body),
  });
  if (response.status === 401 && auth) unauthorizedHandler();
  const data = await parseResponse(response);
  if (!response.ok) {
    throw new ApiError(data && data.message ? data.message : '请求失败', response.status, data);
  }
  return data;
}

export async function requestBlob(path) {
  const { token } = getSession();
  const response = await fetch(path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (response.status === 401) unauthorizedHandler();
  if (!response.ok) {
    let message = '文件加载失败';
    try {
      const data = await response.json();
      message = data.message || message;
    } catch {
      // 非 JSON 错误响应保持默认提示。
    }
    throw new ApiError(message, response.status);
  }
  return response.blob();
}

export function uploadForm(path, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const { token } = getSession();
    xhr.open('POST', path);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || '{}'); } catch { data = {}; }
      if (xhr.status === 401) unauthorizedHandler();
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(data.message || '上传失败', xhr.status, data));
    };
    xhr.onerror = () => reject(new ApiError('网络错误', 0));
    xhr.send(formData);
  });
}
