// The packaged webview's CSP blocks the old CDN import, so SoundTouchJS must
// be vendored locally and imported by main.js. This guards that wiring.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('SoundTouchJS is vendored and exposes the ES module API', () => {
    const file = path.join(root, 'soundtouch.min.js');
    assert.ok(fs.existsSync(file), 'soundtouch.min.js must be present');
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, /class SoundTouch/);
    assert.match(source, /class SimpleFilter/);
    assert.match(source, /export\{/, 'the file must stay an ES module');
});

test('index.html no longer depends on the blocked CDN', () => {
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.doesNotMatch(html, /cdn\.jsdelivr\.net\/npm\/soundtouchjs/);
});

test('main.js imports the local module with a cache-busting version', () => {
    const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    assert.match(main, /import\(`\.\/soundtouch\.min\.js\?v=\$\{encodeURIComponent\(VERSION\)\}`\)/);
});

test('the packaging script ships the library and its licence', () => {
    const assemble = fs.readFileSync(path.join(root, 'scripts/assemble-web.cjs'), 'utf8');
    assert.match(assemble, /'soundtouch\.min\.js'/);
    assert.ok(fs.existsSync(path.join(root, 'SOUNDTOUCH-LICENSE.txt')));
    const config = fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8');
    assert.match(config, /resources\/SOUNDTOUCH-LICENSE\.txt/);
});
