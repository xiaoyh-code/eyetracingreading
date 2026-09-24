"""Run the reader on this computer: uv run gaze-reader --open."""

import argparse
import threading
import webbrowser
from pathlib import Path

import uvicorn


def main() -> None:
    parser = argparse.ArgumentParser(description="目讀 — 本機英文閱讀器")
    parser.add_argument("--port", type=int, default=8765, help="Local port (default: 8765)")
    parser.add_argument("--open", action="store_true", help="Open the reader in your browser")
    parser.add_argument("--reload", action="store_true", help="Reload Python code during development")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    if not (Path(__file__).parent / "static/bundled/app.js").is_file():
        parser.error("請先在專案目錄執行 npm ci --ignore-scripts，再執行 npm run build，準備網頁元件。")
    url = f"http://127.0.0.1:{args.port}"
    print(f"\n目讀 Gaze Reader → {url}\n按 Ctrl+C 關閉。\n", flush=True)
    if args.open:
        timer = threading.Timer(1.2, webbrowser.open, args=(url,))
        timer.daemon = True
        timer.start()
    uvicorn.run("reader.app:app", host="127.0.0.1", port=args.port, reload=args.reload)


if __name__ == "__main__":
    main()
