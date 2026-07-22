# Local neural TTS (Kokoro)

Serves natural-sounding speech to the extension so spoken answers don't use the
browser's robotic `speechSynthesis`. The extension POSTs answer text here and
plays the returned WAV; if this server is down it silently falls back to the
browser voice, so it's optional.

Kokoro is a Python model, so this runs as its own tiny HTTP server (separate
from the Node Q&A backend on `:8787`).

## One-time setup

Python deps are managed with [uv](https://docs.astral.sh/uv/) (see the root
`pyproject.toml`). `kokoro-js` (the Node port) can't build `sharp` on Node 25 and
Piper's prebuilt macOS binary ships broken, so the voice servers stay in Python.

```bash
uv sync                       # creates .venv with kokoro-onnx + faster-whisper + soundfile

# model + voices (gitignored — ~350MB total) into tts/models/
mkdir -p tts/models
curl -L -o tts/models/kokoro-v1.0.onnx https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
curl -L -o tts/models/voices-v1.0.bin  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
```

## Run

```bash
uv run python tts/server.py   # or ./run-voice.sh to start TTS + STT together
# → Kokoro ready → POST http://127.0.0.1:8788/tts  (default voice: am_michael)
```

Then reload the extension and the YouTube page. Spoken answers now use Kokoro.

## Config (env vars)

| var | default | meaning |
|---|---|---|
| `RYH_TTS_PORT` | `8788` | port (must match `TTS_BACKEND` in `extension/content.js`) |
| `RYH_TTS_VOICE` | `am_michael` | default voice when the request omits one |
| `RYH_KOKORO_MODEL` / `RYH_KOKORO_VOICES` | `tts/models/…` | model file paths |

The extension currently pins the voice via `TTS_VOICE` in `extension/content.js`.
Other voices: `af_heart`, `af_bella` (US female), `am_michael`, `am_adam` (US male),
`bf_emma` (UK female), `bm_george` (UK male).

## Endpoints

- `POST /tts` — `{"text": "...", "voice": "am_michael"}` → `audio/wav`
- `GET /health` → `{"ok": true}`
