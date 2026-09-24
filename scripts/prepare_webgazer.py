#!/usr/bin/env python3
"""Install the pinned WebGazer bundle and every local MediaPipe runtime asset.

Only this explicit setup step downloads anything; reading/camera mode uses local
files. WebGazer is GPL-3.0-or-later; its license is kept beside the bundle.
"""
from __future__ import annotations

import base64
import hashlib
import io
import tarfile
import urllib.request
from pathlib import Path

VERSION = "3.5.3"
URL = f"https://registry.npmjs.org/webgazer/-/webgazer-{VERSION}.tgz"
INTEGRITY = "i6P97fWeixASmHWrJxgLUICugqV6qljIafi2ne6p0WYXAuldpwoaFRkedKFcu/qm95d128gdUxhOr336estXOw=="
DESTINATION = Path(__file__).resolve().parents[1] / "reader/static/vendor"
LIMIT = 60 * 1024 * 1024


def main() -> None:
    print(f"Downloading WebGazer {VERSION} and bundled MediaPipe models from npm…")
    with urllib.request.urlopen(URL, timeout=60) as response:
        payload = response.read(LIMIT + 1)
    if len(payload) > LIMIT:
        raise SystemExit("Download exceeded the expected size limit.")
    if base64.b64encode(hashlib.sha512(payload).digest()).decode() != INTEGRITY:
        raise SystemExit("WebGazer package integrity check failed; nothing installed.")
    count = 0
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as archive:
        for item in archive.getmembers():
            if not item.isfile():
                continue
            if item.name == "package/dist/webgazer.js":
                relative = Path("webgazer.js")
            elif item.name == "package/LICENSE.md":
                relative = Path("WEBGAZER-LICENSE.md")
            elif item.name.startswith("package/dist/mediapipe/face_mesh/"):
                relative = Path(item.name.removeprefix("package/dist/"))
            else:
                continue
            if relative.is_absolute() or ".." in relative.parts:
                raise SystemExit("Unexpected archive path.")
            target = DESTINATION / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            source = archive.extractfile(item)
            assert source is not None
            target.write_bytes(source.read())
            count += 1
    (DESTINATION / "WEBGAZER-VERSION.txt").write_text(
        f"webgazer {VERSION}\nSource: {URL}\nSHA512: {INTEGRITY}\n"
        "License: GPL-3.0-or-later (see WEBGAZER-LICENSE.md)\n"
        "Source repository: https://github.com/brownhci/WebGazer\n",
        encoding="utf-8",
    )
    print(f"Installed {count} verified files to {DESTINATION}")


if __name__ == "__main__":
    main()
