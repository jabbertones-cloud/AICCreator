#!/usr/bin/env node
"use strict";

/**
 * larry-autopublish-agent.js
 * Larry-style automation: scheduled TikTok/IG posting agent.
 * Runs aicc-autopublish run-due on schedule (cron) or on-demand.
 * Pair with PM2 or systemd for continuous operation.
 *
 * Usage:
 *   node scripts/larry-autopublish-agent.js run        # Process due jobs once
 *   node scripts/larry-autopublish-agent.js run --draft # Draft mode
 *   node scripts/larry-autopublish-agent.js schedule   # Ensure queue has items (triggers campaign if empty)
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data");
const QUEUE_FILE = path.join(DATA, "aicc-publish-queue.json");

function runAutopublish(args = []) {
  const result = spawnSync("node", [path.join(ROOT, "scripts", "aicc-autopublish.js"), ...args], {
    cwd: ROOT,
    stdio: "inherit",
  });
  return result.status === 0;
}

function ensureCampaign() {
  const campaignPath = path.join(ROOT, "reports", "aicc-campaign-latest.json");
  if (fs.existsSync(campaignPath)) {
    const camp = JSON.parse(fs.readFileSync(campaignPath, "utf8"));
    if (camp.variants && camp.variants.length > 0) return true;
  }
  console.log("[larry-autopublish] No campaign found, running campaign engine...");
  const r = spawnSync("node", [path.join(ROOT, "scripts", "aicc-campaign-engine.js"), "--topic", "content creation", "--niche", "tiktok-slideshow"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  return r.status === 0;
}

function main() {
  const cmd = process.argv[2] || "run";
  const draft = process.argv.includes("--draft");

  if (cmd === "run") {
    const queue = (() => {
      try {
        return JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8"));
      } catch {
        return { items: [] };
      }
    })();
    const dueCount = (queue.items || []).filter(
      (i) => i.status === "scheduled" && new Date(i.scheduled_at).getTime() <= Date.now()
    ).length;
    if (dueCount === 0) {
      console.log("[larry-autopublish] No due jobs in queue");
      return;
    }
    const ok = runAutopublish(["run-due"]);
    process.exit(ok ? 0 : 1);
  }

  if (cmd === "schedule") {
    if (!ensureCampaign()) {
      console.error("[larry-autopublish] Failed to ensure campaign");
      process.exit(1);
    }
    const ok = runAutopublish([
      "schedule",
      "--campaign", path.join(ROOT, "reports", "aicc-campaign-latest.json"),
      "--platforms", "tiktok,instagram",
      "--spacing-min", "180",
    ]);
    process.exit(ok ? 0 : 1);
  }

  console.log("Usage: run | schedule [--draft]");
}

main();
