#!/usr/bin/env node
"use strict";

/**
 * text-hooks-batch.js
 * Oliver Henry pattern: text hooks in file → combine with demo assets → generate campaign variants.
 * Each line in hooks file = one hook. Pairs with demo images/videos for hook+demo format.
 *
 * Usage:
 *   node scripts/text-hooks-batch.js --hooks data/hooks.txt [--demos data/demos/] [--topic "AI tools"]
 *   node scripts/text-hooks-batch.js --hooks data/hooks.txt --output reports/hook-demo-campaign.json
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data");
const REPORTS = path.join(ROOT, "reports");

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function readHooks(hooksPath) {
  if (!fs.existsSync(hooksPath)) {
    throw new Error(`Hooks file not found: ${hooksPath}`);
  }
  return fs
    .readFileSync(hooksPath, "utf8")
    .split(/\r?\n/g)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function listDemoAssets(demosDir) {
  if (!demosDir || !fs.existsSync(demosDir)) return [];
  return fs
    .readdirSync(demosDir)
    .filter((f) => /\.(mp4|webm|mov|jpg|jpeg|png|webp)$/i.test(f))
    .map((f) => path.join(demosDir, f))
    .sort();
}

function main() {
  const hooksPath = arg("--hooks", path.join(DATA, "hooks.txt"));
  const demosDir = arg("--demos", path.join(DATA, "demos"));
  const topic = arg("--topic", "content creation");
  const niche = arg("--niche", "viral-faceless");
  const outputPath = arg("--output", path.join(REPORTS, "hook-demo-campaign-latest.json"));

  const hooks = readHooks(hooksPath);
  const demos = listDemoAssets(demosDir);

  const variants = hooks.map((hook, i) => {
    const demoPath = demos.length > 0 ? demos[i % demos.length] : null;
    const resolvedHook = topic ? hook.replace(/\{topic\}/g, topic) : hook;
    return {
      id: randomUUID(),
      hook: resolvedHook,
      title: `${topic} | Hook ${i + 1}`,
      description: `${hook}\n\nComment for the full breakdown.`,
      cta: "Save this. Use it in your next post.",
      hashtags: [topic.replace(/\s+/g, ""), "faceless", "contentcreation", "viral"],
      format: "hook_demo",
      demo_asset: demoPath,
      publish_mode: "draft",
    };
  });

  const campaign = {
    generated_at: new Date().toISOString(),
    topic,
    niche,
    format: "hook_demo",
    hook_count: hooks.length,
    demo_count: demos.length,
    variants,
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(campaign, null, 2));

  console.log(`[text-hooks-batch] ${hooks.length} hooks × ${demos.length} demos → ${variants.length} variants`);
  console.log(`[text-hooks-batch] campaign: ${outputPath}`);
  console.log(`[text-hooks-batch] next: node scripts/aicc-autopublish.js draft --campaign ${outputPath}`);
}

main();
