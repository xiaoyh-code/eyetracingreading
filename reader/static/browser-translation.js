// A worker is created only by an explicit prepare() call. Documents never leave this page.
export const TRANSLATION_MODEL = Object.freeze({
  id: 'Xenova/opus-mt-en-zh',
  revision: '046f55aec303cdee3e0318604406d4df20f1e8ea',
});

function aborted() { return new DOMException('翻譯已取消。', 'AbortError'); }

export function translationInput({ word, sentence } = {}) {
  if (typeof word !== 'string' || typeof sentence !== 'string') throw new Error('請選擇英文單字同句子。');
  word = word.trim(); sentence = sentence.trim();
  if (!word || word.length > 80 || !sentence || sentence.length > 1200) {
    throw new Error('本機翻譯每次支援 80 字元嘅單字及 1,200 字元嘅短句，請選擇較短內容。');
  }
  return { word, sentence };
}

export class BrowserTranslation {
  constructor({ onStatus = () => {}, workerFactory = () => new Worker(new URL('./translation-worker.js', import.meta.url), { type: 'module' }), prepareTimeoutMs = 600000, inferenceTimeoutMs = 120000 } = {}) {
    this.onStatus = onStatus;
    this.workerFactory = workerFactory;
    this.prepareTimeoutMs = prepareTimeoutMs;
    this.inferenceTimeoutMs = inferenceTimeoutMs;
    this.worker = null;
    this.sequence = 0;
    this.preparing = null;
    this.active = null;
    this.queue = [];
    this.destroyed = false;
    this.status = Object.freeze({ state: 'idle', ready: false, message: '尚未下載瀏覽器翻譯模型。' });
  }

  _status(state, message, progress) {
    this.status = Object.freeze({ state, ready: state === 'ready', message, ...(progress ? { progress } : {}) });
    try { this.onStatus(this.status); } catch { /* UI callbacks must not break cleanup. */ }
  }

  _settle(job, error, result) {
    if (!job || job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.abort);
    if (error) job.reject(error); else job.resolve(result);
  }

  _reset(error, state = 'error', message = error.message) {
    clearTimeout(this.active?.deadline);
    this.worker?.terminate();
    this.worker = null;
    this._settle(this.preparing, error);
    this.preparing = null;
    this._settle(this.active, error);
    this.active = null;
    for (const job of this.queue.splice(0)) this._settle(job, error);
    this._status(state, message);
  }

  prepare({ onProgress = () => {}, signal } = {}) {
    if (this.destroyed) return Promise.reject(new Error('翻譯工具已關閉。'));
    if (signal?.aborted) return Promise.reject(aborted());
    if (this.status.ready) return Promise.resolve(this.status);
    if (this.preparing) return Promise.reject(new Error('翻譯模型正在準備，請稍候。'));
    this._status('loading', '正在下載翻譯模型到瀏覽器；首次需要網絡及足夠記憶體。');
    return new Promise((resolve, reject) => {
      const job = this.preparing = { id: ++this.sequence, resolve, reject, signal, onProgress };
      job.abort = () => this._reset(aborted(), 'idle', '已取消下載；可稍後重新準備翻譯。');
      signal?.addEventListener('abort', job.abort, { once: true });
      job.timer = setTimeout(() => this._reset(new Error('模型下載或初始化逾時；請檢查網絡及瀏覽器可用空間後再試。')), this.prepareTimeoutMs);
      try {
        const worker = this.worker = this.workerFactory();
        worker.onmessage = event => { if (this.worker === worker) this._message(event.data); };
        worker.onerror = event => {
          event.preventDefault?.();
          if (this.worker === worker) this._reset(new Error('瀏覽器翻譯未能執行，可能記憶體不足或模型未完整下載。請關閉其他分頁後重試。'));
        };
        worker.onmessageerror = () => { if (this.worker === worker) this._reset(new Error('翻譯結果未能讀取，請重新準備模型。')); };
        worker.postMessage({ type: 'prepare', id: job.id, model: TRANSLATION_MODEL });
      } catch {
        this._reset(new Error('呢個瀏覽器未能啟動本機翻譯，請使用支援 Web Worker 及 WebAssembly 嘅瀏覽器。'));
      }
    });
  }

  explain({ word, sentence, signal } = {}) {
    if (signal?.aborted) return Promise.reject(aborted());
    let input;
    try { input = translationInput({ word, sentence }); } catch (error) { return Promise.reject(error); }
    if (this.destroyed || !this.status.ready) return Promise.reject(new Error('請先按「下載本機翻譯模型」；呢個操作唔會自動下載。'));
    if (this.queue.length >= 2) return Promise.reject(new Error('已有翻譯等候處理，請稍候再選擇其他字句。'));
    return new Promise((resolve, reject) => {
      const job = { id: ++this.sequence, ...input, signal, resolve, reject };
      job.abort = () => {
        this._settle(job, aborted());
        const index = this.queue.indexOf(job);
        if (index >= 0) this.queue.splice(index, 1);
        // Keep the loaded model. The running inference has a bounded deadline;
        // its result is ignored, and queued work waits for the worker to finish.
      };
      signal?.addEventListener('abort', job.abort, { once: true });
      this.queue.push(job);
      this._drain();
    });
  }

  _drain() {
    if (this.active || !this.worker || !this.status.ready) return;
    const job = this.active = this.queue.shift();
    if (!job) return;
    // Separate from the caller promise: cancellation must not remove this bound.
    job.deadline = setTimeout(() => this._reset(new Error('本機翻譯逾時，已釋放模型記憶體；請重新準備模型或選擇更短句子。')), this.inferenceTimeoutMs);
    try { this.worker.postMessage({ type: 'explain', id: job.id, word: job.word, sentence: job.sentence }); }
    catch { this._reset(new Error('未能提交本機翻譯，請重新準備模型。')); }
  }

  _message(data) {
    if (!data || !Number.isInteger(data.id)) return;
    if (data.id === this.preparing?.id) {
      const job = this.preparing;
      if (data.type === 'progress') {
        const progress = data.progress;
        this._status('loading', '正在下載及準備瀏覽器翻譯模型…', progress);
        try { job.onProgress(progress); } catch { /* Presentation only. */ }
      } else if (data.type === 'ready') {
        this.preparing = null;
        this._status('ready', '瀏覽器本機翻譯已準備好；翻譯內容唔會上傳。');
        this._settle(job, null, this.status);
      } else if (data.type === 'error') {
        this._reset(new Error(data.message || '未能準備本機翻譯模型。'));
      }
      return;
    }
    if (data.id !== this.active?.id || !['result', 'error'].includes(data.type)) return;
    const job = this.active;
    clearTimeout(job.deadline);
    this.active = null;
    if (data.type === 'result') this._settle(job, null, data.result);
    else this._settle(job, new Error(data.message || '本機翻譯未能完成。'));
    this._drain();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.active?.deadline);
    this._reset(aborted(), 'idle', '本機翻譯已關閉。');
  }
}
