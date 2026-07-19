# Raise Your Hand 🖐

An AI teaching assistant that turns YouTube university courses into interactive classes — pause the video, ask a question, get a TA-style answer that knows the whole course. Full product plan: [PLAN.md](PLAN.md).

This repo currently contains **step 1 of the build order**: a CLI spike that validates the agent brain (course ingestion → course map → timestamp-aware Q&A) with zero browser work.

## Setup

```sh
npm install
ant auth login        # or: export ANTHROPIC_API_KEY=sk-ant-...
```

## Models & providers

Model choice is split by workload and set via env (each a `provider:model` spec; a bare string means `anthropic:`):

| Env var | Default | Used for |
|---|---|---|
| `RYH_QA_MODEL` | `claude-opus-4-8` | interactive Q&A (server, REPL, eval agent) |
| `RYH_INGEST_MODEL` | `claude-opus-4-8` | offline course-map build |
| `RYH_JUDGE_MODEL` | `claude-opus-4-8` | eval grader |

The app is provider-agnostic (`src/lib/provider.ts`). Supported: `anthropic:` (needs `ANTHROPIC_API_KEY`), and OpenAI-compatible `openai:` / `deepseek:` / `groq:` / `together:` / `fireworks:` / `compat:` (each needs the matching `*_API_KEY` in `.env`; `compat:` also needs `RYH_COMPAT_BASE_URL`). Example — grade DeepSeek against the eval:

```sh
# in .env: DEEPSEEK_API_KEY=sk-...
RYH_QA_MODEL=deepseek:deepseek-chat npm run eval
```

The `.env` in this repo currently pins `RYH_QA_MODEL`/`RYH_INGEST_MODEL` to `claude-haiku-4-5` for cheap dev testing — delete those lines to run on Opus.

## Usage

```sh
# 1. Ingest a course (playlist -> transcripts -> course map). Re-runs reuse cached transcripts.
npm run ingest -- "https://www.youtube.com/playlist?list=PLxxxxxxxx"

# 2. Ask questions, simulating a pause at a timestamp
npm run ask -- PLxxxxxxxx --lecture 3 --time 34:00
```

Inside the REPL: type a question, or `/seek 12:30`, `/lecture 4 [mm:ss]`, `/exit`. Each answer prints token/cache usage so you can watch the caching scheme work.

```sh
npm run smoke        # network-only check: fetch one video's transcript
npm run typecheck
```

## Browser extension (step 2 — dev shell)

Pause a real YouTube lecture and ask in-page, streamed from the local backend.

```sh
npm run server       # starts the backend on http://localhost:8787
```

Then load the extension in Chrome:

1. `chrome://extensions` → enable **Developer mode** (top right).
2. **Load unpacked** → select the `extension/` folder.
3. Open a lecture from an ingested playlist, e.g.
   `https://www.youtube.com/watch?v=Ub3GoFaUcds&list=PLoROMvodv4rOCXd21gf0CF4xr35yINeOy`
4. **Pause** the video → a "🖐 Ask" chip appears (or press **Shift+A**). Ask a question; timestamps in the answer are clickable and seek the player.

For a playlist that isn't prepared yet, the panel shows a **🛠 Prepare this course** button: the extension fetches the playlist's transcripts in-page (on your residential IP, which YouTube doesn't block) and uploads them to `POST /ingest`, which builds the course map on demand (~1 min, capped at 40 videos). Pre-ingested courses under `data/` load instantly.

Each answer has 👍/👎 buttons. Usage is logged to `data/events.jsonl` (anonymous device id, keyed per answer). See the MVP metrics anytime with:

```sh
npm run stats        # follow-up rate, thumbs-up rate, feedback coverage
```

## Layout

- `src/lib/youtube.ts` — playlist/watch-page/timedtext fetching (no API key; mirrors what the extension will do in-page)
- `src/lib/coursemap.ts` — per-lecture concept extraction + course overview (structured outputs)
- `src/lib/context.ts` — Q&A persona + prompt assembly with cache breakpoints
- `src/ingest.ts`, `src/ask.ts` — the two CLIs
- `data/<playlistId>/` — cached transcripts + `coursemap.json` (gitignored)
