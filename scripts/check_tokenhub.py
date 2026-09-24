"""Check TokenHub authentication without generating text or images."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import httpx
from dotenv import load_dotenv


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    load_dotenv(root / ".env")
    sys.path.insert(0, str(root))
    from reader.tokenhub import TokenHubImageError, TokenHubImageService

    try:
        service = TokenHubImageService()
    except TokenHubImageError as error:
        print(str(error))
        return 1
    key = os.getenv("TOKENHUB_API_KEY", "").strip()
    if not key:
        print("請先在本機 .env 填寫 TOKENHUB_API_KEY。")
        return 1
    try:
        with (
            httpx.Client(timeout=20, trust_env=False, follow_redirects=False) as client,
            client.stream("GET", service.base_url + "/models", headers={"Authorization": f"Bearer {key}"}) as response,
        ):
            data = bytearray()
            for chunk in response.iter_bytes():
                data.extend(chunk)
                if len(data) > 1024 * 1024:
                    raise ValueError("oversized response")
            status = response.status_code
        result = {"endpoint": service.base_url, "http_status": status, "authenticated": status == 200}
        if status == 200:
            models = json.loads(data).get("data")
            if not isinstance(models, list):
                raise ValueError("invalid model list")
            matches = [item for item in models if isinstance(item, dict) and item.get("id") == service.model]
            result.update({"image_model": service.model, "image_model_listed": bool(matches),
                           "image_model_online": any(item.get("status") == "online" for item in matches)})
        print(json.dumps(result, ensure_ascii=False, indent=2))
        print("此檢查不會生成內容；通過驗證不代表已開通圖片模型後付費。")
        return 0 if status == 200 else 1
    except (httpx.HTTPError, ValueError, AttributeError):
        print("TokenHub 連線或模型列表檢查失敗；請檢查網絡及所屬站點設定。")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
