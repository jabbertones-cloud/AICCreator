#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data");
const REPORTS = path.join(ROOT, "reports");
const QUEUE_FILE = path.join(DATA, "aicc-render-queue.jsonl");
const ROUTER_CONFIG = path.join(ROOT, "config", "aicc-plushtrap-stack.json");

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  return String(process.argv[i + 1] || "").trim() || fallback;
}

function has(flag) {
  return process.argv.includes(flag);
}

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function queueFile() {
  return path.resolve(arg("--queue", QUEUE_FILE));
}

function inferProvider(shotType) {
  const config = readJson(ROUTER_CONFIG, {});
  return config?.render_router?.[shotType]?.provider || "manual";
}

function cmdAdd(file) {
  const shotType = arg("--shot-type", "manual");
  const provider = arg("--provider", inferProvider(shotType));
  const prompt = arg("--prompt", "");
  if (!prompt) throw new Error("--prompt required");
  const refs = (arg("--refs", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const row = {
    id: arg("--id", randomUUID()),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: "planned",
    provider,
    shot_type: shotType,
    prompt,
    workflow_path: arg("--workflow", ""),
    reference_assets: refs,
    preflight: {
      estimated_cost_usd: Number(arg("--estimated-cost", "0")) || 0,
      credits_checked: has("--credits-checked"),
      identity_required: has("--identity-required"),
      product_required: has("--product-required"),
    },
  };
  const rows = readJsonl(file);
  rows.push(row);
  writeJsonl(file, rows);
  console.log(`[aicc-render-queue] added ${row.id} provider=${provider} shot_type=${shotType}`);
}

async function submitComfy(job) {
  const url = (process.env.COMFYUI_URL || "http://127.0.0.1:8188").replace(/\/$/, "");
  if (!job.workflow_path) return { ok: false, error: "workflow_path required for comfyui submit" };
  const workflowPath = path.resolve(job.workflow_path);
  const workflow = readJson(workflowPath, null);
  if (!workflow) return { ok: false, error: `invalid workflow json: ${workflowPath}` };
  const payload = workflow.prompt ? workflow : { prompt: workflow };
  const res = await fetch(`${url}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: `comfyui submit failed ${res.status}: ${JSON.stringify(json)}` };
  return { ok: true, external_prompt_id: json.prompt_id || json.number || "", raw: json };
}

async function cmdSubmit(file) {
  const dryRun = has("--dry-run");
  const rows = readJsonl(file);
  const id = arg("--id", "");
  let count = 0;
  for (const job of rows) {
    if (id && job.id !== id) continue;
    if (job.status !== "planned") continue;
    job.updated_at = new Date().toISOString();
    if (dryRun || job.provider !== "comfyui") {
      job.status = "submitted";
      job.external_prompt_id = dryRun ? `dry:${job.id}` : job.external_prompt_id || "";
      job.result = { note: dryRun ? "dry run submit" : "external provider submit pending adapter" };
      count += 1;
      continue;
    }
    const out = await submitComfy(job);
    if (out.ok) {
      job.status = "submitted";
      job.external_prompt_id = out.external_prompt_id;
      job.result = out.raw;
    } else {
      job.status = "failed";
      job.error = out.error;
    }
    count += 1;
  }
  writeJsonl(file, rows);
  console.log(`[aicc-render-queue] submitted=${count} dry_run=${dryRun}`);
}

function cmdSetStatus(file) {
  const id = arg("--id", "");
  const status = arg("--status", "");
  if (!id || !status) throw new Error("--id and --status required");
  const rows = readJsonl(file);
  const job = rows.find((r) => r.id === id);
  if (!job) throw new Error(`job not found: ${id}`);
  job.status = status;
  job.updated_at = new Date().toISOString();
  const resultPath = arg("--result-path", "");
  if (resultPath) job.result = { ...(job.result || {}), path: resultPath };
  writeJsonl(file, rows);
  console.log(`[aicc-render-queue] ${id} status=${status}`);
}

function cmdList(file) {
  const rows = readJsonl(file);
  if (has("--json")) {
    console.log(JSON.stringify({ file, count: rows.length, jobs: rows }, null, 2));
    return;
  }
  for (const job of rows) {
    console.log(`${job.status}\t${job.provider}\t${job.shot_type}\t${job.id}\t${job.prompt.slice(0, 80)}`);
  }
}

function cmdReport(file) {
  const rows = readJsonl(file);
  const byStatus = {};
  const byProvider = {};
  for (const row of rows) {
    byStatus[row.status] = (byStatus[row.status] || 0) + 1;
    byProvider[row.provider] = (byProvider[row.provider] || 0) + 1;
  }
  const out = path.resolve(arg("--out", path.join(REPORTS, "aicc-render-queue-latest.json")));
  writeJson(out, { generated_at: new Date().toISOString(), file, count: rows.length, byStatus, byProvider, jobs: rows });
  console.log(`[aicc-render-queue] report=${out}`);
}

async function main() {
  const cmd = process.argv[2] || "help";
  const file = queueFile();
  if (cmd === "add") return cmdAdd(file);
  if (cmd === "submit") return cmdSubmit(file);
  if (cmd === "set-status") return cmdSetStatus(file);
  if (cmd === "list") return cmdList(file);
  if (cmd === "report") return cmdReport(file);
  console.log("Usage:");
  console.log("  node scripts/aicc-render-queue.js add --shot-type human_motion --prompt <text> [--refs a,b] [--credits-checked]");
  console.log("  node scripts/aicc-render-queue.js submit [--id <job>] [--dry-run]");
  console.log("  node scripts/aicc-render-queue.js set-status --id <job> --status ready_for_qa [--result-path file.mp4]");
  console.log("  node scripts/aicc-render-queue.js list [--json]");
  console.log("  node scripts/aicc-render-queue.js report");
}

main().catch((err) => {
  console.error(`[aicc-render-queue] fatal: ${err.message}`);
  process.exit(1);
});
