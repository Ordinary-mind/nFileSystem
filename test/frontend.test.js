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
  assert.deepEqual(parseRoute('#/share/nfs_sh_abc'), { section: 'share', id: 'nfs_sh_abc', search: '', scope: 'all' });
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

test('上传使用原生 SHA-256 且不再加载 MD5 组件', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const uploadSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'features', 'upload.js'), 'utf8');
  assert.doesNotMatch(indexSource, /spark-md5/i);
  assert.match(uploadSource, /subtle\.digest\('SHA-256'/);
  assert.match(uploadSource, /item\.sha256/);
  assert.doesNotMatch(uploadSource, /md5/i);
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

async function loadDndUtils() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'core', 'dnd-utils.js'), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('拖放类型判定只把外部文件拖拽视为上传', async () => {
  const { hasFileDrag } = await loadDndUtils();
  assert.equal(hasFileDrag(['Files']), true);
  assert.equal(hasFileDrag(['files']), true);
  assert.equal(hasFileDrag({ contains: (type) => type === 'Files' }), true);
  assert.equal(hasFileDrag({ length: 1, 0: 'Files' }), true);
  assert.equal(hasFileDrag(['text/plain']), false);
  assert.equal(hasFileDrag(null), false);
});

test('拖放收集保留目录结构并降级平铺', async () => {
  const { collectDroppedEntries } = await loadDndUtils();
  const rootFile = { name: 'a.txt' };
  const nested = { name: 'b.txt' };
  const fileEntry = (name, file) => ({ isFile: true, isDirectory: false, name, file: (success) => success(file) });
  const dirEntry = (name, children) => ({
    isFile: false, isDirectory: true, name,
    createReader: () => {
      let drained = false;
      return {
        readEntries: (success) => {
          if (drained) success([]);
          else {
            drained = true;
            success(children);
          }
        },
      };
    },
  });
  const dataTransfer = {
    items: [
      { kind: 'file', getAsFile: () => rootFile, webkitGetAsEntry: () => fileEntry('a.txt', rootFile) },
      {
        kind: 'file', getAsFile: () => null,
        webkitGetAsEntry: () => dirEntry('docs', [dirEntry('sub', [fileEntry('b.txt', nested)])]),
      },
    ],
    files: [],
  };
  const collected = await collectDroppedEntries(dataTransfer);
  assert.deepEqual(collected.entries.map((entry) => entry.path.join('/')), ['a.txt', 'docs/sub/b.txt']);
  assert.deepEqual(collected.dirs, []);
  assert.equal(collected.unreadable, 0);

  const fallback = await collectDroppedEntries({ items: [], files: [rootFile] });
  assert.deepEqual(fallback.entries.map((entry) => entry.path.join('/')), ['a.txt']);
  assert.equal(fallback.unreadable, 0);

  const broken = { isFile: true, isDirectory: false, name: 'x.bin', file: (success, failure) => failure(new Error('gone')) };
  const unreadable = await collectDroppedEntries({
    items: [{ kind: 'file', getAsFile: () => null, webkitGetAsEntry: () => broken }],
    files: [],
  });
  assert.deepEqual(unreadable, { entries: [], dirs: [], unreadable: 1 });

  const emptyDir = dirEntry('blank', []);
  const emptyResult = await collectDroppedEntries({
    items: [{ kind: 'file', getAsFile: () => null, webkitGetAsEntry: () => emptyDir }],
    files: [],
  });
  assert.deepEqual(emptyResult, { entries: [], dirs: [['blank']], unreadable: 0 });

  assert.deepEqual(await collectDroppedEntries(null), { entries: [], dirs: [], unreadable: 0 });
});

test('目录创建计划按层级去重且父级优先', async () => {
  const { buildFolderPlan } = await loadDndUtils();
  const plan = buildFolderPlan([
    ['docs', 'sub', 'b.txt'],
    ['docs', 'a.txt'],
    ['docs', 'sub', 'b.txt'],
    ['a.txt'],
  ]);
  assert.deepEqual(plan, [['docs'], ['docs', 'sub']]);
  assert.deepEqual(buildFolderPlan([]), []);
});

test('拖拽移动只接受合法的文件夹目标', async () => {
  const { isDropTargetValid } = await loadDndUtils();
  assert.equal(isDropTargetValid({ type: 'file', id: 7 }, { type: 'folder', id: 3 }), true);
  assert.equal(isDropTargetValid({ type: 'folder', id: 2 }, { type: 'folder', id: 3 }), true);
  assert.equal(isDropTargetValid({ type: 'folder', id: 3 }, { type: 'folder', id: '3' }), false);
  assert.equal(isDropTargetValid({ type: 'file', id: 3 }, { type: 'folder', id: 3 }), true);
  assert.equal(isDropTargetValid({ type: 'file', id: 1 }, { type: 'file', id: 2 }), false);
  assert.equal(isDropTargetValid(null, { type: 'folder', id: 3 }), false);
  assert.equal(isDropTargetValid({ type: 'file', id: 1 }, null), false);
});

test('文件视图接入拖拽上传与拖拽移动并保持原有入口', () => {
  const driveSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views', 'drive.js'), 'utf8');
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'main.js'), 'utf8');
  assert.match(driveSource, /draggable="true"/);
  assert.match(driveSource, /data-drop-hint/);
  assert.match(driveSource, /mountDragAndDrop\(\{/);
  assert.match(driveSource, /onUpload: handleFiles/);
  assert.match(driveSource, /onMove: moveItemTo/);
  assert.match(driveSource, /isInternalEnabled: \(\) => !search && !selected\.size/);
  assert.match(driveSource, /await request\('\/drive\/move'/);
  assert.match(driveSource, /fileInput\.addEventListener\('change'/);
  assert.match(mainSource, /document\.addEventListener\('dragover'/);
  assert.match(mainSource, /document\.addEventListener\('drop'/);
});

test('上传链路支持按目录结构创建文件夹', () => {
  const uploadSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'features', 'upload.js'), 'utf8');
  const driveSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views', 'drive.js'), 'utf8');
  assert.match(uploadSource, /export async function uploadEntries/);
  assert.match(uploadSource, /\/drive\/folder/);
  assert.match(uploadSource, /status !== 409/);
  assert.match(driveSource, /uploadEntries\(selectedFiles/);
  assert.match(driveSource, /toEntries\(Array\.from\(fileInput\.files/);
});

test('分享功能前后端接线完整且公开端点有限流', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'main.js'), 'utf8');
  const driveSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views', 'drive.js'), 'utf8');
  const profileSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views', 'profile.js'), 'utf8');
  const shareViewSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views', 'share.js'), 'utf8');
  assert.match(appSource, /app\.post\('\/drive\/share'/);
  assert.match(appSource, /app\.get\('\/drive\/shares'/);
  assert.match(appSource, /app\.post\('\/drive\/share\/:id\/reset'/);
  assert.match(appSource, /app\.delete\('\/drive\/share\/:id'/);
  assert.match(appSource, /app\.get\('\/share\/:token', \(req, res, next\)/);
  assert.match(appSource, /shareIndexHtml/);
  assert.match(appSource, /app\.post\('\/share\/:token\/verify', authRateLimit/);
  assert.match(appSource, /function shareRateLimit\(req, res, next\)/);
  assert.match(appSource, /app\.get\('\/share\/:token\/list', shareRateLimit/);
  assert.match(appSource, /app\.get\('\/share\/:token\/file\/:fileId', shareRateLimit/);
  assert.match(appSource, /app\.get\('\/share\/:token\/thumb\/:fileId', shareRateLimit/);
  assert.match(appSource, /hashApiToken\(token\)/);
  assert.match(appSource, /isFolderInsideSharedTree/);
  assert.match(mainSource, /mountShareView\(app, shareToken\)/);
  assert.match(driveSource, /openShareDialog/);
  assert.match(driveSource, /\/drive\/share/);
  assert.match(profileSource, /\/drive\/shares/);
  assert.match(profileSource, /data-copy-share/);
  assert.match(profileSource, /data-delete/);
  assert.match(shareViewSource, /\/share\/\$\{encodedToken\}\/verify/);
});
