#!/usr/bin/env bash
# setup-local-video.sh
# One-time setup for local free video generation (Wan 2.1, LTX-2, HunyuanVideo)
# and LivePortrait avatar generation.
#
# Usage:
#   bash scripts/setup-local-video.sh
#   bash scripts/setup-local-video.sh --liveportrait   # also install LivePortrait
#   bash scripts/setup-local-video.sh --all            # everything

set -e

INSTALL_LP=false
for arg in "$@"; do
  case $arg in
    --liveportrait|--all) INSTALL_LP=true ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║        AICC Local Video Setup                               ║"
echo "║  Free alternatives to Higgsfield, HeyGen, D-ID, Runway     ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ── 1. Python check ────────────────────────────────────────────────────────────
echo "[1/4] Checking Python..."
if ! command -v python3 &>/dev/null; then
  echo "  ERROR: python3 not found. Install from https://python.org"
  exit 1
fi
PY_VERSION=$(python3 --version 2>&1)
echo "  ✓ $PY_VERSION"

# ── 2. pip install video server deps ─────────────────────────────────────────
echo ""
echo "[2/4] Installing local video server dependencies..."
echo "      (fastapi, uvicorn, diffusers, torch, transformers)"
echo ""

# Detect Apple Silicon
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ] && [ "$(uname -s)" = "Darwin" ]; then
  echo "  → Apple Silicon detected (MPS acceleration)"
  echo "  → Installing PyTorch with MPS support..."
  pip3 install --quiet torch torchvision \
    --index-url https://download.pytorch.org/whl/cpu || \
  pip3 install --quiet torch torchvision
else
  echo "  → Installing PyTorch (CPU/CUDA auto-detect)..."
  pip3 install --quiet torch torchvision || true
fi

pip3 install -r "$SCRIPT_DIR/requirements-local-video.txt" --quiet
echo "  ✓ Video server dependencies installed"

# ── 3. Verify server starts (dry-run) ─────────────────────────────────────────
echo ""
echo "[3/4] Verifying server can import..."
python3 -c "import fastapi, uvicorn, diffusers; print('  ✓ Imports OK')" || {
  echo "  WARNING: Some imports failed. Check output above."
}

# ── 4. LivePortrait (optional) ────────────────────────────────────────────────
if [ "$INSTALL_LP" = "true" ]; then
  echo ""
  echo "[4/4] Installing LivePortrait..."
  LP_DIR="$HOME/liveportrait"

  if [ -d "$LP_DIR" ]; then
    echo "  → LivePortrait already cloned at $LP_DIR — updating..."
    git -C "$LP_DIR" pull --quiet
  else
    echo "  → Cloning LivePortrait to $LP_DIR..."
    git clone --quiet https://github.com/KwaiYing/LivePortrait "$LP_DIR"
  fi

  if [ -f "$LP_DIR/requirements.txt" ]; then
    echo "  → Installing LivePortrait requirements..."
    pip3 install -r "$LP_DIR/requirements.txt" --quiet
  fi

  pip3 install -r "$SCRIPT_DIR/requirements-liveportrait.txt" --quiet
  echo "  ✓ LivePortrait installed at $LP_DIR"
else
  echo ""
  echo "[4/4] LivePortrait skipped (re-run with --liveportrait to install)"
fi

# ── Summary ────────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Setup complete!                                            ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "  Start video generation server (Wan 2.1 default):"
echo "    npm run aicc:video:server"
echo "    # or: python scripts/local-video-server.py"
echo ""
if [ "$INSTALL_LP" = "true" ]; then
echo "  Start LivePortrait avatar server:"
echo "    npm run aicc:avatar:server"
echo "    # or: python scripts/local-liveportrait-server.py"
echo ""
fi
echo "  Add to your .env:"
echo "    AICC_LOCAL_VIDEO_URL=http://127.0.0.1:8010"
echo "    AICC_LOCAL_VIDEO_MODEL=wan2.1     # wan2.1 | ltx2 | hunyuan | wan2.1-14b"
if [ "$INSTALL_LP" = "true" ]; then
echo "    AICC_LOCAL_AVATAR_URL=http://127.0.0.1:8011"
echo "    AICC_AVATAR_SOURCE_IMAGE=/path/to/your-headshot.jpg"
echo "    AICC_AVATAR_DRIVE_VIDEO=/path/to/talking-clip.mp4"
fi
echo ""
echo "  NOTE: Model weights download automatically on first generation."
echo "  Wan 2.1 1.3B = ~3GB, Wan 2.1 14B = ~28GB, LTX-2 = ~25GB"
echo ""
