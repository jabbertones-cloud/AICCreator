#!/usr/bin/env python3
"""
local-liveportrait-server.py
Local FastAPI server for free talking-head / avatar video generation.
Replaces paid APIs (HeyGen, D-ID) with LivePortrait (KwaiYing).

LivePortrait: upload a static photo + a "drive" video of yourself talking,
and it maps your expressions + lip movements onto the photo — completely free.

Usage:
  # 1. Install LivePortrait (one-time):
  #    pip install -r scripts/requirements-liveportrait.txt
  #    (LivePortrait weights download automatically on first run)

  # 2. Start server:
  python scripts/local-liveportrait-server.py

  # Custom port:
  AICC_LOCAL_AVATAR_PORT=8011 python scripts/local-liveportrait-server.py

Then in .env:
  AICC_LOCAL_AVATAR_URL=http://127.0.0.1:8011
  AICC_AVATAR_SOURCE_IMAGE=/path/to/your-headshot.jpg   # static source photo
  AICC_AVATAR_DRIVE_VIDEO=/path/to/drive-clip.mp4       # your webcam/phone recording

API:
  POST /animate     {source_image_path, drive_video_path, output_path?}
  POST /animate-b64 {source_image_b64, drive_video_b64}  (base64 upload)
  GET  /health
  GET  /info

How to get your drive video:
  - Record yourself talking on your phone/webcam (any length)
  - LivePortrait maps the mouth/eyes/head movements onto the source photo
  - The source photo can be ANY portrait (AI-generated, illustration, etc.)
"""

import os, sys, uuid, logging, base64, tempfile, subprocess
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="[liveportrait-server] %(levelname)s %(message)s")
log = logging.getLogger("liveportrait-server")

try:
    from fastapi import FastAPI, HTTPException, UploadFile, File
    from fastapi.responses import FileResponse
    from pydantic import BaseModel
    from typing import Optional
    import uvicorn
except ImportError:
    print("\n[liveportrait-server] Missing dependencies. Install with:")
    print("  pip install fastapi uvicorn pydantic\n")
    sys.exit(1)

# ── Config ─────────────────────────────────────────────────────────────────────
PORT       = int(os.environ.get("AICC_LOCAL_AVATAR_PORT", "8011"))
HOST       = os.environ.get("AICC_LOCAL_AVATAR_HOST", "127.0.0.1")
OUTPUT_DIR = Path(os.environ.get("AICC_LOCAL_AVATAR_OUTPUT",
                  str(Path(__file__).parent.parent / "media" / "avatar")))
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# Default source image (your headshot) — set in .env or per-request
DEFAULT_SOURCE = os.environ.get("AICC_AVATAR_SOURCE_IMAGE", "")
# Default drive video (your talking reference) — set in .env or per-request
DEFAULT_DRIVE  = os.environ.get("AICC_AVATAR_DRIVE_VIDEO", "")

# Where LivePortrait is cloned (auto-detected)
LP_REPO = os.environ.get("LIVEPORTRAIT_REPO",
          str(Path.home() / "liveportrait"))

# ── Utility ───────────────────────────────────────────────────────────────────
def find_liveportrait():
    """Find LivePortrait installation: cloned repo or installed package."""
    # Check env override
    if os.path.isdir(LP_REPO):
        return LP_REPO, "repo"

    # Check common locations
    for loc in [
        Path.home() / "LivePortrait",
        Path.home() / "liveportrait",
        Path("/opt/liveportrait"),
        Path("/usr/local/lib/liveportrait"),
    ]:
        if loc.is_dir() and (loc / "inference.py").exists():
            return str(loc), "repo"

    # Check if installed as package
    try:
        import liveportrait
        return str(Path(liveportrait.__file__).parent), "package"
    except ImportError:
        pass

    return None, None


def run_liveportrait(source_img: str, drive_vid: str, output_path: str) -> dict:
    """
    Run LivePortrait inference.
    Supports both the official CLI (inference.py) and the Python API.
    """
    lp_path, lp_type = find_liveportrait()

    if lp_path is None:
        return {
            "ok": False,
            "error": (
                "LivePortrait not installed. Install it with:\n"
                "  git clone https://github.com/KwaiYing/LivePortrait ~/liveportrait\n"
                "  cd ~/liveportrait && pip install -r requirements.txt\n"
                "Then set: LIVEPORTRAIT_REPO=~/liveportrait"
            )
        }

    if lp_type == "repo":
        inference_script = Path(lp_path) / "inference.py"
        if not inference_script.exists():
            return {"ok": False, "error": f"inference.py not found in {lp_path}"}

        cmd = [
            sys.executable, str(inference_script),
            "-s", source_img,
            "-d", drive_vid,
            "--output-dir", str(OUTPUT_DIR),
        ]

        log.info(f"Running LivePortrait: {' '.join(cmd)}")
        result = subprocess.run(cmd, capture_output=True, text=True, cwd=lp_path)

        if result.returncode != 0:
            log.error(f"LivePortrait stderr: {result.stderr[-1000:]}")
            return {"ok": False, "error": f"LivePortrait failed: {result.stderr[-500:]}"}

        # LivePortrait saves to output-dir with auto-naming; move to desired output_path
        # Find the most recent .mp4 in output dir
        mp4s = sorted(OUTPUT_DIR.glob("*.mp4"), key=lambda f: f.stat().st_mtime, reverse=True)
        if mp4s:
            mp4s[0].rename(output_path)
            return {"ok": True, "path": output_path}
        else:
            return {"ok": False, "error": "LivePortrait ran but no output MP4 found"}

    return {"ok": False, "error": "LivePortrait package mode not yet supported; use repo mode"}


# ── FastAPI ───────────────────────────────────────────────────────────────────
app = FastAPI(title="AICC LivePortrait Avatar Server", version="1.0.0")


class AnimateRequest(BaseModel):
    source_image_path: Optional[str] = None   # absolute path on server
    drive_video_path:  Optional[str] = None   # absolute path on server
    output_path:       Optional[str] = None   # where to save result


class AnimateB64Request(BaseModel):
    source_image_b64: str    # base64-encoded image
    drive_video_b64:  str    # base64-encoded video
    source_ext: Optional[str] = "jpg"
    drive_ext:  Optional[str] = "mp4"


@app.get("/health")
def health():
    lp_path, lp_type = find_liveportrait()
    return {
        "ok": True,
        "server":         "aicc-liveportrait",
        "liveportrait":   lp_path is not None,
        "liveportrait_path": lp_path,
        "default_source": DEFAULT_SOURCE or "(not set — pass source_image_path)",
        "default_drive":  DEFAULT_DRIVE  or "(not set — pass drive_video_path)",
        "output_dir":     str(OUTPUT_DIR),
        "port": PORT,
    }


@app.get("/info")
def info():
    return {
        "description": "LivePortrait talking-head generator — free HeyGen/D-ID replacement",
        "how_to_use": {
            "1_set_source": "Put your headshot photo path in AICC_AVATAR_SOURCE_IMAGE",
            "2_set_drive":  "Put your webcam/phone talking-clip path in AICC_AVATAR_DRIVE_VIDEO",
            "3_call":       "POST /animate with optional overrides",
            "4_result":     "Returns {ok, path} with output MP4",
        },
        "install_liveportrait": [
            "git clone https://github.com/KwaiYing/LivePortrait ~/liveportrait",
            "cd ~/liveportrait && pip install -r requirements.txt",
            "# Weights download automatically on first inference",
        ],
        "per_request_override": {
            "source_image_path": "Override the headshot photo",
            "drive_video_path":  "Override the drive/reference video",
        },
    }


@app.post("/animate")
async def animate(req: AnimateRequest):
    source = req.source_image_path or DEFAULT_SOURCE
    drive  = req.drive_video_path  or DEFAULT_DRIVE

    if not source:
        raise HTTPException(400,
            "No source image. Set AICC_AVATAR_SOURCE_IMAGE in .env or pass source_image_path")
    if not drive:
        raise HTTPException(400,
            "No drive video. Set AICC_AVATAR_DRIVE_VIDEO in .env or pass drive_video_path")
    if not Path(source).exists():
        raise HTTPException(400, f"Source image not found: {source}")
    if not Path(drive).exists():
        raise HTTPException(400, f"Drive video not found: {drive}")

    out_name = req.output_path or str(OUTPUT_DIR / f"avatar-{uuid.uuid4().hex[:8]}.mp4")
    result   = run_liveportrait(source, drive, out_name)

    if not result["ok"]:
        raise HTTPException(500, result["error"])

    return {"ok": True, "path": result["path"]}


@app.post("/animate-b64")
async def animate_b64(req: AnimateB64Request):
    """Accept base64-encoded source image and drive video, generate avatar video."""
    with tempfile.TemporaryDirectory() as tmp:
        src_path   = os.path.join(tmp, f"source.{req.source_ext}")
        drive_path = os.path.join(tmp, f"drive.{req.drive_ext}")

        with open(src_path, "wb") as f:
            f.write(base64.b64decode(req.source_image_b64))
        with open(drive_path, "wb") as f:
            f.write(base64.b64decode(req.drive_video_b64))

        out_path = str(OUTPUT_DIR / f"avatar-{uuid.uuid4().hex[:8]}.mp4")
        result   = run_liveportrait(src_path, drive_path, out_path)

    if not result["ok"]:
        raise HTTPException(500, result["error"])

    # Return base64-encoded output for easy Node.js consumption
    with open(result["path"], "rb") as f:
        video_b64 = base64.b64encode(f.read()).decode()

    return {"ok": True, "path": result["path"], "video_b64": video_b64}


@app.post("/animate-upload")
async def animate_upload(
    source_image: UploadFile = File(...),
    drive_video:  UploadFile = File(...),
):
    """Multipart form upload: source image + drive video."""
    with tempfile.TemporaryDirectory() as tmp:
        src_path   = os.path.join(tmp, source_image.filename or "source.jpg")
        drive_path = os.path.join(tmp, drive_video.filename  or "drive.mp4")

        with open(src_path,   "wb") as f: f.write(await source_image.read())
        with open(drive_path, "wb") as f: f.write(await drive_video.read())

        out_path = str(OUTPUT_DIR / f"avatar-{uuid.uuid4().hex[:8]}.mp4")
        result   = run_liveportrait(src_path, drive_path, out_path)

    if not result["ok"]:
        raise HTTPException(500, result["error"])

    return {"ok": True, "path": result["path"]}


if __name__ == "__main__":
    log.info(f"Starting AICC LivePortrait Server on {HOST}:{PORT}")
    log.info(f"Output dir: {OUTPUT_DIR}")
    lp, lp_t = find_liveportrait()
    if lp:
        log.info(f"LivePortrait found: {lp} ({lp_t})")
    else:
        log.warning("LivePortrait NOT installed. Health check will report issue.")
        log.warning("Install: git clone https://github.com/KwaiYing/LivePortrait ~/liveportrait")
        log.warning("         cd ~/liveportrait && pip install -r requirements.txt")
    log.info("")
    log.info("Add to .env:")
    log.info("  AICC_LOCAL_AVATAR_URL=http://127.0.0.1:8011")
    log.info("  AICC_AVATAR_SOURCE_IMAGE=/path/to/your-headshot.jpg")
    log.info("  AICC_AVATAR_DRIVE_VIDEO=/path/to/your-talking-clip.mp4")
    uvicorn.run(app, host=HOST, port=PORT)
