# AICC Setup & Operations Guide

> Last updated: 2026-03-10

## What Is AICC?

AICCreator (AICC) is an automated content operations pipeline that turns research into publish-ready short-form campaigns for YouTube, TikTok, and Instagram. It lives in this repo and shares infrastructure (Redis, Postgres) with the `claw-architect` build.

---

## Quick Start (No Infrastructure Needed)

These commands work immediately — no API keys, no Redis, no Postgres required:

```bash
# 1. Generate a campaign from existing research
npm run aicc:campaign
# or with custom params:
node scripts/aicc-campaign-engine.js --topic "AI tools for creators" --niche "ai-tools-review" --variants 3

# 2. Schedule publish queue
npm run aicc:autopublish:schedule

# 3. Launch the local dashboard (standalone, no DB needed)
npm run aicc:standalone
# Open: http://localhost:4051/aicc
```

### New: Content Input (YouTube URL)

Use the **Content Input** panel in the AICC dashboard (Make Videos tab), or call the API directly:

```bash
curl -s -X POST "http://127.0.0.1:4052/api/aicc/content-input/run" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "includeComments": true,
    "keyshots": 0
  }' | jq .

curl -s "http://127.0.0.1:4052/api/aicc/content-input/latest" | jq .
```

Output report:
- `reports/aicc-content-input-latest.json`

---

## Environment Setup

Copy `.env.example` to `.env` (already done), then fill in your keys:

```bash
cp .env.example .env
```

### Required for full dashboard (claw-architect build provides these):

```
REDIS_HOST=127.0.0.1         # or 192.168.1.164 if connecting to NAS
REDIS_PORT=6379              # or 16379 for NAS
POSTGRES_HOST=192.168.1.164
POSTGRES_PORT=15432
POSTGRES_USER=claw
POSTGRES_PASSWORD=<your-password>
POSTGRES_DB=claw_architect
```

> Start these with: `npm run compose:nas` (in claw-architect) or `docker compose -f docker-compose.nas.yml up -d`

---

## Pipeline Tiers

### Tier 1 — Works immediately (zero deps)
| Command | What it does |
|---------|-------------|
| `npm run aicc:campaign` | Generate 3–5 content variants with hooks, CTAs, scene plans |
| `npm run aicc:autopublish:schedule` | Schedule variants to YouTube/TikTok/Instagram queue |
| `npm run aicc:ab:score` | Score variants and promote the winner |
| `npm run aicc:standalone` | Launch AICC dashboard at http://localhost:4051/aicc |

### Tier 2 — Needs yt-dlp (install once)
```bash
# macOS
brew install yt-dlp
# or
pip install yt-dlp
```

| Command | What it does |
|---------|-------------|
| `npm run content-creator:pipeline` | Pull YouTube transcripts → generate research brief |
| `npm run youtube:index` | Full YouTube index with metadata |
| `npm run content-creator:pipeline -- --url "<youtube-url>" --comments --keyshots 0` | One-off YouTube intelligence ingestion with comment capture |

### Tier 2.5 — Hook & transition analysis (Python stack)
Optional full pipeline: Whisper/WhisperX, PySceneDetect, pyannote diarization, EasyOCR.

```bash
# Create venv and install
python3 -m venv .venv-hook-analysis
source .venv-hook-analysis/bin/activate   # Windows: .venv-hook-analysis\Scripts\activate
pip install -r scripts/requirements-hook-analysis.txt
```

| Command | What it does |
|---------|-------------|
| `node scripts/youtube-transcript-visual-index.js --url "https://youtube.com/watch?v=..." --full-analysis --out reports/aicc-content-input-latest.json` | Full hook analysis: scene boundaries, Whisper transcription, OCR on-screen text |
| Content Input API with `fullAnalysis: true` | Same via dashboard / POST `/api/aicc/content-input/run` |

See `docs/HOOK-ANALYSIS-SETUP.md` for WhisperX, pyannote (HF token), and optional upgrades.

### Tier 3 — TTS (Text-to-Speech) for voiceovers

**Option A: Local macOS say (free, zero setup)**
```bash
npm run aicc:tts:local
# or set in .env:
AICC_TTS_PROVIDER=local
AICC_TTS_VOICE_MACOS=Samantha  # try: say -v ? for all voices
```

**Option B: Local HTTP TTS server (piper, kokoro, coqui)**
```bash
# Example with piper-tts (https://github.com/rhasspy/piper)
# Start piper server, then:
AICC_LOCAL_TTS_URL=http://localhost:5000/synthesize npm run aicc:tts:run

# Example with kokoro (OpenAI-compat API)
AICC_LOCAL_TTS_URL=http://localhost:8880/v1/audio/speech
AICC_LOCAL_TTS_OPENAI_COMPAT=true npm run aicc:tts:run
```

**Option C: Cloud (paid)**
```bash
# ElevenLabs (best quality)
ELEVENLABS_API_KEY=your-key

# OpenAI TTS
OPENAI_API_KEY=your-key
AICC_TTS_VOICE=onyx   # alloy | echo | fable | onyx | nova | shimmer
```

### Tier 4 — B-roll video generation
```bash
# Pexels (free tier available)
PEXELS_API_KEY=your-key

# Higgsfield AI (premium)
HIGGSFIELD_API_KEY=your-key
```

### Tier 5 — Social publishing credentials
```env
# YouTube (OAuth2)
YOUTUBE_CLIENT_ID=
YOUTUBE_CLIENT_SECRET=
YOUTUBE_REFRESH_TOKEN=

# TikTok
TIKTOK_ACCESS_TOKEN=

# Instagram
IG_USER_ID=
IG_ACCESS_TOKEN=
```

---

## Dashboard (architect-api)

The full architect dashboard runs at port 4051 and requires Redis + Postgres.

```bash
# With full claw-architect infra running:
node scripts/architect-api.js

# Or the lightweight AICC-only standalone (no Redis/Postgres needed):
npm run aicc:standalone
# → http://localhost:4051/aicc
```

The standalone server handles:
- `GET /aicc` — AICC dashboard UI
- `GET /api/aicc/pipeline` — pipeline status (reads local reports)
- `POST /api/aicc/campaign` — run campaign engine
- `POST /api/aicc/run` — trigger full autopilot
- `POST /api/aicc/content-input/run` — ingest one YouTube URL into content-input report
- `GET /api/aicc/content-input/latest` — fetch latest content-input report
- `GET /health` — health check

---

## Full Autopilot (all tiers)

```bash
npm run content-creator:autopilot
```

This runs: trends → campaign → TTS → B-roll → avatar → clip-extractor → autopublish

Skips steps that don't have API keys configured.

---

## Key Files

| File | Purpose |
|------|---------|
| `scripts/aicc-campaign-engine.js` | Template-based campaign generator (no API) |
| `scripts/content-creator-pipeline.js` | YouTube research ingestion (needs yt-dlp) |
| `scripts/content-creator-autopilot.js` | Full end-to-end orchestrator |
| `scripts/aicc-autopublish.js` | Schedule + publish to platforms |
| `scripts/aicc-ab-loop.js` | A/B scoring and winner promotion |
| `scripts/aicc-standalone-server.js` | Lightweight dashboard server (no DB) |
| `agents/tts-agent.js` | TTS: ElevenLabs / OpenAI / piper / macOS say |
| `agents/video-gen-agent.js` | B-roll video generation |
| `dashboard/aicc-content-creator.html` | Dashboard UI |
| `data/youtube-urls.txt` | Research source videos |
| `reports/aicc-campaign-latest.json` | Latest generated campaign |
| `data/aicc-publish-queue.json` | Scheduled publish queue |

---

## Niche Packs Available

| Niche | Angle |
|-------|-------|
| `ai-clone-news` | Rapid AI market change |
| `viral-faceless` | Short-form retention optimization |
| `product-ads` | Pain-to-proof conversion |
| `ai-tools-review` | AI tool comparison |
| `youtube-faceless` | Faceless YouTube growth |

---

## Upgrade Path

To add new features to AICC:

1. **New niche pack** — Add to `NICHE_PACKS` object in `scripts/aicc-campaign-engine.js`
2. **New TTS provider** — Add function to `agents/tts-agent.js`, hook into `synthesizeScript()`
3. **New publish platform** — Add adapter in `scripts/aicc-autopublish.js`
4. **New research source** — Add indexer script in `scripts/`, call from `content-creator-pipeline.js`
5. **Dashboard widget** — Edit `dashboard/aicc-content-creator.html`, add API endpoint in `scripts/aicc-standalone-server.js`

---

## Troubleshooting

**`Error: yt-dlp is required`** → Install: `brew install yt-dlp`

**Comments missing in content input output** → run with `includeComments: true` and ensure yt-dlp can access the video. Some videos disable comments or restrict availability.

**`No TTS provider configured`** → Set `AICC_TTS_PROVIDER=local` in `.env` to use macOS say

**`Port 4051 already in use`** → Use `AICC_PORT=4052 npm run aicc:standalone`

**Dashboard shows no data** → Run `npm run aicc:campaign` first to generate `reports/aicc-campaign-latest.json`

**Architect API exits with missing Redis/Postgres** → Use `npm run aicc:standalone` instead for AICC-only work
