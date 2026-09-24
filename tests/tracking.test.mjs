import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Data URL keeps the application as browser-native ES modules without needing
// Node package metadata solely for these deterministic logic tests.
const source = await readFile(new URL('../reader/static/gaze.js', import.meta.url), 'utf8');
const { FixationEngine, ReadingTracker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const word = (wordId, sentenceId = 's1') => ({ wordId, sentenceId, word: wordId, sentence: sentenceId });

function fixture(options = {}) {
  const assists = [], focuses = [], progress = [];
  const engine = new FixationEngine({ total: 10, onAssist: x => assists.push(x),
    onFocus: x => focuses.push(x), onProgress: x => progress.push(x), ...options });
  let now = 0;
  return { engine, assists, focuses, progress,
    look(token, duration) {
      engine.observe(token, now);
      const end = now + duration;
      while (now < end) {
        now = Math.min(end, now + 40);
        engine.observe(token, now);
      }
    },
    tick(time) { now = time; engine.tick(time); },
  };
}

test('qualified dwell fires once and progress requires a fixation', () => {
  const f = fixture({ dwellMs: 1000 });
  f.look(word('one'), 180);
  assert.equal(f.progress.at(-1).seen, 0);
  f.look(word('one'), 900);
  assert.equal(f.progress.at(-1).seen, 1);
  assert.deepEqual(f.assists.map(a => a.reason), ['dwell']);
  f.look(word('one'), 15000);
  assert.equal(f.assists.length, 1);
});

test('sweeping quickly over words does not mark them as read', () => {
  const f = fixture();
  for (let index = 0; index < 8; index++) f.look(word(String(index)), 80);
  assert.equal(f.progress.at(-1).seen, 0);
  assert.equal(f.assists.length, 0);
});

test('moving between words in one sentence is one visit', () => {
  const f = fixture({ dwellMs: 8000 });
  for (let index = 0; index < 10; index++) f.look(word(String(index)), 450);
  assert.equal(f.engine.visits.get('s1'), 1);
  assert.equal(f.assists.length, 0);
  assert.equal(f.progress.at(-1).seen, 10);
});

test('reread requires qualified departures and returns', () => {
  const f = fixture({ dwellMs: 8000, revisitCount: 3 });
  f.look(word('A', 'a'), 500);
  f.look(word('B', 'b'), 500);
  f.look(word('A', 'a'), 500);
  f.look(word('B', 'b'), 500);
  f.look(word('A', 'a'), 500);
  assert.equal(f.engine.visits.get('a'), 3);
  assert.equal(f.assists.length, 1);
  assert.equal(f.assists[0].reason, 'reread');
  assert.equal(f.assists[0].visits, 3);
});

test('brief word or sentence jitter does not become a reread', () => {
  const f = fixture({ dwellMs: 8000 });
  f.look(word('A', 'a'), 500);
  for (let index = 0; index < 10; index++) {
    f.look(word('B', 'b'), 60);
    f.look(word('A', 'a'), 450);
  }
  assert.equal(f.engine.visits.get('a'), 1);
  assert.equal(f.engine.visits.has('b'), false);
  assert.equal(f.engine.seen.has('B'), false);
  assert.equal(f.assists.length, 0);
});

test('long departure outside article can count as a later visit', () => {
  const f = fixture({ dwellMs: 8000 });
  f.look(word('A'), 500);
  f.look(null, 800);
  f.look(word('A'), 500);
  assert.equal(f.engine.visits.get('s1'), 2);
});

test('stale camera signal cancels dwell before 500 ms without a new sample', () => {
  const f = fixture({ freshMs: 480, dwellMs: 700 });
  f.engine.observe(word('A'), 0);
  f.tick(400);
  assert.ok(f.focuses.at(-1));
  f.tick(480);
  assert.equal(f.focuses.at(-1), null);
  f.tick(2000);
  assert.equal(f.assists.length, 0);
  f.engine.observe(word('A'), 2000);
  f.tick(2200);
  assert.ok(f.focuses.at(-1).elapsed < 700);
});

test('pause, scroll, and hidden interruptions discard elapsed dwell', () => {
  const f = fixture({ dwellMs: 1000 });
  f.look(word('A'), 900);
  f.engine.interrupt();
  f.look(word('A'), 300);
  assert.equal(f.assists.length, 0);
  assert.equal(f.engine.visits.get('s1'), 1);
  f.look(word('A'), 750);
  assert.equal(f.assists.length, 1);
});

test('sentence cooldown suppresses a cascade of automatic explanations', () => {
  const f = fixture({ dwellMs: 600, cooldownMs: 12000 });
  f.look(word('A'), 800);
  f.look(word('B'), 800);
  assert.equal(f.assists.length, 1);
  f.look(null, 12500);
  f.look(word('C'), 800);
  assert.equal(f.assists.length, 2);
});

test('reset clears document progress, visits, and cooldown', () => {
  const f = fixture({ dwellMs: 600 });
  f.look(word('A'), 800);
  f.engine.reset(20);
  assert.deepEqual(f.progress.at(-1), { seen: 0, total: 20, ratio: 0 });
  assert.equal(f.engine.visits.size, 0);
  f.look(word('A'), 800);
  assert.equal(f.assists.length, 2);
});

test('invalid timestamps and sensitivity cannot create immediate assistance', () => {
  const f = fixture({ dwellMs: 0, revisitCount: 1 });
  f.engine.observe(word('A'), NaN);
  f.engine.tick(NaN);
  f.look(word('A'), 400);
  assert.equal(f.assists.length, 0);
  assert.equal(f.engine.dwellMs, 500);
  assert.equal(f.engine.revisitCount, 2);
});

test('DOM adapter ignores camera samples throughout a window blur', () => {
  const previousDocument = globalThis.document, previousWindow = globalThis.window;
  const documentStub = new EventTarget(), windowStub = new EventTarget();
  const sentence = { textContent: 'A sentence.', dataset: { sentenceId: 's1' } };
  const element = { textContent: 'A', dataset: { wordId: '1', sentenceId: 's1' },
    matches: selector => selector === '.word',
    closest(selector) { return selector === '.word' ? this : sentence; } };
  documentStub.hidden = false;
  documentStub.hasFocus = () => true;
  documentStub.elementFromPoint = () => element;
  globalThis.document = documentStub;
  globalThis.window = windowStub;
  let tracker;
  try {
    tracker = new ReadingTracker({ root: { querySelectorAll: () => [element], contains: node => node === element } });
    tracker.setMode('camera');
    tracker.feed(10, 10, 0);
    tracker.engine.tick(300);
    assert.ok(tracker.engine.active);
    windowStub.dispatchEvent(new Event('blur'));
    tracker.feed(10, 10, 400);
    tracker.feed(10, 10, 700);
    assert.equal(tracker.engine.target, null);
    assert.equal(tracker.engine.active, null);
    windowStub.dispatchEvent(new Event('focus'));
    tracker.feed(10, 10, 800);
    tracker.engine.tick(1000);
    assert.ok(tracker.engine.active);
    assert.equal(tracker.engine.active.elapsed, 200);
    // A snapped caret is in whitespace; its semantic word still receives dwell.
    documentStub.elementFromPoint = () => null;
    tracker.engine.interrupt();
    tracker.feedElement(element, 1100);
    tracker.engine.tick(1300);
    assert.equal(tracker.engine.active.token.element, element);
    tracker.feedElement(null, 1400);
    tracker.engine.tick(1600);
    assert.equal(tracker.engine.active, null);
    const foreignWord = { ...element };
    tracker.feedElement(foreignWord, 1700);
    assert.equal(tracker.engine.target, null);
  } finally {
    tracker?.destroy();
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});
