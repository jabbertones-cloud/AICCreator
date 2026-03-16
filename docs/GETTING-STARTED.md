# Getting Started

## Prerequisites

- Node.js 20+
- npm
- Optional for media workflows: `ffmpeg`, `yt-dlp`

## Install

```bash
npm install
```

## Minimal End-to-End Run

**Using autopilot (recommended):** The autopilot runs the full pipeline (trends, campaign, TTS, B-roll, clip-extractor, repurpose, auto-publish). No manual `--video` needed — clip-extractor produces `media/output/<variant_id>-final.mp4`, and autopublish uses those automatically.

```bash
npm run content-creator:autopilot
# Output: media/output/<variant_id>-final.mp4, then run-due publishes from clip manifest
```

**Manual pipeline (step-by-step):** If you run steps manually, use the clip-extractor output path or omit `--video` so autopublish uses `reports/clip-manifest-latest.json`:

```bash
npm run content-creator:pipeline
npm run aicc:campaign
# TTS + B-roll (see Envs below) → then clip-extractor
npm run aicc:clip-extractor
npm run aicc:autopublish:schedule
# No --video needed: schedule uses clip manifest when available
npm run aicc:autopublish:run
npm run aicc:ab:score
```

## Single Command (aicc:system)

`aicc:system` runs pipeline + campaign + schedule + run-due. It does *not* run TTS/B-roll/clip-extractor. Use `content-creator:autopilot` for the full video pipeline.

```bash
# With existing clip manifest (after autopilot or manual clip-extractor):
npm run aicc:system -- --topic "automated content creator" --niche ai-clone-news --variants 5 --publish-due

# Or pass --video for a single-file campaign:
npm run aicc:system -- --topic "..." --niche "..." --variants 1 --video /path/to/final.mp4 --publish-due
```

## Environment Variables (Optional Steps)

TTS and B-roll run only when the corresponding API keys are set; autopilot skips those steps otherwise.

| Step | Env key(s) | Behavior |
|------|------------|----------|
| **TTS** | `ELEVENLABS_API_KEY` or `OPENAI_API_KEY` | Generates `reports/tts-<variant_id>.mp3`; skipped if neither set |
| **B-roll** | `HIGGSFIELD_API_KEY` or `PEXELS_API_KEY` | Generates B-roll in `media/broll/`; skipped if neither set |
| **Avatar** | `HEYGEN_API_KEY` or `DID_API_KEY` | Generates avatar videos in `media/avatar/`; skipped if neither set |

Clip-extractor uses `reports/tts-*.mp3` and `media/broll/*.mp4` (or avatar when wired). It outputs `media/output/<variant_id>-final.mp4` and writes `reports/clip-manifest-latest.json`. Autopublish uses the clip manifest to resolve video paths when `--video` is not passed.

## Outputs

- `reports/youtube-transcript-visual-index-latest.json`
- `reports/aicc-content-input-latest.json` (when using Content Input API/UI)
- `reports/content-creator-brief-latest.json`
- `reports/aicc-campaign-latest.json`
- `reports/clip-manifest-latest.json` (autopilot / clip-extractor)
- `media/output/<variant_id>-final.mp4` (per-variant final video)
- `data/aicc-publish-queue.json`
- `reports/aicc-publish-results-latest.json`
- `reports/aicc-ab-results-latest.json`
