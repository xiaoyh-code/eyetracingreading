#!/usr/bin/env python3
"""Install the pinned WebGazer bundle and every local MediaPipe runtime asset.

Only this explicit setup step downloads anything; reading/camera mode uses local
files. WebGazer is GPL-3.0-or-later; its license is kept beside the bundle.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import tarfile
import urllib.request
from pathlib import Path

from prepare_webgazer_source import COMMIT, SOURCE_SHA256, SOURCE_URL, source_assets

VERSION = "3.5.3"
URL = f"https://registry.npmjs.org/webgazer/-/webgazer-{VERSION}.tgz"
INTEGRITY = "i6P97fWeixASmHWrJxgLUICugqV6qljIafi2ne6p0WYXAuldpwoaFRkedKFcu/qm95d128gdUxhOr336estXOw=="
DESTINATION = Path(__file__).resolve().parents[1] / "reader/static/vendor"
LIMIT = 60 * 1024 * 1024
MANIFEST = "WEBGAZER-MANIFEST.json"


def write_asset(relative: Path, data: bytes) -> dict[str, str]:
    target = DESTINATION / relative
    # Do not follow local symlinks into unrelated files while refreshing known
    # generated assets. Unlisted files in vendor are left untouched.
    for item in (DESTINATION, *[DESTINATION.joinpath(*relative.parts[:index])
                               for index in range(1, len(relative.parts) + 1)]):
        if item.is_symlink():
            raise SystemExit("Unexpected symlink in WebGazer asset path; nothing outside vendor was changed.")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    return {"path": relative.as_posix(), "sha256": hashlib.sha256(data).hexdigest()}


def main() -> None:
    print(f"Downloading WebGazer {VERSION} and bundled MediaPipe models from npm…")
    with urllib.request.urlopen(URL, timeout=60) as response:
        payload = response.read(LIMIT + 1)
    if len(payload) > LIMIT:
        raise SystemExit("Download exceeded the expected size limit.")
    if base64.b64encode(hashlib.sha512(payload).digest()).decode() != INTEGRITY:
        raise SystemExit("WebGazer package integrity check failed; nothing installed.")
    # Validate corresponding source before changing the generated runtime files.
    verified_sources = source_assets(payload)
    files = []
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
            source = archive.extractfile(item)
            assert source is not None
            files.append(write_asset(relative, source.read()))
    required = {"webgazer.js", "WEBGAZER-LICENSE.md"}
    if not required.issubset({item["path"] for item in files}):
        raise SystemExit("Verified WebGazer package is missing required runtime/license files.")
    for name, data in verified_sources.items():
        files.append(write_asset(Path(name), data))
    version_data = (
        f"webgazer {VERSION}\nSource: {URL}\nSHA512: {INTEGRITY}\n"
        "License: GPL-3.0-or-later (see WEBGAZER-LICENSE.md)\n"
        f"Source repository: https://github.com/brownhci/WebGazer/tree/{COMMIT}\n"
        f"Source archive: {SOURCE_URL}\nSource archive SHA256: {SOURCE_SHA256}\n"
        "Complete source and exact npm archive: source/ (see WEBGAZER-SOURCE.json)\n"
    ).encode()
    files.append(write_asset(Path("WEBGAZER-VERSION.txt"), version_data))
    manifest = {"version": VERSION, "package_sha512": INTEGRITY,
                "source_commit": COMMIT, "source_sha256": SOURCE_SHA256,
                "files": sorted(files, key=lambda item: item["path"])}
    write_asset(Path(MANIFEST), (json.dumps(manifest, indent=2) + "\n").encode("utf-8"))
    print(f"Installed {len(files)} verified files and exact release manifest to {DESTINATION}")


if __name__ == "__main__":
    main()
