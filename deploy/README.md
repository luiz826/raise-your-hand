# Deploy — single VPS, all-in-one

Runs the whole thing on one box: **Node backend + Kokoro TTS + Whisper STT**, behind **Caddy** (automatic HTTPS). End users then just install the extension — no local servers, no keys.

```
                         ┌─────────────── your VPS ───────────────┐
  extension  ──https──▶  │  Caddy ─┬─ /tts ─▶ tts   (Kokoro)       │
 (youtube.com)           │         ├─ /stt ─▶ stt   (Whisper)      │
                         │         └─ *    ─▶ backend (Node + LLM) │
                         └─────────────────────────────────────────┘
```

## You provide
- A **VPS** with Docker + Docker Compose. Size: **≥ 4 GB RAM, 2+ vCPU** (Whisper `small` + Kokoro + Node). Hetzner CPX21/CPX31, DigitalOcean, etc. — ~$15–40/mo.
- A **domain** (or subdomain) with an **A record → your VPS IP**, e.g. `voice.yourdomain.com`.
- A **Moonshot (Kimi) API key**. Set a **spend cap** in the Moonshot dashboard so a spike can't surprise-bill you.
- A **Chrome Web Store developer account** ($5 one-time) to publish.

## 1. Configure
On the VPS, clone the repo, then:
```bash
cp deploy/.env.example deploy/.env
# edit deploy/.env: RYH_DOMAIN, MOONSHOT_API_KEY, RYH_API_TOKEN (a long random string)
```

## 2. Bring the courses
The backend serves course maps from `data/`. Prepare them once (locally, via the extension's "Prepare course" or the CLI), then copy to the VPS:
```bash
rsync -av data/ user@your-vps:/path/to/raise-your-hand/data/
```
(Or, on the server, curl `/ingest` with `Authorization: Bearer $RYH_API_TOKEN` — that endpoint is token-gated so only you can trigger the paid ingest.)

## 3. Launch
From the repo root on the VPS:
```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d --build
```
First run downloads the voice models (~2 GB, one-time, cached in a volume) and Caddy fetches TLS certs. Check:
```bash
curl https://voice.yourdomain.com/health          # {"ok":true,"model":"claude-haiku-4-5"}
docker compose -f deploy/docker-compose.yml logs -f
```

## 4. Point + publish the extension
In `extension/content.js`, set the deploy host, and add the domain to `extension/manifest.json`:
```js
const DEPLOY_HOST = "https://voice.yourdomain.com";
```
```json
"host_permissions": ["https://voice.yourdomain.com/*", "*://www.youtube.com/*"]
```
Then zip `extension/` and upload to the **Chrome Web Store** (`npm run pack:ext` builds the zip). Review takes a few days; after that it's a one-click install.

## Cost & ops
- **Rate limits** are on by default (`RYH_ASK_PER_MIN`, `RYH_INGEST_PER_HOUR`) — tune in `deploy/.env`.
- **LLM** is the only real cost; Haiku 4.5 is cheap ($1/$5 per M), answers are brief, and the course prefix is prompt-cached. A spend cap in the Anthropic console is your safety net.
- **Voice** runs on CPU (no per-use cost). `RYH_WHISPER_MODEL=small` keeps latency ~1–3 s; bump to `medium` if you want more accuracy and have the CPU.
- **Logs:** `docker compose -f deploy/docker-compose.yml logs -f <service>`. Telemetry text is off by default (`RYH_LOG_TEXT=0`).

## Hardening follow-ups (not blockers)
- The TTS/STT servers send `Access-Control-Allow-Origin: *`. Fine to launch, but add a Caddy rate-limit or Origin check on `/tts` and `/stt` to stop other sites from using your voice compute.
- Put the whole thing behind Cloudflare (free) for DDoS protection + caching if it takes off.
