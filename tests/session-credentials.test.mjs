import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionCredentials, TOKENHUB_BASE_URL, tokenHubBaseURL } from '../reader/static/session-credentials.js';

const KEY = 'FAKE_TEST_KEY';
function setup(t) {
  const scope = new EventTarget();
  for (const name of ['localStorage', 'sessionStorage', 'indexedDB']) Object.defineProperty(scope, name, { get() { throw new Error('Persistence must never be used'); } });
  const credentials = new SessionCredentials({ scope });
  t.after(() => credentials.destroy());
  return { scope, credentials };
}

test('session keys are never exposed in settings snapshots or stored in browser storage', t => {
  const { credentials } = setup(t);
  const settings = credentials.update({ api_key: KEY, base_url: TOKENHUB_BASE_URL });
  assert.deepEqual(settings, { configured: true, active: true, base_url: TOKENHUB_BASE_URL, model: 'hy-image-v3' });
  assert.equal(JSON.stringify(settings).includes(KEY), false);
  assert.equal(Object.keys(credentials).some(key => /api.?key/i.test(key)), false);
  let authorized;
  credentials.withTokenHub((base, authorization) => { authorized = [base, authorization]; });
  assert.deepEqual(authorized, [TOKENHUB_BASE_URL, `Bearer ${KEY}`]);
  credentials.clear();
  assert.equal(credentials.snapshot().configured, false);
  assert.throws(() => credentials.withTokenHub(() => {}), /尚未連接/);
});

test('blank update preserves only an existing session key and input objects are not retained', t => {
  const { credentials } = setup(t);
  assert.throws(() => credentials.update({ api_key: null }), /先輸入/);
  const body = { api_key: KEY };
  credentials.update(body);
  body.api_key = 'DIFFERENT_FAKE_KEY';
  credentials.update({ api_key: '', base_url: 'https://tokenhub-intl.tencentmaas.com/v1' });
  credentials.withTokenHub((base, authorization) => {
    assert.equal(base, 'https://tokenhub-intl.tencentmaas.com/v1');
    assert.equal(authorization, `Bearer ${KEY}`);
  });
  const snapshot = credentials.snapshot(); snapshot.configured = false;
  assert.equal(credentials.snapshot().configured, true);
});

test('leaving the page and BFCache restoration clear credentials, with revision notifications', t => {
  const { credentials, scope } = setup(t);
  const reasons = []; credentials.subscribe((snapshot, reason) => reasons.push({ snapshot, reason }));
  credentials.update({ api_key: KEY });
  const first = credentials.revision;
  scope.dispatchEvent(new Event('pagehide'));
  assert.equal(credentials.snapshot().configured, false);
  assert.ok(credentials.revision > first);
  credentials.update({ api_key: KEY });
  const restored = new Event('pageshow'); Object.defineProperty(restored, 'persisted', { value: true });
  scope.dispatchEvent(restored);
  assert.equal(credentials.snapshot().configured, false);
  assert.deepEqual(reasons.map(({ reason }) => reason), ['update', 'pagehide', 'update', 'pageshow']);
  assert.equal(JSON.stringify(reasons).includes(KEY), false);
});

test('only fixed official HTTPS region bases are accepted and invalid updates are atomic', t => {
  const { credentials } = setup(t); credentials.update({ api_key: KEY });
  assert.equal(tokenHubBaseURL('https://tokenhub.tencentcloudmaas.com:443/v1/'), 'https://tokenhub.tencentcloudmaas.com/v1');
  for (const base_url of ['http://tokenhub.tencentmaas.com/v1', 'https://attacker.example/v1',
    'https://tokenhub.tencentmaas.com.attacker.example/v1', 'https://secret@tokenhub.tencentmaas.com/v1',
    'https://tokenhub.tencentmaas.com/v1?key=FAKE', 'https://tokenhub.tencentmaas.com:8443/v1',
    'https://tokenhub.tencentmaas.com/v1/other', 'https://tokenhub.tencentmaas.com\\@attacker.example/v1',
    'https://tokenhub.tencentmaas.com/v1#secret', ' https://tokenhub.tencentmaas.com/v1']) {
    assert.throws(() => credentials.update({ api_key: 'NEW_FAKE', base_url }), /官方/);
    assert.equal(credentials.snapshot().base_url, TOKENHUB_BASE_URL);
    credentials.withTokenHub((_, authorization) => assert.equal(authorization, `Bearer ${KEY}`));
  }
});

test('invalid or oversized credentials never appear in errors', t => {
  const { credentials } = setup(t);
  for (const api_key of ['FAKE\nKEY', 'FAKE KEY', '假密鑰', 'X'.repeat(513), { api_key: KEY }]) {
    assert.throws(() => credentials.update({ api_key }), error => !error.message.includes(KEY) && /格式/.test(error.message));
    assert.equal(credentials.snapshot().configured, false);
  }
});

test('destroy clears state, removes lifecycle callbacks, and notifies every subscriber', t => {
  const { credentials, scope } = setup(t);
  let count = 0;
  credentials.subscribe(() => { throw new Error('UI failure'); });
  credentials.subscribe(() => count++);
  credentials.update({ api_key: KEY });
  credentials.destroy();
  assert.equal(credentials.snapshot().configured, false);
  assert.equal(count, 2);
  const revision = credentials.revision;
  scope.dispatchEvent(new Event('pagehide'));
  assert.equal(credentials.revision, revision);
});
