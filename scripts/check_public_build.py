"""Fail a public build on secret-like values or unexpected private files; never print values."""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATTERNS = [
    re.compile(rb"\bsk-[A-Za-z0-9_-]{24,}\b"),
    re.compile(rb"\bAKID[A-Za-z0-9]{20,}\b"),
    re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(rb"\b(?:ghp|github_pat)_[A-Za-z0-9_]{25,}\b"),
    re.compile(rb"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
]


def main():
    errors = []
    # Include authored new files before git add, while respecting ignored local
    # environments, credentials and downloaded dependencies. CI sees the same
    # list after those source files have been committed.
    source_names = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=ROOT,
    ).decode().split("\0")
    candidates = [ROOT / name for name in set(source_names) if name and (ROOT / name).is_file()]
    dist = ROOT / "dist"
    if not (dist / "index.html").is_file():
        raise SystemExit("Run npm run build before checking the release.")
    paths = list(dist.rglob("*"))
    for file in paths:
        if file.is_symlink():
            errors.append(f"Unexpected public symlink: {file.relative_to(ROOT)}")
    public = [p for p in paths if p.is_file() and not p.is_symlink()]
    for file in public:
        if any(part in {".git", ".models", ".venv", "node_modules", "uploads", "output"} for part in file.relative_to(dist).parts) or file.name.startswith(".env"):
            errors.append(f"Unexpected private path: {file.relative_to(ROOT)}")
    for file in [*candidates, *public]:
        data = file.read_bytes()
        if any(pattern.search(data) for pattern in PATTERNS):
            errors.append(f"Possible secret: {file.relative_to(ROOT)} (value withheld)")
    html = (dist / "index.html").read_text()
    if 'name="reader-runtime" content="browser"' not in html or 'src="/static/' in html:
        errors.append("Public HTML has the wrong runtime or absolute asset paths.")
    if errors:
        print("\n".join(errors), file=sys.stderr)
        raise SystemExit(1)
    print(f"Checked {len(candidates)} tracked/new source files and {len(public)} public files: no detected secrets/private paths.")


if __name__ == "__main__":
    main()
