#!/usr/bin/env node
"use strict";

/**
 * content-creator-pipeline.js
 * Single pipeline: YouTube URLs → index → brief → Reddit search → builder research agenda.
 * Use for "automated content creator" flow. Optionally pass --keyshots 0 to avoid video download (transcript + metadata only).
 *
 * Usage:
 *   node scripts/content-creator-pipeline.js
 *   node scripts/content-creator-pipeline.js --keyshots 0
 *   node scripts/content-creator-pipeline.js --no-reddit   (skip reddit:search)
 *   node scripts/content-creator-pipeline.js --no-research (skip builder:research:agenda)
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");

function run(cmd, args, opts = {}) {
  const cwd = opts.cwd || ROOT;
  const env = { ...process.env, ...opts.env };
  const r = spawnSync(cmd, args, {
    cwd,
    env,
    stdio: opts.silent ? "pipe" : "inherit",
    encoding: "utf8",
    timeout: opts.timeout || 300000,
  });
  return { ok: r.status === 0, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function hasArg(flag) {
  return process.argv.includes(flag);
}

function getArg(flag, fallback = null) {
  const idx = process.argv.indexOf(flag);
  if (idx < 0 || idx + 1 >= process.argv.length) return fallback;
  const value = String(process.argv[idx + 1] || "").trim();
  return value || fallback;
}

function main() {
  const keyshots = hasArg("--keyshots") ? process.argv[process.argv.indexOf("--keyshots") + 1] : "0";
  const noReddit = hasArg("--no-reddit");
  const noResearch = hasArg("--no-research");
  const includeComments = hasArg("--comments");
  const singleUrl = getArg("--url", null);
  const outJson = getArg("--out", path.join(ROOT, "reports", "youtube-transcript-visual-index-latest.json"));

  console.log("[content-creator-pipeline] 1. YouTube index (transcript + metadata, keyshots=" + keyshots + ", comments=" + includeComments + ")");
  const urlsFile = path.join(ROOT, "data", "youtube-urls.txt");
  if (!singleUrl && !fs.existsSync(urlsFile)) {
    console.error("[content-creator-pipeline] Missing data/youtube-urls.txt. Add one YouTube URL per line.");
    process.exit(1);
  }
  const indexArgs = ["--out", outJson, "--keyshots", String(keyshots)];
  if (singleUrl) {
    indexArgs.push("--url", singleUrl);
  } else {
    indexArgs.push("--urls-file", urlsFile);
  }
  if (includeComments) indexArgs.push("--comments");
  const indexRes = run("node", [path.join(ROOT, "scripts", "youtube-transcript-visual-index.js"), ...indexArgs]);
  if (!indexRes.ok) {
    console.error("[content-creator-pipeline] YouTube index failed. Try --keyshots 0 if disk is tight.");
    process.exit(2);
  }

  console.log("\n[content-creator-pipeline] 2. Extract brief (docs/INAYAN-BUILDER-VIDEO-SPEC.md + JSON manifest)");
  const briefRes = run("node", [
    path.join(ROOT, "scripts", "youtube-index-to-brief.js"),
    "--json", path.join(ROOT, "reports", "content-creator-brief-latest.json"),
  ]);
  if (!briefRes.ok) {
    console.error("[content-creator-pipeline] Brief generation failed.");
    process.exit(3);
  }

  if (!noReddit) {
    console.log("\n[content-creator-pipeline] 3. Reddit search");
    const redditRes = run("npm", ["run", "-s", "reddit:search"], { timeout: 90000 });
    if (!redditRes.ok) console.warn("[content-creator-pipeline] Reddit search failed (non-fatal).");
  } else {
    console.log("\n[content-creator-pipeline] 3. Reddit search (skipped --no-reddit)");
  }

  if (!noResearch) {
    console.log("\n[content-creator-pipeline] 4. Builder research agenda (from rolling gap)");
    const agendaRes = run("node", [path.join(ROOT, "scripts", "builder-research-agenda.js"), "--rolling"], { timeout: 30000 });
    if (!agendaRes.ok) console.warn("[content-creator-pipeline] Builder research agenda failed (non-fatal).");
  } else {
    console.log("\n[content-creator-pipeline] 4. Builder research agenda (skipped --no-research)");
  }

  console.log("\n[content-creator-pipeline] Done.");
  console.log("  - Brief: docs/INAYAN-BUILDER-VIDEO-SPEC.md");
  console.log("  - Brief JSON: reports/content-creator-brief-latest.json");
  console.log("  - Index: " + outJson);
  console.log("  - Reddit: reports/reddit-search-research-latest.json");
  console.log("  - Research: reports/builder-research-agenda-latest.json");
  console.log("  Next: Use brief + research to run copy generation (e.g. POST /api/goal with a content goal, or copy_lab_run / aicreator task).");
}

main();
