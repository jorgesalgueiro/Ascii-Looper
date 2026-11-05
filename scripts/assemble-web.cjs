#!/usr/bin/env node
// Assemble the static browser app into dist/ for Tauri.
// The browser build is unchanged: this only copies files, it never rewrites
// index.html or main.js. Run it directly with `node scripts/assemble-web.cjs`.

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'dist');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const files = [
  'index.html',
  'main.js',
  'styles.css',
  'favicon.ico',
  'harmony-effect.afx',
  'LICENSE',
  'soundtouch.min.js',
  'SOUNDTOUCH-LICENSE.txt',
];

for (const file of files) {
  const source = path.join(root, file);
  if (fs.existsSync(source)) {
    fs.copyFileSync(source, path.join(out, file));
  }
}

const modules = path.join(root, 'Modules');
if (fs.existsSync(modules)) {
  fs.mkdirSync(path.join(out, 'Modules'), { recursive: true });
  for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    fs.copyFileSync(path.join(modules, entry.name), path.join(out, 'Modules', entry.name));
  }
}

// Cache-bust the generated page. WebView2 caches tauri:// subresources, so a
// desktop update that only changes a module would otherwise run the previous
// version. The browser tree keeps its original index.html; only dist/ is
// rewritten.
const crypto = require('node:crypto');
const hash = crypto.createHash('sha1');
const jsFiles = [];
for (const file of files) {
  if (file.endsWith('.js')) jsFiles.push(path.join(out, file));
}
for (const entry of fs.readdirSync(path.join(out, 'Modules'), { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.js')) {
    jsFiles.push(path.join(out, 'Modules', entry.name));
  }
}
for (const file of jsFiles.sort()) {
  if (fs.existsSync(file)) hash.update(fs.readFileSync(file));
}
const buildId = hash.digest('hex').slice(0, 12);

const outHtmlPath = path.join(out, 'index.html');
if (fs.existsSync(outHtmlPath)) {
  const html = fs.readFileSync(outHtmlPath, 'utf8');
  const versioned = html.replace(
    /(<script\s+src=")(\.?\/?(?:Modules\/[^"?]+|main\.js|soundtouch\.min\.js))(")/g,
    `$1$2?v=${buildId}$3`
  );
  fs.writeFileSync(outHtmlPath, versioned);
}

console.log(`[assemble-web] wrote ${path.relative(root, out)} (build ${buildId})`);
