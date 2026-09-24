/** Local credential entry. Stored credentials are never returned to this form. */
export class TokenHubSettings {
  constructor({ api, onSaved, onMessage = () => {} }) {
    this.api = api;
    this.onSaved = onSaved;
    this.onMessage = onMessage;
    this.dialog = document.getElementById('api-settings-dialog');
    this.form = document.getElementById('api-settings-form');
    this.key = document.getElementById('tokenhub-api-key');
    this.base = document.getElementById('tokenhub-base-url');
    this.save = document.getElementById('tokenhub-settings-save');
    this.status = document.getElementById('tokenhub-settings-status');
    this.summary = document.getElementById('api-settings-summary');
    this.requestId = 0;
    this.loading = false;
    this.saving = false;
    this.reloadAfterSave = false;
    this.abort = new AbortController();
    this.form.addEventListener('submit', event => { event.preventDefault(); this.submit(); }, { signal: this.abort.signal });
    this.dialog.addEventListener('close', () => {
      this.requestId++;
      this.key.value = '';
      this.status.textContent = '';
    }, { signal: this.abort.signal });
  }

  controls(disabled) {
    this.key.disabled = disabled;
    this.base.disabled = disabled;
    this.save.disabled = disabled;
  }

  setSummary(settings) {
    this.summary.textContent = settings.configured
      ? settings.active ? 'TokenHub Key 已設定 · 單字生圖' : 'TokenHub Key 已設定，尚未選用'
      : '輸入 TokenHub Key，按需為單字生圖';
  }

  async refreshSummary() {
    const version = this.requestId;
    try {
      const settings = await this.api('/api/settings/tokenhub');
      if (version === this.requestId) this.setSummary(settings);
    } catch { /* Keep the settings button usable for an explicit retry. */ }
  }

  async load() {
    const version = ++this.requestId;
    this.key.value = '';
    this.controls(true);
    if (this.saving) {
      this.reloadAfterSave = true;
      this.status.textContent = '正在儲存設定…';
      return;
    }
    this.reloadAfterSave = false;
    this.loading = true;
    this.status.textContent = '正在讀取本機設定…';
    try {
      const settings = await this.api('/api/settings/tokenhub');
      if (version !== this.requestId || !this.dialog.open) return;
      this.setSummary(settings);
      // The server restricts URLs to official TokenHub endpoints. Preserve a
      // supported existing alias even when it is not a default select option.
      if (![...this.base.options].some(option => option.value === settings.base_url)) {
        this.base.add(new Option(settings.base_url, settings.base_url));
      }
      this.base.value = settings.base_url;
      this.key.placeholder = settings.configured ? '已設定；留空保留目前的 Key' : '貼上你的 TokenHub API Key';
      this.status.textContent = settings.configured ? '已設定 API Key，密鑰內容不會顯示。' : '尚未設定 API Key。';
      this.controls(false);
    } catch (error) {
      if (version === this.requestId && this.dialog.open) this.status.textContent = `${error.message} 關閉後重開可再試。`;
    } finally {
      if (version === this.requestId) this.loading = false;
    }
  }

  async submit() {
    if (this.loading || this.saving || this.save.disabled) return;
    const body = { api_key: this.key.value.trim() || null, base_url: this.base.value };
    this.key.value = '';
    this.saving = true;
    this.controls(true);
    this.status.textContent = '正在儲存到本機…';
    try {
      const settings = await this.api('/api/settings/tokenhub', { body });
      this.requestId++;
      this.setSummary(settings);
      this.key.placeholder = '已設定；留空保留目前的 Key';
      this.onSaved(settings);
      if (this.dialog.open) this.status.textContent = '已儲存並即時生效；尚未向 TokenHub 驗證權限或生圖。';
      else this.onMessage('TokenHub API 設定已儲存並生效。');
    } catch (error) {
      if (this.dialog.open) this.status.textContent = error.message;
      else this.onMessage(error.message);
    } finally {
      body.api_key = null;
      this.saving = false;
      this.loading = false;
      this.controls(false);
      if (this.reloadAfterSave && this.dialog.open) {
        this.reloadAfterSave = false;
        this.load();
      }
    }
  }

  destroy() { this.abort.abort(); this.requestId++; this.key.value = ''; }
}
