import {
  DEFAULT_LEARNING_SETTINGS,
  mergeDailyMaps,
  mergeProgressMaps,
} from './core.js';

const STORAGE_PREFIX = 'palabra:v2:';
const MAX_RECENT_REVIEWS = 800;
const LEGACY_SHARED_SHEET_STORAGE_KEY = 'palabra:shared-sheet:v1';

function safeClone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function personalSettings(settings = {}) {
  const {
    sheetUrl: _legacySheetUrl,
    sheetName: _legacySheetName,
    ...personal
  } = settings || {};
  return personal;
}

function safeVocabulary(vocabulary = {}) {
  const sourceKey = String(vocabulary?.sourceKey || '');
  const safeSourceKey = sourceKey.startsWith('local-csv:') || sourceKey.startsWith('public:')
    ? sourceKey
    : '';
  const sourceType = safeSourceKey.startsWith('local-csv:')
    ? 'Локальный CSV'
    : safeSourceKey.startsWith('public:')
      ? (String(vocabulary?.sourceType || '') === 'Демо-словарь' ? 'Демо-словарь' : 'Общий словарь')
      : '';
  return {
    words: Array.isArray(vocabulary?.words) ? vocabulary.words : [],
    importVersion: Number(vocabulary?.importVersion || 0),
    sourceKey: safeSourceKey,
    sourceType,
    syncedAt: vocabulary?.syncedAt || null,
    publishedAt: vocabulary?.publishedAt || null,
  };
}

export function storageKey(profileKey = 'guest') {
  const safeKey = String(profileKey || 'guest').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${STORAGE_PREFIX}${safeKey}`;
}

function profileStorage(profileKey = 'guest') {
  return String(profileKey || 'guest') === 'guest' ? localStorage : sessionStorage;
}

export function createDefaultState() {
  return {
    version: 2,
    settings: {
      ...DEFAULT_LEARNING_SETTINGS,
      theme: 'system',
    },
    vocabulary: {
      words: [],
      importVersion: 0,
      sourceKey: '',
      sourceType: '',
      syncedAt: null,
      publishedAt: null,
    },
    progress: {},
    daily: {},
    recentReviews: [],
    meta: {
      lastSavedAt: null,
      lastRemoteSyncAt: null,
    },
  };
}

function repairState(candidate) {
  const base = createDefaultState();
  if (!candidate || typeof candidate !== 'object') return base;
  return {
    ...base,
    version: 2,
    settings: {
      ...base.settings,
      ...personalSettings(candidate.settings || {}),
    },
    vocabulary: {
      ...base.vocabulary,
      ...safeVocabulary(candidate.vocabulary || {}),
    },
    progress: candidate.progress && typeof candidate.progress === 'object' ? candidate.progress : {},
    daily: candidate.daily && typeof candidate.daily === 'object' ? candidate.daily : {},
    recentReviews: Array.isArray(candidate.recentReviews) ? candidate.recentReviews.slice(0, MAX_RECENT_REVIEWS) : [],
    meta: {
      ...base.meta,
      ...(candidate.meta || {}),
    },
  };
}

export function loadLocalState(profileKey) {
  const key = storageKey(profileKey);
  try {
    const raw = profileStorage(profileKey).getItem(key);
    return repairState(raw ? JSON.parse(raw) : null);
  } catch (error) {
    console.warn('Не удалось прочитать локальное состояние:', error);
    return createDefaultState();
  }
}

export function saveLocalState(profileKey, state) {
  const key = storageKey(profileKey);
  const snapshot = repairState(safeClone(state));
  snapshot.meta = {
    ...(snapshot.meta || {}),
    lastSavedAt: new Date().toISOString(),
  };

  try {
    profileStorage(profileKey).setItem(key, JSON.stringify(snapshot));
    return snapshot;
  } catch (error) {
    if (Array.isArray(snapshot.recentReviews) && snapshot.recentReviews.length > 100) {
      snapshot.recentReviews = snapshot.recentReviews.slice(0, 100);
      try {
        profileStorage(profileKey).setItem(key, JSON.stringify(snapshot));
        return snapshot;
      } catch {
        // Fall through to the original error.
      }
    }
    throw error;
  }
}

export function clearLocalState(profileKey) {
  const key = storageKey(profileKey);
  localStorage.removeItem(key);
  sessionStorage.removeItem(key);
}

export function scrubLegacyPrivateMetadata() {
  try {
    localStorage.removeItem(LEGACY_SHARED_SHEET_STORAGE_KEY);
    const guestKey = storageKey('guest');
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(STORAGE_PREFIX)) continue;
      if (key !== guestKey) {
        // Old versions persisted authenticated users in localStorage. Remove those
        // caches so a later guest session on a shared browser cannot inspect them.
        localStorage.removeItem(key);
        continue;
      }
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      const repaired = repairState(parsed);
      repaired.meta.lastSavedAt = parsed?.meta?.lastSavedAt || repaired.meta.lastSavedAt;
      localStorage.setItem(key, JSON.stringify(repaired));
    }
  } catch (error) {
    console.warn('Не удалось очистить устаревшие локальные данные:', error);
  }
}

export function appendRecentReview(state, review) {
  return {
    ...state,
    recentReviews: [review, ...(state.recentReviews || [])].slice(0, MAX_RECENT_REVIEWS),
  };
}

export function mergeStates(localState, remoteState) {
  const local = repairState(localState);
  const remote = repairState(remoteState);
  const localSettingsTime = local.meta?.lastSavedAt ? new Date(local.meta.lastSavedAt).getTime() : 0;
  const remoteSettingsTime = remote.meta?.lastSavedAt ? new Date(remote.meta.lastSavedAt).getTime() : 0;
  const preferredSettings = remoteSettingsTime >= localSettingsTime ? remote.settings : local.settings;
  const preferredVocabulary = remote.vocabulary?.words?.length ? remote.vocabulary : local.vocabulary;

  const reviewById = new Map();
  [...(local.recentReviews || []), ...(remote.recentReviews || [])].forEach((review) => {
    const key = review.id || `${review.wordId}:${review.reviewedAt}:${review.direction}`;
    const existing = reviewById.get(key);
    if (!existing || new Date(review.updatedAt || review.reviewedAt).getTime() >= new Date(existing.updatedAt || existing.reviewedAt).getTime()) {
      reviewById.set(key, review);
    }
  });

  return {
    ...local,
    settings: { ...local.settings, ...preferredSettings },
    vocabulary: preferredVocabulary,
    progress: mergeProgressMaps(local.progress, remote.progress),
    daily: mergeDailyMaps(local.daily, remote.daily),
    recentReviews: [...reviewById.values()]
      .sort((a, b) => new Date(b.reviewedAt).getTime() - new Date(a.reviewedAt).getTime())
      .slice(0, MAX_RECENT_REVIEWS),
    meta: {
      ...local.meta,
      ...remote.meta,
      lastRemoteSyncAt: new Date().toISOString(),
    },
  };
}
