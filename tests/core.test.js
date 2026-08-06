import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyReview,
  buildStudyQueue,
  chooseDirection,
  computeAnalytics,
  createEmptyProgress,
  evaluateAnswer,
  localDateKey,
  matrixToWords,
  parseDelimited,
  updateDailyAggregate,
} from '../js/core.js';
import { parseGoogleSheetReference } from '../js/sheets.js';

test('CSV parser preserves quoted commas and line breaks', () => {
  const matrix = parseDelimited('Spanish,Russian,Example\n"buenos días","доброе утро","Hola, amigo"\n"línea","строка","uno\ndos"');
  assert.equal(matrix.length, 3);
  assert.equal(matrix[1][2], 'Hola, amigo');
  assert.equal(matrix[2][2], 'uno\ndos');
});

test('table converter detects Russian headers and creates stable words', () => {
  const words = matrixToWords([
    ['Испанский', 'Перевод', 'Часть речи', 'Пример'],
    ['casa', 'дом', 'существительное', 'Mi casa.'],
    ['ir', 'идти; ехать', 'глагол', 'Voy a casa.'],
  ]);
  assert.equal(words.length, 2);
  assert.equal(words[0].spanish, 'casa');
  assert.equal(words[0].russian, 'дом');
  assert.match(words[0].id, /^w_/);
});

test('four-column user layout imports columns B, C and D', () => {
  const first = matrixToWords([
    ['Артикль', 'Испанский', 'Перевод', 'Часть речи'],
    ['el', 'nosotros', 'мы (мужской род или смешанная группа)', 'местоимение'],
  ]);
  const changedMetadata = matrixToWords([
    ['Артикль', 'Испанский', 'Перевод', 'Часть речи'],
    ['los', 'nosotros', 'мы (мужской род или смешанная группа)', 'другая категория'],
  ]);

  assert.equal(first.length, 1);
  assert.equal(first[0].spanish, 'nosotros');
  assert.equal(first[0].russian, 'мы (мужской род или смешанная группа)');
  assert.equal(first[0].partOfSpeech, 'местоимение');
  assert.equal(changedMetadata[0].partOfSpeech, 'другая категория');
  assert.equal(first[0].id, changedMetadata[0].id);
});

test('answer evaluation supports alternatives, articles and accents', () => {
  assert.equal(evaluateAnswer('ехать', 'идти; ехать').accepted, true);
  assert.equal(evaluateAnswer('casa', 'la casa').accepted, true);
  const accent = evaluateAnswer('como', 'cómo', { acceptAccentMistakes: true });
  assert.equal(accent.accepted, true);
  assert.equal(accent.status, 'correct-accent');
  const strictAccent = evaluateAnswer('como', 'cómo', { acceptAccentMistakes: false });
  assert.equal(strictAccent.accepted, false);
  assert.equal(strictAccent.status, 'almost');
});

test('approximate matching is optional and respects typo tolerance', () => {
  assert.equal(evaluateAnswer('si', 'no').status, 'wrong');

  const accepted = evaluateAnswer('necesita', 'necesitar');
  assert.equal(accepted.status, 'correct-approximate');
  assert.equal(accepted.accepted, true);

  const disabled = evaluateAnswer('necesita', 'necesitar', { acceptApproximateMatches: false });
  assert.equal(disabled.status, 'almost');
  assert.equal(disabled.accepted, false);

  assert.equal(evaluateAnswer('cassa', 'la casa').status, 'correct-approximate');
});

test('approximate matching accepts an answer without explanatory text in brackets', () => {
  const expected = 'мы (мужской род или смешанная группа)';
  assert.equal(evaluateAnswer('мы', expected).status, 'correct-approximate');
  assert.equal(evaluateAnswer('мы', expected, { acceptApproximateMatches: false }).accepted, false);
  assert.equal(evaluateAnswer('мы', 'мы (мужской род, смешанная группа)').accepted, true);
});

test('special characters can be ignored independently', () => {
  const ignored = evaluateAnswer('hola', '¡hola!', {
    ignoreSpecialCharacters: true,
    acceptApproximateMatches: false,
  });
  assert.equal(ignored.status, 'correct-special');
  assert.equal(ignored.accepted, true);

  const strict = evaluateAnswer('hola', '¡hola!', {
    ignoreSpecialCharacters: false,
    acceptApproximateMatches: false,
  });
  assert.equal(strict.status, 'wrong');
  assert.equal(strict.accepted, false);
});

test('review schedule grows and reaches learned/mastered states', () => {
  const start = Date.UTC(2026, 0, 1, 12);
  let progress = createEmptyProgress('word-1');
  progress = applyReview(progress, { wordId: 'word-1', rating: 2, responseMs: 2000, direction: 'es-ru', typedCorrect: true }, start);
  assert.equal(progress.intervalDays, 1);
  assert.equal(progress.state, 'review');
  assert.equal(progress.learnedAt, null);

  progress = applyReview(progress, { wordId: 'word-1', rating: 2, responseMs: 1800, direction: 'ru-es', typedCorrect: true }, start + 86_400_000);
  assert.equal(progress.intervalDays, 3);
  assert.ok(progress.learnedAt);

  progress = applyReview(progress, { wordId: 'word-1', rating: 2, responseMs: 1600, direction: 'es-ru', typedCorrect: true }, start + 4 * 86_400_000);
  progress = applyReview(progress, { wordId: 'word-1', rating: 2, responseMs: 1500, direction: 'ru-es', typedCorrect: true }, start + 12 * 86_400_000);
  assert.ok(progress.intervalDays >= 14);
  assert.ok(progress.masteredAt);
  assert.equal(progress.state, 'mastered');
});

test('again creates a short relearning interval and records a lapse', () => {
  const progress = applyReview(
    { ...createEmptyProgress('word-2'), intervalDays: 10, repetitions: 3, state: 'review' },
    { wordId: 'word-2', rating: 0, responseMs: 5000, direction: 'es-ru', typedCorrect: false },
    Date.UTC(2026, 0, 1),
  );
  assert.equal(progress.intervalDays, 1);
  assert.equal(progress.repetitions, 0);
  assert.equal(progress.lapses, 1);
});

test('adaptive direction prefers the weaker side while remaining random', () => {
  const progress = createEmptyProgress('word-3');
  progress.directionStats['es-ru'] = { reviews: 10, successes: 3, typedCorrect: 2, totalResponseMs: 120000 };
  progress.directionStats['ru-es'] = { reviews: 10, successes: 9, typedCorrect: 9, totalResponseMs: 30000 };
  assert.equal(chooseDirection(progress, () => 0.2, 'adaptive-random'), 'es-ru');
  assert.equal(chooseDirection(progress, () => 0.9, 'adaptive-random'), 'ru-es');
});

test('study queue puts due cards first and respects daily new limit', () => {
  const now = Date.UTC(2026, 0, 10);
  const words = [
    { id: 'due' }, { id: 'future' }, { id: 'new-a' }, { id: 'new-b' }, { id: 'new-c' },
  ];
  const progress = {
    due: { ...createEmptyProgress('due'), totalReviews: 1, state: 'review', dueAt: new Date(now - 1000).toISOString() },
    future: { ...createEmptyProgress('future'), totalReviews: 1, state: 'review', dueAt: new Date(now + 100000).toISOString() },
  };
  const queue = buildStudyQueue(words, progress, { dailyNewLimit: 2, dailyReviewLimit: 20 }, { newWords: 1 }, now, () => 0.5);
  assert.equal(queue[0].wordId, 'due');
  assert.equal(queue.filter((item) => item.isNew).length, 1);
  assert.equal(queue.some((item) => item.wordId === 'future'), false);
});

test('daily aggregate and analytics count learned words and typed accuracy', () => {
  const reviewedAt = '2026-08-03T10:00:00.000Z';
  const review = {
    wordId: 'one',
    rating: 2,
    typedCorrect: true,
    direction: 'es-ru',
    responseMs: 1000,
    wasNew: true,
    becameLearned: true,
    becameMastered: false,
    reviewedAt,
  };
  const daily = updateDailyAggregate(null, review, 'UTC');
  assert.equal(daily.reviews, 1);
  assert.equal(daily.newWords, 1);
  assert.equal(daily.learned, 1);

  const progress = {
    one: {
      ...createEmptyProgress('one'),
      totalReviews: 2,
      successfulReviews: 2,
      typedCorrectReviews: 2,
      learnedAt: reviewedAt,
      updatedAt: reviewedAt,
    },
  };
  const analytics = computeAnalytics(
    [{ id: 'one', spanish: 'uno', russian: 'один', partOfSpeech: 'числительное' }],
    progress,
    { [daily.date]: daily },
    Date.parse(reviewedAt),
    { timeZone: 'UTC' },
  );
  assert.equal(analytics.learnedToday, 1);
  assert.equal(analytics.reviewsToday, 1);
  assert.equal(analytics.accuracy7, 1);
});

test('Google Sheets URL parser distinguishes ordinary and published links', () => {
  const ordinary = parseGoogleSheetReference('https://docs.google.com/spreadsheets/d/abc_DEF-123/edit#gid=456');
  assert.deepEqual(ordinary, {
    kind: 'google-sheet', spreadsheetId: 'abc_DEF-123', gid: '456',
    originalUrl: 'https://docs.google.com/spreadsheets/d/abc_DEF-123/edit#gid=456',
  });
  const published = parseGoogleSheetReference('https://docs.google.com/spreadsheets/d/e/2PACX-demo/pub?gid=0&single=true&output=csv');
  assert.equal(published.kind, 'published-csv');
});

test('localDateKey honors explicit time zone', () => {
  const instant = Date.parse('2026-08-03T23:30:00Z');
  assert.equal(localDateKey(instant, 'UTC'), '2026-08-03');
  assert.equal(localDateKey(instant, 'Europe/Madrid'), '2026-08-04');
});
