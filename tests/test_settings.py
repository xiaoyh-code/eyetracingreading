import asyncio
import io
import json
import os
import stat
import subprocess
import sys
import time
from unittest.mock import AsyncMock

import httpx
import pytest
from dotenv import dotenv_values
from fastapi.testclient import TestClient

from reader.app import PROJECT_DIR, create_app
from reader.assistance import AssistanceService, ImageRequest
from reader.settings import MAX_ENV_BYTES, SettingsError, persist_env, updated_env

BASE = "https://tokenhub.tencentmaas.com/v1"
NEW_BASE = "https://tokenhub-intl.tencentmaas.com/v1"
OLD_KEY = "fake-existing-tokenhub-key"
NEW_KEY = "fake-new-tokenhub-key"
ENDPOINT = "/api/settings/tokenhub"


@pytest.fixture
def service(monkeypatch):
    for name in ("OPENAI_API_KEY", "TENCENT_SECRET_ID", "TENCENT_SECRET_KEY", "LOCAL_IMAGE_URL"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("TOKENHUB_API_KEY", OLD_KEY)
    monkeypatch.setenv("TOKENHUB_BASE_URL", BASE)
    monkeypatch.setenv("TOKENHUB_IMAGE_MODEL", "hy-image-v3")
    monkeypatch.setenv("IMAGE_PROVIDER", "auto")
    service = AssistanceService()
    service.tokenhub.generate = AsyncMock(side_effect=AssertionError("Settings must not make paid requests"))
    return service


def client_for(service, tmp_path):
    return TestClient(create_app(service, env_path=tmp_path / ".env"), base_url="http://127.0.0.1")


def parsed(source):
    return dotenv_values(stream=io.StringIO(source), interpolate=False)


def test_env_edit_preserves_comments_unrelated_multiline_and_duplicate_assignments():
    source = (
        "# Keep this comment\nOTHER='line one\nline two' # untouched\n"
        "export TOKENHUB_API_KEY = 'old' # credential comment\n"
        "TOKENHUB_API_KEY=old-again\nIMAGE_PROVIDER=auto  # provider comment\n"
        "# TOKENHUB_BASE_URL=commented-out\nLAST=unchanged"
    )
    key = "test-token'with\\slash#equals=value"
    result = updated_env(source, {"TOKENHUB_API_KEY": key, "IMAGE_PROVIDER": "tokenhub", "TOKENHUB_BASE_URL": BASE})
    assert "# Keep this comment\nOTHER='line one\nline two' # untouched\n" in result
    assert "# TOKENHUB_BASE_URL=commented-out\nLAST=unchanged\n" in result
    assert " # credential comment\n" in result
    assert "  # provider comment\n" in result
    assert "old-again" not in result
    assert parsed(result)["TOKENHUB_API_KEY"] == key
    assert parsed(result)["IMAGE_PROVIDER"] == "tokenhub"
    assert parsed(result)["TOKENHUB_BASE_URL"] == BASE
    assert result.count("TOKENHUB_API_KEY") == 2


@pytest.mark.parametrize("source", [
    "\ufeffTOKENHUB_API_KEY=old\r\nOTHER=value\r\n",
    "'TOKENHUB_API_KEY'=\"old\nmultiline\" # old comment\r\n",
    "TOKENHUB_API_KEY # comment\r\n",
    "TOKENHUB_API_KEY=old",
])
def test_env_edit_handles_bom_crlf_quoted_multiline_or_valueless_keys(source):
    result = updated_env(source, {"TOKENHUB_API_KEY": NEW_KEY, "IMAGE_PROVIDER": "tokenhub"})
    assert parsed(result.removeprefix("\ufeff"))["TOKENHUB_API_KEY"] == NEW_KEY
    assert result.count("\ufeff") == source.count("\ufeff")
    if "\r\n" in source:
        assert "\n" not in result.replace("\r\n", "")


@pytest.mark.parametrize("existing", [False, True])
def test_persistence_is_private_and_preserves_unrelated_settings(tmp_path, existing):
    path = tmp_path / ".env"
    if existing:
        path.write_text("# Existing config\nOTHER='left alone'\nTOKENHUB_API_KEY=old\n")
        path.chmod(0o644)
    persist_env(path, {"TOKENHUB_API_KEY": NEW_KEY})
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert dotenv_values(path)["TOKENHUB_API_KEY"] == NEW_KEY
    if existing:
        assert path.read_text().startswith("# Existing config\nOTHER='left alone'\n")
    assert list(tmp_path.glob(".env-*.tmp")) == []


@pytest.mark.parametrize("contents", [b"OTHER='unterminated", b"OTHER=\xff", b"X" * (MAX_ENV_BYTES + 1)])
def test_invalid_existing_file_is_not_destroyed(tmp_path, contents):
    path = tmp_path / ".env"
    path.write_bytes(contents)
    with pytest.raises(SettingsError) as error:
        persist_env(path, {"TOKENHUB_API_KEY": NEW_KEY})
    assert error.value.status_code == 500
    assert path.read_bytes() == contents
    assert NEW_KEY not in str(error.value)
    assert list(tmp_path.glob(".env-*.tmp")) == []


def test_symlinks_and_special_files_are_not_followed(tmp_path):
    original = tmp_path / "other"
    original.write_text("UNRELATED=preserve\n")
    link = tmp_path / ".env"
    link.symlink_to(original)
    with pytest.raises(SettingsError):
        persist_env(link, {"TOKENHUB_API_KEY": NEW_KEY})
    assert original.read_text() == "UNRELATED=preserve\n"
    assert link.is_symlink()
    link.unlink()
    os.mkfifo(link)
    with pytest.raises(SettingsError):
        persist_env(link, {"TOKENHUB_API_KEY": NEW_KEY})
    assert stat.S_ISFIFO(link.stat().st_mode)


def test_get_never_reads_or_returns_credentials(service, tmp_path, monkeypatch):
    client = client_for(service, tmp_path)
    monkeypatch.setattr("reader.settings.os.open", lambda *args, **kwargs: pytest.fail("GET must not read .env"))
    response = client.get(ENDPOINT)
    assert response.status_code == 200
    assert response.json() == {"configured": True, "base_url": BASE, "model": "hy-image-v3", "active": True}
    assert response.headers["cache-control"] == "no-store"
    assert OLD_KEY not in response.text
    service.tokenhub.generate.assert_not_awaited()


def test_save_hot_applies_without_resetting_guards_or_other_providers(service, tmp_path):
    service.requested_image_provider = "local"
    service.local_image_url = "http://127.0.0.1:7860"
    service.tokenhub._uncertain["uncertain-word"] = time.monotonic()
    service._cache["image"]["cached-word"] = (time.monotonic(), {"image_url": "cached"})
    service._calls["image"].append(time.monotonic())
    before = (service.tokenhub, service.tokenhub._uncertain, service._cache, service._calls, service._pending,
              service.tencent, service._api_key, service.local_image_url)
    path = tmp_path / ".env"
    path.write_text("# My config\nOPENAI_TEXT_MODEL=preserved\n")
    client = client_for(service, tmp_path)
    response = client.post(ENDPOINT, json={"api_key": "  " + NEW_KEY + "  ", "base_url": NEW_BASE + "/"})
    assert response.status_code == 200
    assert response.json() == {"configured": True, "base_url": NEW_BASE, "model": "hy-image-v3", "active": True}
    assert NEW_KEY not in response.text
    assert service.tokenhub._api_key == NEW_KEY
    assert before == (service.tokenhub, service.tokenhub._uncertain, service._cache, service._calls, service._pending,
                      service.tencent, service._api_key, service.local_image_url)
    assert "uncertain-word" in service.tokenhub._uncertain
    assert "cached-word" in service._cache["image"]
    assert len(service._calls["image"]) == 1
    assert service.requested_image_provider == "tokenhub"
    assert dotenv_values(path) == {"OPENAI_TEXT_MODEL": "preserved", "IMAGE_PROVIDER": "tokenhub",
                                  "TOKENHUB_API_KEY": NEW_KEY, "TOKENHUB_BASE_URL": NEW_BASE,
                                  "TOKENHUB_IMAGE_MODEL": "hy-image-v3"}
    assert os.environ["TOKENHUB_API_KEY"] == OLD_KEY
    assert os.environ["IMAGE_PROVIDER"] == "auto"
    service.tokenhub.generate.assert_not_awaited()


@pytest.mark.parametrize("key", [None, "", "   "])
def test_blank_key_keeps_current_credential(service, tmp_path, key):
    response = client_for(service, tmp_path).post(ENDPOINT, json={"api_key": key, "base_url": NEW_BASE})
    assert response.status_code == 200
    assert service.tokenhub._api_key == OLD_KEY
    assert dotenv_values(tmp_path / ".env")["TOKENHUB_API_KEY"] == OLD_KEY


def test_missing_key_cannot_save_unconfigured_service(service, tmp_path):
    service.tokenhub._api_key = ""
    client = client_for(service, tmp_path)
    assert client.get(ENDPOINT).json()["configured"] is False
    response = client.post(ENDPOINT, json={"base_url": BASE})
    assert response.status_code == 422
    assert not (tmp_path / ".env").exists()
    assert service.requested_image_provider == "auto"


@pytest.mark.parametrize("key", ["tiny", "a" * 4097, "secret-key\n", "secret\tkey", "secret key", "secret-中文",
                                 "secret\x00key", "secret\x7fkey", "${EXPANDED}-secret"])
def test_invalid_credentials_are_never_echoed_or_written(service, tmp_path, key):
    response = client_for(service, tmp_path).post(ENDPOINT, json={"api_key": key, "base_url": BASE})
    assert response.status_code == 422
    assert key not in response.text
    assert "secret" not in response.text
    assert service.tokenhub._api_key == OLD_KEY
    assert not (tmp_path / ".env").exists()


@pytest.mark.parametrize("payload", [
    {"api_key": NEW_KEY}, {"api_key": {"secret": NEW_KEY}, "base_url": BASE},
    {"api_key": NEW_KEY, "base_url": BASE, "unexpected": NEW_KEY},
    {"api_key": NEW_KEY, "base_url": None}, {"api_key": NEW_KEY * 500, "base_url": BASE},
    {"api_key": NEW_KEY, "base_url": "https://user:" + NEW_KEY + "@tokenhub.tencentmaas.com/v1"},
    {"api_key": NEW_KEY, "base_url": "https://evil.example/v1?secret=" + NEW_KEY},
])
def test_validation_failures_never_return_pydantic_input(service, tmp_path, payload):
    response = client_for(service, tmp_path).post(ENDPOINT, json=payload)
    assert response.status_code == 422
    assert set(response.json()) == {"detail"}
    assert isinstance(response.json()["detail"], str)
    assert NEW_KEY not in response.text
    assert not (tmp_path / ".env").exists()


def test_malformed_json_does_not_echo_secret(service, tmp_path):
    response = client_for(service, tmp_path).post(ENDPOINT, content='{"api_key":"' + NEW_KEY + '",bad',
                                                headers={"content-type": "application/json"})
    assert response.status_code == 422
    assert NEW_KEY not in response.text


def test_disk_failure_does_not_change_runtime_or_existing_file(service, tmp_path, monkeypatch):
    path = tmp_path / ".env"
    original = "TOKENHUB_API_KEY='" + OLD_KEY + "'\nOTHER=preserved\n"
    path.write_text(original)

    def fail_replace(*args):
        raise OSError("private diagnostic: " + NEW_KEY)

    monkeypatch.setattr("reader.settings.os.replace", fail_replace)
    response = client_for(service, tmp_path).post(ENDPOINT, json={"api_key": NEW_KEY, "base_url": NEW_BASE})
    assert response.status_code == 500
    assert NEW_KEY not in response.text
    assert "private diagnostic" not in response.text
    assert service.tokenhub._api_key == OLD_KEY
    assert service.tokenhub.base_url == BASE
    assert service.requested_image_provider == "auto"
    assert path.read_text() == original
    assert list(tmp_path.glob(".env-*.tmp")) == []


@pytest.mark.parametrize("cancel_request", [False, True])
def test_image_in_flight_blocks_changes_even_after_caller_cancels(service, tmp_path, cancel_request):
    async def run():
        started, release = asyncio.Event(), asyncio.Event()

        async def generate(*args):
            started.set()
            await release.wait()
            return {"source": "tokenhub", "image_url": "cached-image"}

        service.tokenhub.generate = generate
        caller = asyncio.create_task(service.image(ImageRequest(word="river", sentence="A river flows.", use_ai=True)))
        await started.wait()
        pending = list(service._pending.values())
        if cancel_request:
            caller.cancel()
            with pytest.raises(asyncio.CancelledError):
                await caller
        assert service.image_in_flight
        app = create_app(service, env_path=tmp_path / ".env")
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://127.0.0.1") as client:
            response = await client.post(ENDPOINT, json={"api_key": NEW_KEY, "base_url": NEW_BASE})
            assert response.status_code == 409
            assert NEW_KEY not in response.text
            assert not (tmp_path / ".env").exists()
            assert service.tokenhub._api_key == OLD_KEY
            assert service.tokenhub.base_url == BASE
            assert list(service._pending.values()) == pending
            release.set()
            await asyncio.gather(*pending)
            if not cancel_request:
                await caller
            assert not service.image_in_flight
            assert len(service._cache["image"]) == 1
            assert len(service._calls["image"]) == 1
            assert (await client.post(ENDPOINT, json={"api_key": NEW_KEY, "base_url": NEW_BASE})).status_code == 200
            assert len(service._cache["image"]) == 1
            assert len(service._calls["image"]) == 1
        await service.close()
    asyncio.run(run())


def test_text_request_does_not_block_settings(service, tmp_path):
    async def run():
        started, release = asyncio.Event(), asyncio.Event()

        async def generate():
            started.set()
            await release.wait()
            return {"meaning": "example"}

        caller = asyncio.create_task(service._paid("text", "word", "sentence", generate, cloud=False))
        await started.wait()
        assert not service.image_in_flight
        app = create_app(service, env_path=tmp_path / ".env")
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://127.0.0.1") as client:
            assert (await client.post(ENDPOINT, json={"api_key": NEW_KEY, "base_url": BASE})).status_code == 200
        release.set()
        await caller
        await service.close()
    asyncio.run(run())


@pytest.mark.parametrize("bom", [False, True])
def test_saved_file_can_be_loaded_on_restart_without_overriding_exported_values(tmp_path, bom):
    path = tmp_path / ".env"
    if bom:
        path.write_text("\ufeffTOKENHUB_API_KEY=old\n")
    persist_env(path, {"IMAGE_PROVIDER": "tokenhub", "TOKENHUB_API_KEY": NEW_KEY,
                       "TOKENHUB_BASE_URL": BASE, "TOKENHUB_IMAGE_MODEL": "hy-image-v3"})
    # A child process reads only this temporary file; the test process and real
    # workspace .env stay untouched, matching load_dotenv's override=False.
    script = (
        "import json, sys; from dotenv import load_dotenv; "
        "load_dotenv(sys.argv[1],encoding='utf-8-sig'); from reader.assistance import AssistanceService; "
        "s=AssistanceService(); print(json.dumps([s.tokenhub._api_key,s.tokenhub.base_url,s.image_provider]))"
    )
    environment = {"PYTHONPATH": str(PROJECT_DIR)}
    command = [sys.executable, "-c", script, str(path)]
    result = subprocess.run(command, env=environment, cwd=tmp_path, capture_output=True, text=True, check=True, timeout=15)
    assert json.loads(result.stdout) == [NEW_KEY, BASE, "tokenhub"]
    result = subprocess.run(command, env={**environment, "TOKENHUB_API_KEY": OLD_KEY}, cwd=tmp_path,
                            capture_output=True, text=True, check=True, timeout=15)
    assert json.loads(result.stdout) == [OLD_KEY, BASE, "tokenhub"]


def test_settings_writes_require_same_origin(service, tmp_path):
    response = client_for(service, tmp_path).post(ENDPOINT, json={"api_key": NEW_KEY, "base_url": BASE},
                                                headers={"origin": "https://evil.example"})
    assert response.status_code == 403
    assert NEW_KEY not in response.text
    assert not (tmp_path / ".env").exists()
