import asyncio
import io
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

import reader.app as app_module
import reader.speech as speech_module
from reader.app import create_app
from reader.speech import AFCONVERT, SAY, MacOSSpeechService, SpeechError, pronunciation_word


def wav_bytes():
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(22050)
        audio.writeframes(b"\x00\x00" * 2205)
    return output.getvalue()


WAV = wav_bytes()


class FakeProcess:
    def __init__(self, *, output=None, blocked=False, returncode=0):
        self.returncode = None
        self.final_returncode = returncode
        self.killed = False
        self.release = asyncio.Event()
        if not blocked:
            self.release.set()
        self.stdout = None
        if output is not None:
            self.stdout = asyncio.StreamReader()
            self.stdout.feed_data(output)
            self.stdout.feed_eof()

    async def wait(self):
        await self.release.wait()
        if self.returncode is None:
            self.returncode = self.final_returncode
        return self.returncode

    def kill(self):
        self.killed = True
        self.returncode = -9
        self.release.set()


def install_fake_tools(monkeypatch, *, blocked=False, failed=False, invalid_audio=False):
    calls, processes, directories = [], [], []

    async def launch(*argv, **kwargs):
        calls.append((argv, kwargs))
        if argv == (SAY, "-v", "?"):
            process = FakeProcess(output=b"Daniel       en_GB  # Hello\nSamantha     en_US  # Hello\n")
        elif argv[0] == SAY:
            directory = Path(argv[argv.index("-o") + 1]).parent
            directories.append(directory)
            assert Path(argv[argv.index("-f") + 1]).read_text() == "mother-in-law"
            process = FakeProcess(blocked=blocked, returncode=1 if failed else 0)
        else:
            assert argv[0] == AFCONVERT
            Path(argv[-1]).write_bytes(b"invalid" if invalid_audio else WAV)
            process = FakeProcess()
        processes.append(process)
        return process

    monkeypatch.setattr(speech_module.sys, "platform", "darwin")
    monkeypatch.setattr(speech_module.os, "access", lambda *_: True)
    monkeypatch.setattr(speech_module.asyncio, "create_subprocess_exec", launch)
    return calls, processes, directories


@pytest.mark.parametrize(("original", "expected"), [
    ("river", "river"), (" don't ", "don't"), ("mother-in-law", "mother-in-law"),
    ("isn’t", "isn't"), ("well\u2011being", "well-being"), ("A", "A"), ("a" * 80, "a" * 80),
])
def test_only_plain_english_words_and_compounds_are_normalized(original, expected):
    assert pronunciation_word(original) == expected


@pytest.mark.parametrize("word", [
    "", " ", "two words", "word\nword", "word\x00", "a" * 81, "中文", "abc123",
    "--voice", "../file", "$(echo hello)", "word;echo", "[[slnc 10000]]", "a--b", None, 42,
])
def test_invalid_words_fail_before_subprocess(word):
    with pytest.raises(SpeechError) as error:
        pronunciation_word(word)
    assert error.value.status_code == 422


def test_synthesis_is_file_only_uses_argv_and_cleans_temporary_files(monkeypatch):
    calls, processes, directories = install_fake_tools(monkeypatch)

    async def run():
        service = MacOSSpeechService()
        assert await service.status() == {"speech_available": True, "speech_provider": "macos"}
        assert await service.synthesize("mother-in-law") == WAV
        assert await service.status() == {"speech_available": True, "speech_provider": "macos"}
        await service.close()
        assert (await service.status())["speech_available"] is False
    asyncio.run(run())
    assert len(calls) == 3  # Voice discovery is cached.
    assert calls[1][0][:5] == (SAY, "-v", "Samantha", "-r", "160")
    assert "-o" in calls[1][0] and "-f" in calls[1][0]
    assert calls[2][0][:7] == (AFCONVERT, "-f", "WAVE", "-d", "LEI16@22050", "-c", "1")
    assert all("shell" not in kwargs and kwargs["stdin"] == asyncio.subprocess.DEVNULL for _, kwargs in calls)
    assert all(kwargs["stderr"] == asyncio.subprocess.DEVNULL for _, kwargs in calls)
    assert all(not directory.exists() for directory in directories)
    assert all(process.returncode == 0 for process in processes)


def test_unsupported_platform_does_not_spawn_processes(monkeypatch):
    monkeypatch.setattr(speech_module.sys, "platform", "linux")
    launch = AsyncMock()
    monkeypatch.setattr(speech_module.asyncio, "create_subprocess_exec", launch)

    async def run():
        service = MacOSSpeechService()
        assert await service.status() == {"speech_available": False, "speech_provider": "unavailable"}
        with pytest.raises(SpeechError) as error:
            await service.synthesize("river")
        assert error.value.status_code == 503
    asyncio.run(run())
    launch.assert_not_awaited()


def test_catalog_voice_names_with_language_labels_are_preserved(monkeypatch):
    monkeypatch.setattr(speech_module.sys, "platform", "darwin")
    monkeypatch.setattr(speech_module.os, "access", lambda *_: True)
    service = MacOSSpeechService()
    service._run = AsyncMock(return_value=(
        b"Daniel (English (UK)) en_GB # Hello\n"
        b"Samantha (English (US)) en_US # Hello\n"
    ))
    assert asyncio.run(service.status())["speech_available"]
    assert service._voice == "Samantha (English (US))"


def test_missing_english_voice_is_unavailable_and_never_uses_system_default(monkeypatch):
    monkeypatch.setattr(speech_module.sys, "platform", "darwin")
    monkeypatch.setattr(speech_module.os, "access", lambda *_: True)
    launch = AsyncMock(side_effect=lambda *args, **kwargs: FakeProcess(output=b"Sinji zh_HK # Hello\n"))
    monkeypatch.setattr(speech_module.asyncio, "create_subprocess_exec", launch)

    async def run():
        service = MacOSSpeechService()
        assert not (await service.status())["speech_available"]
        with pytest.raises(SpeechError) as error:
            await service.synthesize("river")
        assert error.value.status_code == 503
    asyncio.run(run())
    assert launch.await_count == 1


def test_cancellation_kills_child_and_releases_serialization_slot(monkeypatch):
    calls, processes, directories = install_fake_tools(monkeypatch, blocked=True)

    async def run():
        service = MacOSSpeechService()
        await service.status()
        pending = asyncio.create_task(service.synthesize("mother-in-law"))
        while len(processes) < 2:
            await asyncio.sleep(0)
        with pytest.raises(SpeechError) as busy:
            await service.synthesize("river")
        assert busy.value.status_code == 429
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending
        assert processes[-1].killed
        assert not service._busy
        assert not service._processes
        await service.close()
    asyncio.run(run())
    assert len(calls) == 2  # Cancelled synthesis never starts conversion.
    assert all(not directory.exists() for directory in directories)


def test_timeout_kills_child_and_returns_safe_error(monkeypatch):
    _, processes, directories = install_fake_tools(monkeypatch, blocked=True)
    monkeypatch.setattr(speech_module, "PROCESS_TIMEOUT", 0.03)

    async def run():
        service = MacOSSpeechService()
        with pytest.raises(SpeechError) as error:
            await service.synthesize("mother-in-law")
        assert error.value.status_code == 504
        assert "逾時" in str(error.value)
        assert processes[-1].killed
        assert not service._busy
    asyncio.run(run())
    assert all(not directory.exists() for directory in directories)


@pytest.mark.parametrize("failure", ["nonzero", "invalid_audio"])
def test_failed_synthesis_cleans_files_and_never_returns_paths(monkeypatch, failure):
    _, _, directories = install_fake_tools(monkeypatch, failed=failure == "nonzero", invalid_audio=failure == "invalid_audio")

    async def run():
        service = MacOSSpeechService()
        with pytest.raises(SpeechError) as error:
            await service.synthesize("mother-in-law")
        assert error.value.status_code == 502
        assert all(str(directory) not in str(error.value) for directory in directories)
        assert not service._busy
    asyncio.run(run())
    assert all(not directory.exists() for directory in directories)


def test_shutdown_stops_active_speech(monkeypatch):
    _, processes, directories = install_fake_tools(monkeypatch, blocked=True)

    async def run():
        service = MacOSSpeechService()
        await service.status()
        pending = asyncio.create_task(service.synthesize("mother-in-law"))
        while len(processes) < 2:
            await asyncio.sleep(0)
        await service.close()
        with pytest.raises(SpeechError):
            await pending
        assert processes[-1].killed
        assert not (await service.status())["speech_available"]
    asyncio.run(run())
    assert all(not directory.exists() for directory in directories)


def test_endpoint_returns_wav_and_keeps_existing_local_request_guard(monkeypatch):
    monkeypatch.setattr(app_module, "_offline_status", lambda: False)
    speech = SimpleNamespace(status=AsyncMock(return_value={"speech_available": True, "speech_provider": "macos"}),
                             synthesize=AsyncMock(return_value=WAV), close=AsyncMock())
    assistance = SimpleNamespace(available=False, local_image_url="", text_model="unused", display_image_model="unused",
                                 image_available=False, image_provider="unavailable", close=AsyncMock())
    with TestClient(create_app(assistance, speech=speech), base_url="http://localhost") as client:
        config = client.get("/api/config").json()
        assert config["speech_available"] is True
        assert config["speech_provider"] == "macos"
        response = client.post("/api/speech", json={"word": "river"})
        assert response.status_code == 200
        assert response.content == WAV
        assert response.headers["content-type"] == "audio/wav"
        assert response.headers["cache-control"] == "no-store"
        assert "pronunciation.wav" in response.headers["content-disposition"]
        assert client.post("/api/speech", json={"word": "river"}, headers={"Origin": "https://evil.example"}).status_code == 403
        for body in [{}, {"word": 4}, {"word": "river", "voice": "injected"}]:
            invalid = client.post("/api/speech", json=body)
            assert invalid.status_code == 422
            assert isinstance(invalid.json()["detail"], str)
        speech.synthesize.side_effect = SpeechError("本機發音準備逾時，請稍後再試。", 504)
        failed = client.post("/api/speech", json={"word": "river"})
        assert failed.status_code == 504
        assert failed.json()["detail"] == "本機發音準備逾時，請稍後再試。"
    assert speech.synthesize.await_count == 2
    speech.close.assert_awaited_once()
