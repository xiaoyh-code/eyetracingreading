import { normalizeReview } from './flashcards.js';

/** Import only known learning fields: never retain arbitrary backup properties. */
export function mergeVocabulary(existing, incoming) {
  if (!Array.isArray(incoming) || incoming.length > 10000) throw new Error('請選擇目讀匯出的 JSON 學習簿（上限 10,000 個生字）。');
  const vocabulary = [...existing];
  const seen = new Set(existing.map(item => item.word.trim().toLowerCase()));
  let added = 0;
  const fields = { meaning: 4000, sentence: 4000, translation: 4000, example: 4000, visual_hint: 4000, source: 40, document: 200 };
  for (const item of incoming) {
    if (!item || typeof item !== 'object' || typeof item.word !== 'string' || typeof item.meaning !== 'string') throw new Error('備份內有格式不正確的生字，未有匯入。');
    const word = item.word.trim();
    if (!word || word.length > 80 || /[\u0000-\u001f\u007f]/u.test(word)) throw new Error('備份內有格式不正確的單字，未有匯入。');
    if (seen.has(word.toLowerCase())) continue;
    const entry = { word };
    for (const [field, limit] of Object.entries(fields)) entry[field] = typeof item[field] === 'string' ? item[field].slice(0, limit) : '';
    entry.saved_at = typeof item.saved_at === 'string' && Number.isFinite(Date.parse(item.saved_at)) ? new Date(item.saved_at).toISOString() : new Date().toISOString();
    entry.review = normalizeReview(item.review);
    vocabulary.push(entry);
    seen.add(word.toLowerCase());
    added++;
  }
  if (vocabulary.length > 10000) throw new Error('合併後超過 10,000 個生字，請先整理學習簿。');
  return { vocabulary, added };
}
