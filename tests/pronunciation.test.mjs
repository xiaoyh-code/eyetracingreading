import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../reader/static/pronunciation.js', import.meta.url), 'utf8');
const { localEnglishVoice, PronunciationPlayer } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const english = { name: 'Local English', lang: 'en-US', localService: true, default: true };
const remote = { name: 'Remote English', lang: 'en-US', localService: false, default: true };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const audioResponse = (label = 'local audio') => ({ ok: true, blob: async () => new Blob([label], { type: 'audio/wav' }) });

function harness(t, { voices = [english], browserAPI = true, fetchResponse = async () => audioResponse(), audioPlay = async () => {} } = {}) {
  const events = [], availability = [], utterances = [], audio = [], requests = [], created = [], revoked = [];
  const listeners = new Map();
  const synth = {
    voices, cancels: 0,
    getVoices() { return this.voices; },
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); },
    speak(utterance) { utterances.push(utterance); },
    cancel() { this.cancels += 1; },
  };
  const scope = {
    fetch: async (url, options) => { requests.push({ url, ...options }); return fetchResponse(url, options); },
    URL: {
      createObjectURL(blob) { const url = `blob:local-test-${created.length + 1}`; created.push({ url, blob }); return url; },
      revokeObjectURL(url) { revoked.push(url); },
    },
    Audio: class {
      constructor(url) { this.src = url; this.pauses = 0; this.loads = 0; this.removed = []; audio.push(this); }
      play() { return audioPlay(this); }
      pause() { this.pauses += 1; }
      removeAttribute(name) { this.removed.push(name); if (name === 'src') this.src = ''; }
      load() { this.loads += 1; }
    },
  };
  if (browserAPI) {
    scope.speechSynthesis = synth;
    scope.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  }
  const player = new PronunciationPlayer({ scope, onStatus: event => events.push(event), onAvailability: value => availability.push(value) });
  t.after(() => player.destroy());
  return { player, scope, synth, listeners, events, availability, utterances, audio, requests, created, revoked };
}

test('only explicitly local English voices are eligible; an en-US default is preferred', () => {
  const british = { lang: 'en-GB', localService: true, default: true };
  const american = { lang: 'en-US', localService: true, default: false };
  const underscore = { lang: 'en_US', localService: true, default: true };
  const chinese = { lang: 'zh-TW', localService: true, default: true };
  assert.equal(localEnglishVoice([remote, chinese, { lang: 'en-US' }, { lang: 'en-US', localService: 1 }]), null);
  assert.equal(localEnglishVoice([{ lang: 'english', localService: true }, { lang: 'enochian', localService: true }]), null);
  assert.equal(localEnglishVoice([remote, british, american, underscore]), underscore);
  assert.equal(localEnglishVoice([british, american]), american);
  assert.equal(localEnglishVoice([{ lang: 'en-AU', localService: true }, british]), british);
  assert.equal(localEnglishVoice([{ lang: 'EN', localService: true }])?.lang, 'EN');
  assert.equal(localEnglishVoice(), null);
});

test('construction, availability checks, and delayed voice events never autoplay', async t => {
  const h = harness(t, { voices: [] });
  assert.equal(h.player.availability().available, false);
  h.synth.voices = [english];
  h.listeners.get('voiceschanged')();
  assert.equal(h.availability.at(-1).available, true);
  assert.equal(h.utterances.length, 0);
  assert.equal(h.requests.length, 0);
  await h.player.play('quiet', 'sidebar');
  assert.equal(h.utterances.length, 1);
});

test('a local browser voice is explicitly selected instead of remote voices or HTTP fallback', async t => {
  const h = harness(t, { voices: [remote, english] });
  h.player.setLocalAudioAvailable(true);
  await h.player.play('  serendipity  ', 'sidebar');
  const utterance = h.utterances[0];
  assert.equal(utterance.text, 'serendipity');
  assert.equal(utterance.voice, english);
  assert.equal(utterance.lang, 'en-US');
  assert.equal(h.requests.length, 0);
  utterance.onstart();
  assert.deepEqual(h.events.at(-1), { state: 'playing', word: 'serendipity', sourceId: 'sidebar', message: '正在播放英文發音 · 再按可停止' });
  utterance.onend();
  assert.equal(h.player.active, null);
  assert.equal(h.events.at(-1).state, 'idle');
});

test('a remote-only browser cannot silently pronounce a word', async t => {
  const h = harness(t, { voices: [remote] });
  assert.equal(h.player.availability().available, false);
  await h.player.play('river', 'sidebar');
  assert.equal(h.utterances.length, 0);
  assert.equal(h.requests.length, 0);
  assert.equal(h.player.active, null);
  assert.equal(h.events.at(-1).state, 'error');
  assert.match(h.events.at(-1).message, /本機英文聲音/);
});

test('clicking the same word and source again stops instead of speaking twice', async t => {
  const h = harness(t);
  await h.player.play('river', 'sidebar');
  await h.player.play('river', 'sidebar');
  assert.equal(h.utterances.length, 1);
  assert.equal(h.synth.cancels, 1);
  assert.equal(h.player.active, null);
  assert.equal(h.events.at(-1).state, 'idle');
});

test('a different word cancels the former utterance and ignores every stale callback', async t => {
  const h = harness(t);
  await h.player.play('river', 'sidebar');
  const former = h.utterances[0];
  await h.player.play('leaf', 'focus');
  const active = h.player.active;
  const count = h.events.length;
  former.onstart(); former.onend(); former.onerror();
  assert.equal(h.synth.cancels, 1);
  assert.equal(h.player.active, active);
  assert.equal(h.events.length, count);
  h.utterances[1].onstart();
  assert.equal(h.events.at(-1).word, 'leaf');
  assert.equal(h.events.at(-1).sourceId, 'focus');
});

test('the same word from another button transfers playback to that source', async t => {
  const h = harness(t);
  await h.player.play('river', 'sidebar');
  await h.player.play('river', 'flashcard');
  assert.equal(h.utterances.length, 2);
  assert.equal(h.synth.cancels, 1);
  assert.equal(h.player.active.sourceId, 'flashcard');
});

test('absence of browser speech APIs is handled without throwing or requesting audio', async t => {
  const h = harness(t, { browserAPI: false });
  assert.equal(h.player.availability().available, false);
  await h.player.play('quiet', 'sidebar');
  assert.equal(h.requests.length, 0);
  assert.equal(h.audio.length, 0);
  assert.equal(h.player.active, null);
  assert.equal(h.events.at(-1).state, 'error');
});

test('local audio fallback posts only the selected word to the same-origin speech endpoint', async t => {
  const h = harness(t, { browserAPI: false });
  h.player.setLocalAudioAvailable(true);
  assert.equal(h.availability.at(-1).available, true);
  assert.equal(h.requests.length, 0);
  await h.player.play('quiet', 'sidebar');
  assert.equal(h.requests.length, 1);
  const request = h.requests[0];
  assert.equal(request.url, '/api/speech');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(request.body), { word: 'quiet' });
  assert.equal(request.signal.aborted, false);
  assert.equal(h.audio.length, 1);
  assert.equal(h.audio[0].src, h.created[0].url);
  h.audio[0].onplaying();
  assert.equal(h.events.at(-1).state, 'playing');
});

test('local HTTP fallback remains eligible when the browser offers only remote voices', async t => {
  const h = harness(t, { voices: [remote] });
  h.player.setLocalAudioAvailable(true);
  await h.player.play('forest', 'sidebar');
  assert.equal(h.utterances.length, 0);
  assert.equal(h.requests.length, 1);
  assert.equal(h.audio.length, 1);
});

test('stopping a pending fetch aborts it and its late response cannot create an Audio object', async t => {
  const pending = deferred();
  const h = harness(t, { browserAPI: false, fetchResponse: () => pending.promise });
  h.player.setLocalAudioAvailable(true);
  const playback = h.player.play('forest', 'focus');
  assert.equal(h.requests.length, 1);
  h.player.stop();
  assert.equal(h.requests[0].signal.aborted, true);
  const count = h.events.length;
  pending.resolve(audioResponse());
  await playback;
  assert.equal(h.created.length, 0);
  assert.equal(h.audio.length, 0);
  assert.equal(h.events.length, count);
  assert.equal(h.player.active, null);
});

test('an old blob resolving after a new word cannot replace or interrupt the current audio', async t => {
  const blob = deferred();
  const h = harness(t, {
    browserAPI: false,
    fetchResponse: (_, options) => JSON.parse(options.body).word === 'forest'
      ? { ok: true, blob: () => blob.promise } : audioResponse('new word'),
  });
  h.player.setLocalAudioAvailable(true);
  const previous = h.player.play('forest', 'sidebar');
  await Promise.resolve();
  await h.player.play('leaf', 'focus');
  const current = h.player.active;
  const count = h.events.length;
  blob.resolve(new Blob(['stale word']));
  await previous;
  assert.equal(h.requests[0].signal.aborted, true);
  assert.equal(h.created.length, 1);
  assert.equal(h.audio.length, 1);
  assert.equal(h.audio[0].pauses, 0);
  assert.equal(h.player.active, current);
  assert.equal(h.events.length, count);
});

for (const outcome of ['onended', 'onerror']) {
  test(`audio ${outcome} releases its blob, media source, and active state exactly once`, async t => {
    const h = harness(t, { browserAPI: false });
    h.player.setLocalAudioAvailable(true);
    await h.player.play('leaf', 'sidebar');
    const audio = h.audio[0];
    audio[outcome]();
    assert.deepEqual(h.revoked, [h.created[0].url]);
    assert.equal(audio.pauses, 1);
    assert.deepEqual(audio.removed, ['src']);
    assert.equal(audio.loads, 1);
    assert.equal(h.player.active, null);
    assert.equal(h.events.at(-1).state, outcome === 'onerror' ? 'error' : 'idle');
    const count = h.events.length;
    audio.onplaying(); audio.onended(); audio.onerror();
    assert.equal(h.events.length, count);
    assert.equal(h.revoked.length, 1);
  });
}

test('HTTP and media-play failures become user-visible errors and release resources', async t => {
  const unavailable = harness(t, { browserAPI: false, fetchResponse: async () => ({ ok: false }) });
  unavailable.player.setLocalAudioAvailable(true);
  await unavailable.player.play('leaf', 'sidebar');
  assert.equal(unavailable.events.at(-1).state, 'error');
  assert.equal(unavailable.audio.length, 0);
  assert.equal(unavailable.player.active, null);
  const blocked = harness(t, { browserAPI: false, audioPlay: async () => { throw new Error('playback blocked'); } });
  blocked.player.setLocalAudioAvailable(true);
  await blocked.player.play('leaf', 'sidebar');
  assert.equal(blocked.events.at(-1).state, 'error');
  assert.deepEqual(blocked.revoked, [blocked.created[0].url]);
  assert.equal(blocked.audio[0].pauses, 1);
  assert.equal(blocked.player.active, null);
});

test('an AbortError from the current media playback still releases its blob and loading state', async t => {
  const h = harness(t, { browserAPI: false, audioPlay: async () => {
    const error = new Error('The browser interrupted media playback');
    error.name = 'AbortError';
    throw error;
  } });
  h.player.setLocalAudioAvailable(true);
  await h.player.play('leaf', 'sidebar');
  assert.equal(h.player.active, null, 'only an obsolete/stopped request may silently ignore AbortError');
  assert.deepEqual(h.revoked, [h.created[0].url]);
  assert.equal(h.events.at(-1).state, 'error');
});

test('English validation rejects sentences, markup, non-English text, and excessive length', async t => {
  const h = harness(t);
  h.player.setLocalAudioAvailable(true);
  for (const word of ['', null, undefined, 'two words', '<script>', '中文', 'word123', '-word', "'word", 'word-', 'hello!', 'a'.repeat(81)]) {
    await h.player.play(word, 'sidebar');
    assert.equal(h.events.at(-1).state, 'error', String(word));
    assert.equal(h.player.active, null);
  }
  assert.equal(h.utterances.length, 0);
  assert.equal(h.requests.length, 0);
  for (const word of ['quiet', "can't", 'can’t', 'well-being', 'a'.repeat(80)]) {
    await h.player.play(word, 'sidebar');
    assert.equal(h.utterances.at(-1).text, word);
    h.player.stop();
  }
  assert.equal(h.utterances.length, 5);
});

test('destroy removes the voice listener, cancels synthesis, and ignores stale callbacks', async t => {
  const h = harness(t);
  assert.equal(h.listeners.has('voiceschanged'), true);
  await h.player.play('forest', 'sidebar');
  h.player.destroy();
  assert.equal(h.listeners.has('voiceschanged'), false);
  assert.equal(h.synth.cancels, 1);
  assert.equal(h.player.active, null);
  const count = h.events.length;
  h.utterances[0].onend(); h.utterances[0].onerror();
  h.player.destroy();
  assert.equal(h.events.length, count);
  assert.equal(h.synth.cancels, 1);
});

test('destroy aborts pending fallback and a late result cannot allocate media resources', async t => {
  const pending = deferred();
  const h = harness(t, { browserAPI: false, fetchResponse: () => pending.promise });
  h.player.setLocalAudioAvailable(true);
  const playback = h.player.play('forest', 'sidebar');
  h.player.destroy();
  assert.equal(h.requests[0].signal.aborted, true);
  pending.resolve(audioResponse());
  await playback;
  assert.equal(h.audio.length, 0);
  assert.equal(h.created.length, 0);
  assert.equal(h.player.active, null);
});

test('destroy releases an already playing local audio URL without double-revoking it', async t => {
  const h = harness(t, { browserAPI: false });
  h.player.setLocalAudioAvailable(true);
  await h.player.play('forest', 'sidebar');
  h.player.destroy();
  h.player.destroy();
  assert.equal(h.audio[0].pauses, 1);
  assert.equal(h.audio[0].loads, 1);
  assert.deepEqual(h.revoked, [h.created[0].url]);
});
