# Local speech-to-text (Whisper)

Transcribes the spoken question far more accurately than the browser's Web Speech
API (which routes to Google and is weak for Portuguese and other non-English
languages). The extension records your question, POSTs the audio here, and gets
back text; if this server is down it falls back to the browser recognizer, so
it's optional.

Runs as its own tiny HTTP server (Whisper is Python), sharing the `ryh-tts`
conda env with the Kokoro TTS server.

## One-time setup

Deps are managed with [uv](https://docs.astral.sh/uv/) via the root `pyproject.toml`:

```bash
uv sync        # installs faster-whisper (+ kokoro-onnx, soundfile) into .venv
```

The model downloads automatically on first run (~1.5 GB for the default `medium`) and is cached.

## Run

Both voice servers together (recommended):

```bash
./run-voice.sh          # starts Kokoro TTS (:8788) + Whisper STT (:8789)
```

Or just STT:

```bash
uv run python stt/server.py
```

## Config (env vars)

| var | default | meaning |
|---|---|---|
| `RYH_WHISPER_MODEL` | `medium` | accuracy/speed; `large-v3` is more accurate but slower, `small` is faster/lighter |
| `RYH_WHISPER_COMPUTE` | `int8` | CTranslate2 compute type (`int8` fast on CPU; `float32` most accurate) |
| `RYH_STT_PORT` | `8789` | port (must match `STT_BACKEND` in `extension/content.js`) |

For a faster/lighter run: `RYH_WHISPER_MODEL=small uv run python stt/server.py`

## Endpoints

- `POST /stt?lang=pt` — body = audio bytes (webm/opus from the extension, or wav) → `{"text": "..."}`
- `GET /health` → `{"ok": true}`

The language code comes from the extension's language picker (`pt-BR` → `pt`). Runs
on CPU (CTranslate2 has no Metal backend); for a big speedup on Apple Silicon,
`whisper.cpp` (CoreML) or `mlx-whisper` are future options.
