"""Opt-in TokenHub image generation with fixed official endpoints and no retries."""

from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import re
import time
from collections import OrderedDict
from urllib.parse import urlsplit

import httpx

from .tencent import vocabulary_prompt

MAX_RESPONSE_BYTES = 1024 * 1024
OFFICIAL_HOSTS = frozenset({
    "tokenhub.tencentmaas.com",
    "tokenhub-intl.tencentmaas.com",
    "tokenhub.tencentmaas.cn",
    "tokenhub-intl.tencentmaas.cn",
    "tokenhub.tencentcloudmaas.com",
    "tokenhub-intl.tencentcloudmaas.com",
    "tokenhub-us.tencentcloudmaas.com",
})


class TokenHubImageError(ValueError):
    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


def _base_url(value: str) -> str:
    message = "TOKENHUB_BASE_URL 必須係官方 TokenHub HTTPS 地區網址，並以 /v1 結尾。"
    try:
        parsed = urlsplit(value)
        if (any(ord(character) <= 32 or ord(character) == 127 for character in value)
                or "\\" in value or parsed.scheme != "https" or parsed.hostname not in OFFICIAL_HOSTS
                or parsed.username is not None or parsed.password is not None
                or parsed.port not in {None, 443} or parsed.query or parsed.fragment
                or parsed.path not in {"/v1", "/v1/"}):
            raise ValueError(message)
    except ValueError as exc:
        raise TokenHubImageError(message, 503) from exc
    return f"https://{parsed.hostname}/v1"


def _image_url(value) -> str:
    message = "TokenHub 回傳嘅圖片網址未能安全辨認。"
    if not isinstance(value, str) or len(value) > 16_000:
        raise TokenHubImageError(message)
    try:
        parsed = urlsplit(value)
        host = (parsed.hostname or "").rstrip(".").lower()
        if (any(ord(character) <= 32 or ord(character) == 127 for character in value)
                or "\\" in value or parsed.scheme != "https" or not host
                or parsed.username is not None or parsed.password is not None
                or parsed.port not in {None, 443} or parsed.fragment):
            raise ValueError(message)
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            # Reject local names and non-standard numeric IP spellings understood by browsers.
            if ("." not in host or not re.fullmatch(r"[a-z0-9.-]+", host)
                    or re.fullmatch(r"[0-9.]+", host) or host.startswith("0x")
                    or host == "localhost" or host.endswith((".localhost", ".local", ".localdomain", ".internal", ".lan", ".home", ".invalid", ".test"))):
                raise ValueError(message) from None
        else:
            if not address.is_global:
                raise ValueError(message)
    except ValueError as exc:
        raise TokenHubImageError(message) from exc
    return value


class TokenHubImageService:
    """Generate through the synchronous Hy-Image-3.0 API; do not download images."""

    def __init__(self, client: httpx.AsyncClient | None = None):
        self._api_key = os.getenv("TOKENHUB_API_KEY", "").strip()
        self.base_url = _base_url(os.getenv("TOKENHUB_BASE_URL", "https://tokenhub.tencentmaas.com/v1").strip())
        self.model = os.getenv("TOKENHUB_IMAGE_MODEL", "hy-image-v3").strip()
        if self.model != "hy-image-v3":
            raise TokenHubImageError("目前 TokenHub 圖片功能支援 TOKENHUB_IMAGE_MODEL=hy-image-v3；其他模型使用不同接口。", 503)
        self._client = client
        # Mark an attempt before sending: interrupted/uncertain submissions cannot be repeated.
        self._uncertain: OrderedDict[str, float] = OrderedDict()

    @property
    def available(self) -> bool:
        return bool(self._api_key or self._client is not None)

    async def close(self):
        """Per-call clients close themselves; injected clients remain caller-owned."""

    @staticmethod
    def _status_error(status: int, body: bytes) -> TokenHubImageError:
        code = ""
        try:
            payload = json.loads(body)
            error = payload.get("error", {}) if isinstance(payload, dict) else {}
            if isinstance(error, dict):
                code = str(error.get("code", "")).lower()
        except (ValueError, TypeError):
            pass
        if status == 401:
            return TokenHubImageError("TokenHub API key 未通過驗證；請確認密鑰同所屬地區網址一致。", 503)
        if status == 402 or code in {"insufficient_quota", "insufficient_balance", "insufficient_funds", "balance_not_enough"}:
            return TokenHubImageError("TokenHub 餘額或模型額度不足；請在控制台檢查用量，並確認已啟用混元圖片模型。", 503)
        if status == 403:
            return TokenHubImageError("TokenHub 未授權使用呢個圖片模型；請檢查 API key 範圍同模型服務是否已開通。", 503)
        if status == 429:
            return TokenHubImageError("TokenHub 請求過於頻密或額度受限；請稍後再試。本工具唔會自動重試。", 429)
        if status in {400, 404, 422}:
            return TokenHubImageError("TokenHub 未接受圖片請求；請檢查模型同地區設定，或改用另一個字句。", 422)
        return TokenHubImageError("未能確認 TokenHub 生成結果；為避免重複收費，同一字句一小時內唔會重新提交，請先查看控制台。", 502)

    async def _request(self, client: httpx.AsyncClient, prompt: str, key: str) -> dict:
        headers = {"Authorization": f"Bearer {self._api_key}"} if self._api_key else {}
        async with client.stream(
            "POST", self.base_url + "/wand/hunyuan-image/v3-generation",
            headers=headers, json={"model": self.model, "prompt": prompt, "size": "1024x1024"},
            timeout=100.0, follow_redirects=False,
        ) as response:
            data = bytearray()
            async for chunk in response.aiter_bytes():
                if len(data) + len(chunk) > MAX_RESPONSE_BYTES:
                    raise TokenHubImageError("TokenHub 回應超出大小上限；結果未能確認，同一字句一小時內唔會重新提交。")
                data.extend(chunk)
            if response.status_code < 200 or response.status_code >= 300:
                # Ordinary rejection statuses establish that this attempt was not accepted.
                if 400 <= response.status_code < 500 and response.status_code != 408:
                    self._uncertain.pop(key, None)
                raise self._status_error(response.status_code, data)
        try:
            payload = json.loads(data)
            url = _image_url(payload["data"][0]["url"])
        except (ValueError, TypeError, KeyError, IndexError) as exc:
            raise TokenHubImageError("TokenHub 未回傳有效圖片結果；為避免重複收費，同一字句一小時內唔會重新提交。") from exc
        self._uncertain.pop(key, None)
        return {"image_url": url, "prompt": prompt, "source": "tokenhub", "expires_in_seconds": 43200,
                "message": "由騰訊 TokenHub 混元生成；圖片連結約十二小時後到期，請及時保存。"}

    async def generate(self, word: str, sentence: str) -> dict:
        if not self.available:
            raise TokenHubImageError("未設定 TokenHub API key。請在 .env 填寫 TOKENHUB_API_KEY 後重新啟動。", 503)
        now = time.monotonic()
        for previous in [previous for previous, started in self._uncertain.items() if now - started >= 3600]:
            del self._uncertain[previous]
        key = hashlib.sha256(json.dumps([word, sentence], ensure_ascii=False).encode()).hexdigest()
        if key in self._uncertain:
            raise TokenHubImageError("呢個字句嘅圖片正在生成，或上次結果未能確認；為避免重複收費，一小時內唔會重新提交，請先查看控制台。", 409)
        if len(self._uncertain) >= 64:
            raise TokenHubImageError("未確認嘅圖片任務已達本機上限；請先檢查 TokenHub 控制台或稍後再試。", 429)
        self._uncertain[key] = now
        prompt = vocabulary_prompt(word, sentence)
        try:
            if self._client is not None:
                return await self._request(self._client, prompt, key)
            async with httpx.AsyncClient(timeout=100.0, trust_env=False, follow_redirects=False) as client:
                return await self._request(client, prompt, key)
        except httpx.TimeoutException as exc:
            raise TokenHubImageError("TokenHub 生成回應逾時，結果未能確認；為避免重複收費，同一字句一小時內唔會重新提交。", 504) from exc
        except httpx.HTTPError as exc:
            raise TokenHubImageError("未能確認 TokenHub 連線或生成結果；同一字句一小時內唔會重新提交，請先查看控制台。", 502) from exc
