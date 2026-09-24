import { ReadingTracker } from './gaze.js';
import { CameraTracker } from './camera.js';
import { GazeCursor } from './gaze-cursor.js';
import { GazeSnapper } from './gaze-snap.js';
import { PronunciationPlayer } from './pronunciation.js';
import { TokenHubSettings } from './api-settings.js';
import { buildDeck, dueSummary, reviewCard } from './flashcards.js';

const $ = (id) => document.getElementById(id);
const article = $('article');
const state = {
  document: null, selection: null, explanation: null, focusElement: null, mode: 'mouse', paused: false,
  config: { ai_available: false, offline_available: false, image_available: false, limits: { max_upload_mb: 20, max_characters: 150000 } },
  vocabulary: [], requestId: 0, documentId: 0, imageRequestId: 0, cameraId: 0, cameraReady: false,
  explainAbort: null, imageAbort: null, documentAbort: null, toastTimer: null, imageBusy: false, imageCaption: '',
  flashcards: null,
};

function readStored(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function writeStored(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { toast('瀏覽器未能儲存資料。你仍可匯出生字備份。'); return false; }
}
const savedWords = readStored('gaze-reader-vocabulary', []);
state.vocabulary = Array.isArray(savedWords) ? savedWords.filter(item => item && typeof item.word === 'string' && typeof item.meaning === 'string') : [];

function toast(message) {
  clearTimeout(state.toastTimer);
  $('toast').textContent = String(message);
  $('toast').hidden = false;
  state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000);
}
function setBusy(active) { $('busy-indicator').hidden = !active; syncGazeCursor(); }
function textElement(tag, value, className) {
  const node = document.createElement(tag);
  node.textContent = value ?? '';
  if (className) node.className = className;
  return node;
}
function setIcon(button, icon, label) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon small');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${icon}`);
  svg.append(use);
  button.replaceChildren(svg, textElement('span', label));
}
function apiErrorMessage(detail) {
  if (typeof detail === 'string') return detail;
  if (!Array.isArray(detail)) return '未能完成操作，請稍後再試。';
  const labels = { word: '所選單字', sentence: '這一句', text: '文章', title: '文章名稱' };
  const messages = detail.map(error => {
    const field = Array.isArray(error.loc) ? error.loc.at(-1) : '';
    const label = labels[field];
    if (!label) return null;
    if (error.type === 'string_too_long' || error.ctx?.max_length) {
      const limit = Number(error.ctx?.max_length);
      const maximum = Number.isFinite(limit) ? `，最多支援 ${limit.toLocaleString()} 個字元` : '';
      return `${label}太長${maximum}。${field === 'sentence' ? '請將原文分成較短句子後再匯入。' : '請縮短文字後再試。'}`;
    }
    if (error.type === 'string_too_short' || error.type === 'missing') return `${label}不能留空。`;
    return `${label}格式不正確，請檢查文字後再試。`;
  }).filter(Boolean);
  return [...new Set(messages)].join(' ') || '輸入內容格式不正確，請檢查文字後再試。';
}
async function api(path, { body, signal, method, ...options } = {}) {
  const init = { signal, method: method || (body === undefined ? 'GET' : 'POST'), ...options };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(body); }
  const response = await fetch(path, init);
  let result;
  try { result = await response.json(); } catch { throw new Error('伺服器回應格式不正確，請檢查 Python 服務。'); }
  if (!response.ok) {
    throw new Error(apiErrorMessage(result.detail));
  }
  return result;
}

let pronunciationAnchor = null;
const pronunciation = new PronunciationPlayer({ onStatus: pronunciationStatus, onAvailability: refreshPronunciation });
const gazeSnapper = new GazeSnapper({ root: article });
const gazeCursor = new GazeCursor({ element: $('gaze-cursor'), snapper: gazeSnapper });
let imageConfigRevision = 0;
const apiSettings = new TokenHubSettings({ api, onMessage: toast, onSaved: settings => {
  imageConfigRevision++;
  state.config.image_provider = 'tokenhub';
  state.config.image_available = settings.configured;
  state.config.image_model = settings.model;
  updateImageButton();
} });

function pronunciationWord(id) {
  return id === 'pronounce-word' ? state.selection?.word
    : id === 'pronounce-flashcard' ? state.flashcards?.deck[state.flashcards.index]?.word
      : pronunciationAnchor?.textContent;
}

function refreshPronunciation() {
  const availability = pronunciation.availability();
  for (const id of ['pronounce-word', 'pronounce-flashcard', 'pronounce-focus']) {
    const word = pronunciationWord(id);
    $(id).disabled = !availability.available || !word;
    const label = word ? `聽 ${word} 的英文發音` : '聽英文發音';
    $(id).setAttribute('aria-label', label);
    $(id).title = availability.available ? label : availability.message;
  }
  if (!pronunciation.active) {
    $('pronunciation-status').textContent = availability.message;
    $('flashcard-pronunciation-status').textContent = availability.message;
  }
}

function pronunciationStatus({ state: status, sourceId, message }) {
  for (const id of ['pronounce-word', 'pronounce-flashcard', 'pronounce-focus']) {
    const active = id === sourceId && (status === 'loading' || status === 'playing');
    $(id).classList.toggle('is-speaking', active);
    $(id).setAttribute('aria-pressed', String(active));
  }
  const target = sourceId === 'pronounce-flashcard' ? $('flashcard-pronunciation-status') : $('pronunciation-status');
  target.textContent = message || pronunciation.availability().message;
  if (status === 'error' && sourceId === 'pronounce-focus') toast(message);
}

function hidePronunciationAnchor() {
  pronunciationAnchor = null;
  $('pronounce-focus').hidden = true;
}

function showPronunciationAnchor(element) {
  const button = $('pronounce-focus');
  if (!element?.isConnected || document.querySelector('dialog[open]')) return;
  // Keep the button stationary while the reader moves the mouse to press it.
  if (!button.hidden && (button.matches(':hover') || document.activeElement === button)) return;
  if (pronunciationAnchor === element && !button.hidden) return;
  const rect = element.getBoundingClientRect();
  if (rect.bottom < 0 || rect.top > innerHeight) return;
  pronunciationAnchor = element;
  const lens = $('focus-lens');
  const reference = lens.hidden ? rect : lens.getBoundingClientRect();
  button.style.left = `${Math.max(6, Math.min(innerWidth - 42, reference.right + 6))}px`;
  button.style.top = `${Math.max(6, Math.min(innerHeight - 42, lens.hidden ? rect.top - 40 : reference.top))}px`;
  button.hidden = false;
  refreshPronunciation();
}

function syncGazeCursor() {
  const enabled = state.mode === 'camera' && state.cameraReady && !state.paused && $('busy-indicator').hidden;
  gazeCursor.setEnabled(enabled);
  gazeCursor.setVisible($('gaze-cursor-enabled').checked);
  $('gaze-cursor-status').textContent = !state.cameraReady ? '完成校準後顯示視線位置。'
    : state.paused ? '追蹤已暫停，視線游標已隱藏。'
      : !$('gaze-cursor-enabled').checked ? '視線游標已隱藏，文章追蹤繼續。'
        : '游標吸附字縫，視線穩定後才移動；文章以外隱藏。';
}

const tracker = new ReadingTracker({
  root: article,
  dwellMs: 1800,
  revisitCount: 3,
  onFocus: showFocus,
  onAssist: (focus) => { if (!state.paused) explain(focus, focus.reason || 'dwell'); },
  onProgress: ({ seen, total, ratio }) => {
    $('progress-label').textContent = `${Number(seen) || 0} / ${Number(total) || 0} 字已瀏覽`;
    $('reading-progress').style.width = `${Math.min(100, Math.max(0, Number(ratio) * 100 || 0))}%`;
  },
  onStatus: ({ message, state: status }) => {
    if (message && state.mode === 'camera') $('focus-status').textContent = message;
    $('tracking-dot').classList.toggle('paused', status === 'paused' || status === 'error');
  },
});

const camera = new CameraTracker({
  onPoint: (point, y) => {
    if (state.mode !== 'camera' || !state.cameraReady || state.paused || !$('busy-indicator').hidden) return;
    const sample = point && typeof point === 'object' ? point : { x: point, y, t: performance.now() };
    const position = gazeCursor.feed(sample.x, sample.y, sample.t);
    // The caret sits in whitespace; its explicit word target drives reading.
    tracker.feedElement(position?.target ?? null, sample.t);
  },
  onStatus: ({ message, state: status }) => {
    if (state.mode !== 'camera') return;
    if (message) $('mode-help').textContent = message;
    if (status === 'lost') {
      gazeCursor.hide();
      $('gaze-cursor-status').textContent = '暫時未偵測到眼睛，視線游標已隱藏。';
    } else if (status === 'camera') syncGazeCursor();
    else if (status === 'error' || status === 'off') gazeCursor.hide();
    if (status === 'error') toast(message || '未能啟動鏡頭追蹤。');
    if ((status === 'error' || status === 'off') && state.cameraReady) setMode('mouse');
  },
});

function showFocus(focus) {
  const lens = $('focus-lens');
  if (state.focusElement !== focus?.element) {
    state.focusElement?.classList.remove('is-focused');
    state.focusElement = focus?.element || null;
    state.focusElement?.classList.add('is-focused');
  }
  if (!focus || !focus.element || state.paused || document.querySelector('dialog[open]')) {
    lens.hidden = true;
    $('dwell-progress').style.width = '0%';
    $('attention-label').textContent = state.paused ? '追蹤已暫停' : '準備好，慢慢讀';
    if (!state.paused) $('focus-status').textContent = state.mode === 'mouse' ? '把滑鼠移到文章中的英文單字' : '鏡頭追蹤中 · 位置只供參考';
    return;
  }
  const rect = focus.element.getBoundingClientRect();
  if (rect.bottom < 0 || rect.top > innerHeight) { lens.hidden = true; return; }
  lens.textContent = focus.word;
  lens.hidden = false;
  const half = Math.min(lens.offsetWidth / 2 + 10, innerWidth / 2);
  lens.style.left = `${Math.max(half, Math.min(innerWidth - half, rect.left + rect.width / 2))}px`;
  const upper = rect.top - 12;
  lens.style.top = `${upper < lens.offsetHeight + 12 ? rect.bottom + lens.offsetHeight + 14 : upper}px`;
  const ratio = Math.max(0, Math.min(1, Number(focus.ratio) || 0));
  $('dwell-progress').style.width = `${ratio * 100}%`;
  $('attention-label').textContent = ratio >= 1 ? '留意到你的停留' : '跟著你的閱讀焦點';
  $('focus-status').textContent = `${focus.word} · ${(Math.max(0, Number(focus.elapsed) || 0) / 1000).toFixed(1)} 秒${state.mode === 'camera' ? ' · 鏡頭估算' : ' · 滑鼠模擬'}`;
  showPronunciationAnchor(focus.element);
}

function clearSelection() {
  pronunciation.stop();
  hidePronunciationAnchor();
  state.requestId += 1;
  state.imageRequestId += 1;
  state.explainAbort?.abort();
  state.imageAbort?.abort();
  state.selection = null;
  state.explanation = null;
  state.focusElement?.classList.remove('is-focused');
  state.focusElement = null;
  state.imageBusy = false;
  state.imageCaption = '';
  $('explanation').hidden = true;
  $('explanation-empty').hidden = false;
  $('word-image').replaceChildren();
  $('word-image').hidden = true;
  $('focus-lens').hidden = true;
  article.querySelectorAll('.word.selected').forEach(node => node.classList.remove('selected'));
}

function renderDocument(doc) {
  if (!doc || !Array.isArray(doc.paragraphs)) throw new Error('文件內容格式不正確。');
  state.documentId += 1;
  clearSelection();
  state.document = doc;
  $('document-title').textContent = doc.title || 'Untitled reading';
  document.title = `${doc.title || 'Reading'} · 目讀`;
  const sources = { demo: '示範閱讀', text: '貼上的文字', pdf: 'PDF 文件', markdown: 'Markdown 文件', md: 'Markdown 文件', docx: 'Word 文件', txt: '文字文件' };
  $('document-source').textContent = sources[doc.source] || String(doc.source || '我的文章');
  $('word-count').textContent = `${Number(doc.word_count || 0).toLocaleString()} words`;
  $('document-warning').textContent = (doc.warnings || []).join(' ');
  $('document-warning').hidden = !doc.warnings?.length;
  const fragment = document.createDocumentFragment();
  let firstWord = true;
  for (const paragraph of doc.paragraphs) {
    const p = document.createElement('p');
    p.dataset.paragraphId = paragraph.id;
    for (const sentence of paragraph.sentences || []) {
      const span = document.createElement('span');
      span.className = 'sentence';
      span.dataset.sentenceId = sentence.id;
      for (const token of sentence.tokens || []) {
        if (token.word) {
          const word = textElement('span', token.text, 'word');
          word.dataset.wordId = token.id;
          word.dataset.sentenceId = sentence.id;
          word.tabIndex = firstWord ? 0 : -1;
          firstWord = false;
          span.append(word);
        } else span.append(document.createTextNode(token.text || ''));
      }
      if (!sentence.tokens?.length) span.textContent = sentence.text || '';
      p.append(span);
      p.append(document.createTextNode(' '));
    }
    fragment.append(p);
  }
  article.replaceChildren(fragment);
  gazeSnapper.invalidate();
  tracker.reset();
  $('progress-label').textContent = `0 / ${Number(doc.word_count) || 0} 字已瀏覽`;
  $('reading-progress').style.width = '0%';
  updateImageButton();
}

async function loadDocument(path, body) {
  state.documentAbort?.abort();
  const abort = new AbortController();
  state.documentAbort = abort;
  setBusy(true);
  tracker.setPaused(true);
  try {
    const doc = await api(path, { body, signal: abort.signal });
    if (abort.signal.aborted) return;
    renderDocument(doc);
    $('paste-dialog').close();
    if (innerWidth < 640) $('document-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    if (error.name !== 'AbortError') toast(error.message);
    if (!state.document) article.replaceChildren(textElement('p', '未能載入示範文章。請確認 Python 服務已啟動，再匯入文件或重試示範文章。', 'loading-copy'));
  } finally {
    if (state.documentAbort === abort) {
      setBusy(false);
      tracker.setPaused(state.paused || !!document.querySelector('dialog[open]'));
    }
  }
}

function contextFromElement(element) {
  const sentence = element.closest('.sentence');
  return { element, word: element.textContent, sentence: sentence?.textContent || element.textContent, wordId: element.dataset.wordId, sentenceId: element.dataset.sentenceId };
}

const sourceLabels = { demo: '示範解釋', dictionary: '本機字典', offline: '本機翻譯', ai: '雲端 AI', unavailable: '暫無解釋' };
async function explain(focus, reason = 'click', force = false) {
  if (!focus?.word || !state.document || document.querySelector('dialog[open]')) return;
  if (!force && state.selection?.wordId === focus.wordId && state.explanation) return;
  const sequence = ++state.requestId;
  const documentId = state.documentId;
  state.explainAbort?.abort();
  state.imageAbort?.abort();
  state.imageRequestId += 1;
  state.imageBusy = false;
  state.imageCaption = '';
  const abort = new AbortController();
  state.explainAbort = abort;
  state.selection = focus;
  state.explanation = null;
  article.querySelectorAll('.word.selected').forEach(node => node.classList.remove('selected'));
  focus.element?.classList.add('selected');
  $('explanation-empty').hidden = true;
  $('explanation').hidden = false;
  $('selected-word').textContent = focus.word;
  pronunciation.stop();
  refreshPronunciation();
  showPronunciationAnchor(focus.element);
  $('selected-sentence').textContent = focus.sentence;
  $('word-meaning').textContent = '正在理解…';
  $('sentence-translation').textContent = '';
  $('explanation-source').textContent = $('ai-enabled').checked ? '雲端 AI 處理中' : (state.config.offline_available ? '本機處理中' : '查閱本機字典');
  $('explanation-reason').textContent = reason === 'reread' ? `重讀 ${focus.visits || $('revisit-count').value} 次` : reason === 'dwell' ? '停留觸發' : '手動查閱';
  $('explanation-message').hidden = true;
  $('example-section').hidden = true;
  $('visual-section').hidden = true;
  $('word-image').hidden = true;
  $('word-image').replaceChildren();
  $('save-word').disabled = true;
  updateImageButton();
  try {
    const result = await api('/api/explain', { body: { word: focus.word, sentence: focus.sentence, reason, use_ai: $('ai-enabled').checked }, signal: abort.signal });
    if (sequence !== state.requestId || documentId !== state.documentId || abort.signal.aborted) return;
    state.explanation = result;
    $('word-meaning').textContent = result.meaning || '這個字暫時未有解釋';
    $('sentence-translation').textContent = result.translation || '暫時沒有這句的翻譯。';
    $('explanation-source').textContent = sourceLabels[result.source] || result.source || '字詞解釋';
    $('explanation-message').textContent = result.message || '';
    $('explanation-message').hidden = !result.message;
    $('word-example').textContent = result.example || '';
    $('example-section').hidden = !result.example;
    $('visual-hint').textContent = result.visual_hint || '';
    $('visual-section').hidden = !result.visual_hint;
    $('save-word').disabled = false;
    updateSaveButton();
    updateImageButton();
  } catch (error) {
    if (error.name === 'AbortError' || sequence !== state.requestId || documentId !== state.documentId) return;
    $('word-meaning').textContent = '暫時未能取得解釋';
    $('explanation-source').textContent = '未完成';
    $('explanation-message').textContent = error.message;
    $('explanation-message').hidden = false;
    $('sentence-translation').textContent = '可以再按一次單字重試。';
    updateImageButton();
  }
}

function imageIsLocal() { return state.config.image_provider === 'local'; }
function imageIsTencent() { return state.config.image_provider === 'tencent'; }
function imageIsTokenHub() { return state.config.image_provider === 'tokenhub'; }
function imageIsReady() {
  if (imageIsLocal() || imageIsTencent() || imageIsTokenHub()) return !!state.config.image_available;
  return !!state.config.ai_available && state.config.image_available !== false && $('ai-enabled').checked;
}
function updateImageButton() {
  $('generate-image').disabled = !state.selection || !imageIsReady() || state.imageBusy;
  $('generate-image').replaceChildren(textElement('span', state.imageBusy ? '正在畫圖，請稍候…' : imageIsTokenHub() ? '用 TokenHub 混元畫張圖' : imageIsTencent() ? '用騰訊混元畫張圖' : '為這個字畫張圖'));
  let note = imageIsTokenHub() ? '尚未設定 TokenHub API Key；設定後即可按需生圖，閱讀及本機翻譯仍可照常使用。' : '尚未設定生圖服務，可配置騰訊 TokenHub 或本機模型。';
  if (state.config.image_available) {
    if (imageIsLocal()) note = '使用本機圖像模型生成；只會在你按下按鈕後開始。';
    else if (imageIsTokenHub()) note = '按下按鈕會將所選單字及句子傳送至騰訊 TokenHub，使用混元生圖，可能產生 API 費用。';
    else if (imageIsTencent()) note = '按下按鈕會將所選單字及句子傳送至騰訊混元，可能產生 API 費用。';
    else note = '啟用雲端 AI 後，按下按鈕會傳送所選單字及句子，生成圖片可能產生費用。';
  }
  $('image-note').textContent = state.imageCaption || note;
}
async function generateImage() {
  if (!state.selection || state.imageBusy || !imageIsReady()) return;
  const focus = state.selection;
  const sequence = ++state.imageRequestId;
  const documentId = state.documentId;
  const selectionId = state.requestId;
  state.imageAbort?.abort();
  const abort = new AbortController();
  state.imageAbort = abort;
  state.imageBusy = true;
  state.imageCaption = '';
  updateImageButton();
  try {
    const result = await api('/api/image', { body: { word: focus.word, sentence: focus.sentence, use_ai: !imageIsLocal() }, signal: abort.signal });
    if (sequence !== state.imageRequestId || documentId !== state.documentId || selectionId !== state.requestId || abort.signal.aborted) return;
    // Only image URLs are accepted; never place model output in HTML.
    const url = String(result.image_url || '');
    if (!/^(data:image\/(png|jpeg|webp);base64,|https?:\/\/|\/)/i.test(url)) throw new Error('圖像格式不受支援。');
    const img = new Image();
    img.alt = result.prompt || `${focus.word} 的意思示意圖`;
    img.src = url;
    img.referrerPolicy = 'no-referrer';
    img.onerror = () => { if (selectionId === state.requestId) toast('圖片未能顯示，請再試一次。'); };
    $('word-image').replaceChildren(img);
    $('word-image').hidden = false;
    const provider = result.source === 'tokenhub' || imageIsTokenHub() ? 'TokenHub 混元' : result.source === 'tencent' || imageIsTencent() ? '騰訊混元' : imageIsLocal() ? '本機模型' : '雲端 AI';
    const expiresIn = Number(result.expires_in_seconds);
    const duration = expiresIn >= 3600 ? `${Number((expiresIn / 3600).toFixed(1))} 小時` : `${Math.max(1, Math.ceil(expiresIn / 60))} 分鐘`;
    const expiry = Number.isFinite(expiresIn) && expiresIn > 0 ? ` 圖片連結約 ${duration}後到期。` : '';
    state.imageCaption = `${provider}生成的聯想插圖，意思仍以文字及上下文為準。${expiry}`;
  } catch (error) {
    if (error.name !== 'AbortError' && sequence === state.imageRequestId && documentId === state.documentId) {
      state.imageCaption = error.message;
      toast(error.message);
    }
  } finally {
    if (sequence === state.imageRequestId) { state.imageBusy = false; updateImageButton(); }
  }
}

function updateSaveButton() {
  const word = state.selection?.word.toLowerCase();
  const exists = state.vocabulary.some(item => item.word.toLowerCase() === word);
  setIcon($('save-word'), exists ? 'check' : 'save', exists ? '已加入生字與溫習卡' : '加入生字與溫習卡');
  $('save-word').classList.toggle('saved', exists);
}
function updateVocabulary() { $('vocab-count').textContent = state.vocabulary.length; renderVocabulary(); updateSaveButton(); }
function saveWord() {
  if (!state.selection || !state.explanation) return;
  const { word, sentence } = state.selection;
  if (state.vocabulary.some(item => item.word.toLowerCase() === word.toLowerCase())) { toast('這個字已經在你的生字簿裡。'); return; }
  const updated = [{ word, meaning: state.explanation.meaning || '', sentence, translation: state.explanation.translation || '', example: state.explanation.example || '', visual_hint: state.explanation.visual_hint || '', source: state.explanation.source, document: state.document.title, saved_at: new Date().toISOString() }, ...state.vocabulary];
  if (!writeStored('gaze-reader-vocabulary', updated)) return;
  state.vocabulary = updated;
  updateVocabulary();
  toast(`「${word}」已加入生字與溫習卡`);
}
function renderVocabulary() {
  const list = $('vocabulary-list');
  list.replaceChildren();
  if (!state.vocabulary.length) list.append(textElement('p', '還未有收藏。閱讀時，將想記住的字收進來。', 'vocabulary-empty'));
  for (const [index, item] of state.vocabulary.entries()) {
    const row = textElement('div', '', 'vocab-item');
    const word = textElement('h3', item.word); word.lang = 'en';
    const meaning = textElement('p', item.meaning || '未有解釋');
    const sentence = textElement('small', item.sentence || ''); sentence.lang = 'en';
    const remove = textElement('button', '移除', 'button quiet');
    remove.setAttribute('aria-label', `移除 ${item.word}`);
    remove.addEventListener('click', () => { state.vocabulary.splice(index, 1); writeStored('gaze-reader-vocabulary', state.vocabulary); updateVocabulary(); });
    row.append(word, meaning, sentence, remove);
    list.append(row);
  }
  ['export-csv', 'export-json', 'clear-vocabulary'].forEach(id => { $(id).disabled = !state.vocabulary.length; });
  updateReviewSummary();
}

function nextReviewText(value) {
  if (!value) return '';
  return new Date(value).toLocaleString('zh-HK', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function updateReviewSummary() {
  const { total, due, nextDueAt } = dueSummary(state.vocabulary);
  $('review-count').textContent = due;
  $('flashcards-open').setAttribute('aria-label', `溫習卡，${due} 張待溫習`);
  $('review-summary').textContent = !total ? '收藏一個想記住的字，就有第一張溫習卡。' : due ? `${total} 張卡片 · ${due} 張待溫習` : `${total} 張卡片 · 暫時全部完成${nextDueAt ? `，下次 ${nextReviewText(nextDueAt)}` : ''}`;
  $('review-due').disabled = !due;
  $('review-all').disabled = !total;
  $('learning-summary').textContent = !total ? '把不熟悉的單字收藏，變成你的溫習卡。'
    : `${total} 個收藏生字 · ${due} 張待溫習`;
  $('learning-review-open').setAttribute('aria-label', `溫習 Flash Card，${due} 張待溫習`);
}

function startFlashcards(mode = 'due') {
  state.flashcards = { deck: buildDeck(state.vocabulary, mode), index: 0, again: 0, remembered: 0, mode, revealed: false };
  $('vocabulary-dialog').close();
  if (!$('flashcard-dialog').open) openDialog('flashcard-dialog');
  renderFlashcard();
}

function renderFlashcard() {
  const session = state.flashcards;
  if (!session) return;
  pronunciation.stop();
  session.revealed = false;
  $('flashcard-feedback').textContent = '';
  const item = session.deck[session.index];
  $('flashcard-session').hidden = !item;
  $('flashcard-empty').hidden = !!item;
  if (!item) {
    const { total, nextDueAt } = dueSummary(state.vocabulary);
    const finished = session.index > 0;
    $('flashcard-empty-title').textContent = finished ? '這一輪，記住多一點。' : total ? '暫時沒有到期的卡片' : '從一個生字開始';
    $('flashcard-empty-message').textContent = finished
      ? `已溫習 ${session.index} 張 · 記得 ${session.remembered} 張 · 未記熟 ${session.again} 張。${nextDueAt ? `下次溫習：${nextReviewText(nextDueAt)}。` : ''}`
      : total ? `你可以提早練習全部卡片。${nextDueAt ? `下次溫習：${nextReviewText(nextDueAt)}。` : ''}`
        : '在文章中點選不熟悉的字，按「加入生字與溫習卡」，就可以在這裡翻卡溫習。';
    $('flashcard-practice').hidden = !total;
    $('flashcard-practice').textContent = finished ? '全部再練一次' : '練習全部卡片';
    $('flashcard-return').focus();
    updateReviewSummary();
    return;
  }
  $('flashcard-progress').textContent = `${session.mode === 'all' ? '全部練習' : '到期溫習'} · ${session.index + 1} / ${session.deck.length}`;
  $('flashcard-side').textContent = '先想一想，這個字是甚麼意思？';
  $('flashcard-word').textContent = item.word;
  refreshPronunciation();
  $('flashcard-sentence').textContent = item.sentence || '試試自己用這個字造一句句子。';
  $('flashcard-document').textContent = item.document ? `讀過的文章 · ${item.document}` : '';
  $('flashcard-document').hidden = !item.document;
  // Keep the answer out of the visible and accessible card until it is revealed.
  $('flashcard-answer').hidden = true;
  $('flashcard-meaning').textContent = item.meaning || '這張卡未有詞義，請返回文章查閱。';
  $('flashcard-translation').textContent = item.translation || '';
  $('flashcard-translation').hidden = !item.translation;
  $('flashcard-example').textContent = item.example || '';
  $('flashcard-example-section').hidden = !item.example;
  $('flashcard-hint').textContent = item.visual_hint || '';
  $('flashcard-hint-section').hidden = !item.visual_hint;
  const now = Date.now();
  const next = reviewCard(item.review, 'remembered', now);
  const days = Math.round((Date.parse(next.due_at) - now) / 86400000);
  $('flashcard-next-interval').textContent = `${days} 日後`;
  $('flashcard-reveal').hidden = false;
  $('flashcard-ratings').hidden = true;
  $('flashcard-card').classList.remove('is-revealed');
  $('flashcard-card').scrollTop = 0;
  $('flashcard-reveal').focus();
}

function revealFlashcard() {
  const session = state.flashcards;
  if (!session?.deck[session.index] || session.revealed) return;
  session.revealed = true;
  $('flashcard-answer').hidden = false;
  $('flashcard-side').textContent = '放回意思裡，再記一次。';
  $('flashcard-reveal').hidden = true;
  $('flashcard-ratings').hidden = false;
  $('flashcard-card').classList.add('is-revealed');
  $('flashcard-card').scrollTop = 0;
  $('flashcard-again').focus({ preventScroll: true });
}

function rateFlashcard(rating) {
  const session = state.flashcards;
  if (!session?.revealed) return;
  const card = session.deck[session.index];
  const index = state.vocabulary.findIndex(item => item.word.trim().toLowerCase() === card.word.trim().toLowerCase());
  if (index < 0) return;
  const updated = [...state.vocabulary];
  updated[index] = { ...updated[index], review: reviewCard(updated[index].review, rating) };
  // Commit only after storage succeeds, so a failed save never masquerades as progress.
  if (!writeStored('gaze-reader-vocabulary', updated)) {
    $('flashcard-feedback').textContent = '未能儲存溫習進度。請確認瀏覽器允許本機儲存，再按一次評分。';
    return;
  }
  state.vocabulary = updated;
  session[rating] += 1;
  session.index += 1;
  updateVocabulary();
  renderFlashcard();
}
function exportVocabulary(format) {
  if (!state.vocabulary.length) return;
  let content;
  if (format === 'json') content = JSON.stringify(state.vocabulary, null, 2);
  else {
    // Neutralize formulas when the exported CSV is opened in a spreadsheet.
    const cell = (value) => { let text = String(value ?? ''); if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; };
    const keys = ['word', 'meaning', 'sentence', 'translation', 'source', 'document', 'saved_at'];
    content = '\uFEFF' + [keys.join(','), ...state.vocabulary.map(item => keys.map(key => cell(item[key])).join(','))].join('\r\n');
  }
  const url = URL.createObjectURL(new Blob([content], { type: format === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `目讀生字-${new Date().toISOString().slice(0, 10)}.${format}`;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function setMode(mode) {
  const sequence = ++state.cameraId;
  state.cameraReady = false;
  gazeCursor.setEnabled(false);
  camera.stop();
  state.mode = mode;
  tracker.setMode(mode);
  $('mode-mouse').classList.toggle('selected', mode === 'mouse');
  $('mode-camera').classList.toggle('selected', mode === 'camera');
  $('mode-mouse').setAttribute('aria-pressed', String(mode === 'mouse'));
  $('mode-camera').setAttribute('aria-pressed', String(mode === 'camera'));
  $('calibrate').hidden = mode !== 'camera';
  $('camera-note').hidden = mode !== 'camera';
  $('gaze-cursor-settings').hidden = mode !== 'camera';
  $('focus-lens').hidden = true;
  syncGazeCursor();
  if (mode === 'mouse') {
    $('mode-help').textContent = '移動滑鼠，試試用目光閱讀的感覺。停留一會，就會出現解釋。';
    $('calibrate').disabled = false;
    tracker.setPaused(state.paused || !$('busy-indicator').hidden || !!document.querySelector('dialog[open]'));
    return;
  }
  $('mode-help').textContent = '正在準備鏡頭，請依照畫面完成校準。';
  $('calibrate').disabled = true;
  tracker.setPaused(true);
  try {
    const calibration = await camera.start();
    if (sequence !== state.cameraId) return;
    state.cameraReady = true;
    syncGazeCursor();
    const errorPx = Number(calibration?.errorPx);
    $('mode-help').textContent = Number.isFinite(errorPx) ? `已校準 · 估算誤差約 ${Math.round(errorPx)} px。注視位置只供參考，可點擊單字修正。` : '鏡頭追蹤已啟動。注視位置只供參考，可點擊單字修正。';
    toast('鏡頭已啟動。游標會吸附文章字縫，可在左邊開關顯示。');
  } catch (error) {
    if (sequence !== state.cameraId) return;
    toast(error.message || '鏡頭啟動失敗，已切換到滑鼠模式。');
    await setMode('mouse');
  } finally {
    if (sequence === state.cameraId) { $('calibrate').disabled = false; tracker.setPaused(state.paused || !!document.querySelector('dialog[open]')); }
  }
}

function togglePause() {
  hidePronunciationAnchor();
  state.paused = !state.paused;
  tracker.setPaused(state.paused || !$('busy-indicator').hidden || !!document.querySelector('dialog[open]'));
  syncGazeCursor();
  document.body.classList.toggle('is-paused', state.paused);
  $('tracking-dot').classList.toggle('paused', state.paused);
  $('pause-toggle').setAttribute('aria-pressed', String(state.paused));
  setIcon($('pause-toggle'), state.paused ? 'play' : 'pause', state.paused ? '繼續追蹤' : '暫停追蹤');
  showFocus(null);
  if (state.paused) $('focus-status').textContent = '仍可點擊單字，手動查閱解釋';
}
function openDialog(id) { pronunciation.stop(); hidePronunciationAnchor(); gazeCursor.hide(); $(id).showModal(); tracker.setPaused(true); $('focus-lens').hidden = true; }
document.querySelectorAll('dialog').forEach(dialog => {
  dialog.querySelector('.dialog-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    pronunciation.stop();
    gazeCursor.hide();
    tracker.setPaused(state.paused || !$('busy-indicator').hidden || !!document.querySelector('dialog[open]'));
    if (dialog.id === 'flashcard-dialog') state.flashcards = null;
  });
  dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } });
});

function applySettings() {
  const font = Number($('font-size').value);
  const spacing = Number($('line-height').value);
  const dwell = Number($('dwell-time').value);
  const revisits = Number($('revisit-count').value);
  document.documentElement.style.setProperty('--article-size', `${font}px`);
  document.documentElement.style.setProperty('--article-leading', spacing);
  $('font-output').textContent = `${font} px`;
  $('spacing-output').textContent = spacing.toFixed(1);
  $('dwell-output').textContent = `${dwell.toFixed(1)} 秒`;
  document.querySelectorAll('input[type=range]').forEach(input => input.style.setProperty('--range-progress', `${(Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min)) * 100}%`));
  tracker.configure({ dwellMs: dwell * 1000, revisitCount: revisits });
  gazeSnapper.invalidate();
  hidePronunciationAnchor();
  syncGazeCursor();
  writeStored('gaze-reader-settings', { font, spacing, dwell, revisits, gazeCursor: $('gaze-cursor-enabled').checked });
}
const settings = readStored('gaze-reader-settings', {});
if (typeof settings.gazeCursor === 'boolean') $('gaze-cursor-enabled').checked = settings.gazeCursor;
$('gaze-cursor-enabled').addEventListener('change', applySettings);
for (const [id, key] of [['font-size', 'font'], ['line-height', 'spacing'], ['dwell-time', 'dwell'], ['revisit-count', 'revisits']]) {
  if (Number.isFinite(Number(settings[key]))) $(id).value = settings[key];
  $(id).addEventListener('input', applySettings);
}

async function uploadFile(file) {
  if (!file) return;
  if (!/\.(pdf|md|markdown|txt|docx)$/i.test(file.name)) { toast('請選擇 PDF、Markdown、TXT 或 DOCX 文件。'); return; }
  const max = state.config.limits?.max_upload_mb || 20;
  if (file.size > max * 1024 * 1024) { toast(`文件太大，請選擇 ${max} MB 以下的文件。`); return; }
  const body = new FormData(); body.append('file', file);
  await loadDocument('/api/documents/upload', body);
  $('file-input').value = '';
}
$('file-input').addEventListener('change', event => uploadFile(event.target.files[0]));
$('drop-zone').addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('file-input').click(); } });
for (const name of ['dragenter', 'dragover']) $('drop-zone').addEventListener(name, event => { event.preventDefault(); $('drop-zone').classList.add('drag-over'); });
for (const name of ['dragleave', 'drop']) $('drop-zone').addEventListener(name, event => { event.preventDefault(); $('drop-zone').classList.remove('drag-over'); });
$('drop-zone').addEventListener('drop', event => uploadFile(event.dataTransfer.files[0]));
window.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
window.addEventListener('drop', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
$('paste-open').addEventListener('click', () => openDialog('paste-dialog'));
$('paste-form').addEventListener('submit', event => { event.preventDefault(); const text = $('paste-text').value.trim(); if (!text) return; loadDocument('/api/documents/text', { text, title: $('paste-title').value.trim() || undefined }); });
$('demo-load').addEventListener('click', () => loadDocument('/api/demo'));
$('pause-toggle').addEventListener('click', togglePause);
$('mode-mouse').addEventListener('click', () => setMode('mouse'));
$('mode-camera').addEventListener('click', () => setMode('camera'));
$('calibrate').addEventListener('click', () => setMode('camera'));
$('generate-image').addEventListener('click', generateImage);
for (const id of ['pronounce-word', 'pronounce-flashcard', 'pronounce-focus']) {
  $(id).addEventListener('click', () => pronunciation.play(pronunciationWord(id), id));
}
$('save-word').addEventListener('click', saveWord);
$('vocabulary-open').addEventListener('click', () => { renderVocabulary(); openDialog('vocabulary-dialog'); });
$('learning-notebook-open').addEventListener('click', () => { renderVocabulary(); openDialog('vocabulary-dialog'); });
$('learning-review-open').addEventListener('click', () => startFlashcards());
$('api-settings-open').addEventListener('click', () => { openDialog('api-settings-dialog'); apiSettings.load(); });
$('flashcards-open').addEventListener('click', () => startFlashcards());
$('review-due').addEventListener('click', () => startFlashcards());
$('review-all').addEventListener('click', () => startFlashcards('all'));
$('flashcard-practice').addEventListener('click', () => startFlashcards('all'));
$('flashcard-return').addEventListener('click', () => $('flashcard-dialog').close());
$('flashcard-reveal').addEventListener('click', revealFlashcard);
$('flashcard-again').addEventListener('click', () => rateFlashcard('again'));
$('flashcard-remembered').addEventListener('click', () => rateFlashcard('remembered'));
$('flashcard-dialog').addEventListener('keydown', event => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
  if (event.target.closest('.dialog-close, .pronunciation-button, input, textarea, select, [contenteditable="true"]')) return;
  if (event.key === ' ' && !state.flashcards?.revealed && state.flashcards?.deck[state.flashcards.index]) {
    event.preventDefault(); revealFlashcard();
  } else if ((event.key === '1' || event.key === '2') && state.flashcards?.revealed) {
    event.preventDefault(); rateFlashcard(event.key === '1' ? 'again' : 'remembered');
  }
});
$('export-csv').addEventListener('click', () => exportVocabulary('csv'));
$('export-json').addEventListener('click', () => exportVocabulary('json'));
$('clear-vocabulary').addEventListener('click', () => {
  const previous = [...state.vocabulary];
  state.vocabulary = []; writeStored('gaze-reader-vocabulary', []); updateVocabulary();
  $('toast').replaceChildren(textElement('span', '已清空生字收藏。 '));
  const undo = textElement('button', '復原', 'button quiet');
  undo.addEventListener('click', () => { state.vocabulary = previous; writeStored('gaze-reader-vocabulary', previous); updateVocabulary(); $('toast').hidden = true; });
  $('toast').append(undo); $('toast').hidden = false;
  clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, 12000);
});
$('ai-enabled').addEventListener('change', () => {
  state.requestId += 1; state.imageRequestId += 1; state.explainAbort?.abort(); state.imageAbort?.abort(); state.imageBusy = false;
  updateAIStatus(); updateImageButton();
  toast($('ai-enabled').checked ? '已啟用雲端 AI：查閱的字詞及句子會傳送至 API，可能產生費用。' : '已關閉雲端 AI，使用本機功能。');
  if (state.selection) explain(state.selection, 'click', true);
});
article.addEventListener('click', event => { const word = event.target.closest('.word'); if (word) explain(contextFromElement(word)); });
article.addEventListener('keydown', event => {
  const word = event.target.closest('.word'); if (!word) return;
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); explain(contextFromElement(word)); }
  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
    event.preventDefault(); const words = [...article.querySelectorAll('.word')];
    const next = words[Math.max(0, Math.min(words.length - 1, words.indexOf(word) + (event.key === 'ArrowRight' ? 1 : -1)))];
    if (next) { word.tabIndex = -1; next.tabIndex = 0; next.focus(); showFocus({ ...contextFromElement(next), elapsed: 0, ratio: 0 }); }
  }
});
window.addEventListener('scroll', () => { $('focus-lens').hidden = true; hidePronunciationAnchor(); }, { passive: true, capture: true });
window.addEventListener('resize', () => { $('focus-lens').hidden = true; hidePronunciationAnchor(); });
window.addEventListener('blur', hidePronunciationAnchor);
const reviewRefresh = setInterval(updateReviewSummary, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) updateReviewSummary(); else { pronunciation.stop(); hidePronunciationAnchor(); } });
window.addEventListener('pagehide', () => { clearInterval(reviewRefresh); apiSettings.destroy(); pronunciation.destroy(); camera.stop(); gazeCursor.destroy(); gazeSnapper.destroy(); tracker.destroy(); state.explainAbort?.abort(); state.imageAbort?.abort(); });

function updateAIStatus() {
  const online = $('ai-enabled').checked;
  $('ai-help').textContent = online ? '已啟用：查閱的字詞及句子會送往雲端，可能產生 API 費用。' : state.config.ai_available ? `按需啟用雲端解釋。${state.config.offline_available ? '目前使用本機翻譯。' : '目前使用本機字典。'}開啟後會傳送查閱的字詞及句子。` : state.config.offline_available ? '本機翻譯已就緒。雲端 AI 尚未設定；你可以離線閱讀及翻譯。' : '目前使用示範解釋及本機字典。設定本機翻譯模型，可離線翻譯其他句子。';
  document.querySelector('.ai-setting-title strong').textContent = '雲端 AI（選用）';
}

async function start() {
  updateVocabulary(); applySettings();
  apiSettings.refreshSummary();
  try {
    const revision = imageConfigRevision;
    const config = await api('/api/config');
    if (revision !== imageConfigRevision) {
      for (const field of ['image_provider', 'image_available', 'image_model']) config[field] = state.config[field];
    }
    state.config = { ...state.config, ...config };
    pronunciation.setLocalAudioAvailable(state.config.speech_available);
    $('ai-enabled').disabled = !state.config.ai_available;
    $('paste-text').maxLength = state.config.limits?.max_characters || 150000;
    updateAIStatus(); updateImageButton();
  } catch {
    $('ai-help').textContent = '未能連接本機服務。請檢查 Python 服務是否已啟動。';
  }
  await loadDocument('/api/demo');
}
start();
