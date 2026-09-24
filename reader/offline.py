"""Small, local English → Traditional Chinese translation. No network calls.

The Argos English/Chinese 1.9 model is run directly with CTranslate2, since the
reader already supplies individual sentences and needs no extra NLP pipeline.
"""

import importlib.util
import os
import re
import threading
from functools import lru_cache
from pathlib import Path

_LOCK = threading.RLock()


def model_directory() -> Path:
    default = Path(__file__).resolve().parents[1] / ".models" / "en-zh"
    return Path(os.environ.get("READER_MODEL_DIR", str(default))).expanduser()


def offline_status() -> bool:
    path = model_directory()
    return all((path / name).is_file() for name in (
        "model/model.bin", "model/config.json", "sentencepiece.model"
    )) and all(importlib.util.find_spec(name) is not None for name in (
        "ctranslate2", "sentencepiece", "opencc"
    ))


@lru_cache(maxsize=1)
def _runtime(path: str):
    import ctranslate2
    import sentencepiece
    from opencc import OpenCC

    tokenizer = sentencepiece.SentencePieceProcessor(model_file=str(Path(path) / "sentencepiece.model"))
    translator = ctranslate2.Translator(
        str(Path(path) / "model"), device="cpu", compute_type="int8",
        inter_threads=1, intra_threads=min(4, os.cpu_count() or 2),
    )
    return tokenizer, translator, OpenCC("s2twp")


@lru_cache(maxsize=512)
def _translate(text: str, path: str) -> str:
    tokenizer, translator, converter = _runtime(path)
    # Bound tokens explicitly instead of letting the model silently truncate.
    # Prefer word boundaries; very long paragraphs still retain all their text.
    chunks: list[str] = []
    current = ""
    for part in re.findall(r"\S+\s*", text):
        if current and len(tokenizer.encode(current + part, out_type=str)) > 180:
            chunks.append(current)
            current = ""
        current += part
    if current:
        chunks.append(current)
    encoded = [tokenizer.encode(chunk, out_type=str) for chunk in chunks]
    if any(len(tokens) > 256 for tokens in encoded):
        raise ValueError("文字包含過長的連續字串，請分成較短句子。")
    predictions = translator.translate_batch(
        encoded, beam_size=4, max_batch_size=8,
        replace_unknowns=True, length_penalty=0.2,
        max_input_length=0, max_decoding_length=512,
    )
    # Copied unknown tokens may still carry SentencePiece's visible space marker.
    parts = [tokenizer.decode(result.hypotheses[0]).replace("▁", " ").strip() for result in predictions]
    return converter.convert(" ".join(parts)).strip()


def translate_offline(word: str, sentence: str) -> dict | None:
    """Return the assistance API shape, or None when the model is not installed.

    Call from a worker thread; model initialization and CPU inference are blocking.
    No translation claims are made for additional definitions or example sentences.
    """
    if not offline_status():
        return None
    if len(word) > 120 or len(sentence) > 6000:
        raise ValueError("查詢過長，請選取一個單字及較短句子。")
    with _LOCK:
        path = str(model_directory())
        meaning = _translate(word.strip(), path) if word.strip() else ""
        translation = _translate(sentence.strip(), path) if sentence.strip() else ""
    return {
        "word": word, "meaning": meaning, "translation": translation,
        "example": "", "visual_hint": "", "source": "offline",
        "message": "本機機器翻譯；單字有多個意思時，請以整句譯文判斷。",
    }
