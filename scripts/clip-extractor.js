"use strict";
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { execSync, spawnSync } = require("child_process");

// Configuration
const ROOT = path.join(__dirname, "..");
const REPORTS = path.join(ROOT, "reports");
const OUTPUT_DIR = path.join(ROOT, "media", "output");

// Ensure output directory exists
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

/**
 * Parse CLI argument by flag name
 * @param {string} flag - Flag name (e.g., "campaign")
 * @param {string} fallback - Default value if flag not provided
 * @returns {string} Argument value or fallback
 */
function arg(flag, fallback) {
  const index = process.argv.indexOf(`--${flag}`);
  if (index > -1 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

/**
 * Check if FFmpeg is available on the system
 * @returns {boolean} True if ffmpeg command is available
 */
function ffmpegAvailable() {
  try {
    execSync("ffmpeg -version", { stdio: "pipe" });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Assemble a single clip from campaign variant, TTS audio, B-roll videos, or avatar video
 * @param {object} variant - Campaign variant with id, title, hook, etc.
 * @param {object} ttsEntry - TTS manifest entry with mp3_path
 * @param {array} brollEntries - Array of B-roll manifest entries with mp4_path
 * @param {string|null} avatarPath - Optional path to avatar video (preferred when available)
 * @returns {promise<object>} Result object with ok status, path, and variant_id
 */
async function assembleClip(variant, ttsEntry, brollEntries = [], avatarPath = null) {
  const variant_id = variant.id;
  const outputPath = path.join(OUTPUT_DIR, `${variant_id}-final.mp4`);

  try {
    // Prefer avatar video when available (full video with audio)
    if (avatarPath && fs.existsSync(avatarPath)) {
      fs.copyFileSync(avatarPath, outputPath);
      console.log(`[assembleClip] Used avatar video for ${variant_id}`);
      return { ok: true, path: outputPath, variant_id };
    }

    // Get TTS audio path
    const audioPath = ttsEntry ? ttsEntry.mp3_path : null;
    const brollPaths = brollEntries
      .filter(e => e && e.mp4_path && fs.existsSync(e.mp4_path))
      .map(e => e.mp4_path);

    if (!audioPath || !fs.existsSync(audioPath)) {
      console.warn(`[assembleClip] Missing TTS audio for variant ${variant_id}`);
      return { ok: false, path: outputPath, variant_id, error: "Missing TTS audio" };
    }

    let ffmpegArgs = [];

    // Case 1: B-roll videos available
    if (brollPaths.length > 0) {
      // Build FFmpeg input arguments for all B-roll clips
      brollPaths.forEach(brollPath => {
        ffmpegArgs.push("-i", brollPath);
      });

      // Add audio input
      ffmpegArgs.push("-i", audioPath);

      // Build concat filter if multiple clips
      if (brollPaths.length > 1) {
        let filterComplex = "";
        for (let i = 0; i < brollPaths.length; i++) {
          filterComplex += `[${i}:v]`;
        }
        filterComplex += `concat=n=${brollPaths.length}:v=1:a=0[v]`;

        ffmpegArgs.push("-filter_complex", filterComplex);
        ffmpegArgs.push("-map", "[v]");
      } else {
        // Single B-roll: just map the video
        ffmpegArgs.push("-map", "0:v");
      }

      // Map audio and set output options
      ffmpegArgs.push(
        "-map",
        `${brollPaths.length}:a`,
        "-shortest",
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "128k"
      );
    } else {
      // Case 2: No B-roll available, create text-only video with colored background
      console.log(`[assembleClip] No B-roll available for ${variant_id}, using text overlay`);

      const title = (variant.title || variant.id).replace(/'/g, "\\'");
      const width = 1080;
      const height = 1920;
      const framerate = 30;

      ffmpegArgs.push(
        "-f", "lavfi",
        "-i", `color=c=black:s=${width}x${height}:r=${framerate}`,
        "-i", audioPath,
        "-vf", `drawtext=text='${title}':fontsize=60:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:line_spacing=10`,
        "-shortest",
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "128k"
      );
    }

    // Add output path and overwrite flag
    ffmpegArgs.push("-y", outputPath);

    // Execute FFmpeg
    const result = spawnSync("ffmpeg", ffmpegArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300000 // 5 minute timeout
    });

    if (result.status !== 0) {
      const stderr = result.stderr ? result.stderr.toString() : "Unknown error";
      console.error(`[assembleClip] FFmpeg failed for ${variant_id}:`, stderr);
      return { ok: false, path: outputPath, variant_id, error: "FFmpeg encoding failed" };
    }

    if (!fs.existsSync(outputPath)) {
      console.error(`[assembleClip] Output file not created for ${variant_id}`);
      return { ok: false, path: outputPath, variant_id, error: "Output file not created" };
    }

    console.log(`[assembleClip] Successfully assembled clip: ${variant_id}`);
    return { ok: true, path: outputPath, variant_id };
  } catch (error) {
    console.error(`[assembleClip] Exception for ${variant_id}:`, error.message);
    return { ok: false, path: outputPath, variant_id, error: error.message };
  }
}

/**
 * Main entry point
 * Loads campaign and manifests, assembles clips for all variants
 */
async function main() {
  console.log("[clip-extractor] Starting clip assembly pipeline...");

  // Load campaign
  const campaignPath = arg("campaign", path.join(REPORTS, "aicc-campaign-latest.json"));
  if (!fs.existsSync(campaignPath)) {
    console.error(`[clip-extractor] Campaign file not found: ${campaignPath}`);
    process.exit(1);
  }
  const campaign = JSON.parse(fs.readFileSync(campaignPath, "utf8"));
  console.log(`[clip-extractor] Loaded campaign with ${campaign.variants.length} variants`);

  // Load TTS manifest
  const ttsManifestPath = path.join(REPORTS, "tts-manifest-latest.json");
  let ttsManifest = {};
  if (fs.existsSync(ttsManifestPath)) {
    try {
      const ttsData = JSON.parse(fs.readFileSync(ttsManifestPath, "utf8"));
      // Index by variant_id for easy lookup
      if (Array.isArray(ttsData)) {
        ttsData.forEach(entry => {
          if (entry.variant_id) ttsManifest[entry.variant_id] = entry;
        });
      }
      console.log(`[clip-extractor] Loaded TTS manifest with ${Object.keys(ttsManifest).length} entries`);
    } catch (e) {
      console.warn(`[clip-extractor] Failed to parse TTS manifest: ${e.message}`);
    }
  } else {
    console.warn("[clip-extractor] TTS manifest not found, proceeding without audio");
  }

  // Load avatar manifest (optional - avatar video used as final when available)
  const avatarManifestPath = path.join(REPORTS, "avatar-manifest-latest.json");
  let avatarManifest = {};
  if (fs.existsSync(avatarManifestPath)) {
    try {
      const avatarData = JSON.parse(fs.readFileSync(avatarManifestPath, "utf8"));
      const results = avatarData.results || avatarData;
      if (Array.isArray(results)) {
        results.forEach((entry) => {
          if (entry.variant_id && entry.status === "completed" && entry.video_path && fs.existsSync(entry.video_path)) {
            avatarManifest[entry.variant_id] = entry.video_path;
          }
        });
      }
      if (Object.keys(avatarManifest).length > 0) {
        console.log(`[clip-extractor] Loaded avatar manifest with ${Object.keys(avatarManifest).length} variants`);
      }
    } catch (e) {
      console.warn(`[clip-extractor] Failed to parse avatar manifest: ${e.message}`);
    }
  }

  // Load B-roll manifest
  const brollManifestPath = path.join(REPORTS, "broll-manifest-latest.json");
  let brollManifest = {};
  if (fs.existsSync(brollManifestPath)) {
    try {
      const brollData = JSON.parse(fs.readFileSync(brollManifestPath, "utf8"));
      // Index by variant_id for easy lookup (may have multiple entries per variant)
      if (Array.isArray(brollData)) {
        brollData.forEach(entry => {
          if (entry.variant_id) {
            if (!brollManifest[entry.variant_id]) {
              brollManifest[entry.variant_id] = [];
            }
            brollManifest[entry.variant_id].push(entry);
          }
        });
      }
      console.log(`[clip-extractor] Loaded B-roll manifest with ${Object.keys(brollManifest).length} variants`);
    } catch (e) {
      console.warn(`[clip-extractor] Failed to parse B-roll manifest: ${e.message}`);
    }
  } else {
    console.warn("[clip-extractor] B-roll manifest not found");
  }

  // Check FFmpeg availability
  if (!ffmpegAvailable()) {
    console.error("[clip-extractor] FFmpeg is not available on this system");
    console.error("[clip-extractor] Install FFmpeg: https://ffmpeg.org/download.html");
    process.exit(1);
  }
  console.log("[clip-extractor] FFmpeg is available");

  // Assemble clips for each variant
  const results = [];
  for (const variant of campaign.variants) {
    console.log(`[clip-extractor] Processing variant: ${variant.id}`);
    const ttsEntry = ttsManifest[variant.id];
    const brollEntries = brollManifest[variant.id] || [];
    const avatarPath = avatarManifest[variant.id] || null;

    const result = await assembleClip(variant, ttsEntry, brollEntries, avatarPath);
    results.push(result);
  }

  // Write clip manifest
  const clipManifestPath = path.join(REPORTS, "clip-manifest-latest.json");
  fs.writeFileSync(clipManifestPath, JSON.stringify(results, null, 2));
  console.log(`[clip-extractor] Wrote clip manifest to ${clipManifestPath}`);

  // Summary
  const successCount = results.filter(r => r.ok).length;
  console.log(`[clip-extractor] Completed: ${successCount}/${results.length} clips assembled successfully`);

  if (successCount < results.length) {
    console.warn(`[clip-extractor] ${results.length - successCount} clips failed`);
    process.exit(1);
  }
}

// Execute main with error handling
main().catch(error => {
  console.error("[clip-extractor] Fatal error:", error);
  process.exit(1);
});
