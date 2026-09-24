import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../reader/static/flashcards.js', import.meta.url), 'utf8');
const { normalizeReview, reviewCard, isDue, buildDeck, dueSummary } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const DAY = 86400000;
const date = offset => new Date(NOW + offset).toISOString();
const card = (word, offset) => ({ word, ...(offset === undefined ? {} : { review: { due_at: date(offset) } }) });

test('old saved words are new and due without requiring a migration', () => {
  const item = { word: 'serendipity', meaning: '美好的意外發現', saved_at: '2025-01-01T00:00:00Z' };
  assert.deepEqual(normalizeReview(item.review), { streak: 0, reviews: 0, lapses: 0, due_at: null, last_reviewed_at: null });
  assert.equal(isDue(item, NOW), true);
  assert.deepEqual(dueSummary([item], NOW), { total: 1, due: 1, nextDueAt: null });
  assert.equal(item.review, undefined);
});

test('remembered reviews follow 1, 3, 7, 14, 30, 60, 90 days and cap intervals', () => {
  let review;
  const intervals = [1, 3, 7, 14, 30, 60, 90, 90, 90];
  let now = NOW;
  intervals.forEach((days, index) => {
    review = reviewCard(review, 'remembered', now);
    assert.equal(Date.parse(review.due_at) - now, days * DAY);
    assert.equal(review.streak, index + 1);
    assert.equal(review.reviews, index + 1);
    assert.equal(review.lapses, 0);
    assert.equal(review.last_reviewed_at, new Date(now).toISOString());
    now = Date.parse(review.due_at);
  });
});

test('again resets progression and schedules ten minutes before restarting at one day', () => {
  const previous = { streak: 6, reviews: 10, lapses: 2, due_at: date(-DAY), last_reviewed_at: date(-30 * DAY) };
  const again = reviewCard(previous, 'again', NOW);
  assert.deepEqual(again, { streak: 0, reviews: 11, lapses: 3, due_at: date(600000), last_reviewed_at: date(0) });
  const remembered = reviewCard(again, 'remembered', NOW + 600000);
  assert.equal(remembered.streak, 1);
  assert.equal(remembered.reviews, 12);
  assert.equal(remembered.lapses, 3);
  assert.equal(Date.parse(remembered.due_at), NOW + 600000 + DAY);
});

test('custom future schedules and UTC offsets are preserved and boundaries are inclusive', () => {
  const review = normalizeReview({ due_at: '2030-02-28T20:00:00+08:00', last_reviewed_at: '2026-09-24' });
  assert.equal(review.due_at, '2030-02-28T12:00:00.000Z');
  assert.equal(review.last_reviewed_at, '2026-09-24T00:00:00.000Z');
  const item = { word: 'future', review };
  const deadline = Date.parse(review.due_at);
  assert.equal(isDue(item, deadline - 1), false);
  assert.equal(isDue(item, deadline), true);
  assert.equal(isDue(item, deadline + 1), true);
});

test('malformed metadata becomes safe new metadata and never hides an unscheduled card', () => {
  for (const review of [null, undefined, false, 12, 'tomorrow', []]) {
    assert.deepEqual(normalizeReview(review), { streak: 0, reviews: 0, lapses: 0, due_at: null, last_reviewed_at: null });
    assert.equal(isDue({ word: 'river', review }, NOW), true);
  }
  assert.deepEqual(normalizeReview({ streak: -4, reviews: '9', lapses: Infinity, due_at: 'nonsense', last_reviewed_at: 123 }),
    { streak: 0, reviews: 0, lapses: 0, due_at: null, last_reviewed_at: null });
  assert.equal(normalizeReview({ reviews: 1.5 }).reviews, 0);
  assert.equal(normalizeReview({ reviews: Number.MAX_SAFE_INTEGER + 1 }).reviews, 0);
});

test('invalid calendar dates and ambiguous local dates are not silently normalized', () => {
  for (const due_at of ['2026-02-30T00:00:00Z', '2025-02-29', '2026-13-01', '2026-01-00',
    '2026-01-01T24:00:00Z', '2026-01-01T00:60:00Z', '09/24/2026', '2026-09-24T12:00:00']) {
    assert.equal(normalizeReview({ due_at }).due_at, null, due_at);
  }
  assert.equal(normalizeReview({ due_at: '2028-02-29' }).due_at, '2028-02-29T00:00:00.000Z');
});

test('due deck sorts oldest overdue first then oldest new, and all mode adds future schedules', () => {
  const futureLater = card('later', 10 * DAY), futureSoon = card('soon', DAY);
  const newRecent = { ...card('new recent'), saved_at: date(-DAY) };
  const newOld = { ...card('new old'), saved_at: date(-10 * DAY) };
  const dueNow = card('now', 0), dueOld = card('overdue', -5 * DAY);
  const vocabulary = [futureLater, newRecent, dueNow, futureSoon, newOld, dueOld];
  const before = [...vocabulary];
  assert.deepEqual(buildDeck(vocabulary, 'due', NOW), [dueOld, dueNow, newOld, newRecent]);
  assert.deepEqual(buildDeck(vocabulary, 'all', NOW), [dueOld, dueNow, newOld, newRecent, futureSoon, futureLater]);
  assert.deepEqual(vocabulary, before);
  assert.equal(buildDeck(vocabulary, 'due', NOW)[0], dueOld);
});

test('duplicates are case-insensitive and preserve the first original item', () => {
  const original = card('  River  '), duplicate = card('rIvEr', DAY);
  const accents = card('Café'), duplicateAccents = card('Cafe\u0301');
  const items = [original, duplicate, accents, duplicateAccents, card('TREE')];
  const deck = buildDeck(items, 'all', NOW);
  assert.deepEqual(deck, [original, accents, items[4]]);
  assert.equal(deck[0], original);
  assert.equal(original.word, '  River  ');
  assert.deepEqual(dueSummary(items, NOW), { total: 3, due: 3, nextDueAt: null });
});

test('invalid words and non-array storage are ignored without inventing cards', () => {
  const valid = card('resilience');
  const corrupt = [null, false, 'text', {}, { word: 7 }, { word: '' }, { word: '  ' }, { word: '...' }, { word: '\u0000word' }, []];
  for (const item of corrupt) assert.equal(isDue(item, NOW), false);
  assert.deepEqual(buildDeck([...corrupt, valid], 'due', NOW), [valid]);
  for (const input of [undefined, null, {}, 'words', 42]) {
    assert.deepEqual(buildDeck(input, 'all', NOW), []);
    assert.deepEqual(dueSummary(input, NOW), { total: 0, due: 0, nextDueAt: null });
  }
});

test('summary counts deduplicated due items and reports only the earliest future date', () => {
  const items = [card('new'), card('past', -DAY), card('boundary', 0), card('later', 10 * DAY), card('next', DAY), card('NEXT', -DAY)];
  assert.deepEqual(dueSummary(items, NOW), { total: 5, due: 3, nextDueAt: date(DAY) });
  assert.deepEqual(dueSummary([card('due', 0)], NOW), { total: 1, due: 1, nextDueAt: null });
});

test('normalization and rating never mutate frozen stored metadata', () => {
  const stored = Object.freeze({ streak: 2, reviews: 3, lapses: 1, due_at: date(0), last_reviewed_at: date(-DAY) });
  const item = Object.freeze({ word: 'quiet', review: stored });
  const vocabulary = Object.freeze([item]);
  const normalized = normalizeReview(stored);
  assert.notEqual(normalized, stored);
  assert.equal(reviewCard(stored, 'remembered', NOW).reviews, 4);
  assert.equal(stored.reviews, 3);
  assert.equal(buildDeck(vocabulary, 'due', NOW)[0], item);
});

test('safe counts saturate instead of overflowing and rating/time errors are explicit', () => {
  const previous = { streak: Number.MAX_SAFE_INTEGER, reviews: Number.MAX_SAFE_INTEGER, lapses: Number.MAX_SAFE_INTEGER };
  const remembered = reviewCard(previous, 'remembered', NOW);
  assert.equal(remembered.streak, Number.MAX_SAFE_INTEGER);
  assert.equal(remembered.reviews, Number.MAX_SAFE_INTEGER);
  assert.equal(Date.parse(remembered.due_at) - NOW, 90 * DAY);
  assert.equal(reviewCard(previous, 'again', NOW).lapses, Number.MAX_SAFE_INTEGER);
  assert.throws(() => reviewCard({}, 'easy', NOW), /Unsupported/);
  assert.throws(() => buildDeck([], 'unexpected', NOW), /Unsupported/);
  for (const now of [NaN, Infinity, '2026-09-24', null, 9e15]) assert.throws(() => reviewCard({}, 'again', now), RangeError);
  assert.throws(() => reviewCard({}, 'again', 8.64e15), RangeError);
});
