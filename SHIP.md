# Shipping Raise Your Hand

The MVP has two deployable parts: the **backend** (hosted) and the **extension**
(Chrome Web Store). The extension fetches transcripts on the user's residential
IP and uploads them; the backend builds course maps and answers questions.

## 1. Deploy the backend

The backend is a single Node process (see `Dockerfile`). It needs an Anthropic
API key and a writable `data/` volume (for course maps + telemetry).

```sh
docker build -t ryh-backend .
docker run -d --name ryh-backend \
  -p 8787:8787 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e HOST=0.0.0.0 \
  -e RYH_ALLOWED_ORIGIN='chrome-extension://<your-extension-id>' \
  -e RYH_QA_MODEL=claude-opus-4-8 \
  -e RYH_INGEST_MODEL=claude-opus-4-8 \
  -v ryh-data:/app/data \
  ryh-backend
```

Put it behind HTTPS (a reverse proxy / platform TLS) — Chrome will only let the
extension call an `https://` backend once it's not `localhost`. Health check:
`GET /health`.

### Backend config (env vars)

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | Listen port |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` to expose) |
| `ANTHROPIC_API_KEY` | — | Required (or another provider's key — see README) |
| `RYH_QA_MODEL` | `claude-opus-4-8` | Interactive Q&A model (`provider:model`) |
| `RYH_INGEST_MODEL` | `claude-opus-4-8` | Course-map build model |
| `RYH_ALLOWED_ORIGIN` | `*` | CORS origin — set to the extension origin |
| `RYH_ASK_PER_MIN` | `30` | Per-device question rate limit |
| `RYH_INGEST_PER_HOUR` | `5` | Per-device course-prep rate limit |
| `RYH_MAX_INGESTS` | `2` | Global concurrent course builds |

> **Cost note:** `/ingest` triggers LLM course-map builds (~$0.30–$1.75 per
> course depending on model). Rate limits + the 40-video cap bound this, but for
> a public deployment add auth or a per-user budget before opening it wide.

## 2. Point the extension at the backend

Two edits, then the extension talks to your hosted backend instead of localhost:

1. `extension/content.js` — set `const BACKEND = "https://your-backend.example.com";`
2. `extension/manifest.json` — set `"host_permissions": ["https://your-backend.example.com/*"]`

## 3. Package and publish

```sh
npm run icons     # regenerate icons if you changed the design
npm run pack:ext  # -> raise-your-hand-extension.zip
```

Chrome Web Store ([developer dashboard](https://chrome.google.com/webstore/devconsole)):

1. Create a new item, upload `raise-your-hand-extension.zip`.
2. Store listing: use `icon128.png` as the store icon; write the description
   (the manifest `description` is a good start); add screenshots (record the
   pause → ask → answer flow).
3. Privacy: host `PRIVACY.md` at a public URL and link it; fill the data-use
   disclosures — the extension collects *user activity* (questions) and *web
   content* (transcripts) tied to an anonymous ID; it does **not** collect PII.
4. Permissions justification:
   - `storage` — persist an anonymous device id.
   - `host_permissions` (YouTube) — read the current lecture; (backend) — send
     questions and upload transcripts for course prep.
5. Start as **Unlisted** to dogfood with a small group before going public.

## 4. Before a wide launch (not MVP)

- Auth / per-user budgets on `/ingest` (it spends money).
- Move rate-limit buckets to Redis if you run more than one backend instance.
- Watch-time telemetry (heartbeats) for the "questions per 20 min" metric.
- Pre-ingest ~10 flagship courses so first-run is instant for common courses.
