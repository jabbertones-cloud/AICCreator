#!/usr/bin/env node
"use strict";

/**
 * scripts/content-creator-autopilot.js
 *
 * Main orchestrator for the content creation pipeline.
 * Runs every 2 hours (via PM2 ecosystem config).
 *
 * Flow:
 *   1. Generate weekly trends brief
 *   2. Run campaign engine with 3 variants
 *   3. Generate TTS audio (if ELEVENLABS_API_KEY set)
 *   4. Generate B-roll video (if video providers set)
 *   5. Extract clips from campaign
 *   6. Repurpose content for multiple platforms
 *   7. Auto-publish due items
 *   8. Run A/B testing loop
 *   9. Write summary to reports/autopilot-last-run.json
 *
 * Usage:
 *   node scripts/content-creator-autopilot.js
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const REPORTS = path.join(ROOT, "reports");

// Ensure reports directory exists
if (!fs.existsSync(REPORTS)) {
  fs.mkdirSync(REPORTS, { recursive: true });
}

/**
 * Run a script via spawnSync with proper error handling
 * @param {string} scriptPath - Path to the script file (relative to project root)
 * @param {string[]} args - CLI arguments to pass
 * @returns {object} { ok: boolean, status: number }
 */
function runScript(scriptPath, args = []) {
  const fullPath = path.join(ROOT, scriptPath);

  console.log(`[autopilot] running ${scriptPath} ${args.join(" ")}`);

  const result = spawnSync("node", [fullPath, ...args], {
    stdio: "inherit",
    cwd: ROOT,
  });

  const ok = result.status === 0;
  console.log(`[autopilot] ${scriptPath} finished with status ${result.status} (${ok ? "ok" : "failed"})`);

  return { ok, status: result.status };
}

/**
 * Safe JSON read with error handling
 * @param {string} filePath - Full path to JSON file
 * @returns {object|null} Parsed object or null if not found/invalid
 */
function readJSON(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      console.warn(`[autopilot] File not found: ${filePath}`);
      return null;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[autopilot] Failed to read JSON from ${filePath}: ${err.message}`);
    return null;
  }
}

/**
 * Safe JSON write with error handling
 * @param {string} filePath - Full path to JSON file
 * @param {object} data - Data to write
 * @returns {boolean} Success
 */
function writeJSON(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
    return true;
  } catch (err) {
    console.error(`[autopilot] Failed to write JSON to ${filePath}: ${err.message}`);
    return false;
  }
}

/**
 * Check if a file exists and has content
 * @param {string} filePath - Full path to file
 * @returns {boolean}
 */
function fileExists(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/**
 * Main orchestration loop
 */
async function main() {
  const startTime = new Date().toISOString();
  console.log(`[autopilot] starting content creator loop at ${startTime}`);

  const steps = [];
  let campaignData = null;
  let briefData = null;

  // Step 1: Generate weekly trends brief
  console.log("[autopilot] === STEP 1: Weekly Trends Brief ===");
  const trendsBriefResult = runScript("scripts/weekly-trends-brief.js", ["--rolling"]);
  steps.push({ step: "trends-brief", ok: trendsBriefResult.ok, status: trendsBriefResult.status });

  // Step 2: Run campaign engine
  console.log("[autopilot] === STEP 2: Campaign Engine (3 variants) ===");
  const campaignResult = runScript("scripts/aicc-campaign-engine.js", ["--variants", "3"]);
  steps.push({ step: "campaign-engine", ok: campaignResult.ok, status: campaignResult.status });

  // Step 3: Load campaign data
  const campaignPath = path.join(REPORTS, "aicc-campaign-latest.json");
  campaignData = readJSON(campaignPath);

  if (!campaignData) {
    console.error("[autopilot] ❌ Campaign JSON not found. Exiting gracefully.");
    const summaryPath = path.join(REPORTS, "autopilot-last-run.json");
    const summary = {
      ran_at: startTime,
      ended_at: new Date().toISOString(),
      steps_ok: steps.filter(s => s.ok).length,
      steps_failed: steps.filter(s => !s.ok).length,
      campaign_topic: null,
      error: "Campaign JSON not found after campaign engine",
      steps: steps,
    };
    writeJSON(summaryPath, summary);
    process.exit(0);
  }

  console.log(`[autopilot] Loaded campaign: ${campaignData.topic || "unknown"}`);

  // Step 4: Load brief if exists
  const briefPath = path.join(REPORTS, "content-creator-brief-latest.json");
  briefData = readJSON(briefPath);
  if (briefData) {
    console.log("[autopilot] Loaded brief data");
  }

  // Step 5: TTS generation (optional)
  if (process.env.ELEVENLABS_API_KEY) {
    console.log("[autopilot] === STEP 3: TTS Audio Generation ===");
    const ttsResult = runScript("agents/tts-agent.js", ["--campaign", campaignPath]);
    steps.push({ step: "tts-generation", ok: ttsResult.ok, status: ttsResult.status });
  } else {
    console.log("[autopilot] ⊘ TTS skipped (ELEVENLABS_API_KEY not set)");
    steps.push({ step: "tts-generation", ok: true, status: 0, skipped: true });
  }

  // Step 6: Video/B-roll generation (optional)
  if (process.env.HIGGSFIELD_API_KEY || process.env.PEXELS_API_KEY) {
    console.log("[autopilot] === STEP 4: Video/B-roll Generation ===");
    const videoResult = runScript("agents/video-gen-agent.js", ["--campaign", campaignPath]);
    steps.push({ step: "video-generation", ok: videoResult.ok, status: videoResult.status });
  } else {
    console.log("[autopilot] ⊘ Video generation skipped (no provider keys set)");
    steps.push({ step: "video-generation", ok: true, status: 0, skipped: true });
  }

  // Step 6b: Avatar video generation (optional)
  if (process.env.HEYGEN_API_KEY || process.env.DID_API_KEY) {
    console.log("[autopilot] === STEP 4b: Avatar Video Generation ===");
    const avatarResult = runScript("agents/avatar-agent.js", ["--campaign", campaignPath]);
    steps.push({ step: "avatar-generation", ok: avatarResult.ok, status: avatarResult.status });
  } else {
    console.log("[autopilot] ⊘ Avatar generation skipped (HEYGEN_API_KEY / DID_API_KEY not set)");
    steps.push({ step: "avatar-generation", ok: true, status: 0, skipped: true });
  }

  // Step 7: Clip extraction
  console.log("[autopilot] === STEP 5: Clip Extraction ===");
  const clipResult = runScript("scripts/clip-extractor.js", ["--campaign", campaignPath]);
  steps.push({ step: "clip-extraction", ok: clipResult.ok, status: clipResult.status });

  // Circuit breaker: check for video assets
  let hasVideoAsset = false;
  if (clipResult.ok) {
    const clipManifest = readJSON(path.join(REPORTS, "clip-manifest-latest.json"));
    hasVideoAsset = clipManifest && Array.isArray(clipManifest.clips) && clipManifest.clips.length > 0;
  }

  // Step 8: Content repurposing
  console.log("[autopilot] === STEP 6: Content Repurposing ===");
  const repurposeResult = runScript("scripts/content-repurpose.js", ["--campaign", campaignPath]);
  steps.push({ step: "content-repurpose", ok: repurposeResult.ok, status: repurposeResult.status });

  // Step 9: Auto-publish (with circuit breaker check)
  // Autopublish uses clip-manifest-latest.json for video paths when queue items have no video_asset.
  console.log("[autopilot] === STEP 7: Auto-publish ===");
  if (!clipResult.ok && !hasVideoAsset) {
    console.warn("[autopilot] ⚠️  CIRCUIT BREAKER: clip-extractor failed and no video assets found. Skipping auto-publish.");
    steps.push({ step: "auto-publish", ok: false, status: 1, reason: "circuit_breaker_engaged" });
  } else {
    // Ensure queue is populated; schedule uses clip manifest when --video not passed
    runScript("scripts/aicc-autopublish.js", [
      "schedule",
      "--campaign", campaignPath,
      "--platforms", "youtube,tiktok,instagram",
      "--spacing-min", "120",
      "--replace",
    ]);
    const publishResult = runScript("scripts/aicc-autopublish.js", ["run-due"]);
    steps.push({ step: "auto-publish", ok: publishResult.ok, status: publishResult.status });
  }

  // Step 10: A/B testing loop
  console.log("[autopilot] === STEP 8: A/B Testing Loop ===");
  const abResult = runScript("scripts/aicc-ab-loop.js", []);
  steps.push({ step: "ab-testing", ok: abResult.ok, status: abResult.status });

  // Write summary
  console.log("[autopilot] === SUMMARY ===");
  const endTime = new Date().toISOString();
  const summary = {
    ran_at: startTime,
    ended_at: endTime,
    steps_ok: steps.filter(s => s.ok && !s.skipped).length,
    steps_failed: steps.filter(s => !s.ok).length,
    steps_skipped: steps.filter(s => s.skipped).length,
    campaign_topic: campaignData.topic || null,
    campaign_id: campaignData.id || null,
    brief_topic: briefData && briefData.topic ? briefData.topic : null,
    steps: steps,
  };

  const summaryPath = path.join(REPORTS, "autopilot-last-run.json");
  writeJSON(summaryPath, summary);

  console.log(`[autopilot] loop complete at ${endTime}`);
  console.log(`[autopilot] Summary: ${summary.steps_ok} ok, ${summary.steps_failed} failed, ${summary.steps_skipped || 0} skipped`);

  return summary;
}

// Entry point
if (require.main === module) {
  main()
    .catch(err => {
      console.error("[autopilot] fatal:", err.message);
      console.error(err.stack);
      process.exit(1);
    });
}

module.exports = { runScript, readJSON, writeJSON, main };
