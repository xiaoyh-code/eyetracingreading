/** The form connects this page only: no credential persistence or backend writes. */
import { sessionCredentials, tokenHubBaseURL } from './session-credentials.js';

export class TokenHubSettings {
  constructor({ api, onSaved = () => {}, onMessage = () => {}, credentials = sessionCredentials }) {
    Object.assign(this, { api, onSaved, onMessage });
    this.dialog = document.getElementById('api-settings-dialog');
    this.form = document.getElementById('api-settings-form');
    this.key = document.getElementById('tokenhub-api-key');
    this.base = document.getElementById('tokenhub-base-url');
    this.save = document.getElementById('tokenhub-settings-save');
    this.disconnect = document.getElementById('tokenhub-settings-disconnect');
    this.status = document.getElementById('tokenhub-settings-status');
    this.summary = document.getElementById('api-settings-summary');
    this.requestId = 0; this.loading = false; this.saving = false; this.configured = false;
    this.abort = new AbortController();
    this.form.addEventListener('submit', event => { event.preventDefault(); this.submit(); }, { signal: this.abort.signal });
    this.disconnect?.addEventListener('click', () => this.disconnectSession(), { signal: this.abort.signal });
    this.dialog.addEventListener('close', () => {
      this.requestId++; this.key.value = ''; this.status.textContent = '';
    }, { signal: this.abort.signal });
    this.unsubscribe = credentials.subscribe((settings, reason) => {
      if (reason === 'pagehide' || reason === 'pageshow' || reason === 'destroy') {
        this.key.value = ''; this.setSummary(settings); this.onSaved(settings);
        this.status.textContent = '本次連接已清除；需要生圖時請重新輸入密鑰。';
      }
    });
  }

  controls(disabled) {
    this.key.disabled = disabled; this.base.disabled = disabled; this.save.disabled = disabled;
    if (this.disconnect) this.disconnect.disabled = disabled || !this.configured;
  }

  setSummary(settings) {
    this.configured = !!settings.configured;
    this.summary.textContent = this.configured ? 'TokenHub 本次已連接 · 密鑰只在頁面記憶體內' : '輸入 TokenHub Key，本次按需生圖';
    if (this.disconnect) this.disconnect.disabled = !this.configured || this.loading || this.saving;
  }

  async refreshSummary() {
    const version = this.requestId;
    try { const settings = await this.api('/api/settings/tokenhub'); if (version === this.requestId) this.setSummary(settings); }
    catch { /* The visible settings control remains usable. */ }
  }

  async load() {
    const version = ++this.requestId;
    this.key.value = ''; this.loading = true; this.controls(true);
    this.status.textContent = '正在讀取本次連接狀態…';
    try {
      const settings = await this.api('/api/settings/tokenhub');
      if (version !== this.requestId || !this.dialog.open) return;
      this.setSummary(settings);
      const base = tokenHubBaseURL(settings.base_url);
      if (![...this.base.options].some(option => option.value === base)) this.base.add(new Option(base, base));
      this.base.value = base;
      this.key.placeholder = settings.configured ? '本次已連接；留空保留目前的 Key' : '貼上本次使用的 TokenHub API Key';
      this.save.textContent = settings.configured ? '更新本次連接' : '連接本次使用';
      this.status.textContent = settings.configured ? '密鑰及防重複生圖紀錄只在本頁面內；重新整理或離開頁面會清除。' : '尚未連接。輸入密鑰只會更新本頁狀態，不會驗證或生圖。';
    } catch {
      if (version === this.requestId && this.dialog.open) this.status.textContent = '未能讀取本次設定，請關閉後重新開啟。';
    } finally {
      if (version === this.requestId) { this.loading = false; this.controls(false); }
    }
  }

  async submit() {
    if (this.loading || this.saving || this.save.disabled) return;
    const body = { api_key: this.key.value.trim() || null, base_url: this.base.value };
    this.key.value = ''; this.saving = true; this.controls(true);
    this.status.textContent = '正在更新本次連接…';
    try {
      const settings = await this.api('/api/settings/tokenhub', { body });
      this.requestId++; this.setSummary(settings); this.onSaved(settings);
      this.key.placeholder = '本次已連接；留空保留目前的 Key';
      this.save.textContent = '更新本次連接';
      if (this.dialog.open) this.status.textContent = '本次已連接；尚未驗證密鑰或生圖。密鑰及防重複生圖紀錄只在本頁面內，重新整理或離開頁面即清除。';
      else this.onMessage('TokenHub 本次已連接，密鑰只留在頁面記憶體內。');
    } catch {
      const message = '未能更新本次連接，請檢查密鑰格式及官方服務網址。';
      if (this.dialog.open) this.status.textContent = message; else this.onMessage(message);
    } finally {
      body.api_key = null; this.saving = false; this.loading = false; this.controls(false);
    }
  }

  async disconnectSession() {
    if (this.saving || this.loading) return;
    this.key.value = ''; this.saving = true; this.controls(true);
    try {
      const settings = await this.api('/api/settings/tokenhub', { method: 'DELETE' });
      this.requestId++; this.setSummary(settings); this.onSaved(settings);
      this.key.placeholder = '貼上本次使用的 TokenHub API Key';
      this.save.textContent = '連接本次使用';
      this.status.textContent = '已清除本次密鑰，並取消未完成的請求。已送出的生圖可能仍會計費，請查看控制台。';
    } catch { this.status.textContent = '未能清除連接，重新整理頁面亦會清除密鑰。'; }
    finally { this.saving = false; this.controls(false); }
  }

  destroy() { this.abort.abort(); this.unsubscribe(); this.requestId++; this.key.value = ''; }
}
