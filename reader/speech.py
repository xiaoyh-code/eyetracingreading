"""Generate short English pronunciations with installed macOS voices, offline."""

from __future__ import annotations

import asyncio
import io
import os
import re
import sys
import tempfile
import wave
from pathlib import Path

from pydantic import BaseModel, ConfigDict

SAY = "/usr/bin/say"
AFCONVERT = "/usr/bin/afconvert"
MAX_WORD_LENGTH = 80
MAX_AUDIO_BYTES = 2 * 1024 * 1024
PROCESS_TIMEOUT = 12.0
WORD_PATTERN = re.compile(r"[A-Za-z]+(?:['-][A-Za-z]+)*")


class SpeechError(ValueError):
    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


class SpeechRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    word: str


def pronunciation_word(word: str) -> str:
    if not isinstance(word, str):
        raise SpeechError("請選擇一個英文單字發音。", 422)
    word = word.strip().replace("\u2019", "'").replace("\u2010", "-").replace("\u2011", "-")
    if not word or len(word) > MAX_WORD_LENGTH or not WORD_PATTERN.fullmatch(word):
        raise SpeechError("發音只接受一個英文單字，可包含撇號或連字號，最多 80 個字元。", 422)
    return word


def _read_wav(path: Path) -> bytes:
    with path.open("rb") as source:
        data = source.read(MAX_AUDIO_BYTES + 1)
    if len(data) > MAX_AUDIO_BYTES:
        raise SpeechError("本機發音結果超出大小上限，請選擇較短的單字。")
    try:
        with wave.open(io.BytesIO(data), "rb") as audio:
            if (audio.getnchannels() != 1 or audio.getsampwidth() != 2 or audio.getframerate() != 22050
                    or not 0 < audio.getnframes() <= 30 * 22050
                    or len(audio.readframes(audio.getnframes())) != audio.getnframes() * 2):
                raise ValueError("invalid PCM data")
    except (wave.Error, EOFError, ValueError) as exc:
        raise SpeechError("本機未能產生有效的發音音訊，請稍後再試。") from exc
    return data


class MacOSSpeechService:
    """One synthesis at a time; output files and child processes are always cleaned up."""

    def __init__(self):
        self._supported = sys.platform == "darwin" and all(os.access(path, os.X_OK) for path in (SAY, AFCONVERT))
        self._voice: str | None = None
        self._checked = False
        self._probe_lock = asyncio.Lock()
        self._busy = False
        self._closed = False
        self._processes: set[asyncio.subprocess.Process] = set()

    @staticmethod
    async def _stop(process):
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        try:
            await asyncio.wait_for(process.wait(), timeout=2.0)
        except TimeoutError:
            pass

    async def _run(self, *argv: str, capture: bool = False, timeout: float = PROCESS_TIMEOUT) -> bytes:
        if self._closed:
            raise SpeechError("本機發音服務已關閉，請重新啟動閱讀器。", 503)
        process = None
        # Shield creation so cancellation cannot lose the handle to a spawned child.
        launch = asyncio.create_task(asyncio.create_subprocess_exec(
            *argv, stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE if capture else asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        ))
        try:
            async with asyncio.timeout(timeout):
                process = await asyncio.shield(launch)
                self._processes.add(process)
                if self._closed:
                    raise SpeechError("本機發音服務已關閉，請重新啟動閱讀器。", 503)
                output = bytearray()
                if capture:
                    while chunk := await process.stdout.read(8192):
                        output.extend(chunk)
                        if len(output) > 65536:
                            raise SpeechError("未能辨認本機英文聲線，請檢查系統語音設定。", 503)
                await process.wait()
                if process.returncode != 0:
                    raise SpeechError("本機發音未能完成，請檢查已安裝的英文聲線。")
                return bytes(output)
        finally:
            if process is None:
                # A local process can finish launching just as its caller is cancelled.
                try:
                    process = await asyncio.wait_for(launch, timeout=2.0)
                except (OSError, TimeoutError, asyncio.CancelledError):
                    process = None
            if process is not None:
                await self._stop(process)
                self._processes.discard(process)

    async def status(self) -> dict:
        if self._supported and not self._checked and not self._closed:
            async with self._probe_lock:
                if not self._checked and not self._closed:
                    try:
                        output = await self._run(SAY, "-v", "?", capture=True, timeout=3.0)
                        voices = re.findall(r"^(.+?)\s+en_[A-Z]{2}\s+#", output.decode("utf-8"), re.MULTILINE)
                        # Some macOS catalogs include the locale in the voice
                        # name. Pass that installed name unchanged to `say`.
                        self._voice = next((voice for name in ("Samantha", "Daniel")
                                            for voice in sorted(voices, key=len)
                                            if voice == name or voice.startswith(name + " (")), None)
                    except (OSError, TimeoutError, UnicodeError, SpeechError):
                        self._voice = None
                    self._checked = True
        available = bool(self._voice) and not self._closed
        return {"speech_available": available, "speech_provider": "macos" if available else "unavailable"}

    async def synthesize(self, word: str) -> bytes:
        word = pronunciation_word(word)
        if self._busy:
            raise SpeechError("另一個單字正在準備發音，請稍候再試。", 429)
        self._busy = True
        try:
            async with asyncio.timeout(PROCESS_TIMEOUT):
                if not (await self.status())["speech_available"]:
                    raise SpeechError("本機未有可用的英文聲線；請在 macOS 安裝 Samantha 或 Daniel 聲線。", 503)
                with tempfile.TemporaryDirectory(prefix="gaze-reader-speech-") as directory:
                    root = Path(directory)
                    text_path, source_path, output_path = root / "word.txt", root / "word.aiff", root / "word.wav"
                    text_path.write_text(word, encoding="utf-8")
                    await self._run(SAY, "-v", self._voice, "-r", "160", "-o", str(source_path), "-f", str(text_path))
                    await self._run(AFCONVERT, "-f", "WAVE", "-d", "LEI16@22050", "-c", "1", str(source_path), str(output_path))
                    return _read_wav(output_path)
        except TimeoutError as exc:
            raise SpeechError("本機發音準備逾時，請稍後再試。", 504) from exc
        except OSError as exc:
            raise SpeechError("本機發音未能完成，請檢查系統英文聲線。", 502) from exc
        finally:
            self._busy = False

    async def close(self):
        self._closed = True
        for process in list(self._processes):
            await self._stop(process)
