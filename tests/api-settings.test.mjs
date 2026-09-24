import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenHubSettings } from '../reader/static/api-settings.js';
import { SessionCredentials, TOKENHUB_BASE_URL } from '../reader/static/session-credentials.js';

const KEY = 'FAKE_TEST_KEY';
function setup(t, apiOverride) {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const ids = ['api-settings-dialog', 'api-settings-form', 'tokenhub-api-key', 'tokenhub-base-url', 'tokenhub-settings-save', 'tokenhub-settings-disconnect', 'tokenhub-settings-status', 'api-settings-summary'];
  const elements = Object.fromEntries(ids.map(id => [id, Object.assign(new EventTarget(), { value: '', textContent: '', disabled: true, open: true })]));
  elements['tokenhub-base-url'].value = TOKENHUB_BASE_URL;
  elements['tokenhub-base-url'].options = [{ value: TOKENHUB_BASE_URL }];
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { getElementById: id => elements[id] } });
  const scope = new EventTarget();
  const credentials = new SessionCredentials({ scope });
  const saved = [], messages = [], requests = [];
  const api = apiOverride || (async (path, { body, method = body === undefined ? 'GET' : 'POST' } = {}) => {
    requests.push({ path, method });
    return method === 'POST' ? credentials.update(body) : method === 'DELETE' ? credentials.clear() : credentials.snapshot();
  });
  const settings = new TokenHubSettings({ api, credentials, onSaved: value => saved.push(value), onMessage: value => messages.push(value) });
  t.after(() => {
    settings.destroy(); credentials.destroy();
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else delete globalThis.document;
  });
  return { settings, elements, credentials, scope, saved, messages, requests };
}

test('session form never repopulates secrets and connects without a verification or image request', async t => {
  const h = setup(t);
  await h.settings.load();
  assert.equal(h.elements['tokenhub-settings-save'].disabled, false);
  assert.equal(h.elements['tokenhub-settings-disconnect'].disabled, true);
  h.elements['tokenhub-api-key'].value = KEY;
  const submitting = h.settings.submit();
  assert.equal(h.elements['tokenhub-api-key'].value, '', 'clear input before awaiting any operation');
  await submitting;
  assert.equal(h.credentials.snapshot().configured, true);
  assert.equal(h.saved.at(-1).configured, true);
  assert.equal(h.elements['tokenhub-settings-disconnect'].disabled, false);
  assert.match(h.elements['tokenhub-settings-status'].textContent, /尚未驗證.*本頁面/);
  await h.settings.load();
  assert.equal(h.elements['tokenhub-api-key'].value, '');
  assert.deepEqual(h.requests.map(item => item.path), ['/api/settings/tokenhub', '/api/settings/tokenhub', '/api/settings/tokenhub']);
  assert.equal(JSON.stringify(h.saved).includes(KEY), false);
  for (const element of Object.values(h.elements)) assert.equal(element.textContent.includes(KEY), false);
});

test('disconnect empties input, clears credentials, updates availability, and explains in-flight billing', async t => {
  const h = setup(t); h.credentials.update({ api_key: KEY });
  await h.settings.load();
  h.elements['tokenhub-api-key'].value = 'UNSAVED_FAKE';
  await h.settings.disconnectSession();
  assert.equal(h.credentials.snapshot().configured, false);
  assert.equal(h.elements['tokenhub-api-key'].value, '');
  assert.equal(h.elements['tokenhub-settings-disconnect'].disabled, true);
  assert.equal(h.saved.at(-1).configured, false);
  assert.match(h.elements['tokenhub-settings-status'].textContent, /可能仍會計費/);
  assert.equal(h.requests.at(-1).method, 'DELETE');
});

test('close, destroy, and pagehide clear sensitive input even without form submission', async t => {
  const h = setup(t); h.credentials.update({ api_key: KEY });
  h.elements['tokenhub-api-key'].value = KEY;
  h.elements['api-settings-dialog'].dispatchEvent(new Event('close'));
  assert.equal(h.elements['tokenhub-api-key'].value, '');
  h.elements['tokenhub-api-key'].value = KEY;
  h.scope.dispatchEvent(new Event('pagehide'));
  assert.equal(h.elements['tokenhub-api-key'].value, '');
  assert.equal(h.saved.at(-1).configured, false);
  h.elements['tokenhub-api-key'].value = KEY;
  h.settings.destroy();
  assert.equal(h.elements['tokenhub-api-key'].value, '');
});

test('failed submissions do not echo arbitrary exception messages or retain credential payloads', async t => {
  let captured;
  const h = setup(t, async (path, { body } = {}) => {
    if (!body) return { configured: false, active: false, base_url: TOKENHUB_BASE_URL, model: 'hy-image-v3' };
    captured = body;
    throw new Error(`unexpected upstream error echoed ${KEY}`);
  });
  await h.settings.load();
  h.elements['tokenhub-api-key'].value = KEY;
  await h.settings.submit();
  assert.equal(captured.api_key, null);
  assert.equal(h.elements['tokenhub-api-key'].value, '');
  assert.equal(h.elements['tokenhub-settings-status'].textContent.includes(KEY), false);
  assert.match(h.elements['tokenhub-settings-status'].textContent, /請檢查/);
});
