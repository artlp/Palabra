import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDefaultState,
  loadLocalState,
  saveLocalState,
  scrubLegacyPrivateMetadata,
  storageKey,
} from '../js/local-store.js';

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }

  get length() {
    return this.map.size;
  }

  key(index) {
    return [...this.map.keys()][index] ?? null;
  }

  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  setItem(key, value) {
    this.map.set(String(key), String(value));
  }

  removeItem(key) {
    this.map.delete(String(key));
  }
}

function resetStorage() {
  globalThis.localStorage = new MemoryStorage();
  globalThis.sessionStorage = new MemoryStorage();
}

test('guest and authenticated profile settings cannot overwrite each other', () => {
  resetStorage();

  const guest = createDefaultState();
  guest.settings.dailyNewLimit = 3;
  guest.settings.sheetUrl = 'https://secret.example/sheet';
  saveLocalState('guest', guest);

  const account = createDefaultState();
  account.settings.dailyNewLimit = 27;
  account.settings.answerTolerance = 'strict';
  saveLocalState('user-123', account);

  assert.equal(loadLocalState('guest').settings.dailyNewLimit, 3);
  assert.equal(loadLocalState('user-123').settings.dailyNewLimit, 27);
  assert.equal(loadLocalState('user-123').settings.answerTolerance, 'strict');
  assert.equal('sheetUrl' in loadLocalState('guest').settings, false);

  assert.ok(localStorage.getItem(storageKey('guest')));
  assert.equal(localStorage.getItem(storageKey('user-123')), null);
  assert.ok(sessionStorage.getItem(storageKey('user-123')));
});


test('two authenticated accounts keep independent session settings', () => {
  const first = createDefaultState();
  first.settings.dailyNewLimit = 3;
  saveLocalState('user-a', first);

  const second = createDefaultState();
  second.settings.dailyNewLimit = 17;
  saveLocalState('user-b', second);

  const loadedA = loadLocalState('user-a');
  const loadedB = loadLocalState('user-b');
  assert.equal(loadedA.settings.dailyNewLimit, 3);
  assert.equal(loadedB.settings.dailyNewLimit, 17);
  assert.notEqual(storageKey('user-a'), storageKey('user-b'));
  assert.ok(sessionStorage.getItem(storageKey('user-a')));
  assert.ok(sessionStorage.getItem(storageKey('user-b')));
});

test('legacy shared-sheet metadata and persistent account caches are purged', () => {
  resetStorage();

  localStorage.setItem('palabra:shared-sheet:v1', JSON.stringify({
    sheetUrl: 'https://secret.example/sheet',
    sheetName: 'Private tab',
  }));
  localStorage.setItem(storageKey('real-user'), JSON.stringify({
    settings: { dailyNewLimit: 99, sheetUrl: 'https://secret.example/sheet' },
    progress: { privateWord: { totalReviews: 10 } },
  }));
  localStorage.setItem(storageKey('guest'), JSON.stringify({
    settings: { dailyNewLimit: 4, sheetName: 'Private tab' },
    vocabulary: { words: [], sourceUrl: 'https://secret.example/sheet', sourceType: 'Google Sheets' },
  }));

  scrubLegacyPrivateMetadata();

  assert.equal(localStorage.getItem('palabra:shared-sheet:v1'), null);
  assert.equal(localStorage.getItem(storageKey('real-user')), null);
  assert.equal(loadLocalState('guest').settings.dailyNewLimit, 4);
  assert.equal('sheetName' in loadLocalState('guest').settings, false);
  assert.equal('sourceUrl' in loadLocalState('guest').vocabulary, false);
  assert.notEqual(loadLocalState('guest').vocabulary.sourceType, 'Google Sheets');
});
