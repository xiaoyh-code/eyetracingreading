"""Local credential settings: safe responses, atomic persistence, no network calls."""

from __future__ import annotations

import io
import os
import re
import stat
import tempfile
from pathlib import Path

from dotenv.parser import parse_stream
from pydantic import BaseModel, ConfigDict, Field

from .tokenhub import TokenHubImageError, _base_url

MAX_ENV_BYTES = 256 * 1024


class SettingsError(ValueError):
    def __init__(self, message: str, status_code: int = 422):
        super().__init__(message)
        self.status_code = status_code


class TokenHubSettingsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, hide_input_in_errors=True)
    api_key: str | None = Field(default=None, max_length=8192, repr=False)
    base_url: str = Field(min_length=1, max_length=256)


def _api_key(value: str) -> str:
    # Trim ordinary clipboard padding, but never accept control characters or
    # dotenv interpolation syntax that would change the credential on restart.
    value = value.strip(" ")
    if not 8 <= len(value) <= 4096 or any(not 33 <= ord(char) <= 126 for char in value) or "${" in value:
        raise SettingsError("API Key 格式不正確；請貼上完整密鑰，勿包含空格、換行或控制字元。")
    return value


def _quoted(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def _replace_value(original: str, key: str, value: str) -> str:
    # Use dotenv's parsed binding boundaries, so unrelated multiline values and
    # commented-out settings cannot be mistaken for assignments.
    header = re.match(rf"(\s*(?:export[^\S\r\n]+)?(?:{key}|'{key}')[^\S\r\n]*)(=[^\S\r\n]*)?", original)
    if header is None:
        raise SettingsError("未能辨認現有設定檔；請先檢查 .env 格式。", 500)
    tail = original[header.end():]
    if header[2] is None:
        suffix = tail
    elif tail.startswith(("'", '"')):
        quote = tail[0]
        quoted = re.match(rf"{quote}(?:\\.|[^{quote}\\])*{quote}", tail, re.DOTALL)
        if quoted is None:
            raise SettingsError("未能辨認現有設定檔；請先檢查 .env 格式。", 500)
        suffix = tail[quoted.end():]
    else:
        comment = re.search(r"[^\S\r\n]+#[^\r\n]*(?:\r\n|\n|\r)?$", tail)
        suffix = comment[0] if comment else re.search(r"[^\S\r\n]*(?:\r\n|\n|\r)?$", tail)[0]
    return header[1] + (header[2] or "=") + _quoted(value) + suffix


def updated_env(source: str, values: dict[str, str]) -> str:
    newline = "\r\n" if "\r\n" in source else "\n"
    output = ["\ufeff"] if source.startswith("\ufeff") else []
    source = source.removeprefix("\ufeff")
    found = set()
    for binding in parse_stream(io.StringIO(source)):
        if binding.error:
            raise SettingsError("現有 .env 格式未能辨認，設定未有更改；請先檢查設定檔。", 500)
        if binding.key in values:
            output.append(_replace_value(binding.original.string, binding.key, values[binding.key]))
            found.add(binding.key)
        else:
            output.append(binding.original.string)
    result = "".join(output)
    missing = [key for key in values if key not in found]
    if missing and result and not result.endswith(("\n", "\r")):
        result += newline
    return result + "".join(f"{key}={_quoted(values[key])}{newline}" for key in missing)


def persist_env(path: Path, values: dict[str, str]) -> None:
    """Replace all settings together; failures before replace leave the file intact."""
    temporary = None
    try:
        source = ""
        try:
            descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | os.O_NONBLOCK)
        except FileNotFoundError:
            descriptor = None
        if descriptor is not None:
            with os.fdopen(descriptor, "rb") as current:
                if not stat.S_ISREG(os.fstat(current.fileno()).st_mode):
                    raise SettingsError("設定檔必須是一般檔案，設定未有更改。", 500)
                raw = current.read(MAX_ENV_BYTES + 1)
                if len(raw) > MAX_ENV_BYTES:
                    raise SettingsError("現有設定檔過大，設定未有更改；請先檢查 .env。", 500)
                source = raw.decode("utf-8")
        result = updated_env(source, values)
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="", dir=path.parent,
                                         prefix=".env-", suffix=".tmp", delete=False) as target:
            temporary = Path(target.name)
            os.fchmod(target.fileno(), 0o600)
            target.write(result)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
        temporary = None
    except (OSError, UnicodeError):
        raise SettingsError("未能儲存本機設定，原有設定未有更改；請檢查 .env 所在資料夾的寫入權限。", 500) from None
    finally:
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


class TokenHubSettings:
    def __init__(self, service, env_path: Path):
        self.service = service
        self.env_path = Path(env_path)

    def snapshot(self) -> dict:
        tokenhub = self.service.tokenhub
        return {"configured": bool(tokenhub._api_key), "base_url": tokenhub.base_url,
                "model": "hy-image-v3", "active": self.service.image_provider == "tokenhub"}

    def save(self, request: TokenHubSettingsRequest) -> dict:
        if self.service.image_in_flight:
            raise SettingsError("圖片仍在生成中，請等完成後再儲存 TokenHub 設定。", 409)
        try:
            base_url = _base_url(request.base_url.strip(" "))
        except TokenHubImageError:
            raise SettingsError("請選擇官方 TokenHub HTTPS 接口，並以 /v1 結尾。") from None
        supplied = request.api_key
        if supplied is None or not supplied.strip(" "):
            supplied = self.service.tokenhub._api_key
        if not supplied:
            raise SettingsError("尚未設定 API Key；請先貼上 TokenHub 密鑰。")
        api_key = _api_key(supplied)
        persist_env(self.env_path, {"IMAGE_PROVIDER": "tokenhub", "TOKENHUB_API_KEY": api_key,
                                   "TOKENHUB_BASE_URL": base_url, "TOKENHUB_IMAGE_MODEL": "hy-image-v3"})
        # This synchronous commit contains no await: an image request cannot
        # start between the in-flight check, atomic save, and runtime update.
        # Keep the existing object, paid caches and uncertainty markers intact.
        self.service.tokenhub._api_key = api_key
        self.service.tokenhub.base_url = base_url
        self.service.tokenhub.model = "hy-image-v3"
        self.service.requested_image_provider = "tokenhub"
        return self.snapshot()
