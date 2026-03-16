#!/usr/bin/env python3
"""
youtube-hook-analysis.py
========================
Hook and transition analysis pipeline for video content.
Runs: scene detection, transcription (whisper/whisperx), optional diarization, OCR.
Outputs JSON for merging into AICC content-input schema.

Usage:
  python scripts/youtube-hook-analysis.py --video /path/to/video.mp4 --out /path/to/out.json
  python scripts/youtube-hook-analysis.py --audio /path/to/audio.wav --out /path/to/out.json
  python scripts/youtube-hook-analysis.py --video /path/to/video.mp4 --max-duration 120 --out /path/to/out.json
"""

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Optional


def run_scenedetect(video_path: str, max_duration_sec: Optional[float]) -> dict:
    """Run PySceneDetect for shot boundaries."""
    try:
        from scenedetect import open_video, SceneManager, ContentDetector

        cap = open_video(video_path)
        duration = cap.duration.total_seconds() if cap.duration else 0
        if max_duration_sec and duration > max_duration_sec:
            duration = max_duration_sec

        scene_manager = SceneManager()
        scene_manager.add_detector(ContentDetector(threshold=27))
        scene_manager.detect_scenes(video=cap)

        scene_list = scene_manager.get_scene_list()
        boundaries = []
        for start_tc, end_tc in scene_list:
            s = start_tc.get_seconds() if hasattr(start_tc, "get_seconds") else float(start_tc)
            if max_duration_sec and s >= max_duration_sec:
                break
            boundaries.append(round(s, 2))

        shot_count = len(boundaries)
        avg_shot = duration / (shot_count + 1) if duration else 0
        density = (shot_count / duration * 10) if duration else 0

        return {
            "scene_boundaries": boundaries,
            "hard_cut_count": shot_count,
            "fade_count": 0,
            "average_shot_length": round(avg_shot, 3),
            "transition_density_per_10s": round(density, 3),
            "duration_sec": round(duration, 2),
        }
    except Exception as e:
        return {"error": str(e), "scene_boundaries": [], "hard_cut_count": 0}


def run_whisper(audio_path: str, max_duration_sec: Optional[float]) -> dict:
    """Run OpenAI Whisper for transcription with timestamps."""
    try:
        import whisper

        model = whisper.load_model("base")
        result = model.transcribe(audio_path, word_timestamps=False, verbose=False)

        segments = result.get("segments") or []
        word_ts = []
        segments_out = []

        for s in segments:
            start = float(s.get("start", 0))
            end = float(s.get("end", start + 1))
            text = (s.get("text") or "").strip()
            if max_duration_sec and start >= max_duration_sec:
                break
            segments_out.append({"start": round(start, 2), "end": round(end, 2), "text": text})
            words = text.split()
            if words and end > start:
                step = (end - start) / len(words)
                for i, w in enumerate(words):
                    word_ts.append({"word": w, "start": round(start + i * step, 3)})

        return {
            "word_timestamps": word_ts[:500],
            "segments": segments_out,
            "transcript": " ".join(s.get("text", "") for s in segments).strip(),
            "provider": "whisper",
        }
    except Exception as e:
        return {"error": str(e), "word_timestamps": [], "segments": []}


def run_whisperx(audio_path: str, max_duration_sec: Optional[float]) -> Optional[dict]:
    """Run WhisperX if available (word-level timestamps)."""
    try:
        import whisperx

        model = whisperx.load_model("base", "cpu", compute_type="int8")
        audio = whisperx.load_audio(audio_path)
        result = model.transcribe(audio, batch_size=8)
        if max_duration_sec:
            result["segments"] = [s for s in (result.get("segments") or []) if float(s.get("start", 0)) < max_duration_sec]

        word_ts = []
        segments_out = []
        for s in result.get("segments") or []:
            start = float(s.get("start", 0))
            end = float(s.get("end", start + 1))
            text = (s.get("text") or "").strip()
            segments_out.append({"start": round(start, 2), "end": round(end, 2), "text": text})
            for w in (s.get("words") or []):
                ws = float(w.get("start", start))
                word_ts.append({"word": str(w.get("word", "")).strip(), "start": round(ws, 3)})
            if not (s.get("words")):
                for w in text.split():
                    word_ts.append({"word": w, "start": round(start, 3)})

        return {
            "word_timestamps": word_ts[:500],
            "segments": segments_out,
            "transcript": " ".join(s.get("text", "") for s in result.get("segments", [])).strip(),
            "provider": "whisperx",
        }
    except Exception:
        return None


def run_diarization(audio_path: str, segments: list, max_duration_sec: Optional[float]) -> list:
    """Run pyannote diarization if available. Requires HF_TOKEN."""
    try:
        from pyannote.audio import Pipeline
        import os

        token = os.environ.get("HF_TOKEN")
        if not token:
            return []
        pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1", use_auth_token=token)
        diar = pipeline(audio_path)
        diar_segments = []
        for turn, _, speaker in diar.itertracks(yield_label=True):
            diar_segments.append((turn.start, turn.end, speaker))
        speaker_segments = []
        for seg in segments:
            start = seg.get("start", 0)
            end = seg.get("end", start + 1)
            if max_duration_sec and start >= max_duration_sec:
                break
            speaker = "unknown"
            for ds, de, sp in diar_segments:
                if start < de and end > ds:
                    speaker = sp
                    break
            speaker_segments.append({"speaker": speaker, "start": start, "end": end, "text": seg.get("text", "")[:180]})
        return speaker_segments
    except Exception:
        return []


def run_ocr(video_path: str, max_frames: int = 12, max_duration_sec: Optional[float] = None) -> list:
    """Sample frames and run EasyOCR for on-screen text."""
    try:
        import cv2
        import easyocr

        reader = easyocr.Reader(["en"], gpu=False, verbose=False)
        cap = cv2.VideoCapture(video_path)
        fps = cap.get(cv2.CAP_PROP_FPS) or 30
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        duration = total_frames / fps if fps else 0
        if max_duration_sec:
            duration = min(duration, max_duration_sec)
        interval = max(1, int((duration * fps) / max_frames)) if duration else 30
        texts = []
        seen = set()
        frame_idx = 0
        while frame_idx < (duration * fps if duration else total_frames):
            cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
            ret, frame = cap.read()
            if not ret:
                break
            results = reader.readtext(frame)
            for (_, text, _) in results:
                t = text.strip()
                if t and len(t) > 2 and t.lower() not in seen:
                    seen.add(t.lower())
                    texts.append(t[:120])
            frame_idx += interval
        cap.release()
        return texts[:50]
    except Exception:
        return []


def extract_audio_from_video(video_path: str, out_dir: str) -> str:
    """Extract audio to wav using ffmpeg."""
    out_path = str(Path(out_dir) / "audio.wav")
    subprocess.run(
        ["ffmpeg", "-y", "-i", video_path, "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", out_path],
        capture_output=True,
        check=True,
    )
    return out_path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", help="Path to video file")
    ap.add_argument("--audio", help="Path to audio file (or extract from video)")
    ap.add_argument("--out", required=True, help="Output JSON path")
    ap.add_argument("--max-duration", type=float, default=180, help="Max seconds to process (default 180)")
    args = ap.parse_args()

    video_path = args.video
    audio_path = args.audio
    if not video_path and not audio_path:
        print("Need --video or --audio", file=sys.stderr)
        sys.exit(1)

    out = {
        "word_timestamps": [],
        "speaker_segments": [],
        "scene_boundaries": [],
        "transition_density_per_10s": 0,
        "on_screen_text": [],
        "average_shot_length": None,
        "hard_cut_count": 0,
        "fade_count": 0,
        "transcript": "",
        "segments": [],
        "pipeline_coverage": {"transcribe": False, "diarize_speakers": False, "segment_shots": False, "ocr_on_screen_text": False},
    }

    with tempfile.TemporaryDirectory() as tmp:
        if video_path and not audio_path:
            try:
                audio_path = extract_audio_from_video(video_path, tmp)
            except Exception:
                audio_path = None

        max_sec = args.max_duration

        # 1. Transcription: WhisperX first, fallback Whisper
        trans_result = None
        if audio_path:
            trans_result = run_whisperx(audio_path, max_sec)
            if trans_result is None:
                trans_result = run_whisper(audio_path, max_sec)
            if trans_result and "error" not in trans_result:
                out["word_timestamps"] = trans_result.get("word_timestamps", [])
                out["segments"] = trans_result.get("segments", [])
                out["transcript"] = trans_result.get("transcript", "")
                out["pipeline_coverage"]["transcribe"] = True

        # 2. Diarization (requires segments)
        if trans_result and out["segments"] and audio_path:
            diar_seg = run_diarization(audio_path, out["segments"], max_sec)
            if diar_seg:
                out["speaker_segments"] = diar_seg
                out["pipeline_coverage"]["diarize_speakers"] = True
            else:
                out["speaker_segments"] = [{"speaker": "unknown", "start": s["start"], "end": s["end"], "text": s.get("text", "")[:180]} for s in out["segments"][:120]]

        # 3. Scene detection (needs video)
        if video_path:
            sc = run_scenedetect(video_path, max_sec)
            if "error" not in sc:
                out["scene_boundaries"] = sc.get("scene_boundaries", [])
                out["hard_cut_count"] = sc.get("hard_cut_count", 0)
                out["fade_count"] = sc.get("fade_count", 0)
                out["average_shot_length"] = sc.get("average_shot_length")
                out["transition_density_per_10s"] = sc.get("transition_density_per_10s", 0)
                out["pipeline_coverage"]["segment_shots"] = True

        # 4. OCR
        if video_path:
            ocr_texts = run_ocr(video_path, max_frames=12, max_duration_sec=max_sec)
            if ocr_texts:
                out["on_screen_text"] = ocr_texts
                out["pipeline_coverage"]["ocr_on_screen_text"] = True

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(out, f, indent=2)
    print(f"Wrote {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
