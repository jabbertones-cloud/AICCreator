#!/usr/bin/env node
"use strict";

/**
 * tiktok-hook-analytics.js
 * Viral hook analysis: rank hooks by performance (views, likes, engagement).
 * Input: JSON/CSV of posts with hook/caption + metrics.
 * Output: Ranked hooks for hook-library scoring, top performers for reuse.
 *
 * Usage:
 *   node scripts/tiktok-hook-analytics.js --input reports/tiktok-analytics-export.json
 *   node scripts/tiktok-hook-analytics.js --input data/tiktok-posts.csv --format csv
 *   node scripts/tiktok-hook-analytics.js --input reports/tiktok-analytics-export.json --update-library
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data");
const REPORTS = path.join(ROOT, "reports");
const HOOK_LIBRARY = path.join(DATA, "hook-library.json");

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function loadInput(inputPath, format = "json") {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input not found: ${inputPath}`);
  }
  const raw = fs.readFileSync(inputPath, "utf8");

  if (format === "csv") {
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
    return lines.slice(1).map((line) => {
      const vals = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map((v) => v.replace(/^"|"$/g, "").trim());
      const row = {};
      headers.forEach((h, i) => (row[h] = vals[i] || ""));
      return row;
    });
  }

  const data = JSON.parse(raw);
  return Array.isArray(data) ? data : data.posts || data.videos || data.items || [];
}

function normalizePost(p) {
  const hook = p.hook || p.caption || p.title || p.description || "";
  const hookText = (typeof hook === "string" ? hook : hook.text || "").split(/\n/)[0].trim().slice(0, 200);
  const views = parseInt(p.views || p.play_count || p.view_count || 0, 10) || 0;
  const likes = parseInt(p.likes || p.digg_count || p.like_count || 0, 10) || 0;
  const comments = parseInt(p.comments || p.comment_count || 0, 10) || 0;
  const shares = parseInt(p.shares || p.share_count || 0, 10) || 0;
  const engagement = likes + comments * 2 + shares * 3;
  const engagementRate = views > 0 ? engagement / views : 0;
  return {
    hook: hookText,
    views,
    likes,
    comments,
    shares,
    engagement,
    engagementRate,
  };
}

function rankHooks(posts) {
  const byHook = new Map();
  for (const p of posts) {
    const n = normalizePost(p);
    if (!n.hook || n.hook.length < 10) continue;
    const key = n.hook.toLowerCase().slice(0, 100);
    if (!byHook.has(key)) {
      byHook.set(key, { hook: n.hook, views: 0, engagement: 0, count: 0 });
    }
    const agg = byHook.get(key);
    agg.views += n.views;
    agg.engagement += n.engagement;
    agg.count += 1;
  }

  return [...byHook.values()]
    .map((a) => ({
      ...a,
      avgViews: a.count > 0 ? a.views / a.count : 0,
      viralScore: Math.log10(a.views + 1) + Math.log10(a.engagement + 1),
    }))
    .sort((a, b) => b.viralScore - a.viralScore);
}

function updateHookLibrary(ranked, topN = 20) {
  let library = { version: "1.0.0", updated_at: new Date().toISOString(), total: 0, hooks: [] };
  if (fs.existsSync(HOOK_LIBRARY)) {
    try {
      library = JSON.parse(fs.readFileSync(HOOK_LIBRARY, "utf8"));
      if (!Array.isArray(library.hooks)) library.hooks = [];
    } catch {
      library.hooks = [];
    }
  }

  const existing = new Set(library.hooks.map((h) => (h.text || "").toLowerCase()));
  let added = 0;
  for (let i = 0; i < Math.min(topN, ranked.length); i++) {
    const r = ranked[i];
    const key = r.hook.toLowerCase().slice(0, 100);
    if (existing.has(key)) continue;
    library.hooks.push({
      id: `analytics-${Date.now()}-${i}`,
      text: r.hook,
      category: "viral",
      niche: "general",
      platform: ["tiktok"],
      score: Math.min(0.99, 0.7 + (i / topN) * 0.25),
      source: "tiktok_analytics",
      views: r.views,
      engagement: r.engagement,
    });
    existing.add(key);
    added++;
  }
  library.total = library.hooks.length;
  library.updated_at = new Date().toISOString();
  fs.writeFileSync(HOOK_LIBRARY, JSON.stringify(library, null, 2));
  return added;
}

function main() {
  const inputPath = arg("--input", path.join(REPORTS, "tiktok-analytics-export.json"));
  const format = (arg("--format", "json") || "json").toLowerCase();
  const updateLibrary = process.argv.includes("--update-library");
  const outputPath = arg("--output", path.join(REPORTS, "tiktok-hook-analytics-latest.json"));

  const posts = loadInput(inputPath, format);
  const ranked = rankHooks(posts);

  const out = {
    generated_at: new Date().toISOString(),
    input: inputPath,
    posts_analyzed: posts.length,
    unique_hooks: ranked.length,
    top_hooks: ranked.slice(0, 30),
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(out, null, 2));

  console.log(`[tiktok-hook-analytics] Analyzed ${posts.length} posts → ${ranked.length} unique hooks`);
  console.log(`[tiktok-hook-analytics] Output: ${outputPath}`);

  if (ranked.length > 0) {
    console.log("\nTop 5 viral hooks:");
    ranked.slice(0, 5).forEach((r, i) => {
      console.log(`  ${i + 1}. (${r.views} views, score ${r.viralScore.toFixed(2)}) ${r.hook.slice(0, 60)}...`);
    });
  }

  if (updateLibrary && ranked.length > 0) {
    const added = updateHookLibrary(ranked);
    console.log(`\n[tiktok-hook-analytics] Added ${added} hooks to library`);
  }
}

main();
