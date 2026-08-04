import {
  DEFAULT_LEARNING_SETTINGS,
  mergeDailyMaps,
  mergeProgressMaps,
} from './core.js';

const STORAGE_PREFIX = 'palabra:v2:';
const MAX_RECENT_REVIEWS = 800;

function safeClone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function storageKey(profileKey = 'guest') {
  const safeKey = String(profileKey || 'guest').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${STORAGE_PREFIX}${safeKey}`;
}

export function createDefaultState({ defaultSheetUrl = '', defaultSheetName = '' } = {}) {
  return {
    version: 2,
    settings: {
      ...DEFAULT_LEARNING_SETTINGS,
      sheetUrl: defaultSheetUrl,
      sheetName: defaultSheetName,
      theme: 'system',
    },
    vocabulary: {
      words: [],
      sourceUrl: defaultSheetUrl,
      sourceType: '',
      syncedAt: null,
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

function repairState(candidate, defaults) {
  const base = createDefaultState(defaults);
  if (!candidate || typeof candidate !== 'object') return base;
  return {
    ...base,
    ...candidate,
    version: 2,
    settings: {
      ...base.settings,
      ...(candidate.settings || {}),
    },
    vocabulary: {
      ...base.vocabulary,
      ...(candidate.vocabulary || {}),
      words: Array.isArray(candidate.vocabulary?.words) ? candidate.vocabulary.words : [],
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

export function loadLocalState(profileKey, defaults = {}) {
  const key = storageKey(profileKey);
  try {
    const raw = localStorage.getItem(key);
    return repairState(raw ? JSON.parse(raw) : null, defaults);
  } catch (error) {
    console.warn('Не удалось прочитать локальное состояние:', error);
    return createDefaultState(defaults);
  }
}

export function saveLocalState(profileKey, state) {
  const key = storageKey(profileKey);
  const snapshot = safeClone(state);
  snapshot.meta = {
    ...(snapshot.meta || {}),
    lastSavedAt: new Date().toISOString(),
  };

  try {
    localStorage.setItem(key, JSON.stringify(snapshot));
    return snapshot;
  } catch (error) {
    if (Array.isArray(snapshot.recentReviews) && snapshot.recentReviews.length > 100) {
      snapshot.recentReviews = snapshot.recentReviews.slice(0, 100);
      try {
        localStorage.setItem(key, JSON.stringify(snapshot));
        return snapshot;
      } catch {
        // Fall through to the original error.
      }
    }
    throw error;
  }
}

export function clearLocalState(profileKey) {
  localStorage.removeItem(storageKey(profileKey));
}

export function appendRecentReview(state, review) {
  return {
    ...state,
    recentReviews: [review, ...(state.recentReviews || [])].slice(0, MAX_RECENT_REVIEWS),
  };
}

export function hasMeaningfulProgress(state) {
  return Object.values(state?.progress || {}).some((progress) => Number(progress.totalReviews) > 0);
}

export function isRemoteStateEmpty(remoteState) {
  return !remoteState || Object.keys(remoteState.progress || {}).length === 0;
}

export function mergeStates(localState, remoteState, defaults = {}) {
  const local = repairState(localState, defaults);
  const remote = repairState(remoteState, defaults);
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

export function copyGuestIntoAccount(guestState, accountState, defaults = {}) {
  const guest = repairState(guestState, defaults);
  const account = repairState(accountState, defaults);
  return {
    ...account,
    settings: { ...account.settings, ...guest.settings },
    vocabulary: guest.vocabulary?.words?.length ? guest.vocabulary : account.vocabulary,
    progress: mergeProgressMaps(account.progress, guest.progress),
    daily: mergeDailyMaps(account.daily, guest.daily),
    recentReviews: [...(guest.recentReviews || []), ...(account.recentReviews || [])]
      .sort((a, b) => new Date(b.reviewedAt).getTime() - new Date(a.reviewedAt).getTime())
      .slice(0, MAX_RECENT_REVIEWS),
    meta: {
      ...account.meta,
      lastSavedAt: new Date().toISOString(),
    },
  };
}
