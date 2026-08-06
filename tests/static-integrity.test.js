import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

function allMatches(text, pattern) {
  return [...text.matchAll(pattern)].map((match) => match[1]);
}

test('HTML ids are unique and literal app references exist', () => {
  const html = read('index.html');
  const app = read('js/app.js');
  const ids = allMatches(html, /\sid="([^"]+)"/g);
  const counts = new Map();
  ids.forEach((id) => counts.set(id, (counts.get(id) || 0) + 1));
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1);
  assert.deepEqual(duplicates, []);

  const referenced = new Set([
    ...allMatches(app, /(?<!\$)\$\('([^']+)'\)/g),
    ...allMatches(app, /setText\('([^']+)'/g),
    ...allMatches(app, /setFormValue\('([^']+)'/g),
  ]);
  const available = new Set(ids);
  const missing = [...referenced].filter((id) => !available.has(id)).sort();
  assert.deepEqual(missing, []);
});

test('all local HTML and service-worker shell assets exist', () => {
  const html = read('index.html');
  const sw = read('sw.js');
  const htmlAssets = [...html.matchAll(/(?:href|src)="\.\/([^"?#]+)"/g)].map((match) => match[1]);
  const shellAssets = [...sw.matchAll(/'\.\/([^']*)'/g)]
    .map((match) => match[1])
    .filter(Boolean);
  const missing = [...new Set([...htmlAssets, ...shellAssets])]
    .filter((path) => !existsSync(resolve(root, path)) || !statSync(resolve(root, path)).isFile());
  assert.deepEqual(missing, []);
});

test('Font Awesome sprite contains every referenced interface icon', () => {
  const html = read('index.html');
  const sprite = read('icons/fa-sprite.svg');
  const references = allMatches(html, /fa-sprite\.svg#([^"]+)/g);
  assert.ok(references.length > 0);
  references.forEach((iconId) => {
    assert.match(sprite, new RegExp(`id="${iconId}"`));
  });
});

test('manifest is valid and declares install icons', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, './');
  assert.ok(Array.isArray(manifest.icons));
  assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192'));
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512'));
});

test('deployment workflow runs checks and Firestore rules isolate users', () => {
  const workflow = read('.github/workflows/deploy.yml');
  const rules = read('firestore.rules');
  assert.match(workflow, /npm test && npm run check/);
  assert.match(workflow, /actions\/setup-node@v6/);
  assert.match(workflow, /actions\/configure-pages@v6/);
  assert.match(workflow, /actions\/upload-pages-artifact@v5/);
  assert.match(workflow, /actions\/deploy-pages@v5/);
  assert.match(rules, /request\.auth\.uid == userId/);
  assert.match(rules, /allow read, write: if false/);
});

test('Google Sheets source is shared and writable only by the configured administrator', () => {
  const adminUid = 'uuDh6U8naZeC7hHv7U3Qex3sAtE2';
  const config = read('js/config.js');
  const app = read('js/app.js');
  const adapter = read('js/firebase-adapter.js');
  const rules = read('firestore.rules');
  const html = read('index.html');

  assert.match(config, new RegExp(`sheetsAdminUid:\\s*'${adminUid}'`));
  assert.match(rules, new RegExp(`request\\.auth\\.uid == '${adminUid}'`));
  assert.match(rules, /match \/appSettings\/googleSheets/);
  assert.match(rules, /allow read: if true/);
  assert.match(rules, /allow create, update: if isSheetsAdmin\(\)/);
  assert.match(adapter, /doc\(db, 'appSettings', 'googleSheets'\)/);
  assert.match(adapter, /async function saveSheetSettings/);
  assert.match(app, /function isSheetsAdmin/);
  assert.match(app, /runtime\.firebase\.saveSheetSettings\(runtime\.user, nextSettings\)/);
  assert.match(html, /id="save-source-button"/);
  assert.match(html, /id="source-permission-note"/);
});
