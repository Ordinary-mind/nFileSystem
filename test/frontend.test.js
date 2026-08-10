const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

async function loadUtils() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'core', 'utils.js'), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('移动端路由解析保持稳定', async () => {
  const { parseRoute } = await loadUtils();
  assert.deepEqual(parseRoute('#/files/42'), { section: 'files', id: '42' });
  assert.deepEqual(parseRoute('#/apps/7'), { section: 'apps', id: '7' });
  assert.deepEqual(parseRoute('#/unknown'), { section: 'files', id: null });
});

test('前端格式化与 HTML 转义正确', async () => {
  const { escapeHtml, formatSize, getExtension } = await loadUtils();
  assert.equal(escapeHtml('<img src=x onerror=1>'), '&lt;img src=x onerror=1&gt;');
  assert.equal(formatSize(1536), '1.5 KB');
  assert.equal(getExtension('photo.final.jpg'), 'jpg');
});
