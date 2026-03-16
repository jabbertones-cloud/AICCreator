# Hook & Transition Analysis Setup

Optional Python stack for full video analysis: scene detection, Whisper/WhisperX transcription, pyannote diarization, and OCR for on-screen text.

## Quick start

```bash
# Create venv
python3 -m venv .venv-hook-analysis
source .venv-hook-analysis/bin/activate   # Windows: .venv-hook-analysis\Scripts\activate

# Install core dependencies
pip install -r scripts/requirements-hook-analysis.txt

# Run full analysis (Node calls Python when --full-analysis is passed)
node scripts/youtube-transcript-visual-index.js --url "https://www.youtube.com/watch?v=..." --full-analysis --out reports/aicc-content-input-latest.json
```

## Pipeline components

| Component | Purpose | Package |
|-----------|---------|---------|
| **Capture** | Download video/audio | yt-dlp (Node) |
| **Segment** | Shot boundaries, cuts | scenedetect |
| **Transcribe** | Speech → text + timestamps | openai-whisper (or WhisperX) |
| **Diarize** | Who said what | pyannote.audio (optional) |
| **OCR** | On-screen text | easyocr |

## Core install (scenedetect + whisper + easyocr)

```bash
pip install -r scripts/requirements-hook-analysis.txt
```

Includes:
- `scenedetect[opencv]` — PySceneDetect for scene/shot boundaries
- `openai-whisper` — Whisper transcription with segment timestamps
- `easyocr` — On-screen text extraction from sampled frames

## Optional upgrades

### WhisperX (word-level timestamps)

Better alignment than plain Whisper. Install after core:

```bash
pip install git+https://github.com/m-bain/whisperX.git
```

WhisperX will be used automatically when available. Fallback: plain Whisper.

### pyannote.audio (speaker diarization)

Separates host, guest, VO, etc. Requires HuggingFace token:

1. Accept model license: https://huggingface.co/pyannote/speaker-diarization-3.1  
2. Create token: https://huggingface.co/settings/tokens  
3. Install and set env:

```bash
pip install pyannote.audio
export HF_TOKEN=your_huggingface_token
```

## Usage

### CLI

```bash
# Basic (transcript + metadata + comments)
node scripts/youtube-transcript-visual-index.js --url "https://youtube.com/watch?v=..." --comments --out reports/aicc-content-input-latest.json

# Full analysis (scene detection, Whisper, OCR)
node scripts/youtube-transcript-visual-index.js --url "https://youtube.com/watch?v=..." --full-analysis --out reports/aicc-content-input-latest.json

# With keyshots (ffmpeg frames) + full analysis
node scripts/youtube-transcript-visual-index.js --url "https://youtube.com/watch?v=..." --full-analysis --keyshots 6 --out reports/aicc-content-input-latest.json
```

### API

```bash
curl -X POST "http://127.0.0.1:4052/api/aicc/content-input/run" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://youtube.com/watch?v=...","includeComments":true,"fullAnalysis":true}'
```

### Dashboard

In the Content Input section, enable "Full analysis" (when the UI option exists) or use the API with `fullAnalysis: true`.

## Output schema

`hook_transition_analysis` and `pipeline_coverage` in the report:

- `scene_boundaries` — Seconds where cuts occur
- `word_timestamps` — Word-level timing (WhisperX) or estimated (Whisper)
- `speaker_segments` — Speaker-labeled segments (pyannote or fallback "unknown")
- `on_screen_text` — OCR-extracted text from frames
- `transition_density_per_10s`, `average_shot_length`, `hard_cut_count`
- `pipeline_coverage` — Which stages ran: transcribe, diarize_speakers, segment_shots, ocr_on_screen_text

## Requirements

- Python 3.10+
- ffmpeg (for audio extraction)
- yt-dlp (for download)
- ~2–4 GB disk for Whisper base model (first run)

## Troubleshooting

**`python3` not found** — Ensure `python3` is in PATH. The Node script invokes `python3 -u scripts/youtube-hook-analysis.py`.

**Whisper slow on CPU** — Use `base` model (default). For faster runs, install CUDA and use GPU if available.

**pyannote fails** — Check `HF_TOKEN` and that you’ve accepted the model license on HuggingFace.

**OCR empty** — Some videos have little on-screen text. EasyOCR works best on clear, high-contrast text.
