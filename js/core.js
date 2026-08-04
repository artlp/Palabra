const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export const DEFAULT_LEARNING_SETTINGS = Object.freeze({
  dailyNewLimit: 20,
  dailyReviewLimit: 200,
  acceptAccentMistakes: true,
  answerTolerance: 'balanced',
  directionMode: 'adaptive-random',
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Madrid',
});

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function shuffle(items, random = Math.random) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

export function localDateKey(value = Date.now(), timeZone = DEFAULT_LEARNING_SETTINGS.timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat('en', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function dateKeyOffset(days, now = Date.now(), timeZone = DEFAULT_LEARNING_SETTINGS.timeZone) {
  return localDateKey(now + days * DAY_MS, timeZone);
}

export function dateKeyToUtcNumber(key) {
  const [year, month, day] = String(key).split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

export function formatRelativeDue(dueAt, now = Date.now()) {
  if (!dueAt) return 'сейчас';
  const delta = new Date(dueAt).getTime() - now;
  if (delta <= 30_000) return 'сейчас';
  if (delta < 60 * MINUTE_MS) return `через ${Math.max(1, Math.round(delta / MINUTE_MS))} мин`;
  if (delta < DAY_MS) return `через ${Math.max(1, Math.round(delta / (60 * MINUTE_MS)))} ч`;
  const days = Math.max(1, Math.round(delta / DAY_MS));
  return `через ${days} дн.`;
}

function countOutsideQuotes(line, delimiter) {
  let count = 0;
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && char === delimiter) {
      count += 1;
    }
  }
  return count;
}

export function detectDelimiter(text) {
  const firstLogicalLine = String(text).split(/\r?\n/).find((line) => line.trim()) || '';
  const candidates = [',', ';', '\t'];
  return candidates
    .map((delimiter) => ({ delimiter, count: countOutsideQuotes(firstLogicalLine, delimiter) }))
    .sort((a, b) => b.count - a.count)[0]?.delimiter || ',';
}

export function parseDelimited(text, delimiter = detectDelimiter(text)) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field.trim());
      field = '';
    } else if (char === '\n') {
      row.push(field.trim());
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  row.push(field.trim());
  if (row.some((cell) => cell !== '')) rows.push(row);
  return rows;
}

function canonicalHeader(value) {
  return String(value ?? '')
    .toLocaleLowerCase('ru')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .trim();
}

const HEADER_ALIASES = Object.freeze({
  id: ['id', 'key', 'uid', 'идентификатор'],
  spanish: [
    'spanish', 'espanol', 'es', 'palabra', 'palabra espanola', 'termino',
    'испанский', 'испанское слово', 'слово на испанском', 'слово испанский',
  ],
  russian: [
    'russian', 'ru', 'translation', 'meaning', 'traduccion',
    'русский', 'перевод', 'значение', 'перевод на русский',
  ],
  partOfSpeech: [
    'part of speech', 'pos', 'type', 'category', 'categoria', 'clase',
    'часть речи', 'тип', 'категория',
  ],
  example: ['example', 'example sentence', 'ejemplo', 'frase', 'пример', 'контекст'],
  notes: ['notes', 'note', 'comment', 'comentario', 'nota', 'заметка', 'комментарий'],
});

export function detectColumns(headers) {
  const normalized = headers.map(canonicalHeader);
  const result = {};

  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const normalizedAliases = aliases.map(canonicalHeader);
    const exactIndex = normalized.findIndex((header) => normalizedAliases.includes(header));
    if (exactIndex >= 0) {
      result[field] = exactIndex;
      continue;
    }
    const partialIndex = normalized.findIndex((header) =>
      normalizedAliases.some((alias) => header.includes(alias) || alias.includes(header)),
    );
    if (partialIndex >= 0) result[field] = partialIndex;
  }

  if (result.spanish === undefined && headers.length >= 1) result.spanish = 0;
  if (result.russian === undefined && headers.length >= 2) result.russian = 1;
  if (result.partOfSpeech === undefined && headers.length >= 3) result.partOfSpeech = 2;
  return result;
}

export function stableHash(value) {
  let hash = 0x811c9dc5;
  const input = String(value);
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function tableToWords(headers, rows) {
  if (!Array.isArray(headers) || !Array.isArray(rows)) return [];
  const columns = detectColumns(headers);
  const seenIds = new Set();
  const words = [];

  rows.forEach((row, sourceIndex) => {
    const spanish = String(row?.[columns.spanish] ?? '').trim();
    const russian = String(row?.[columns.russian] ?? '').trim();
    if (!spanish || !russian) return;

    const partOfSpeech = String(row?.[columns.partOfSpeech] ?? '').trim() || 'не указано';
    const explicitId = columns.id === undefined ? '' : String(row?.[columns.id] ?? '').trim();
    const fingerprint = `${normalizeText(spanish, { stripAccents: true })}|${normalizeText(russian, { stripAccents: true })}|${canonicalHeader(partOfSpeech)}`;
    let id = explicitId || `w_${stableHash(fingerprint)}`;
    if (seenIds.has(id)) id = `${id}_${sourceIndex + 1}`;
    seenIds.add(id);

    words.push({
      id,
      spanish,
      russian,
      partOfSpeech,
      example: columns.example === undefined ? '' : String(row?.[columns.example] ?? '').trim(),
      notes: columns.notes === undefined ? '' : String(row?.[columns.notes] ?? '').trim(),
      sourceRow: sourceIndex + 2,
    });
  });

  return words;
}

export function matrixToWords(matrix) {
  if (!Array.isArray(matrix) || matrix.length === 0) return [];
  const [headers, ...rows] = matrix;
  return tableToWords(headers, rows);
}

export function normalizeText(value, { stripAccents = false, removeArticles = false } = {}) {
  let result = String(value ?? '')
    .trim()
    .toLocaleLowerCase('es')
    .replace(/ё/g, 'е')
    .replace(/[“”„«»]/g, '"')
    .replace(/[’‘`]/g, "'")
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/[¿¡!?.,:;()\[\]{}"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (removeArticles) {
    result = result.replace(/^(el|la|los|las|un|una|unos|unas)\s+/i, '');
  }

  if (stripAccents) {
    result = result.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }
  return result;
}

export function splitExpectedAnswers(value) {
  const raw = Array.isArray(value) ? value : [value];
  const answers = raw
    .flatMap((entry) => String(entry ?? '').split(/\s*(?:;|\||\/|\n|,\s+)\s*/g))
    .map((entry) => entry.trim())
    .filter(Boolean);

  const expanded = new Set();
  for (const answer of answers) {
    expanded.add(answer);
    const withoutParenthetical = answer.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    if (withoutParenthetical) expanded.add(withoutParenthetical);
    const withoutArticle = answer.replace(/^(el|la|los|las|un|una|unos|unas)\s+/i, '').trim();
    if (withoutArticle) expanded.add(withoutArticle);
  }
  return [...expanded];
}

export function levenshteinDistance(left, right) {
  const a = String(left);
  const b = String(right);
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost,
      );
    }
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j];
  }
  return previous[b.length];
}

function toleranceFor(length, mode) {
  if (mode === 'strict' || length <= 4) return 0;
  if (mode === 'lenient') return Math.max(1, Math.floor(length * 0.2));
  return Math.max(1, Math.floor(length * 0.12));
}

export function evaluateAnswer(input, expected, options = {}) {
  const settings = {
    acceptAccentMistakes: true,
    answerTolerance: 'balanced',
    ...options,
  };
  const typed = String(input ?? '').trim();
  const variants = splitExpectedAnswers(expected);

  if (!typed) {
    return { status: 'empty', accepted: false, exact: false, matched: null, distance: null };
  }

  const normalizedTyped = normalizeText(typed);
  const accentlessTyped = normalizeText(typed, { stripAccents: true });
  let closest = { answer: variants[0] || '', distance: Number.POSITIVE_INFINITY };

  for (const answer of variants) {
    const normalizedExpected = normalizeText(answer);
    if (normalizedTyped === normalizedExpected) {
      return { status: 'correct', accepted: true, exact: true, matched: answer, distance: 0 };
    }

    const accentlessExpected = normalizeText(answer, { stripAccents: true });
    if (accentlessTyped === accentlessExpected) {
      return {
        status: settings.acceptAccentMistakes ? 'correct-accent' : 'almost',
        accepted: Boolean(settings.acceptAccentMistakes),
        exact: false,
        matched: answer,
        distance: 0,
      };
    }

    const articlelessTyped = normalizeText(typed, { stripAccents: true, removeArticles: true });
    const articlelessExpected = normalizeText(answer, { stripAccents: true, removeArticles: true });
    if (articlelessTyped === articlelessExpected) {
      return { status: 'correct-article', accepted: true, exact: false, matched: answer, distance: 0 };
    }

    const distance = levenshteinDistance(accentlessTyped, accentlessExpected);
    if (distance < closest.distance) closest = { answer, distance };
  }

  const comparisonLength = Math.max(accentlessTyped.length, normalizeText(closest.answer, { stripAccents: true }).length);
  const tolerance = toleranceFor(comparisonLength, settings.answerTolerance);
  const closeEnough = closest.distance <= tolerance;

  return {
    status: closeEnough ? 'almost' : 'wrong',
    accepted: false,
    exact: false,
    matched: closest.answer,
    distance: Number.isFinite(closest.distance) ? closest.distance : null,
  };
}

export function createEmptyProgress(wordId) {
  return {
    wordId,
    state: 'new',
    ease: 2.5,
    intervalDays: 0,
    dueAt: null,
    repetitions: 0,
    lapses: 0,
    totalReviews: 0,
    successfulReviews: 0,
    typedCorrectReviews: 0,
    totalResponseMs: 0,
    firstSeenAt: null,
    lastReviewedAt: null,
    learnedAt: null,
    masteredAt: null,
    updatedAt: null,
    lastRating: null,
    lastAnswerStatus: null,
    directionStats: {
      'es-ru': { reviews: 0, successes: 0, typedCorrect: 0, totalResponseMs: 0 },
      'ru-es': { reviews: 0, successes: 0, typedCorrect: 0, totalResponseMs: 0 },
    },
  };
}

function nextInterval(progress, rating) {
  const current = Math.max(0, Number(progress.intervalDays) || 0);
  const repetitions = Math.max(0, Number(progress.repetitions) || 0);
  const ease = clamp(Number(progress.ease) || 2.5, 1.3, 3.2);

  if (rating === 0) return { intervalDays: current >= 1 ? 1 : 10 / 1440, repetitions: 0, ease: clamp(ease - 0.2, 1.3, 3.2) };
  if (rating === 1) return { intervalDays: current < 1 ? 30 / 1440 : Math.max(1, current * 1.2), repetitions: Math.max(1, repetitions), ease: clamp(ease - 0.15, 1.3, 3.2) };
  if (rating === 2) {
    const intervalDays = repetitions === 0 ? 1 : repetitions === 1 ? 3 : Math.max(3, current * ease);
    return { intervalDays, repetitions: repetitions + 1, ease };
  }
  const intervalDays = repetitions === 0 ? 4 : Math.max(4, current * ease * 1.3);
  return { intervalDays, repetitions: repetitions + 1, ease: clamp(ease + 0.15, 1.3, 3.2) };
}

export function applyReview(progressInput, review, now = Date.now()) {
  const base = createEmptyProgress(review.wordId || progressInput?.wordId);
  const progress = {
    ...base,
    ...(progressInput || {}),
    directionStats: {
      ...base.directionStats,
      ...(progressInput?.directionStats || {}),
    },
  };

  const rating = clamp(Number(review.rating) || 0, 0, 3);
  const responseMs = Math.max(0, Number(review.responseMs) || 0);
  const direction = review.direction === 'ru-es' ? 'ru-es' : 'es-ru';
  const typedCorrect = Boolean(review.typedCorrect);
  const successful = rating > 0;
  const at = new Date(now).toISOString();
  const scheduled = nextInterval(progress, rating);
  const intervalDays = clamp(scheduled.intervalDays, 1 / 1440, 36_500);

  progress.wordId = review.wordId || progress.wordId;
  progress.ease = scheduled.ease;
  progress.intervalDays = intervalDays;
  progress.repetitions = scheduled.repetitions;
  progress.dueAt = new Date(now + intervalDays * DAY_MS).toISOString();
  progress.totalReviews = (Number(progress.totalReviews) || 0) + 1;
  progress.successfulReviews = (Number(progress.successfulReviews) || 0) + (successful ? 1 : 0);
  progress.typedCorrectReviews = (Number(progress.typedCorrectReviews) || 0) + (typedCorrect ? 1 : 0);
  progress.totalResponseMs = (Number(progress.totalResponseMs) || 0) + responseMs;
  progress.lapses = (Number(progress.lapses) || 0) + (rating === 0 ? 1 : 0);
  progress.firstSeenAt = progress.firstSeenAt || at;
  progress.lastReviewedAt = at;
  progress.updatedAt = at;
  progress.lastRating = rating;
  progress.lastAnswerStatus = review.answerStatus || (typedCorrect ? 'correct' : 'wrong');

  const directionBase = base.directionStats[direction];
  const directionCurrent = { ...directionBase, ...(progress.directionStats?.[direction] || {}) };
  progress.directionStats[direction] = {
    reviews: (Number(directionCurrent.reviews) || 0) + 1,
    successes: (Number(directionCurrent.successes) || 0) + (successful ? 1 : 0),
    typedCorrect: (Number(directionCurrent.typedCorrect) || 0) + (typedCorrect ? 1 : 0),
    totalResponseMs: (Number(directionCurrent.totalResponseMs) || 0) + responseMs,
  };

  const passRate = progress.totalReviews ? progress.successfulReviews / progress.totalReviews : 0;
  if (!progress.learnedAt && progress.repetitions >= 2 && progress.intervalDays >= 3) progress.learnedAt = at;
  if (!progress.masteredAt && progress.repetitions >= 4 && progress.intervalDays >= 14 && passRate >= 0.75) progress.masteredAt = at;

  if (progress.masteredAt) progress.state = 'mastered';
  else if (progress.intervalDays >= 1) progress.state = 'review';
  else progress.state = 'learning';

  return progress;
}

export function chooseDirection(progress, random = Math.random, mode = 'adaptive-random') {
  if (mode === 'es-ru') return 'es-ru';
  if (mode === 'ru-es') return 'ru-es';
  if (!progress?.directionStats || mode === 'pure-random') return random() < 0.5 ? 'es-ru' : 'ru-es';

  const score = (stats = {}) => {
    const reviews = Number(stats.reviews) || 0;
    const successRate = reviews ? (Number(stats.successes) || 0) / reviews : 0.5;
    const responsePenalty = reviews ? Math.min(0.3, ((Number(stats.totalResponseMs) || 0) / reviews) / 60_000) : 0.15;
    return successRate - responsePenalty - 1 / (reviews + 4);
  };

  const esRuScore = score(progress.directionStats['es-ru']);
  const ruEsScore = score(progress.directionStats['ru-es']);
  const weaker = esRuScore <= ruEsScore ? 'es-ru' : 'ru-es';
  return random() < 0.68 ? weaker : weaker === 'es-ru' ? 'ru-es' : 'es-ru';
}

export function isDue(progress, now = Date.now()) {
  if (!progress || progress.state === 'new' || !progress.dueAt) return false;
  return new Date(progress.dueAt).getTime() <= now;
}

export function buildStudyQueue(words, progressMap, settings = {}, dailyEntry = {}, now = Date.now(), random = Math.random) {
  const mergedSettings = { ...DEFAULT_LEARNING_SETTINGS, ...settings };
  const progressObject = progressMap || {};
  const due = [];
  const fresh = [];

  for (const word of words) {
    const progress = progressObject[word.id];
    if (!progress || progress.state === 'new' || progress.totalReviews === 0) {
      fresh.push({ wordId: word.id, isNew: true, reason: 'new' });
    } else if (isDue(progress, now)) {
      due.push({ wordId: word.id, isNew: false, reason: 'due', dueAt: progress.dueAt });
    }
  }

  due.sort((left, right) => new Date(left.dueAt).getTime() - new Date(right.dueAt).getTime());
  const dueLimited = due.slice(0, Math.max(0, Number(mergedSettings.dailyReviewLimit) || 0));
  const introducedToday = Math.max(0, Number(dailyEntry.newWords) || 0);
  const newLimit = Math.max(0, (Number(mergedSettings.dailyNewLimit) || 0) - introducedToday);
  const newLimited = shuffle(fresh, random).slice(0, newLimit);

  return [...dueLimited, ...newLimited];
}

export function updateDailyAggregate(current, review, timeZone = DEFAULT_LEARNING_SETTINGS.timeZone) {
  const date = localDateKey(review.reviewedAt || Date.now(), timeZone);
  const base = {
    date,
    reviews: 0,
    successful: 0,
    typedCorrect: 0,
    newWords: 0,
    learned: 0,
    mastered: 0,
    totalResponseMs: 0,
    directions: {
      'es-ru': { reviews: 0, successful: 0, typedCorrect: 0 },
      'ru-es': { reviews: 0, successful: 0, typedCorrect: 0 },
    },
    updatedAt: null,
  };
  const aggregate = {
    ...base,
    ...(current || {}),
    directions: {
      ...base.directions,
      ...(current?.directions || {}),
    },
  };

  const direction = review.direction === 'ru-es' ? 'ru-es' : 'es-ru';
  const directionStats = { ...base.directions[direction], ...(aggregate.directions[direction] || {}) };
  const successful = Number(review.rating) > 0;
  const typedCorrect = Boolean(review.typedCorrect);

  aggregate.reviews += 1;
  aggregate.successful += successful ? 1 : 0;
  aggregate.typedCorrect += typedCorrect ? 1 : 0;
  aggregate.newWords += review.wasNew ? 1 : 0;
  aggregate.learned += review.becameLearned ? 1 : 0;
  aggregate.mastered += review.becameMastered ? 1 : 0;
  aggregate.totalResponseMs += Math.max(0, Number(review.responseMs) || 0);
  aggregate.directions[direction] = {
    reviews: directionStats.reviews + 1,
    successful: directionStats.successful + (successful ? 1 : 0),
    typedCorrect: directionStats.typedCorrect + (typedCorrect ? 1 : 0),
  };
  aggregate.updatedAt = new Date(review.reviewedAt || Date.now()).toISOString();
  return aggregate;
}

export function difficultyScore(progress) {
  const reviews = Number(progress?.totalReviews) || 0;
  if (!reviews) return 50;
  const passRate = (Number(progress.successfulReviews) || 0) / reviews;
  const typedRate = (Number(progress.typedCorrectReviews) || 0) / reviews;
  const averageSeconds = (Number(progress.totalResponseMs) || 0) / reviews / 1000;
  const lapsePenalty = (Number(progress.lapses) || 0) * 7;
  const easePenalty = Math.max(0, 2.5 - (Number(progress.ease) || 2.5)) * 18;
  return (1 - passRate) * 36 + (1 - typedRate) * 26 + Math.min(24, averageSeconds * 0.8) + lapsePenalty + easePenalty;
}

function sumDaily(dailyMap, keys) {
  return keys.reduce((sum, key) => sum + (Number(dailyMap?.[key]?.reviews) || 0), 0);
}

export function computeAnalytics(words, progressMap, dailyMap, now = Date.now(), settings = {}) {
  const mergedSettings = { ...DEFAULT_LEARNING_SETTINGS, ...settings };
  const wordById = Object.fromEntries(words.map((word) => [word.id, word]));
  const progressValues = Object.values(progressMap || {}).filter((progress) => wordById[progress.wordId]);
  const today = localDateKey(now, mergedSettings.timeZone);
  const last7Keys = Array.from({ length: 7 }, (_, index) => dateKeyOffset(index - 6, now, mergedSettings.timeZone));
  const last14Keys = Array.from({ length: 14 }, (_, index) => dateKeyOffset(index - 13, now, mergedSettings.timeZone));
  const last30Keys = Array.from({ length: 30 }, (_, index) => dateKeyOffset(index - 29, now, mergedSettings.timeZone));

  const dateOf = (value) => (value ? localDateKey(value, mergedSettings.timeZone) : null);
  const learnedToday = progressValues.filter((progress) => dateOf(progress.learnedAt) === today).length;
  const learnedWeek = progressValues.filter((progress) => last7Keys.includes(dateOf(progress.learnedAt))).length;
  const masteredTotal = progressValues.filter((progress) => progress.masteredAt).length;
  const learnedTotal = progressValues.filter((progress) => progress.learnedAt).length;
  const dueNow = progressValues.filter((progress) => isDue(progress, now)).length;
  const newTotal = Math.max(0, words.length - progressValues.filter((progress) => progress.totalReviews > 0).length);

  const todayDaily = dailyMap?.[today] || {};
  const weekReviews = sumDaily(dailyMap, last7Keys);
  const weekTypedCorrect = last7Keys.reduce((sum, key) => sum + (Number(dailyMap?.[key]?.typedCorrect) || 0), 0);
  const accuracy7 = weekReviews ? weekTypedCorrect / weekReviews : 0;

  let streak = 0;
  for (let offset = 0; offset < 366; offset += 1) {
    const key = dateKeyOffset(-offset, now, mergedSettings.timeZone);
    if ((Number(dailyMap?.[key]?.reviews) || 0) > 0) streak += 1;
    else if (offset === 0) continue;
    else break;
  }

  const ranked = progressValues
    .filter((progress) => Number(progress.totalReviews) >= 2)
    .map((progress) => ({ progress, word: wordById[progress.wordId], score: difficultyScore(progress) }))
    .sort((left, right) => left.score - right.score);

  const partOfSpeechMap = new Map();
  for (const word of words) {
    const key = word.partOfSpeech || 'не указано';
    const bucket = partOfSpeechMap.get(key) || { label: key, total: 0, learned: 0, mastered: 0, reviews: 0 };
    const progress = progressMap?.[word.id];
    bucket.total += 1;
    bucket.learned += progress?.learnedAt ? 1 : 0;
    bucket.mastered += progress?.masteredAt ? 1 : 0;
    bucket.reviews += Number(progress?.totalReviews) || 0;
    partOfSpeechMap.set(key, bucket);
  }

  const directionTotals = {
    'es-ru': { reviews: 0, successful: 0, typedCorrect: 0 },
    'ru-es': { reviews: 0, successful: 0, typedCorrect: 0 },
  };
  for (const progress of progressValues) {
    for (const direction of ['es-ru', 'ru-es']) {
      const stats = progress.directionStats?.[direction] || {};
      directionTotals[direction].reviews += Number(stats.reviews) || 0;
      directionTotals[direction].successful += Number(stats.successes) || 0;
      directionTotals[direction].typedCorrect += Number(stats.typedCorrect) || 0;
    }
  }

  const series = (keys) => keys.map((key) => ({
    date: key,
    reviews: Number(dailyMap?.[key]?.reviews) || 0,
    learned: Number(dailyMap?.[key]?.learned) || 0,
    mastered: Number(dailyMap?.[key]?.mastered) || 0,
    accuracy: dailyMap?.[key]?.reviews ? (Number(dailyMap[key].typedCorrect) || 0) / Number(dailyMap[key].reviews) : 0,
  }));

  return {
    today,
    totalWords: words.length,
    newTotal,
    learnedToday,
    learnedWeek,
    learnedTotal,
    masteredTotal,
    dueNow,
    reviewsToday: Number(todayDaily.reviews) || 0,
    weekReviews,
    accuracy7,
    streak,
    easiest: ranked.slice(0, 5),
    hardest: [...ranked].reverse().slice(0, 5),
    partOfSpeech: [...partOfSpeechMap.values()].sort((a, b) => b.total - a.total),
    directionTotals,
    last14: series(last14Keys),
    last30: series(last30Keys),
  };
}

export function mergeProgressMaps(localMap = {}, remoteMap = {}) {
  const merged = { ...localMap };
  for (const [wordId, remote] of Object.entries(remoteMap)) {
    const local = merged[wordId];
    const localTime = local?.updatedAt ? new Date(local.updatedAt).getTime() : 0;
    const remoteTime = remote?.updatedAt ? new Date(remote.updatedAt).getTime() : 0;
    if (!local || remoteTime >= localTime) merged[wordId] = remote;
  }
  return merged;
}

export function mergeDailyMaps(localMap = {}, remoteMap = {}) {
  const merged = { ...localMap };
  for (const [date, remote] of Object.entries(remoteMap)) {
    const local = merged[date];
    const localTime = local?.updatedAt ? new Date(local.updatedAt).getTime() : 0;
    const remoteTime = remote?.updatedAt ? new Date(remote.updatedAt).getTime() : 0;
    if (!local || remoteTime >= localTime) merged[date] = remote;
  }
  return merged;
}

export function formatPercent(value, fallback = '—') {
  if (!Number.isFinite(value)) return fallback;
  return `${Math.round(value * 100)}%`;
}

export function ratingLabel(rating) {
  return ['Ещё раз', 'Трудно', 'Хорошо', 'Легко'][Number(rating)] || '—';
}
