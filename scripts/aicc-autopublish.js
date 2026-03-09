#!/usr/bin/env node
"use strict";

/**
 * aicc-autopublish.js
 * Scheduler + publish adapters for YouTube/TikTok/Instagram.
 *
 * Draft-first human-finalize: Use --draft or publish_mode: "draft" to output to
 * outputs/drafts/ for human to add trending music on phone and post natively.
 * Higher virality: bot creates draft → human finalizes on device.
 *
 * Commands:
 *   node scripts/aicc-autopublish.js schedule --campaign reports/aicc-campaign-latest.json [--draft] [--platforms youtube,tiktok,instagram]
 *   node scripts/aicc-autopublish.js draft --campaign reports/aicc-campaign-latest.json [--platforms tiktok,instagram] [--video path]
 *   node scripts/aicc-autopublish.js run-due [--dry-run]
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
const OUTPUTS = path.join(ROOT, "outputs");
const DRAFTS_DIR = path.join(OUTPUTS, "drafts");
const QUEUE_FILE = path.join(DATA, "aicc-publish-queue.json");
const RESULT_FILE = path.join(REPORTS, "aicc-publish-results-latest.json");
const CLIP_MANIFEST_PATH = path.join(REPORTS, "clip-manifest-latest.json");

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

/**
 * TikTok draft: Use POST /v2/post/publish/inbox/video/init/ (video.upload scope)
 * when AICC_TIKTOK_DRAFT=true and video URL is verified. Falls back to local drafts.
 */
async function publishTikTok(variant, videoPathOrUrl) {
  if (process.env.TIKTOK_PUBLISH_WEBHOOK) {
    const r = await postWebhook(process.env.TIKTOK_PUBLISH_WEBHOOK, {
      platform: "tiktok",
      variant,
      video: videoPathOrUrl,
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

  // Build caption with optional affiliate link
  const caption = variant.hook || variant.title;
  const affiliateUrl = process.env.TIKTOK_SHOP_AFFILIATE_URL
    ? `${process.env.TIKTOK_SHOP_AFFILIATE_URL}?utm_source=tiktok&utm_campaign=${variant.id || "aicc"}`
    : "";
  const captionWithAffiliate = affiliateUrl
    ? `${caption} 🛒 ${affiliateUrl}`.slice(0, 2200)
    : caption.slice(0, 2200);

  const useInboxDraft = process.env.AICC_TIKTOK_DRAFT === "true";
  const endpoint = useInboxDraft
    ? "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/"
    : "https://open.tiktokapis.com/v2/post/publish/video/init/";

  const body = useInboxDraft
    ? { source_info: { source: "PULL_FROM_URL", video_url: videoPathOrUrl } }
    : {
        post_info: {
          title: variant.title.slice(0, 90),
          caption: captionWithAffiliate,
          privacy_level: process.env.AICC_TIKTOK_PRIVACY || "SELF_ONLY",
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false,
          video_cover_timestamp_ms: 1000,
        },
        source_info: { source: "PULL_FROM_URL", video_url: videoPathOrUrl },
      };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  const json = await res.json();
  if (!res.ok) {
    return { ok: false, error: `TikTok publish init failed: ${JSON.stringify(json)}` };
  }

  return { ok: true, external_id: json?.data?.publish_id || json?.data?.task_id || null, raw: json };
}

/**
 * Publish to Pinterest using their API or webhook
 */
async function publishPinterest(variant, imageUrlOrPath) {
  if (process.env.PINTEREST_PUBLISH_WEBHOOK) {
    const r = await postWebhook(process.env.PINTEREST_PUBLISH_WEBHOOK, {
      platform: "pinterest",
      variant,
      image: imageUrlOrPath,
    });
    return { ok: r.ok, external_id: `pin:webhook:${r.status}`, raw: r.body };
  }

  const token = process.env.PINTEREST_ACCESS_TOKEN;
  if (!token) {
    return { ok: false, error: "Pinterest credentials missing (set PINTEREST_ACCESS_TOKEN or PINTEREST_PUBLISH_WEBHOOK)." };
  }

  const affiliateUrl = process.env.PINTEREST_AFFILIATE_URL || process.env.TIKTOK_SHOP_AFFILIATE_URL || null;
  const pinData = {
    board_id: process.env.PINTEREST_BOARD_ID || "",
    title: (variant.title || "").slice(0, 100),
    description: (variant.hook || variant.description || "").slice(0, 500),
    link: affiliateUrl || undefined,
    media_source: imageUrlOrPath && /^https?:\/\//i.test(imageUrlOrPath)
      ? { source_type: "image_url", url: imageUrlOrPath }
      : { source_type: "image_base64", content_type: "image/jpeg", data: "" },
  };

  const res = await fetch("https://api.pinterest.com/v5/pins", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(pinData),
  });

  const json = await res.json();
  if (!res.ok) {
    return { ok: false, error: `Pinterest pin failed: ${JSON.stringify(json)}` };
  }

  return { ok: true, external_id: json?.id || null, raw: json };
}

function resolveVideoForVariant(variant, videoAsset) {
  if (videoAsset && videoAsset.trim()) return path.resolve(videoAsset.trim());
  if (!fs.existsSync(CLIP_MANIFEST_PATH)) return null;
  try {
    const clipData = JSON.parse(fs.readFileSync(CLIP_MANIFEST_PATH, "utf8"));
    const clips = Array.isArray(clipData) ? clipData : clipData.clips || [];
    const entry = clips.find((c) => c.variant_id === variant?.id && c.ok && c.path);
    return entry ? path.resolve(entry.path) : null;
  } catch {
    return null;
  }
}

/**
 * Draft-first human-finalize: Write to outputs/drafts/<platform>/ for human to
 * add trending music on phone and post natively. Higher virality.
 */
function writeDraftManifest(item, videoPath) {
  const { platform, payload } = item;
  const variant = payload?.variant || {};
  const draftDir = path.join(DRAFTS_DIR, platform, `${variant.id || randomUUID()}`);
  fs.mkdirSync(draftDir, { recursive: true });

  const manifest = {
    created_at: new Date().toISOString(),
    platform,
    variant_id: variant.id,
    title: variant.title || "",
    hook: variant.hook || variant.title || "",
    description: variant.description || "",
    hashtags: variant.hashtags || [],
    cta: variant.cta || "",
    caption: variant.hook || variant.title || "",
    video_path: videoPath ? path.relative(draftDir, videoPath) : null,
    human_finalize: "Add trending music on phone, then post natively for higher virality.",
  };

  const manifestPath = path.join(draftDir, "manifest.json");
  writeJson(manifestPath, manifest);

  if (videoPath && fs.existsSync(videoPath)) {
    const destVideo = path.join(draftDir, path.basename(videoPath));
    try {
      fs.copyFileSync(videoPath, destVideo);
      manifest.video_path = path.basename(videoPath);
    } catch (e) {
      manifest.video_path = videoPath;
      manifest.video_note = "Copy video manually from: " + videoPath;
    }
    writeJson(manifestPath, manifest);
  }

  return { ok: true, external_id: `draft:${draftDir}`, draft_dir: draftDir };
}

async function dispatch(item, dryRun = false, draftMode = false) {
  const payload = item.payload || {};
  const variant = payload.variant;
  const video = resolveVideoForVariant(variant, payload.video_asset) || payload.video_asset;
  const wantDraft = draftMode || variant?.publish_mode === "draft";

  if (dryRun) {
    return { ok: true, external_id: `dry:${item.platform}:${item.id}` };
  }

  if (wantDraft) {
    return writeDraftManifest(item, video);
  }

  if (item.platform === "youtube") return publishYouTube(variant, video);
  if (item.platform === "instagram") return publishInstagram(variant, video);
  if (item.platform === "tiktok") return publishTikTok(variant, video);
  if (item.platform === "pinterest") return publishPinterest(variant, video);
  return { ok: false, error: `Unsupported platform: ${item.platform}` };
}

function ensureQueue() {
  const q = readJson(QUEUE_FILE, { items: [] });
  if (!Array.isArray(q.items)) q.items = [];
  return q;
}

function addToQueue(entries, replace = false) {
  const q = replace ? { items: [] } : ensureQueue();
  q.items.push(...entries);
  writeJson(QUEUE_FILE, q);
  return entries.length;
}

/**
 * Resolve video path per variant: from clip manifest when available, else use single videoAsset.
 * @param {object[]} variants - Campaign variants
 * @param {string} videoAsset - Optional single path for all (legacy --video)
 * @returns {Map<string, string>} variant_id -> absolute video path
 */
function resolveVideoPaths(variants, videoAsset) {
  const map = new Map();
  if (videoAsset && videoAsset.trim()) {
    for (const v of variants) {
      map.set(v.id, path.resolve(videoAsset.trim()));
    }
    return map;
  }
  if (!fs.existsSync(CLIP_MANIFEST_PATH)) return map;
  try {
    const clipData = JSON.parse(fs.readFileSync(CLIP_MANIFEST_PATH, "utf8"));
    const clips = Array.isArray(clipData) ? clipData : clipData.clips || [];
    for (const entry of clips) {
      if (entry.ok && entry.path && entry.variant_id) {
        map.set(entry.variant_id, path.resolve(entry.path));
      }
    }
  } catch {
    // ignore parse errors
  }
  return map;
}

function makeScheduleEntries({ campaign, platforms, startAt, spacingMin, videoAsset, videoPaths, draftMode = false }) {
  const baseTs = startAt ? new Date(startAt).getTime() : Date.now() + 60_000;
  if (!Number.isFinite(baseTs)) throw new Error(`Invalid --start-at: ${startAt}`);

  const entries = [];
  let offset = 0;
  for (const variant of campaign.variants) {
    const pathForVariant = videoPaths?.get(variant.id) || videoAsset || "";
    const v = draftMode ? { ...variant, publish_mode: "draft" } : variant;
    for (const platform of platforms) {
      entries.push({
        id: randomUUID(),
        created_at: new Date().toISOString(),
        scheduled_at: new Date(baseTs + offset * 60_000).toISOString(),
        status: "scheduled",
        platform,
        payload: {
          campaign_topic: campaign.topic,
          variant: v,
          video_asset: pathForVariant,
        },
      });
      offset += spacingMin;
    }
  }
  return entries;
}

async function cmdSchedule() {
  const campaignFile = arg("--campaign", path.join(REPORTS, "aicc-campaign-latest.json"));
  const validPlatforms = ["youtube", "tiktok", "instagram", "pinterest"];
  const platforms = (arg("--platforms", "youtube,tiktok,instagram") || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((p) => validPlatforms.includes(p));
  const startAt = arg("--start-at", null);
  const spacingMin = Math.max(5, Number(arg("--spacing-min", "90")) || 90);
  const videoAsset = arg("--video", process.env.AICC_VIDEO_ASSET || "");
  const draftMode = has("--draft") || false;

  const campaign = loadCampaign(campaignFile);
  const videoPaths = resolveVideoPaths(campaign.variants, videoAsset);
  const entries = makeScheduleEntries({ campaign, platforms, startAt, spacingMin, videoAsset, videoPaths, draftMode });
  const replace = has("--replace");
  const n = addToQueue(entries, replace);
  console.log(`[aicc-autopublish] scheduled ${n} publish jobs${draftMode ? " (draft mode)" : ""}`);
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
      const out = await dispatch(item, dryRun, item.payload?.variant?.publish_mode === "draft");
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

async function cmdDraft() {
  const campaignFile = arg("--campaign", path.join(REPORTS, "aicc-campaign-latest.json"));
  const validPlatforms = ["youtube", "tiktok", "instagram", "pinterest"];
  const platforms = (arg("--platforms", "tiktok,instagram") || "tiktok,instagram")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((p) => validPlatforms.includes(p));
  const videoAsset = arg("--video", process.env.AICC_VIDEO_ASSET || "");

  const campaign = loadCampaign(campaignFile);
  const videoPaths = resolveVideoPaths(campaign.variants, videoAsset);

  fs.mkdirSync(DRAFTS_DIR, { recursive: true });
  const results = [];

  for (const variant of campaign.variants) {
    const pathForVariant = videoPaths?.get(variant.id) || videoAsset || "";
    for (const platform of platforms) {
      const item = {
        id: randomUUID(),
        platform,
        payload: {
          campaign_topic: campaign.topic,
          variant: { ...variant, publish_mode: "draft" },
          video_asset: pathForVariant,
        },
      };
      const out = await dispatch(item, false, true);
      if (out.ok) {
        results.push({ variant_id: variant.id, platform, draft_dir: out.draft_dir || out.external_id });
        console.log(`[aicc-autopublish] draft: ${out.draft_dir || out.external_id}`);
      } else {
        results.push({ variant_id: variant.id, platform, error: out.error });
        console.error(`[aicc-autopublish] failed: ${out.error}`);
      }
    }
  }

  writeJson(path.join(REPORTS, "aicc-drafts-latest.json"), {
    generated_at: new Date().toISOString(),
    drafts_dir: DRAFTS_DIR,
    results,
  });
  console.log(`[aicc-autopublish] ${results.filter((r) => r.draft_dir).length} drafts written to ${DRAFTS_DIR}`);
  console.log("[aicc-autopublish] Human: add trending music on phone, then post natively for higher virality.");
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

  const draftMode = has("--draft");
  const out = await dispatch(
    { id: randomUUID(), platform, payload: { variant: draftMode ? { ...variant, publish_mode: "draft" } : variant, video_asset: videoAsset } },
    dryRun,
    draftMode
  );
  if (!out.ok) throw new Error(out.error || "publish failed");

  console.log(`[aicc-autopublish] published variant ${variantId} to ${platform}`);
  console.log(`[aicc-autopublish] external_id=${out.external_id || "n/a"}`);
}

async function main() {
  const cmd = process.argv[2] || "help";
  if (cmd === "schedule") return cmdSchedule();
  if (cmd === "draft") return cmdDraft();
  if (cmd === "run-due") return cmdRunDue();
  if (cmd === "publish-now") return cmdPublishNow();

  console.log("Usage:");
  console.log("  node scripts/aicc-autopublish.js schedule --campaign reports/aicc-campaign-latest.json [--draft] [--platforms youtube,tiktok,instagram] [--spacing-min 120] [--video /path/final.mp4] [--replace]");
  console.log("  node scripts/aicc-autopublish.js draft --campaign reports/aicc-campaign-latest.json [--platforms tiktok,instagram] [--video /path/final.mp4]");
  console.log("    (draft: output to outputs/drafts/ for human to add trending music on phone → higher virality)");
  console.log("  node scripts/aicc-autopublish.js run-due [--dry-run]");
  console.log("  node scripts/aicc-autopublish.js publish-now --campaign reports/aicc-campaign-latest.json --variant-id <uuid> --platform youtube [--video /path/final.mp4] [--dry-run] [--draft]");
}

main().catch((err) => {
  console.error(`[aicc-autopublish] fatal: ${err.message}`);
  process.exit(1);
});
