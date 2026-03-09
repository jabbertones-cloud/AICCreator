#!/usr/bin/env node
"use strict";

/**
 * aicc-campaign-engine.js
 * Builds campaign-ready variants from transcript brief + niche templates.
 * Includes scene quality planning, beat timing, monetization packaging.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { randomUUID } = require("crypto");

const ROOT = path.join(__dirname, "..");
const REPORTS = path.join(ROOT, "reports");

const NICHE_PACKS = {
  "ai-clone-news": {
    angle: "rapid AI market change",
    hookTemplates: [
      "Most creators miss this {topic} shift until it's too late.",
      "This {topic} update quietly changed the game today.",
      "If you're building with AI, this {topic} move matters now.",
    ],
    ctaTemplates: [
      "Comment 'clone' for the full workflow.",
      "Follow for daily AI build breakdowns.",
      "Grab the checklist link before your next post.",
    ],
    affiliateCta: "Tools linked in bio: AI stack + automation bundle.",
  },
  "viral-faceless": {
    angle: "short-form retention optimization",
    hookTemplates: [
      "This faceless {topic} format is pulling retention fast.",
      "You can steal this {topic} structure in 15 minutes.",
      "The easiest faceless {topic} video formula is this.",
    ],
    ctaTemplates: [
      "Save this and use it in your next upload.",
      "Comment 'template' and I'll drop the framework.",
      "Follow for more faceless growth systems.",
    ],
    affiliateCta: "Download the faceless creator template pack in bio.",
  },
  "product-ads": {
    angle: "pain-to-proof conversion",
    hookTemplates: [
      "If {topic} is blocking growth, test this ad angle.",
      "This product ad framing lifts conversion for {topic}.",
      "A fast ad structure for selling {topic} without hard selling.",
    ],
    ctaTemplates: [
      "Tap the link to try the product workflow.",
      "DM 'offer' and get the offer script.",
      "Start with the product checklist in bio.",
    ],
    affiliateCta: "Use code CREATOR for partner-tool discount in bio.",
  },
  "ai-tools-review": {
    angle: "AI tool comparison and review",
    hookTemplates: [
      "I tested 5 AI tools for {topic} so you don't have to.",
      "This AI tool for {topic} is lowkey underrated.",
      "The best free AI tool for {topic} in 2026.",
    ],
    ctaTemplates: [
      "Comment 'tools' for the full comparison list.",
      "Links to all tools in bio.",
      "Follow for weekly AI tool reviews.",
    ],
    affiliateCta: "Get the AI tools comparison sheet free in bio.",
  },
  "youtube-faceless": {
    angle: "faceless YouTube growth",
    hookTemplates: [
      "This faceless YouTube channel makes $10k/mo with {topic}.",
      "How I'd start a {topic} faceless channel today with AI.",
      "The {topic} niche is perfect for a faceless YouTube channel.",
    ],
    ctaTemplates: [
      "Subscribe for the full faceless channel blueprint.",
      "Comment 'faceless' for the channel setup checklist.",
      "Download the faceless YouTube template in bio.",
    ],
    affiliateCta: "Start your faceless channel with the toolkit in bio.",
  },
  "tiktok-slideshow": {
    angle: "TikTok slideshow hook+demo format (Oliver Henry pattern)",
    hookTemplates: [
      "This {topic} slideshow format is pulling millions of views.",
      "Text hook + demo combo: the fastest {topic} viral formula.",
      "Most creators don't know this {topic} slideshow trick exists.",
    ],
    ctaTemplates: [
      "Save this and use it in your next upload.",
      "Comment 'template' and I'll drop the framework.",
      "Follow for more slideshow growth systems.",
    ],
    affiliateCta: "Download the slideshow template pack in bio.",
  },
  "hook-demo": {
    angle: "hook + demo combination (text file → script combines)",
    hookTemplates: [
      "I wrote all my {topic} hooks in a text file, then a script combined them.",
      "This {topic} hook plus demo format went viral.",
      "The {topic} hook+demo combo that gets retention.",
    ],
    ctaTemplates: [
      "Comment 'hooks' for the batch workflow.",
      "Save this for your next content batch.",
      "Follow for the hook+demo automation setup.",
    ],
    affiliateCta: "Get the hook batch script in bio.",
  },
  "tiktok-affiliate": {
    angle: "TikTok affiliate marketing",
    hookTemplates: [
      "This TikTok affiliate method for {topic} prints commissions.",
      "The fastest way to earn with {topic} affiliate on TikTok.",
      "I made my first $1k with {topic} using this TikTok method.",
    ],
    ctaTemplates: [
      "Tap the link for the affiliate product setup guide.",
      "Comment 'affiliate' for the commission blueprint.",
      "Follow for daily affiliate strategy breakdowns.",
    ],
    affiliateCta: "Join the affiliate program through the bio link.",
  },
};

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  return String(process.argv[i + 1] || "").trim() || fallback;
}

function numArg(flag, fallback) {
  const raw = arg(flag, null);
  if (raw == null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function readJsonSafe(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function run(cmd, args) {
  return spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: "pipe",
    encoding: "utf8",
    timeout: 120000,
  });
}

function extractTranscriptText(indexJson) {
  const rows = Array.isArray(indexJson?.rows) ? indexJson.rows : [];
  return rows
    .filter((r) => r?.transcript?.segments?.length)
    .map((r) => r.transcript.segments.map((s) => s.text).join(" "))
    .join("\n");
}

function topKeywords(text, limit = 8) {
  const stop = new Set(["the", "and", "for", "with", "that", "this", "from", "you", "your", "are", "was", "have", "has", "will", "into", "about", "their", "they", "them", "just", "more", "than", "what", "when", "where", "how", "why"]);
  const words = (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !stop.has(w));
  const freq = new Map();
  for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([w]) => w);
}

function scenePlan(variant, durationSec, keywords) {
  const hookSec = Math.max(4, Math.round(durationSec * 0.18));
  const ctaSec = Math.max(4, Math.round(durationSec * 0.15));
  const bodySec = Math.max(8, durationSec - hookSec - ctaSec);
  const beat = Math.max(1.4, Math.min(2.4, bodySec / 8));

  const broll = keywords.slice(0, 5).map((k, i) => ({ cue: `body_beat_${i + 1}`, keyword: k }));

  return {
    duration_sec: durationSec,
    hook: {
      start: 0,
      end: hookSec,
      text: variant.hook,
      transition_out: "flash-cut",
    },
    body: {
      start: hookSec,
      end: hookSec + bodySec,
      text: variant.body,
      beat_timing_sec: beat,
      transitions: ["zoom-cut", "motion-blur", "speed-ramp"],
      broll,
    },
    cta: {
      start: hookSec + bodySec,
      end: durationSec,
      text: variant.cta,
      transition_in: "dip-to-color",
    },
  };
}

function hashTags(topic, niche) {
  const base = ["#AI", "#ContentCreator", "#ShortForm", "#Growth", "#Automation"];
  const topicTag = "#" + String(topic || "AICC").replace(/[^a-z0-9]/gi, "").slice(0, 18);
  const nicheTag = "#" + String(niche || "niche").replace(/[^a-z0-9]/gi, "").slice(0, 18);
  return [...new Set([...base, topicTag, nicheTag])].slice(0, 8);
}

function main() {
  const topic = arg("--topic", process.env.AICC_TOPIC || "automated content creator system");
  const niche = arg("--niche", process.env.AICC_NICHE_PACK || "ai-clone-news");
  const variantsCount = Math.max(3, Math.min(5, numArg("--variants", 3)));
  const durationSec = Math.max(15, Math.min(90, numArg("--duration-sec", 38)));
  const out = arg("--out", path.join(REPORTS, "aicc-campaign-latest.json"));
  const runResearch = process.argv.includes("--run-research");
  const hookType = arg("--hook-type", null); // curiosity | urgency | social_proof | pain | benefit | pattern_interrupt

  const pack = NICHE_PACKS[niche] || NICHE_PACKS["ai-clone-news"];

  // Load affiliate links config
  let affiliateLinksConfig = {};
  try {
    affiliateLinksConfig = JSON.parse(fs.readFileSync(path.join(ROOT, "config/affiliate-links.json"), "utf8"));
  } catch (_) {}

  function getAffiliateUrl(platform, nicheKey) {
    return affiliateLinksConfig?.platforms?.[platform]?.[nicheKey] || pack.affiliateCta;
  }

  if (runResearch) {
    run("node", [path.join(ROOT, "scripts", "builder-research-agenda.js"), "--rolling"]);
    run("node", [path.join(ROOT, "scripts", "feature-benchmark-score.js")]);
  }

  const indexJson = readJsonSafe(path.join(REPORTS, "youtube-transcript-visual-index-latest.json"), {});
  const briefJson = readJsonSafe(path.join(REPORTS, "content-creator-brief-latest.json"), {});
  const transcript = extractTranscriptText(indexJson);
  const keywords = topKeywords(`${topic}\n${transcript}`, 10);

  // Load hook library if specified
  let hookLibrary = null;
  if (hookType) {
    const hookLibraryPath = path.join(ROOT, "data/hook-library.json");
    if (fs.existsSync(hookLibraryPath)) {
      try {
        hookLibrary = readJsonSafe(hookLibraryPath, null);
      } catch (_) {}
    }
  }

  const variants = [];
  for (let i = 0; i < variantsCount; i++) {
    let hook;
    if (hookType && hookLibrary && hookLibrary[hookType]) {
      const libraryHooks = hookLibrary[hookType];
      if (Array.isArray(libraryHooks) && libraryHooks.length > 0) {
        hook = libraryHooks[i % libraryHooks.length].replace("{topic}", topic);
      } else {
        hook = pack.hookTemplates[i % pack.hookTemplates.length].replace("{topic}", topic);
      }
    } else {
      hook = pack.hookTemplates[i % pack.hookTemplates.length].replace("{topic}", topic);
    }

    const cta = pack.ctaTemplates[i % pack.ctaTemplates.length];
    const body = [
      `Problem: creators waste time on disconnected tooling for ${topic}.`,
      `System: one pipeline from research -> script -> scene plan -> video -> publish.`,
      `Proof: use beat-timed sections, b-roll keyword mapping, and retention-first structure.`,
      `Execution: ship variants, track CTR/retention, auto-promote the winner.`,
    ].join(" ");

    const title = `${hook.split(".")[0]} | ${pack.angle}`.slice(0, 100);
    const description = [
      `Topic: ${topic}`,
      `Template pack: ${niche}`,
      `Hook-body-CTA structure optimized for short-form retention.`,
      pack.affiliateCta,
    ].join("\n");

    const variant = {
      id: randomUUID(),
      index: i + 1,
      niche_pack: niche,
      hook,
      body,
      cta,
      title,
      description,
      hashtags: hashTags(topic, niche),
      thumbnail_prompt: `High contrast thumbnail about ${topic}, bold 3-word hook, red/yellow accents, no clutter`,
      affiliate_cta_block: {
        tiktok: getAffiliateUrl("tiktok", niche),
        instagram: getAffiliateUrl("instagram", niche),
        youtube: getAffiliateUrl("youtube", niche),
        pinterest: getAffiliateUrl("pinterest", niche),
      },
      voice: {
        provider: process.env.AICC_TTS_PROVIDER || "local",
        voice_id: process.env.AICC_TTS_VOICE || "default",
      },
      avatar: {
        provider: process.env.AICC_AVATAR_PROVIDER || "none",
        preset: process.env.AICC_AVATAR_PRESET || "faceless-motion",
      },
    };
    variant.scene_quality = scenePlan(variant, durationSec, keywords);
    variants.push(variant);
  }

  const campaign = {
    generated_at: new Date().toISOString(),
    topic,
    niche_pack: niche,
    variants_count: variants.length,
    source: {
      brief_path: path.join("reports", "content-creator-brief-latest.json"),
      transcript_index_path: path.join("reports", "youtube-transcript-visual-index-latest.json"),
      transcript_keywords: keywords,
      brief_goal: briefJson.goal || null,
    },
    monetization: {
      affiliate_cta_default: pack.affiliateCta,
      title_strategy: "question+outcome",
      thumbnail_strategy: "bold_hook+contrast",
    },
    variants,
  };

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(campaign, null, 2));
  console.log(`[aicc-campaign-engine] wrote ${out}`);
  console.log(`[aicc-campaign-engine] variants=${variants.length} niche=${niche}`);
}

main();
