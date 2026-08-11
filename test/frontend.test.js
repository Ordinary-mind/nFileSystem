const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

async function loadUtils() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'core', 'utils.js'), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

async function loadImageViewer() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'features', 'image-viewer.js'), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('移动端路由解析保持稳定', async () => {
  const { parseRoute } = await loadUtils();
  assert.deepEqual(parseRoute('#/files/42'), { section: 'files', id: '42' });
  assert.deepEqual(parseRoute('#/apps/7'), { section: 'apps', id: '7' });
  assert.deepEqual(parseRoute('#/unknown'), { section: 'files', id: null });
});

test('前端格式化与 HTML 转义正确', async () => {
  const { escapeHtml, formatSize, getExtension, hasPressMoved, selectionKey } = await loadUtils();
  assert.equal(escapeHtml('<img src=x onerror=1>'), '&lt;img src=x onerror=1&gt;');
  assert.equal(formatSize(1536), '1.5 KB');
  assert.equal(getExtension('photo.final.jpg'), 'jpg');
  assert.equal(selectionKey({ type: 'file', id: 7 }), 'file:7');
  assert.notEqual(selectionKey({ type: 'file', id: 7 }), selectionKey({ type: 'folder', id: 7 }));
  assert.equal(hasPressMoved(10, 10, 15, 15), false);
  assert.equal(hasPressMoved(10, 10, 21, 10), true);
});

test('认证页面提供邮箱验证码和密码管理入口', () => {
  const authSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views', 'auth.js'), 'utf8');
  const profileSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views', 'profile.js'), 'utf8');
  assert.match(authSource, /type="email"/);
  assert.match(authSource, /\/auth\/email-codes/);
  assert.match(authSource, /reset_password/);
  assert.match(profileSource, /\/auth\/password\/change/);
});

test('图片预览缩放围绕焦点并限制平移边界', async () => {
  const { constrainImageTransform, zoomImageAt } = await loadImageViewer();
  const imageSize = { width: 300, height: 200 };
  const viewportSize = { width: 300, height: 200 };
  assert.deepEqual(
    constrainImageTransform({ scale: 2, x: 999, y: -999 }, imageSize, viewportSize),
    { scale: 2, x: 150, y: -100 }
  );
  assert.deepEqual(
    zoomImageAt({ scale: 1, x: 0, y: 0 }, 2, { x: 50, y: 0 }, imageSize, viewportSize),
    { scale: 2, x: -50, y: 0 }
  );
  assert.equal(constrainImageTransform({ scale: 9, x: 0, y: 0 }, imageSize, viewportSize).scale, 5);
});
