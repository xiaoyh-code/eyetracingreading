"""Download and verify the small English/Chinese translation model once."""

import argparse
import hashlib
import shutil
import tempfile
import urllib.request
import zipfile
from pathlib import Path

MODEL_URL = "https://argos-net.com/v1/translate-en_zh-1_9.argosmodel"
MODEL_SHA256 = "433e7c4f034d87fbe2353161e05f18646d7999452f801a4e1f0378522b9850ab"
PREFIX = "translate-en_zh-1_9/"
FILES = [
    "metadata.json", "sentencepiece.model", "README.md", "model/model.bin",
    "model/config.json", "model/shared_vocabulary.json",
]
ROOT = Path(__file__).resolve().parents[1]


def install(archive: Path, destination: Path) -> None:
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if digest != MODEL_SHA256:
        raise ValueError("模型校驗碼不符；已停止安裝。請重新下載。")
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as z:
        for name in FILES:
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with z.open(PREFIX + name) as source, target.open("wb") as output:
                shutil.copyfileobj(source, output)
    (destination / "SOURCE.txt").write_text(
        f"Argos Translate English to Chinese 1.9\n{MODEL_URL}\nSHA256: {MODEL_SHA256}\n",
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="下載本機英中翻譯模型（約 71 MB）")
    parser.add_argument("--archive", type=Path, help="Use an already downloaded .argosmodel file")
    parser.add_argument("--destination", type=Path, default=ROOT / ".models" / "en-zh")
    args = parser.parse_args()
    if args.archive:
        install(args.archive, args.destination)
    else:
        print("正在下載英中翻譯模型（約 71 MB），只需執行一次…", flush=True)
        with tempfile.TemporaryDirectory(prefix="gaze-reader-model-") as temp:
            archive = Path(temp) / "model.argosmodel"
            request = urllib.request.Request(MODEL_URL, headers={"User-Agent": "GazeReader/0.1"})
            with urllib.request.urlopen(request, timeout=90) as response, archive.open("wb") as output:
                size = 0
                while block := response.read(1024 * 1024):
                    size += len(block)
                    if size > 100 * 1024 * 1024:
                        raise ValueError("下載超出預期大小；已停止。")
                    output.write(block)
            install(archive, args.destination)
    print(f"離線模型已安裝：{args.destination.resolve()}")
    print("重新啟動閱讀器後，無需 API key 即可翻譯英文句子。")


if __name__ == "__main__":
    main()
