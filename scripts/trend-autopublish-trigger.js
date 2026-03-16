#!/usr/bin/env node
"use strict";
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const REPORTS = path.join(ROOT, "reports");

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const TREND_THRESHOLD = parseFloat(process.env.AICC_TREND_THRESHOLD || "0.7");

async function loadTrendsBrief() {
  try {
    const briefPath = path.join(REPORTS, "weekly-trends-brief-latest.json");
    if (!fs.existsSync(briefPath)) {
      return null;
    }
    const content = fs.readFileSync(briefPath, "utf8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function scoreTrend(brief) {
  if (!brief) return 0;

  if (typeof brief.trend_score === "number") {
    return brief.trend_score;
  }

  if (Array.isArray(brief.topics)) {
    const scores = brief.topics
      .map((t) => (typeof t.score === "number" ? t.score : 0))
      .filter((s) => s > 0);
    if (scores.length > 0) {
      return Math.max(...scores);
    }
  }

  return 0;
}

function triggerCampaign(topic, niche) {
  console.log(
    `[trend-autopublish-trigger] Triggering campaign for topic="${topic}" niche="${niche}"`
  );

  const result = spawnSync("node", [
    path.join(ROOT, "scripts", "aicc-campaign-engine.js"),
    "--topic",
    topic,
    "--niche",
    niche,
    "--run-research",
  ]);

  if (result.error) {
    console.error(
      `[trend-autopublish-trigger] Failed to trigger campaign: ${result.error.message}`
    );
    return false;
  }

  if (result.status !== 0) {
    console.error(`[trend-autopublish-trigger] Campaign trigger failed with status ${result.status}`);
    if (result.stderr) {
      console.error(result.stderr);
    }
    return false;
  }

  console.log("[trend-autopublish-trigger] Campaign triggered successfully");
  return true;
}

async function main() {
  console.log(`[trend-autopublish-trigger] Starting trend check (threshold=${TREND_THRESHOLD})`);

  let brief = await loadTrendsBrief();

  if (!brief) {
    console.log("[trend-autopublish-trigger] No trends brief found, running rolling research");
    const result = spawnSync("node", [
      path.join(ROOT, "scripts", "weekly-trends-brief.js"),
      "--rolling",
    ]);

    if (result.status !== 0) {
      console.error("[trend-autopublish-trigger] Failed to run trends research");
      if (result.stderr) {
        console.error(result.stderr);
      }
      process.exit(1);
    }

    brief = await loadTrendsBrief();
    if (!brief) {
      console.error("[trend-autopublish-trigger] Still no trends brief after research");
      process.exit(1);
    }
  }

  const score = scoreTrend(brief);
  console.log(`[trend-autopublish-trigger] Trend score: ${score.toFixed(3)}`);

  const triggered = score >= TREND_THRESHOLD;
  let triggeredTopic = null;

  if (triggered) {
    let topic = "ai-automation";
    if (brief.topics && Array.isArray(brief.topics) && brief.topics.length > 0) {
      topic = brief.topics[0].topic || brief.topics[0].name || topic;
    } else if (typeof brief.topic === "string") {
      topic = brief.topic;
    }

    triggeredTopic = topic;
    const niche = arg("--niche", process.env.AICC_NICHE_PACK || "ai-clone-news");
    const success = triggerCampaign(topic, niche);

    if (!success) {
      console.error("[trend-autopublish-trigger] Campaign trigger failed");
    }
  } else {
    console.log(
      `[trend-autopublish-trigger] Trend score ${score.toFixed(3)} below threshold ${TREND_THRESHOLD}, skipping auto-trigger`
    );
  }

  const report = {
    checked_at: new Date().toISOString(),
    score: Number(score.toFixed(3)),
    threshold: TREND_THRESHOLD,
    triggered,
    topic: triggeredTopic,
  };

  const reportPath = path.join(REPORTS, "trend-trigger-latest.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`[trend-autopublish-trigger] Wrote report to ${reportPath}`);
}

main().catch((err) => {
  console.error(`trend-autopublish-trigger failed: ${err.message}`);
  process.exit(1);
});
