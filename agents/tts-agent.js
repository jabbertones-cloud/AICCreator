#!/usr/bin/env node
"use strict";

/**
 * agents/tts-agent.js
 *
 * Text-to-speech agent. Converts content variant scripts to MP3 voice files.
 *
 * Supports two providers:
 *   - ElevenLabs (preferred if ELEVENLABS_API_KEY set)
 *   - OpenAI TTS (fallback if OPENAI_API_KEY set)
 *
 * Usage:
 *   node agents/tts-agent.js --campaign reports/aicc-campaign-latest.json
 *
 * Environment variables:
 *   ELEVENLABS_API_KEY - Required for ElevenLabs provider
 *   ELEVENLABS_VOICE_ID - Voice ID (default: "21m00Tcm4TlvDq8ikWAM" = Rachel)
 *   OPENAI_API_KEY - Required for OpenAI fallback
 *   AICC_TTS_VOICE - OpenAI voice (default: "onyx")
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = path.join(__dirname, "..");
const REPORTS = path.join(ROOT, "reports");

// Ensure reports directory exists
if (!fs.existsSync(REPORTS)) {
  fs.mkdirSync(REPORTS, { recursive: true });
}

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

/**
 * Make HTTPS request and get response as buffer/string
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
 * Generate speech using ElevenLabs API
 * @param {string} text - Text to synthesize
 * @param {string} voiceId - ElevenLabs voice ID
 * @param {string} outputPath - Path to save MP3 file
 * @returns {Promise<{ok: boolean, path?: string, error?: string}>}
 */
async function elevenLabsTTS(text, voiceId, outputPath) {
  try {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      return { ok: false, error: "ELEVENLABS_API_KEY not set" };
    }

    const pathname = `/v1/text-to-speech/${voiceId}/stream`;
    const headers = {
      "xi-api-key": apiKey,
      Accept: "audio/mpeg",
    };
    const body = {
      text,
      model_id: "eleven_monolingual_v1",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
      },
    };

    console.log(`[tts-agent] Requesting ElevenLabs TTS for voice ${voiceId}...`);
    const response = await httpsRequest("POST", "api.elevenlabs.io", pathname, headers, body);

    if (response.status !== 200) {
      return { ok: false, error: `ElevenLabs API error ${response.status}: ${response.data.toString()}` };
    }

    // Write MP3 file
    fs.writeFileSync(outputPath, response.data);
    console.log(`[tts-agent] ✓ Saved ElevenLabs TTS to ${outputPath}`);
    return { ok: true, path: outputPath };
  } catch (err) {
    return { ok: false, error: `ElevenLabs TTS failed: ${err.message}` };
  }
}

/**
 * Generate speech using OpenAI TTS API
 * @param {string} text - Text to synthesize
 * @param {string} outputPath - Path to save MP3 file
 * @returns {Promise<{ok: boolean, path?: string, error?: string}>}
 */
async function openaiTTS(text, outputPath) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return { ok: false, error: "OPENAI_API_KEY not set" };
    }

    const voice = process.env.AICC_TTS_VOICE || "onyx";
    const headers = {
      Authorization: `Bearer ${apiKey}`,
    };
    const body = {
      model: "tts-1-hd",
      input: text,
      voice: voice,
      response_format: "mp3",
    };

    console.log(`[tts-agent] Requesting OpenAI TTS with voice ${voice}...`);
    const response = await httpsRequest("POST", "api.openai.com", "/v1/audio/speech", headers, body);

    if (response.status !== 200) {
      return { ok: false, error: `OpenAI API error ${response.status}: ${response.data.toString()}` };
    }

    // Write MP3 file
    fs.writeFileSync(outputPath, response.data);
    console.log(`[tts-agent] ✓ Saved OpenAI TTS to ${outputPath}`);
    return { ok: true, path: outputPath };
  } catch (err) {
    return { ok: false, error: `OpenAI TTS failed: ${err.message}` };
  }
}

/**
 * Local TTS via macOS `say` command (free, no API key needed).
 * Outputs AIFF, then converts to MP3 via ffmpeg if available.
 * Set AICC_TTS_VOICE_MACOS to override the voice (default: Samantha).
 * List available voices: say -v ?
 */
async function macOsTTS(text, outputPath) {
  const { execFileSync } = require("child_process");
  const voiceName = process.env.AICC_TTS_VOICE_MACOS || "Samantha";
  const aiffPath  = outputPath.replace(/\.mp3$/, ".aiff");

  try {
    execFileSync("say", ["-v", voiceName, "-o", aiffPath, text], { stdio: "pipe" });
  } catch (err) {
    return { ok: false, error: `macOS say failed: ${err.message}` };
  }

  // Try to convert AIFF → MP3 via ffmpeg
  try {
    execFileSync("ffmpeg", ["-y", "-i", aiffPath, "-codec:a", "libmp3lame", "-qscale:a", "2", outputPath], { stdio: "pipe" });
    try { fs.unlinkSync(aiffPath); } catch {}
    console.log(`[tts-agent] ✓ macOS TTS → ${outputPath}`);
    return { ok: true, path: outputPath };
  } catch {
    // ffmpeg not available — serve the AIFF as-is
    console.log(`[tts-agent] ✓ macOS TTS → ${aiffPath} (install ffmpeg to get mp3 conversion)`);
    return { ok: true, path: aiffPath };
  }
}

/**
 * Local HTTP TTS server (piper-tts, kokoro-fastapi, whisper-tts, etc.)
 * Set AICC_LOCAL_TTS_URL=http://localhost:5000/synthesize
 * Or set AICC_LOCAL_TTS_OPENAI_COMPAT=true for OpenAI /v1/audio/speech format
 * Popular local options:
 *   - piper:  https://github.com/rhasspy/piper  (fast, high-quality)
 *   - kokoro: https://github.com/hexgrad/kokoro (excellent quality)
 *   - coqui:  https://github.com/coqui-ai/TTS
 */
async function localHttpTTS(text, outputPath) {
  const baseUrl  = process.env.AICC_LOCAL_TTS_URL;
  const isOpenAI = process.env.AICC_LOCAL_TTS_OPENAI_COMPAT === "true";
  if (!baseUrl) return { ok: false, error: "AICC_LOCAL_TTS_URL not set" };

  const { URL: NodeURL } = require("url");
  const http  = require("http");
  const https = require("https");

  const parsed  = new NodeURL(baseUrl);
  const lib     = parsed.protocol === "https:" ? https : http;
  const voice   = process.env.AICC_TTS_VOICE || "default";
  const bodyObj = isOpenAI
    ? { model: "tts-1", input: text, voice, response_format: "mp3" }
    : { text, voice };
  const bodyStr = JSON.stringify(bodyObj);

  return new Promise((resolve) => {
    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path:     parsed.pathname + (parsed.search || ""),
      method:   "POST",
      headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) },
    };
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          return resolve({ ok: false, error: `local TTS returned HTTP ${res.statusCode}` });
        }
        fs.writeFileSync(outputPath, Buffer.concat(chunks));
        console.log(`[tts-agent] ✓ Local TTS → ${outputPath}`);
        resolve({ ok: true, path: outputPath });
      });
    });
    req.on("error", (err) => resolve({ ok: false, error: `local TTS request failed: ${err.message}` }));
    req.write(bodyStr);
    req.end();
  });
}

/**
 * Synthesize script text to audio using available provider.
 * Priority order:
 *   1. ElevenLabs  (ELEVENLABS_API_KEY)         — best quality, paid
 *   2. OpenAI TTS  (OPENAI_API_KEY)              — great quality, paid
 *   3. Local HTTP  (AICC_LOCAL_TTS_URL)          — piper/kokoro/coqui local server
 *   4. macOS say   (AICC_TTS_PROVIDER=local)     — free, always available on Mac
 *
 * To force local TTS: set AICC_TTS_PROVIDER=local
 * @param {string} scriptText - Full script to synthesize
 * @param {string} outputPath - Output MP3 path
 * @returns {Promise<{ok: boolean, path?: string, error?: string}>}
 */
async function synthesizeScript(scriptText, outputPath) {
  const provider = (process.env.AICC_TTS_PROVIDER || "").toLowerCase();

  // Explicit local override
  if (provider === "local" || provider === "macos" || provider === "say") {
    return macOsTTS(scriptText, outputPath);
  }
  if (provider === "local-http") {
    return localHttpTTS(scriptText, outputPath);
  }

  // Try ElevenLabs first
  if (process.env.ELEVENLABS_API_KEY) {
    const voiceId = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
    return elevenLabsTTS(scriptText, voiceId, outputPath);
  }

  // Fall back to OpenAI
  if (process.env.OPENAI_API_KEY) {
    return openaiTTS(scriptText, outputPath);
  }

  // Local HTTP TTS server (e.g. piper-tts, kokoro-fastapi)
  if (process.env.AICC_LOCAL_TTS_URL) {
    return localHttpTTS(scriptText, outputPath);
  }

  // macOS say as last resort (always available on Mac, no API needed)
  if (process.platform === "darwin") {
    console.log("[tts-agent] No API keys found — falling back to macOS say (free local TTS)");
    return macOsTTS(scriptText, outputPath);
  }

  return {
    ok: false,
    error: [
      "No TTS provider configured. Options:",
      "  • ELEVENLABS_API_KEY          — ElevenLabs (best quality, paid)",
      "  • OPENAI_API_KEY              — OpenAI TTS (great quality, paid)",
      "  • AICC_LOCAL_TTS_URL          — piper / kokoro / local TTS server",
      "  • AICC_TTS_PROVIDER=local     — macOS built-in say (Mac only, free)",
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
      console.error(`[tts-agent] Campaign not found: ${campaignPath}`);
      process.exit(1);
    }
    campaign = JSON.parse(fs.readFileSync(campaignPath, "utf8"));
  } catch (err) {
    console.error(`[tts-agent] Failed to load campaign: ${err.message}`);
    process.exit(1);
  }

  console.log(`[tts-agent] Processing campaign with ${campaign.variants.length} variants`);

  const manifest = [];
  let successCount = 0;
  let failureCount = 0;

  // Process each variant
  for (const variant of campaign.variants) {
    try {
      // Combine hook + body + cta into full script
      const scriptParts = [
        variant.hook || "",
        variant.body || "",
        variant.cta || "",
      ].filter(Boolean);
      const fullScript = scriptParts.join("\n\n").trim();

      if (!fullScript) {
        console.warn(`[tts-agent] Variant ${variant.id} has no script content, skipping`);
        manifest.push({ variant_id: variant.id, mp3_path: null, ok: false, reason: "no_script_content" });
        failureCount++;
        continue;
      }

      const outputPath = path.join(REPORTS, `tts-${variant.id}.mp3`);

      console.log(`[tts-agent] Processing variant ${variant.id} (${fullScript.length} chars)...`);
      const result = await synthesizeScript(fullScript, outputPath);

      if (result.ok) {
        manifest.push({ variant_id: variant.id, mp3_path: result.path, ok: true });
        successCount++;
      } else {
        console.error(`[tts-agent] Failed for variant ${variant.id}: ${result.error}`);
        manifest.push({ variant_id: variant.id, mp3_path: null, ok: false, error: result.error });
        failureCount++;
      }
    } catch (err) {
      console.error(`[tts-agent] Exception processing variant ${variant.id}: ${err.message}`);
      manifest.push({ variant_id: variant.id, mp3_path: null, ok: false, error: err.message });
      failureCount++;
    }
  }

  // Write manifest
  const manifestPath = path.join(REPORTS, "tts-manifest-latest.json");
  const manifestData = {
    generated_at: new Date().toISOString(),
    campaign_id: campaign.id || null,
    total: manifest.length,
    success_count: successCount,
    failure_count: failureCount,
    clips: manifest,
  };

  try {
    fs.writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2), "utf8");
    console.log(`[tts-agent] Manifest saved to ${manifestPath}`);
  } catch (err) {
    console.error(`[tts-agent] Failed to write manifest: ${err.message}`);
  }

  console.log(`[tts-agent] Complete: ${successCount} success, ${failureCount} failed`);
  process.exit(failureCount > 0 ? 1 : 0);
}

// Entry point
if (require.main === module) {
  main()
    .catch(err => {
      console.error("[tts-agent] Fatal:", err.message);
      console.error(err.stack);
      process.exit(1);
    });
}

module.exports = { elevenLabsTTS, openaiTTS, synthesizeScript, main };
