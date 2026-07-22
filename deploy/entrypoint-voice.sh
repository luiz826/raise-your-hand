#!/usr/bin/env bash
# Ensure the Kokoro model files exist (mounted volume, downloaded once), then run
# whatever server command was passed (tts/server.py or stt/server.py). Whisper
# downloads itself on first model load into the mounted HF cache.
set -e
M=/app/tts/models
if [ ! -f "$M/kokoro-v1.0.onnx" ] || [ ! -f "$M/voices-v1.0.bin" ]; then
  echo "downloading Kokoro model files (first run)…"
  mkdir -p "$M"
  curl -fSL -o "$M/kokoro-v1.0.onnx" \
    https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
  curl -fSL -o "$M/voices-v1.0.bin" \
    https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
fi
exec "$@"
