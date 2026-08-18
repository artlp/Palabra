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
  assert.match(rules, /function isOwner\(userId\)/);
  assert.match(rules, /request\.auth\.uid == userId/);
  assert.match(rules, /allow delete: if isOwner\(userId\) && isSheetsAdmin\(\)/);
  assert.match(rules, /allow read, write: if false/);
});

test('Google Sheets metadata is admin-only and public users receive only parsed vocabulary', () => {
  const adminUid = 'uuDh6U8naZeC7hHv7U3Qex3sAtE2';
  const config = read('js/config.js');
  const app = read('js/app.js');
  const adapter = read('js/firebase-adapter.js');
  const localStore = read('js/local-store.js');
  const rules = read('firestore.rules');
  const html = read('index.html');

  assert.match(config, new RegExp(`sheetsAdminUid:\\s*'${adminUid}'`));
  assert.match(rules, new RegExp(`request\\.auth\\.uid == '${adminUid}'`));
  const privateSourceStart = rules.indexOf('match /appSettings/googleSheets');
  const publicVocabularyStart = rules.indexOf('match /appData/vocabulary');
  assert.ok(privateSourceStart >= 0 && publicVocabularyStart > privateSourceStart);
  const privateSourceRules = rules.slice(privateSourceStart, publicVocabularyStart);
  assert.match(privateSourceRules, /allow read: if isSheetsAdmin\(\)/);
  assert.doesNotMatch(privateSourceRules, /allow read: if true/);
  assert.match(rules, /match \/appData\/vocabulary[\s\S]*?allow read: if true/);
  assert.match(rules, /request\.resource\.data\.keys\(\)\.hasOnly\(\['words', 'publishedAt'\]\)/);
  assert.doesNotMatch(rules, /publishedBy/);
  assert.match(rules, /hasAny\(\['sheetUrl', 'sheetName'\]\)/);
  assert.match(rules, /totalReviews == resource\.data\.totalReviews \+ 1/);
  assert.match(rules, /reviews == resource\.data\.reviews \+ 1/);

  assert.match(adapter, /async function loadPublishedVocabulary/);
  assert.match(adapter, /async function publishVocabulary/);

  const syncStart = app.indexOf('async function syncVocabulary');
  const publishStart = app.indexOf('async function publishVocabularyFromSheet');
  const nextFunction = app.indexOf('function nextCardStateLabel', publishStart);
  assert.ok(syncStart >= 0 && publishStart > syncStart && nextFunction > publishStart);
  const loginSyncBlock = app.slice(syncStart, publishStart);
  const adminPublishBlock = app.slice(publishStart, nextFunction);
  assert.match(loginSyncBlock, /loadPublishedVocabulary/);
  assert.doesNotMatch(loginSyncBlock, /loadWordsFromSource\(source\.sheetUrl/);
  assert.doesNotMatch(loginSyncBlock, /publishVocabulary\(/);
  assert.match(adminPublishBlock, /isSheetsAdmin\(\)/);
  assert.match(adminPublishBlock, /loadWordsFromSource\(source\.sheetUrl/);
  assert.match(adminPublishBlock, /publishVocabulary\(runtime\.user, result\.words\)/);
  assert.match(adapter, /browserSessionPersistence/);
  assert.doesNotMatch(adapter, /browserLocalPersistence/);
  assert.match(adapter, /doc\(db, 'appSettings', 'googleSheets'\)/);
  assert.match(adapter, /doc\(db, 'appData', 'vocabulary'\)/);
  assert.match(app, /if \(!isSheetsAdmin\(\)\) \{\s*applySharedSheetSettings/);
  assert.match(app, /await publishVocabularyFromSheet\(\{ silent: true \}\)/);
  assert.match(html, /id="source-settings-panel" hidden/);
  assert.match(html, /id="reset-progress-panel" hidden/);
  assert.match(html, /id="dictionary-status-panel"/);
  assert.doesNotMatch(html, /id="csv-file-input"/);
  assert.doesNotMatch(html, /id="settings-sync-button"/);

  assert.doesNotMatch(app, /copyGuestIntoAccount/);
  assert.doesNotMatch(app, /guestState\.settings/);
  assert.match(localStore, /profileStorage\(profileKey = 'guest'\)/);
  assert.match(localStore, /\? localStorage : sessionStorage/);
  assert.match(localStore, /localStorage\.removeItem\(LEGACY_SHARED_SHEET_STORAGE_KEY\)/);
  assert.match(localStore, /palabra:global-vocabulary:v1/);
  assert.match(localStore, /personalSnapshot\.vocabulary = emptyVocabulary\(\)/);
  assert.doesNotMatch(localStore, /startsWith\('local-csv:'\)/);
});
