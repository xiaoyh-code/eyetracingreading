import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeVocabulary } from '../reader/static/vocabulary-io.js';

test('migration keeps existing reviews and drops unknown properties', () => {
  const old = { word: 'hello', meaning: '你好', review: { streak: 2 } };
  const result = mergeVocabulary([old], [{ word: 'HELLO', meaning: 'changed' }, { word: 'world', meaning: '世界', api_key: 'synthetic-private', review: { reviews: 3, due_at: '2026-10-01T00:00:00Z' } }]);
  assert.equal(result.added, 1);
  assert.equal(result.vocabulary[0], old);
  assert.equal(result.vocabulary[1].review.reviews, 3);
  assert.equal(result.vocabulary[1].review.due_at, '2026-10-01T00:00:00.000Z');
  assert.ok(!('api_key' in result.vocabulary[1]));
});
test('invalid backups fail without mutating existing vocabulary', () => {
  const old = [{ word: 'hello', meaning: '你好' }];
  assert.throws(() => mergeVocabulary(old, [{ word: 'valid', meaning: '有效' }, { word: '' }]));
  assert.equal(old.length, 1);
  assert.throws(() => mergeVocabulary(old, {}));
});
