import asyncio
import base64
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
from fastapi.testclient import TestClient

import reader.app as app_module
from reader.app import create_app
from reader.assistance import AssistanceError, AssistanceService, ExplainRequest, ImageRequest
from reader.tencent import TencentImageError, TencentImageService, vocabulary_prompt

EXPLANATION = {"meaning": "美好的意外發現", "translation": "我意外發現一本好書。", "example": "It was serendipity.", "visual_hint": "散步時發現秘密花園。"}
PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII="


@pytest.fixture(autouse=True)
def isolated_settings(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("LOCAL_IMAGE_URL", raising=False)
    for variable in ("IMAGE_PROVIDER", "TENCENT_SECRET_ID", "TENCENT_SECRET_KEY", "TENCENT_TOKEN", "TENCENT_REGION",
                     "TOKENHUB_API_KEY", "TOKENHUB_BASE_URL", "TOKENHUB_IMAGE_MODEL"):
        monkeypatch.delenv(variable, raising=False)
    monkeypatch.setattr(app_module, "_offline_help", lambda word, sentence: None)
    monkeypatch.setattr(app_module, "_offline_status", lambda: False)


@pytest.fixture
def client():
    with TestClient(create_app(), base_url="http://localhost") as test_client:
        yield test_client


def mock_ai():
    return SimpleNamespace(
        responses=SimpleNamespace(create=AsyncMock(return_value=SimpleNamespace(output_text=json.dumps(EXPLANATION)))),
        images=SimpleNamespace(generate=AsyncMock(return_value=SimpleNamespace(data=[SimpleNamespace(b64_json=PNG)]))),
        close=AsyncMock(),
    )


def test_config_and_import_routes(client):
    config = client.get("/api/config").json()
    assert config["ai_available"] is False
    assert config["offline_available"] is False
    assert config["limits"]["max_upload_mb"] == 20
    assert client.get("/api/health").json() == {"status": "ok"}
    assert client.get("/api/demo").json()["word_count"] > 350
    result = client.post("/api/documents/text", json={"text": "A quiet river.", "title": "Test"})
    assert result.status_code == 200
    assert result.json()["word_count"] == 3
    upload = client.post("/api/documents/upload", files={"file": ("words.md", b"# A small book", "text/markdown")})
    assert upload.status_code == 200
    assert upload.json()["source"] == "md"


def test_unknown_offline_word_is_honest_and_known_word_has_no_fake_translation(client):
    response = client.post("/api/explain", json={"word": "photosynthesis", "sentence": "Plants use photosynthesis."}).json()
    assert response["source"] == "unavailable"
    assert response["translation"] == ""
    assert response["meaning"] == ""
    response = client.post("/api/explain", json={"word": "resilience", "sentence": "This sentence has resilience."}).json()
    assert response["source"] == "dictionary"
    assert response["meaning"]
    assert response["translation"] == ""


def test_local_translation_keeps_curated_meaning(client, monkeypatch):
    monkeypatch.setattr(app_module, "_offline_help", lambda word, sentence: {
        "meaning": "模型詞義", "translation": "植物展現韌性。", "source": "offline",
    })
    response = client.post("/api/explain", json={"word": "resilience", "sentence": "Plants show resilience."}).json()
    assert response["source"] == "offline"
    assert response["translation"] == "植物展現韌性。"
    assert response["meaning"].startswith("韌性")


def test_broken_local_model_falls_back_without_network(client, monkeypatch):
    def broken(*args):
        raise RuntimeError("private model path")
    monkeypatch.setattr(app_module, "_offline_help", broken)
    response = client.post("/api/explain", json={"word": "resilience", "sentence": "Plants show resilience."})
    assert response.status_code == 200
    assert response.json()["source"] == "dictionary"
    assert "private model path" not in response.text


def test_local_browser_origin_and_host_protection(client):
    payload = {"text": "Hello."}
    assert client.post("/api/documents/text", json=payload, headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.post("/api/documents/text", json=payload, headers={"Sec-Fetch-Site": "same-site"}).status_code == 403
    assert client.post("/api/documents/text", json=payload, headers={"Origin": "http://localhost"}).status_code == 200
    assert client.get("/api/config", headers={"Host": "evil.example"}).status_code == 400


def test_no_implicit_ai_or_image_network(client):
    response = client.post("/api/explain", json={"word": "river", "sentence": "A river flows.", "use_ai": True})
    assert response.status_code == 410
    image = client.post("/api/image", json={"word": "river", "sentence": "A river flows.", "use_ai": False})
    assert image.status_code == 410


def test_ai_payload_is_selected_text_only_and_results_are_cached():
    ai = mock_ai()
    async def run():
        service = AssistanceService(ai, cloud_enabled=True)
        request = ExplainRequest(word="serendipity", sentence="I found a book by serendipity.", use_ai=True)
        for _ in range(2):
            assert (await service.explain(request))["source"] == "ai"
        ai.responses.create.assert_awaited_once()
        kwargs = ai.responses.create.call_args.kwargs
        assert kwargs["store"] is False
        assert json.loads(kwargs["input"]) == {"word": request.word, "sentence": request.sentence}
        assert kwargs["text"]["format"]["strict"] is True
        await service.close()
    asyncio.run(run())


def test_ai_errors_do_not_expose_provider_details():
    ai = mock_ai()
    ai.responses.create.side_effect = RuntimeError("secret-sk-private-key")
    async def run():
        service = AssistanceService(ai, cloud_enabled=True)
        with pytest.raises(AssistanceError) as error:
            await service.explain(ExplainRequest(word="word", sentence="A word.", use_ai=True))
        assert error.value.status_code == 502
        assert "secret-sk" not in str(error.value)
        await service.close()
    asyncio.run(run())


def test_invalid_ai_output_is_rejected():
    ai = mock_ai()
    ai.responses.create.return_value = SimpleNamespace(output_text='{"meaning": "incomplete"}')
    async def run():
        service = AssistanceService(ai, cloud_enabled=True)
        with pytest.raises(AssistanceError) as error:
            await service.explain(ExplainRequest(word="word", sentence="A word.", use_ai=True))
        assert error.value.status_code == 502
        await service.close()
    asyncio.run(run())


def test_concurrent_ai_requests_are_deduplicated():
    ai = mock_ai()
    async def delayed(**kwargs):
        await asyncio.sleep(0.01)
        return SimpleNamespace(output_text=json.dumps(EXPLANATION))
    ai.responses.create.side_effect = delayed
    async def run():
        service = AssistanceService(ai, cloud_enabled=True)
        request = ExplainRequest(word="serendipity", sentence="A moment of serendipity.", use_ai=True)
        responses = await asyncio.gather(*(service.explain(request) for _ in range(5)))
        assert all(response["source"] == "ai" for response in responses)
        ai.responses.create.assert_awaited_once()
        await service.close()
    asyncio.run(run())


def test_image_generation_is_validated_cached_and_rate_limited():
    ai = mock_ai()
    async def run():
        service = AssistanceService(ai, cloud_enabled=True)
        request = ImageRequest(word="river", sentence="A river flows.", use_ai=True)
        image = await service.image(request)
        assert base64.b64decode(image["image_url"].split(",")[1]).startswith(b"\x89PNG")
        await service.image(request)
        ai.images.generate.assert_awaited_once()
        assert ai.images.generate.call_args.kwargs["quality"] == "low"
        await service.image(ImageRequest(word="leaf", sentence="A leaf falls.", use_ai=True))
        await service.image(ImageRequest(word="tree", sentence="A tree grows.", use_ai=True))
        with pytest.raises(AssistanceError) as error:
            await service.image(ImageRequest(word="flower", sentence="A flower opens.", use_ai=True))
        assert error.value.status_code == 429
        await service.close()
    asyncio.run(run())


def test_local_image_endpoint_cannot_point_off_machine(monkeypatch):
    monkeypatch.setenv("LOCAL_IMAGE_URL", "https://example.com")
    with pytest.raises(ValueError, match="本機"):
        AssistanceService()


def test_local_image_generation_stays_on_loopback(monkeypatch):
    monkeypatch.setenv("LOCAL_IMAGE_URL", "http://localhost:7860")
    seen = []
    def respond(request):
        seen.append(request)
        return httpx.Response(200, json={"images": [PNG]})
    original_client = httpx.AsyncClient
    def mock_client(**kwargs):
        assert kwargs["trust_env"] is False
        assert kwargs["follow_redirects"] is False
        return original_client(**kwargs, transport=httpx.MockTransport(respond))
    monkeypatch.setattr("reader.assistance.httpx.AsyncClient", mock_client)
    async def run():
        service = AssistanceService()
        result = await service.image(ImageRequest(word="river", sentence="A river flows."))
        assert result["source"] == "local"
        assert str(seen[0].url) == "http://127.0.0.1:7860/sdapi/v1/txt2img"
        assert json.loads(seen[0].content)["steps"] == 20
        await service.close()
    asyncio.run(run())


def mock_tencent(statuses=("5",)):
    return SimpleNamespace(
        SubmitHunyuanImageJob=Mock(return_value=SimpleNamespace(JobId="example-job-id")),
        QueryHunyuanImageJob=Mock(side_effect=[
            SimpleNamespace(JobStatusCode=status, ResultImage=["https://cos.ap-guangzhou.myqcloud.com/vocabulary.png?signature=temporary"], ResultDetails=["Success"])
            for status in statuses
        ]),
    )


def test_tencent_image_works_without_openai_and_requires_explicit_opt_in(monkeypatch):
    monkeypatch.setenv("IMAGE_PROVIDER", "tencent")
    tencent = mock_tencent()
    async def run():
        service = AssistanceService(tencent_client=tencent, cloud_enabled=True)
        assert not service.available
        assert service.image_available
        assert service.image_provider == "tencent"
        assert service.display_image_model == "Hunyuan Image"
        payload = {"word": "resilience", "sentence": "The young tree showed resilience."}
        with pytest.raises(AssistanceError) as error:
            await service.image(ImageRequest(**payload))
        assert error.value.status_code == 400
        tencent.SubmitHunyuanImageJob.assert_not_called()
        for _ in range(2):
            result = await service.image(ImageRequest(**payload, use_ai=True))
            assert result["source"] == "tencent"
            assert result["image_url"].startswith("https://")
            assert result["expires_in_seconds"] == 3600
        tencent.SubmitHunyuanImageJob.assert_called_once()
        request = tencent.SubmitHunyuanImageJob.call_args.args[0]
        assert "resilience" in request.Prompt
        assert "The young tree showed resilience." in request.Prompt
        assert request.LogoParam is None
        await service.close()
    asyncio.run(run())


def test_explicit_tencent_missing_credentials_never_falls_back_to_openai(monkeypatch):
    monkeypatch.setenv("IMAGE_PROVIDER", "tencent")
    ai = mock_ai()
    async def run():
        service = AssistanceService(ai, cloud_enabled=True)
        assert service.available
        assert service.image_provider == "tencent"
        assert not service.image_available
        with pytest.raises(AssistanceError) as error:
            await service.image(ImageRequest(word="river", sentence="A river flows.", use_ai=True))
        assert error.value.status_code == 503
        assert "TENCENT_SECRET_ID" in str(error.value)
        ai.images.generate.assert_not_awaited()
        await service.close()
    asyncio.run(run())


def test_tencent_credentials_are_not_exposed_by_config(monkeypatch):
    monkeypatch.setenv("IMAGE_PROVIDER", "tencent")
    monkeypatch.setenv("TENCENT_SECRET_ID", "private-secret-id")
    monkeypatch.setenv("TENCENT_SECRET_KEY", "private-secret-key")
    with TestClient(create_app(), base_url="http://localhost") as client:
        response = client.get("/api/config")
        assert response.json()["image_available"] is False
        assert "private-secret" not in response.text


def test_auto_image_provider_preference(monkeypatch):
    monkeypatch.setenv("TENCENT_SECRET_ID", "fake-id")
    monkeypatch.setenv("TENCENT_SECRET_KEY", "fake-key")
    assert AssistanceService(mock_ai(), cloud_enabled=True).image_provider == "tencent"
    monkeypatch.setenv("TOKENHUB_API_KEY", "test-tokenhub-key")
    assert AssistanceService(mock_ai(), cloud_enabled=True).image_provider == "tokenhub"
    monkeypatch.setenv("LOCAL_IMAGE_URL", "http://localhost:7860")
    assert AssistanceService(mock_ai(), cloud_enabled=True).image_provider == "local"


def test_tokenhub_images_are_separate_from_openai_and_cache_paid_requests(monkeypatch):
    monkeypatch.setenv("IMAGE_PROVIDER", "tokenhub")
    monkeypatch.setenv("TOKENHUB_API_KEY", "private-tokenhub-test-key")
    seen = []

    def respond(request):
        seen.append(request)
        return httpx.Response(200, json={"data": [{"url": "https://aigc-image.cos.myqcloud.com/card.png"}]})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as transport_client:
            service = AssistanceService(tokenhub_client=transport_client, cloud_enabled=True)
            assert service.image_provider == "tokenhub"
            assert service.image_available
            assert not service.available
            assert service.display_image_model == "hy-image-v3"
            payload = {"word": "resilience", "sentence": "The tree showed resilience."}
            with pytest.raises(AssistanceError) as error:
                await service.image(ImageRequest(**payload))
            assert error.value.status_code == 400
            assert not seen
            for _ in range(2):
                response = await service.image(ImageRequest(**payload, use_ai=True))
                assert response["source"] == "tokenhub"
                assert response["expires_in_seconds"] == 43200
            assert len(seen) == 1
            await service.close()
    asyncio.run(run())


def test_tokenhub_missing_key_does_not_use_other_provider(monkeypatch):
    monkeypatch.setenv("IMAGE_PROVIDER", "tokenhub")
    ai = mock_ai()
    async def run():
        service = AssistanceService(ai, cloud_enabled=True)
        assert not service.image_available
        with pytest.raises(AssistanceError) as error:
            await service.image(ImageRequest(word="river", sentence="A river flows.", use_ai=True))
        assert error.value.status_code == 503
        assert "TOKENHUB_API_KEY" in str(error.value)
        ai.images.generate.assert_not_awaited()
        await service.close()
    asyncio.run(run())


def test_tencent_pending_job_resumes_without_resubmission():
    tencent = mock_tencent(("1", "2", "5"))
    async def run():
        service = TencentImageService(tencent, poll_interval=0, max_polls=2)
        with pytest.raises(TencentImageError) as error:
            await service.generate("river", "A river flows.")
        assert error.value.status_code == 504
        result = await service.generate("river", "A river flows.")
        assert result["source"] == "tencent"
        tencent.SubmitHunyuanImageJob.assert_called_once()
        assert tencent.QueryHunyuanImageJob.call_count == 3
        assert all(call.args[0].JobId == "example-job-id" for call in tencent.QueryHunyuanImageJob.call_args_list)
    asyncio.run(run())


def test_tencent_uncertain_submission_is_not_repeated_and_error_is_sanitized():
    from tencentcloud.common.exception.tencent_cloud_sdk_exception import TencentCloudSDKException
    tencent = mock_tencent()
    tencent.SubmitHunyuanImageJob.side_effect = TencentCloudSDKException("ClientNetworkError", "private-secret-id private-secret-key")
    async def run():
        service = TencentImageService(tencent, poll_interval=0)
        for _ in range(2):
            with pytest.raises(TencentImageError) as error:
                await service.generate("river", "A river flows.")
            assert "private-secret" not in str(error.value)
            assert "重新提交" in str(error.value)
        tencent.SubmitHunyuanImageJob.assert_called_once()
    asyncio.run(run())


def test_tencent_failed_job_is_not_resubmitted():
    tencent = mock_tencent(("4",))
    async def run():
        service = TencentImageService(tencent, poll_interval=0)
        for _ in range(2):
            with pytest.raises(TencentImageError, match="生成失敗"):
                await service.generate("river", "A river flows.")
        tencent.SubmitHunyuanImageJob.assert_called_once()
        tencent.QueryHunyuanImageJob.assert_called_once()
    asyncio.run(run())


def test_tencent_rejects_non_https_image_url():
    tencent = mock_tencent()
    tencent.QueryHunyuanImageJob.side_effect = None
    tencent.QueryHunyuanImageJob.return_value = SimpleNamespace(JobStatusCode="5", ResultImage=["javascript:alert(1)"], ResultDetails=["Success"])
    async def run():
        with pytest.raises(TencentImageError, match="網址"):
            await TencentImageService(tencent).generate("river", "A river flows.")
    asyncio.run(run())


def test_tencent_prompt_respects_limit_and_keeps_selected_word_near_sentence_end():
    sentence = "A long story. " * 150 + "The quiet river flows through the valley."
    prompt = vocabulary_prompt("river", sentence)
    assert len(prompt.encode("utf-8")) <= 1024
    assert "The quiet river flows" in prompt


def test_tencent_sdk_profile_disables_resubmissions(monkeypatch):
    from tencentcloud.common.retry import NoopRetryer
    monkeypatch.setenv("TENCENT_SECRET_ID", "fake-id")
    monkeypatch.setenv("TENCENT_SECRET_KEY", "fake-key")
    sdk = TencentImageService()._get_client()
    assert isinstance(sdk.profile.retryer, NoopRetryer)
    assert sdk.profile.disable_region_breaker is True
    assert sdk.profile.httpProfile.reqTimeout == 15
    assert sdk.profile.httpProfile.endpoint == "hunyuan.tencentcloudapi.com"
