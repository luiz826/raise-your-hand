# Raise Your Hand — Product & Technical Plan

*An AI teaching assistant that turns YouTube university courses into interactive classes.*
*Last updated: 2026-07-18*

## 1. Product

You're watching a Stanford/MIT/Harvard lecture on YouTube. You pause the video (or hit a hotkey, or literally raise your hand) and ask a question out loud or in text. An agent that knows **the whole course** — the playlist, the syllabus, exactly where you are in lecture N — answers like a TA sitting next to you, then the class resumes.

The defining behavior (canonical example): watching a lecture on linear models, the student asks *"is it possible to split non-linear datasets?"* The agent must **not** deliver a lecture on kernels. It answers: *"Yes — linear models alone can't, but you'll see techniques for exactly that (kernels) in lecture 7."* Brief, grounded, forward-referencing the syllabus.

**Core insight:** the moat is not the chat — it's context assembly. Anyone can alt-tab to a chatbot. This agent already knows the course, the lecture, the minute of playback, and what's coming later. Later: exercises after each lecture, midterms/finals from real course materials.

## 2. Competitive landscape

- **YouTube's Gemini "Ask about this video" panel** — single-video scoped (its own suggested prompts: summarize *the video*, quiz on *the video*). No course/playlist model, no progression, no "covered later," Premium-gated, side-panel UX. It **validates demand** and makes single-video Q&A table stakes. Our defensible layer is everything course-shaped.
- **NotebookLM** — accepts YouTube URLs as sources, but is a separate destination app: not in-player, not in-flow, no timestamp/progression awareness.
- **Strategic consequences:**
  1. Backend is **source-agnostic**: course maps/Q&A/assessment key on "a course" that happens to have YouTube IDs today. MIT OCW, lecture archives, recorded Zoom later. This is the hedge against Google extending Gemini to playlists.
  2. Exploit player control (extension-only): answers with **seekable timestamps**, "let me take you back to 14:20."

## 3. Architecture decisions (with rationale)

| # | Decision | Rationale / revisit when |
|---|---|---|
| 1 | **Transcripts: YouTube auto-captions first, fetched client-side** (extension, or dev machine for the spike — residential IPs avoid the datacenter-IP blocks on timedtext endpoints). ASR (Whisper-class, $0.04–0.40/hr) only for caption-less videos. LLM cleanup pass per lecture fixes garbled math terms. | Official `captions.download` needs video-owner OAuth — dead end. Revisit if YouTube hardens client-side access. |
| 2 | **Context: hierarchical, no RAG.** Raw transcript of current lecture up to timestamp t (~15k tokens) + LLM-built **course map** (per-lecture concept lists w/ timestamps, ~5–10k) + persona ≈ 25–35k token prompt. | A 25-lecture course is 300–500k tokens; "is X covered later?" needs the concept index, not verbatim text. RAG only when ingesting textbooks/notes. |
| 3 | **Prompt caching with append-only prefix.** Transcript-so-far chunked into ~5-min blocks, prefix extended only at block boundaries (prefix-match caching survives); tail minutes ride in the user message. 1h TTL (pause sessions are sporadic). | Cache reads = 10% input price, much better TTFT. |
| 4 | **Models:** ingestion/course-map/exams offline via **Batches API** (50% off) on Opus 4.8 or Sonnet 5; interactive Q&A on Opus 4.8 quality ceiling first, then A/B Sonnet 5 / Haiku 4.5 for TTFT/cost. | ~$0.01/question cached; ~$1–3 one-time per course, shared by all users. Pre-ingesting ~100 flagship courses ≈ a few hundred dollars. |
| 5 | **Voice: cascade** (streaming STT ~300ms → LLM TTFT ~500ms w/ cached prefix → streaming TTS ~150ms ≈ ~1s to first audio), not realtime speech-to-speech. | S2S is faster (~500–800ms) but marries the brain to that provider and makes 30k-token context injection clunky. Revisit only if ~1s proves fatal. Text-first for MVP regardless. |
| 6 | **Trigger UX:** on pause, show a subtle "🖐 Ask" chip + global hotkey. Never auto-open the mic. Webcam hand-raise (MediaPipe) = launch-video demo behind a flag. | Pause ≠ question (coffee exists). |
| 7 | **Visual questions:** `chrome.tabs.captureVisibleTab` frame attached to the question (board/slides never appear in transcripts). ~$0.005/question extra. | Canvas capture of the video element is CORS-tainted; tab capture isn't. |
| 8 | **Thin backend from day one** (key custody, streaming proxy, ingestion jobs, per-playlist shared cache, rate limits). BYO-key client-only mode is fine for personal use, not a product. | API keys can't ship inside an extension. |
| 9 | **Description → course-site enrichment.** Parse playlist/video descriptions for URLs, LLM-classify (course site vs sponsor noise), fetch syllabus page text into the course map. v1.1: crawl problem-set/past-exam PDFs → real exam material. | Lecture descriptions routinely link the official course site. |

**Known risks:** YouTube ToS gray zone on caption fetching (worse for ASR audio); server-side transcript caching is the piece to get legal eyes on before scale; YouTube DOM churn breaking the extension (`yt-navigate-finish`, re-renders); auto-caption quality on math.

## 4. Problem decomposition

- **A. Course ingestion** — playlist/video identification; timestamped transcripts; course-map build (per-lecture concepts w/ timestamps — this powers "covered later"); description→course-site enrichment; per-playlist cache shared across users.
- **B. Player integration** — MV3 content script (currentTime, pause/play, SPA-navigation survival); trigger UX; shadow-DOM overlay vs side panel; later: frame capture, webcam hand-raise.
- **C. Agent brain** — context assembly at question time; persona/brevity control (≤3 sentences, forward references, professor's notation, "explain more" escalation); follow-up state; eval set of (course, timestamp, question) triples.
- **D. Voice loop** — streaming STT, streaming TTS, turn-taking, ~1s budget.
- **E. Assessment** — grounded post-lecture quizzes; LLM grading with timestamp-cited feedback; midterms/finals (real past exams where public); progress persistence.
- **F. Platform** — backend, auth (Google OAuth), cost controls, ToS posture.

## 5. MVP

**Hypothesis to validate:** *while watching a real lecture, people pause to ask questions in place, and a course-aware ≤3-sentence answer beats alt-tabbing to a chatbot.*

**In:** MV3 extension (overlay, pause chip + hotkey, **text** chat, streamed answers, thumbs up/down, answers with clickable **seekable timestamps**, ask-in-your-own-language); thin backend (client-side caption fetch → server processing, course map build, per-playlist cache, streaming Q&A w/ caching, anonymous device ID + rate limits); ~10 pre-ingested flagship courses + JIT ingestion for any captioned playlist; frame capture if the week has room.

**Out (explicitly):** voice in/out, webcam hand-raise, quizzes/exams (quiz is v1.1 — reuses ingestion artifacts), cross-lecture personal memory, textbook RAG, accounts, non-Chrome browsers.

**Metrics:** ≥1 question / 20 min watched; ≥30% follow-up rate; ≥70% thumbs-up; forward-reference correctness on the eval set.

**Build order** (each step demoable; step 1 is the go/no-go gate):
1. **CLI spike** *(current step — lives in this repo)*: playlist URL → transcripts → course map JSON → REPL Q&A with simulated timestamp. Validates the entire brain with zero browser work. If answers aren't clearly better than vanilla chatbot answers here, stop and fix.
2. Extension shell: overlay + currentTime + pause chip, streaming from local backend.
3. Ingestion service + shared cache + block-boundary caching.
4. Persona tuning against 30–50 eval questions across two contrasting courses (one mathy, one not).
5. Polish → Chrome Web Store unlisted → watch metrics.

## 5b. Model strategy & cost (decided 2026-07-19)

**Provider-agnostic model adapter — BUILT (2026-07-19).** The app is decoupled from the Anthropic SDK; every model call goes through `LLMProvider` (`src/lib/provider-types.ts`): `streamText()` for interactive Q&A, `completeStructured()` for ingestion/judging. Prompts are built as neutral `PromptSegment[]` (role + text + `cacheable` hint); each provider realizes caching its own way. `src/lib/provider.ts` `resolveModel("provider:model")` is the factory (bare strings default to `anthropic`). Implemented: **AnthropicProvider** (`providers/anthropic.ts`, fully tested — server /ask + eval both green; segment→block translation preserves cache breakpoints) and **OpenAICompatProvider** (`providers/openai-compat.ts`, raw fetch, one class covers `openai:`/`deepseek:`/`groq:`/`together:`/`fireworks:`/`compat:` — built and factory-tested, not yet run against a live key). Gemini throws a clear "not implemented — add gemini.ts". The Anthropic SDK is now imported in exactly one file. To use a cheap cross-provider model: set its API key in `.env` (e.g. `DEEPSEEK_API_KEY`) and `RYH_QA_MODEL=deepseek:deepseek-chat`. **The eval is now a provider-neutral price/quality dyno** — `RYH_QA_MODEL=<spec> npm run eval` grades any model against the 38 cases.

**Cheap-tier models to eval (2026-07-19):** run the 38-case eval against **DeepSeek** (`deepseek:deepseek-chat`), **GLM 5.2** (Zhipu — `zhipu:glm-5.2` via the `zhipu:` alias, verify base URL/model string), and **Kimi 3** (Moonshot — `moonshot:kimi-3` via the `moonshot:` alias) to find the cheapest that clears the persona bar. All are OpenAI-compatible → slot into `OpenAICompatProvider`; each needs its `*_API_KEY` in `.env`. `RYH_QA_MODEL=<spec> npm run eval` gives the score in ~$1.

**Dev-phase decision:** while testing the *system* (not judging answer quality), run a cheap model — set `RYH_QA_MODEL`/`RYH_INGEST_MODEL=claude-haiku-4-5` in `.env` (code default stays Opus 4.8, the persona-validated production intent). ~$20 was spent on 2026-07-19, **eval-dominated** (judge=Opus, ~5 full 38-case runs) — so the biggest cost lever is still eval discipline (sparse full runs), not the Q&A model.

**Current pricing snapshot (mid-2026, $/1M in/out — verify before committing):**
- Anthropic: Opus 4.8 $5/$25 (cache-read $0.50); Haiku 4.5 $1/$5 (cache-read $0.10).
- OpenAI: GPT-5.4 $2.50/$15, GPT-5 mini $0.125/$1, GPT-5 nano $0.05/$0.40 (auto prefix cache 75–90% off; Batch 50% off).
- Google: Gemini 3.1 Pro $2/$12; 3.5 Flash $1.50/$9; **2.5 Flash-Lite $0.10/$0.40** (context cache up to 90% off; Batch 50% off).
- Open (via providers): **DeepSeek V3.2 $0.14/$0.28** (cheapest strong general model); Qwen 3.6 Plus ~$0.50/$3; Llama 3.3 70B ~$0.59–0.88 flat. **Groq** runs these at 500+ tok/s (Llama 8B $0.05 in) — the speed play for the fluid/voice phase; self-host vLLM = free prefix caching.
- Rough per-cached-follow-up on our ~32k-token prefix: Opus ~$0.02, Haiku ~$0.004, Gemini Flash-Lite / GPT-5 nano / DeepSeek ~$0.0004–0.001 (**~20–50× cheaper than Opus**). Caveat: all weaker than Opus on restraint/grounding — eval-gate before productionizing (Sonnet 5 already regressed 37→26/38).

## 5c. MVP status (2026-07-19)

**Done:** CLI spike (ingest → course map → REPL); eval set (38 cases) + persona validated 37/38 on Opus; extension shell (overlay, pause chip, Shift+A, streamed answers, seekable timestamps, ask-in-your-language), dogfooded in real Chrome; backend (course lookup, streaming Q&A, per-playlist cache, prompt-cache scheme); provider adapter (bonus). 2 courses ingested (CME295, 3b1b).

**Missing to finish the MVP** (ordered by priority against the hypothesis "real users pause to ask, and course-aware answers beat a chatbot"):
1. ~~**Thumbs up/down + event telemetry**~~ — **DONE (2026-07-19).** Append-only JSONL log (`src/lib/events.ts` → `data/events.jsonl`); `/ask` logs an `ask` event (question, answer, context, usage, anonymous device id, sessionId, turnIndex) and returns an `answerId`; new `/feedback` endpoint records 👍/👎 keyed to the answerId; extension renders a thumbs row under each answer (anonymous device id via `chrome.storage.local`, `storage` permission added). `npm run stats` computes follow-up rate and thumbs-up rate against their targets. Verified backend end-to-end. **Still missing:** watch-time tracking (for the "≥1 Q/20min" metric — needs playback heartbeats), and the privacy disclosure for a real deploy (ask events store question+answer text).
2. ~~**Client-side caption fetch + JIT ingestion**~~ — **DONE (2026-07-19).** The extension fetches the playlist list + every transcript **in-page** (InnerTube ANDROID client — verified in-browser: the watch page's own caption URLs return empty even from the browser session, but the ANDROID player endpoint returns full captions on the user's residential IP), uploads them to the new streaming **`POST /ingest`** endpoint, and the backend builds + persists the course map on demand (NDJSON progress). A "🛠 Prepare this course" button appears in the panel for any un-prepared playlist; the pipeline was proven end-to-end on a fresh course (Essence of linear algebra: client fetch → upload → 3-lecture map built + description-enrichment found the course site → immediately queryable via `/ask`). Backend caps at 40 videos. **Still to verify:** the actual extension "Prepare" button/progress UI in a real reload (the underlying pipeline is proven via injection; the UI wiring is written + syntax-checked). Hardening (abuse/cost limits on the open `/ingest`) rolls into gap #3.
3. ~~**Backend hardening + hosting**~~ — **DONE (2026-07-19).** Anonymous device id (gap #1) + per-device rate limits on `/ask` (30/min) and `/ingest` (5/hr) with a global ingest-concurrency cap, request body-size caps, configurable CORS (`RYH_ALLOWED_ORIGIN`), and localhost-by-default binding (`HOST`) — all env-tunable (`src/lib/guard.ts`). **Deploy-ready** (not deployed — needs host creds + is outward-facing): `Dockerfile` + `.dockerignore` + full deploy guide in `SHIP.md`. *I can't deploy it for you; that's your host + your call.*
4. ~~**Ship prep**~~ — **DONE (2026-07-19).** Real PNG icons (16/48/128, a white raised hand on the brand square, generated by `npm run icons` — committed script, no image dep), polished `manifest.json` (v0.2.0, icons + toolbar action + real description), `PRIVACY.md` (Web-Store-ready data disclosure for the transcript-upload + question-logging), `npm run pack:ext` → uploadable zip, and `SHIP.md` (backend deploy + extension repoint + store-listing steps). **Deferred:** ~10 pre-ingested flagship courses (JIT now covers any course, so this is a first-run nicety, not a blocker).

**Not gaps (explicitly deferred):** voice, webcam hand-raise, quizzes/exams, accounts, cross-lecture memory, RAG, frame-capture visual questions.

**MVP status: functionally complete.** All four gaps closed in code; remaining before a public launch is operational (actually deploying the backend, recording store screenshots, and the pre-launch items in SHIP.md §4).

## 5d. Immersive features — built ahead of schedule (2026-07-20, user request: before deployment)

- **Watch-time heartbeats** — extension posts a `/heartbeat` every 30s while a prepared course plays; `npm run stats` now computes the last metric, **questions per 20 min watched** (≥1 target). Verified end-to-end.
- **Voice** — mic button in the panel: speech-to-text in (Web Speech `SpeechRecognition`), the answer spoken back (`speechSynthesis`) when the question came in by voice. Zero server, zero API key (browser-native; Chrome's STT routes audio to Google). Never auto-opens the mic. **Built + syntax-clean; the mic/audio itself needs a real device — user verifies on reload.** Production upgrade path (cascade STT/TTS with Deepgram/Cartesia for quality + full context control) is still the plan for later; this is the free demo-grade version.
- **Computer vision (visual questions)** — 📷 toggle captures the visible tab frame via a new background service worker (`captureVisibleTab`; content scripts can't, and the cross-origin `<video>` taints a canvas), attaches it to `/ask`. The adapter now carries images on a neutral `PromptSegment` (`imageBase64`) → Anthropic image block / OpenAI `image_url`. **Adapter + backend verified via curl (model correctly described an attached image); the tab-capture half needs the reloaded extension — user verifies.** Added manifest `background` worker + `*://www.youtube.com/*` host permission (needed for capture; Chrome will prompt on reload).

**Product reframe (2026-07-20, user): VOICE-FIRST.** Voice is the main feature, text chat optional; the differentiator + entry is "raise your hand → speak → hear the answer." Two follow-ups landed:
- **Voice → continuous dictation** — was single-utterance (cut off after one phrase); now `continuous: true` + interim preview, so you talk as long as you want and it sends on a ~3s pause or the ⏹ button. (The earlier "computer vision" I built was the 📷 board-screenshot — a bonus, *not* what the user meant by it.)
- **Webcam hand-raise (the real "computer vision")** — MediaPipe hand-tracking runs in the content script (dynamic-imported from bundled `extension/vendor/` — library + WASM + `hand_landmarker.task`, ~19MB, gitignored behind `npm run fetch:mediapipe`, `web_accessible_resources` exposes them). A ✋ toggle in the panel opens the camera (opt-in, a mirrored preview floats bottom-left as the on-indicator); raising an open hand pauses the video, opens the panel, and starts voice capture → full hands-free loop (raise → speak → spoken answer). **Verified: assets valid + bundle exports match the code. NOT verified: the live webcam + gesture detection — needs the reloaded extension + a camera (user tests).** Detection heuristic: ≥3 fingertips well above the wrist, 4s re-arm debounce.

## 5e. Voice-first hardening + future investigations (2026-07-20)

**Landed since the reframe (syntax-clean; user dogfooding in Chrome):**
- **Hand-raise moved to an offscreen document.** A content script's isolated world can't load MediaPipe's WASM engine (the extension CSP blocks the `eval` workaround → `EvalError`). The webcam + `HandLandmarker` now run in `extension/offscreen.{html,js}` (single JS world, `extension_pages` CSP with `wasm-unsafe-eval`); `background.js` owns the offscreen lifecycle and relays gesture messages (offscreen ↔ content can't talk directly); content just starts/stops it. Camera permission is primed once via a visible `permission.html` (offscreen can't show a prompt, and the youtube.com grant doesn't cover the extension origin). Detection tuned: 640×480, confidences 0.3, 120 ms loop, ≥2 fingertips above wrist; a `ryh-gesture-debug` channel logs detector stats to the page console.
- **Follow-up loop (no LLM).** After a spoken answer the agent says + shows "Any other questions?", listens, and either answers again or **resumes the video** on a "no"/"thanks"/silence (~7 s). Voice turns only; typed Q&A untouched.
- **Detection suspended during a turn** so mid-answer hand movement can't re-trigger; resumes (fresh down→up required) when the video resumes / panel closes. `gestureTabId` persisted in `chrome.storage.session` so the ~30 s MV3 worker termination mid-turn doesn't break the offscreen→content relay.
- **TTS chunking.** Chrome's `speechSynthesis` clips after ~15 s / ~200 chars; answers now speak as ≤130-char sentence chunks back-to-back (run-ons hard-wrapped), token-guarded so stopping/replacing never truncates or double-fires.

**To investigate later (raised by user 2026-07-20):**

1. **Less-robotic voice.** `speechSynthesis` uses the OS's built-in voices (robotic, plus the 15 s-cutoff we're working around). Options, cheapest→best:
   - *Better local voice* — enumerate `speechSynthesis.getVoices()`, prefer known-good neural ones (macOS "Ava (Enhanced)", "Google US English"); let the user pick. Free, still zero-key/zero-server.
   - *Local neural TTS* — **Piper** or **Kokoro** (open-weight; in-browser via WASM/WebGPU or a tiny local server). Free, private, far more natural, no 15 s bug. Best free upgrade — try first.
   - *Cloud neural TTS* — ElevenLabs / Cartesia / OpenAI `tts-1` / Deepgram Aura / Azure Neural: most natural + streaming (~150 ms first audio), but needs a key, per-char cost, and a backend proxy (never put the key in the extension). This is the "cascade TTS" already noted at §3 row 5 / §5d for the production voice loop.
   - Decision driver: stay zero-key/zero-server (local) vs. accept backend + cost for top quality (cloud).
   - **Tried (2026-07-21):** **Kokoro** via **conda py3.11 + `kokoro-onnx`** works and is verified (13.8s WAV in 3.9s on CPU; samples in scratchpad `tts-kokoro-py/`, voices af_heart/af_bella/am_michael/bf_emma). Sounds far more natural than `speechSynthesis`. Two dead ends on this machine: **kokoro-js** (Node) won't install — transformers.js pulls `sharp`, which has no prebuilt for Node 25 and fails to build from source; and the **Piper prebuilt macOS binary is broken** (ships the `.dSYM` but not the actual `libonnxruntime`/`libespeak-ng` dylibs → dyld load error). So the integration path is a small local TTS server (Kokoro in the py3.11 env) that the extension fetches WAV/PCM from, replacing `speak()`.
   - **Integrated (2026-07-21, voice `am_michael`):** `tts/server.py` (stdlib http.server, CORS-open, `POST /tts`→WAV, `GET /health`) serves Kokoro on `:8788`; run it with `~/miniconda3/envs/ryh-tts/bin/python tts/server.py` (see `tts/README.md`). `extension/content.js` `speak()` now fetches Kokoro audio and plays it via an `Audio` element, **falling back to the chunked browser `speakBrowser()` if the server is down** — so TTS is an optional local dependency. Verified at the HTTP layer (preflight + cross-origin POST + WAV); in-browser playback is the user's dogfood check. Model files live in gitignored `tts/models/`. Voice is pinned via `TTS_VOICE` in content.js — revisit later (cloud TTS for production, since a local Python server won't ship to end users).
   - **Streaming + multilingual (2026-07-21):** `speak()` now **streams** — synthesizes one sentence per `/tts` request and prefetches the next while the current plays, so first audio starts after ~1 sentence, not the whole answer. A **language picker** (EN/PT/ES/FR/IT) sits by the mic (persisted in `chrome.storage.local`, defaults from `navigator.language`) and drives three things at once: `SpeechRecognition.lang` (fixes STT transcribing everything as English — the reported bug), the Kokoro voice+`lang` per request (e.g. `pm_alex`/`pt-br` for Portuguese; `server.py` now takes `lang`), and the localized follow-up prompt + "no" regex (`LANGS` table in content.js). Kokoro ships BR-Portuguese voices (`pf_dora`, `pm_alex`, `pm_santa`); verified `lang=pt-br` synthesis end-to-end.
   - **Answer-language forcing (2026-07-21):** picking a language now also forces the *answer text* into it, not just STT/TTS. The extension sends `answerLanguage` (e.g. "Brazilian Portuguese") on `/ask`; `assembleSegments` appends a `RESPOND IN …` system directive **after** the cached course map (cache-safe), and persona line now defers to it. Fixes the report that speaking Portuguese produced an English answer — a partly-English transcription no longer drags the reply to English. Verified live: an English-worded question with `answerLanguage=Brazilian Portuguese` answered fully in PT (Haiku). Persona wording changed → re-run the 38-case eval before trusting scores (default/no-directive path is unchanged, so low risk).
   - **Screenshot always-on (2026-07-21):** removed the 📷 toggle; the extension now auto-captures the paused frame **once per pause session** (grabbed in `onHandRaised` *before* the panel opens, so the overlay isn't in the shot; `sessionFrame` cached, cleared on session reset) and attaches it to every question. `attachScreen`/`camBtn` gone.
   - **Whisper STT built (2026-07-21):** replaced the browser recognizer (Google, weak for PT) with a local **faster-whisper** server (`stt/server.py`, `:8789`, `POST /stt?lang=pt` → `{text}`, CORS-open). The extension now **records** the question (`MediaRecorder` webm/opus) with a Web-Audio **VAD** (auto-send ~2.2 s after speech, 7 s no-speech give-up, 30 s cap, ⏹ to send now), POSTs the audio, and transcribes; **falls back to Web Speech** when the server is down (`toggleDictation` health-gates the choice; `finishDictation` shared). Language comes from the picker (`pt-BR`→`pt`). Default model `medium` (env `RYH_WHISPER_MODEL`; `large-v3` better, `small` faster). Validated mic-free by round-tripping Kokoro-synthesized PT/EN audio (WAV **and** webm/opus) → exact transcripts. `run-voice.sh` starts TTS+STT together. CPU-only (CTranslate2 has no Metal); whisper.cpp/mlx-whisper are future speedups. Now three local servers: Node `:8787`, TTS `:8788`, STT `:8789`.

2. **Using open-source / open-weight models — the "how".** The provider adapter (§5b) already speaks OpenAI-compatible, so OSS models drop in via env vars — two paths:
   - **Hosted (easiest, no infra):** a provider serves the open weights behind an OpenAI-compatible API. Get a key → put it in `.env` → point `RYH_QA_MODEL` at it. e.g. `deepseek:deepseek-chat`, or Together/Fireworks/Groq/OpenRouter for Llama/Qwen/GLM/Kimi (use the `compat:` provider + base URL where there's no alias). `RYH_QA_MODEL=<spec> npm run eval` scores it on the 38 cases for ~$1. **This is exactly the blocked cheap-model eval (§5b) — it only needs the keys.**
   - **Local (free + private, needs a capable machine/GPU):** run the weights yourself with **Ollama** (`ollama run llama3.3` → OpenAI-compatible endpoint at `http://localhost:11434/v1`, no real key) or **vLLM** (`http://localhost:8000/v1`, gives free prefix caching — matters for our ~32 k-token cached prefix). **Already supported, no code change:** the `compat:` provider reads `RYH_COMPAT_BASE_URL` + `RYH_COMPAT_API_KEY` (provider.ts:40). e.g. `RYH_COMPAT_BASE_URL=http://localhost:11434/v1 RYH_COMPAT_API_KEY=ollama RYH_QA_MODEL=compat:llama3.3 npm run eval` (Ollama ignores the key but the env var must be non-empty).
   - Either way it's the same neutral `PromptSegment` path; the real work is per-provider cache semantics + **eval-gating quality before shipping** (weaker models already regressed — Sonnet 5 went 37→26/38).
   - **Evaled Kimi K3 (2026-07-21):** `RYH_QA_MODEL=moonshot:kimi-k3 npm run eval` → **36/38** (vs Opus 37/38) — passes the persona bar. Fails: `esc-grpo` (turn-2 answer came back **empty** on a deep escalation — likely a thinking/`reasoning_content` extraction gap in `OpenAICompatProvider` for K3, worth a look) and one `misconception`. Cost note corrected: Moonshot **auto-caches** — the full run showed `cache-read 307968` on the agent side ($0.30/MTok cache-hit), so K3 ($3/$15 fresh) is more cost-viable than the smoke implied (~$1 agent-side for 38 cases). Cheaper Kimi = K2.6 ($0.95/$4). GLM 5.2 still pending a Zhipu key.

## 6. Feature backlog (moat-reinforcing, post-MVP)

- **"I'm lost" recovery** — trace the dependency via course map: "this leans on the kernel trick, lecture 6 @ 31:00 — recap or jump back?"
- **Personal course notebook** — your Q&A auto-organized per lecture; Markdown/Anki export; your questions map your weak spots → smarter quizzes.
- **Community question layer** — "3 people asked here"; doubles as an answer cache (popular courses ≈ free + instant) and a proprietary where-students-get-confused dataset.
- **Socratic checkpoints (opt-in)** — the agent asks *you* questions at natural breaks; active recall.
- **Prerequisite check** — quiz before lecture 1; failed items link to lectures elsewhere that cover them.
- **Notation fidelity** — answer in *this professor's* notation.
- **Exam mode** — timed midterms/finals from real past exams; grading rubrics; feedback pointing to lecture timestamps.

## 7. Repo status

- `PLAN.md` — this document.
- `src/` — TypeScript: `ingest.ts` (playlist → transcripts → course map), `ask.ts` (REPL Q&A), `eval.ts` (persona eval with LLM judge), `server.ts` (extension backend), `lib/` (YouTube fetching, course-map build, prompt assembly, shared Q&A turn/message assembly). See `README.md` for usage.
- `extension/` — step-2 MV3 Chrome extension (dev shell): `manifest.json`, `content.js` (shadow-DOM overlay, pause chip, Shift+A hotkey, NDJSON streaming, clickable timestamps that seek the player), `content.css`.
- `eval/` — curated case files (`cases.cme295.json` 29 cases, `cases.3b1b.json` 9), grounded in the real course maps. `data/`, `eval-results/` — gitignored artifacts.

### Step 2 — extension shell (built 2026-07-19)
Content script reads the paused `<video>` + `?v=`/`&list=` from the URL, POSTs `{playlistId, videoId, currentTimeSeconds, question, history}` to the thin Node backend (`src/server.ts`), which resolves videoId→lecture from the ingested course map and streams the same proven agent answer as NDJSON. Stateless per request; the cached session block (per lecture+pause) does the token work — `assembleMessages()` in `src/lib/agent.ts` is shared with the REPL/eval so prompts and cache keys are identical. Backend verified end-to-end: `/health`, `/course` (metadata + readiness), error paths (un-ingested course, video-not-in-course), and a live `/ask` that resolved Ub3GoFaUcds@600s → Lecture 1 and streamed a correct forward-reference ("RAG is covered in lecture 7"). Extension load: `chrome://extensions` → Developer mode → Load unpacked → `extension/`.

**DOGFOODED IN A REAL BROWSER (2026-07-19)** via content-script injection on the live CME295 lecture 1 page (Chrome automation; the tool bypasses YouTube's Trusted Types the same way a real content script's isolated world does). Every step passed: DOM contract (video selector, currentTime, `?v=`/`&list=`); the localhost fetch works from the youtube.com page (no CSP block — the big risk); shadow-DOM overlay renders cleanly over YouTube; pause→chip→panel; header resolved "Lecture 1 · paused at 0:37"; a forward-ref question streamed the correct "covered in lecture 6" answer in ~1.2s; a backward-ref question cited **1:32:57**, rendered it as a clickable link, and **clicking it seeked the player to exactly 5577s + played + closed the panel**. No bugs found. Next: cross-lecture timestamp seeking (currently seeks current video only), JIT ingestion for un-prepared playlists, thumbs up/down telemetry.

### Eval set (built 2026-07-19)
38 (lecture, timestamp, question) cases across two contrasting courses (CME295 mathy/dense, 3b1b conceptual), covering: forward reference (spoiler control), same-lecture-later, backward reference (timestamp accuracy), grounding, misconception correction, out-of-scope, logistics (from the real syllabus), multilingual (PT/ES), and two-turn escalation. Judged by an LLM against a 6-criterion persona contract (scope, reference, brevity, grounding, language, tone). **Result: 37/37 on cases that ran** (final run's 38th case errored on API credit exhaustion, not behavior — it passed in the prior targeted re-run).

First run was 28/34 with 4 judge-truncation errors; the 6 genuine failures drove persona/harness fixes (all in `src/lib/context.ts`, `src/lib/agent.ts`, `src/eval.ts`):
- turn-1 question mislabeled as context after a long transcript → explicit "The student asks:" wrapper
- spoiler leak when correcting misconceptions → no-spoilers rule
- fabricated timestamps / invented professor recommendations → attribute-only-what's-in-transcript rule
- material seconds before the pause labeled "coming up" → explicit `[VIDEO PAUSED HERE]` transcript marker
- Opus 4.8 defaulting to bold/bullets/headers in short answers → plain-prose rule (structure only on explicit escalation)
- judge truncating at max_tokens (adaptive thinking ate the 2048 budget) → raised to 8192 + stop_reason guard; judge now gets the full watched transcript to verify citations

Spike language is TypeScript so ingestion/prompt-assembly code lifts directly into the future backend, and the caption-fetch logic mirrors what the extension will do in-page.
