# AICC Plushtrap Media OS

Generated: 2026-06-03

## Purpose

AICC now has foundation pieces for scalable Plushtrap AI lifestyle documentary production:

- agent team contracts
- source provenance ledger
- disclosure gate
- async render queue
- stack preflight
- micro-metric AB scoring

This does not spend external video credits by default. External APIs remain opt-in.

## Core Files

- `config/aicc-agent-team.json` — expert agent roles and local/Gemini model routes.
- `config/aicc-plushtrap-stack.json` — Plushtrap routing, disclosure, quality, metrics policy.
- `schemas/aicc-agent-output.schema.json` — agent output contract.
- `schemas/aicc-render-job.schema.json` — render job contract.
- `schemas/aicc-metrics.schema.json` — micro-metric contract.
- `scripts/aicc-source-ledger.js` — provenance ledger CLI.
- `scripts/aicc-disclosure-gate.js` — virtual creator/legal/platform publish gate.
- `scripts/aicc-stack-preflight.js` — local runtime check for Ollama, Hermes, NotebookLM, Gemini, n8n, FFmpeg, ComfyUI.
- `scripts/aicc-render-queue.js` — JSONL render queue with dry-run and ComfyUI submit path.

## Operating Flow

1. Run stack check:

```bash
npm run -s aicc:preflight
```

2. Add or verify sources:

```bash
npm run -s aicc:source:add -- --claim "ComfyUI supports API workflow execution" --status verified_external --source-type url --url-or-path "https://github.com/Comfy-Org/ComfyUI" --allowed-use publish
npm run -s aicc:source:gate
```

3. Generate campaign:

```bash
npm run -s aicc:campaign -- --topic "Plushtrap factory trip" --niche product-ads
```

4. Run disclosure gate:

```bash
npm run -s aicc:disclosure:gate
```

5. Queue render jobs:

```bash
npm run -s aicc:render:add -- --shot-type human_motion --prompt "Mika, virtual Plushtrap creator, handheld Tokyo sourcing clip, Bunski styling, imperfect phone camera" --credits-checked
npm run -s aicc:render:submit -- --dry-run
npm run -s aicc:render:report
```

6. Schedule/publish only after QA/human approval:

```bash
npm run -s aicc:autopublish:schedule -- --video /absolute/path/final.mp4
npm run -s aicc:autopublish:run -- --dry-run
```

## Gates

Publish fails if variant lacks approved virtual creator disclosure. Current accepted phrases live in `config/aicc-plushtrap-stack.json`.

Blocked claim patterns also live there. Defaults block fake real-customer, real-factory, official-partner, celebrity-endorsement, and guarantee claims.

## Local LLM Routing

Current recommended routes:

- fast text: `qwen3:4b-64k`
- coding/workflow: `qwen2.5-coder:7b`
- vision: `llama3.2-vision`
- stronger reasoning target: `qwen3:14b` with `qwen3:4b-64k` fallback
- synthesis checker: Gemini CLI

Preflight reports missing recommended models without blocking unless `--strict` is used.

## External Video Routing

Render queue supports provider labels now:

- `comfyui`
- `kie_kling`
- `muapi_kling`
- `muapi_veo`
- `remotion`
- `ffmpeg`
- `manual`

Only `comfyui` has direct submit implementation in this pass. Other providers are queued with adapter stubs, so no accidental API spend.

## Metrics

`scripts/aicc-ab-loop.js` now reads:

- `one_sec_hold_pct`
- `three_sec_view_pct`
- `skip_dropoff_ms`
- `completion_pct`
- `saves`
- `shares`
- `comments`
- existing `retention_30s_pct`, `ctr_pct`, `avg_watch_sec`

Use `reports/aicc-metrics-latest.json` with `schemas/aicc-metrics.schema.json`.

## NotebookLM

Research refresh source added to NotebookLM:

- notebook: `8b8519a6-798f-4150-abfd-1f9c5a6e1796`
- source: `9a81bf45-4bad-4a23-8878-9218c1f9de78`

Future implementation notes should be added as file sources so AICC memory survives chat context.
