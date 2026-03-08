#!/usr/bin/env node
"use strict";

const { spawnSync } = require("child_process");

const patterns = [
  "/Users/",
  "MacBook-Pro",
  "tatsheen",
  "jamonwidit@",
  "plushtrap\\.com",
  "plushtrap/",
  "Tatsheens-Mini",
  "\\(408\\) 386-1907",
  "408-386-1907",
  "/Volumes/home/Storage",
  "\\bScott\\b",
];

const cmd = [
  "-n",
  patterns.join("|"),
  "--glob", "!.git/**",
  "--glob", "!node_modules/**",
  "--glob", "!.venv-openclaw-tools/**",
  "--glob", "!reports/**",
  "--glob", "!agent-state/**",
];

const r = spawnSync("rg", cmd, { stdio: "pipe", encoding: "utf8" });

if (r.status === 0) {
  console.error("[public-safety-check] FAILED: potential public-info leak patterns found:");
  process.stderr.write(r.stdout || "");
  process.exit(1);
}

if (r.status === 1) {
  console.log("[public-safety-check] PASS: no blocked patterns found.");
  process.exit(0);
}

console.error("[public-safety-check] ERROR: ripgrep command failed.");
process.stderr.write(r.stderr || "");
process.exit(2);
