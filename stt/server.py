#!/usr/bin/env python3
"""Speech-to-text server for the Raise Your Hand extension.

Forwards the recorded question to OpenAI's transcription API (gpt-4o-transcribe) —
much better multilingual accuracy (especially Portuguese) than a small local
Whisper, fast, and with no model to host or CPU to burn. The browser records the
spoken question and POSTs the audio here; if this server is down the extension
falls back to the browser's own recognizer, so it stays optional.

Run in the uv-managed environment (see pyproject.toml):

    uv run python stt/server.py       # or ./run-voice.sh to start TTS + STT together

Endpoints (CORS-open so the youtube.com content script can reach it):
    POST /stt?lang=pt   body = audio bytes (webm/opus, wav, …) -> {"text": "..."}
    GET  /health                                               -> {"ok": true}

Env: OPENAI_API_KEY (required), RYH_STT_MODEL (default "gpt-4o-transcribe"),
     OPENAI_BASE_URL (default "https://api.openai.com/v1"),
     RYH_STT_PORT (default 8789), RYH_VOICE_HOST (default 127.0.0.1; 0.0.0.0 in Docker).
"""
import json
import os
import sys
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

API_KEY = os.environ.get("OPENAI_API_KEY", "")
MODEL = os.environ.get("RYH_STT_MODEL", "gpt-4o-transcribe")
BASE = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
PORT = int(os.environ.get("RYH_STT_PORT", "8789"))
HOST = os.environ.get("RYH_VOICE_HOST", "127.0.0.1")  # 0.0.0.0 in Docker so Caddy can reach it
# Drive-by protection: browsers always send Origin on a preflighted POST, so a
# mismatched Origin means another website is spending our STT credits through
# its visitors. (Not an auth check — curl is covered by the Caddy rate limits.)
ALLOWED_ORIGIN = os.environ.get("RYH_ALLOWED_ORIGIN", "https://www.youtube.com")

if not API_KEY:
    sys.stderr.write("WARNING: OPENAI_API_KEY not set — /stt will fail until it is.\n")
print(f"STT ready → POST http://{HOST}:{PORT}/stt  (OpenAI {MODEL})", flush=True)


def _audio_ext(audio: bytes) -> str:
    """Sniff the container from magic bytes so OpenAI gets the right file extension
    (the extension records webm; TTS/tests may send wav/ogg)."""
    head = audio[:4]
    if head == b"RIFF":
        return "wav"
    if head == b"OggS":
        return "ogg"
    if head[:3] == b"ID3" or head[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2", b"\xff\xfa"):
        return "mp3"
    return "webm"  # EBML (webm) or MediaRecorder default


def transcribe(audio: bytes, lang: str | None, hint: str | None = None) -> str:
    """POST the audio to OpenAI /audio/transcriptions as multipart/form-data."""
    boundary = uuid.uuid4().hex
    ext = _audio_ext(audio)

    def field(name: str, value: str) -> bytes:
        return (
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'
        ).encode("utf-8")

    body = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.{ext}"\r\n'
        f"Content-Type: application/octet-stream\r\n\r\n"
    ).encode("utf-8") + audio + b"\r\n"
    body += field("model", MODEL)
    body += field("response_format", "json")
    if lang:
        body += field("language", lang)
    if hint:
        body += field("prompt", hint)  # biases the recognizer toward the expected reply shape
    body += f"--{boundary}--\r\n".encode("utf-8")

    req = urllib.request.Request(
        f"{BASE}/audio/transcriptions",
        data=body,
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:400]
        raise RuntimeError(f"OpenAI {e.code}: {detail}") from e
    return (data.get("text") or "").strip()


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
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/stt"):
            self.send_response(404)
            self._cors()
            self.end_headers()
            return
        origin = self.headers.get("Origin")
        if ALLOWED_ORIGIN != "*" and origin and origin != ALLOWED_ORIGIN:
            self.send_response(403)
            self._cors()
            self.end_headers()
            return
        try:
            lang = (parse_qs(parsed.query).get("lang", [None])[0]) or None
            # ctx=yn: the audio is a short reply to "Any more questions?" — telling the
            # recognizer so sharply improves "no/não" vs. noise mishears.
            ctx = parse_qs(parsed.query).get("ctx", [None])[0]
            hint = (
                "A very short spoken reply to the question 'Any more questions?' — "
                "typically 'no', 'não', 'no more', 'that's all', 'nada', or a short follow-up question."
            ) if ctx == "yn" else None
            n = int(self.headers.get("Content-Length", "0"))
            if n > 25_000_000:  # ~25MB cap — reject oversized/abusive uploads
                self.send_response(413)
                self._cors()
                self.end_headers()
                return
            audio = self.rfile.read(n) if n else b""
            text = transcribe(audio, lang, hint) if audio else ""
            payload = json.dumps({"text": text}).encode("utf-8")
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except BrokenPipeError:
            pass
        except Exception as e:  # noqa: BLE001 — keep the server alive on bad input/upstream errors
            sys.stderr.write(f"stt error: {e}\n")
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
