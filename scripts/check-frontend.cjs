const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const publicRoot = path.join(__dirname, '..', 'public');

function collectJavaScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectJavaScriptFiles(target);
    return entry.isFile() && entry.name.endsWith('.js') ? [target] : [];
  });
}

for (const filePath of collectJavaScriptFiles(publicRoot)) {
  const result = spawnSync(process.execPath, ['--check', filePath], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
