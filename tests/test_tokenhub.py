import asyncio
import json

import httpx
import pytest

from reader.tokenhub import MAX_RESPONSE_BYTES, OFFICIAL_HOSTS, TokenHubImageError, TokenHubImageService

IMAGE_URL = "https://hunyuan-result.cos.ap-guangzhou.myqcloud.com/example.png?signature=temporary"


@pytest.fixture(autouse=True)
def tokenhub_environment(monkeypatch):
    monkeypatch.setenv("TOKENHUB_API_KEY", "unit-test-key-not-real")
    monkeypatch.delenv("TOKENHUB_BASE_URL", raising=False)
    monkeypatch.delenv("TOKENHUB_IMAGE_MODEL", raising=False)


def test_tokenhub_request_uses_bearer_key_and_documented_image_schema():
    received = []

    def respond(request):
        received.append(request)
        assert request.headers["Authorization"] == "Bearer unit-test-key-not-real"
        assert str(request.url) == "https://tokenhub.tencentmaas.com/v1/wand/hunyuan-image/v3-generation"
        payload = json.loads(request.content)
        assert payload["model"] == "hy-image-v3"
        assert payload["size"] == "1024x1024"
        assert "resilience" in payload["prompt"]
        assert "The tree showed resilience." in payload["prompt"]
        assert "unit-test-key" not in payload["prompt"]
        return httpx.Response(200, json={"data": [{"url": IMAGE_URL}]})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            service = TokenHubImageService(client)
            assert service.available
            assert service.model == "hy-image-v3"
            result = await service.generate("resilience", "The tree showed resilience.")
            assert result["image_url"] == IMAGE_URL
            assert result["source"] == "tokenhub"
            assert result["expires_in_seconds"] == 43200
            await service.close()
            assert not client.is_closed
    asyncio.run(run())
    assert len(received) == 1  # The returned image URL is never fetched.


@pytest.mark.parametrize("hostname", sorted(OFFICIAL_HOSTS))
def test_official_regional_urls_are_supported(monkeypatch, hostname):
    monkeypatch.setenv("TOKENHUB_BASE_URL", f"https://{hostname}/v1/")
    assert TokenHubImageService().base_url == f"https://{hostname}/v1"


@pytest.mark.parametrize("url", [
    "http://tokenhub.tencentmaas.com/v1", "https://example.com/v1", "https://localhost/v1",
    "https://tokenhub.tencentmaas.com.evil.example/v1", "https://tokenhub.tencentmaas.com@evil.example/v1",
    "https://user:secret@tokenhub.tencentmaas.com/v1", "https://tokenhub.tencentmaas.com/v1?key=secret",
    "https://tokenhub.tencentmaas.com/v1#ignored", "https://tokenhub.tencentmaas.com/v1/../other",
    "https://tokenhub.tencentmaas.com/v1%2fother", "https://tokenhub.tencentmaas.com//v1",
    "https://tokenhub.tencentmaas.com/v1//", "https://tokenhub.tencentmaas.com:444/v1",
    "https://tokenhub.tencentmaas.com\\@evil.example/v1", "https://tokenhub.tencent\nmaas.com/v1",
])
def test_custom_or_smuggled_base_urls_are_rejected_without_exposing_input(monkeypatch, url):
    monkeypatch.setenv("TOKENHUB_BASE_URL", url)
    with pytest.raises(TokenHubImageError) as error:
        TokenHubImageService()
    assert error.value.status_code == 503
    assert "secret" not in str(error.value)
    assert url not in str(error.value)


def test_unsupported_models_and_missing_credentials_fail_before_network(monkeypatch):
    monkeypatch.setenv("TOKENHUB_IMAGE_MODEL", "hy-image-v3.5-preview")
    with pytest.raises(TokenHubImageError, match="不同接口"):
        TokenHubImageService()
    monkeypatch.delenv("TOKENHUB_IMAGE_MODEL")
    monkeypatch.delenv("TOKENHUB_API_KEY")
    service = TokenHubImageService()
    assert not service.available
    async def run():
        with pytest.raises(TokenHubImageError) as error:
            await service.generate("river", "A river flows.")
        assert error.value.status_code == 503
    asyncio.run(run())


@pytest.mark.parametrize(("status", "expected", "message"), [
    (401, 503, "驗證"), (403, 503, "未授權"), (402, 503, "餘額"),
    (429, 429, "頻密"), (400, 422, "未接受"), (500, 502, "未能確認"),
])
def test_provider_errors_are_sanitized(status, expected, message):
    async def run():
        transport = httpx.MockTransport(lambda request: httpx.Response(status, json={"error": {"message": "private-provider-details unit-test-key-not-real"}}))
        async with httpx.AsyncClient(transport=transport) as client:
            with pytest.raises(TokenHubImageError) as error:
                await TokenHubImageService(client).generate("river", "A river flows.")
            assert error.value.status_code == expected
            assert message in str(error.value)
            assert "private-provider" not in str(error.value)
            assert "unit-test-key" not in str(error.value)
    asyncio.run(run())


@pytest.mark.parametrize("failure", ["timeout", "network", "server"])
def test_ambiguous_failures_are_not_resubmitted(failure):
    requests = []
    def respond(request):
        requests.append(request)
        if failure == "timeout":
            raise httpx.ReadTimeout("private details", request=request)
        if failure == "network":
            raise httpx.ConnectError("private details", request=request)
        return httpx.Response(503, json={"error": "private details"})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            service = TokenHubImageService(client)
            with pytest.raises(TokenHubImageError) as initial:
                await service.generate("river", "A river flows.")
            assert initial.value.status_code == (504 if failure == "timeout" else 502)
            with pytest.raises(TokenHubImageError) as repeated:
                await service.generate("river", "A river flows.")
            assert repeated.value.status_code == 409
            assert "private details" not in str(initial.value)
    asyncio.run(run())
    assert len(requests) == 1


def test_explicit_retry_after_definite_rejection_is_allowed():
    requests = []
    def respond(request):
        requests.append(request)
        return httpx.Response(429, json={}) if len(requests) == 1 else httpx.Response(200, json={"data": [{"url": IMAGE_URL}]})
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            service = TokenHubImageService(client)
            with pytest.raises(TokenHubImageError):
                await service.generate("river", "A river flows.")
            assert (await service.generate("river", "A river flows."))["source"] == "tokenhub"
    asyncio.run(run())
    assert len(requests) == 2


def test_owned_client_disables_environment_proxy_and_closes_after_request(monkeypatch):
    original_client = httpx.AsyncClient
    created = []
    def client_factory(**kwargs):
        assert kwargs == {"timeout": 100.0, "trust_env": False, "follow_redirects": False}
        client = original_client(**kwargs, transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"data": [{"url": IMAGE_URL}]})))
        created.append(client)
        return client
    monkeypatch.setattr("reader.tokenhub.httpx.AsyncClient", client_factory)
    asyncio.run(TokenHubImageService().generate("river", "A river flows."))
    assert len(created) == 1
    assert created[0].is_closed


def test_uncertain_submission_blocks_for_exactly_one_hour(monkeypatch):
    clock = {"now": 100.0}
    monkeypatch.setattr("reader.tokenhub.time.monotonic", lambda: clock["now"])
    requests = []
    def respond(request):
        requests.append(request)
        return httpx.Response(500, json={}) if len(requests) == 1 else httpx.Response(200, json={"data": [{"url": IMAGE_URL}]})
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            service = TokenHubImageService(client)
            with pytest.raises(TokenHubImageError):
                await service.generate("river", "A river flows.")
            clock["now"] = 3699.999
            with pytest.raises(TokenHubImageError) as blocked:
                await service.generate("river", "A river flows.")
            assert blocked.value.status_code == 409
            clock["now"] = 3700.0
            assert (await service.generate("river", "A river flows."))["source"] == "tokenhub"
    asyncio.run(run())
    assert len(requests) == 2


@pytest.mark.parametrize("url", [
    "http://cdn.example.com/image.png", "javascript:alert(1)", "https://user:secret@cdn.example.com/image.png",
    "https://127.0.0.1/image.png", "https://10.0.0.1/image.png", "https://169.254.169.254/image.png",
    "https://[::1]/image.png", "https://127.1/image.png", "https://2130706433/image.png",
    "https://0x7f000001/image.png", "https://internal.local/image.png", "https://localhost/image.png",
    "https://cdn.example.com\\@localhost/image.png", "https://cdn.example.com:8000/image.png",
])
def test_invalid_or_private_image_urls_are_not_returned(url):
    async def run():
        transport = httpx.MockTransport(lambda request: httpx.Response(200, json={"data": [{"url": url}]}))
        async with httpx.AsyncClient(transport=transport) as client:
            with pytest.raises(TokenHubImageError) as error:
                await TokenHubImageService(client).generate("river", "A river flows.")
            assert "secret" not in str(error.value)
    asyncio.run(run())


def test_redirect_is_not_followed_even_when_injected_client_follows_redirects():
    received = []
    def respond(request):
        received.append(request)
        return httpx.Response(307, headers={"Location": "https://evil.example/collect"})
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond), follow_redirects=True) as client:
            with pytest.raises(TokenHubImageError):
                await TokenHubImageService(client).generate("river", "A river flows.")
    asyncio.run(run())
    assert len(received) == 1


@pytest.mark.parametrize("body", [b"not JSON", b'{"data": []}', b'{"data": [{}]}', b"x" * (MAX_RESPONSE_BYTES + 1)])
def test_malformed_and_oversized_responses_are_bounded_and_not_resubmitted(body):
    received = []
    def respond(request):
        received.append(request)
        return httpx.Response(200, content=body)
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            service = TokenHubImageService(client)
            with pytest.raises(TokenHubImageError):
                await service.generate("river", "A river flows.")
            with pytest.raises(TokenHubImageError) as repeated:
                await service.generate("river", "A river flows.")
            assert repeated.value.status_code == 409
    asyncio.run(run())
    assert len(received) == 1
