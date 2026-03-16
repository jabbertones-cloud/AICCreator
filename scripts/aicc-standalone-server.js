#!/usr/bin/env node
"use strict";
/**
 * aicc-standalone-server.js
 * Lightweight local dev server for the AICC Content Creator dashboard.
 * Does NOT require Redis or Postgres — reads/writes local report files only.
 *
 * Usage:
 *   node scripts/aicc-standalone-server.js
 *   AICC_PORT=4052 node scripts/aicc-standalone-server.js
 *
 * Then open: http://localhost:4052/aicc
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const http = require("http");
const path = require("path");
const fs   = require("fs");
const { spawnSync } = require("child_process");

const PORT  = parseInt(process.env.AICC_PORT || "4052", 10);
const HOST  = process.env.ARCHITECT_HOST || "127.0.0.1";
const ROOT  = path.join(__dirname, "..");
const REPORTS = path.join(ROOT, "reports");
const DASHBOARD = path.join(ROOT, "dashboard", "aicc-content-creator.html");
const CONTENT_INPUT_REPORT = path.join(REPORTS, "aicc-content-input-latest.json");

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

function json(res, status, body) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

function readReport(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPORTS, name), "utf8"));
  } catch { return null; }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function handlePipeline(res) {
  const autopilot  = readReport("autopilot-last-run.json")            || {};
  const campaign   = readReport("aicc-campaign-latest.json")          || {};
  const abResults  = readReport("aicc-ab-results-latest.json")        || {};
  const promoted   = readReport("aicc-promoted-variant-latest.json")  || {};
  const tts        = readReport("tts-manifest-latest.json")           || {};
  const broll      = readReport("broll-manifest-latest.json")         || {};
  const clips      = readReport("clip-manifest-latest.json")          || {};
  const avatars    = readReport("avatar-manifest-latest.json")        || {};
  const carousels  = readReport("carousel-manifest-latest.json")      || {};
  const repurpose  = readReport("content-repurpose-latest.json")      || {};
  const lps        = readReport("lp-manifest-latest.json")            || {};
  const trend      = readReport("trend-trigger-latest.json")          || {};

  let hookLib = {};
  try { hookLib = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "hook-library.json"), "utf8")); } catch {}

  const countOk   = (m) => Array.isArray(m.variants) ? m.variants.filter(v => v.ok !== false).length  : (m.generated || 0);
  const countFail = (m) => Array.isArray(m.variants) ? m.variants.filter(v => v.ok === false).length  : (m.failed    || 0);

  json(res, 200, {
    autopilot: {
      ran_at:        autopilot.ran_at        || null,
      ended_at:      autopilot.ended_at      || null,
      steps_ok:      autopilot.steps_ok      || 0,
      steps_failed:  autopilot.steps_failed  || 0,
      steps_skipped: autopilot.steps_skipped || 0,
      steps:         autopilot.steps         || [],
    },
    campaign: {
      topic:    campaign.topic || null,
      niche:    campaign.niche_pack || null,
      variants: (campaign.variants || []).map(v => ({
        id:       v.id,
        hook:     v.hook || "",
        platform: v.platform || "",
        score:    v.score || null,
      })),
    },
    ab_results: {
      variants: (abResults.variants || []).map(v => ({
        id:      v.id,
        score:   v.score || 0,
        metrics: v.metrics || {},
      })),
      winner: promoted.id || abResults.winner || null,
    },
    tts:       { generated: countOk(tts),      failed: countFail(tts)      },
    broll:     { generated: countOk(broll),     failed: countFail(broll)    },
    clips:     { assembled: countOk(clips),     failed: countFail(clips)    },
    avatars:   { generated: countOk(avatars),   failed: countFail(avatars)  },
    carousels: { generated: countOk(carousels), failed: countFail(carousels)},
    repurpose: { processed: countOk(repurpose), failed: countFail(repurpose)},
    lps:       { generated: countOk(lps),       failed: countFail(lps)      },
    trend_trigger: {
      topic:        trend.topic        || null,
      niche:        trend.niche        || null,
      score:        trend.score        || null,
      triggered_at: trend.triggered_at || null,
    },
    hook_library: {
      total:      hookLib.total || (hookLib.hooks ? hookLib.hooks.length : 0),
      categories: hookLib.hooks
        ? hookLib.hooks.reduce((a, h) => { a[h.category] = (a[h.category] || 0) + 1; return a; }, {})
        : {},
    },
  });
}

function handleRun(res) {
  const autopilotScript = path.join(ROOT, "scripts", "content-creator-autopilot.js");
  if (!fs.existsSync(autopilotScript)) {
    return json(res, 404, { error: "autopilot_script_not_found" });
  }
  console.log("[aicc-standalone] triggering content-creator-autopilot...");
  const result = spawnSync("node", [autopilotScript], {
    cwd:      ROOT,
    encoding: "utf8",
    env:      process.env,
    timeout:  600000,
  });
  json(res, 200, {
    ok:     result.status === 0,
    code:   result.status,
    stdout: (result.stdout || "").slice(-2000),
    stderr: (result.stderr || "").slice(-1000),
    ran_at: new Date().toISOString(),
  });
}

function handleCampaignRun(req, res) {
  let body = "";
  req.on("data", d => body += d);
  req.on("end", () => {
    let opts = {};
    try { opts = JSON.parse(body); } catch {}
    const topic    = opts.topic    || process.env.AICC_TOPIC        || "automated content creator";
    const niche    = opts.niche    || process.env.AICC_NICHE_PACK   || "ai-clone-news";
    const variants = String(opts.variants || process.env.AICC_VARIANTS || "3");

    console.log(`[aicc-standalone] running campaign: topic="${topic}" niche="${niche}" variants=${variants}`);
    const result = spawnSync("node", [
      path.join(ROOT, "scripts", "aicc-campaign-engine.js"),
      "--topic", topic, "--niche", niche, "--variants", variants, "--run-research",
    ], { cwd: ROOT, encoding: "utf8", env: process.env, timeout: 60000 });

    json(res, 200, {
      ok:        result.status === 0,
      code:      result.status,
      stdout:    (result.stdout || "").slice(-2000),
      stderr:    (result.stderr || "").slice(-500),
      ran_at:    new Date().toISOString(),
      campaign:  readReport("aicc-campaign-latest.json"),
    });
  });
}

function handleContentInputRun(req, res) {
  let body = "";
  req.on("data", d => body += d);
  req.on("end", () => {
    let opts = {};
    try { opts = JSON.parse(body || "{}"); } catch {}

    const url = String(opts.url || "").trim();
    const includeComments = opts.includeComments !== false;
    const fullAnalysis = opts.fullAnalysis === true;
    const keyshotsRaw = Number(opts.keyshots);
    const keyshots = Number.isFinite(keyshotsRaw) ? Math.max(0, Math.min(24, keyshotsRaw)) : 0;

    if (!url || !/^https?:\/\//i.test(url)) {
      return json(res, 400, { ok: false, error: "invalid_url", message: "Provide a valid YouTube URL." });
    }

    const indexScript = path.join(ROOT, "scripts", "youtube-transcript-visual-index.js");
    if (!fs.existsSync(indexScript)) {
      return json(res, 500, { ok: false, error: "missing_indexer_script" });
    }

    const indexArgs = [
      indexScript,
      "--url", url,
      "--out", CONTENT_INPUT_REPORT,
      "--keyshots", String(keyshots),
    ];
    if (includeComments) indexArgs.push("--comments");
    if (fullAnalysis) indexArgs.push("--full-analysis");

    const result = spawnSync("node", indexArgs, {
      cwd: ROOT,
      encoding: "utf8",
      env: process.env,
      timeout: fullAnalysis ? 600000 : 180000,
    });

    const report = fs.existsSync(CONTENT_INPUT_REPORT)
      ? JSON.parse(fs.readFileSync(CONTENT_INPUT_REPORT, "utf8"))
      : null;

    const responseBody = {
      ok: result.status === 0,
      code: result.status,
      stdout: (result.stdout || "").slice(-3000),
      stderr: (result.stderr || "").slice(-1500),
      ran_at: new Date().toISOString(),
      report_path: CONTENT_INPUT_REPORT,
      report,
    };

    // Keep a consistent latest marker even on soft failures so UI can render meaningful state.
    if (!responseBody.ok && !report) {
      writeJson(CONTENT_INPUT_REPORT, {
        generated_at: new Date().toISOString(),
        ok: false,
        error: "content_input_run_failed",
        url,
        include_comments: includeComments,
        keyshots,
        stderr: responseBody.stderr,
      });
      responseBody.report = readReport("aicc-content-input-latest.json");
    }

    return json(res, responseBody.ok ? 200 : 500, responseBody);
  });
}

function handleContentInputLatest(res) {
  if (!fs.existsSync(CONTENT_INPUT_REPORT)) {
    return json(res, 404, { ok: false, error: "content_input_report_not_found" });
  }
  try {
    const report = JSON.parse(fs.readFileSync(CONTENT_INPUT_REPORT, "utf8"));
    return json(res, 200, { ok: true, report });
  } catch (err) {
    return json(res, 500, { ok: false, error: "content_input_report_invalid_json", message: String(err.message || err) });
  }
}

const server = http.createServer((req, res) => {
  const { method } = req;
  const pathname = req.url.split("?")[0];

  if (method === "OPTIONS") { cors(res); res.writeHead(204); res.end(); return; }

  // ── Dashboard HTML ──────────────────────────────────────────────────────
  if (["GET","HEAD"].includes(method) && ["/", "/aicc", "/aicc-creator", "/aicc-content-creator", "/aicc-content-creator.html"].includes(pathname)) {
    if (!fs.existsSync(DASHBOARD)) {
      res.writeHead(404); res.end("Dashboard not found: " + DASHBOARD); return;
    }
    const html = fs.readFileSync(DASHBOARD, "utf8");
    cors(res);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(html);
    return;
  }

  // ── AICC API ─────────────────────────────────────────────────────────────
  if (method === "GET"  && pathname === "/api/aicc/pipeline") { return handlePipeline(res); }
  if (method === "POST" && pathname === "/api/aicc/run")      { return handleRun(res); }
  if (method === "POST" && pathname === "/api/aicc/campaign") { return handleCampaignRun(req, res); }
  if (method === "POST" && pathname === "/api/aicc/content-input/run") { return handleContentInputRun(req, res); }
  if (method === "GET" && pathname === "/api/aicc/content-input/latest") { return handleContentInputLatest(res); }

  // ── Health check ──────────────────────────────────────────────────────────
  if (pathname === "/health" || pathname === "/api/health") {
    return json(res, 200, { ok: true, server: "aicc-standalone", port: PORT, time: new Date().toISOString() });
  }

  // ── Static reports (for debugging) ───────────────────────────────────────
  if (method === "GET" && pathname.startsWith("/reports/")) {
    const name = path.basename(pathname);
    const reportPath = path.join(REPORTS, name);
    if (fs.existsSync(reportPath)) {
      cors(res);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(fs.readFileSync(reportPath));
      return;
    }
  }

  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, HOST, () => {
  console.log(`\n✅ AICC Standalone Server running`);
  console.log(`   Dashboard: http://${HOST}:${PORT}/aicc`);
  console.log(`   Health:    http://${HOST}:${PORT}/health`);
  console.log(`   Pipeline:  http://${HOST}:${PORT}/api/aicc/pipeline`);
  console.log(`   Campaign:  POST http://${HOST}:${PORT}/api/aicc/campaign`);
  console.log(`   Run:       POST http://${HOST}:${PORT}/api/aicc/run\n`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n❌ Port ${PORT} is already in use.`);
    console.error(`   Try: AICC_PORT=4053 node scripts/aicc-standalone-server.js\n`);
  } else {
    console.error("[aicc-standalone] server error:", err);
  }
  process.exit(1);
});
