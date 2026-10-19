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
  /**
   * Kickstarter + dietary supplement / wellness — hooks and body avoid disease claims,
   * alcohol “recovery,” and symptom relief (align with campaign Trust & Safety review).
   * Use a short {topic} e.g. "Chaser" or "Somavéa Chaser".
   */
  "kickstarter-wellness": {
    angle: "lifestyle morning readiness",
    hookTemplates: [
      "Tomorrow still matters — {topic} is about showing up, not fixing.",
      "Flights, events, real life — {topic} for preparation and morning readiness.",
      "Lifestyle supplement: {topic} for system support and general wellness.",
      "We’re bringing {topic} to Kickstarter — here’s what makes it different.",
      "Peer-not-preachy wellness: {topic} and the morning you want to keep.",
    ],
    ctaTemplates: [
      "Link in bio — waitlist + launch alerts.",
      "Follow for Kickstarter date and backer tiers.",
      "Save this — campaign drops soon.",
      "Notify me: link in bio for updates.",
      "Questions? FAQ on the pre-launch page — link in bio.",
    ],
    affiliateCta: "Official site + Supplement Facts in bio. FDA disclaimer applies.",
    hashtagBase: ["#Wellness", "#Kickstarter", "#MorningRoutine", "#Lifestyle", "#Supplement"],
    bodyVariants: [
      [
        "Story: {topic} is for people who want momentum when the calendar doesn’t pause.",
        "Frame: morning readiness + lifestyle preparation — general wellness, not treating a condition.",
        "Proof: focused formula, quality standards, transparent rewards and shipping on the campaign page.",
        "Ask: join the list — we’ll announce when backers can choose a tier.",
      ],
      [
        "Hook body: where {topic} fits — travel, celebrations, nights you don’t want to trade for tomorrow.",
        "Compliance: statements not evaluated by FDA; product not intended to diagnose, treat, cure, or prevent disease.",
        "Creative: lead with morning contrast and real occasions — not clinical before/after.",
        "CTA: save + follow so you don’t miss the launch window.",
      ],
      [
        "Differentiator: {topic} — preparation beats perfection; no moralizing the night.",
        "Trust: fulfillment regions, caps, and supplement labeling spelled out in Story + FAQ.",
        "Short video: keep first moments morning-forward; product education after the hook lands.",
        "Next step: link in bio for waitlist and updates.",
      ],
    ],
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

function hashTags(topic, niche, pack) {
  const base =
    Array.isArray(pack?.hashtagBase) && pack.hashtagBase.length
      ? [...pack.hashtagBase]
      : ["#AI", "#ContentCreator", "#ShortForm", "#Growth", "#Automation"];
  const topicTag = "#" + String(topic || "AICC").replace(/[^a-z0-9]/gi, "").slice(0, 18);
  const nicheTag = "#" + String(niche || "niche").replace(/[^a-z0-9]/gi, "").slice(0, 18);
  return [...new Set([...base, topicTag, nicheTag])].slice(0, 8);
}

function defaultBody(topic) {
  return [
    `Problem: creators waste time on disconnected tooling for ${topic}.`,
    `System: one pipeline from research -> script -> scene plan -> video -> publish.`,
    `Proof: use beat-timed sections, b-roll keyword mapping, and retention-first structure.`,
    `Execution: ship variants, track CTR/retention, auto-promote the winner.`,
  ].join(" ");
}

function variantBody(pack, topic, variantIndex) {
  const variants = pack.bodyVariants;
  if (Array.isArray(variants) && variants.length) {
    const lines = variants[variantIndex % variants.length];
    return lines.map((line) => line.replace(/\{topic\}/g, topic)).join(" ");
  }
  return defaultBody(topic);
}

function main() {
  const topic = arg("--topic", process.env.AICC_TOPIC || "automated content creator system");
  const niche = arg("--niche", process.env.AICC_NICHE_PACK || "ai-clone-news");
  const variantsCount = Math.max(3, Math.min(5, numArg("--variants", 3)));
  const durationSec = Math.max(15, Math.min(90, numArg("--duration-sec", 38)));
  const out = arg("--out", path.join(REPORTS, "aicc-campaign-latest.json"));
  const runResearch = process.argv.includes("--run-research");

  const pack = NICHE_PACKS[niche] || NICHE_PACKS["ai-clone-news"];

  if (runResearch) {
    run("node", [path.join(ROOT, "scripts", "builder-research-agenda.js"), "--rolling"]);
    run("node", [path.join(ROOT, "scripts", "feature-benchmark-score.js")]);
  }

  const indexJson = readJsonSafe(path.join(REPORTS, "youtube-transcript-visual-index-latest.json"), {});
  const briefJson = readJsonSafe(path.join(REPORTS, "content-creator-brief-latest.json"), {});
  const transcript = extractTranscriptText(indexJson);
  const keywords = topKeywords(`${topic}\n${transcript}`, 10);

  const variants = [];
  for (let i = 0; i < variantsCount; i++) {
    const hook = pack.hookTemplates[i % pack.hookTemplates.length].replace(/\{topic\}/g, topic);
    const cta = pack.ctaTemplates[i % pack.ctaTemplates.length];
    const body = variantBody(pack, topic, i);

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
      hashtags: hashTags(topic, niche, pack),
      thumbnail_prompt: `High contrast thumbnail about ${topic}, bold 3-word hook, red/yellow accents, no clutter`,
      affiliate_cta_block: pack.affiliateCta,
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
