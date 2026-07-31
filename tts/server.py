#!/usr/bin/env python3
"""Text-to-speech server for the Raise Your Hand extension.

Forwards text to OpenAI's speech API (gpt-4o-mini-tts) — a natural, fast,
multilingual voice (PT + EN) with no local model to host or CPU to burn. The
extension POSTs a sentence and plays the returned audio.

Run in the uv-managed environment (see pyproject.toml):

    uv run python tts/server.py       # or ./run-voice.sh to start TTS + STT together

Endpoints (CORS-open so the youtube.com content script can reach it):
    POST /tts   body = {"text": "..."}   -> audio bytes (mp3)
    GET  /health                          -> {"ok": true}

Env: OPENAI_API_KEY (required), RYH_TTS_MODEL (default "gpt-4o-mini-tts"),
     RYH_TTS_VOICE (default "alloy"; try onyx/ash/sage/nova/shimmer/echo/fable),
     RYH_TTS_FORMAT (default "mp3"), RYH_TTS_INSTRUCTIONS (optional tone steer),
     OPENAI_BASE_URL, RYH_TTS_PORT (default 8788),
     RYH_VOICE_HOST (default 127.0.0.1; 0.0.0.0 in Docker).
"""
import json
import os
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

API_KEY = os.environ.get("OPENAI_API_KEY", "")
MODEL = os.environ.get("RYH_TTS_MODEL", "gpt-4o-mini-tts")
VOICE = os.environ.get("RYH_TTS_VOICE", "alloy")
FMT = os.environ.get("RYH_TTS_FORMAT", "mp3")
INSTRUCTIONS = os.environ.get(
    "RYH_TTS_INSTRUCTIONS",
    "Speak clearly and warmly, at a natural conversational pace, like a friendly teaching assistant.",
)
BASE = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
PORT = int(os.environ.get("RYH_TTS_PORT", "8788"))
HOST = os.environ.get("RYH_VOICE_HOST", "127.0.0.1")  # 0.0.0.0 in Docker so Caddy can reach it
MIME = {"mp3": "audio/mpeg", "wav": "audio/wav", "opus": "audio/ogg", "aac": "audio/aac", "flac": "audio/flac"}.get(FMT, "audio/mpeg")
VOICES = {"alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse"}  # per-request voice allowlist

if not API_KEY:
    sys.stderr.write("WARNING: OPENAI_API_KEY not set — /tts will fail until it is.\n")
print(f"TTS ready → POST http://{HOST}:{PORT}/tts  (OpenAI {MODEL}, voice {VOICE})", flush=True)


def synth(text: str, voice: str | None = None, speed: float | None = None) -> bytes:
    v = voice if voice in VOICES else VOICE
    # gpt-4o-mini-tts ignores the `speed` param — steer pace via instructions instead.
    instr = INSTRUCTIONS
    if isinstance(speed, (int, float)):
        if speed <= 0.9:
            instr = (instr + " Speak at a slower, deliberate pace.").strip()
        elif speed >= 1.15:
            instr = (instr + " Speak at a brisk, faster pace.").strip()
    payload = {"model": MODEL, "voice": v, "input": text[:4000], "response_format": FMT}
    if instr:
        payload["instructions"] = instr
    req = urllib.request.Request(
        f"{BASE}/audio/speech",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:400]
        raise RuntimeError(f"OpenAI {e.code}: {detail}") from e


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/health"):
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
        else:
            self.send_response(404)
            self._cors()
            self.end_headers()

    def do_POST(self):
        if not urlparse(self.path).path.startswith("/tts"):
            self.send_response(404)
            self._cors()
            self.end_headers()
            return
        try:
            n = int(self.headers.get("Content-Length", "0"))
            if n > 200_000:  # text payload cap
                self.send_response(413)
                self._cors()
                self.end_headers()
                return
            body = json.loads(self.rfile.read(n) or b"{}") if n else {}
            text = (body.get("text") or "").strip()
            if not text:
                self.send_response(400)
                self._cors()
                self.end_headers()
                return
            audio = synth(text, (body.get("voice") or "").strip() or None, body.get("speed"))
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", MIME)
            self.send_header("Content-Length", str(len(audio)))
            self.end_headers()
            self.wfile.write(audio)
        except BrokenPipeError:
            pass
        except Exception as e:  # noqa: BLE001 — keep the server alive on bad input/upstream errors
            sys.stderr.write(f"tts error: {e}\n")
            try:
                self.send_response(500)
                self._cors()
                self.end_headers()
            except Exception:
                pass

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    try:
        ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nbye", flush=True)
