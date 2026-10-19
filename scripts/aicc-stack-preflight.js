#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const REPORTS = path.join(ROOT, "reports");
const CONFIG_FILE = path.join(ROOT, "config", "aicc-agent-team.json");

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

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function cmd(name, args = []) {
  const r = spawnSync(name, args, { encoding: "utf8", stdio: "pipe", timeout: 15000 });
  return {
    name,
    args,
    ok: r.status === 0,
    status: r.status,
    stdout: String(r.stdout || "").trim(),
    stderr: String(r.stderr || "").trim(),
  };
}

function checkCommand(label, name, args = []) {
  const r = cmd(name, args);
  return { id: label, ok: r.ok, detail: r.ok ? r.stdout.split(/\r?\n/)[0] || "ok" : r.stderr || "missing" };
}

function optionalCheck(check) {
  return { ...check, optional: true };
}

function ollamaModels() {
  const r = cmd("ollama", ["list"]);
  if (!r.ok) return { ok: false, models: [], detail: r.stderr || "ollama list failed" };
  const models = r.stdout
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean);
  return { ok: true, models, detail: `${models.length} models` };
}

async function checkHttp(label, url) {
  if (!url) return { id: label, ok: false, optional: true, detail: "url not configured" };
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(t);
    return { id: label, ok: res.ok, detail: `${res.status} ${url}` };
  } catch (err) {
    return { id: label, ok: false, optional: true, detail: err.message };
  }
}

async function main() {
  const out = path.resolve(arg("--out", path.join(REPORTS, "aicc-stack-preflight-latest.json")));
  const strict = has("--strict");
  const agentConfig = readJson(CONFIG_FILE, {});
  const ollama = ollamaModels();
  const requiredModels = Object.values(agentConfig.model_routes || {})
    .map((r) => r.model)
    .filter((m) => m && m !== "cli-default");
  const missingModels = ollama.ok ? requiredModels.filter((m) => !ollama.models.includes(m)) : requiredModels;

  const checks = [
    checkCommand("node", "node", ["-v"]),
    checkCommand("npm", "npm", ["-v"]),
    checkCommand("ollama", "ollama", ["--version"]),
    checkCommand("hermes", "hermes", ["--version"]),
    checkCommand("nlm", "nlm", ["--version"]),
    checkCommand("gemini", "gemini", ["--version"]),
    checkCommand("ffmpeg", "ffmpeg", ["-version"]),
    optionalCheck(checkCommand("n8n", "n8n", ["--version"])),
    {
      id: "ollama_models",
      ok: ollama.ok && missingModels.length === 0,
      optional: missingModels.length > 0,
      detail: missingModels.length ? `missing recommended models: ${missingModels.join(", ")}` : ollama.detail,
      models: ollama.models,
    },
    await checkHttp("comfyui", process.env.COMFYUI_URL ? `${process.env.COMFYUI_URL.replace(/\/$/, "")}/system_stats` : "http://127.0.0.1:8188/system_stats"),
    await checkHttp("n8n_health", process.env.N8N_HEALTH_URL || ""),
  ];

  const failed = checks.filter((c) => !c.ok && (strict || !c.optional));
  const result = {
    generated_at: new Date().toISOString(),
    ok: failed.length === 0,
    strict,
    checks,
    failed: failed.map((c) => c.id),
    recommendations: [
      "Install n8n or configure N8N_HEALTH_URL before automation publish path.",
      "Run Hermes update when active jobs allow.",
      "Add qwen3:14b or qwen3:30b-a3b class model on M3 Max if memory allows.",
      "Start ComfyUI on 127.0.0.1:8188 or set COMFYUI_URL.",
    ],
  };
  writeJson(out, result);
  console.log(`[aicc-stack-preflight] ok=${result.ok} failed=${result.failed.join(",") || "none"} out=${out}`);
  if (!result.ok) process.exit(1);
}

main().catch((err) => {
  console.error(`[aicc-stack-preflight] fatal: ${err.message}`);
  process.exit(1);
});
