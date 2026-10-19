#!/usr/bin/env node
"use strict";

/**
 * aicc-ab-loop.js
 * Scores campaign variants from retention/CTR metrics and promotes winners.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const REPORTS = path.join(ROOT, "reports");

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  return String(process.argv[i + 1] || "").trim() || fallback;
}

function readJson(file, fallback = null) {
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

function normalizeMetric(m, key) {
  const v = Number(m?.[key]);
  return Number.isFinite(v) ? v : 0;
}

function scoreMetricSet(metric) {
  const retention = normalizeMetric(metric, "retention_30s_pct");
  const ctr = normalizeMetric(metric, "ctr_pct");
  const watch = normalizeMetric(metric, "avg_watch_sec");
  const oneSecHold = normalizeMetric(metric, "one_sec_hold_pct");
  const threeSecView = normalizeMetric(metric, "three_sec_view_pct");
  const completion = normalizeMetric(metric, "completion_pct");
  const saves = normalizeMetric(metric, "saves");
  const shares = normalizeMetric(metric, "shares");
  const comments = normalizeMetric(metric, "comments");
  const skipDropoffMs = normalizeMetric(metric, "skip_dropoff_ms");
  const engagement = Math.min(100, saves * 0.5 + shares * 0.8 + comments * 0.7);
  const hookHold = oneSecHold || threeSecView ? oneSecHold * 0.25 + threeSecView * 0.35 : retention * 0.4;
  const completionScore = completion || retention;
  const dropoffScore = Math.min(100, skipDropoffMs / 30);
  return hookHold + completionScore * 0.2 + ctr * 0.15 + watch * 0.08 + engagement * 0.08 + dropoffScore * 0.04;
}

function main() {
  const campaignFile = arg("--campaign", path.join(REPORTS, "aicc-campaign-latest.json"));
  const metricsFile = arg("--metrics", path.join(REPORTS, "aicc-metrics-latest.json"));
  const out = arg("--out", path.join(REPORTS, "aicc-ab-results-latest.json"));
  const championOut = arg("--champion-out", path.join(REPORTS, "aicc-promoted-variant-latest.json"));

  const campaign = readJson(campaignFile, null);
  if (!campaign || !Array.isArray(campaign.variants)) {
    throw new Error(`invalid campaign file: ${campaignFile}`);
  }

  const metrics = readJson(metricsFile, { variants: [] });
  const metricRows = Array.isArray(metrics?.variants) ? metrics.variants : [];
  const byId = new Map(metricRows.map((m) => [m.variant_id, m]));

  const scored = campaign.variants.map((v) => {
    const m = byId.get(v.id) || {};
    const score = scoreMetricSet(m);
    return {
      variant_id: v.id,
      title: v.title,
      niche_pack: v.niche_pack,
      score,
      one_sec_hold_pct: normalizeMetric(m, "one_sec_hold_pct"),
      three_sec_view_pct: normalizeMetric(m, "three_sec_view_pct"),
      skip_dropoff_ms: normalizeMetric(m, "skip_dropoff_ms"),
      completion_pct: normalizeMetric(m, "completion_pct"),
      saves: normalizeMetric(m, "saves"),
      shares: normalizeMetric(m, "shares"),
      comments: normalizeMetric(m, "comments"),
      retention_30s_pct: normalizeMetric(m, "retention_30s_pct"),
      ctr_pct: normalizeMetric(m, "ctr_pct"),
      avg_watch_sec: normalizeMetric(m, "avg_watch_sec"),
      impressions: normalizeMetric(m, "impressions"),
      clicks: normalizeMetric(m, "clicks"),
    };
  }).sort((a, b) => b.score - a.score);

  const winner = scored[0] || null;
  const result = {
    generated_at: new Date().toISOString(),
    campaign_topic: campaign.topic,
    scored_variants: scored,
    winner,
    recommendation: winner
      ? `Promote variant ${winner.variant_id} and down-rank variants below score delta 10.`
      : "No winner available",
  };

  writeJson(out, result);
  if (winner) {
    writeJson(championOut, {
      generated_at: new Date().toISOString(),
      campaign_topic: campaign.topic,
      winner,
      action: "auto-promote",
    });
  }

  console.log(`[aicc-ab-loop] wrote ${out}`);
  if (winner) {
    console.log(`[aicc-ab-loop] winner=${winner.variant_id} score=${winner.score.toFixed(2)}`);
  }
}

try {
  main();
} catch (err) {
  console.error(`[aicc-ab-loop] fatal: ${err.message}`);
  process.exit(1);
}
