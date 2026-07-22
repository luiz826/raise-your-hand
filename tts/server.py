#!/usr/bin/env python3
"""Local Kokoro neural-TTS server for the Raise Your Hand extension.

The extension's spoken answers sound robotic on the browser's speechSynthesis;
this serves natural Kokoro audio instead. The extension POSTs text here and plays
the returned WAV (falling back to the browser voice if this server is down).

Run it in the uv-managed environment (see pyproject.toml):

    uv run python tts/server.py       # or ./run-voice.sh to start TTS + STT together

Endpoints (CORS-open so the youtube.com content script can reach localhost):
    POST /tts   {"text": "...", "voice": "am_michael"}  -> audio/wav
    GET  /health                                          -> {"ok": true}
"""
import io
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import soundfile as sf
from kokoro_onnx import Kokoro

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.environ.get("RYH_KOKORO_MODEL", os.path.join(HERE, "models", "kokoro-v1.0.onnx"))
VOICES = os.environ.get("RYH_KOKORO_VOICES", os.path.join(HERE, "models", "voices-v1.0.bin"))
PORT = int(os.environ.get("RYH_TTS_PORT", "8788"))
DEFAULT_VOICE = os.environ.get("RYH_TTS_VOICE", "am_michael")

print(f"loading Kokoro model ({MODEL})…", flush=True)
kokoro = Kokoro(MODEL, VOICES)
_lock = threading.Lock()  # espeak phonemizer isn't guaranteed thread-safe
print(f"Kokoro ready → POST http://127.0.0.1:{PORT}/tts  (default voice: {DEFAULT_VOICE})", flush=True)


def synth(text: str, voice: str, lang: str) -> bytes:
    with _lock:
        samples, sample_rate = kokoro.create(text, voice=voice, speed=1.0, lang=lang)
    buf = io.BytesIO()
    sf.write(buf, samples, sample_rate, format="WAV")
    return buf.getvalue()


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
        if not self.path.startswith("/tts"):
            self.send_response(404)
            self._cors()
            self.end_headers()
            return
        try:
            n = int(self.headers.get("Content-Length", "0"))
            if n > 200_000:  # a text request is tiny — reject anything abusive
                self.send_response(413)
                self._cors()
                self.end_headers()
                return
            body = json.loads(self.rfile.read(n) or b"{}")
            text = (body.get("text") or "").strip()[:2000]  # cap synthesis length
            voice = body.get("voice") or DEFAULT_VOICE
            lang = body.get("lang") or "en-us"
            if not text:
                self.send_response(400)
                self._cors()
                self.end_headers()
                return
            wav = synth(text, voice, lang)
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(wav)))
            self.end_headers()
            self.wfile.write(wav)
        except BrokenPipeError:
            pass  # client navigated away / stopped playback mid-stream
        except Exception as e:  # noqa: BLE001 — keep the server alive on bad input
            sys.stderr.write(f"tts error: {e}\n")
            try:
                self.send_response(500)
                self._cors()
                self.end_headers()
            except Exception:
                pass

    def log_message(self, *args):
        pass  # quiet; errors still go to stderr


if __name__ == "__main__":
    try:
        ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nbye", flush=True)
