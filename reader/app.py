"""Local FastAPI server: parsing and offline help; cloud keys stay in the browser."""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated
from urllib.parse import urlsplit

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from . import demo
from .assistance import AssistanceError, AssistanceService, ExplainRequest, ImageRequest
from .documents import MAX_CHARACTERS, MAX_UPLOAD_BYTES, DocumentError, extract_upload, make_document
from .speech import MacOSSpeechService, SpeechError, SpeechRequest

PROJECT_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = Path(__file__).parent / "static"
CLOUD_DISABLED = "本機伺服器不再接收、儲存或使用雲端 API Key；請在網頁輸入本次使用的密鑰。"


class TextRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1, max_length=MAX_CHARACTERS)
    title: str = Field(default="Untitled reading", max_length=200)


class LocalRequestGuard:
    """Stop cross-origin browser writes and bound bodies before multipart/JSON parsing."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = {key.decode("latin1").lower(): value.decode("latin1") for key, value in scope["headers"]}
        host = headers.get("host", "")
        try:
            host_parts = urlsplit("http://" + host)
            valid_host = host_parts.hostname in {"localhost", "127.0.0.1", "::1"} and not host_parts.username
        except ValueError:
            valid_host = False

        async def error(status: int, detail: str):
            response = JSONResponse({"detail": detail}, status_code=status)
            await response(scope, receive, send)

        if not valid_host:
            return await error(400, "本工具只接受 localhost 或 127.0.0.1 本機連線。")
        if scope["method"] in {"POST", "PUT", "PATCH", "DELETE"}:
            origin = headers.get("origin")
            expected_origin = f"{scope.get('scheme', 'http')}://{host}"
            if (origin is not None and origin.rstrip("/") != expected_origin
                    or headers.get("sec-fetch-site") in {"cross-site", "same-site"}):
                return await error(403, "請從本工具嘅本機頁面發出請求。")
            try:
                declared = int(headers.get("content-length", "0"))
            except ValueError:
                return await error(400, "請求大小格式不正確。")
            body_limit = MAX_UPLOAD_BYTES + 1024 * 1024
            if declared > body_limit:
                return await error(413, "檔案太大；每個檔案上限為 20 MB。")
            chunks = []
            size = 0
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                chunk = message.get("body", b"")
                size += len(chunk)
                if size > body_limit:
                    return await error(413, "檔案太大；每個檔案上限為 20 MB。")
                chunks.append(chunk)
                if not message.get("more_body", False):
                    break
            body = b"".join(chunks)
            delivered = False

            async def replay():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {"type": "http.request", "body": body, "more_body": False}
                return await receive()

            await self.app(scope, replay, send)
        else:
            await self.app(scope, receive, send)


def _offline_status() -> bool:
    try:
        from .offline import offline_status
        return bool(offline_status())
    except ImportError:
        return False


def _offline_help(word: str, sentence: str) -> dict | None:
    try:
        from .offline import translate_offline
        return translate_offline(word, sentence)
    except ImportError:
        return None


def create_app(service: AssistanceService | None = None, *, speech: MacOSSpeechService | None = None) -> FastAPI:
    service = service or AssistanceService(cloud_enabled=False)
    speech = speech or MacOSSpeechService()

    @asynccontextmanager
    async def lifespan(_app):
        yield
        await speech.close()
        await service.close()

    application = FastAPI(title="目讀 · Gaze Reader", lifespan=lifespan, docs_url=None, redoc_url=None)
    application.state.assistance = service
    application.state.speech = speech
    application.add_middleware(LocalRequestGuard)

    @application.exception_handler(DocumentError)
    @application.exception_handler(AssistanceError)
    @application.exception_handler(SpeechError)
    async def handle_expected_error(_request, exc):
        return JSONResponse(status_code=exc.status_code, content={"detail": str(exc)})

    @application.exception_handler(RequestValidationError)
    async def handle_validation_error(request, exc):
        if request.url.path == "/api/speech":
            return JSONResponse(status_code=422, content={"detail": "請提供一個英文單字發音，格式為 {word: 單字}。"})
        return await request_validation_exception_handler(request, exc)

    @application.middleware("http")
    async def response_headers(request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Frame-Options"] = "DENY"
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        elif request.url.path == "/" or (request.url.path.startswith("/static/")
                                          and not request.url.path.startswith("/static/vendor/")):
            # Keep local UI modules consistent when the reader is updated.
            response.headers["Cache-Control"] = "no-cache"
        return response

    @application.get("/api/health")
    async def health():
        return {"status": "ok"}

    @application.api_route("/api/settings/tokenhub", methods=["GET", "POST"])
    async def retired_tokenhub_settings():
        # No body model: old clients receive a fixed error without parsing or
        # echoing credentials, including malformed JSON and unexpected fields.
        raise HTTPException(status_code=410, detail=CLOUD_DISABLED)

    @application.get("/api/config")
    async def config():
        offline_available = await run_in_threadpool(_offline_status)
        speech_status = await speech.status()
        local_image_available = bool(service.local_image_url)
        return {"ai_available": False, "offline_available": offline_available,
                "text_model": "", "image_model": "Stable Diffusion" if local_image_available else "",
                "image_available": local_image_available,
                "local_image_available": local_image_available,
                "image_provider": "local" if local_image_available else "unavailable",
                "text_provider": "offline" if offline_available else "dictionary",
                **speech_status,
                "limits": {"max_upload_mb": 20, "max_characters": MAX_CHARACTERS}}

    @application.get("/api/demo")
    async def get_demo():
        return make_document(demo.TEXT, demo.TITLE, "demo")

    @application.post("/api/documents/text")
    async def text_document(request: TextRequest):
        return await run_in_threadpool(make_document, request.text, request.title, "text")

    @application.post("/api/documents/upload")
    async def upload_document(file: Annotated[UploadFile, File()]):
        try:
            data = await file.read(MAX_UPLOAD_BYTES + 1)
            if len(data) > MAX_UPLOAD_BYTES:
                raise DocumentError("檔案太大；每個檔案上限為 20 MB。", 413)
            return await run_in_threadpool(extract_upload, data, file.filename or "document")
        finally:
            await file.close()

    @application.post("/api/explain")
    async def explain(request: ExplainRequest):
        if request.use_ai:
            raise HTTPException(status_code=410, detail=CLOUD_DISABLED)
        result = await service.explain(request)
        if not request.use_ai and (result["source"] != "demo" or not result["meaning"]):
            is_demo = result["source"] == "demo"
            try:
                local = await run_in_threadpool(_offline_help, request.word, request.sentence)
            except (ValueError, RuntimeError, OSError):
                # A missing/corrupt optional model must not break the offline dictionary.
                result["message"] = "離線翻譯模型暫時未能運作；仍可使用內置小詞庫，請檢查模型設定。"
                return result
            if local:
                for key in ("meaning", "translation", "example", "visual_hint"):
                    if local.get(key) and (not result.get(key) or key == "translation" and not is_demo):
                        result[key] = local[key]
                result["source"] = "demo" if is_demo else "offline"
                result["message"] = ("句子採用示範文章嘅人手翻譯；詞義由本機模型補充。" if is_demo
                                     else local.get("message", "翻譯由本機模型完成，文字無需上傳。機器翻譯可能有誤，請對照原文。"))
        return result

    @application.post("/api/image")
    async def create_image(request: ImageRequest):
        if not service.local_image_url:
            raise HTTPException(status_code=410, detail=CLOUD_DISABLED)
        return await service.local_image(request)

    @application.post("/api/speech")
    async def create_speech(request: SpeechRequest):
        audio = await speech.synthesize(request.word)
        return Response(content=audio, media_type="audio/wav", headers={
            "Content-Disposition": 'inline; filename="pronunciation.wav"',
        })

    @application.get("/")
    async def index():
        index_path = STATIC_DIR / "index.html"
        if not index_path.is_file():
            raise HTTPException(status_code=503, detail="閱讀介面尚未安裝完成。")
        return FileResponse(index_path)

    application.mount("/static", StaticFiles(directory=STATIC_DIR, check_dir=False), name="static")
    return application


app = create_app()
