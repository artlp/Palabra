import { APP_CONFIG, isFirebaseConfigured } from './config.js';
import {
  DEFAULT_LEARNING_SETTINGS,
  applyReview,
  buildStudyQueue,
  chooseDirection,
  computeAnalytics,
  createEmptyProgress,
  difficultyScore,
  evaluateAnswer,
  formatPercent,
  formatRelativeDue,
  isDue,
  localDateKey,
  normalizeText,
  ratingLabel,
  updateDailyAggregate,
} from './core.js';
import { loadWordsFromFile, loadWordsFromSource } from './sheets.js';
import {
  appendRecentReview,
  clearLocalState,
  copyGuestIntoAccount,
  createDefaultState,
  hasMeaningfulProgress,
  isRemoteStateEmpty,
  loadLocalState,
  mergeStates,
  saveLocalState,
  storageKey,
} from './local-store.js';
import { createFirebaseClient } from './firebase-adapter.js';

const DEFAULTS = {
  defaultSheetUrl: APP_CONFIG.defaultSheetUrl,
  defaultSheetName: APP_CONFIG.defaultSheetName,
};

const SHARED_SHEET_STORAGE_KEY = 'palabra:shared-sheet:v1';
const SHEETS_ADMIN_UID = String(APP_CONFIG.sheetsAdminUid || '');
const SHEETS_ADMIN_NAME = String(APP_CONFIG.sheetsAdminName || 'администратор');

const VIEW_META = Object.freeze({
  dashboard: { title: 'Обзор', eyebrow: 'Личный словарь' },
  study: { title: 'Карточки', eyebrow: 'Интервальное повторение' },
  words: { title: 'Словарь', eyebrow: 'Все слова' },
  analytics: { title: 'Аналитика', eyebrow: 'Учебный прогресс' },
  settings: { title: 'Настройки', eyebrow: 'Источник и профиль' },
});

const $ = (id) => document.getElementById(id);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function normalizeSharedSheetSettings(candidate = {}) {
  const hasSheetUrl = Object.prototype.hasOwnProperty.call(candidate || {}, 'sheetUrl');
  const hasSheetName = Object.prototype.hasOwnProperty.call(candidate || {}, 'sheetName');
  return {
    exists: candidate?.exists === true,
    sheetUrl: String(hasSheetUrl ? candidate.sheetUrl : DEFAULTS.defaultSheetUrl || '').trim(),
    sheetName: String(hasSheetName ? candidate.sheetName : DEFAULTS.defaultSheetName || '').trim(),
    updatedAt: candidate?.updatedAt || null,
    updatedBy: String(candidate?.updatedBy || ''),
  };
}

function loadCachedSharedSheetSettings() {
  try {
    const raw = localStorage.getItem(SHARED_SHEET_STORAGE_KEY);
    return normalizeSharedSheetSettings(raw ? JSON.parse(raw) : {});
  } catch (error) {
    console.warn('Не удалось прочитать общий источник Google Sheets:', error);
    return normalizeSharedSheetSettings();
  }
}

function saveCachedSharedSheetSettings(settings) {
  try {
    localStorage.setItem(SHARED_SHEET_STORAGE_KEY, JSON.stringify(settings));
  } catch (error) {
    console.warn('Не удалось сохранить общий источник Google Sheets:', error);
  }
}

function sharedSheetKey(settings) {
  return `${String(settings?.sheetUrl || '').trim()}\n${String(settings?.sheetName || '').trim()}`;
}

let profileKey = 'guest';
let appState = loadLocalState(profileKey, DEFAULTS);

const runtime = {
  currentView: 'dashboard',
  user: null,
  firebase: null,
  firebaseStatus: isFirebaseConfigured() ? 'connecting' : 'disabled',
  firebaseError: '',
  vocabularyBusy: false,
  pendingWrites: 0,
  authMode: 'signin',
  study: null,
  selectedWordId: null,
  confirmResolve: null,
  lastSourceMessage: '',
  sourceMessageType: '',
  sheetSettings: loadCachedSharedSheetSettings(),
  sheetSettingsLoaded: !isFirebaseConfigured(),
  sheetSettingsReady: Promise.resolve(),
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function pluralize(number, forms) {
  const value = Math.abs(Number(number) || 0) % 100;
  const last = value % 10;
  if (value > 10 && value < 20) return forms[2];
  if (last > 1 && last < 5) return forms[1];
  if (last === 1) return forms[0];
  return forms[2];
}

function formatDateTime(value) {
  if (!value) return 'ещё не обновлялся';
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return String(value);
  }
}

function formatShortDate(dateKey) {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' })
    .format(new Date(Date.UTC(year, month - 1, day)));
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.round((Number(milliseconds) || 0) / 1000));
  if (seconds < 60) return `${seconds} сек`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} мин ${seconds % 60} сек`;
}

function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = String(value ?? '');
}

function setBusy(button, busy, busyLabel = 'Загрузка…') {
  if (!button) return;
  if (busy) {
    button.dataset.originalLabel = button.textContent;
    button.textContent = busyLabel;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalLabel || button.textContent;
    button.disabled = false;
    delete button.dataset.originalLabel;
  }
}

function persistState() {
  appState = saveLocalState(profileKey, appState);
  return appState;
}

function isSheetsAdmin(user = runtime.user) {
  return Boolean(user?.uid && SHEETS_ADMIN_UID && user.uid === SHEETS_ADMIN_UID);
}

function mirrorSharedSheetSettingsIntoState() {
  appState.settings = appState.settings || {};
  appState.settings.sheetUrl = runtime.sheetSettings.sheetUrl;
  appState.settings.sheetName = runtime.sheetSettings.sheetName;
}

function applySharedSheetSettings(candidate, { persist = true } = {}) {
  const previousKey = sharedSheetKey(runtime.sheetSettings);
  runtime.sheetSettings = normalizeSharedSheetSettings(candidate);
  runtime.sheetSettingsLoaded = true;
  saveCachedSharedSheetSettings(runtime.sheetSettings);
  mirrorSharedSheetSettingsIntoState();
  if (persist) persistState();
  return previousKey !== sharedSheetKey(runtime.sheetSettings);
}

function vocabularyMatchesSharedSheet(state = appState) {
  const expectedKey = sharedSheetKey(runtime.sheetSettings);
  if (String(state.vocabulary?.sourceKey || '').startsWith('local-csv:')) return true;
  if (state.vocabulary?.sourceKey) return state.vocabulary.sourceKey === expectedKey;
  return Boolean(
    state.vocabulary?.words?.length
    && String(state.vocabulary?.sourceUrl || '') === runtime.sheetSettings.sheetUrl
    && !runtime.sheetSettings.sheetName,
  );
}

function firstLegacySheetSettings(...candidates) {
  for (const candidate of candidates) {
    const sheetUrl = String(candidate?.sheetUrl || candidate?.sourceUrl || '').trim();
    const sheetName = String(candidate?.sheetName || '').trim();
    if (sheetUrl || sheetName) return { sheetUrl, sheetName };
  }
  return null;
}

function announce(message) {
  setText('live-region', message);
}

function toast(message, type = 'info', duration = 4200) {
  const region = $('toast-region');
  if (!region) return;
  const item = document.createElement('div');
  item.className = `toast ${type}`;
  item.textContent = message;
  region.append(item);
  window.setTimeout(() => item.remove(), duration);
}

function sourceMessage(message, type = '') {
  runtime.lastSourceMessage = message;
  runtime.sourceMessageType = type;
  renderSourceStatus();
}

async function refreshSharedSheetSettings({ silent = false } = {}) {
  if (!runtime.firebase?.loadSheetSettings) return false;
  try {
    const remote = await runtime.firebase.loadSheetSettings();
    const effective = remote.exists ? remote : {
      exists: false,
      sheetUrl: DEFAULTS.defaultSheetUrl || '',
      sheetName: DEFAULTS.defaultSheetName || '',
      updatedAt: null,
      updatedBy: '',
    };
    const changed = applySharedSheetSettings(effective);
    renderSettings();
    return changed;
  } catch (error) {
    console.error('Shared Google Sheets settings:', error);
    runtime.sheetSettingsLoaded = true;
    if (!silent) {
      toast('Не удалось проверить общий источник Google Sheets. Используется последняя локальная копия.', 'warning', 6000);
    }
    return false;
  }
}

async function refreshAndSyncVocabulary({ silent = false } = {}) {
  if (runtime.vocabularyBusy) return;
  await refreshSharedSheetSettings({ silent: true });
  await syncVocabulary({ silent });
}

function currentTheme() {
  const setting = appState.settings.theme || 'system';
  if (setting === 'system') return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  return setting;
}

function applyTheme() {
  document.documentElement.dataset.theme = currentTheme();
  const themeColor = currentTheme() === 'dark' ? '#191a24' : '#5b5ce2';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColor);
}

function toggleTheme() {
  appState.settings.theme = currentTheme() === 'dark' ? 'light' : 'dark';
  persistState();
  applyTheme();
  renderSettings();
  saveSettingsRemote();
}

function navigate(view) {
  if (!VIEW_META[view]) return;
  runtime.currentView = view;
  $$('[data-view-panel]').forEach((panel) => {
    const active = panel.dataset.viewPanel === view;
    panel.hidden = !active;
    panel.classList.toggle('is-active', active);
  });
  $$('[data-view]').forEach((button) => button.classList.toggle('is-active', button.dataset.view === view));
  setText('view-title', VIEW_META[view].title);
  setText('view-eyebrow', VIEW_META[view].eyebrow);
  window.scrollTo({ top: 0, behavior: 'smooth' });

  if (view === 'words') renderWords();
  if (view === 'analytics') renderAnalytics();
  if (view === 'settings') renderSettings();
  if (view === 'study' && !runtime.study) renderStudyIdle();
}

function syncVisualState(status, detail = '') {
  const dot = $('sidebar-status-dot');
  dot?.classList.remove('is-online', 'is-syncing', 'is-error');

  if (status === 'syncing') {
    dot?.classList.add('is-syncing');
    setText('sidebar-sync-title', 'Синхронизация');
    setText('sidebar-sync-detail', detail || 'Сохраняем изменения');
  } else if (status === 'online') {
    dot?.classList.add('is-online');
    setText('sidebar-sync-title', 'Синхронизировано');
    setText('sidebar-sync-detail', detail || 'Firebase и этот браузер');
  } else if (status === 'error') {
    dot?.classList.add('is-error');
    setText('sidebar-sync-title', 'Ошибка синхронизации');
    setText('sidebar-sync-detail', detail || 'Данные сохранены локально');
  } else {
    setText('sidebar-sync-title', 'Локальный режим');
    setText('sidebar-sync-detail', detail || 'Данные в этом браузере');
  }
}

function updateSyncVisual() {
  if (runtime.pendingWrites > 0 || runtime.firebaseStatus === 'connecting') {
    syncVisualState('syncing', runtime.firebaseStatus === 'connecting' ? 'Подключаем Firebase' : `${runtime.pendingWrites} изменений`);
  } else if (runtime.firebaseStatus === 'error') {
    syncVisualState('error', runtime.firebaseError || 'Проверьте Firebase');
  } else if (runtime.user && runtime.firebaseStatus === 'ready') {
    syncVisualState('online', appState.meta?.lastRemoteSyncAt ? `Обновлено ${formatDateTime(appState.meta.lastRemoteSyncAt)}` : 'Firebase подключён');
  } else {
    syncVisualState('local', isFirebaseConfigured() ? 'Войдите для облачной копии' : 'Firebase не настроен');
  }
}

function queueRemoteOperation(promise, successMessage = '') {
  if (!promise) return;
  runtime.pendingWrites += 1;
  updateSyncVisual();
  Promise.resolve(promise)
    .then(() => {
      appState.meta.lastRemoteSyncAt = new Date().toISOString();
      persistState();
      if (successMessage) toast(successMessage, 'success');
    })
    .catch((error) => {
      console.error(error);
      runtime.firebaseError = error?.friendlyMessage || error?.message || 'Ошибка Firestore';
      toast(`Не удалось синхронизировать: ${runtime.firebaseError}`, 'error');
    })
    .finally(() => {
      runtime.pendingWrites = Math.max(0, runtime.pendingWrites - 1);
      updateSyncVisual();
    });
}

function userInitials(user) {
  const name = user?.displayName || user?.email || 'Г';
  return name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toLocaleUpperCase('ru');
}

function avatarMarkup(user, className = 'avatar') {
  if (user?.photoURL) {
    return `<span class="${className}"><img src="${escapeHtml(user.photoURL)}" alt=""></span>`;
  }
  return `<span class="${className}">${escapeHtml(userInitials(user))}</span>`;
}

function renderAccount() {
  const configured = isFirebaseConfigured();
  $('setup-banner').hidden = configured;

  if (runtime.user) {
    setText('account-name', runtime.user.displayName || runtime.user.email || 'Аккаунт');
    setText('account-detail', runtime.pendingWrites ? 'Синхронизация…' : 'Прогресс в облаке');
    $('account-avatar').innerHTML = runtime.user.photoURL ? `<img src="${escapeHtml(runtime.user.photoURL)}" alt="">` : escapeHtml(userInitials(runtime.user));
  } else {
    setText('account-name', 'Гостевой профиль');
    setText('account-detail', configured ? 'Войти для синхронизации' : 'Локальное хранение');
    $('account-avatar').textContent = 'Г';
  }
  updateSyncVisual();
}

function nextFutureDue(now = Date.now()) {
  const timestamps = Object.values(appState.progress || {})
    .map((progress) => progress?.dueAt ? new Date(progress.dueAt).getTime() : Number.POSITIVE_INFINITY)
    .filter((time) => Number.isFinite(time) && time > now)
    .sort((a, b) => a - b);
  return timestamps[0] || null;
}

function previewQueue(now = Date.now()) {
  const today = localDateKey(now, appState.settings.timeZone);
  return buildStudyQueue(
    appState.vocabulary.words,
    appState.progress,
    appState.settings,
    appState.daily[today] || {},
    now,
  );
}

function renderBarChart(container, series, { showLearned = false, compact = false } = {}) {
  if (!container) return;
  const total = series.reduce((sum, item) => sum + item.reviews + (showLearned ? item.learned : 0), 0);
  if (!total) {
    container.innerHTML = '<div class="chart-empty">Здесь появится история занятий.</div>';
    return;
  }

  const width = compact ? 680 : 920;
  const height = compact ? 230 : 300;
  const padding = { top: 16, right: 12, bottom: 38, left: 34 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const maxValue = Math.max(1, ...series.map((item) => Math.max(item.reviews, showLearned ? item.learned : 0)));
  const groupWidth = innerWidth / series.length;
  const mainWidth = Math.max(4, groupWidth * (showLearned ? 0.5 : 0.64));
  const secondaryWidth = showLearned ? Math.max(2, groupWidth * 0.18) : 0;
  const gridValues = [0, .25, .5, .75, 1].map((ratio) => Math.round(maxValue * ratio));

  const grid = gridValues.map((value) => {
    const y = padding.top + innerHeight - (value / maxValue) * innerHeight;
    return `<line class="grid-line" x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}"></line><text x="${padding.left - 8}" y="${y + 3}" text-anchor="end">${value}</text>`;
  }).join('');

  const bars = series.map((item, index) => {
    const xCenter = padding.left + index * groupWidth + groupWidth / 2;
    const mainHeight = (item.reviews / maxValue) * innerHeight;
    const mainX = xCenter - mainWidth / 2 - (showLearned ? secondaryWidth * .35 : 0);
    const mainY = padding.top + innerHeight - mainHeight;
    const showLabel = series.length <= 14 || index % 3 === 0 || index === series.length - 1;
    const label = showLabel ? `<text x="${xCenter}" y="${height - 13}" text-anchor="middle">${escapeHtml(formatShortDate(item.date))}</text>` : '';
    const secondaryHeight = showLearned ? (item.learned / maxValue) * innerHeight : 0;
    const secondary = showLearned
      ? `<rect class="bar-secondary" x="${mainX + mainWidth - secondaryWidth / 2}" y="${padding.top + innerHeight - secondaryHeight}" width="${secondaryWidth}" height="${Math.max(secondaryHeight, item.learned ? 2 : 0)}"><title>${escapeHtml(formatShortDate(item.date))}: выучено ${item.learned}</title></rect>`
      : '';
    return `<rect class="bar" x="${mainX}" y="${mainY}" width="${mainWidth}" height="${Math.max(mainHeight, item.reviews ? 2 : 0)}"><title>${escapeHtml(formatShortDate(item.date))}: ${item.reviews} повторений</title></rect>${secondary}${label}`;
  }).join('');

  container.innerHTML = `<svg class="bar-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="График учебной активности">${grid}<line class="axis-line" x1="${padding.left}" y1="${padding.top + innerHeight}" x2="${width - padding.right}" y2="${padding.top + innerHeight}"></line>${bars}</svg>`;
}

function emptyRankMarkup(text = 'Нужно хотя бы два ответа на слово.') {
  return `<div class="chart-empty" style="min-height:120px">${escapeHtml(text)}</div>`;
}

function rankMarkup(items, reverseTone = false) {
  if (!items.length) return emptyRankMarkup();
  return items.map((entry, index) => {
    const reviews = Number(entry.progress.totalReviews) || 0;
    const typedRate = reviews ? (Number(entry.progress.typedCorrectReviews) || 0) / reviews : 0;
    return `<div class="rank-item">
      <span class="rank-number">${index + 1}</span>
      <span class="rank-copy"><strong>${escapeHtml(entry.word.spanish)}</strong><small>${escapeHtml(entry.word.russian)}</small></span>
      <span class="rank-score" title="Сводная оценка сложности">${reverseTone ? 'сложн.' : 'точн.'} ${reverseTone ? Math.round(entry.score) : Math.round(typedRate * 100) + '%'}</span>
    </div>`;
  }).join('');
}

function renderDashboard() {
  const analytics = computeAnalytics(appState.vocabulary.words, appState.progress, appState.daily, Date.now(), appState.settings);
  const queue = previewQueue();
  const dailyNew = queue.filter((item) => item.isNew).length;
  const ratio = analytics.totalWords ? analytics.masteredTotal / analytics.totalWords : 0;

  setText('dashboard-kicker', analytics.reviewsToday ? `${analytics.reviewsToday} ответов сегодня` : 'На сегодня');
  if (!analytics.totalWords) {
    setText('dashboard-greeting', 'Подключите свой словарь');
    setText('dashboard-subtitle', 'Можно вставить ссылку Google Sheets или начать со встроенного демо-набора.');
  } else if (queue.length) {
    setText('dashboard-greeting', `${queue.length} ${pluralize(queue.length, ['карточка', 'карточки', 'карточек'])} в плане`);
    setText('dashboard-subtitle', `${analytics.dueNow} к повторению и ${dailyNew} новых. Направление перевода выбирается случайно с приоритетом слабой стороны.`);
  } else {
    const nextDue = nextFutureDue();
    setText('dashboard-greeting', 'На сейчас всё выполнено');
    setText('dashboard-subtitle', nextDue ? `Следующая карточка появится ${formatRelativeDue(nextDue)}.` : 'Добавьте новые слова или увеличьте дневной лимит.');
  }

  setText('mastery-percent', formatPercent(ratio, '0%'));
  $('mastery-ring').style.strokeDashoffset = String(100 - Math.round(ratio * 100));
  setText('metric-due', analytics.dueNow);
  setText('metric-due-note', queue.length ? `${queue.length} в текущем плане` : 'ничего срочного');
  setText('metric-learned-today', analytics.learnedToday);
  setText('metric-learned-week', `${analytics.learnedWeek} за неделю`);
  setText('metric-streak', analytics.streak);
  setText('metric-accuracy', analytics.weekReviews ? formatPercent(analytics.accuracy7) : '—');
  setText('metric-week-reviews', `${analytics.weekReviews} ${pluralize(analytics.weekReviews, ['ответ', 'ответа', 'ответов'])}`);
  setText('activity-total', `${analytics.last14.reduce((sum, item) => sum + item.reviews, 0)} повторений`);

  renderBarChart($('dashboard-chart'), analytics.last14, { compact: true });

  setText('next-focus-number', queue.length);
  if (queue.length) {
    setText('next-focus-title', 'Начать запланированное занятие');
    setText('next-focus-copy', `${analytics.dueNow} повторений, до ${dailyNew} новых слов.`);
  } else {
    const nextDue = nextFutureDue();
    setText('next-focus-title', nextDue ? `Следующее повторение ${formatRelativeDue(nextDue)}` : 'Карточек пока нет');
    setText('next-focus-copy', analytics.totalWords ? 'Можно посмотреть аналитику или обновить таблицу.' : 'Подключите Google Sheets или загрузите CSV.');
  }

  const hardest = analytics.hardest.slice(0, 3);
  $('dashboard-hardest-list').innerHTML = hardest.length
    ? `<span class="mini-list-title">Требуют внимания</span>${hardest.map((entry) => `<div class="mini-item"><div><strong>${escapeHtml(entry.word.spanish)}</strong><small>${escapeHtml(entry.word.russian)}</small></div><span class="mini-score">${Math.round(entry.score)}</span></div>`).join('')}`
    : '<span class="mini-list-title">Требуют внимания</span><div class="chart-empty" style="min-height:80px">Появятся после нескольких ответов.</div>';

  const badge = $('nav-due-badge');
  badge.textContent = String(queue.length);
  badge.hidden = queue.length === 0;
}

function wordStatus(word, progress) {
  if (!progress || !progress.totalReviews) return { key: 'new', label: 'Новое' };
  if (isDue(progress)) return { key: 'due', label: 'Повторить' };
  if (progress.state === 'mastered') return { key: 'mastered', label: 'Освоено' };
  if (progress.state === 'review') return { key: 'review', label: 'Закрепление' };
  return { key: 'learning', label: 'Изучается' };
}

function refreshPartFilter() {
  const select = $('part-filter');
  if (!select) return;
  const current = select.value || 'all';
  const parts = [...new Set(appState.vocabulary.words.map((word) => word.partOfSpeech || 'не указано'))]
    .sort((a, b) => a.localeCompare(b, 'ru'));
  select.innerHTML = `<option value="all">Все части речи</option>${parts.map((part) => `<option value="${escapeHtml(part)}">${escapeHtml(part)}</option>`).join('')}`;
  select.value = parts.includes(current) ? current : 'all';
}

function renderWords() {
  refreshPartFilter();
  const query = normalizeText($('word-search')?.value || '', { stripAccents: true });
  const statusFilter = $('status-filter')?.value || 'all';
  const partFilter = $('part-filter')?.value || 'all';

  const filtered = appState.vocabulary.words.filter((word) => {
    const progress = appState.progress[word.id];
    const status = wordStatus(word, progress);
    const haystack = normalizeText(`${word.spanish} ${word.russian} ${word.partOfSpeech}`, { stripAccents: true });
    return (!query || haystack.includes(query))
      && (statusFilter === 'all' || status.key === statusFilter)
      && (partFilter === 'all' || word.partOfSpeech === partFilter);
  });

  const visible = filtered.slice(0, 600);
  setText('words-heading', appState.vocabulary.sourceType || 'Словарь');
  setText('words-count', filtered.length > visible.length ? `${visible.length} из ${filtered.length} слов` : `${filtered.length} ${pluralize(filtered.length, ['слово', 'слова', 'слов'])}`);
  $('words-empty').hidden = filtered.length > 0;

  $('words-list').innerHTML = visible.map((word) => {
    const progress = appState.progress[word.id];
    const status = wordStatus(word, progress);
    const reviews = Number(progress?.totalReviews) || 0;
    const accuracy = reviews ? (Number(progress.typedCorrectReviews) || 0) / reviews : null;
    return `<div class="word-row" role="button" tabindex="0" data-word-id="${escapeHtml(word.id)}">
      <span class="word-main"><strong>${escapeHtml(word.spanish)}</strong><small>${reviews ? `${reviews} повторений` : 'ещё не показывалось'}</small></span>
      <span class="word-cell-muted">${escapeHtml(word.russian)}</span>
      <span class="word-cell-muted">${escapeHtml(word.partOfSpeech)}</span>
      <span class="status-pill ${status.key}">${status.label}</span>
      <span class="word-cell-muted">${accuracy === null ? '—' : formatPercent(accuracy)}</span>
      <svg class="word-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
    </div>`;
  }).join('');
}

function directionMarkup(label, stats) {
  const reviews = Number(stats.reviews) || 0;
  const accuracy = reviews ? (Number(stats.typedCorrect) || 0) / reviews : 0;
  return `<div class="direction-row">
    <div class="direction-row-top"><strong>${escapeHtml(label)}</strong><span>${reviews ? `${formatPercent(accuracy)} · ${reviews} ответов` : 'нет данных'}</span></div>
    <div class="progress-track"><span style="width:${Math.round(accuracy * 100)}%"></span></div>
  </div>`;
}

function renderAnalytics() {
  const analytics = computeAnalytics(appState.vocabulary.words, appState.progress, appState.daily, Date.now(), appState.settings);
  setText('analytics-total', analytics.totalWords);
  setText('analytics-new', `${analytics.newTotal} новых`);
  setText('analytics-learned', analytics.learnedTotal);
  setText('analytics-learned-week', `${analytics.learnedWeek} за неделю`);
  setText('analytics-mastered', analytics.masteredTotal);
  setText('analytics-accuracy', analytics.weekReviews ? formatPercent(analytics.accuracy7) : '—');

  renderBarChart($('analytics-chart'), analytics.last30, { showLearned: true });
  $('direction-breakdown').innerHTML = [
    directionMarkup('Испанский → русский', analytics.directionTotals['es-ru']),
    directionMarkup('Русский → испанский', analytics.directionTotals['ru-es']),
  ].join('');
  $('easiest-list').innerHTML = rankMarkup(analytics.easiest);
  $('hardest-list').innerHTML = rankMarkup(analytics.hardest, true);

  const parts = analytics.partOfSpeech.slice(0, 12);
  $('part-progress-list').innerHTML = parts.length ? parts.map((part) => {
    const ratio = part.total ? part.mastered / part.total : 0;
    return `<div class="part-row"><strong>${escapeHtml(part.label)}</strong><div class="progress-track"><span style="width:${Math.round(ratio * 100)}%"></span></div><small>${part.mastered} / ${part.total}</small></div>`;
  }).join('') : emptyRankMarkup('Сначала загрузите словарь.');
}

function setFormValue(id, value) {
  const element = $(id);
  if (!element || document.activeElement === element) return;
  if (element.type === 'checkbox') element.checked = Boolean(value);
  else element.value = value ?? '';
}

function renderSourceStatus() {
  const element = $('source-status');
  if (!element) return;
  element.className = `source-status${runtime.sourceMessageType ? ` is-${runtime.sourceMessageType}` : ''}`;
  if (runtime.lastSourceMessage) {
    element.textContent = runtime.lastSourceMessage;
  } else if (appState.vocabulary.words.length) {
    element.textContent = `${appState.vocabulary.words.length} слов · ${appState.vocabulary.sourceType || 'источник'} · обновлено ${formatDateTime(appState.vocabulary.syncedAt)}`;
  } else {
    element.textContent = 'Источник ещё не загружен.';
  }
}

function renderSettings() {
  setFormValue('sheet-url-input', runtime.sheetSettings.sheetUrl || '');
  setFormValue('sheet-name-input', runtime.sheetSettings.sheetName || '');
  setFormValue('daily-new-limit', appState.settings.dailyNewLimit ?? DEFAULT_LEARNING_SETTINGS.dailyNewLimit);
  setFormValue('daily-review-limit', appState.settings.dailyReviewLimit ?? DEFAULT_LEARNING_SETTINGS.dailyReviewLimit);
  setFormValue('answer-tolerance', appState.settings.answerTolerance || 'balanced');
  setFormValue('direction-mode', appState.settings.directionMode || 'adaptive-random');
  setFormValue('accept-accents', appState.settings.acceptAccentMistakes !== false);
  setFormValue('ignore-special-characters', appState.settings.ignoreSpecialCharacters !== false);
  setFormValue('accept-approximate-matches', appState.settings.acceptApproximateMatches !== false);
  setFormValue('theme-select', appState.settings.theme || 'system');
  renderSourceStatus();

  const canEditSource = isSheetsAdmin();
  const sourceUrlInput = $('sheet-url-input');
  const sourceNameInput = $('sheet-name-input');
  const sourceSaveButton = $('save-source-button');
  [sourceUrlInput, sourceNameInput].forEach((input) => {
    if (!input) return;
    input.readOnly = !canEditSource;
    input.setAttribute('aria-readonly', String(!canEditSource));
  });
  if (sourceSaveButton && !sourceSaveButton.dataset.originalLabel) {
    sourceSaveButton.disabled = !canEditSource || !runtime.firebase;
  }
  $('source-settings-form')?.classList.toggle('is-readonly', !canEditSource);

  let permissionNote;
  if (!runtime.sheetSettingsLoaded) {
    permissionNote = 'Загружаем общий источник из Firestore…';
  } else if (canEditSource) {
    permissionNote = `Вы вошли как ${SHEETS_ADMIN_NAME}. Сохранённый источник применяется ко всем пользователям.`;
  } else if (runtime.user) {
    permissionNote = `Общий источник доступен только для чтения. Изменять его может только ${SHEETS_ADMIN_NAME}.`;
  } else {
    permissionNote = `Источник общий для всех пользователей. Для изменения нужно войти как ${SHEETS_ADMIN_NAME}.`;
  }
  if (runtime.sheetSettingsLoaded && !runtime.sheetSettings.exists) {
    permissionNote += ' Документ настроек ещё не создан; сейчас используется источник по умолчанию.';
  }
  setText('source-permission-note', permissionNote);

  const container = $('account-settings');
  if (runtime.user) {
    container.innerHTML = `<div class="account-settings-row">${avatarMarkup(runtime.user)}<div><strong>${escapeHtml(runtime.user.displayName || runtime.user.email || 'Аккаунт')}</strong><span>${escapeHtml(runtime.user.email || '')}</span></div></div><p>Карточки, дневная статистика и настройки синхронизируются с Firestore. Локальная копия остаётся для быстрого запуска.</p>`;
    setText('settings-auth-button', 'Выйти');
  } else if (isFirebaseConfigured()) {
    container.innerHTML = '<div class="account-settings-row"><span class="avatar">Г</span><div><strong>Гостевой профиль</strong><span>Только этот браузер</span></div></div><p>После входа локальный прогресс переносится в новый пустой профиль автоматически.</p>';
    setText('settings-auth-button', 'Войти');
  } else {
    container.innerHTML = '<div class="account-settings-row"><span class="avatar">!</span><div><strong>Firebase не настроен</strong><span>Вход временно недоступен</span></div></div><p>Заполните объект <code>firebase</code> в <code>js/config.js</code> и добавьте домен GitHub Pages в Authorized domains.</p>';
    setText('settings-auth-button', 'Как подключить');
  }
}

function renderStudyIdle() {
  $('study-empty').hidden = false;
  $('study-session').hidden = true;
  $('study-complete').hidden = true;
}

function renderGlobal() {
  renderAccount();
  renderDashboard();
  renderSettings();
  if (runtime.currentView === 'words') renderWords();
  if (runtime.currentView === 'analytics') renderAnalytics();
}

async function syncVocabulary({ silent = false } = {}) {
  if (runtime.vocabularyBusy) return;
  runtime.vocabularyBusy = true;
  $('sync-button-top')?.classList.add('is-spinning');
  sourceMessage('Загружаем словарь…');

  try {
    const source = runtime.sheetSettings;
    const result = await loadWordsFromSource(source.sheetUrl, {
      sheetName: source.sheetName,
      fallbackUrl: './data/demo-words.csv',
    });
    appState.vocabulary = {
      words: result.words,
      sourceUrl: source.sheetUrl || '',
      sourceSheetName: source.sheetName || '',
      sourceKey: sharedSheetKey(source),
      sourceType: source.sheetUrl ? result.sourceType : 'Демо-словарь',
      syncedAt: result.syncedAt,
    };
    persistState();
    sourceMessage(`${result.words.length} слов загружено из ${appState.vocabulary.sourceType}.`, 'success');
    renderGlobal();
    if (!silent) toast(`Словарь обновлён: ${result.words.length} слов.`, 'success');
  } catch (error) {
    console.error(error);
    sourceMessage(error.message || 'Не удалось загрузить словарь.', 'error');
    if (!silent) toast(error.message || 'Не удалось загрузить словарь.', 'error');
  } finally {
    runtime.vocabularyBusy = false;
    $('sync-button-top')?.classList.remove('is-spinning');
  }
}

async function importCsv(file) {
  try {
    sourceMessage('Читаем CSV…');
    const result = await loadWordsFromFile(file);
    appState.vocabulary = {
      words: result.words,
      sourceUrl: '',
      sourceSheetName: '',
      sourceKey: `local-csv:${file?.name || 'file'}`,
      sourceType: result.sourceType,
      syncedAt: result.syncedAt,
    };
    persistState();
    sourceMessage(`${result.words.length} слов загружено из локального CSV.`, 'success');
    renderGlobal();
    toast('CSV импортирован. Для синхронизации между устройствами лучше использовать Google Sheets.', 'success', 6000);
  } catch (error) {
    sourceMessage(error.message || 'Ошибка CSV.', 'error');
    toast(error.message || 'Ошибка CSV.', 'error');
  } finally {
    $('csv-file-input').value = '';
  }
}

function nextCardStateLabel(progress, isNew) {
  if (isNew || !progress?.totalReviews) return 'Новое слово';
  if (isDue(progress)) return 'Повторение';
  if (progress.state === 'mastered') return 'Освоено';
  return 'Закрепление';
}

function updateSessionHeader() {
  const session = runtime.study;
  if (!session) return;
  const remaining = session.queue.length + (session.current ? 1 : 0);
  const planned = Math.max(1, session.reviewed + remaining);
  const percent = Math.min(100, Math.round((session.reviewed / planned) * 100));
  setText('session-count', `Ответ ${session.reviewed + 1} · осталось ${remaining}`);
  setText('session-score', `${session.accepted} принято`);
  $('session-progress-bar').style.width = `${percent}%`;
}

function startStudy() {
  if (!appState.vocabulary.words.length) {
    toast('Сначала загрузите словарь.', 'warning');
    navigate('settings');
    return;
  }

  const now = Date.now();
  const today = localDateKey(now, appState.settings.timeZone);
  const queue = buildStudyQueue(
    appState.vocabulary.words,
    appState.progress,
    appState.settings,
    appState.daily[today] || {},
    now,
  );

  runtime.study = {
    queue,
    current: null,
    phase: 'question',
    reviewed: 0,
    accepted: 0,
    newCount: 0,
    startedAt: now,
  };
  navigate('study');

  if (!queue.length) {
    showStudyComplete(true);
    return;
  }
  $('study-empty').hidden = true;
  $('study-complete').hidden = true;
  $('study-session').hidden = false;
  showNextCard();
}

function showNextCard() {
  const session = runtime.study;
  if (!session) return renderStudyIdle();
  if (!session.queue.length) return showStudyComplete(false);

  const item = session.queue.shift();
  const word = appState.vocabulary.words.find((candidate) => candidate.id === item.wordId);
  if (!word) return showNextCard();
  const progress = appState.progress[word.id] || createEmptyProgress(word.id);
  const direction = chooseDirection(progress, Math.random, appState.settings.directionMode);
  const prompt = direction === 'es-ru' ? word.spanish : word.russian;
  const expected = direction === 'es-ru' ? word.russian : word.spanish;

  session.current = {
    item,
    word,
    progress,
    direction,
    prompt,
    expected,
    startedAt: performance.now(),
    responseMs: null,
    hintUsed: false,
    evaluation: null,
    typedAnswer: '',
    suggestedRating: 2,
  };
  session.phase = 'question';

  setText('card-direction', direction === 'es-ru' ? 'Испанский → русский' : 'Русский → испанский');
  setText('card-state', nextCardStateLabel(progress, item.isNew));
  setText('card-prompt', prompt);
  setText('card-part', word.partOfSpeech || 'не указано');
  $('answer-input').value = '';
  $('answer-input').disabled = false;
  $('check-answer-button').disabled = false;
  $('answer-form').hidden = false;
  $('feedback-panel').hidden = true;
  $('hint-button').disabled = false;
  $('hint-button').textContent = 'Показать первую букву';
  $$('.rating-button').forEach((button) => button.classList.remove('is-suggested'));
  updateSessionHeader();
  window.setTimeout(() => $('answer-input').focus(), 30);
}

function hintText(expected) {
  const firstVariant = String(expected).split(/[;|/\n]/)[0].trim();
  return firstVariant.split(/\s+/).map((part) => `${part.slice(0, 1)}${'·'.repeat(Math.min(5, Math.max(1, part.length - 1)))}`).join(' ');
}

function showHint() {
  const current = runtime.study?.current;
  if (!current || runtime.study.phase !== 'question') return;
  current.hintUsed = true;
  $('hint-button').textContent = `Подсказка: ${hintText(current.expected)}`;
  $('hint-button').disabled = true;
  $('answer-input').focus();
}

function feedbackFor(evaluation, typedAnswer) {
  if (evaluation.status === 'correct') return { tone: 'correct', icon: '✓', title: 'Верно', copy: 'Ответ совпал с переводом.' };
  if (evaluation.status === 'correct-accent') return { tone: 'correct', icon: '✓', title: 'Верно, но проверьте ударение', copy: 'Акцент или диакритический знак пропущен.' };
  if (evaluation.status === 'correct-article') return { tone: 'correct', icon: '✓', title: 'Верно', copy: 'Разница только в испанском артикле.' };
  if (evaluation.status === 'correct-special') return { tone: 'correct', icon: '✓', title: 'Верно', copy: 'Специальные символы при проверке не учитывались.' };
  if (evaluation.status === 'correct-approximate') return { tone: 'correct', icon: '≈', title: 'Засчитано', copy: 'Ответ принят как примерное совпадение.' };
  if (evaluation.status === 'almost') return { tone: 'almost', icon: '~', title: 'Почти', copy: `Похоже на правильный ответ: «${typedAnswer}». Проверьте написание.` };
  return { tone: 'wrong', icon: '×', title: 'Пока неверно', copy: typedAnswer ? `Ваш ответ: «${typedAnswer}».` : 'Ответ не был введён.' };
}

function checkCurrentAnswer(event) {
  event?.preventDefault();
  const session = runtime.study;
  const current = session?.current;
  if (!current || session.phase !== 'question') return;
  const typedAnswer = $('answer-input').value.trim();
  if (!typedAnswer) {
    toast('Введите перевод или воспользуйтесь подсказкой.', 'warning');
    $('answer-input').focus();
    return;
  }

  const evaluation = evaluateAnswer(typedAnswer, current.expected, appState.settings);
  current.typedAnswer = typedAnswer;
  current.evaluation = evaluation;
  current.responseMs = Math.max(0, Math.round(performance.now() - current.startedAt));
  current.suggestedRating = evaluation.accepted ? (current.hintUsed ? 1 : 2) : evaluation.status === 'almost' ? 1 : 0;
  session.phase = 'rating';

  const feedback = feedbackFor(evaluation, typedAnswer);
  const result = $('feedback-panel').querySelector('.feedback-result');
  result.classList.toggle('is-wrong', feedback.tone === 'wrong');
  result.classList.toggle('is-almost', feedback.tone === 'almost');
  setText('feedback-icon', feedback.icon);
  setText('feedback-title', feedback.title);
  setText('feedback-copy', feedback.copy);
  setText('expected-answer', current.expected);
  const example = current.word.example || current.word.notes;
  $('card-example').hidden = !example;
  setText('card-example', example ? `Пример: ${example}` : '');
  $('answer-input').disabled = true;
  $('check-answer-button').disabled = true;
  $('feedback-panel').hidden = false;
  const suggested = document.querySelector(`[data-rating="${current.suggestedRating}"]`);
  suggested?.classList.add('is-suggested');
  suggested?.focus({ preventScroll: true });
  announce(`${feedback.title}. Правильный ответ: ${current.expected}`);
}

function createReviewId() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `r_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function rateCurrent(rating) {
  const session = runtime.study;
  const current = session?.current;
  if (!current || session.phase !== 'rating') return;
  session.phase = 'saving';
  const previous = appState.progress[current.word.id] || createEmptyProgress(current.word.id);
  const wasNew = !previous.totalReviews;
  const reviewedAt = new Date().toISOString();
  const next = applyReview(previous, {
    wordId: current.word.id,
    rating,
    responseMs: current.responseMs,
    direction: current.direction,
    typedCorrect: current.evaluation.accepted,
    answerStatus: current.evaluation.status,
  }, Date.now());

  const review = {
    id: createReviewId(),
    wordId: current.word.id,
    direction: current.direction,
    prompt: current.prompt,
    expectedAnswer: current.expected,
    typedAnswer: current.typedAnswer,
    answerStatus: current.evaluation.status,
    typedCorrect: current.evaluation.accepted,
    rating: Number(rating),
    ratingLabel: ratingLabel(rating),
    responseMs: current.responseMs,
    hintUsed: current.hintUsed,
    wasNew,
    becameLearned: !previous.learnedAt && Boolean(next.learnedAt),
    becameMastered: !previous.masteredAt && Boolean(next.masteredAt),
    reviewedAt,
    date: localDateKey(reviewedAt, appState.settings.timeZone),
    updatedAt: reviewedAt,
  };
  const daily = updateDailyAggregate(appState.daily[review.date], review, appState.settings.timeZone);

  appState.progress[current.word.id] = next;
  appState.daily[review.date] = daily;
  appState = appendRecentReview(appState, review);
  persistState();

  session.reviewed += 1;
  session.accepted += current.evaluation.accepted ? 1 : 0;
  session.newCount += wasNew ? 1 : 0;
  if (Number(rating) === 0) {
    const insertAt = Math.min(2, session.queue.length);
    session.queue.splice(insertAt, 0, { wordId: current.word.id, isNew: false, reason: 'repeat' });
  }
  session.current = null;

  if (runtime.user && runtime.firebase) {
    queueRemoteOperation(runtime.firebase.saveReview(runtime.user.uid, { progress: next, daily, review }));
  }
  renderDashboard();
  window.setTimeout(showNextCard, 120);
}

function showStudyComplete(noCards) {
  const session = runtime.study || { reviewed: 0, accepted: 0, newCount: 0 };
  $('study-empty').hidden = true;
  $('study-session').hidden = true;
  $('study-complete').hidden = false;
  if (noCards) {
    const nextDue = nextFutureDue();
    setText('completion-copy', nextDue ? `Новых карточек по лимиту нет. Следующее повторение ${formatRelativeDue(nextDue)}.` : 'Новых и просроченных карточек сейчас нет.');
  } else {
    setText('completion-copy', `Занятие заняло ${formatDuration(Date.now() - session.startedAt)}.`);
  }
  setText('completion-reviewed', session.reviewed);
  setText('completion-correct', session.accepted);
  setText('completion-new', session.newCount);
  renderGlobal();
}

function exitStudy() {
  runtime.study = null;
  renderStudyIdle();
  navigate('dashboard');
}

function openWordDialog(wordId) {
  const word = appState.vocabulary.words.find((candidate) => candidate.id === wordId);
  if (!word) return;
  runtime.selectedWordId = wordId;
  const progress = appState.progress[wordId] || createEmptyProgress(wordId);
  const reviews = Number(progress.totalReviews) || 0;
  const accuracy = reviews ? (Number(progress.typedCorrectReviews) || 0) / reviews : null;
  const average = reviews ? (Number(progress.totalResponseMs) || 0) / reviews : 0;
  const status = wordStatus(word, progress);

  setText('word-modal-part', word.partOfSpeech || 'не указано');
  setText('word-modal-spanish', word.spanish);
  setText('word-modal-russian', word.russian);
  const example = word.example || word.notes;
  $('word-modal-example').hidden = !example;
  setText('word-modal-example', example || '');
  $('word-modal-stats').innerHTML = [
    ['Статус', status.label],
    ['Повторений', reviews],
    ['Точность', accuracy === null ? '—' : formatPercent(accuracy)],
    ['Средний ответ', reviews ? formatDuration(average) : '—'],
    ['Интервал', progress.intervalDays ? `${Math.round(progress.intervalDays)} дн.` : '—'],
    ['Сложность', reviews ? Math.round(difficultyScore(progress)) : '—'],
  ].map(([label, value]) => `<div class="word-stat"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`).join('');
  $('word-dialog').showModal();
}

function confirmAction({ title, copy, confirmLabel = 'Подтвердить' }) {
  setText('confirm-title', title);
  setText('confirm-copy', copy);
  setText('confirm-accept', confirmLabel);
  $('confirm-dialog').showModal();
  return new Promise((resolve) => { runtime.confirmResolve = resolve; });
}

function settleConfirm(value) {
  if ($('confirm-dialog').open) $('confirm-dialog').close();
  runtime.confirmResolve?.(value);
  runtime.confirmResolve = null;
}

async function resetAllProgress() {
  const confirmed = await confirmAction({
    title: 'Сбросить весь прогресс?',
    copy: 'Будут удалены интервалы, история ответов и аналитика. Словарь и настройки источника останутся.',
    confirmLabel: 'Удалить прогресс',
  });
  if (!confirmed) return;

  appState.progress = {};
  appState.daily = {};
  appState.recentReviews = [];
  persistState();
  if (runtime.user && runtime.firebase) {
    queueRemoteOperation(runtime.firebase.deleteProgress(runtime.user.uid), 'Облачный прогресс удалён.');
  }
  runtime.study = null;
  renderStudyIdle();
  renderGlobal();
  toast('Учебный прогресс сброшен.', 'success');
}

async function resetSelectedWord() {
  const wordId = runtime.selectedWordId;
  const word = appState.vocabulary.words.find((candidate) => candidate.id === wordId);
  if (!word) return;
  const confirmed = await confirmAction({
    title: `Сбросить «${word.spanish}»?`,
    copy: 'Карточка снова станет новой. Исторические дневные показатели сохранятся.',
    confirmLabel: 'Сбросить слово',
  });
  if (!confirmed) return;
  delete appState.progress[wordId];
  persistState();
  if (runtime.user && runtime.firebase?.deleteCardProgress) {
    queueRemoteOperation(runtime.firebase.deleteCardProgress(runtime.user.uid, wordId));
  }
  $('word-dialog').close();
  renderGlobal();
  renderWords();
  toast('Карточка сброшена.', 'success');
}

function exportData() {
  const payload = {
    exportedAt: new Date().toISOString(),
    app: 'Palabra',
    profile: runtime.user ? { uid: runtime.user.uid, email: runtime.user.email } : { mode: 'guest' },
    state: appState,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `palabra-progress-${localDateKey()}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function setAuthMode(mode) {
  runtime.authMode = mode === 'register' ? 'register' : 'signin';
  $$('[data-auth-mode]').forEach((button) => button.classList.toggle('is-active', button.dataset.authMode === runtime.authMode));
  setText('email-auth-submit', runtime.authMode === 'register' ? 'Создать аккаунт' : 'Войти');
  $('auth-password').autocomplete = runtime.authMode === 'register' ? 'new-password' : 'current-password';
  $('reset-password-button').hidden = runtime.authMode === 'register';
  setText('auth-note', runtime.authMode === 'register' ? 'Минимальная длина пароля — 8 символов.' : 'После входа данные сохраняются в вашей ветке Firestore.');
}

function openAuthDialog() {
  if (!isFirebaseConfigured() || !runtime.firebase) {
    navigate('settings');
    toast('Сначала заполните Firebase config в js/config.js.', 'warning', 6000);
    return;
  }
  setAuthMode('signin');
  $('auth-dialog').showModal();
}

async function handleGoogleAuth() {
  if (!runtime.firebase) return;
  const button = $('google-auth-button');
  setBusy(button, true, 'Открываем Google…');
  try {
    await runtime.firebase.signInGoogle();
  } catch (error) {
    if (error?.code === 'auth/popup-blocked') {
      await runtime.firebase.signInGoogleRedirect();
      return;
    }
    toast(error.friendlyMessage || error.message || 'Ошибка входа.', 'error');
  } finally {
    setBusy(button, false);
  }
}

async function handleEmailAuth(event) {
  event.preventDefault();
  if (!runtime.firebase) return;
  const email = $('auth-email').value.trim();
  const password = $('auth-password').value;
  const button = $('email-auth-submit');
  setBusy(button, true, runtime.authMode === 'register' ? 'Создаём…' : 'Входим…');
  try {
    if (runtime.authMode === 'register') await runtime.firebase.registerEmail(email, password);
    else await runtime.firebase.signInEmail(email, password);
  } catch (error) {
    toast(error.friendlyMessage || error.message || 'Ошибка входа.', 'error');
  } finally {
    setBusy(button, false);
  }
}

async function resetPassword() {
  if (!runtime.firebase) return;
  const email = $('auth-email').value.trim();
  if (!email) {
    toast('Сначала укажите email.', 'warning');
    $('auth-email').focus();
    return;
  }
  try {
    await runtime.firebase.resetPassword(email);
    toast('Письмо для восстановления отправлено.', 'success');
  } catch (error) {
    toast(error.friendlyMessage || error.message || 'Не удалось отправить письмо.', 'error');
  }
}

async function signOutUser() {
  if (!runtime.firebase) return;
  await runtime.firebase.signOut();
}

async function accountButtonAction() {
  if (runtime.user) {
    navigate('settings');
    return;
  }
  openAuthDialog();
}

async function settingsAuthAction() {
  if (!isFirebaseConfigured()) {
    toast('Откройте js/config.js и вставьте Firebase web config.', 'warning', 6000);
  } else if (runtime.user) {
    await signOutUser();
  } else {
    openAuthDialog();
  }
}

async function handleAuthChange(user) {
  runtime.user = user || null;
  runtime.firebaseStatus = 'ready';
  runtime.firebaseError = '';

  if (!user) {
    profileKey = 'guest';
    appState = loadLocalState(profileKey, DEFAULTS);
    mirrorSharedSheetSettingsIntoState();
    persistState();
    if ($('auth-dialog').open) $('auth-dialog').close();
    if (!appState.vocabulary.words.length || !vocabularyMatchesSharedSheet()) {
      await syncVocabulary({ silent: true });
    }
    renderGlobal();
    return;
  }

  if ($('auth-dialog').open) $('auth-dialog').close();
  profileKey = user.uid;
  const guestState = loadLocalState('guest', DEFAULTS);
  const localAccount = loadLocalState(profileKey, DEFAULTS);
  runtime.pendingWrites += 1;
  updateSyncVisual();

  try {
    const remoteState = await runtime.firebase.loadUserState(user.uid);
    let migratedSource = false;

    if (isSheetsAdmin(user) && !runtime.sheetSettings.exists) {
      const legacySource = firstLegacySheetSettings(
        remoteState.legacySheetSettings,
        localAccount.settings,
        guestState.settings,
      );
      if (legacySource) {
        try {
          const savedSource = await runtime.firebase.saveSheetSettings(user, legacySource);
          applySharedSheetSettings(savedSource, { persist: false });
          migratedSource = true;
        } catch (migrationError) {
          console.warn('Legacy Google Sheets migration:', migrationError);
          applySharedSheetSettings({ ...legacySource, exists: false }, { persist: false });
          toast('Старый источник найден, но Firestore пока не разрешил перенести его в общие настройки. Опубликуйте обновлённые правила.', 'warning', 8000);
        }
      }
    }

    let merged = mergeStates(localAccount, remoteState, DEFAULTS);
    let migrated = false;

    if (isRemoteStateEmpty(remoteState) && !hasMeaningfulProgress(localAccount) && hasMeaningfulProgress(guestState)) {
      merged = copyGuestIntoAccount(guestState, merged, DEFAULTS);
      migrated = true;
    }
    if (!merged.vocabulary.words.length && guestState.vocabulary.words.length && vocabularyMatchesSharedSheet(guestState)) {
      merged.vocabulary = guestState.vocabulary;
    }

    appState = merged;
    mirrorSharedSheetSettingsIntoState();
    persistState();
    if (!appState.vocabulary.words.length || !vocabularyMatchesSharedSheet()) {
      await syncVocabulary({ silent: true });
    }
    await runtime.firebase.syncFullState(user, appState);
    appState.meta.lastRemoteSyncAt = new Date().toISOString();
    persistState();
    if (migrated) toast('Локальный прогресс перенесён в аккаунт.', 'success', 6000);
    if (migratedSource) toast('Источник Google Sheets перенесён в общие настройки.', 'success', 6000);
  } catch (error) {
    console.error(error);
    runtime.firebaseError = error.message || 'Ошибка загрузки профиля';
    runtime.firebaseStatus = 'error';
    appState = localAccount;
    mirrorSharedSheetSettingsIntoState();
    if (!appState.vocabulary.words.length && guestState.vocabulary.words.length && vocabularyMatchesSharedSheet(guestState)) {
      appState.vocabulary = guestState.vocabulary;
    }
    persistState();
    if (!appState.vocabulary.words.length || !vocabularyMatchesSharedSheet()) {
      await syncVocabulary({ silent: true });
    }
    toast('Не удалось получить облачный прогресс. Используется локальная копия.', 'error', 6000);
  } finally {
    runtime.pendingWrites = Math.max(0, runtime.pendingWrites - 1);
    renderGlobal();
  }
}

async function initializeFirebase() {
  if (!isFirebaseConfigured()) {
    runtime.firebaseStatus = 'disabled';
    runtime.sheetSettingsLoaded = true;
    mirrorSharedSheetSettingsIntoState();
    persistState();
    renderAccount();
    return;
  }

  runtime.firebaseStatus = 'connecting';
  updateSyncVisual();
  let resolveSheetSettingsReady = () => {};
  runtime.sheetSettingsReady = new Promise((resolve) => { resolveSheetSettingsReady = resolve; });
  try {
    runtime.firebase = await createFirebaseClient(APP_CONFIG.firebase, (user) => (
      runtime.sheetSettingsReady
        .then(() => handleAuthChange(user))
        .catch((error) => console.error('Auth state:', error))
    ));
    await refreshSharedSheetSettings({ silent: true });
  } catch (error) {
    console.error(error);
    runtime.firebaseStatus = 'error';
    runtime.firebaseError = error.message || 'Не удалось инициализировать Firebase';
    renderAccount();
    toast('Firebase не подключился. Локальный режим продолжает работать.', 'error', 6000);
  } finally {
    runtime.sheetSettingsLoaded = true;
    resolveSheetSettingsReady();
  }

  if (runtime.firebase?.authReady) {
    await runtime.firebase.authReady;
  }
}

function saveSettingsRemote() {
  if (runtime.user && runtime.firebase) queueRemoteOperation(runtime.firebase.saveSettings(runtime.user.uid, appState));
}

async function handleSourceSettings(event) {
  event.preventDefault();
  if (!runtime.firebase || !runtime.user) {
    toast(`Для изменения общего источника войдите как ${SHEETS_ADMIN_NAME}.`, 'warning', 6000);
    if (runtime.firebase) openAuthDialog();
    return;
  }
  if (!isSheetsAdmin()) {
    toast(`Изменять общий источник Google Sheets может только ${SHEETS_ADMIN_NAME}.`, 'error', 6000);
    renderSettings();
    return;
  }

  const button = $('save-source-button');
  const nextSettings = {
    sheetUrl: $('sheet-url-input').value.trim(),
    sheetName: $('sheet-name-input').value.trim(),
  };
  setBusy(button, true, 'Сохраняем…');
  try {
    const saved = await runtime.firebase.saveSheetSettings(runtime.user, nextSettings);
    applySharedSheetSettings(saved);
    await syncVocabulary({ silent: true });
    toast('Общий источник Google Sheets сохранён для всех пользователей.', 'success', 6000);
  } catch (error) {
    console.error(error);
    const permissionDenied = String(error?.code || '').includes('permission-denied');
    toast(
      permissionDenied
        ? 'Firestore отклонил изменение. Опубликуйте обновлённый файл firestore.rules и проверьте UID администратора.'
        : error?.message || 'Не удалось сохранить общий источник.',
      'error',
      8000,
    );
  } finally {
    setBusy(button, false);
    renderSettings();
  }
}

function handleLearningSettings(event) {
  event.preventDefault();
  appState.settings.dailyNewLimit = Math.max(0, Math.min(200, Number($('daily-new-limit').value) || 0));
  appState.settings.dailyReviewLimit = Math.max(1, Math.min(1000, Number($('daily-review-limit').value) || 1));
  appState.settings.answerTolerance = $('answer-tolerance').value;
  appState.settings.directionMode = $('direction-mode').value;
  appState.settings.acceptAccentMistakes = $('accept-accents').checked;
  appState.settings.ignoreSpecialCharacters = $('ignore-special-characters').checked;
  appState.settings.acceptApproximateMatches = $('accept-approximate-matches').checked;
  appState.settings.theme = $('theme-select').value;
  persistState();
  applyTheme();
  saveSettingsRemote();
  renderGlobal();
  toast('Параметры занятий сохранены.', 'success');
}

function bindEvents() {
  document.addEventListener('click', (event) => {
    const viewButton = event.target.closest('[data-view]');
    if (viewButton) navigate(viewButton.dataset.view);
  });

  $('theme-toggle').addEventListener('click', toggleTheme);
  $('sync-button-top').addEventListener('click', () => refreshAndSyncVocabulary());
  $('dashboard-sync-button').addEventListener('click', () => refreshAndSyncVocabulary());
  $('words-sync-button').addEventListener('click', () => refreshAndSyncVocabulary());
  $('top-start-button').addEventListener('click', startStudy);
  $('start-study-button').addEventListener('click', startStudy);
  $('study-empty-start').addEventListener('click', startStudy);
  $('completion-more').addEventListener('click', startStudy);
  $('exit-study-button').addEventListener('click', exitStudy);
  $('answer-form').addEventListener('submit', checkCurrentAnswer);
  $('hint-button').addEventListener('click', showHint);
  $$('.rating-button').forEach((button) => button.addEventListener('click', () => rateCurrent(Number(button.dataset.rating))));

  $('word-search').addEventListener('input', renderWords);
  $('status-filter').addEventListener('change', renderWords);
  $('part-filter').addEventListener('change', renderWords);
  $('words-list').addEventListener('click', (event) => {
    const row = event.target.closest('[data-word-id]');
    if (row) openWordDialog(row.dataset.wordId);
  });
  $('words-list').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('[data-word-id]');
    if (row) {
      event.preventDefault();
      openWordDialog(row.dataset.wordId);
    }
  });

  $('source-settings-form').addEventListener('submit', handleSourceSettings);
  $('learning-settings-form').addEventListener('submit', handleLearningSettings);
  $('csv-file-input').addEventListener('change', (event) => importCsv(event.target.files?.[0]));
  $('account-button').addEventListener('click', accountButtonAction);
  $('settings-auth-button').addEventListener('click', settingsAuthAction);
  $('export-data-button').addEventListener('click', exportData);
  $('reset-progress-button').addEventListener('click', resetAllProgress);
  $('reset-word-button').addEventListener('click', resetSelectedWord);

  $$('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => $(button.dataset.closeDialog)?.close()));
  $$('[data-auth-mode]').forEach((button) => button.addEventListener('click', () => setAuthMode(button.dataset.authMode)));
  $('google-auth-button').addEventListener('click', handleGoogleAuth);
  $('email-auth-form').addEventListener('submit', handleEmailAuth);
  $('reset-password-button').addEventListener('click', resetPassword);
  $('confirm-cancel').addEventListener('click', () => settleConfirm(false));
  $('confirm-accept').addEventListener('click', () => settleConfirm(true));
  $('confirm-dialog').addEventListener('cancel', (event) => { event.preventDefault(); settleConfirm(false); });

  document.addEventListener('keydown', (event) => {
    if (runtime.currentView !== 'study' || runtime.study?.phase !== 'rating') return;
    if (/^[1-4]$/.test(event.key)) {
      event.preventDefault();
      rateCurrent(Number(event.key) - 1);
    }
  });

  window.addEventListener('storage', (event) => {
    if (event.key !== storageKey(profileKey)) return;
    appState = loadLocalState(profileKey, DEFAULTS);
    renderGlobal();
  });

  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (appState.settings.theme === 'system') applyTheme();
  });
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  try {
    await navigator.serviceWorker.register('./sw.js');
  } catch (error) {
    console.warn('Service worker:', error);
  }
}

async function init() {
  applyTheme();
  bindEvents();
  setAuthMode('signin');
  renderStudyIdle();
  renderGlobal();
  navigate('dashboard');

  await initializeFirebase();
  if (!appState.vocabulary.words.length || !vocabularyMatchesSharedSheet()) {
    await syncVocabulary({ silent: true });
  }
  registerServiceWorker();
}

init().catch((error) => {
  console.error(error);
  toast(`Ошибка запуска: ${error.message}`, 'error', 8000);
});
