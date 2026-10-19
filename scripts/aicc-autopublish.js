#!/usr/bin/env node
"use strict";

/**
 * aicc-autopublish.js
 * Scheduler + publish adapters for YouTube/TikTok/Instagram.
 *
 * Commands:
 *   node scripts/aicc-autopublish.js schedule --campaign reports/aicc-campaign-latest.json --platforms youtube,tiktok,instagram --start-at 2026-03-05T18:00:00Z --spacing-min 120
 *   node scripts/aicc-autopublish.js run-due
 *   node scripts/aicc-autopublish.js publish-now --campaign reports/aicc-campaign-latest.json --variant-id <uuid> --platform youtube
 */

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

try {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
} catch {
  // Optional in clean checkouts without node_modules.
}

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data");
const REPORTS = path.join(ROOT, "reports");
const STACK_CONFIG_FILE = path.join(ROOT, "config", "aicc-plushtrap-stack.json");
const QUEUE_FILE = path.join(DATA, "aicc-publish-queue.json");
const RESULT_FILE = path.join(REPORTS, "aicc-publish-results-latest.json");

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  return String(process.argv[i + 1] || "").trim() || fallback;
}

function has(flag) {
  return process.argv.includes(flag);
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function variantText(variant) {
  return [variant?.title, variant?.hook, variant?.body, variant?.cta, variant?.description, ...((variant?.hashtags || []))]
    .filter(Boolean)
    .join("\n");
}

function disclosureCheck(variant) {
  const config = readJson(STACK_CONFIG_FILE, {});
  const text = variantText(variant);
  const lower = text.toLowerCase();
  const phrases = config?.disclosure?.phrases || ["virtual Plushtrap creator"];
  const hasDisclosure = phrases.some((p) => lower.includes(String(p).toLowerCase()));
  const forbidden = (config?.disclosure?.forbidden_claim_patterns || [])
    .map((p) => new RegExp(p, "i"))
    .filter((re) => re.test(text))
    .map((re) => re.source);
  const failures = [];
  if (!hasDisclosure) failures.push("missing_virtual_creator_disclosure");
  for (const pattern of forbidden) failures.push(`forbidden_claim:${pattern}`);
  return { ok: failures.length === 0, failures };
}

function platformDisclosureMetadata() {
  return {
    is_aigc: true,
    brand_organic_toggle: true,
    disclosure: "virtual Plushtrap creator",
  };
}

function loadCampaign(file) {
  const campaign = readJson(file, null);
  if (!campaign || !Array.isArray(campaign.variants)) {
    throw new Error(`Invalid campaign manifest: ${file}`);
  }
  return campaign;
}

async function postWebhook(url, payload, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return {
    ok: res.ok,
    status: res.status,
    body: text,
  };
}

async function publishYouTube(variant, videoPathOrUrl) {
  if (process.env.YOUTUBE_PUBLISH_WEBHOOK) {
    const r = await postWebhook(process.env.YOUTUBE_PUBLISH_WEBHOOK, {
      platform: "youtube",
      variant,
      video: videoPathOrUrl,
      aicc_disclosure: platformDisclosureMetadata(),
    });
    return { ok: r.ok, external_id: `yt:webhook:${r.status}`, raw: r.body };
  }

  const credsReady = process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET && process.env.YOUTUBE_REFRESH_TOKEN;
  if (!credsReady) {
    return { ok: false, error: "YouTube credentials missing (set YOUTUBE_* env vars or YOUTUBE_PUBLISH_WEBHOOK)." };
  }
  if (!videoPathOrUrl || /^https?:\/\//i.test(videoPathOrUrl)) {
    return { ok: false, error: "YouTube native upload requires local video file path." };
  }

  const { google } = require("googleapis");
  const auth = new google.auth.OAuth2(process.env.YOUTUBE_CLIENT_ID, process.env.YOUTUBE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN });
  const youtube = google.youtube({ version: "v3", auth });

  const resp = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: variant.title,
        description: `${variant.description}\n\n${(variant.hashtags || []).join(" ")}`,
        tags: variant.hashtags || [],
      },
      status: {
        privacyStatus: process.env.AICC_YOUTUBE_PRIVACY || "private",
      },
    },
    media: {
      body: fs.createReadStream(path.resolve(videoPathOrUrl)),
    },
  });

  return { ok: true, external_id: resp?.data?.id || null, raw: resp?.data || null };
}

async function publishInstagram(variant, videoPathOrUrl) {
  if (process.env.INSTAGRAM_PUBLISH_WEBHOOK) {
    const r = await postWebhook(process.env.INSTAGRAM_PUBLISH_WEBHOOK, {
      platform: "instagram",
      variant,
      video: videoPathOrUrl,
      aicc_disclosure: platformDisclosureMetadata(),
    });
    return { ok: r.ok, external_id: `ig:webhook:${r.status}`, raw: r.body };
  }

  const userId = process.env.IG_USER_ID;
  const token = process.env.IG_ACCESS_TOKEN;
  if (!userId || !token) {
    return { ok: false, error: "Instagram credentials missing (set IG_USER_ID + IG_ACCESS_TOKEN or INSTAGRAM_PUBLISH_WEBHOOK)." };
  }
  if (!/^https?:\/\//i.test(videoPathOrUrl || "")) {
    return { ok: false, error: "Instagram Graph API requires a public video URL." };
  }

  const caption = `${variant.title}\n\n${variant.description}\n\n${(variant.hashtags || []).join(" ")}`;
  const createRes = await fetch(`https://graph.facebook.com/v20.0/${userId}/media`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      media_type: "REELS",
      video_url: videoPathOrUrl,
      caption,
      access_token: token,
    }),
  });
  const createJson = await createRes.json();
  if (!createRes.ok || !createJson?.id) {
    return { ok: false, error: `Instagram media create failed: ${JSON.stringify(createJson)}` };
  }

  const publishRes = await fetch(`https://graph.facebook.com/v20.0/${userId}/media_publish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ creation_id: createJson.id, access_token: token }),
  });
  const publishJson = await publishRes.json();
  if (!publishRes.ok || !publishJson?.id) {
    return { ok: false, error: `Instagram publish failed: ${JSON.stringify(publishJson)}` };
  }

  return { ok: true, external_id: publishJson.id, raw: publishJson };
}

async function publishTikTok(variant, videoPathOrUrl) {
  if (process.env.TIKTOK_PUBLISH_WEBHOOK) {
    const r = await postWebhook(process.env.TIKTOK_PUBLISH_WEBHOOK, {
      platform: "tiktok",
      variant,
      video: videoPathOrUrl,
      aicc_disclosure: platformDisclosureMetadata(),
    });
    return { ok: r.ok, external_id: `tt:webhook:${r.status}`, raw: r.body };
  }

  const token = process.env.TIKTOK_ACCESS_TOKEN;
  if (!token) {
    return { ok: false, error: "TikTok credentials missing (set TIKTOK_ACCESS_TOKEN or TIKTOK_PUBLISH_WEBHOOK)." };
  }
  if (!/^https?:\/\//i.test(videoPathOrUrl || "")) {
    return { ok: false, error: "TikTok API mode requires a public video URL." };
  }

  const postInfo = {
    post_info: {
      title: variant.title.slice(0, 90),
      privacy_level: process.env.AICC_TIKTOK_PRIVACY || "SELF_ONLY",
      disable_duet: false,
      disable_comment: false,
      disable_stitch: false,
      video_cover_timestamp_ms: 1000,
    },
    source_info: {
      source: "PULL_FROM_URL",
      video_url: videoPathOrUrl,
    },
  };

  if (process.env.AICC_TIKTOK_SEND_AIGC_FIELDS === "true") {
    postInfo.post_info.is_aigc = true;
    postInfo.post_info.brand_organic_toggle = true;
  }

  const res = await fetch("https://open.tiktokapis.com/v2/post/publish/video/init/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(postInfo),
  });

  const json = await res.json();
  if (!res.ok) {
    return { ok: false, error: `TikTok publish init failed: ${JSON.stringify(json)}` };
  }

  return { ok: true, external_id: json?.data?.publish_id || json?.data?.task_id || null, raw: json };
}

async function dispatch(item, dryRun = false) {
  const payload = item.payload || {};
  const variant = payload.variant;
  const video = payload.video_asset;
  const gate = disclosureCheck(variant);
  if (!gate.ok) {
    return { ok: false, error: `Disclosure gate failed: ${gate.failures.join(",")}` };
  }

  if (dryRun) {
    return { ok: true, external_id: `dry:${item.platform}:${item.id}` };
  }

  if (item.platform === "youtube") return publishYouTube(variant, video);
  if (item.platform === "instagram") return publishInstagram(variant, video);
  if (item.platform === "tiktok") return publishTikTok(variant, video);
  return { ok: false, error: `Unsupported platform: ${item.platform}` };
}

function ensureQueue() {
  const q = readJson(QUEUE_FILE, { items: [] });
  if (!Array.isArray(q.items)) q.items = [];
  return q;
}

function addToQueue(entries) {
  const q = ensureQueue();
  q.items.push(...entries);
  writeJson(QUEUE_FILE, q);
  return entries.length;
}

function makeScheduleEntries({ campaign, platforms, startAt, spacingMin, videoAsset }) {
  const baseTs = startAt ? new Date(startAt).getTime() : Date.now() + 60_000;
  if (!Number.isFinite(baseTs)) throw new Error(`Invalid --start-at: ${startAt}`);

  const entries = [];
  let offset = 0;
  for (const variant of campaign.variants) {
    for (const platform of platforms) {
      entries.push({
        id: randomUUID(),
        created_at: new Date().toISOString(),
        scheduled_at: new Date(baseTs + offset * 60_000).toISOString(),
        status: "scheduled",
        platform,
        payload: {
          campaign_topic: campaign.topic,
          variant,
          video_asset: videoAsset,
        },
      });
      offset += spacingMin;
    }
  }
  return entries;
}

async function cmdSchedule() {
  const campaignFile = arg("--campaign", path.join(REPORTS, "aicc-campaign-latest.json"));
  const platforms = (arg("--platforms", "youtube,tiktok,instagram") || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const startAt = arg("--start-at", null);
  const spacingMin = Math.max(5, Number(arg("--spacing-min", "90")) || 90);
  const videoAsset = arg("--video", process.env.AICC_VIDEO_ASSET || "");

  const campaign = loadCampaign(campaignFile);
  const entries = makeScheduleEntries({ campaign, platforms, startAt, spacingMin, videoAsset });
  const n = addToQueue(entries);
  console.log(`[aicc-autopublish] scheduled ${n} publish jobs`);
  console.log(`[aicc-autopublish] queue file: ${QUEUE_FILE}`);
}

async function cmdRunDue() {
  const now = Date.now();
  const dryRun = has("--dry-run");
  const q = ensureQueue();
  const results = [];

  for (const item of q.items) {
    if (item.status !== "scheduled") continue;
    const ts = new Date(item.scheduled_at).getTime();
    if (!Number.isFinite(ts) || ts > now) continue;

    item.status = "running";
    item.started_at = new Date().toISOString();

    try {
      const out = await dispatch(item, dryRun);
      if (out.ok) {
        item.status = "published";
        item.external_id = out.external_id || null;
      } else {
        item.status = "failed";
        item.error = out.error || "unknown publish error";
      }
      item.finished_at = new Date().toISOString();
      results.push({ id: item.id, platform: item.platform, status: item.status, external_id: item.external_id || null, error: item.error || null });
    } catch (err) {
      item.status = "failed";
      item.error = err.message;
      item.finished_at = new Date().toISOString();
      results.push({ id: item.id, platform: item.platform, status: "failed", error: err.message });
    }
  }

  writeJson(QUEUE_FILE, q);
  writeJson(RESULT_FILE, {
    generated_at: new Date().toISOString(),
    processed: results.length,
    dry_run: dryRun,
    results,
  });

  console.log(`[aicc-autopublish] processed due jobs: ${results.length}`);
  console.log(`[aicc-autopublish] results: ${RESULT_FILE}`);
}

async function cmdPublishNow() {
  const campaignFile = arg("--campaign", path.join(REPORTS, "aicc-campaign-latest.json"));
  const variantId = arg("--variant-id", null);
  const platform = (arg("--platform", "youtube") || "youtube").toLowerCase();
  const videoAsset = arg("--video", process.env.AICC_VIDEO_ASSET || "");
  const dryRun = has("--dry-run");

  if (!variantId) throw new Error("--variant-id is required");

  const campaign = loadCampaign(campaignFile);
  const variant = campaign.variants.find((v) => v.id === variantId);
  if (!variant) throw new Error(`variant not found: ${variantId}`);

  const out = await dispatch({ id: randomUUID(), platform, payload: { variant, video_asset: videoAsset } }, dryRun);
  if (!out.ok) throw new Error(out.error || "publish failed");

  console.log(`[aicc-autopublish] published variant ${variantId} to ${platform}`);
  console.log(`[aicc-autopublish] external_id=${out.external_id || "n/a"}`);
}

async function main() {
  const cmd = process.argv[2] || "help";
  if (cmd === "schedule") return cmdSchedule();
  if (cmd === "run-due") return cmdRunDue();
  if (cmd === "publish-now") return cmdPublishNow();

  console.log("Usage:");
  console.log("  node scripts/aicc-autopublish.js schedule --campaign reports/aicc-campaign-latest.json --platforms youtube,tiktok,instagram --start-at 2026-03-05T18:00:00Z --spacing-min 120 --video /abs/path/final.mp4");
  console.log("  node scripts/aicc-autopublish.js run-due [--dry-run]");
  console.log("  node scripts/aicc-autopublish.js publish-now --campaign reports/aicc-campaign-latest.json --variant-id <uuid> --platform youtube --video /abs/path/final.mp4 [--dry-run]");
}

main().catch((err) => {
  console.error(`[aicc-autopublish] fatal: ${err.message}`);
  process.exit(1);
});
