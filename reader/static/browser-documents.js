// Extract plain text only: imported markup is never inserted as HTML or fetched.
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_CHARACTERS = 150000;
const MAX_UNPACKED_BYTES = 50 * 1024 * 1024;
const WORD = /^[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*$/u;
const TOKENS = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*|\s+|[^\p{L}\p{N}\s]/gu;
const ABBREVIATIONS = new Set(['mr.', 'mrs.', 'ms.', 'dr.', 'prof.', 'e.g.', 'i.e.', 'vs.', 'etc.']);
const EXTENSIONS = new Set(['pdf', 'md', 'markdown', 'txt', 'text', 'docx']);

export class DocumentError extends Error {
  constructor(message, status = 422) { super(message); this.name = 'DocumentError'; this.status = status; }
}
function checkAbort(signal) { if (signal?.aborted) throw new DOMException('文件匯入已取消。', 'AbortError'); }
function bounded(text) {
  if (text.length > MAX_CHARACTERS) throw new DocumentError('文章太長；每次最多支援 150,000 個字元，請分開匯入。', 413);
  return text;
}

export function sentenceSegments(paragraph) {
  const result = [];
  let start = 0;
  for (const match of paragraph.matchAll(/[.!?]["'”’)\]]*\s+(?=[A-Z0-9“"'(])/g)) {
    const last = paragraph.slice(start, match.index + 1).trim().split(/\s+/).at(-1).toLowerCase();
    if (ABBREVIATIONS.has(last) || /^[a-z]\.$/.test(last)) continue;
    result.push(paragraph.slice(start, match.index + match[0].length));
    start = match.index + match[0].length;
  }
  if (start < paragraph.length) result.push(paragraph.slice(start));
  return result;
}

export async function makeDocument(text, title = 'Untitled reading', source = 'text', { signal, warnings = [] } = {}) {
  checkAbort(signal);
  if (typeof text !== 'string') throw new DocumentError('請提供可閱讀文字。');
  text = bounded(text).replace(/\r\n?/g, '\n').replace(/\0/g, '').trim();
  if (!/[\p{L}\p{N}]/u.test(text)) throw new DocumentError('搵唔到可閱讀文字。掃描版 PDF 請先進行 OCR，再匯入文字版。');
  const id = crypto.randomUUID().replaceAll('-', '');
  const paragraphs = [];
  let sequence = 0, wordCount = 0;
  const pieces = text.split(/\n[ \t]*\n+/);
  for (let p = 0; p < pieces.length; p++) {
    checkAbort(signal);
    if (!pieces[p].trim()) continue;
    const sentences = sentenceSegments(pieces[p]).map((sentence, s) => ({
      id: `${id}-p${p}-s${s}`, text: sentence,
      tokens: [...sentence.matchAll(TOKENS)].map(match => {
        const word = WORD.test(match[0]);
        wordCount += Number(word);
        return { id: `${id}-t${sequence++}`, text: match[0], word };
      }),
    }));
    paragraphs.push({ id: `${id}-p${p}`, sentences });
    // Yield so cancellation can reach a long import without blocking the reader.
    if (p && p % 50 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  checkAbort(signal);
  return { id, title: String(title).trim().slice(0, 200) || 'Untitled reading', source, word_count: wordCount, paragraphs, warnings };
}

export function decodeText(bytes) {
  try {
    let encoding = 'utf-8';
    if (bytes[0] === 255 && bytes[1] === 254) encoding = 'utf-16le';
    else if (bytes[0] === 254 && bytes[1] === 255) encoding = 'utf-16be';
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    if (text.includes('\0')) throw new Error('binary');
    return bounded(text);
  } catch (error) {
    if (error instanceof DocumentError) throw error;
    throw new DocumentError('文字編碼未能辨認。請將文稿儲存為 UTF-8 或 UTF-16 文字檔後再試。');
  }
}

export async function markdownText(text) {
  bounded(text);
  const { default: MarkdownIt } = await import('markdown-it');
  const tokens = new MarkdownIt({ html: true, linkify: false }).parse(text, {});
  const blocks = [];
  for (const token of tokens) {
    if (['fence', 'code_block'].includes(token.type)) blocks.push(`${token.content.trimEnd()}\n\n`);
    else if (token.type === 'inline') {
      for (const child of token.children || []) {
        if (['text', 'code_inline', 'image'].includes(child.type)) blocks.push(child.content);
        else if (['softbreak', 'hardbreak'].includes(child.type)) blocks.push('\n');
      }
    } else if (['paragraph_close', 'heading_close', 'tr_close', 'blockquote_close'].includes(token.type)) blocks.push('\n\n');
    else if (['td_close', 'th_close'].includes(token.type)) blocks.push('  ');
  }
  return blocks.join('').trim();
}

// Inspect the ZIP central directory before mammoth allocates decompressed content.
// ZIP64, multi-disk and encrypted documents are deliberately unsupported.
export function inspectDocxZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const invalid = () => { throw new DocumentError('DOCX 結構未能辨認，請另存一份標準 DOCX 後再試。'); };
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
  }
  if (end < 0) invalid();
  const count = view.getUint16(end + 10, true), length = view.getUint32(end + 12, true), offset = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count
      || count === 65535 || length === 0xffffffff || offset === 0xffffffff || offset + length > end) invalid();
  if (count > 2000) throw new DocumentError('DOCX 附件數量太多，請移除附件或分拆文件。', 413);
  let cursor = offset, unpacked = 0, documentFound = false;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > offset + length || view.getUint32(cursor, true) !== 0x02014b50) invalid();
    const flags = view.getUint16(cursor + 8, true), size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true), extra = view.getUint16(cursor + 30, true), comment = view.getUint16(cursor + 32, true);
    if (flags & 1 || size === 0xffffffff || cursor + 46 + nameLength + extra + comment > offset + length) invalid();
    unpacked += size;
    if (unpacked > MAX_UNPACKED_BYTES) throw new DocumentError('DOCX 解壓後內容太大，請移除大型附件或分拆文件。', 413);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (name === 'word/document.xml') documentFound = true;
    cursor += 46 + nameLength + extra + comment;
  }
  if (cursor !== offset + length || !documentFound) invalid();
  return { count, unpacked };
}

async function pdfText(bytes, signal, warnings) {
  const pdfjs = await import('pdfjs-dist/build/pdf.mjs');
  checkAbort(signal);
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: false,
    useWorkerFetch: false, disableFontFace: true, stopAtErrors: true,
    standardFontDataUrl: new URL('./vendor/pdfjs/standard_fonts/', import.meta.url).href,
    cMapUrl: new URL('./vendor/pdfjs/cmaps/', import.meta.url).href, cMapPacked: true });
  const cancel = () => { void task.destroy(); };
  signal?.addEventListener('abort', cancel, { once: true });
  let pdf;
  try {
    pdf = await task.promise;
    if (pdf.numPages > 300) throw new DocumentError('PDF 頁數超過 300 頁，請先分拆文件。', 413);
    const pages = [];
    let characters = 0, empty = 0;
    for (let i = 1; i <= pdf.numPages; i++) {
      checkAbort(signal);
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const parts = [];
      for (const item of content.items) {
        if (typeof item.str === 'string') parts.push(item.str, item.hasEOL ? '\n' : ' ');
      }
      const text = parts.join('').trim();
      characters += text.length + 2;
      if (characters > MAX_CHARACTERS) throw new DocumentError('PDF 文字超過 150,000 個字元，請先分拆文件。', 413);
      empty += Number(!text);
      pages.push(text);
      page.cleanup();
    }
    warnings.push('PDF 會轉成連續文字；多欄排版、表格同公式可能需要手動檢查。');
    if (empty) warnings.push(`有 ${empty} 頁未有擷取到文字；掃描頁需要先進行 OCR。`);
    return pages.join('\n\n');
  } catch (error) {
    checkAbort(signal);
    if (error.name === 'PasswordException') throw new DocumentError('PDF 有密碼保護，請先解鎖再匯入。');
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    await task.destroy();
  }
}

export async function extractUpload(file, { signal } = {}) {
  checkAbort(signal);
  if (!file || !Number.isFinite(file.size) || typeof file.arrayBuffer !== 'function') throw new DocumentError('請選擇可閱讀文件。');
  if (file.size > MAX_UPLOAD_BYTES) throw new DocumentError('檔案太大；每個檔案上限為 20 MB。', 413);
  if (!file.size) throw new DocumentError('檔案係空白嘅，請選擇有文字嘅文件。');
  const name = String(file.name || '').replaceAll('\\', '/').split('/').at(-1);
  const extension = name.includes('.') ? name.split('.').at(-1).toLowerCase() : '';
  if (!EXTENSIONS.has(extension)) throw new DocumentError('暫時支援 PDF、Markdown、TXT 同 DOCX；舊版 DOC 或 RTF 請先另存為 DOCX 或 TXT。', 415);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    checkAbort(signal);
    if (bytes.length > MAX_UPLOAD_BYTES) throw new DocumentError('檔案太大；每個檔案上限為 20 MB。', 413);
    const warnings = [];
    let text;
    if (extension === 'pdf') text = await pdfText(bytes, signal, warnings);
    else if (extension === 'docx') {
      inspectDocxZip(bytes);
      const imported = await import('mammoth/mammoth.browser.js');
      checkAbort(signal);
      const mammoth = imported.default || imported;
      text = (await mammoth.extractRawText({ arrayBuffer: bytes.buffer })).value;
      warnings.push('DOCX 會擷取正文同表格文字；圖片、頁眉頁腳同文字方塊可能未能保留。');
    } else {
      text = decodeText(bytes);
      if (['md', 'markdown'].includes(extension)) text = await markdownText(text);
    }
    checkAbort(signal);
    return await makeDocument(text, name.slice(0, -(extension.length + 1)), extension, { signal, warnings });
  } catch (error) {
    if (error.name === 'AbortError' || error instanceof DocumentError) throw error;
    throw new DocumentError('文件未能讀取，可能已損壞或格式不符；請重新匯出 PDF、DOCX 或 UTF-8 文字檔。');
  }
}
