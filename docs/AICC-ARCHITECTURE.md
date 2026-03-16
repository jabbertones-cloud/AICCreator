# AICC Architecture

## Pipeline

1. Content input ingestion (YouTube intelligence)
- `dashboard/aicc-content-creator.html` (Content Input section)
- `POST /api/aicc/content-input/run` and `GET /api/aicc/content-input/latest`
- `scripts/youtube-transcript-visual-index.js --url <youtube-url> --comments --keyshots 0`
- Writes `reports/aicc-content-input-latest.json`
- Output schema includes:
  - title, description, publish_date
  - transcript
  - top_comments, comment_themes
  - hook_summary_30s
  - on_screen_topics
  - scene_change_count
  - cta_moments
  - sentiment_by_timestamp
  - hook_transition_analysis:
    - start_hook_window (0-5s, 0-8s, 0-15s)
    - word_timestamps
    - speaker_segments (fallback: unknown speaker when diarization unavailable)
    - scene_boundaries
    - transition_density_per_10s
    - first_question_time, first_surprise_claim_time
    - caption_change_rate
    - average_shot_length, hard_cut_count, fade_count
    - hook_phrase, hook_type
  - pipeline_coverage flags for capture/segment/transcribe/diarize/ocr/hook-ranking

2. Research ingestion
- `scripts/content-creator-pipeline.js`
- YouTube transcript index + brief + benchmark context

3. Campaign generation
- `scripts/aicc-campaign-engine.js`
- Produces 3-5 variants with niche templates and scene plans

4. Distribution scheduling
- `scripts/aicc-autopublish.js schedule`
- Queues jobs for YouTube/TikTok/Instagram

5. Publish execution
- `scripts/aicc-autopublish.js run-due`
- Executes due jobs through platform adapters

6. Feedback and optimization
- `scripts/aicc-ab-loop.js`
- Scores retention/CTR/watch-time and promotes winner

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

## Distribution Adapter Modes

- Native API mode via platform credentials
- Webhook mode for external publishing systems
