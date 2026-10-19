#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data");
const DEFAULT_LEDGER = path.join(DATA, "aicc-source-ledger.jsonl");
const VALID_STATUS = new Set(["verified_external", "notebook_sot", "local_asset", "operator_assumption", "rejected"]);

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  return String(process.argv[i + 1] || "").trim() || fallback;
}

function has(flag) {
  return process.argv.includes(flag);
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function appendJsonl(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}

function cmdAdd(file) {
  const sourceType = arg("--source-type", "operator_note");
  const urlOrPath = arg("--url-or-path", "");
  const claim = arg("--claim", "");
  const status = arg("--status", "operator_assumption");
  const agent = arg("--agent", "operator");
  const allowedUse = arg("--allowed-use", "research_only");

  if (!claim) throw new Error("--claim required");
  if (!VALID_STATUS.has(status)) throw new Error(`invalid --status: ${status}`);

  const row = {
    source_id: arg("--source-id", randomUUID()),
    source_type: sourceType,
    url_or_path: urlOrPath,
    claim,
    verification_status: status,
    last_checked_at: new Date().toISOString(),
    agent,
    allowed_use: allowedUse,
  };

  appendJsonl(file, row);
  console.log(`[aicc-source-ledger] added ${row.source_id} status=${status}`);
}

function cmdList(file) {
  const rows = readJsonl(file);
  const status = arg("--status", "");
  const filtered = status ? rows.filter((r) => r.verification_status === status) : rows;
  if (has("--json")) {
    console.log(JSON.stringify({ file, count: filtered.length, rows: filtered }, null, 2));
    return;
  }
  for (const row of filtered) {
    console.log(`${row.verification_status}\t${row.source_id}\t${row.source_type}\t${row.claim}`);
  }
}

function cmdGate(file) {
  const rows = readJsonl(file);
  const bad = rows.filter((r) => !VALID_STATUS.has(r.verification_status));
  const publishBad = rows.filter((r) => r.allowed_use === "publish" && !["verified_external", "notebook_sot", "local_asset"].includes(r.verification_status));
  if (bad.length || publishBad.length) {
    console.error(`[aicc-source-ledger] gate failed invalid=${bad.length} publish_bad=${publishBad.length}`);
    if (has("--json")) console.error(JSON.stringify({ invalid: bad, publish_bad: publishBad }, null, 2));
    process.exit(1);
  }
  console.log(`[aicc-source-ledger] gate pass rows=${rows.length}`);
}

function main() {
  const cmd = process.argv[2] || "help";
  const file = path.resolve(arg("--ledger", DEFAULT_LEDGER));
  if (cmd === "add") return cmdAdd(file);
  if (cmd === "list") return cmdList(file);
  if (cmd === "gate") return cmdGate(file);
  console.log("Usage:");
  console.log("  node scripts/aicc-source-ledger.js add --claim <text> --status verified_external --source-type url --url-or-path https://...");
  console.log("  node scripts/aicc-source-ledger.js list [--json]");
  console.log("  node scripts/aicc-source-ledger.js gate [--json]");
}

try {
  main();
} catch (err) {
  console.error(`[aicc-source-ledger] fatal: ${err.message}`);
  process.exit(1);
}
