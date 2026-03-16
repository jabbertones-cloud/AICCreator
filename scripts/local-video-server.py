#!/usr/bin/env python3
"""
local-video-server.py
Local FastAPI server for free, hardware-accelerated video generation.
Replaces paid APIs (Higgsfield, Runway, etc.) with open-source models.

Supported models (select via AICC_LOCAL_VIDEO_MODEL or per-request):
  wan2.1       — Wan 2.1 by Alibaba/Wan-AI (BEST default — 1.3B runs on 8GB VRAM)
  wan2.1-14b   — Wan 2.1 14B (higher quality, needs 24GB VRAM)
  ltx2         — LTX-Video 2 by Lightricks (fastest, 6GB VRAM minimum)
  hunyuan      — HunyuanVideo by Tencent (best human motion, 24GB VRAM)

Usage:
  pip install -r scripts/requirements-local-video.txt
  python scripts/local-video-server.py

  # Custom port or model:
  AICC_LOCAL_VIDEO_PORT=8010 AICC_LOCAL_VIDEO_MODEL=wan2.1 python scripts/local-video-server.py

Then in .env:
  AICC_LOCAL_VIDEO_URL=http://127.0.0.1:8010

API:
  POST /generate   {prompt, model?, width?, height?, num_frames?, num_steps?, seed?}
  GET  /health
  GET  /models
"""

import os, sys, json, uuid, time, logging, asyncio
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="[video-server] %(levelname)s %(message)s")
log = logging.getLogger("video-server")

# ── Try importing fastapi/uvicorn ──────────────────────────────────────────────
try:
    from fastapi import FastAPI, HTTPException
    from fastapi.responses import JSONResponse
    from pydantic import BaseModel, Field
    from typing import Optional
    import uvicorn
except ImportError:
    print("\n[video-server] Missing dependencies. Install with:")
    print("  pip install fastapi uvicorn pydantic\n")
    sys.exit(1)

# ── Config ─────────────────────────────────────────────────────────────────────
PORT         = int(os.environ.get("AICC_LOCAL_VIDEO_PORT", "8010"))
HOST         = os.environ.get("AICC_LOCAL_VIDEO_HOST", "127.0.0.1")
DEFAULT_MODEL = os.environ.get("AICC_LOCAL_VIDEO_MODEL", "wan2.1")
OUTPUT_DIR   = Path(os.environ.get("AICC_LOCAL_VIDEO_OUTPUT", str(Path(__file__).parent.parent / "media" / "broll")))
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# ── Model registry ─────────────────────────────────────────────────────────────
MODEL_INFO = {
    "wan2.1": {
        "hf_id":     "Wan-AI/Wan2.1-T2V-1.3B",
        "pipeline":  "WanPipeline",
        "vram_gb":   8,
        "desc":      "Wan 2.1 1.3B — best free default, runs on 8GB VRAM",
        "resolution": (480, 832),
    },
    "wan2.1-14b": {
        "hf_id":     "Wan-AI/Wan2.1-T2V-14B",
        "pipeline":  "WanPipeline",
        "vram_gb":   24,
        "desc":      "Wan 2.1 14B — cinematic quality, needs 24GB VRAM",
        "resolution": (720, 1280),
    },
    "wan2.1-i2v": {
        "hf_id":     "Wan-AI/Wan2.1-I2V-14B-480P",
        "pipeline":  "WanImageToVideoPipeline",
        "vram_gb":   16,
        "desc":      "Wan 2.1 Image-to-Video 14B 480P",
        "resolution": (480, 832),
    },
    "ltx2": {
        "hf_id":     "Lightricks/LTX-Video",
        "pipeline":  "LTXPipeline",
        "vram_gb":   6,
        "desc":      "LTX-Video by Lightricks — fastest generation, 6GB VRAM",
        "resolution": (480, 704),
    },
    "hunyuan": {
        "hf_id":     "tencent/HunyuanVideo",
        "pipeline":  "HunyuanVideoPipeline",
        "vram_gb":   24,
        "desc":      "HunyuanVideo by Tencent — best for human motion & avatars",
        "resolution": (544, 960),
    },
}

# Cached pipeline (one at a time to save VRAM)
_loaded_model: str | None = None
_pipeline = None

def get_device():
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"  # Apple Silicon
    except ImportError:
        pass
    return "cpu"

def get_dtype():
    try:
        import torch
        dev = get_device()
        if dev == "cuda":
            return torch.float16
        if dev == "mps":
            return torch.bfloat16  # MPS works better with bfloat16
    except ImportError:
        pass
    return None

def load_pipeline(model_key: str):
    global _loaded_model, _pipeline

    if _loaded_model == model_key and _pipeline is not None:
        return _pipeline

    info = MODEL_INFO.get(model_key)
    if not info:
        raise ValueError(f"Unknown model: {model_key}. Available: {list(MODEL_INFO.keys())}")

    try:
        import torch
        from diffusers import (
            WanPipeline,
            WanImageToVideoPipeline,
            LTXPipeline,
            HunyuanVideoPipeline,
        )
    except ImportError as e:
        raise RuntimeError(
            f"Missing diffusers/torch. Install with:\n"
            f"  pip install diffusers transformers accelerate torch torchvision\n"
            f"Error: {e}"
        )

    device = get_device()
    dtype  = get_dtype()

    pipeline_cls_map = {
        "WanPipeline":              WanPipeline,
        "WanImageToVideoPipeline":  WanImageToVideoPipeline,
        "LTXPipeline":              LTXPipeline,
        "HunyuanVideoPipeline":     HunyuanVideoPipeline,
    }

    cls = pipeline_cls_map.get(info["pipeline"])
    if cls is None:
        raise RuntimeError(f"Pipeline class {info['pipeline']} not available")

    log.info(f"Loading {model_key} from {info['hf_id']} on {device} ({dtype})...")
    kwargs = {"torch_dtype": dtype} if dtype else {}

    pipe = cls.from_pretrained(info["hf_id"], **kwargs)

    # Memory optimizations
    if hasattr(pipe, "enable_model_cpu_offload"):
        pipe.enable_model_cpu_offload()
    elif device in ("cuda", "mps"):
        pipe = pipe.to(device)

    if hasattr(pipe, "enable_vae_tiling"):
        pipe.enable_vae_tiling()

    if hasattr(pipe, "enable_xformers_memory_efficient_attention"):
        try:
            pipe.enable_xformers_memory_efficient_attention()
        except Exception:
            pass

    _loaded_model = model_key
    _pipeline     = pipe
    log.info(f"Model {model_key} loaded.")
    return pipe


# ── FastAPI app ────────────────────────────────────────────────────────────────
app = FastAPI(title="AICC Local Video Server", version="1.0.0")

class GenerateRequest(BaseModel):
    prompt: str
    model: Optional[str] = Field(default=None, description="Model key: wan2.1 | ltx2 | hunyuan | wan2.1-14b")
    negative_prompt: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None
    num_frames: Optional[int] = 25
    num_steps: Optional[int] = 25
    guidance_scale: Optional[float] = 7.5
    seed: Optional[int] = None


@app.get("/health")
def health():
    return {
        "ok": True,
        "server": "aicc-local-video",
        "device": get_device(),
        "loaded_model": _loaded_model,
        "port": PORT,
    }


@app.get("/models")
def models():
    return {k: {"desc": v["desc"], "vram_gb": v["vram_gb"], "resolution": v["resolution"]}
            for k, v in MODEL_INFO.items()}


@app.post("/generate")
async def generate(req: GenerateRequest):
    model_key = req.model or DEFAULT_MODEL
    if model_key not in MODEL_INFO:
        raise HTTPException(400, f"Unknown model '{model_key}'. Available: {list(MODEL_INFO.keys())}")

    info = MODEL_INFO[model_key]
    w = req.width  or info["resolution"][1]
    h = req.height or info["resolution"][0]

    log.info(f"Generating: model={model_key} prompt='{req.prompt[:60]}' {w}x{h} frames={req.num_frames}")

    try:
        import torch
        pipe = load_pipeline(model_key)

        gen = torch.Generator().manual_seed(req.seed) if req.seed is not None else None

        # Build kwargs depending on pipeline type
        pipe_kwargs = dict(
            prompt=req.prompt,
            width=w,
            height=h,
            num_frames=req.num_frames,
            num_inference_steps=req.num_steps,
            guidance_scale=req.guidance_scale,
        )
        if req.negative_prompt:
            pipe_kwargs["negative_prompt"] = req.negative_prompt
        if gen:
            pipe_kwargs["generator"] = gen

        t0 = time.time()
        output = pipe(**pipe_kwargs)
        elapsed = round(time.time() - t0, 1)

        # Save output — diffusers returns VideoOutput with .frames
        out_name = f"{model_key}-{uuid.uuid4().hex[:8]}.mp4"
        out_path = OUTPUT_DIR / out_name

        frames = output.frames[0] if hasattr(output, "frames") else output[0]

        # Export frames to MP4 via imageio or export_to_video
        try:
            from diffusers.utils import export_to_video
            export_to_video(frames, str(out_path), fps=int(os.environ.get("AICC_VIDEO_FPS", "16")))
        except Exception:
            # Fallback: imageio
            import imageio
            writer = imageio.get_writer(str(out_path), fps=16, codec="libx264")
            for frame in frames:
                writer.append_data(frame)
            writer.close()

        log.info(f"Saved: {out_path} ({elapsed}s)")
        return {
            "ok":      True,
            "path":    str(out_path),
            "model":   model_key,
            "elapsed": elapsed,
            "prompt":  req.prompt,
        }

    except RuntimeError as e:
        # Dependency or VRAM error
        raise HTTPException(503, str(e))
    except Exception as e:
        log.error(f"Generation failed: {e}", exc_info=True)
        raise HTTPException(500, f"Generation failed: {e}")


if __name__ == "__main__":
    log.info(f"Starting AICC Local Video Server on {HOST}:{PORT}")
    log.info(f"Default model: {DEFAULT_MODEL} — {MODEL_INFO[DEFAULT_MODEL]['desc']}")
    log.info(f"Output dir: {OUTPUT_DIR}")
    log.info(f"Device: {get_device()}")
    log.info("")
    log.info("Available models (GET /models):")
    for k, v in MODEL_INFO.items():
        log.info(f"  {k:16s} {v['vram_gb']}GB VRAM  {v['desc']}")
    log.info("")
    log.info("Add to .env:  AICC_LOCAL_VIDEO_URL=http://127.0.0.1:8010")
    uvicorn.run(app, host=HOST, port=PORT)
