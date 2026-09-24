import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserTranslation, translationInput, TRANSLATION_MODEL } from '../reader/static/browser-translation.js';

function fixture(t, options = {}) {
  const workers = [], statuses = [];
  const translation = new BrowserTranslation({
    onStatus: status => statuses.push(status),
    workerFactory: () => {
      const worker = { sent: [], terminated: false, postMessage(message) { this.sent.push(message); }, terminate() { this.terminated = true; }, reply(data) { this.onmessage({ data }); } };
      workers.push(worker); return worker;
    }, ...options,
  });
  t.after(() => translation.destroy());
  return { translation, workers, statuses };
}
async function ready(h) {
  const promise = h.translation.prepare();
  const worker = h.workers.at(-1);
  worker.reply({ type: 'ready', id: worker.sent[0].id });
  await promise;
  return worker;
}
const result = { meaning: '河流', translation: '河水流向大海。', source: 'offline', example: '', visual_hint: '', message: '' };

test('construction and explain never trigger model downloads', async t => {
  const h = fixture(t);
  assert.equal(h.translation.status.state, 'idle');
  await assert.rejects(h.translation.explain({ word: 'river', sentence: 'The river flows.' }), /先按/);
  assert.equal(h.workers.length, 0);
  assert.match(TRANSLATION_MODEL.revision, /^[a-f0-9]{40}$/);
});

test('explicit prepare reports progress, pins a model, then permits inference', async t => {
  const h = fixture(t), progress = [];
  const prepared = h.translation.prepare({ onProgress: info => progress.push(info) });
  const worker = h.workers[0];
  assert.deepEqual(worker.sent[0].model, TRANSLATION_MODEL);
  worker.reply({ id: 1, type: 'progress', progress: { file: 'encoder.onnx', loaded: 12, total: 100 } });
  assert.equal(progress[0].loaded, 12);
  worker.reply({ id: 1, type: 'ready' });
  assert.equal((await prepared).ready, true);
  const promise = h.translation.explain({ word: ' river ', sentence: 'The river flows.' });
  assert.equal(worker.sent[1].word, 'river');
  worker.reply({ id: worker.sent[1].id, type: 'result', result });
  assert.deepEqual(await promise, result);
  await h.translation.prepare();
  assert.equal(h.workers.length, 1);
});

test('input and queue limits prevent unbounded worker work', async t => {
  const h = fixture(t), worker = await ready(h);
  assert.throws(() => translationInput({ word: 'a', sentence: 'x'.repeat(1201) }), /1,200/);
  assert.throws(() => translationInput({ word: {}, sentence: 'sentence' }), /英文/);
  const pending = Array.from({ length: 3 }, () => h.translation.explain({ word: 'river', sentence: 'The river flows.' }));
  const settled = Promise.allSettled(pending);
  await assert.rejects(h.translation.explain({ word: 'river', sentence: 'The river flows.' }), /等候/);
  assert.equal(worker.sent.length, 2);
  for (let i = 0; i < 3; i++) worker.reply({ id: worker.sent.at(-1).id, type: 'result', result });
  assert.equal((await settled).every(item => item.status === 'fulfilled'), true);
});

test('canceling download terminates its worker and ignores late ready messages', async t => {
  const h = fixture(t), controller = new AbortController();
  const promise = h.translation.prepare({ signal: controller.signal });
  const worker = h.workers[0];
  controller.abort();
  await assert.rejects(promise, { name: 'AbortError' });
  assert.equal(worker.terminated, true);
  worker.reply({ id: 1, type: 'ready' });
  assert.equal(h.translation.status.ready, false);
  await ready(h);
  assert.equal(h.workers.length, 2);
});

test('canceling queued work removes it; canceling active work discards output without unloading the model', async t => {
  const h = fixture(t), worker = await ready(h);
  const activeAbort = new AbortController(), queuedAbort = new AbortController();
  const a = h.translation.explain({ word: 'river', sentence: 'First sentence.', signal: activeAbort.signal });
  const b = h.translation.explain({ word: 'leaf', sentence: 'Second sentence.', signal: queuedAbort.signal });
  queuedAbort.abort(); activeAbort.abort();
  await assert.rejects(a, { name: 'AbortError' });
  await assert.rejects(b, { name: 'AbortError' });
  assert.equal(worker.terminated, false);
  const c = h.translation.explain({ word: 'tree', sentence: 'Third sentence.' });
  assert.equal(worker.sent.length, 2);
  worker.reply({ id: worker.sent[1].id, type: 'result', result });
  assert.equal(worker.sent.length, 3);
  assert.equal(worker.sent[2].word, 'tree');
  worker.reply({ id: worker.sent[2].id, type: 'result', result });
  assert.deepEqual(await c, result);
});

test('active inference still has a deadline after its caller aborts', async t => {
  const h = fixture(t, { inferenceTimeoutMs: 15 }), worker = await ready(h);
  const controller = new AbortController();
  const a = h.translation.explain({ word: 'river', sentence: 'The river flows.', signal: controller.signal });
  controller.abort(); await assert.rejects(a, { name: 'AbortError' });
  const b = h.translation.explain({ word: 'leaf', sentence: 'A green leaf.' });
  await assert.rejects(b, /逾時/);
  assert.equal(worker.terminated, true);
  assert.equal(h.translation.status.ready, false);
});

test('worker crashes reject active and queued callers without leaking raw runtime errors', async t => {
  const h = fixture(t), worker = await ready(h);
  const a = h.translation.explain({ word: 'river', sentence: 'The river flows.' });
  const b = h.translation.explain({ word: 'leaf', sentence: 'A green leaf.' });
  worker.onerror({ message: 'private runtime detail', preventDefault() {} });
  await assert.rejects(a, /記憶體/); await assert.rejects(b, /記憶體/);
  assert.doesNotMatch(h.translation.status.message, /private/);
  assert.equal(worker.terminated, true);
});

test('destroy releases worker and rejects work; already-aborted signals never start work', async t => {
  const h = fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(h.translation.prepare({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(h.workers.length, 0);
  const worker = await ready(h);
  const a = h.translation.explain({ word: 'river', sentence: 'The river flows.' });
  h.translation.destroy();
  await assert.rejects(a, { name: 'AbortError' });
  assert.equal(worker.terminated, true);
  await assert.rejects(h.translation.prepare(), /關閉/);
});
