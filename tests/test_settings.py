"""Regression checks for removal of server-side cloud credentials and storage."""

import asyncio
import json
import os
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi.testclient import TestClient

import reader.app as app_module
from reader.app import PROJECT_DIR, create_app
from reader.assistance import AssistanceError, AssistanceService, ExplainRequest

SECRET = "synthetic-session-key-never-send-to-server"
CLOUD_VARIABLES = ("OPENAI_API_KEY", "TOKENHUB_API_KEY", "TENCENT_SECRET_ID", "TENCENT_SECRET_KEY",
                   "TENCENT_TOKEN", "TENCENT_SESSION_TOKEN")


@pytest.fixture(autouse=True)
def isolate_local_services(monkeypatch):
    monkeypatch.delenv("LOCAL_IMAGE_URL", raising=False)
    monkeypatch.setattr(app_module, "_offline_status", lambda: False)
    monkeypatch.setattr(app_module, "_offline_help", lambda *_: None)


def fake_speech():
    return SimpleNamespace(status=AsyncMock(return_value={"speech_available": True, "speech_provider": "macos"}),
                           close=AsyncMock())


def test_default_service_never_reads_cloud_environment_or_constructs_cloud_clients(monkeypatch):
    for name in CLOUD_VARIABLES:
        monkeypatch.setenv(name, SECRET)
    monkeypatch.setenv("IMAGE_PROVIDER", "invalid-cloud-setting")
    monkeypatch.setenv("TOKENHUB_BASE_URL", "https://invalid.example")
    getenv = os.getenv

    def checked_getenv(name, *args):
        if name in CLOUD_VARIABLES or name.startswith(("OPENAI_", "TOKENHUB_", "TENCENT_")) or name == "IMAGE_PROVIDER":
            pytest.fail("Cloud environment settings must not be read")
        return getenv(name, *args)

    monkeypatch.setattr("reader.assistance.os.getenv", checked_getenv)
    forbidden = Mock(side_effect=AssertionError("Cloud clients must not be constructed"))
    monkeypatch.setattr("reader.assistance.TencentImageService", forbidden)
    monkeypatch.setattr("reader.assistance.TokenHubImageService", forbidden)
    injected = SimpleNamespace(close=AsyncMock())
    service = AssistanceService(injected, tencent_client=injected, tokenhub_client=injected)
    assert not service.cloud_enabled
    assert service._api_key == ""
    assert service._client is None
    assert service.tencent is None
    assert service.tokenhub is None
    assert not service.available
    assert not service.image_available
    assert service.image_provider == "unavailable"
    asyncio.run(service.close())
    injected.close.assert_not_awaited()
    forbidden.assert_not_called()


def test_production_app_ignores_all_exported_keys_and_keeps_offline_routes(monkeypatch):
    for name in CLOUD_VARIABLES:
        monkeypatch.setenv(name, SECRET)
    monkeypatch.setenv("IMAGE_PROVIDER", "tokenhub")
    app = create_app(speech=fake_speech())
    with TestClient(app, base_url="http://localhost") as client:
        config = client.get("/api/config")
        assert config.json()["ai_available"] is False
        assert config.json()["image_available"] is False
        assert config.json()["image_provider"] == "unavailable"
        assert config.json()["speech_available"] is True
        assert SECRET not in config.text
        payload = {"word": "river", "sentence": "A river flows.", "use_ai": True}
        for endpoint in ("/api/image", "/api/explain"):
            response = client.post(endpoint, json=payload)
            assert response.status_code == 410
            assert SECRET not in response.text
        offline = client.post("/api/explain", json={**payload, "use_ai": False})
        assert offline.status_code == 200
        assert offline.json()["source"] == "dictionary"
        document = client.post("/api/documents/text", json={"text": "A quiet river."})
        assert document.status_code == 200
        assert document.json()["word_count"] == 3
    assert app.state.assistance._api_key == ""
    assert app.state.assistance.tokenhub is None


@pytest.mark.parametrize("body", [
    json.dumps({"api_key": SECRET, "base_url": "https://tokenhub.tencentmaas.com/v1"}),
    json.dumps({"api_key": None, "base_url": "https://tokenhub.tencentmaas.com/v1"}),
    json.dumps({"api_key": {"unexpected": SECRET}, "extra": SECRET}),
    '{"api_key":"' + SECRET + '", malformed',
    SECRET,
])
def test_retired_settings_endpoint_never_parses_echoes_or_persists_a_key(tmp_path, monkeypatch, body):
    monkeypatch.chdir(tmp_path)
    existing = b"TOKENHUB_API_KEY='synthetic-old-key'\nNONSECRET=preserve\n"
    path = tmp_path / ".env"
    path.write_bytes(existing)
    with TestClient(create_app(speech=fake_speech()), base_url="http://localhost") as client:
        response = client.post("/api/settings/tokenhub", content=body, headers={"content-type": "application/json"})
        assert response.status_code == 410
        assert response.headers["cache-control"] == "no-store"
        assert SECRET not in response.text
        assert "synthetic-old-key" not in response.text
        assert isinstance(response.json()["detail"], str)
        assert client.get("/api/settings/tokenhub").status_code == 410
    assert path.read_bytes() == existing
    assert set(tmp_path.iterdir()) == {path}


def test_retired_settings_endpoint_does_not_create_env_file(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    with TestClient(create_app(speech=fake_speech()), base_url="http://localhost") as client:
        response = client.post("/api/settings/tokenhub", json={"api_key": SECRET})
        assert response.status_code == 410
    assert list(tmp_path.iterdir()) == []


def test_http_routes_block_cloud_even_if_a_caller_injects_a_cloud_capable_service():
    service = SimpleNamespace(local_image_url="", image_provider="tokenhub", available=True,
                              image_available=True, text_model="cloud", display_image_model="cloud",
                              image=AsyncMock(), explain=AsyncMock(), close=AsyncMock())
    with TestClient(create_app(service, speech=fake_speech()), base_url="http://localhost") as client:
        payload = {"word": "river", "sentence": "A river flows.", "use_ai": True}
        assert client.post("/api/explain", json=payload).status_code == 410
        assert client.post("/api/image", json=payload).status_code == 410
        assert client.get("/api/config").json()["ai_available"] is False
        assert client.get("/api/config").json()["image_provider"] == "unavailable"
    service.image.assert_not_awaited()
    service.explain.assert_not_awaited()


def test_local_image_route_remains_local_with_cloud_capable_injected_service():
    service = SimpleNamespace(local_image_url="http://127.0.0.1:7860", image_provider="tokenhub",
                              local_image=AsyncMock(return_value={"source": "local", "image_url": "local-image"}),
                              image=AsyncMock(), close=AsyncMock())
    with TestClient(create_app(service, speech=fake_speech()), base_url="http://localhost") as client:
        config = client.get("/api/config").json()
        assert config["image_provider"] == "local"
        assert config["image_available"] is True
        response = client.post("/api/image", json={"word": "river", "sentence": "A river flows."})
        assert response.status_code == 200
        assert response.json()["source"] == "local"
    service.local_image.assert_awaited_once()
    service.image.assert_not_awaited()


def test_cloud_disabled_service_rejects_paid_operations_without_invoking_them():
    async def run():
        operation = AsyncMock()
        service = AssistanceService()
        with pytest.raises(AssistanceError) as error:
            await service.explain(ExplainRequest(word="river", sentence="A river flows.", use_ai=True))
        assert error.value.status_code == 410
        with pytest.raises(AssistanceError) as error:
            await service._paid("image", "river", "A river flows.", operation, provider="tokenhub")
        assert error.value.status_code == 410
        operation.assert_not_awaited()
        assert not service._pending
        assert not service._calls["image"]
        await service.close()
    asyncio.run(run())


def test_fresh_app_import_does_not_load_dotenv_or_credentials(tmp_path):
    path = tmp_path / ".env"
    contents = "TOKENHUB_API_KEY='synthetic-file-key'\n"
    path.write_text(contents)
    # Isolated child process has only synthetic environment keys; failure text
    # cannot contain any credential inherited from the user's shell.
    environment = {"PYTHONPATH": str(PROJECT_DIR), **{name: SECRET for name in CLOUD_VARIABLES}}
    script = """
import dotenv
def forbidden(*args, **kwargs):
    raise AssertionError('dotenv loading is disabled')
dotenv.load_dotenv = forbidden
from reader.app import app
s = app.state.assistance
assert not s.cloud_enabled and s.tokenhub is None and s.tencent is None and not s._api_key
print('isolated')
"""
    result = subprocess.run([sys.executable, "-c", script], cwd=tmp_path, env=environment,
                            capture_output=True, text=True, check=True, timeout=15)
    assert result.stdout.strip() == "isolated"
    assert path.read_text() == contents
