#!/bin/zsh
set -e
cd -- "$(dirname -- "$0")"
if command -v uv >/dev/null 2>&1; then
  exec uv run python -m reader --open
elif [[ -x .venv/bin/python ]]; then
  exec .venv/bin/python -m reader --open
else
  print "請先按照 README.md 安裝 Python 相依套件。"
  read -r "?按 Enter 關閉…"
fi
