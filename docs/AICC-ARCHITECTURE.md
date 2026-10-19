# AICC Architecture

## Pipeline

1. Research ingestion
- `scripts/content-creator-pipeline.js`
- YouTube transcript index + brief + benchmark context

2. Campaign generation
- `scripts/aicc-campaign-engine.js`
- Produces 3-5 variants with niche templates and scene plans

3. Distribution scheduling
- `scripts/aicc-autopublish.js schedule`
- Queues jobs for YouTube/TikTok/Instagram

4. Publish execution
- `scripts/aicc-autopublish.js run-due`
- Executes due jobs through platform adapters

5. Feedback and optimization
- `scripts/aicc-ab-loop.js`
- Scores retention/CTR/watch-time and promotes winner

6. Plushtrap Media OS control layer
- `config/aicc-agent-team.json`
- `config/aicc-plushtrap-stack.json`
- `scripts/aicc-stack-preflight.js`
- `scripts/aicc-source-ledger.js`
- `scripts/aicc-disclosure-gate.js`
- `scripts/aicc-render-queue.js`
- See `docs/AICC-PLUSHTRAP-MEDIA-OS.md`

## Niche Packs

- `ai-clone-news`
- `viral-faceless`
- `product-ads`

Each pack includes hook templates, CTA templates, and affiliate packaging defaults.

## Scene Quality Engine

Generated per variant:
- Hook/body/CTA segmentation
- Beat timing
- Transition plan
- B-roll cue keywords

## Plushtrap Safety Gates

- Source provenance must distinguish verified external sources, NotebookLM SOT, local assets, operator assumptions, and rejected claims.
- Virtual creator disclosure is required before publish.
- Publish adapters attach AICC disclosure metadata to webhooks.
- TikTok native AI/content metadata is opt-in with `AICC_TIKTOK_SEND_AIGC_FIELDS=true` so unknown API field changes do not break conservative private uploads.
- Render queue defaults to dry-run/external-adapter stubs unless ComfyUI workflow JSON is explicitly submitted.

## Metrics Upgrade

The AB loop accepts first-second and three-second hook metrics in addition to legacy retention/CTR/watch-time:

- `one_sec_hold_pct`
- `three_sec_view_pct`
- `skip_dropoff_ms`
- `completion_pct`
- `saves`
- `shares`
- `comments`

## Distribution Adapter Modes

- Native API mode via platform credentials
- Webhook mode for external publishing systems
