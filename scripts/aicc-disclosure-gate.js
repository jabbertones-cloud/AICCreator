#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CONFIG_FILE = path.join(ROOT, "config", "aicc-plushtrap-stack.json");
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

function variantText(v) {
  return [v.title, v.hook, v.body, v.cta, v.description, ...(v.hashtags || [])].filter(Boolean).join("\n");
}

function checkVariant(v, config) {
  const text = variantText(v);
  const lower = text.toLowerCase();
  const phrases = config?.disclosure?.phrases || [];
  const hasDisclosure = phrases.some((p) => lower.includes(String(p).toLowerCase()));
  const forbidden = (config?.disclosure?.forbidden_claim_patterns || [])
    .map((p) => new RegExp(p, "i"))
    .filter((re) => re.test(text))
    .map((re) => re.source);
  const failures = [];
  if (!hasDisclosure) failures.push("missing_virtual_creator_disclosure");
  for (const pattern of forbidden) failures.push(`forbidden_claim:${pattern}`);
  return {
    variant_id: v.id || String(v.index || "unknown"),
    title: v.title || "",
    ok: failures.length === 0,
    failures,
  };
}

function loadVariants(file) {
  const payload = readJson(file, null);
  if (!payload) throw new Error(`invalid json: ${file}`);
  if (Array.isArray(payload.variants)) return payload.variants;
  if (payload.variant) return [payload.variant];
  if (payload.payload?.variant) return [payload.payload.variant];
  throw new Error(`no variants found: ${file}`);
}

function main() {
  const file = path.resolve(arg("--campaign", arg("--file", path.join(REPORTS, "aicc-campaign-latest.json"))));
  const out = path.resolve(arg("--out", path.join(REPORTS, "aicc-disclosure-gate-latest.json")));
  const config = readJson(CONFIG_FILE, {});
  const variants = loadVariants(file);
  const checks = variants.map((v) => checkVariant(v, config));
  const failed = checks.filter((c) => !c.ok);
  const result = {
    generated_at: new Date().toISOString(),
    file,
    ok: failed.length === 0,
    checked: checks.length,
    failed: failed.length,
    checks,
  };
  writeJson(out, result);
  console.log(`[aicc-disclosure-gate] checked=${checks.length} failed=${failed.length} out=${out}`);
  if (failed.length) process.exit(1);
}

try {
  main();
} catch (err) {
  console.error(`[aicc-disclosure-gate] fatal: ${err.message}`);
  process.exit(1);
}
