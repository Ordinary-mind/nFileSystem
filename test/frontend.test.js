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
  assert.deepEqual(parseRoute('#/files/42'), { section: 'files', id: '42', search: '', scope: 'all' });
  assert.deepEqual(parseRoute('#/apps/7'), { section: 'apps', id: '7', search: '', scope: 'all' });
  assert.deepEqual(parseRoute('#/unknown'), { section: 'files', id: null, search: '', scope: 'all' });
  assert.deepEqual(parseRoute('#/files/42?q=%E6%8A%A5%E5%91%8A&scope=current'), {
    section: 'files', id: '42', search: '报告', scope: 'current',
  });
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

test('SVG 预览会使用浏览器可识别的 MIME 类型', () => {
  const driveSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views', 'drive.js'), 'utf8');
  assert.match(driveSource, /ext === 'svg'/);
  assert.match(driveSource, /type: 'image\/svg\+xml'/);
  assert.doesNotMatch(driveSource, /thumbnail.*image\/svg\+xml/i);
});

test('移动目录加载完成前禁止提交且重命名默认保护扩展名', () => {
  const driveSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views', 'drive.js'), 'utf8');
  assert.match(driveSource, /let folderLoaded = false/);
  assert.match(driveSource, /moveSubmit\.disabled = true/);
  assert.match(driveSource, /folderLoaded = true;\s*moveSubmit\.disabled = false/);
  assert.match(driveSource, /扩展名决定文件类型，默认保持不变/);
  assert.match(driveSource, /data-edit-extension/);
});

test('普通目录命中历史缓存后仍会静默刷新最新列表', () => {
  const driveSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views', 'drive.js'), 'utf8');
  assert.match(driveSource, /async function load\(append = false, preserveDisplay = false\)/);
  assert.match(driveSource, /load\(false, true\)/);
  assert.match(driveSource, /缓存只负责立即恢复界面/);
});
