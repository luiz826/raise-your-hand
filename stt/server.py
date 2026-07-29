#!/usr/bin/env python3
"""Local Whisper speech-to-text server (faster-whisper) for the Raise Your Hand
extension. The browser's Web Speech API (Google) transcribes non-English poorly;
this gives much better multilingual accuracy, fully local.

The extension records the spoken question and POSTs the audio here; if this server
is down it falls back to the browser's recognizer, so it's optional.

Run in the uv-managed environment (see pyproject.toml):

    uv run python stt/server.py       # or ./run-voice.sh to start TTS + STT together

Endpoints (CORS-open so the youtube.com content script can reach localhost):
    POST /stt?lang=pt   body = audio bytes (webm/opus, wav, …) -> {"text": "..."}
    GET  /health                                               -> {"ok": true}

Env: RYH_WHISPER_MODEL (default "small"; try "medium"/"large-v3" for more accuracy),
     RYH_WHISPER_COMPUTE (default "int8"), RYH_STT_PORT (default 8789).
"""
import io
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from faster_whisper import WhisperModel

MODEL = os.environ.get("RYH_WHISPER_MODEL", "small")  # small = much faster on CPU, still good for PT/EN
COMPUTE = os.environ.get("RYH_WHISPER_COMPUTE", "int8")
PORT = int(os.environ.get("RYH_STT_PORT", "8789"))

print(f"loading Whisper model ({MODEL}, {COMPUTE}) — first run downloads it…", flush=True)
model = WhisperModel(MODEL, device="cpu", compute_type=COMPUTE)
_lock = threading.Lock()
print(f"Whisper ready → POST http://127.0.0.1:{PORT}/stt  (model: {MODEL})", flush=True)


def transcribe(audio: bytes, lang: str | None) -> str:
    with _lock:
        # vad_filter trims silence so short clips don't hallucinate filler.
        segments, _info = model.transcribe(
            io.BytesIO(audio),
            language=lang or None,
            vad_filter=True,
            beam_size=1,  # greedy — ~2x faster than beam search, minimal accuracy loss on short clips
        )
        return "".join(s.text for s in segments).strip()


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
        try:
            lang = (parse_qs(parsed.query).get("lang", [None])[0]) or None
            n = int(self.headers.get("Content-Length", "0"))
            if n > 25_000_000:  # ~25MB cap — reject oversized/abusive uploads before decoding
                self.send_response(413)
                self._cors()
                self.end_headers()
                return
            audio = self.rfile.read(n) if n else b""
            text = transcribe(audio, lang) if audio else ""
            payload = json.dumps({"text": text}).encode("utf-8")
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except BrokenPipeError:
            pass
        except Exception as e:  # noqa: BLE001 — keep the server alive on bad input
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
        ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nbye", flush=True)
