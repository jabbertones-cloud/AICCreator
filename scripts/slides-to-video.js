#!/usr/bin/env node
"use strict";

/**
 * slides-to-video.js
 * Assemble hook slides + demo clips into final video (Reels/Shorts).
 * Uses ffmpeg to concatenate images (as video) + optional demo clips.
 *
 * Usage:
 *   node scripts/slides-to-video.js --manifest reports/carousel-manifest-latest.json --variant-id <uuid>
 *   node scripts/slides-to-video.js --slides slide1.png,slide2.png --duration 3 --output media/output/final.mp4
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const REPORTS = path.join(ROOT, "reports");
const MEDIA_OUT = path.join(ROOT, "media", "output");

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function hasFfmpeg() {
  try {
    execSync("which ffmpeg", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function imageToVideoSegment(imagePath, durationSec, outputPath) {
  execSync(
    `ffmpeg -y -loop 1 -i "${imagePath}" -t ${durationSec} -r 30 -pix_fmt yuv420p -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2" "${outputPath}"`,
    { stdio: "pipe" }
  );
}

function concatVideos(inputListPath, outputPath) {
  execSync(`ffmpeg -y -f concat -safe 0 -i "${inputListPath}" -c copy "${outputPath}"`, { stdio: "pipe" });
}

function main() {
  if (!hasFfmpeg()) {
    console.error("[slides-to-video] ffmpeg required");
    process.exit(1);
  }

  const manifestPath = arg("--manifest", path.join(REPORTS, "carousel-manifest-latest.json"));
  const variantId = arg("--variant-id", null);
  const slidesArg = arg("--slides", null);
  const durationPerSlide = parseInt(arg("--duration", "3"), 10) || 3;
  const outputPath = arg("--output", path.join(MEDIA_OUT, `${variantId || "slides"}-final.mp4`));

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  let slidePaths = [];
  if (slidesArg) {
    slidePaths = slidesArg.split(",").map((p) => path.resolve(p.trim()));
  } else if (manifestPath && fs.existsSync(manifestPath) && variantId) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const entry = Array.isArray(manifest) ? manifest.find((m) => m.variant_id === variantId) : null;
    if (entry && entry.slides) {
      slidePaths = entry.slides.map((s) => s.image_path).filter(Boolean);
    }
  }

  if (slidePaths.length === 0) {
    console.error("[slides-to-video] No slides. Use --slides or --manifest + --variant-id");
    process.exit(1);
  }

  const tempDir = path.join(require("os").tmpdir(), `slides-vid-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  const segments = [];
  for (let i = 0; i < slidePaths.length; i++) {
    const segPath = path.join(tempDir, `seg_${i}.mp4`);
    if (fs.existsSync(slidePaths[i])) {
      imageToVideoSegment(slidePaths[i], durationPerSlide, segPath);
      segments.push(segPath);
    }
  }

  if (segments.length === 0) {
    console.error("[slides-to-video] No valid segments");
    process.exit(1);
  }

  const listPath = path.join(tempDir, "list.txt");
  fs.writeFileSync(listPath, segments.map((p) => `file '${p}'`).join("\n"));

  concatVideos(listPath, outputPath);

  try {
    fs.rmSync(tempDir, { recursive: true });
  } catch {}

  console.log(`[slides-to-video] Output: ${outputPath}`);
}

main();
