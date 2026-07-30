#!/usr/bin/env bash
# Both voice servers now call OpenAI (STT = transcriptions, TTS = speech) — there
# are no local models to fetch, so just run whatever command was passed.
set -e
exec "$@"
