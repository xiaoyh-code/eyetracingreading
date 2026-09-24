"""Bounded document extraction and lossless text tokens for the reading surface."""

from __future__ import annotations

import io
import re
import uuid
import zipfile
from pathlib import Path

from docx import Document as WordDocument
from markdown_it import MarkdownIt
from pypdf import PdfReader

MAX_UPLOAD_BYTES = 20 * 1024 * 1024
MAX_CHARACTERS = 150_000
MAX_UNPACKED_BYTES = 50 * 1024 * 1024
SUPPORTED_EXTENSIONS = {".pdf", ".md", ".markdown", ".txt", ".text", ".docx"}
WORD_PATTERN = re.compile(r"[^\W_]+(?:['’\-][^\W_]+)*", re.UNICODE)
TOKEN_PATTERN = re.compile(r"[^\W_]+(?:['’\-][^\W_]+)*|\s+|[^\w\s]|_", re.UNICODE)
BOUNDARY_PATTERN = re.compile(r"[.!?][\"'”’\)\]]*\s+(?=[A-Z0-9“\"'(])")
ABBREVIATIONS = {"mr.", "mrs.", "ms.", "dr.", "prof.", "e.g.", "i.e.", "vs.", "etc."}


class DocumentError(ValueError):
    def __init__(self, message: str, status_code: int = 422):
        super().__init__(message)
        self.status_code = status_code


def sentence_segments(paragraph: str) -> list[str]:
    """Keep the separator whitespace with its sentence, so tokens remain faithful."""
    parts: list[str] = []
    start = 0
    for match in BOUNDARY_PATTERN.finditer(paragraph):
        prefix = paragraph[start:match.start() + 1]
        last_word = prefix.split()[-1].lower() if prefix.split() else ""
        if last_word in ABBREVIATIONS or re.fullmatch(r"[a-z]\.", last_word):
            continue
        parts.append(paragraph[start:match.end()])
        start = match.end()
    if start < len(paragraph):
        parts.append(paragraph[start:])
    return parts


def make_document(text: str, title: str = "Untitled reading", source: str = "text", warnings: list[str] | None = None) -> dict:
    if len(text) > MAX_CHARACTERS:
        raise DocumentError("文章太長；每次最多支援 150,000 個字元，請分開匯入。", 413)
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "").strip()
    if not text or not WORD_PATTERN.search(text):
        raise DocumentError("搵唔到可閱讀文字。掃描版 PDF 請先進行 OCR，再匯入文字版。")
    document_id = uuid.uuid4().hex
    paragraphs = []
    word_count = 0
    sequence = 0
    for paragraph_index, paragraph in enumerate(re.split(r"\n[ \t]*\n+", text)):
        if not paragraph.strip():
            continue
        sentences = []
        for sentence_index, sentence in enumerate(sentence_segments(paragraph)):
            tokens = []
            for match in TOKEN_PATTERN.finditer(sentence):
                token_text = match.group()
                is_word = bool(WORD_PATTERN.fullmatch(token_text))
                tokens.append({"id": f"{document_id}-t{sequence}", "text": token_text, "word": is_word})
                sequence += 1
                word_count += int(is_word)
            sentences.append({"id": f"{document_id}-p{paragraph_index}-s{sentence_index}", "text": sentence, "tokens": tokens})
        paragraphs.append({"id": f"{document_id}-p{paragraph_index}", "sentences": sentences})
    return {"id": document_id, "title": title.strip()[:200] or "Untitled reading", "source": source,
            "word_count": word_count, "paragraphs": paragraphs, "warnings": warnings or []}


def markdown_text(text: str) -> str:
    """Extract readable content; HTML, link targets, and image sources are never rendered."""
    tokens = MarkdownIt("default", {"html": True}).parse(text)
    blocks: list[str] = []
    for token in tokens:
        if token.type in {"fence", "code_block"}:
            blocks.append(token.content.rstrip() + "\n\n")
        elif token.type == "inline":
            for child in token.children or []:
                if child.type in {"text", "code_inline"} or child.type == "image":
                    blocks.append(child.content)
                elif child.type in {"softbreak", "hardbreak"}:
                    blocks.append("\n")
        elif token.type in {"paragraph_close", "heading_close", "tr_close", "blockquote_close"}:
            blocks.append("\n\n")
        elif token.type in {"td_close", "th_close"}:
            blocks.append("  ")
    return "".join(blocks).strip()


def _decode_text(data: bytes) -> str:
    try:
        if data.startswith((b"\xff\xfe", b"\xfe\xff")):
            return data.decode("utf-16")
        text = data.decode("utf-8-sig")
        if "\x00" in text:
            raise UnicodeError("binary input")
        return text
    except UnicodeError as exc:
        raise DocumentError("文字編碼未能辨認。請將文稿儲存為 UTF-8 或 UTF-16 文字檔後再試。") from exc


def extract_upload(data: bytes, filename: str) -> dict:
    if len(data) > MAX_UPLOAD_BYTES:
        raise DocumentError("檔案太大；每個檔案上限為 20 MB。", 413)
    if not data:
        raise DocumentError("檔案係空白嘅，請選擇有文字嘅文件。")
    # Treat either platform's path separator as a filename separator.
    name = filename.replace("\\", "/").rsplit("/", 1)[-1]
    extension = Path(name).suffix.lower()
    if extension not in SUPPORTED_EXTENSIONS:
        raise DocumentError("暫時支援 PDF、Markdown、TXT 同 DOCX；舊版 DOC 或 RTF 請先另存為 DOCX 或 TXT。", 415)
    warnings: list[str] = []
    try:
        if extension == ".pdf":
            reader = PdfReader(io.BytesIO(data))
            if reader.is_encrypted and not reader.decrypt(""):
                raise DocumentError("PDF 有密碼保護，請先解鎖再匯入。")
            if len(reader.pages) > 300:
                raise DocumentError("PDF 頁數超過 300 頁，請先分拆文件。", 413)
            pages = []
            character_count = 0
            empty_pages = 0
            for page in reader.pages:
                page_text = page.extract_text() or ""
                character_count += len(page_text)
                if character_count > MAX_CHARACTERS:
                    raise DocumentError("PDF 文字超過 150,000 個字元，請先分拆文件。", 413)
                empty_pages += int(not page_text.strip())
                pages.append(page_text)
            text = "\n\n".join(pages)
            warnings.append("PDF 會轉成連續文字；多欄排版、表格同公式可能需要手動檢查。")
            if empty_pages:
                warnings.append(f"有 {empty_pages} 頁未有擷取到文字；掃描頁需要先進行 OCR。")
        elif extension == ".docx":
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                if len(archive.infolist()) > 2000 or sum(item.file_size for item in archive.infolist()) > MAX_UNPACKED_BYTES:
                    raise DocumentError("DOCX 解壓後內容太大，請移除大型附件或分拆文件。", 413)
            document = WordDocument(io.BytesIO(data))
            # Body order is retained for both paragraphs and tables.
            blocks = []
            for block in document.iter_inner_content():
                if hasattr(block, "rows"):
                    blocks.extend("  ".join(cell.text for cell in row.cells) for row in block.rows)
                else:
                    blocks.append(block.text)
            text = "\n\n".join(blocks)
            warnings.append("DOCX 會擷取正文同表格文字；圖片、頁眉頁腳同文字方塊暫未支援。")
        else:
            text = _decode_text(data)
            if len(text) > MAX_CHARACTERS:
                raise DocumentError("文章太長；每次最多支援 150,000 個字元。", 413)
            if extension in {".md", ".markdown"}:
                text = markdown_text(text)
    except DocumentError:
        raise
    except Exception as exc:
        raise DocumentError("文件未能讀取，可能已損壞或格式不符；請重新匯出 PDF、DOCX 或 UTF-8 文字檔。") from exc
    return make_document(text, Path(name).stem, extension.lstrip("."), warnings)
