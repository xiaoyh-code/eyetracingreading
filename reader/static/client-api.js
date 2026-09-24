/** Shared local/static runtime adapter. Documents and credentials stay in browser. */
import { sessionCredentials } from './session-credentials.js';
import { ProviderClient, boundedJSON, validateWordContext } from './provider-client.js';
import { BrowserTranslation } from './browser-translation.js';

export const translation = new BrowserTranslation();
const abortError = () => new DOMException('操作已取消。', 'AbortError');
const checkAbort = signal => { if (signal?.aborted) throw abortError(); };

export function createClientAPI({
  runtime = globalThis.document?.querySelector('meta[name="reader-runtime"]')?.content || 'browser',
  fetchImpl = (...args) => globalThis.fetch(...args),
  credentials = sessionCredentials,
  provider = new ProviderClient({ credentials, fetchImpl }),
  translator = translation,
  documents = null,
  demoData = null,
} = {}) {
  let demoPromise = null;
  const documentTools = () => documents ? Promise.resolve(documents) : import('./browser-documents.js');

  async function localJSON(path, { body, signal } = {}) {
    checkAbort(signal);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, 30000);
    try {
      const response = await fetchImpl(path, {
        method: body === undefined ? 'GET' : 'POST', signal: controller.signal,
        credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error('本機服務暫時未能回應。');
      const value = await boundedJSON(response, 2 * 1024 * 1024);
      checkAbort(signal);
      return value;
    } catch {
      checkAbort(signal);
      throw new Error('本機服務暫時未能回應，可繼續使用瀏覽器字典。');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  }

  async function demo(signal) {
    checkAbort(signal);
    if (demoData) return demoData;
    if (!demoPromise) {
      demoPromise = (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          const response = await fetchImpl(new URL('./browser-data.json', import.meta.url).href, { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal });
          if (!response.ok) throw new Error('未能載入示範字典，請重新整理頁面。');
          return await boundedJSON(response, 2 * 1024 * 1024);
        } finally { clearTimeout(timer); controller.abort(); }
      })().catch(() => { demoPromise = null; throw new Error('未能載入示範字典，請重新整理頁面。'); });
    }
    const value = await demoPromise;
    checkAbort(signal);
    return value;
  }

  function browserConfig() {
    const settings = credentials.snapshot();
    return {
      runtime, ai_available: false, text_model: null,
      image_available: settings.configured, image_provider: 'tokenhub', image_model: settings.model,
      offline_available: !!translator.status?.ready, browser_translation_available: !!translator.status?.ready,
      speech_available: false, limits: { max_upload_mb: 20, max_characters: 150000 },
    };
  }

  async function dictionary(word, sentence, signal) {
    const data = await demo(signal);
    const normalized = word.toLowerCase().replace(/^[\s.,!?;:"'“”‘’()\[\]]+|[\s.,!?;:"'“”‘’()\[\]]+$/g, '');
    const entry = data.GLOSSARY && Object.hasOwn(data.GLOSSARY, normalized) ? data.GLOSSARY[normalized] : null;
    const translated = data.TRANSLATIONS && Object.hasOwn(data.TRANSLATIONS, sentence.trim()) ? data.TRANSLATIONS[sentence.trim()] : '';
    return {
      word,
      meaning: Array.isArray(entry) ? entry[0] || '' : entry?.meaning || '',
      example: Array.isArray(entry) ? entry[1] || '' : entry?.example || '',
      visual_hint: Array.isArray(entry) ? entry[2] || '' : entry?.visual_hint || '',
      translation: translated,
      source: translated ? 'demo' : entry ? 'dictionary' : 'unavailable',
      message: translated ? '示範文章的人工翻譯；詞義來自內置小詞庫。'
        : entry ? '內置小詞庫提供一般詞義。可下載本機翻譯模型，翻譯這句原文。'
          : '本機小詞庫暫未收錄這個字。可先下載本機翻譯模型，再查閱其他字句。',
    };
  }

  async function api(path, { body, signal, method = body === undefined ? 'GET' : 'POST' } = {}) {
    checkAbort(signal);
    if (path === '/api/settings/tokenhub') {
      if (method === 'GET') return credentials.snapshot();
      if (method === 'POST') return credentials.update(body);
      if (method === 'DELETE') return credentials.clear();
      throw new Error('不支援這個設定操作。');
    }
    if (path === '/api/config' && method === 'GET') {
      const config = browserConfig();
      if (runtime === 'local') {
        try {
          const local = await localJSON('/api/config', { signal });
          config.offline_available ||= local.offline_available === true;
          config.speech_available = local.speech_available === true;
        } catch { checkAbort(signal); }
      }
      return config;
    }
    if (path === '/api/demo' && method === 'GET') {
      const data = await demo(signal);
      const { makeDocument } = await documentTools();
      checkAbort(signal);
      return makeDocument(data.TEXT, data.TITLE, 'demo', { signal });
    }
    if (path === '/api/documents/text' && method === 'POST') {
      const { makeDocument } = await documentTools();
      checkAbort(signal);
      return makeDocument(body?.text, body?.title || 'Untitled reading', 'text', { signal });
    }
    if (path === '/api/documents/upload' && method === 'POST') {
      const file = body?.get?.('file');
      if (!file) throw new Error('請選擇要匯入的文件。');
      const { extractUpload } = await documentTools();
      checkAbort(signal);
      return extractUpload(file, { signal });
    }
    if (path === '/api/explain' && method === 'POST') {
      if (body?.use_ai) throw new Error('翻譯使用本機功能，不會使用或傳送生圖 API Key。');
      const { word, sentence } = validateWordContext(body);
      if (runtime === 'local' && !translator.status?.ready) {
        try { return await localJSON('/api/explain', { body: { word, sentence, use_ai: false }, signal }); }
        catch { checkAbort(signal); }
      }
      const result = await dictionary(word, sentence, signal);
      if (translator.status?.ready && (!result.meaning || result.source !== 'demo')) {
        try {
          const local = await translator.explain({ word, sentence, signal });
          checkAbort(signal);
          if (local) {
            for (const key of ['meaning', 'translation', 'example', 'visual_hint']) {
              if (local[key] && (!result[key] || key === 'translation' && result.source !== 'demo')) result[key] = local[key];
            }
            result.source = result.source === 'demo' ? 'demo' : 'offline';
            result.message = result.source === 'demo' ? '句子採用示範人工翻譯；詞義由本機模型補充。' : '翻譯在瀏覽器內完成，字句不會上傳；機器翻譯可能有誤，請對照原文。';
          }
        } catch { checkAbort(signal); result.message += ' 本機模型暫時未能完成翻譯。'; }
      }
      return result;
    }
    if (path === '/api/image' && method === 'POST') return provider.image(body, { signal });
    throw new Error('不支援這個操作。');
  }
  api.destroy = () => provider.destroy();
  return api;
}

export const api = createClientAPI();
