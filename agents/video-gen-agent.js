#!/usr/bin/env node
"use strict";

/**
 * agents/video-gen-agent.js
 *
 * Video and B-roll generation agent. Generates or fetches video clips per scene plan keyword.
 *
 * Provider priority (first available wins):
 *   1. Local AI server  (AICC_LOCAL_VIDEO_URL) — Wan 2.1 / LTX-2 / HunyuanVideo, FREE
 *        Start with: python scripts/local-video-server.py
 *   2. Higgsfield AI    (HIGGSFIELD_API_KEY)   — paid, high-quality AI generation
 *   3. Pexels           (PEXELS_API_KEY)       — royalty-free stock clips, free tier
 *
 * Usage:
 *   node agents/video-gen-agent.js --campaign reports/aicc-campaign-latest.json
 *
 * Environment variables:
 *   AICC_LOCAL_VIDEO_URL   — http://127.0.0.1:8010  (local-video-server.py)
 *   AICC_LOCAL_VIDEO_MODEL — wan2.1 | ltx2 | hunyuan (default: wan2.1)
 *   HIGGSFIELD_API_KEY     — Higgsfield AI API key
 *   PEXELS_API_KEY         — Pexels API key
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const REPORTS = path.join(ROOT, "reports");
const MEDIA_DIR = path.join(ROOT, "media", "broll");

// Ensure media directory exists
if (!fs.existsSync(MEDIA_DIR)) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  console.log(`[video-gen] Created media directory: ${MEDIA_DIR}`);
}

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

/**
 * Make HTTPS request and stream response to file or return as buffer
 * @param {string} method - HTTP method
 * @param {string} hostname - API hostname
 * @param {string} pathname - URL path
 * @param {object} headers - Request headers
 * @param {string|object} body - Request body
 * @returns {Promise<{status: number, data: Buffer|string}>}
 */
function httpsRequest(method, hostname, pathname, headers, body) {
  return new Promise((resolve, reject) => {
    const options = {
      method,
      hostname,
      path: pathname,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
    };

    let bodyStr = body;
    if (body && typeof body === "object") {
      bodyStr = JSON.stringify(body);
    }

    if (bodyStr) {
      options.headers["Content-Length"] = Buffer.byteLength(bodyStr);
    }

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", chunk => {
        chunks.push(chunk);
      });
      res.on("end", () => {
        const data = Buffer.concat(chunks);
        resolve({ status: res.statusCode, data });
      });
    });

    req.on("error", reject);

    if (bodyStr) {
      req.write(bodyStr);
    }
    req.end();
  });
}

/**
 * Download file from URL via HTTPS
 * @param {string} url - Full HTTPS URL
 * @param {string} outputPath - Path to save file
 * @returns {Promise<boolean>} Success
 */
function downloadFile(url, outputPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outputPath);
    https.get(url, (res) => {
      res.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve(true);
      });
    }).on("error", (err) => {
      fs.unlink(outputPath, () => {});
      reject(err);
    });
  });
}

/**
 * Generate video using Higgsfield AI
 * @param {string} prompt - Text prompt describing video
 * @param {string} outputPath - Path to save MP4 file
 * @returns {Promise<{ok: boolean, path?: string, error?: string}>}
 */
async function higgsfieldGenerate(prompt, outputPath) {
  try {
    const apiKey = process.env.HIGGSFIELD_API_KEY;
    if (!apiKey) {
      return { ok: false, error: "HIGGSFIELD_API_KEY not set" };
    }

    const baseUrl = process.env.HIGGSFIELD_API_URL || "https://api.higgsfield.ai/v1/video";
    const headers = {
      Authorization: `Bearer ${apiKey}`,
    };
    const body = {
      prompt,
      aspect_ratio: "9:16",
      duration: 5,
      quality: "standard",
    };

    console.log(`[video-gen] Requesting Higgsfield generation: "${prompt.substring(0, 50)}..."`);
    const response = await httpsRequest("POST", "api.higgsfield.ai", "/v1/video/generate", headers, body);

    if (response.status !== 200 && response.status !== 201) {
      return { ok: false, error: `Higgsfield API error ${response.status}` };
    }

    let jobData;
    try {
      jobData = JSON.parse(response.data.toString());
    } catch {
      return { ok: false, error: "Failed to parse Higgsfield response" };
    }

    const jobId = jobData.id || jobData.video_id;
    if (!jobId) {
      return { ok: false, error: "No job ID in Higgsfield response" };
    }

    console.log(`[video-gen] Job created: ${jobId}, polling for completion...`);

    // Poll for completion (up to 60s, every 5s)
    let completed = false;
    let videoUrl = null;
    const maxAttempts = 12; // 60s total

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5s

      const pollResponse = await httpsRequest("GET", "api.higgsfield.ai", `/v1/video/${jobId}`, headers, null);

      if (pollResponse.status === 200) {
        let pollData;
        try {
          pollData = JSON.parse(pollResponse.data.toString());
        } catch {
          continue;
        }

        if (pollData.status === "completed" && pollData.video_url) {
          videoUrl = pollData.video_url;
          completed = true;
          console.log(`[video-gen] Video ready: ${videoUrl}`);
          break;
        } else if (pollData.status === "failed") {
          return { ok: false, error: `Higgsfield job failed: ${pollData.error || "unknown"}` };
        }
      }
    }

    if (!completed) {
      return { ok: false, error: "Higgsfield generation timeout" };
    }

    // Download video
    try {
      await downloadFile(videoUrl, outputPath);
      console.log(`[video-gen] ✓ Saved Higgsfield video to ${outputPath}`);
      return { ok: true, path: outputPath };
    } catch (err) {
      return { ok: false, error: `Download failed: ${err.message}` };
    }
  } catch (err) {
    return { ok: false, error: `Higgsfield generation failed: ${err.message}` };
  }
}

/**
 * Fetch video from Pexels API
 * @param {string} keyword - Search keyword
 * @param {string} outputPath - Path to save MP4 file
 * @returns {Promise<{ok: boolean, path?: string, error?: string}>}
 */
async function pexelsFetchVideo(keyword, outputPath) {
  try {
    const apiKey = process.env.PEXELS_API_KEY;
    if (!apiKey) {
      return { ok: false, error: "PEXELS_API_KEY not set" };
    }

    const searchQuery = encodeURIComponent(keyword);
    const pathname = `/videos/search?query=${searchQuery}&per_page=1&orientation=portrait`;
    const headers = {
      Authorization: apiKey,
    };

    console.log(`[video-gen] Searching Pexels for: "${keyword}"`);
    const response = await httpsRequest("GET", "api.pexels.com", pathname, headers, null);

    if (response.status !== 200) {
      return { ok: false, error: `Pexels API error ${response.status}` };
    }

    let searchData;
    try {
      searchData = JSON.parse(response.data.toString());
    } catch {
      return { ok: false, error: "Failed to parse Pexels response" };
    }

    if (!searchData.videos || searchData.videos.length === 0) {
      return { ok: false, error: `No videos found for "${keyword}"` };
    }

    const video = searchData.videos[0];
    const videoFiles = video.video_files || [];
    if (videoFiles.length === 0) {
      return { ok: false, error: "Video has no downloadable files" };
    }

    const videoFile = videoFiles[0];
    const videoUrl = videoFile.link;

    if (!videoUrl) {
      return { ok: false, error: "No download link found" };
    }

    console.log(`[video-gen] Found video: ${video.url}`);
    console.log(`[video-gen] Downloading from: ${videoUrl}`);

    try {
      await downloadFile(videoUrl, outputPath);
      console.log(`[video-gen] ✓ Saved Pexels video to ${outputPath}`);
      return { ok: true, path: outputPath };
    } catch (err) {
      return { ok: false, error: `Download failed: ${err.message}` };
    }
  } catch (err) {
    return { ok: false, error: `Pexels fetch failed: ${err.message}` };
  }
}

/**
 * Generate or fetch B-roll for a keyword using available providers
 * @param {string} keyword - Keyword/prompt for video
 * @param {string} outputPath - Output MP4 path
 * @returns {Promise<{ok: boolean, path?: string, error?: string}>}
 */
/**
 * Local AI video generation via local-video-server.py
 * Supports: Wan 2.1 (default), LTX-2, HunyuanVideo
 * Start server: python scripts/local-video-server.py
 */
async function localVideoGenerate(prompt, outputPath) {
  const baseUrl = process.env.AICC_LOCAL_VIDEO_URL;
  if (!baseUrl) return { ok: false, error: "AICC_LOCAL_VIDEO_URL not set" };

  const { URL: NodeURL } = require("url");
  const http  = require("http");
  const https = require("https");

  const parsed  = new NodeURL(`${baseUrl}/generate`);
  const lib     = parsed.protocol === "https:" ? https : http;
  const model   = process.env.AICC_LOCAL_VIDEO_MODEL || "wan2.1";
  const bodyObj = { prompt, model };
  const bodyStr = JSON.stringify(bodyObj);

  return new Promise((resolve) => {
    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path:     parsed.pathname,
      method:   "POST",
      headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) },
    };
    const req = lib.request(opts, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try {
          const body = JSON.parse(raw);
          if (res.statusCode !== 200 || !body.ok) {
            return resolve({ ok: false, error: body.detail || body.error || `HTTP ${res.statusCode}` });
          }
          // If the path is on a different machine, just copy filename to local
          const remoteP = body.path;
          if (remoteP && fs.existsSync(remoteP)) {
            fs.copyFileSync(remoteP, outputPath);
            console.log(`[video-gen] ✓ Local AI (${model}) → ${outputPath} (${body.elapsed}s)`);
            return resolve({ ok: true, path: outputPath, model, elapsed: body.elapsed });
          }
          // Remote server — the path is on the server, not locally accessible
          // Return the server path (caller can use it or NFS-mount it)
          console.log(`[video-gen] ✓ Local AI (${model}) → ${remoteP} (${body.elapsed}s)`);
          resolve({ ok: true, path: remoteP, model, elapsed: body.elapsed });
        } catch {
          resolve({ ok: false, error: `local video server bad response: ${raw.slice(0, 200)}` });
        }
      });
    });
    req.on("error", (err) => resolve({ ok: false, error: `local video server unreachable: ${err.message}` }));
    req.setTimeout(600000, () => { req.destroy(); resolve({ ok: false, error: "local video server timeout (600s)" }); });
    req.write(bodyStr);
    req.end();
  });
}

/**
 * generateBroll — provider waterfall:
 *   1. Local AI server (Wan 2.1 / LTX-2 / HunyuanVideo) — FREE
 *   2. Higgsfield AI   — paid
 *   3. Pexels          — stock, free tier
 */
async function generateBroll(keyword, outputPath) {
  if (!keyword) {
    return { ok: false, error: "No keyword provided" };
  }

  // 1. Local AI (no usage limits, runs on own hardware)
  if (process.env.AICC_LOCAL_VIDEO_URL) {
    const result = await localVideoGenerate(keyword, outputPath);
    if (result.ok) return result;
    console.warn(`[video-gen] Local AI failed (${result.error}), falling through to next provider`);
  }

  // 2. Higgsfield AI (paid)
  if (process.env.HIGGSFIELD_API_KEY) {
    return higgsfieldGenerate(keyword, outputPath);
  }

  // 3. Pexels stock (free tier, royalty-free)
  if (process.env.PEXELS_API_KEY) {
    return pexelsFetchVideo(keyword, outputPath);
  }

  return {
    ok: false,
    error: [
      "No video provider configured. Options:",
      "  • AICC_LOCAL_VIDEO_URL=http://127.0.0.1:8010  (free — start: python scripts/local-video-server.py)",
      "  • HIGGSFIELD_API_KEY                           (paid AI generation)",
      "  • PEXELS_API_KEY                               (free stock clips)",
    ].join("\n"),
  };
}

/**
 * Main entry point
 */
async function main() {
  const campaignPath = arg("--campaign", path.join(REPORTS, "aicc-campaign-latest.json"));

  // Load campaign
  let campaign;
  try {
    if (!fs.existsSync(campaignPath)) {
      console.error(`[video-gen] Campaign not found: ${campaignPath}`);
      process.exit(1);
    }
    campaign = JSON.parse(fs.readFileSync(campaignPath, "utf8"));
  } catch (err) {
    console.error(`[video-gen] Failed to load campaign: ${err.message}`);
    process.exit(1);
  }

  console.log(`[video-gen] Processing campaign with ${campaign.variants.length} variants`);

  const manifest = [];
  let successCount = 0;
  let failureCount = 0;

  // Process each variant
  for (const variant of campaign.variants) {
    const variantBeats = [];

    // Extract beat plan from scene_quality.
    // Supports two formats:
    //   1. scene_quality.beat_plan = [{keyword, broll_cue}, ...]  (legacy)
    //   2. scene_quality.body.broll = [{cue, keyword}, ...]       (campaign-engine format)
    let beatPlan = [];
    const sq = variant.scene_quality || {};
    if (Array.isArray(sq.beat_plan) && sq.beat_plan.length > 0) {
      beatPlan = sq.beat_plan;
    } else if (sq.body && Array.isArray(sq.body.broll) && sq.body.broll.length > 0) {
      beatPlan = sq.body.broll.map(b => ({ keyword: b.keyword, broll_cue: b.keyword }));
    } else if (variant.hook || variant.body) {
      // Fallback: extract keywords from hook/body text
      const text = [variant.hook || "", variant.body || "", variant.niche_pack || ""].join(" ");
      const words = text.split(/\W+/).filter(w => w.length > 4).slice(0, 5);
      beatPlan = words.map(w => ({ keyword: w, broll_cue: w }));
    }

    if (beatPlan.length === 0) {
      console.warn(`[video-gen] Variant ${variant.id} has no beat plan, skipping`);
      manifest.push({
        variant_id: variant.id,
        beats: [],
        ok: false,
        reason: "no_beat_plan",
      });
      failureCount++;
      continue;
    }

    // Process each beat
    for (let beatIdx = 0; beatIdx < beatPlan.length; beatIdx++) {
      const beat = beatPlan[beatIdx];
      const brollCue = beat.broll_cue || beat.keyword || variant.niche_pack || "generic scene";

      const outputPath = path.join(MEDIA_DIR, `${variant.id}-beat-${beatIdx}.mp4`);

      console.log(`[video-gen] Processing variant ${variant.id} beat ${beatIdx}: "${brollCue}"`);
      const result = await generateBroll(brollCue, outputPath);

      if (result.ok) {
        variantBeats.push({
          beat_index: beatIdx,
          broll_cue: brollCue,
          mp4_path: result.path,
          ok: true,
        });
        successCount++;
      } else {
        console.error(`[video-gen] Failed for beat ${beatIdx}: ${result.error}`);
        variantBeats.push({
          beat_index: beatIdx,
          broll_cue: brollCue,
          mp4_path: null,
          ok: false,
          error: result.error,
        });
        failureCount++;
      }
    }

    manifest.push({
      variant_id: variant.id,
      total_beats: beatPlan.length,
      success_count: variantBeats.filter(b => b.ok).length,
      beats: variantBeats,
    });
  }

  // Write manifest
  const manifestPath = path.join(REPORTS, "broll-manifest-latest.json");
  const manifestData = {
    generated_at: new Date().toISOString(),
    campaign_id: campaign.id || null,
    total_variants: manifest.length,
    success_count: successCount,
    failure_count: failureCount,
    variants: manifest,
  };

  try {
    fs.writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2), "utf8");
    console.log(`[video-gen] Manifest saved to ${manifestPath}`);
  } catch (err) {
    console.error(`[video-gen] Failed to write manifest: ${err.message}`);
  }

  console.log(`[video-gen] Complete: ${successCount} success, ${failureCount} failed`);
  process.exit(failureCount > 0 ? 1 : 0);
}

// Entry point
if (require.main === module) {
  main()
    .catch(err => {
      console.error("[video-gen] Fatal:", err.message);
      console.error(err.stack);
      process.exit(1);
    });
}

module.exports = { higgsfieldGenerate, pexelsFetchVideo, generateBroll, main };
