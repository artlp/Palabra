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
  assert.match(workflow, /actions\/deploy-pages@v4/);
  assert.match(rules, /request\.auth\.uid == userId/);
  assert.match(rules, /allow read, write: if false/);
});
