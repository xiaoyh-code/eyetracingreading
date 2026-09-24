import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { makeDocument, extractUpload, markdownText, decodeText, inspectDocxZip, MAX_UPLOAD_BYTES } from '../reader/static/browser-documents.js';

const flattened = doc => doc.paragraphs.map(p => p.sentences.map(s => s.tokens.map(t => t.text).join('')).join('')).join('\n\n');

test('tokens retain punctuation, whitespace and Unicode; sentence abbreviations remain intact', async () => {
  const text = "Dr. Smith reads a well-known book. It's good!\n\nCafé 中文 _ test.";
  const doc = await makeDocument(text, ' Reading ');
  assert.equal(flattened(doc), text);
  assert.equal(doc.title, 'Reading');
  assert.equal(doc.paragraphs[0].sentences.length, 2);
  assert.equal(doc.paragraphs[0].sentences[0].text, 'Dr. Smith reads a well-known book. ');
  const tokens = doc.paragraphs.flatMap(p => p.sentences.flatMap(s => s.tokens));
  assert.equal(new Set(tokens.map(t => t.id)).size, tokens.length);
  assert.equal(tokens.find(t => t.text === 'well-known').word, true);
  assert.equal(tokens.find(t => t.text === '_').word, false);
  assert.equal(doc.word_count, tokens.filter(t => t.word).length);
});

test('Markdown retains readable labels/code but discards HTML blocks and all remote link/image targets', async () => {
  const input = '# Heading\n\nA [friendly](https://private.invalid/link) **word** ![cat](https://private.invalid/cat.png).\n\n<script>evil()</script>\n\n`inline`\n\n```js\nconst a = 1;\n```';
  const plain = await markdownText(input);
  assert.match(plain, /Heading/); assert.match(plain, /friendly word cat/); assert.match(plain, /const a = 1/);
  assert.doesNotMatch(plain, /private|script|evil|https/);
  const doc = await extractUpload(new File([input], 'notes.md'));
  assert.equal(doc.source, 'md'); assert.equal(doc.title, 'notes');
});

test('UTF-8 and UTF-16 BOM encodings decode; binary and invalid bytes fail explicitly', () => {
  assert.equal(decodeText(new Uint8Array([239, 187, 191, 72, 105])), 'Hi');
  assert.equal(decodeText(new Uint8Array([255, 254, 72, 0, 105, 0])), 'Hi');
  assert.equal(decodeText(new Uint8Array([254, 255, 0, 72, 0, 105])), 'Hi');
  assert.throws(() => decodeText(new Uint8Array([255, 23])), /編碼/);
  assert.throws(() => decodeText(new Uint8Array([65, 0, 66])), /編碼/);
});

test('oversize and unsupported inputs are rejected before reading file bytes', async () => {
  let reads = 0;
  const oversized = { name: 'big.txt', size: MAX_UPLOAD_BYTES + 1, arrayBuffer() { reads++; } };
  await assert.rejects(extractUpload(oversized), error => error.status === 413);
  await assert.rejects(extractUpload({ ...oversized, size: 10, name: 'unsafe.html' }), error => error.status === 415);
  assert.equal(reads, 0);
  await assert.rejects(makeDocument('x'.repeat(150001)), error => error.status === 413);
  await assert.rejects(makeDocument(' \n !! '), /搵唔到/);
  await assert.rejects(extractUpload(new File([], 'empty.txt')), /空白/);
});

test('path-like filenames become plain titles and abort is respected before/after byte reads', async () => {
  const doc = await extractUpload(new File(['Hello world.'], 'C:\\private\\words.TXT'));
  assert.equal(doc.title, 'words'); assert.equal(doc.source, 'txt');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(makeDocument('Hello.', 'Hi', 'text', { signal: controller.signal }), { name: 'AbortError' });
  const during = new AbortController();
  const file = { name: 'sample.txt', size: 3, arrayBuffer: async () => { during.abort(); return new Uint8Array([65, 66, 67]).buffer; } };
  await assert.rejects(extractUpload(file, { signal: during.signal }), { name: 'AbortError' });
});

async function docxBytes() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello from Word.</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Table cell.</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>');
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

test('DOCX preflight and raw-text extraction preserve document/table text', async () => {
  const bytes = await docxBytes();
  assert.ok(inspectDocxZip(bytes).count >= 3);
  const doc = await extractUpload(new File([bytes], 'sample.docx'));
  assert.match(flattened(doc), /Hello from Word\./);
  assert.match(flattened(doc), /Table cell\./);
  assert.equal(doc.source, 'docx');
});

test('DOCX rejects corrupted archives and oversized declared expansion before decompression', async () => {
  assert.throws(() => inspectDocxZip(new Uint8Array(20)), /DOCX/);
  const bytes = await docxBytes(), view = new DataView(bytes.buffer);
  const end = bytes.length - 22, directory = view.getUint32(end + 16, true);
  view.setUint32(directory + 24, 51 * 1024 * 1024, true);
  assert.throws(() => inspectDocxZip(bytes), error => error.status === 413);
  await assert.rejects(extractUpload(new File([bytes], 'expansion.docx')), error => error.status === 413);
});
