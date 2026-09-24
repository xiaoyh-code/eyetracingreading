#!/usr/bin/env python3
"""Pinned WebGazer source provenance used by prepare_webgazer.py.

The npm release contains source and source maps but omits webpack.config.js.
Ship both unmodified upstream archives: the exact npm package and the full
repository at its published gitHead, including build configuration and lockfile.
"""
from __future__ import annotations

import hashlib
import io
import json
import tarfile
import urllib.request

VERSION = "3.5.3"
COMMIT = "b12701dd7b6d7b00d4b8dbebf87fdec840c24999"
SOURCE_URL = f"https://codeload.github.com/brownhci/WebGazer/tar.gz/{COMMIT}"
SOURCE_SHA256 = "b1508a1b5b4e1ed3a10e64938fbdb54c046e800ec80a13a6953a9f20397d7982"
SOURCE_NAME = f"source/webgazer-{VERSION}-source.tar.gz"
PACKAGE_NAME = f"source/webgazer-{VERSION}-npm.tgz"
INFO_NAME = "source/WEBGAZER-SOURCE.json"
LIMIT = 100 * 1024 * 1024


def archive_file(archive: tarfile.TarFile, name: str) -> bytes:
    try:
        member = archive.getmember(name)
        if not member.isfile():
            raise ValueError("not a regular archive member")
        source = archive.extractfile(member)
        if source is None:
            raise ValueError("missing archive member data")
        return source.read()
    except (KeyError, ValueError) as error:
        raise SystemExit(f"Verified WebGazer source archive is missing required file: {name}") from error


def source_assets(package_payload: bytes, *, source_payload: bytes | None = None) -> dict[str, bytes]:
    """Verify the untouched archives and return allowlisted public source assets.

    The caller has already verified the npm SHA512. Injection exists only for
    deterministic packaging tests; source SHA256 is checked in every path.
    Archive paths are read in memory and never extracted onto the filesystem.
    """
    if source_payload is None:
        print(f"Downloading complete WebGazer source at {COMMIT}…")
        with urllib.request.urlopen(SOURCE_URL, timeout=90) as response:
            source_payload = response.read(LIMIT + 1)
    if len(source_payload) > LIMIT or hashlib.sha256(source_payload).hexdigest() != SOURCE_SHA256:
        raise SystemExit("WebGazer source archive checksum/size validation failed; source was not installed.")
    prefix = f"WebGazer-{COMMIT}/"
    def normalize(data: bytes) -> bytes:
        return data.replace(b"\r\n", b"\n")
    with tarfile.open(fileobj=io.BytesIO(source_payload), mode="r:gz") as source, \
            tarfile.open(fileobj=io.BytesIO(package_payload), mode="r:gz") as package:
        for name in ["webpack.config.js", "package-lock.json", "package.json", "LICENSE.md", "README.md"]:
            archive_file(source, prefix + name)
        package_json = json.loads(archive_file(source, prefix + "package.json"))
        package_lock = json.loads(archive_file(source, prefix + "package-lock.json"))
        if package_json.get("version") != VERSION or package_lock.get("version") != VERSION:
            raise SystemExit("WebGazer source package/lock version does not match the distributed runtime.")
        if normalize(archive_file(source, prefix + "package.json")) != normalize(archive_file(package, "package/package.json")):
            raise SystemExit("WebGazer repository/package metadata differ beyond line endings.")

        matched = []
        for member in package.getmembers():
            if not member.isfile() or not member.name.startswith("package/src/"):
                continue
            relative = member.name.removeprefix("package/")
            if normalize(archive_file(package, member.name)) != normalize(archive_file(source, prefix + relative)):
                raise SystemExit(f"WebGazer runtime package source mismatch: {relative}")
            matched.append(relative)
        if len(matched) != 26 or "src/index.mjs" not in matched:
            raise SystemExit("WebGazer package source inventory does not match the pinned release.")

        # Also tie source to the map emitted alongside the actual dist bundle,
        # rather than trusting gitHead metadata alone.
        source_map = json.loads(archive_file(package, "package/dist/webgazer.js.map"))
        mapped = []
        if source_map.get("file") != "webgazer.js":
            raise SystemExit("WebGazer runtime source map has an unexpected output name.")
        for name, content in zip(source_map["sources"], source_map["sourcesContent"], strict=True):
            if not name.startswith("webpack://webgazer/./src/"):
                continue
            relative = name.split("/./", 1)[1]
            if normalize(content.encode("utf-8")) != normalize(archive_file(source, prefix + relative)):
                raise SystemExit(f"WebGazer compiled runtime source map mismatch: {relative}")
            mapped.append(relative)
        if len(mapped) != 10 or "src/index.mjs" not in mapped:
            raise SystemExit("WebGazer compiled runtime source map inventory is incomplete.")

    info = {
        "package": f"webgazer@{VERSION}",
        "license": "GPL-3.0-or-later",
        "npm_metadata_url": f"https://registry.npmjs.org/webgazer/{VERSION}",
        "npm_git_head": COMMIT,
        "repository_at_commit": f"https://github.com/brownhci/WebGazer/tree/{COMMIT}",
        "archives": [
            {"file": SOURCE_NAME.split("/", 1)[1], "url": SOURCE_URL,
             "sha256": SOURCE_SHA256, "bytes": len(source_payload)},
            {"file": PACKAGE_NAME.split("/", 1)[1],
             "url": f"https://registry.npmjs.org/webgazer/-/webgazer-{VERSION}.tgz",
             "sha256": hashlib.sha256(package_payload).hexdigest(), "bytes": len(package_payload)},
        ],
        "validation": {"matched_npm_source_files": len(matched), "matched_runtime_map_sources": len(mapped),
                       "comparison": "Exact bytes after CRLF-to-LF normalization; no source modifications."},
        "build": [f"Extract webgazer-{VERSION}-source.tar.gz", f"cd WebGazer-{COMMIT}", "npm ci", "npm run build"],
        "notes": "The full repository includes webpack.config.js and package-lock.json. The exact npm archive additionally preserves the distributed runtime and its dependency-inclusive source maps. Both archives are unmodified.",
    }
    return {SOURCE_NAME: source_payload, PACKAGE_NAME: package_payload,
            INFO_NAME: (json.dumps(info, indent=2) + "\n").encode("utf-8")}


if __name__ == "__main__":
    from prepare_webgazer import main
    main()
