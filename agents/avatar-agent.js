#!/usr/bin/env node
"use strict";
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = path.join(__dirname, "..");
const REPORTS = path.join(ROOT, "reports");

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

async function httpsRequest(method, hostname, pathname, headers, body) {
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

    if (body) {
      const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
      options.headers["Content-Length"] = Buffer.byteLength(bodyStr);
    }

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, data: parsed });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on("error", (err) => {
      reject(err);
    });

    if (body) {
      const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
      req.write(bodyStr);
    }
    req.end();
  });
}

async function heyGenGenerate(avatarId, scriptText, outputPath) {
  const apiKey = process.env.HEYGEN_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "HEYGEN_API_KEY not configured" };
  }

  const body = {
    video_inputs: [
      {
        character: {
          type: "avatar",
          avatar_id: avatarId || process.env.HEYGEN_AVATAR_ID || "default",
        },
        voice: {
          type: "text",
          input_text: scriptText,
          voice_id: process.env.HEYGEN_VOICE_ID || "",
        },
      },
    ],
    dimension: { width: 1080, height: 1920 },
    aspect_ratio: "9:16",
  };

  try {
    const generateRes = await httpsRequest(
      "POST",
      "api.heygen.com",
      "/v2/video/generate",
      { "X-Api-Key": apiKey },
      body
    );

    if (generateRes.status !== 200 && generateRes.status !== 201) {
      return { ok: false, error: `HeyGen generate failed: ${generateRes.status}` };
    }

    const videoId = generateRes.data.data?.video_id;
    if (!videoId) {
      return { ok: false, error: "No video_id returned from HeyGen" };
    }

    let videoUrl = null;
    let pollCount = 0;
    const maxPolls = 120 / 10; // 120 seconds / 10s interval

    while (pollCount < maxPolls) {
      await new Promise((r) => setTimeout(r, 10000)); // 10s delay
      pollCount++;

      const statusRes = await httpsRequest(
        "GET",
        "api.heygen.com",
        `/v1/video_status.get?video_id=${videoId}`,
        { "X-Api-Key": apiKey }
      );

      if (statusRes.status === 200) {
        const status = statusRes.data.data?.status;
        if (status === "completed") {
          videoUrl = statusRes.data.data?.video_url;
          break;
        } else if (status === "failed") {
          return { ok: false, error: "HeyGen video generation failed" };
        }
      }
    }

    if (!videoUrl) {
      return { ok: false, error: "HeyGen generation timeout" };
    }

    // Download video
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(outputPath);
      https.get(videoUrl, (res) => {
        res.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
      }).on("error", (err) => {
        fs.unlink(outputPath, () => {});
        reject(err);
      });
    });

    return { ok: true, path: outputPath, video_url: videoUrl };
  } catch (err) {
    return { ok: false, error: `HeyGen error: ${err.message}` };
  }
}

async function didGenerate(scriptText, outputPath) {
  const apiKey = process.env.DID_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "DID_API_KEY not configured" };
  }

  const body = {
    source_url:
      process.env.DID_PRESENTER_URL ||
      "https://create-images-results.d-id.com/DefaultPresenters/Emma_f/image.jpeg",
    script: {
      type: "text",
      input: scriptText,
      provider: { type: "microsoft", voice_id: "en-US-JennyNeural" },
    },
  };

  try {
    const auth = Buffer.from(apiKey + ":").toString("base64");
    const generateRes = await httpsRequest(
      "POST",
      "api.d-id.com",
      "/talks",
      { Authorization: `Basic ${auth}` },
      body
    );

    if (generateRes.status !== 200 && generateRes.status !== 201) {
      return { ok: false, error: `D-ID generate failed: ${generateRes.status}` };
    }

    const talkId = generateRes.data.id;
    if (!talkId) {
      return { ok: false, error: "No talk id returned from D-ID" };
    }

    let resultUrl = null;
    let pollCount = 0;
    const maxPolls = 120 / 5; // 120 seconds / 5s interval

    while (pollCount < maxPolls) {
      await new Promise((r) => setTimeout(r, 5000)); // 5s delay
      pollCount++;

      const statusRes = await httpsRequest(
        "GET",
        "api.d-id.com",
        `/talks/${talkId}`,
        { Authorization: `Basic ${auth}` }
      );

      if (statusRes.status === 200) {
        const status = statusRes.data.status;
        if (status === "done") {
          resultUrl = statusRes.data.result_url;
          break;
        } else if (status === "failed") {
          return { ok: false, error: "D-ID talk generation failed" };
        }
      }
    }

    if (!resultUrl) {
      return { ok: false, error: "D-ID generation timeout" };
    }

    // Download video
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(outputPath);
      https.get(resultUrl, (res) => {
        res.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
      }).on("error", (err) => {
        fs.unlink(outputPath, () => {});
        reject(err);
      });
    });

    return { ok: true, path: outputPath };
  } catch (err) {
    return { ok: false, error: `D-ID error: ${err.message}` };
  }
}

/**
 * LivePortrait — free local talking-head generator (replaces HeyGen/D-ID).
 * Maps expressions from your drive video onto any source photo.
 *
 * Setup (one-time):
 *   git clone https://github.com/KwaiYing/LivePortrait ~/liveportrait
 *   cd ~/liveportrait && pip install -r requirements.txt
 *   python scripts/local-liveportrait-server.py
 *
 * .env vars:
 *   AICC_LOCAL_AVATAR_URL=http://127.0.0.1:8011
 *   AICC_AVATAR_SOURCE_IMAGE=/path/to/headshot.jpg
 *   AICC_AVATAR_DRIVE_VIDEO=/path/to/talking-clip.mp4
 */
async function livePortraitGenerate(scriptText, outputPath) {
  const baseUrl     = process.env.AICC_LOCAL_AVATAR_URL;
  const sourceImage = process.env.AICC_AVATAR_SOURCE_IMAGE;
  const driveVideo  = process.env.AICC_AVATAR_DRIVE_VIDEO;

  if (!baseUrl) return { ok: false, error: "AICC_LOCAL_AVATAR_URL not set" };

  const http  = require("http");
  const https = require("https");
  const { URL: NodeURL } = require("url");

  const parsed  = new NodeURL(`${baseUrl}/animate`);
  const lib     = parsed.protocol === "https:" ? https : http;
  const bodyObj = {
    source_image_path: sourceImage || null,
    drive_video_path:  driveVideo  || null,
    output_path:       outputPath,
  };
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
          console.log(`[avatar-agent] ✓ LivePortrait → ${body.path}`);
          resolve({ ok: true, path: body.path });
        } catch {
          resolve({ ok: false, error: `LivePortrait server bad response: ${raw.slice(0, 200)}` });
        }
      });
    });
    req.on("error", (err) => resolve({ ok: false, error: `LivePortrait server unreachable: ${err.message}` }));
    req.setTimeout(300000, () => { req.destroy(); resolve({ ok: false, error: "LivePortrait timeout (300s)" }); });
    req.write(bodyStr);
    req.end();
  });
}

/**
 * generateAvatar — provider waterfall:
 *   1. LivePortrait (FREE local) — run scripts/local-liveportrait-server.py
 *   2. HeyGen (paid)
 *   3. D-ID (paid)
 */
async function generateAvatar(scriptText, outputPath) {
  // 1. LivePortrait (free, no usage limits, runs on own hardware)
  if (process.env.AICC_LOCAL_AVATAR_URL) {
    const result = await livePortraitGenerate(scriptText, outputPath);
    if (result.ok) return result;
    console.warn(`[avatar-agent] LivePortrait failed (${result.error}), trying next provider`);
  }

  // 2. HeyGen (paid)
  if (process.env.HEYGEN_API_KEY) {
    return await heyGenGenerate(null, scriptText, outputPath);
  }

  // 3. D-ID (paid)
  if (process.env.DID_API_KEY) {
    return await didGenerate(scriptText, outputPath);
  }

  return {
    ok: false,
    error: [
      "No avatar provider configured. Options:",
      "  FREE: set AICC_LOCAL_AVATAR_URL=http://127.0.0.1:8011",
      "        + AICC_AVATAR_SOURCE_IMAGE=/path/to/headshot.jpg",
      "        + AICC_AVATAR_DRIVE_VIDEO=/path/to/talking-clip.mp4",
      "        then: python scripts/local-liveportrait-server.py",
      "  PAID: HEYGEN_API_KEY or DID_API_KEY",
    ].join("\n"),
  };
}

async function main() {
  const campaignPath = arg("--campaign", null);
  const avatarId = arg("--avatar-id", null);

  if (!campaignPath) {
    console.error("--campaign flag is required");
    process.exit(1);
  }

  let campaign;
  try {
    campaign = JSON.parse(fs.readFileSync(campaignPath, "utf8"));
  } catch (err) {
    console.error(`Failed to read campaign: ${err.message}`);
    process.exit(1);
  }

  const variants = campaign.variants || [];
  if (!Array.isArray(variants) || !variants.length) {
    console.error("Campaign has no variants");
    process.exit(1);
  }

  const avatarDir = path.join(ROOT, "media/avatar");
  fs.mkdirSync(avatarDir, { recursive: true });

  const results = [];

  for (const variant of variants) {
    const script = [variant.hook, variant.body, variant.cta].filter(Boolean).join(" ");
    const outputPath = path.join(avatarDir, `${variant.id}.mp4`);

    console.log(`[avatar-agent] Generating avatar video for variant ${variant.id}`);
    const result = await generateAvatar(script, outputPath);

    if (result.ok) {
      console.log(`[avatar-agent] Success: ${outputPath}`);
      results.push({
        variant_id: variant.id,
        video_path: outputPath,
        status: "completed",
        generated_at: new Date().toISOString(),
      });
    } else {
      console.error(`[avatar-agent] Failed: ${result.error}`);
      results.push({
        variant_id: variant.id,
        status: "failed",
        error: result.error,
        generated_at: new Date().toISOString(),
      });
    }
  }

  const manifest = {
    campaign_id: campaign.topic || "unknown",
    generated_at: new Date().toISOString(),
    results,
  };

  const manifestPath = path.join(REPORTS, "avatar-manifest-latest.json");
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`[avatar-agent] Wrote manifest to ${manifestPath}`);
  console.log(`[avatar-agent] Completed ${results.filter((r) => r.status === "completed").length}/${results.length} videos`);
}

main().catch((err) => {
  console.error(`avatar-agent failed: ${err.message}`);
  process.exit(1);
});
