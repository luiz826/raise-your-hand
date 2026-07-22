#!/usr/bin/env bash
# Starts both local voice servers for the extension in one terminal:
#   - Kokoro TTS  (tts/server.py, :8788) — natural spoken answers
#   - Whisper STT (stt/server.py, :8789) — accurate multilingual speech-to-text
# Runs in the uv-managed .venv (see pyproject.toml).
#
#   ./run-voice.sh            # Ctrl-C stops both
# First run downloads the Python deps + models; after that it's instant.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv not found — install it: https://docs.astral.sh/uv/  (brew install uv)" >&2
  exit 1
fi

uv sync --quiet          # make sure the .venv exists and matches pyproject.toml
PY=".venv/bin/python"

"$PY" tts/server.py &
TTS=$!
"$PY" stt/server.py &
STT=$!
trap 'kill "$TTS" "$STT" 2>/dev/null || true' EXIT INT TERM
echo "TTS (pid $TTS, :8788) + STT (pid $STT, :8789) starting… Ctrl-C to stop both."
wait
