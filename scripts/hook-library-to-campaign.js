#!/usr/bin/env node
"use strict";

/**
 * hook-library-to-campaign.js
 * Exports hook-library.json to hooks.txt and/or triggers text-hooks-batch.
 * Closes the loop: hook-thief → hook-library → hooks.txt → campaign.
 *
 * Usage:
 *   node scripts/hook-library-to-campaign.js --to-hooks-txt
 *   node scripts/hook-library-to-campaign.js --to-campaign --topic "AI tools"
 *   node scripts/hook-library-to-campaign.js --to-hooks-txt --to-campaign --topic "content" --limit 15
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data");
const REPORTS = path.join(ROOT, "reports");
const HOOK_LIBRARY = path.join(DATA, "hook-library.json");
const HOOKS_TXT = path.join(DATA, "hooks.txt");

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function loadLibrary() {
  if (!fs.existsSync(HOOK_LIBRARY)) {
    throw new Error(`Hook library not found: ${HOOK_LIBRARY}. Run hook-thief first.`);
  }
  const lib = JSON.parse(fs.readFileSync(HOOK_LIBRARY, "utf8"));
  return Array.isArray(lib.hooks) ? lib.hooks : [];
}

function toHooksTxt(hooks, limit = 50) {
  const sorted = [...hooks]
    .filter((h) => h.text && h.text.length >= 10)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, limit);
  const lines = [
    "# Exported from hook-library.json",
    "# Replace {topic} via --topic when running text-hooks-batch",
    "",
    ...sorted.map((h) => h.text),
  ];
  fs.mkdirSync(path.dirname(HOOKS_TXT), { recursive: true });
  fs.writeFileSync(HOOKS_TXT, lines.join("\n"));
  return sorted.length;
}

function toCampaign(topic = "content") {
  const result = spawnSync(
    "node",
    [
      path.join(ROOT, "scripts", "text-hooks-batch.js"),
      "--hooks",
      HOOKS_TXT,
      "--topic",
      topic,
      "--output",
      path.join(REPORTS, "hook-demo-campaign-latest.json"),
    ],
    { cwd: ROOT, stdio: "inherit" }
  );
  return result.status === 0;
}

function main() {
  const toHooks = process.argv.includes("--to-hooks-txt");
  const toCamp = process.argv.includes("--to-campaign");
  const topic = arg("--topic", "content");
  const limit = parseInt(arg("--limit", "30"), 10) || 30;

  const hooks = loadLibrary();
  if (hooks.length === 0) {
    console.error("[hook-library-to-campaign] No hooks in library. Run hook-thief first.");
    process.exit(1);
  }

  if (toHooks) {
    const n = toHooksTxt(hooks, limit);
    console.log(`[hook-library-to-campaign] Wrote ${n} hooks to ${HOOKS_TXT}`);
  }

  if (toCamp) {
    if (!toHooks) {
      if (!fs.existsSync(HOOKS_TXT)) {
        toHooksTxt(hooks, limit);
      }
    }
    console.log(`[hook-library-to-campaign] Running text-hooks-batch --topic ${topic}...`);
    const ok = toCampaign(topic);
    if (!ok) process.exit(1);
    console.log(`[hook-library-to-campaign] Campaign: reports/hook-demo-campaign-latest.json`);
  }

  if (!toHooks && !toCamp) {
    console.log("Usage: --to-hooks-txt | --to-campaign | both");
    console.log("  --to-hooks-txt   Export library to data/hooks.txt");
    console.log("  --to-campaign    Run text-hooks-batch (uses hooks.txt)");
    console.log("  --topic X        Topic for campaign (default: content)");
    console.log("  --limit N        Max hooks to export (default: 30)");
  }
}

main();
