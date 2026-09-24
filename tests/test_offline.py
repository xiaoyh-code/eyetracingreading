"""Exercise inference boundaries without downloading models or making API calls."""

from types import SimpleNamespace

import pytest

from reader import offline


@pytest.fixture(autouse=True)
def reset_cache():
    offline._translate.cache_clear()
    yield
    offline._translate.cache_clear()


def test_missing_model_is_explicit(monkeypatch, tmp_path):
    monkeypatch.setenv("READER_MODEL_DIR", str(tmp_path))
    assert not offline.offline_status()
    assert offline.translate_offline("apple", "An apple falls.") is None


def test_inference_is_local_cached_and_removes_token_markers(monkeypatch):
    calls = []

    class Tokenizer:
        def encode(self, text, out_type=str):
            return text.split()

        def decode(self, tokens):
            return "".join(tokens)

    class Translator:
        def translate_batch(self, values, **options):
            calls.append(values)
            assert options["max_input_length"] == 0
            return [SimpleNamespace(hypotheses=[["▁", "繁體譯文"]]) for value in values]

    monkeypatch.setattr(offline, "offline_status", lambda: True)
    monkeypatch.setattr(offline, "_runtime", lambda path: (
        Tokenizer(), Translator(), SimpleNamespace(convert=lambda text: text)
    ))
    answer = offline.translate_offline("apple", "An apple falls.")
    assert answer["source"] == "offline"
    assert answer["translation"] == "繁體譯文"
    assert answer["example"] == ""
    assert offline.translate_offline("apple", "An apple falls.") == answer
    assert len(calls) == 2


def test_long_sentences_are_chunked_without_silent_truncation(monkeypatch):
    seen = []

    class Tokenizer:
        def encode(self, text, out_type=str):
            return text.split()

        def decode(self, tokens):
            return " ".join(tokens)

    class Translator:
        def translate_batch(self, batches, **options):
            seen.extend(batches)
            return [SimpleNamespace(hypotheses=[batch]) for batch in batches]

    monkeypatch.setattr(offline, "_runtime", lambda path: (
        Tokenizer(), Translator(), SimpleNamespace(convert=lambda text: text)
    ))
    original = " ".join(f"w{i}" for i in range(450))
    assert offline._translate(original, "fixture-model") == original
    assert len(seen) == 3
    assert max(map(len, seen)) <= 180


def test_oversized_input_rejected_before_inference(monkeypatch):
    monkeypatch.setattr(offline, "offline_status", lambda: True)
    with pytest.raises(ValueError, match="查詢過長"):
        offline.translate_offline("x" * 121, "A sentence.")
