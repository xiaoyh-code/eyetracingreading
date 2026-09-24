/** Credentials live only in this page's memory. Never persist or serialize them. */
export const TOKENHUB_BASE_URL = 'https://tokenhub.tencentmaas.com/v1';
export const TOKENHUB_MODEL = 'hy-image-v3';
const OFFICIAL_HOSTS = new Set([
  'tokenhub.tencentmaas.com', 'tokenhub-intl.tencentmaas.com',
  'tokenhub.tencentmaas.cn', 'tokenhub-intl.tencentmaas.cn',
  'tokenhub.tencentcloudmaas.com', 'tokenhub-intl.tencentcloudmaas.com',
  'tokenhub-us.tencentcloudmaas.com',
]);

export function tokenHubBaseURL(value) {
  const invalid = () => new Error('請選擇官方 TokenHub HTTPS 服務網址。');
  if (typeof value !== 'string' || /[\s\\\x00-\x1f\x7f]/.test(value)) throw invalid();
  let url;
  try { url = new URL(value); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || !OFFICIAL_HOSTS.has(url.hostname) || url.username || url.password
      || url.port || url.search || url.hash || !['/v1', '/v1/'].includes(url.pathname)) throw invalid();
  return `${url.origin}/v1`;
}

export class SessionCredentials {
  #key = '';
  #base = TOKENHUB_BASE_URL;
  #revision = 0;
  #listeners = new Set();

  constructor({ scope = globalThis } = {}) {
    this.scope = scope;
    this.pagehide = () => this.clear('pagehide');
    this.pageshow = event => { if (event.persisted) this.clear('pageshow'); };
    scope.addEventListener?.('pagehide', this.pagehide);
    scope.addEventListener?.('pageshow', this.pageshow);
  }

  get revision() { return this.#revision; }
  snapshot() { return { configured: !!this.#key, base_url: this.#base, model: TOKENHUB_MODEL, active: !!this.#key }; }
  subscribe(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  #notify(reason) {
    this.#revision++;
    for (const listener of this.#listeners) {
      try { listener(this.snapshot(), reason); } catch { /* Clearing every subscriber must continue. */ }
    }
  }

  update({ api_key = null, base_url = this.#base } = {}) {
    const base = tokenHubBaseURL(base_url);
    let key = api_key;
    if (key !== null && key !== undefined) {
      if (typeof key !== 'string') throw new Error('API Key 格式不正確，請重新貼上。');
      key = key.trim();
      if (key && (key.length > 512 || !/^[\x21-\x7e]+$/.test(key))) throw new Error('API Key 格式不正確，請重新貼上。');
    }
    if (!key && !this.#key) throw new Error('請先輸入本次使用的 TokenHub API Key。');
    if (key) this.#key = key;
    this.#base = base;
    this.#notify('update');
    return this.snapshot();
  }

  clear(reason = 'disconnect') {
    this.#key = '';
    this.#notify(reason);
    return this.snapshot();
  }

  withTokenHub(callback) {
    if (!this.#key) throw new Error('本次尚未連接 TokenHub。請在 API 設定輸入密鑰。');
    return callback(this.#base, `Bearer ${this.#key}`);
  }

  destroy() {
    this.clear('destroy');
    this.scope.removeEventListener?.('pagehide', this.pagehide);
    this.scope.removeEventListener?.('pageshow', this.pageshow);
    this.#listeners.clear();
  }
}

export const sessionCredentials = new SessionCredentials();
