#!/usr/bin/env node
/**
 * architect-api.js
 * HTTP API server for ClawdBot architect — goal submission, orchestration,
 * plan/task status, and approval flow. Serves the web dashboard.
 *
 * Usage: node scripts/architect-api.js
 *   ARCHITECT_PORT=4050 (default)
 *   ARCHITECT_API_KEY=optional — if set, all /api/* require Bearer token
 *   ARCHITECT_HOST=127.0.0.1 (default, recommended)
 */

"use strict";

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const url = require("url");
const { execSync, exec, spawnSync, spawn } = require("child_process");
const { promisify } = require("util");
const { loadConfiguredAppMeta, annotatePm2Process } = require("../control/pm2-runtime-classifier");

const PORT = parseInt(process.env.ARCHITECT_PORT || "4051", 10);
const HOST = process.env.ARCHITECT_HOST || "127.0.0.1";
const API_KEY = process.env.ARCHITECT_API_KEY || null;
const REPORTS_DIR = path.join(__dirname, "..", "reports");
const DASHBOARD_ACTION_HISTORY_FILE = path.join(REPORTS_DIR, "dashboard-action-history.json");
const DASHBOARD_ACTION_RUNS = new Map();
const ORCHESTRATION_RUNS = new Map();
const execAsync = promisify(exec);
const ALLOWED_ORIGINS = String(process.env.ARCHITECT_ALLOWED_ORIGINS || "http://localhost:4051,http://127.0.0.1:4051")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ALLOW_ANY_ORIGIN = ALLOWED_ORIGINS.includes("*");
const ACTION_RATE_LIMIT_PER_MIN = Math.max(1, Number(process.env.ARCHITECT_ACTION_RATE_PER_MIN || "20") || 20);
const ACTION_RATE_WINDOW_MS = 60_000;
const ACTION_RATE_BUCKETS = new Map();
const ACTION_COOLDOWN_MS = Math.max(1000, Number(process.env.ARCHITECT_ACTION_COOLDOWN_MS || "60000") || 60000);
const ACTION_COOLDOWNS = new Map();
const ACTION_RESULT_STALE_MINUTES = Math.max(30, Number(process.env.ARCHITECT_ACTION_RESULT_STALE_MIN || "180") || 180);
/** Minutes idle after which a "continue" action is a nudge candidate (auto-trigger to keep lanes moving) */
const NUDGE_IDLE_MINUTES = Math.max(15, Number(process.env.ARCHITECT_NUDGE_IDLE_MINUTES || "30") || 30);
const DASHBOARD_SSE_INTERVAL_MS = Math.max(3000, Number(process.env.ARCHITECT_SSE_INTERVAL_MS || "10000") || 10000);
const DASHBOARD_SSE_KEEPALIVE_MS = 15000;
const DASHBOARD_CHAT_TIMEOUT_MS = Math.min(
  45000,
  Math.max(10000, Number(process.env.ARCHITECT_DASHBOARD_CHAT_TIMEOUT_MS || "12000") || 12000)
);
const DASHBOARD_PROGRESS_TIMEOUT_MS = Math.min(
  2000,
  Math.max(400, Number(process.env.ARCHITECT_DASHBOARD_PROGRESS_TIMEOUT_MS || "1200") || 1200)
);
const DASHBOARD_TAB_CACHE_TTL_MS = Math.max(
  0,
  Number(process.env.ARCHITECT_DASHBOARD_TAB_CACHE_MS || "3000") || 3000
);
const DASHBOARD_FALLBACK_TIMEOUT_MS = Math.min(
  60000,
  Math.max(12000, Number(process.env.ARCHITECT_DASHBOARD_FALLBACK_TIMEOUT_MS || "30000") || 30000)
);
const MEDIA_HUB_CAPTION_TIMEOUT_MS = Math.max(
  2000,
  Number(process.env.MEDIA_HUB_CAPTION_TIMEOUT_MS || "12000") || 12000
);
const DASHBOARD_SSE_CLIENTS = new Map();
const PM2_WARNING_GRACE_MS = Math.max(5000, Number(process.env.PM2_WARNING_GRACE_MS || "20000") || 20000);
const PM2_WARNING_MIN_CONSECUTIVE = Math.max(1, Number(process.env.PM2_WARNING_MIN_CONSECUTIVE || "2") || 2);
const PM2_WARNING_STATE = {
  unhealthy_since: null,
  unhealthy_streak: 0,
  last_health: true,
  last_auto_heal_at: 0,
};
const PM2_AUTO_HEAL_ENABLED = !["0", "false", "no", "off"].includes(
  String(process.env.PM2_AUTO_HEAL_ENABLED || "true").toLowerCase()
);
const PM2_AUTO_HEAL_COOLDOWN_MS = Math.max(30_000, Number(process.env.PM2_AUTO_HEAL_COOLDOWN_MS || "180000") || 180000);
const EXTERNAL_CHAT_CHANNELS_ENABLED = ["1", "true", "yes", "on"].includes(
  String(process.env.EXTERNAL_CHAT_CHANNELS_ENABLED || "false").toLowerCase()
);

// FIX H4: single source of truth for freshness SLAs (was duplicated at ~line 1119 and ~1385)
const FRESHNESS_SLA = {
  global_status: 180,
  repo_scan: 360,
  launch_e2e: 360,
  qa_human: 720,
  agent_memory: 720,
  saas_opportunity: 1440,
  affiliate_research: 1440,
  symbolic_qa_hub: 240,
  daily_feature_rotation: 240,
  closed_loop_daily: 240,
  knowledge_troll_harvest: 180,
  pattern_robust_builder: 180,
  production_kpi_flywheel: 120,
  forward_progress_enforcer: 90,
  agent_streamline_pulse: 180,
};

// Critical runtime checks. `any` means at least one listed process must be online.
const CRITICAL_CHECKS = [
  { id: "claw-architect-api", any: ["claw-architect-api"] },
  { id: "claw-dispatcher", any: ["claw-dispatcher"] },
  { id: "worker-plane", any: ["claw-worker", "claw-worker-ai", "claw-worker-nas"] },
  { id: "claw-webhook-server", any: ["claw-webhook-server"] },
  ...(EXTERNAL_CHAT_CHANNELS_ENABLED
    ? [{ id: "external-chat", any: ["claw-gateway", "claw-discord-gateway"] }]
    : []),
];
const CRITICAL_PROCESS_NAMES = Array.from(new Set(CRITICAL_CHECKS.flatMap((c) => c.any)));

const DASHBOARD_ACTIONS = [
  {
    id: "global_diagnose",
    name: "Diagnose All Lanes",
    lane: "ops",
    verb: "diagnose",
    command: "npm run -s status:redgreen && npm run -s audit:deep && npm run -s audit:gaps",
  },
  {
    id: "global_fix",
    name: "Fix Top Blockers",
    lane: "ops",
    verb: "fix",
    command: "npm run -s needs:attention:autofix && npm run -s status:redgreen",
  },
  {
    id: "status_redgreen",
    name: "Refresh Global Status",
    lane: "system",
    verb: "refresh",
    command: "npm run -s status:redgreen",
  },
  {
    id: "launch_e2e_fix",
    name: "Fix Launch E2E",
    lane: "qa",
    verb: "fix",
    command: "npm run -s e2e:launch:matrix",
  },
  {
    id: "repo_scan_continue",
    name: "Continue Repo Scan",
    lane: "repos",
    verb: "continue",
    command: "npm run -s github:scan -- --limit 200 --strict-baseline",
  },
  {
    id: "repo_gate_fix",
    name: "Fix Repo Baseline Gate",
    lane: "repos",
    verb: "fix",
    command: "npm run -s github:baseline:gate",
  },
  {
    id: "lead_skynpatch_fix",
    name: "Fix SkynPatch Sends",
    lane: "leadgen",
    verb: "fix",
    command: "npm run -s lead:autopilot",
  },
  {
    id: "lead_bws_continue",
    name: "Continue BWS Lead Collect",
    lane: "leadgen",
    verb: "continue",
    command: "npm run -s lead:bws:collect",
  },
  {
    id: "lead_bws_send_fix",
    name: "Fix BWS Send Lane",
    lane: "leadgen",
    verb: "fix",
    command: "npm run -s lead:bws:send",
  },
  {
    id: "credit_check_refresh",
    name: "Refresh Credit OAuth",
    lane: "credit",
    verb: "refresh",
    command: "npm run -s credit:oauth:check",
  },
  {
    id: "credit_continue",
    name: "Continue Credit Pipeline",
    lane: "credit",
    verb: "continue",
    command: "npm run -s credit:e2e:live",
  },
  {
    id: "security_fix",
    name: "Fix Security Lane",
    lane: "security",
    verb: "fix",
    command: "npm run -s security:sweep",
  },
  {
    id: "workflow_continue",
    name: "Continue Workflow Audit",
    lane: "ops",
    verb: "continue",
    command: "npm run -s workflow:audit:soft",
  },
  // FIX C3 + G1: research lane actions wired for research-copy/regenerate endpoint
  {
    id: "saas_pain_report",
    name: "Regenerate SaaS Pain Report",
    lane: "research",
    verb: "regenerate",
    command: "npm run -s saas:pain:report",
  },
  {
    id: "saas_opportunity",
    name: "Regenerate Opportunity Research",
    lane: "research",
    verb: "regenerate",
    command: "npm run -s saas:opportunity:research",
  },
  {
    id: "research_sync",
    name: "Sync Research Signals",
    lane: "research",
    verb: "continue",
    command: "npm run -s research:sync",
  },
  {
    id: "requirement_expansion_pass",
    name: "Run Requirement Expansion Proof Pass",
    lane: "builder",
    verb: "run",
    command: "npm run -s requirement-expansion:pass -- --goal \"\" --app-type default",
  },
  {
    id: "affiliate_research",
    name: "Regenerate Affiliate Research",
    lane: "research",
    verb: "regenerate",
    command: "npm run -s affiliate:research",
  },
  {
    id: "payclaw_launch",
    name: "Launch PayClaw Repo",
    lane: "repos",
    verb: "launch",
    command: "npm run -s payclaw:launch",
  },
  {
    id: "payclaw_sync_context",
    name: "Sync PayClaw Context",
    lane: "repos",
    verb: "sync",
    command: "npm run -s payclaw:launch -- --no-scaffold",
  },
  {
    id: "queue_retry_failed",
    name: "Retry Failed/Dead-letter Tasks",
    lane: "ops",
    verb: "fix",
    command: "npm run -s tasks:reconcile-deadletters -- --requeue",
  },
  {
    id: "media_os_run",
    name: "Run Media OS Pipeline",
    lane: "media",
    verb: "run",
    command: "npm run -s media:chain",
  },
  {
    id: "learning_flywheel_refresh",
    name: "Refresh Learning Flywheel",
    lane: "learning",
    verb: "refresh",
    command: "npm run -s pattern:robust:build && npm run -s feature:rotation:daily",
  },
  {
    id: "progress_enforce",
    name: "Enforce Forward Progress",
    lane: "ops",
    verb: "enforce",
    command: "npm run -s progress:enforce",
  },
];

// Minimal config check — architect API does not require TELEGRAM_BOT_TOKEN
// Accepts POSTGRES_* or CLAW_DB_* (matches rest of project)
function validateArchitectConfig() {
  const pgHost = process.env.POSTGRES_HOST || process.env.CLAW_DB_HOST;
  const pgPass = process.env.POSTGRES_PASSWORD || process.env.CLAW_DB_PASSWORD;
  const pgDb = process.env.POSTGRES_DB || process.env.CLAW_DB_NAME;
  const redisHost = process.env.REDIS_HOST;
  const redisPort = process.env.REDIS_PORT;

  const missing = [];
  if (!pgHost || String(pgHost).trim() === "") missing.push("POSTGRES_HOST or CLAW_DB_HOST");
  if (!pgPass || String(pgPass).trim() === "") missing.push("POSTGRES_PASSWORD or CLAW_DB_PASSWORD");
  if (!pgDb || String(pgDb).trim() === "") missing.push("POSTGRES_DB or CLAW_DB_NAME");
  if (!redisHost || String(redisHost).trim() === "") missing.push("REDIS_HOST");
  if (!redisPort || String(redisPort).trim() === "") missing.push("REDIS_PORT");

  if (missing.length > 0) {
    throw new Error(
      `Architect API: missing required env: ${missing.join(", ")}. Copy .env.example to .env and fill in Postgres/Redis.`
    );
  }
  if (!API_KEY) {
    console.warn("[architect-api] ARCHITECT_API_KEY not set — API is unauthenticated (NAS-only use).");
  }
}

validateArchitectConfig();

const pg = require("../infra/postgres");
if (pg && typeof pg.end === "function") {
  const originalPgEnd = pg.end.bind(pg);
  pg.end = async () => {
    console.warn("[architect-api] blocked pg.end() in long-lived API process");
    return undefined;
  };
  pg.__architect_original_end = originalPgEnd;
}
const redis = require("../infra/redis");
const planner = require("../agents/planner");
const { insertPlan } = require("../control/inserter");
const { verifyPlan } = require("../agents/verifier");
const { checkBudget, spendSummary } = require("../control/budget");
const { getHandler } = require("../agents/registry");
const { buildTaskIdempotencyKey } = require("../control/idempotency");
const { chat: routedChat, routingStats } = require("../infra/model-router");
const {
  listReportDefinitions,
  getReportDefinition,
  latestArtifactForReport,
  freshnessFromAge,
} = require("../control/report-registry");
const { isEmergencyStopped } = require("../control/emergency");
const {
  scanVeritapServices,
  runLocalAiPrompt,
  createEmailDraft,
  createSmsDraft,
  getRecentActivity,
} = require("../control/local-alternatives");
const {
  getSnapshot: getOffgridSnapshot,
  getBridgeStatus: getOffgridBridgeStatus,
  queueMeshCommand,
  ingestMeshEvent,
  setLight: offgridSetLight,
  runService: offgridRunService,
  discoverAllLights,
  flickerTest,
  getOffgridHuePatternPack,
  getOffgridPatternTaskTemplates,
} = require("../control/offgrid-home");
const { generateCreatorPack } = require("../agents/openclaw-creator-pack-agent");
const { loadState: loadManagementIntegrityState } = require("../control/management-integrity");

// Load agents for orchestrator and other handlers
require("../agents/orchestrator");
require("../agents/echo-agent");
require("../agents/index-agent");
require("../agents/report-agent");
require("../agents/classify-agent");
require("../agents/qa-agent");
require("../agents/triage-agent");
require("../agents/patch-agent");
require("../agents/dedupe-agent");
require("../agents/migrate-agent");
require("../agents/claw-agent");
require("../agents/github-sync-agent");
require("../agents/site-audit-agent");
require("../agents/repo-autofix-agent");
require("../agents/brand-provision-agent");
require("../agents/media-detect-agent");
require("../agents/media-enrich-agent");
require("../agents/media-hash-agent");
require("../agents/cluster-agent");
require("../agents/stub-agents");
require("../agents/report-refresh-agent");

// ── Helpers ───────────────────────────────────────────────────

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const buf = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(buf ? JSON.parse(buf) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

function withTimeout(promise, timeoutMs, code = "timeout", message = "operation_timeout") {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(message);
      err.code = code;
      reject(err);
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function jsonResponse(res, status, data) {
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
    "X-Response-Time": new Date().toISOString(),
  };
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

function latestReportFile(suffix) {
  if (!fs.existsSync(REPORTS_DIR)) return null;
  const files = fs
    .readdirSync(REPORTS_DIR)
    .filter((f) => f.endsWith(suffix))
    .sort((a, b) => {
      const aTs = parseInt(String(a).split("-")[0], 10);
      const bTs = parseInt(String(b).split("-")[0], 10);
      if (Number.isFinite(aTs) && Number.isFinite(bTs) && aTs !== bTs) {
        return aTs - bTs;
      }
      try {
        const aM = fs.statSync(path.join(REPORTS_DIR, a)).mtimeMs;
        const bM = fs.statSync(path.join(REPORTS_DIR, b)).mtimeMs;
        return aM - bM;
      } catch {
        return a.localeCompare(b);
      }
    });
  if (!files.length) return null;
  return path.join(REPORTS_DIR, files[files.length - 1]);
}

function readJsonSafe(filePath) {
  if (!filePath) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function parsePm2ListSafe() {
  try {
    const { stdout: raw } = await execAsync("pm2 jlist", { timeout: 5000 });
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function minutesAgo(iso) {
  if (!iso) return null;
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Math.round((Date.now() - ts) / 60000));
}

function dashboardChatSystemPrompt(progress) {
  const queue = progress?.metrics?.queue || {};
  const kpi = progress?.history?.production_kpi_flywheel || {};
  const findings = (progress?.needs_attention || []).slice(0, 8);
  const recommendations = (progress?.recommendations || []).slice(0, 8);
  return [
    "You are the OpenClaw dashboard copilot.",
    "Respond with concise, execution-focused guidance only.",
    "Always produce: 1) current state summary, 2) top next actions (max 5), 3) exact commands when useful.",
    "Prefer shipping and KPI movement over generic analysis.",
    "If user asks to run actions, mention action IDs if available.",
    "",
    `Queue: created=${queue.created || 0} pending=${queue.pending || 0} running=${queue.running || 0} dead_letter=${queue.dead_letter || 0}`,
    `KPI score: ${kpi.score || 0} | queued_actions=${kpi.queued_actions || 0}`,
    `Needs attention: ${findings.join(" | ") || "none"}`,
    `Recommendations: ${recommendations.join(" | ") || "none"}`,
  ].join("\n");
}

function dashboardChatDegradedPayload(reason) {
  const offlineReply = [
    "Dashboard chat is in degraded mode.",
    `Reason: ${reason}`,
    "Immediate actions:",
    "1) npm run -s status:redgreen",
    "2) npm run -s audit:progress:integrity",
    "3) npm run -s repo:readiness:pulse -- --min-score 80 --skip-lock-ddl",
  ].join("\n");
  return {
    ok: true,
    reply: offlineReply,
    model_key: "deterministic_fallback",
    provider: "local",
    confidence: null,
    escalation_reason: "chat_degraded_fallback",
    routing: routingStats(),
    degraded: true,
  };
}

function dashboardChatRulePayload(message, progress, reason) {
  const queue = progress?.metrics?.queue || {};
  const topNeeds = (progress?.needs_attention || []).slice(0, 3);
  const topRecs = (progress?.recommendations || []).slice(0, 3);
  const intent = String(message || "").toLowerCase();
  const actionHint = intent.includes("fix")
    ? "Run `global_fix` then `global_diagnose` from dashboard actions."
    : intent.includes("status") || intent.includes("health")
      ? "Run `status_redgreen` from dashboard actions."
      : "Run `global_diagnose` from dashboard actions.";
  const reply = [
    "State summary:",
    `Queue pending=${queue.pending || 0}, running=${queue.running || 0}, dead_letter=${queue.dead_letter || 0}.`,
    `Top blockers: ${topNeeds.length ? topNeeds.join(" | ") : "none"}.`,
    "Next actions:",
    `1) ${actionHint}`,
    "2) Run `npm run -s audit:progress:integrity`.",
    "3) Run `npm run -s repo:readiness:pulse -- --min-score 80 --skip-lock-ddl`.",
    `Mode: rule-based fallback (${reason}).`,
  ].join("\n");
  return {
    ok: true,
    reply,
    model_key: "rule_based_fallback",
    provider: "local",
    confidence: null,
    escalation_reason: "chat_rule_fallback",
    routing: routingStats(),
    degraded: false,
    work_actions: buildDashboardChatWorkActions(message, progress),
  };
}

function buildDashboardChatWorkActions(message, progress) {
  const intent = String(message || "").toLowerCase();
  const queue = progress?.metrics?.queue || {};
  const picks = [];
  const add = (id) => {
    if (!id || picks.includes(id)) return;
    if (!getActionDefinition(id)) return;
    picks.push(id);
  };

  if (/(status|health|diagnose|why)/.test(intent)) {
    add("status_redgreen");
    add("global_diagnose");
  }
  if (/(fix|repair|unblock|stuck|broken|error)/.test(intent)) {
    add("global_fix");
    add("queue_retry_failed");
    add("progress_enforce");
  }
  if (/(repo|index|symbol|drift|baseline|compare)/.test(intent)) {
    add("repo_scan_continue");
    add("repo_gate_fix");
    add("learning_flywheel_refresh");
  }
  if (/(payclaw|stripe|telnyx|invoice)/.test(intent)) {
    add("payclaw_launch");
    add("payclaw_sync_context");
  }
  if (/(research|idea|opportunity|saas|affiliate)/.test(intent)) {
    add("saas_pain_report");
    add("affiliate_research");
    add("research_sync");
  }
  if (/(media|photo|video|catalog)/.test(intent)) {
    add("media_os_run");
  }

  const pending = Number(queue.pending || 0);
  const created = Number(queue.created || 0);
  if (pending > 120 || created > 200) {
    add("progress_enforce");
    add("queue_retry_failed");
  }

  if (picks.length === 0) {
    add("global_diagnose");
    add("progress_enforce");
  }

  return picks.slice(0, 4).map((id) => {
    const def = getActionDefinition(id);
    return {
      id: def.id,
      name: def.name,
      lane: def.lane,
      command: def.command,
    };
  });
}

function shouldRejectDashboardChatCandidate(reply, modelKey, provider, escalationReason, degradedFlag) {
  const text = String(reply || "").trim();
  const mk = String(modelKey || "").toLowerCase();
  const pr = String(provider || "").toLowerCase();
  const reason = String(escalationReason || "").toLowerCase();
  if (!text) return true;
  if (degradedFlag === true) return true;
  if (mk === "deterministic_fallback" || mk === "rule_based_fallback") return true;
  if (reason.includes("degraded")) return true;
  if (pr === "local" && /dashboard chat is in degraded mode/i.test(text)) return true;
  return false;
}

function checkAuth(req, explicitToken = null) {
  if (!API_KEY) {
    // Defense in depth: if no API key, only accept loopback callers.
    const xfwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    const remote = xfwd || req.socket?.remoteAddress || "";
    const normalized = String(remote).replace(/^::ffff:/, "");
    const isLocal =
      normalized === "127.0.0.1" ||
      normalized === "::1" ||
      normalized === "localhost";
    return isLocal;
  }
  if (explicitToken && String(explicitToken).trim() === API_KEY) return true;
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  return token === API_KEY;
}

function route(method, pathname) {
  void method;
  return {
    param: (name) => {
      const match = pathname.match(new RegExp(`^/api/plans/([a-f0-9-]{36})(?:/(approve|reject|confirm|events))?$`, "i"));
      if (!match) return null;
      if (name === "plan_id") return match[1];
      if (name === "action") return match[2] || null;
      return null;
    },
  };
}

function actionRequesterIp(req) {
  const xfwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xfwd || req.socket?.remoteAddress || "unknown";
}

function checkActionRateLimit(ip) {
  const now = Date.now();
  const bucket = ACTION_RATE_BUCKETS.get(ip) || { count: 0, resetAt: now + ACTION_RATE_WINDOW_MS };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + ACTION_RATE_WINDOW_MS;
  }
  bucket.count += 1;
  ACTION_RATE_BUCKETS.set(ip, bucket);
  return bucket.count <= ACTION_RATE_LIMIT_PER_MIN;
}

function checkActionCooldown(ip, actionId) {
  const key = `${ip}:${actionId}`;
  const now = Date.now();
  const last = Number(ACTION_COOLDOWNS.get(key) || 0);
  if (last && now - last < ACTION_COOLDOWN_MS) {
    return false;
  }
  ACTION_COOLDOWNS.set(key, now);
  return true;
}

function ensureReportsDir() {
  try {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  } catch (_) {}
}

function loadDashboardActionHistory() {
  try {
    const raw = fs.readFileSync(DASHBOARD_ACTION_HISTORY_FILE, "utf8");
    const json = JSON.parse(raw);
    return Array.isArray(json) ? json : [];
  } catch (_) {
    return [];
  }
}

function saveDashboardActionHistory(history) {
  ensureReportsDir();
  fs.writeFileSync(DASHBOARD_ACTION_HISTORY_FILE, JSON.stringify(history.slice(-200), null, 2), "utf8");
}

let actionHistoryWriteChain = Promise.resolve();
let actionHistoryFailureStreak = 0;
let actionHistoryCircuitOpenUntil = 0;
const ACTION_HISTORY_CIRCUIT_THRESHOLD = 5;
const ACTION_HISTORY_CIRCUIT_RESET_MS = 5 * 60 * 1000;

function appendDashboardActionHistory(entry) {
  // Simple circuit breaker: if writes have been consistently failing,
  // stop queueing more work for a cooldown window to avoid thrashing.
  const now = Date.now();
  if (now < actionHistoryCircuitOpenUntil) {
    console.warn("[architect-api] action history circuit open, skipping file write");
    return Promise.resolve();
  }

  actionHistoryWriteChain = actionHistoryWriteChain
    .then(() => {
      const history = loadDashboardActionHistory();
      history.unshift(entry);
      saveDashboardActionHistory(history);
      // Successful write: reset failure streak and close circuit if it was open.
      actionHistoryFailureStreak = 0;
      actionHistoryCircuitOpenUntil = 0;
    })
    .catch((err) => {
      actionHistoryFailureStreak += 1;
      console.error("[architect-api] action history write failed:", err.message);
      if (actionHistoryFailureStreak >= ACTION_HISTORY_CIRCUIT_THRESHOLD) {
        actionHistoryCircuitOpenUntil = now + ACTION_HISTORY_CIRCUIT_RESET_MS;
        console.error(
          "[architect-api] action history circuit opened after repeated failures; " +
            `suppressing writes for ${ACTION_HISTORY_CIRCUIT_RESET_MS / 1000}s`
        );
      }
    });
  return actionHistoryWriteChain;
}

let dashboardActionLogTableEnsured = false;
async function ensureDashboardActionLogTable() {
  if (dashboardActionLogTableEnsured) return;
  await pg.query(`
    CREATE TABLE IF NOT EXISTS dashboard_action_runs (
      run_id TEXT PRIMARY KEY,
      action_id TEXT NOT NULL,
      lane TEXT,
      name TEXT,
      command TEXT,
      requested_by TEXT,
      requested_ip TEXT,
      status TEXT NOT NULL,
      exit_code INTEGER,
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      stdout_path TEXT,
      stderr_path TEXT,
      pid INTEGER,
      error TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  dashboardActionLogTableEnsured = true;
}

async function persistDashboardActionRun(row) {
  if (!row?.run_id) return;
  try {
    await ensureDashboardActionLogTable();
    await pg.query(
      `INSERT INTO dashboard_action_runs (
         run_id, action_id, lane, name, command, requested_by, requested_ip, status, exit_code,
         started_at, finished_at, stdout_path, stderr_path, pid, error, updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW()
       )
       ON CONFLICT (run_id) DO UPDATE SET
         status = EXCLUDED.status,
         exit_code = EXCLUDED.exit_code,
         finished_at = EXCLUDED.finished_at,
         error = EXCLUDED.error,
         updated_at = NOW()`,
      [
        row.run_id,
        row.action_id,
        row.lane || null,
        row.name || null,
        row.command || null,
        row.requested_by || null,
        row.requested_ip || null,
        row.status || "unknown",
        Number.isFinite(Number(row.exit_code)) ? Number(row.exit_code) : null,
        row.started_at || null,
        row.finished_at || null,
        row.stdout_path || null,
        row.stderr_path || null,
        Number.isFinite(Number(row.pid)) ? Number(row.pid) : null,
        row.error || null,
      ]
    );
  } catch (err) {
    if (!isPoolClosedError(err)) {
      console.error("[architect-api] action run DB log failed:", err.message);
    }
  }
}

function getActionDefinition(actionId) {
  return DASHBOARD_ACTIONS.find((a) => a.id === actionId) || null;
}

function isProcessAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    // Check if process exists (signal 0 doesn't kill, just checks)
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process
    return false;
  }
}

async function getDashboardActionsState() {
  const history = loadDashboardActionHistory();
  const byAction = new Map();
  for (const row of history) {
    if (!row || !row.action_id || byAction.has(row.action_id)) continue;
    byAction.set(row.action_id, row);
  }

  // Also query database for latest status (source of truth)
  let dbLatestByAction = new Map();
  try {
    await ensureDashboardActionLogTable();
    const { rows } = await pg.query(`
      SELECT DISTINCT ON (action_id) 
        action_id, status, exit_code, started_at, finished_at, pid, error, run_id
      FROM dashboard_action_runs
      ORDER BY action_id, started_at DESC
    `);
    for (const row of rows || []) {
      if (row?.action_id) {
        dbLatestByAction.set(row.action_id, {
          action_id: row.action_id,
          status: row.status,
          exit_code: row.exit_code,
          started_at: row.started_at ? new Date(row.started_at).toISOString() : null,
          finished_at: row.finished_at ? new Date(row.finished_at).toISOString() : null,
          pid: row.pid,
          error: row.error,
          run_id: row.run_id,
        });
      }
    }
  } catch (err) {
    if (!isPoolClosedError(err)) {
      console.error("[architect-api] Failed to load action status from DB:", err.message);
    }
  }

  // Clean up stale "running" entries that are actually dead
  for (const [runId, run] of DASHBOARD_ACTION_RUNS.entries()) {
    if (run.status === "running" && run.pid) {
      if (!isProcessAlive(run.pid)) {
        // Process is dead but still marked as running - mark as failed
        const failed = {
          ...run,
          finished_at: new Date().toISOString(),
          status: "failed",
          exit_code: null,
          error: "Process died unexpectedly",
        };
        DASHBOARD_ACTION_RUNS.set(runId, failed);
        appendDashboardActionHistory(failed);
        persistDashboardActionRun(failed);
        broadcastDashboardEvent("action_run", failed);
        setTimeout(() => {
          DASHBOARD_ACTION_RUNS.delete(runId);
        }, 10 * 60 * 1000);
      }
    }
  }

  return DASHBOARD_ACTIONS.map((def) => {
    // Find actually running process (alive and in memory)
    const runningEntry = Array.from(DASHBOARD_ACTION_RUNS.values()).find(
      (r) => r.action_id === def.id && r.status === "running" && isProcessAlive(r.pid)
    );
    
    // Get latest from database (source of truth), then history file, then memory
    const latestDb = dbLatestByAction.get(def.id);
    const latestHistory = byAction.get(def.id);
    const latest = runningEntry || latestDb || latestHistory;
    
    // Determine actual status
    let currentStatus = "idle";
    if (runningEntry && isProcessAlive(runningEntry.pid)) {
      currentStatus = "running";
    } else if (latestDb) {
      // Database is source of truth
      if (latestDb.status === "completed" || latestDb.status === "failed") {
        currentStatus = "idle"; // Terminal state, now idle
      } else if (latestDb.status === "running") {
        // DB says running - check if process is actually alive
        if (latestDb.pid && isProcessAlive(latestDb.pid)) {
          currentStatus = "running";
        } else {
          currentStatus = "idle"; // Process is dead, mark as idle
        }
      }
    } else if (latestHistory) {
      // Fallback to history file
      if (latestHistory.status === "completed" || latestHistory.status === "failed") {
        currentStatus = "idle";
      } else if (latestHistory.status === "running") {
        if (latestHistory.pid && isProcessAlive(latestHistory.pid)) {
          currentStatus = "running";
        } else {
          currentStatus = "idle";
        }
      }
    }
    
    const latestAt = latest?.finished_at || latest?.started_at || latest?.requested_at || null;
    const latestAgeMin = Number(minutesAgo(latestAt));
    const staleResult = Boolean(
      currentStatus === "idle" &&
      latest &&
      Number.isFinite(latestAgeMin) &&
      latestAgeMin > ACTION_RESULT_STALE_MINUTES
    );
    
    return {
      ...def,
      running: currentStatus === "running",
      current_status: currentStatus,
      stale_result: staleResult,
      latest_age_min: Number.isFinite(latestAgeMin) ? latestAgeMin : null,
      latest,
    };
  });
}

/**
 * Returns dashboard actions that are good nudge candidates: verb "continue", idle, and last run
 * older than NUDGE_IDLE_MINUTES so auto-triggering them keeps lanes moving.
 */
async function getNudgeCandidates() {
  const state = await getDashboardActionsState();
  const candidates = state.filter(
    (a) =>
      a.verb === "continue" &&
      a.current_status === "idle" &&
      (a.latest_age_min == null || a.latest_age_min >= NUDGE_IDLE_MINUTES)
  );
  return candidates.map((a) => ({
    action_id: a.id,
    name: a.name,
    lane: a.lane,
    latest_age_min: a.latest_age_min,
  }));
}

function sseSend(res, event, payload) {
  try {
    if (event) res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch (_) {}
}

function broadcastDashboardEvent(event, payload) {
  for (const client of DASHBOARD_SSE_CLIENTS.values()) {
    sseSend(client.res, event, payload);
  }
}

function startDashboardEventStream(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");
  const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const client = { id, res };
  DASHBOARD_SSE_CLIENTS.set(id, client);
  sseSend(res, "hello", { ok: true, client_id: id, generated_at: new Date().toISOString() });
  const summaryTimer = setInterval(async () => {
    const progress = await getProgressSafe();
    const findings = buildAuditFindings(progress);
    // For SSE summary, use system status (same as overview tab) to ensure consistency
    const systemStatus = (progress.system?.status || "unknown").toLowerCase();
    const systemStatusSummary = {
      green: systemStatus === "green" ? 1 : 0,
      yellow: systemStatus === "yellow" ? 1 : 0,
      red: systemStatus === "red" ? 1 : 0,
      total: 1,
      overall: systemStatus === "red" ? "red" : systemStatus === "yellow" ? "yellow" : "green",
    };
    sseSend(res, "summary", {
      generated_at: new Date().toISOString(),
      status_summary: systemStatusSummary, // Use system status instead of findings-based status
      queue: progress?.metrics?.queue || {},
      running_actions: (await getDashboardActionsState()).filter((a) => a.running).length,
    });
  }, DASHBOARD_SSE_INTERVAL_MS);
  const keepaliveTimer = setInterval(() => {
    sseSend(res, "keepalive", { ts: Date.now() });
  }, DASHBOARD_SSE_KEEPALIVE_MS);

  const close = () => {
    clearInterval(summaryTimer);
    clearInterval(keepaliveTimer);
    DASHBOARD_SSE_CLIENTS.delete(id);
  };
  req.on("close", close);
  req.on("aborted", close);
}

function runDashboardAction(actionId, requestedBy = "dashboard", requesterIp = "unknown") {
  const def = getActionDefinition(actionId);
  if (!def) {
    const err = new Error("unknown_action");
    err.status = 404;
    throw err;
  }
  const existingRunning = Array.from(DASHBOARD_ACTION_RUNS.values()).find(
    (r) => r.action_id === actionId && r.status === "running"
  );
  if (existingRunning) {
    return { accepted: true, deduped: true, run: existingRunning };
  }

  // Action execution changes dashboard state; drop short-lived tab envelopes.
  invalidateDashboardTabEnvelopeCache();

  ensureReportsDir();
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const startedAt = new Date().toISOString();
  const stdoutPath = path.join(REPORTS_DIR, `${runId}-${actionId}.out.log`);
  const stderrPath = path.join(REPORTS_DIR, `${runId}-${actionId}.err.log`);
  const outFd = fs.openSync(stdoutPath, "a");
  const errFd = fs.openSync(stderrPath, "a");
  const proc = spawn("bash", ["-lc", def.command], {
    cwd: path.join(__dirname, ".."),
    env: process.env,
    stdio: ["ignore", outFd, errFd],
  });
  // FIX H1: close fds in parent after spawn — child inherits them; parent must close its copies
  // to avoid fd exhaustion under load (2 leaked fds per action invocation without this)
  fs.closeSync(outFd);
  fs.closeSync(errFd);

  const run = {
    run_id: runId,
    action_id: actionId,
    name: def.name,
    lane: def.lane,
    command: def.command,
    requested_by: requestedBy,
    requested_ip: requesterIp,
    started_at: startedAt,
    finished_at: null,
    status: "running",
    exit_code: null,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    pid: proc.pid,
  };
  DASHBOARD_ACTION_RUNS.set(runId, run);
  persistDashboardActionRun(run);
  broadcastDashboardEvent("action_run", run);

  proc.on("close", (code) => {
    const finished = {
      ...run,
      finished_at: new Date().toISOString(),
      status: code === 0 ? "completed" : "failed",
      exit_code: code,
    };
    DASHBOARD_ACTION_RUNS.set(runId, finished);
    appendDashboardActionHistory(finished);
    persistDashboardActionRun(finished);
    broadcastDashboardEvent("action_run", finished);
    setTimeout(() => {
      DASHBOARD_ACTION_RUNS.delete(runId);
    }, 10 * 60 * 1000);
  });

  proc.on("error", (err) => {
    const failed = {
      ...run,
      finished_at: new Date().toISOString(),
      status: "failed",
      exit_code: null,
      error: err.message,
    };
    DASHBOARD_ACTION_RUNS.set(runId, failed);
    appendDashboardActionHistory(failed);
    persistDashboardActionRun(failed);
    broadcastDashboardEvent("action_run", failed);
    setTimeout(() => {
      DASHBOARD_ACTION_RUNS.delete(runId);
    }, 10 * 60 * 1000);
  });

  return { accepted: true, deduped: false, run };
}

let reportRefreshColumnsEnsured = false;
function isPoolClosedError(err) {
  const msg = String(err?.message || "");
  return msg.includes("Cannot use a pool after calling end on the pool");
}

async function ensureReportRefreshTaskColumns() {
  if (reportRefreshColumnsEnsured) return;
  try {
    await pg.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS worker_queue TEXT`).catch(() => {});
    await pg.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS required_tags TEXT[] DEFAULT '{}'`).catch(() => {});
    await pg.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS idempotency_key TEXT`).catch(() => {});
  } catch (err) {
    if (!isPoolClosedError(err)) throw err;
    return;
  }
  reportRefreshColumnsEnsured = true;
}

function toIso(ts) {
  if (!ts) return null;
  try {
    const d = ts instanceof Date ? ts : new Date(ts);
    if (!Number.isFinite(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

function ageMinutesFromIso(iso) {
  if (!iso) return null;
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Math.round((Date.now() - ts) / 60000));
}

async function getReportRefreshRows(reportId = null, limit = 200) {
  await ensureReportRefreshTaskColumns();
  const sql = reportId
    ? `SELECT id, payload, status, created_at, started_at, completed_at, last_error, result, worker_queue, required_tags, idempotency_key
         FROM tasks
        WHERE type = 'report_refresh'
          AND payload->>'report_id' = $1
        ORDER BY created_at DESC
        LIMIT $2`
    : `SELECT id, payload, status, created_at, started_at, completed_at, last_error, result, worker_queue, required_tags, idempotency_key
         FROM tasks
        WHERE type = 'report_refresh'
        ORDER BY created_at DESC
        LIMIT $1`;
  const params = reportId ? [reportId, limit] : [limit];
  let rows = [];
  try {
    const result = await pg.query(sql, params);
    rows = result?.rows || [];
  } catch (err) {
    if (!isPoolClosedError(err)) throw err;
    rows = [];
  }
  return rows || [];
}

function normalizeReportHistoryRow(row) {
  const payload = row?.payload && typeof row.payload === "object" ? row.payload : {};
  const result = row?.result && typeof row.result === "object" ? row.result : {};
  const lastError = row?.last_error ? String(row.last_error) : "";
  let outcome = "queued";
  const status = String(row?.status || "");
  if (status === "COMPLETED") outcome = "success";
  else if (status === "FAILED" || status === "DEAD_LETTER") outcome = "failed";
  else if (status === "RUNNING" || status === "DISPATCHED") outcome = "running";

  return {
    task_id: row?.id || null,
    report_id: payload?.report_id || null,
    status,
    outcome,
    created_at: toIso(row?.created_at),
    started_at: toIso(row?.started_at),
    completed_at: toIso(row?.completed_at),
    last_error: lastError || null,
    artifact_path: result?.artifact_path || payload?.artifact_path || null,
    command: result?.command || null,
    stdout_tail: result?.stdout_tail || null,
    stderr_tail: result?.stderr_tail || null,
    idempotency_key: row?.idempotency_key || payload?.idempotency_key || null,
    worker_queue: row?.worker_queue || null,
    required_tags: Array.isArray(row?.required_tags) ? row.required_tags : [],
  };
}

async function buildReportsInventory() {
  const defs = listReportDefinitions();
  const rows = await getReportRefreshRows(null, 600);
  const byReport = new Map();
  for (const row of rows) {
    const rid = row?.payload?.report_id;
    if (!rid) continue;
    if (!byReport.has(rid)) byReport.set(rid, []);
    byReport.get(rid).push(row);
  }

  const reports = defs.map((def) => {
    const artifact = latestArtifactForReport(def);
    const lastGeneratedAt = artifact?.mtime || null;
    const ageMin = ageMinutesFromIso(lastGeneratedAt);
    
    // Freshness is based purely on artifact age, not on running/failed status
    // If artifact exists and is fresh, it's GREEN regardless of current run status
    let freshnessStatus = freshnessFromAge(ageMin, def.staleAfterMinutes);
    
    const historyRows = byReport.get(def.id) || [];
    const latestRow = historyRows[0] ? normalizeReportHistoryRow(historyRows[0]) : null;
    const running = historyRows.some((r) => ["CREATED", "PENDING", "DISPATCHED", "RUNNING"].includes(String(r.status || "")));
    
    // Freshness is based on artifact age, NOT on running/failed status
    // If artifact exists and is fresh, it's GREEN even if currently running or failed
    let effectiveAgeMin = ageMin;
    let effectiveLastGeneratedAt = lastGeneratedAt;
    
    if (!artifact) {
      // No artifact - check for completed runs (not running ones)
      const completedRows = historyRows.filter((r) => 
        ["COMPLETED"].includes(String(r.status || ""))
      );
      const lastCompleted = completedRows[0] ? normalizeReportHistoryRow(completedRows[0]) : null;
      
      if (lastCompleted && lastCompleted.completed_at) {
        // Use last completed run timestamp for age calculation
        effectiveLastGeneratedAt = lastCompleted.completed_at;
        effectiveAgeMin = ageMinutesFromIso(lastCompleted.completed_at);
        freshnessStatus = freshnessFromAge(effectiveAgeMin, def.staleAfterMinutes);
      } else if (!latestRow) {
        // No artifact and no history - treat as "never run"
        // This is expected for new reports, so don't mark as problematic
        effectiveAgeMin = null;
        freshnessStatus = "yellow"; // Indicates needs first run (not an error)
      } else {
        // Has running/failed but no completed - check if currently running
        if (running) {
          // Currently running - show as yellow but not stale
          effectiveAgeMin = null;
          freshnessStatus = "yellow"; // Running (not stale, just in progress)
        } else {
          // Failed but never completed - treat as needs attention
          effectiveAgeMin = null;
          freshnessStatus = "yellow"; // Unknown freshness (needs attention)
        }
      }
    } else {
      // Artifact exists - freshness is based on artifact age only
      // Running/failed status doesn't affect freshness
      if (ageMin < def.staleAfterMinutes) {
        freshnessStatus = "green"; // Fresh artifact = GREEN
      }
      // ageMin >= staleAfterMinutes already handled by freshnessFromAge above
    }

    return {
      id: def.id,
      name: def.name,
      lane: def.lane,
      last_generated_at: effectiveLastGeneratedAt || lastGeneratedAt,
      age_min: effectiveAgeMin != null ? effectiveAgeMin : (ageMin < 1000 ? ageMin : null),
      freshness_status: freshnessStatus,
      artifact_path: artifact?.abs || null,
      last_result: latestRow,
      stale_severity: def.staleSeverity,
      cadence_minutes: def.cadenceMinutes,
      stale_after_minutes: def.staleAfterMinutes,
      refresh_command: def.refreshCommand,
      refresh_task_type: def.refreshTaskType,
      queue_route: def.queueRoute,
      required_tags: def.requiredTags,
      running_refresh: running,
    };
  });

  // Calculate summary - exclude "never run" reports (no artifact, no history) from status counts
  // These are expected for new reports and shouldn't affect global status
  const reportsWithHistory = reports.filter((r) => r.artifact_path || r.last_result);
  const summary = {
    total_reports: reports.length,
    green: reports.filter((r) => r.freshness_status === "green").length,
    yellow: reportsWithHistory.filter((r) => r.freshness_status === "yellow").length, // Only count yellow if has history
    red: reports.filter((r) => r.freshness_status === "red").length,
    running_refreshes: reports.filter((r) => r.running_refresh).length,
    never_run: reports.filter((r) => !r.artifact_path && !r.last_result).length, // Track never-run reports separately
  };
  
  // Calculate overall status: green if all reports with history are green, yellow if any are yellow/red
  let overall = "green";
  if (summary.red > 0) {
    overall = "red";
  } else if (summary.yellow > 0) {
    overall = "yellow";
  }
  summary.overall = overall;

  return { reports, summary };
}

async function enqueueReportRefresh(reportId, requestedBy = "dashboard", priority = 3) {
  const reportDef = getReportDefinition(reportId);
  if (!reportDef) {
    const err = new Error("unknown_report_id");
    err.status = 404;
    throw err;
  }

  const activeStatuses = ["CREATED", "PENDING", "DISPATCHED", "RUNNING", "RETRY"];
  const { rows: activeRows } = await pg.query(
    `SELECT id, status, created_at
       FROM tasks
      WHERE type = 'report_refresh'
        AND payload->>'report_id' = $1
        AND status = ANY($2::text[])
      ORDER BY created_at DESC
      LIMIT 1`,
    [reportId, activeStatuses]
  );
  if (activeRows.length > 0) {
    return {
      accepted: true,
      deduped: true,
      task_id: activeRows[0].id,
      status: activeRows[0].status,
      accepted_at: toIso(activeRows[0].created_at),
    };
  }

  const cap = Math.max(1, Number(process.env.REPORT_REFRESH_CONCURRENCY_CAP || "3") || 3);
  const { rows: runningRows } = await pg.query(
    `SELECT COUNT(*)::int AS n
       FROM tasks
      WHERE type = 'report_refresh'
        AND status = ANY($1::text[])`,
    [activeStatuses]
  );
  const runningCount = Number(runningRows?.[0]?.n || 0);
  if (runningCount >= cap) {
    const err = new Error("report_refresh_concurrency_cap");
    err.status = 429;
    throw err;
  }

  await ensureReportRefreshTaskColumns();
  const now = Date.now();
  const windowMinutes = Math.max(1, Number(process.env.REPORT_REFRESH_IDEMPOTENCY_MIN || "10") || 10);
  const windowBucket = Math.floor(now / (windowMinutes * 60_000));
  const payload = {
    report_id: reportId,
    requested_by: requestedBy,
    priority,
    enqueued_at: new Date(now).toISOString(),
  };
  const idempotencyKey = buildTaskIdempotencyKey("report_refresh", {
    report_id: reportId,
    window_bucket: windowBucket,
  });

  const taskId = crypto.randomUUID();
  await pg.query(
    `INSERT INTO tasks (
        id, type, payload, status, priority, worker_queue, required_tags, idempotency_key, title
      ) VALUES (
        $1, 'report_refresh', $2::jsonb, 'CREATED', $3, $4, $5::text[], $6, $7
      )`,
    [
      taskId,
      JSON.stringify({ ...payload, idempotency_key: idempotencyKey }),
      Math.max(1, Math.min(10, Number(priority) || 3)),
      reportDef.queueRoute || "claw_tasks_infra",
      reportDef.requiredTags || ["infra", "deterministic"],
      idempotencyKey,
      `Report refresh: ${reportDef.name}`,
    ]
  );

  return {
    accepted: true,
    deduped: false,
    task_id: taskId,
    accepted_at: new Date(now).toISOString(),
    idempotency_key: idempotencyKey,
  };
}

// ── Handlers ───────────────────────────────────────────────────

async function handlePostGoal(req, res, body) {
  const goal = (body.goal || "").toString().trim();
  if (!goal) {
    return jsonResponse(res, 400, { error: "Missing or empty goal" });
  }

  // FIX C1: declare outside try so it's in scope for verifyPlan/insertPlan below
  let taskPlan;

  try {
    if (await isEmergencyStopped()) {
      return jsonResponse(res, 503, { error: "Emergency stop is active — new plans are blocked." });
    }

    const summary = await spendSummary();
    if (summary.remaining_usd <= 0) {
      return jsonResponse(res, 429, {
        error: `Daily budget cap hit. Spent $${Number(summary.spent_usd || 0).toFixed(3)} of $${summary.daily_cap_usd} today.`,
      });
    }

    taskPlan = await planner.plan(goal);

    await checkBudget(taskPlan.estimated_cost_usd || 0);
  } catch (budgetErr) {
    return jsonResponse(res, 429, { error: budgetErr.message });
  }

  try {
    await verifyPlan(taskPlan);
  } catch (verifyErr) {
    return jsonResponse(res, 400, { error: verifyErr.message });
  }

  const { planId } = await insertPlan(taskPlan);
  const tier = taskPlan.intent_tier ?? 2;

  if (tier === 0 || tier === 1) {
    if (tier === 1) {
      await pg.query(`UPDATE tasks SET status = 'CREATED' WHERE plan_id = $1 AND status = 'PENDING'`, [planId]);
    }
    return jsonResponse(res, 200, {
      plan_id: planId,
      goal: taskPlan.goal,
      tasks: taskPlan.tasks.map((t) => ({ temp_id: t.temp_id, type: t.type, title: t.title })),
      intent_tier: tier,
      approval_required: false,
      cost_usd: taskPlan.estimated_cost_usd,
      risk_level: taskPlan.risk_level,
    });
  }

  if (taskPlan.approval_required) {
    const approvalToken = crypto.randomBytes(3).toString("hex").toUpperCase();
    await pg.query(
      `INSERT INTO plan_approvals (plan_id, telegram_user_id, telegram_chat_id, approval_token)
       VALUES ($1, NULL, NULL, $2) ON CONFLICT (plan_id) DO UPDATE SET approval_token = $2`,
      [planId, approvalToken]
    );
    await pg.query(
      `UPDATE tasks SET status = 'PENDING', approval_required = true WHERE plan_id = $1`,
      [planId]
    );

    return jsonResponse(res, 200, {
      plan_id: planId,
      goal: taskPlan.goal,
      tasks: taskPlan.tasks.map((t) => ({ temp_id: t.temp_id, type: t.type, title: t.title })),
      intent_tier: tier,
      approval_required: true,
      approval_token: approvalToken,
      cost_usd: taskPlan.estimated_cost_usd,
      risk_level: taskPlan.risk_level,
    });
  }

  return jsonResponse(res, 200, {
    plan_id: planId,
    goal: taskPlan.goal,
    tasks: taskPlan.tasks.map((t) => ({ temp_id: t.temp_id, type: t.type, title: t.title })),
    intent_tier: tier,
    approval_required: false,
    cost_usd: taskPlan.estimated_cost_usd,
    risk_level: taskPlan.risk_level,
  });
}

async function handlePostOrchestrate(req, res, body) {
  const goal = (body.goal || "").toString().trim();
  if (!goal) {
    return jsonResponse(res, 400, { error: "Missing or empty goal" });
  }

  const waitForResult = body.wait === true;
  const orchestrationId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  ORCHESTRATION_RUNS.set(orchestrationId, {
    id: orchestrationId,
    goal,
    status: "queued",
    started_at: startedAt,
    completed_at: null,
    result: null,
    error: null,
  });
  while (ORCHESTRATION_RUNS.size > 200) {
    const firstKey = ORCHESTRATION_RUNS.keys().next().value;
    ORCHESTRATION_RUNS.delete(firstKey);
  }

  const runPromise = (async () => {
    try {
      const handler = getHandler("orchestrate");
      if (!handler) {
        throw new Error("Orchestrator not registered");
      }
      ORCHESTRATION_RUNS.set(orchestrationId, {
        ...ORCHESTRATION_RUNS.get(orchestrationId),
        status: "running",
      });
      const result = await handler({
        goal,
        context: body.context || {},
        dry_run: !!body.dry_run,
      });
      ORCHESTRATION_RUNS.set(orchestrationId, {
        ...ORCHESTRATION_RUNS.get(orchestrationId),
        status: "completed",
        completed_at: new Date().toISOString(),
        result,
      });
      return result;
    } catch (err) {
      ORCHESTRATION_RUNS.set(orchestrationId, {
        ...ORCHESTRATION_RUNS.get(orchestrationId),
        status: "failed",
        completed_at: new Date().toISOString(),
        error: String(err?.message || "orchestrate_failed"),
      });
      throw err;
    }
  })();

  if (waitForResult) {
    try {
      const result = await runPromise;
      return jsonResponse(res, 200, {
        ...result,
        orchestration_id: result?.orchestration_id || orchestrationId,
      });
    } catch (err) {
      console.error("[architect-api] orchestrate error:", err.message);
      return jsonResponse(res, 500, { error: err.message, orchestration_id: orchestrationId });
    }
  }

  runPromise.catch((err) => {
    console.error("[architect-api] orchestrate async error:", err.message);
  });

  return jsonResponse(res, 202, {
    status: "queued",
    message: "Orchestration accepted and running in background.",
    orchestration_id: orchestrationId,
    plan_ids: [],
    sub_goals_total: null,
    started_at: startedAt,
  });
}


async function handlePostPlanApprove(req, res, body, planId) {
  const token = (body.approval_token || "").toString().trim().toUpperCase();
  if (!token) {
    return jsonResponse(res, 400, { error: "Missing approval_token" });
  }

  // FIX C2: include plan_id = $2 in WHERE so token is only consumed for the correct plan.
  // Previously the UPDATE fired first, burning the token, then plan_id was checked — too late.
  const { rows } = await pg.query(
    `UPDATE plan_approvals
     SET approved = true, approved_at = NOW()
     WHERE approval_token = $1
       AND plan_id = $2
       AND approved = false
       AND expires_at > NOW()
     RETURNING plan_id`,
    [token, planId]
  );

  if (!rows.length) {
    return jsonResponse(res, 400, { error: "Token invalid, already used, expired, or does not match plan." });
  }

  const { rows: planRows } = await pg.query(`SELECT intent_tier FROM plans WHERE id = $1`, [planId]);
  const tier = planRows[0]?.intent_tier ?? 2;

  if (tier === 3) {
    const confirmToken = crypto.randomBytes(3).toString("hex").toUpperCase();
    await pg.query(`UPDATE plan_approvals SET confirm_token = $1 WHERE plan_id = $2`, [confirmToken, planId]);
    return jsonResponse(res, 200, {
      confirm_required: true,
      confirm_token: confirmToken,
      message: "Tier 3 — second confirmation required",
    });
  }

  await pg.query(
    `UPDATE tasks SET status = 'CREATED'
     WHERE plan_id = $1 AND status = 'PENDING' AND approval_required = true
       AND (depends_on IS NULL OR depends_on = '{}')`,
    [planId]
  );

  return jsonResponse(res, 200, { approved: true, message: "Plan approved — tasks dispatching." });
}

async function handlePostPlanReject(req, res, body, planId) {
  const token = (body.approval_token || "").toString().trim().toUpperCase();
  if (!token) {
    return jsonResponse(res, 400, { error: "Missing approval_token" });
  }

  const { rows } = await pg.query(
    `SELECT plan_id FROM plan_approvals WHERE approval_token = $1 AND expires_at > NOW()`,
    [token]
  );

  if (!rows.length) {
    return jsonResponse(res, 400, { error: "Token invalid or expired." });
  }

  if (rows[0].plan_id !== planId) {
    return jsonResponse(res, 400, { error: "Token does not match plan" });
  }

  await pg.query(`UPDATE plans SET status = 'cancelled' WHERE id = $1`, [planId]);
  await pg.query(`UPDATE tasks SET status = 'CANCELLED' WHERE plan_id = $1 AND status = 'PENDING'`, [planId]);

  return jsonResponse(res, 200, { rejected: true, message: "Plan rejected and cancelled." });
}

async function handlePostPlanConfirm(req, res, body, planId) {
  const token = (body.confirm_token || "").toString().trim().toUpperCase();
  if (!token) {
    return jsonResponse(res, 400, { error: "Missing confirm_token" });
  }

  const { rows } = await pg.query(
    `SELECT plan_id FROM plan_approvals WHERE confirm_token = $1 AND approved = true AND expires_at > NOW()`,
    [token]
  );

  if (!rows.length) {
    return jsonResponse(res, 400, { error: "Confirm token invalid or expired." });
  }

  if (rows[0].plan_id !== planId) {
    return jsonResponse(res, 400, { error: "Token does not match plan" });
  }

  await pg.query(
    `UPDATE tasks SET status = 'CREATED'
     WHERE plan_id = $1 AND status = 'PENDING' AND approval_required = true
       AND (depends_on IS NULL OR depends_on = '{}')`,
    [planId]
  );
  await pg.query(`UPDATE plan_approvals SET confirm_token = NULL WHERE plan_id = $1`, [planId]);

  return jsonResponse(res, 200, { confirmed: true, message: "Tier 3 plan executing." });
}

async function handleGetPlan(req, res, planId) {
  const { rows: planRows } = await pg.query(
    `SELECT id, goal, status, total_tasks, estimated_cost_usd, intent_tier, raw_plan, created_at
     FROM plans WHERE id = $1`,
    [planId]
  );

  if (!planRows.length) {
    return jsonResponse(res, 404, { error: "Plan not found" });
  }

  const plan = planRows[0];
  const { rows: taskRows } = await pg.query(
    `SELECT id, type, title, status, duration_ms, last_error, result, sequence
     FROM tasks WHERE plan_id = $1 ORDER BY sequence ASC, created_at ASC`,
    [planId]
  );

  return jsonResponse(res, 200, {
    plan_id: plan.id,
    goal: plan.goal,
    status: plan.status,
    total_tasks: plan.total_tasks,
    estimated_cost_usd: plan.estimated_cost_usd,
    intent_tier: plan.intent_tier,
    created_at: plan.created_at,
    tasks: taskRows.map((t) => ({
      id: t.id,
      type: t.type,
      title: t.title,
      status: t.status,
      duration_ms: t.duration_ms,
      last_error: t.last_error,
      result: t.result ? (typeof t.result === "string" ? JSON.parse(t.result) : t.result) : null,
    })),
  });
}

async function handleGetTasks(req, res) {
  const parsed = url.parse(req.url, true);
  const planId = parsed.query?.plan_id || null;
  const status = parsed.query?.status || null;

  let sql = `SELECT id, type, title, plan_id, status, duration_ms, last_error, created_at, completed_at FROM tasks WHERE 1=1`;
  const params = [];
  let idx = 1;

  if (planId) {
    sql += ` AND plan_id = $${idx++}`;
    params.push(planId);
  }
  if (status) {
    sql += ` AND status = $${idx++}`;
    params.push(status);
  }

  sql += ` ORDER BY created_at DESC LIMIT 100`;

  const { rows } = await pg.query(sql, params);
  return jsonResponse(res, 200, { tasks: rows });
}

const EVENTS_STREAM_DOMAIN = process.env.EVENTS_STREAM_DOMAIN || "events.domain";
const EVENTS_LAG_WARN = parseInt(process.env.EVENTS_LAG_WARN || "1000", 10);

const LOAD_REDUCED_STATE_FILE = path.join(__dirname, "..", ".load-reduced.json");

async function handleSystemReduceLoad(req, res, body) {
  try {
    const reason = body.reason || "manual";
    const hostname = require("os").hostname();

    // Stop local workers (but keep dispatcher, gateway, and architect-api running)
    const { stdout: pm2Raw } = await execAsync("pm2 jlist", { timeout: 5000 });
    const processes = JSON.parse(pm2Raw);
    const stoppedWorkers = [];

    for (const proc of processes) {
      const name = proc.name || "";
      // Stop workers but keep control plane services running
      if (name &&
          (name.includes("worker") || name.includes("claw-worker")) &&
          !name.includes("architect-api") &&
          !name.includes("gateway") &&
          !name.includes("dispatcher") &&
          proc.pm2_env?.status === "online") {
        try {
          await execAsync(`pm2 stop ${proc.pm_id}`, { timeout: 5000 });
          stoppedWorkers.push(name);
        } catch (err) {
          console.warn(`[reduce-load] Failed to stop ${name}:`, err.message);
        }
      }
    }
    
    // Mark local device as draining in device_registry (so work routes to other devices)
    try {
      await pg.query(
        `UPDATE device_registry 
         SET status = 'draining', 
             updated_at = NOW(),
             capabilities = COALESCE(capabilities, '{}'::jsonb) || $1::jsonb
         WHERE hostname = $2 OR worker_id LIKE $3`,
        [
          JSON.stringify({ load_reduced: true, reduced_at: new Date().toISOString(), reason }),
          hostname,
          `${hostname}%`
        ]
      );
    } catch (err) {
      console.warn("[reduce-load] Failed to update device_registry:", err.message);
    }
    
    // Force garbage collection to free RAM
    if (global.gc) {
      global.gc();
    }
    
    // Save state
    const state = {
      load_reduced: true,
      reduced_at: new Date().toISOString(),
      reduced_by: "dashboard",
      reason: reason,
      stopped_workers: stoppedWorkers,
      hostname: hostname,
    };
    fs.writeFileSync(LOAD_REDUCED_STATE_FILE, JSON.stringify(state, null, 2));
    
    return jsonResponse(res, 200, {
      ok: true,
      message: `Local load reduced. Stopped ${stoppedWorkers.length} workers. Work will route to other devices. RAM freed.`,
      stopped_workers: stoppedWorkers,
      reduced_at: state.reduced_at,
    });
  } catch (err) {
    return jsonResponse(res, 500, {
      ok: false,
      error: err.message || "reduce_load_failed",
    });
  }
}

async function handleSystemResumeLoad(req, res) {
  try {
    const hostname = require("os").hostname();
    
    // Check if load was reduced
    let state = null;
    try {
      if (fs.existsSync(LOAD_REDUCED_STATE_FILE)) {
        state = JSON.parse(fs.readFileSync(LOAD_REDUCED_STATE_FILE, "utf8"));
      }
    } catch (err) {
      // Ignore
    }
    
    // Restart local workers
    const { stdout: pm2Raw } = await execAsync("pm2 jlist", { timeout: 5000 });
    const processes = JSON.parse(pm2Raw);
    const resumedWorkers = [];

    for (const proc of processes) {
      const name = proc.name || "";
      if (name &&
          (name.includes("worker") || name.includes("claw-worker")) &&
          proc.pm2_env?.status === "stopped") {
        try {
          await execAsync(`pm2 start ${proc.pm_id}`, { timeout: 5000 });
          resumedWorkers.push(name);
        } catch (err) {
          console.warn(`[resume-load] Failed to start ${name}:`, err.message);
        }
      }
    }
    
    // Mark local device as ready again in device_registry
    try {
      await pg.query(
        `UPDATE device_registry 
         SET status = 'ready', 
             updated_at = NOW(),
             capabilities = COALESCE(capabilities, '{}'::jsonb) - 'load_reduced' - 'reduced_at' - 'reason'
         WHERE hostname = $1 OR worker_id LIKE $2`,
        [hostname, `${hostname}%`]
      );
    } catch (err) {
      console.warn("[resume-load] Failed to update device_registry:", err.message);
    }
    
    // Remove state file
    try {
      if (fs.existsSync(LOAD_REDUCED_STATE_FILE)) {
        fs.unlinkSync(LOAD_REDUCED_STATE_FILE);
      }
    } catch (err) {
      console.warn("[resume-load] Failed to remove state file:", err.message);
    }
    
    return jsonResponse(res, 200, {
      ok: true,
      message: `Local work resumed. Started ${resumedWorkers.length} workers. Accepting local work again.`,
      resumed_workers: resumedWorkers,
      resumed_at: new Date().toISOString(),
    });
  } catch (err) {
    return jsonResponse(res, 500, {
      ok: false,
      error: err.message || "resume_load_failed",
    });
  }
}

async function handleSystemPm2Ensure(req, res) {
  void req;
  try {
    const startedAt = new Date().toISOString();
    const child = spawn("npm", ["run", "-s", "pm2:ensure"], {
      cwd: path.join(__dirname, ".."),
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return jsonResponse(res, 200, {
      ok: true,
      message: "pm2:ensure started",
      started_at: startedAt,
      pid: child.pid || null,
    });
  } catch (err) {
    return jsonResponse(res, 500, {
      ok: false,
      error: err.message || "pm2_ensure_failed",
    });
  }
}

async function handleSystemStatus(req, res) {
  try {
    let loadReduced = false;
    let state = null;
    const hostname = require("os").hostname();
    
    try {
      if (fs.existsSync(LOAD_REDUCED_STATE_FILE)) {
        state = JSON.parse(fs.readFileSync(LOAD_REDUCED_STATE_FILE, "utf8"));
        loadReduced = state.load_reduced === true;
      }
    } catch (err) {
      // Ignore
    }
    
    // Check PM2 status
    let processStatus = [];
    let pm2Running = false;
    let criticalProcessesRunning = 0;
    
    try {
      const { stdout: pm2List } = await execAsync("pm2 jlist", { timeout: 15000 });
      const processes = JSON.parse(pm2List);
      pm2Running = true;
      processStatus = processes.map((proc) => {
        const name = proc.name || "";
        const status = proc.pm2_env?.status || "unknown";
        return {
          name: name,
          status: status,
          memory: proc.monit?.memory || 0,
          is_critical: CRITICAL_PROCESS_NAMES.includes(name),
        };
      });
    } catch (err) {
      // Fallback: pm2 jlist can timeout under heavy process count.
      try {
        const checks = await Promise.all(
          CRITICAL_PROCESS_NAMES.map(async (name) => {
            try {
              const { stdout } = await execAsync(`pm2 pid ${name}`, { timeout: 5000 });
              const pid = Number(String(stdout || "").trim());
              const online = Number.isFinite(pid) && pid > 0;
              return { name, status: online ? "online" : "stopped", memory: 0, is_critical: true, online };
            } catch {
              return { name, status: "unknown", memory: 0, is_critical: true, online: false };
            }
          })
        );
        pm2Running = checks.some((x) => x.online);
        processStatus = checks.map(({ online, ...rest }) => rest);
      } catch {
        // PM2 not available or not running
        pm2Running = false;
      }
    }
    
    // Check device registry status
    let deviceStatus = null;
    try {
      const { rows } = await pg.query(
        `SELECT status, capabilities FROM device_registry 
         WHERE hostname = $1 OR worker_id LIKE $2 
         LIMIT 1`,
        [hostname, `${hostname}%`]
      );
      if (rows.length > 0) {
        deviceStatus = rows[0];
        loadReduced = loadReduced || deviceStatus.status === 'draining' || deviceStatus.capabilities?.load_reduced === true;
      }
    } catch (err) {
      // Ignore
    }
    
    const now = Date.now();
    const processStatusByName = new Map(
      (processStatus || [])
        .map((p) => [String(p.name), String(p.status || "unknown")])
    );
    const missingCritical = [];
    for (const check of CRITICAL_CHECKS) {
      const ok = check.any.some((name) => processStatusByName.get(name) === "online");
      if (ok) criticalProcessesRunning += 1;
      else missingCritical.push(check.id);
    }
    const healthy = pm2Running && criticalProcessesRunning >= CRITICAL_CHECKS.length;
    if (healthy) {
      PM2_WARNING_STATE.unhealthy_since = null;
      PM2_WARNING_STATE.unhealthy_streak = 0;
      PM2_WARNING_STATE.last_health = true;
    } else {
      PM2_WARNING_STATE.unhealthy_since = PM2_WARNING_STATE.unhealthy_since || now;
      PM2_WARNING_STATE.unhealthy_streak += 1;
      PM2_WARNING_STATE.last_health = false;
    }
    const unhealthyDurationMs = PM2_WARNING_STATE.unhealthy_since ? now - PM2_WARNING_STATE.unhealthy_since : 0;
    const sustainedUnhealthy =
      !healthy &&
      PM2_WARNING_STATE.unhealthy_streak >= PM2_WARNING_MIN_CONSECUTIVE &&
      unhealthyDurationMs >= PM2_WARNING_GRACE_MS;
    let autoHealTriggered = false;
    let autoHealTargets = [];
    if (
      PM2_AUTO_HEAL_ENABLED &&
      missingCritical.length > 0 &&
      now - PM2_WARNING_STATE.last_auto_heal_at >= PM2_AUTO_HEAL_COOLDOWN_MS &&
      PM2_WARNING_STATE.unhealthy_streak >= PM2_WARNING_MIN_CONSECUTIVE
    ) {
      PM2_WARNING_STATE.last_auto_heal_at = now;
      autoHealTargets = missingCritical.slice(0, 4).map((id) => {
        const check = CRITICAL_CHECKS.find((c) => c.id === id);
        return check?.any?.[0] || id;
      });
      for (const name of autoHealTargets) {
        execAsync(`pm2 start ${name}`, { timeout: 8000 }).catch(() => {});
      }
      autoHealTriggered = true;
    }

    return jsonResponse(res, 200, {
      load_reduced: loadReduced,
      state: state,
      processes: processStatus,
      device_status: deviceStatus,
      hostname: hostname,
      pm2_running: pm2Running,
      critical_processes_running: criticalProcessesRunning,
      critical_processes_total: CRITICAL_CHECKS.length,
      persistence_warning: sustainedUnhealthy,
      persistence_warning_reason: sustainedUnhealthy
        ? (!pm2Running ? "pm2_unavailable" : "critical_processes_below_target")
        : null,
      missing_critical_processes: missingCritical,
      auto_heal: {
        enabled: PM2_AUTO_HEAL_ENABLED,
        triggered: autoHealTriggered,
        targets: autoHealTargets,
        cooldown_ms: PM2_AUTO_HEAL_COOLDOWN_MS,
        last_auto_heal_at: PM2_WARNING_STATE.last_auto_heal_at || null,
      },
      warning_grace_ms: PM2_WARNING_GRACE_MS,
      unhealthy_streak: PM2_WARNING_STATE.unhealthy_streak,
      unhealthy_duration_ms: unhealthyDurationMs,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return jsonResponse(res, 500, {
      ok: false,
      error: err.message || "status_check_failed",
    });
  }
}

function unblockActionFromReason(reason) {
  const r = String(reason || "");
  if (r.includes("OUTPUT_CONTRACT_MISSING")) {
    return "Emit final output JSON with repo,symbol_ids,index_run,repo_map_path,changed_files,tests_passed.";
  }
  if (r.includes("GIT_EVIDENCE_MISSING")) {
    return "Include git evidence: `git rev-parse HEAD` and `git diff --name-only` from the target repo.";
  }
  if (r.includes("SYMBOL_PREFLIGHT_FAILED")) {
    return "Run filesystem MCP + rg symbol-map indexing (no jcodemunch) + repo_mapper when available, then include verified symbol IDs and repomap path.";
  }
  if (r.includes("RESEARCH_CONTRACT_INCOMPLETE")) {
    return "Provide ranked implementation candidates, exact symbol targets, and acceptance criteria.";
  }
  if (r.includes("BLOCKED_LOOP")) {
    return "Change objective or inputs for this lane and rerun to break duplicate-loop fingerprint.";
  }
  if (r.includes("DRY_RUN_NO_EVIDENCE")) {
    return "Run the lane without --dry-run so integrity evidence can be produced.";
  }
  return "Inspect integrity reasons and rerun with required evidence.";
}

async function handleManagementIntegrityQuarantine(req, res) {
  try {
    const state = loadManagementIntegrityState();
    const entries = Object.entries(state?.entries || {});
    const blocked = entries
      .map(([key, entry]) => ({
        key,
        lane: key.split(":")[1] || "unknown",
        repo: key.split(":")[2] || "unknown",
        agent_id: key.split(":")[3] || "unknown",
        status: entry?.last_status || "unknown",
        summary: entry?.last_summary || "",
        quarantined: Boolean(entry?.quarantined?.active),
        required_action: entry?.quarantined?.required_action || unblockActionFromReason(entry?.last_summary || ""),
        last_seen_at: entry?.last_seen_at || null,
      }))
      .filter((x) => x.status !== "COMPLETED")
      .sort((a, b) => Date.parse(b.last_seen_at || 0) - Date.parse(a.last_seen_at || 0));

    return jsonResponse(res, 200, {
      generated_at: new Date().toISOString(),
      blocked_total: blocked.length,
      blocked,
    });
  } catch (err) {
    return jsonResponse(res, 500, { ok: false, error: err.message || "management_integrity_quarantine_failed" });
  }
}

async function handleHealth(req, res) {
  const checks = { postgres: "unknown", redis: "unknown", workers: "unknown" };

  try {
    await pg.query("SELECT 1");
    checks.postgres = "ok";
  } catch (err) {
    checks.postgres = `fail: ${err.message}`;
  }

  try {
    await redis.ping();
    checks.redis = "ok";
  } catch (err) {
    checks.redis = `fail: ${err.message}`;
  }

  try {
    const { rows } = await pg.query(
      `SELECT 1 FROM device_registry
       WHERE status IN ('ready','busy') AND NOW() - last_heartbeat <= INTERVAL '90 seconds'
       LIMIT 1`
    );
    checks.workers = rows.length ? "ok" : "warn: no active workers";
  } catch (err) {
    checks.workers = `fail: ${err.message}`;
  }

  if (checks.redis === "ok") {
    for (const group of ["cg:auditor", "cg:spawner"]) {
      try {
        const pending = await redis.xpending(EVENTS_STREAM_DOMAIN, group);
        const count = Array.isArray(pending) ? pending[0] : (pending && pending[0]) || 0;
        const n = typeof count === "number" ? count : parseInt(String(count), 10) || 0;
        checks[`events_domain_pending_${group.replace(":", "_")}`] =
          n > EVENTS_LAG_WARN ? `warn: ${n} pending` : `ok: ${n}`;
      } catch (e) {
        if (/NOGROUP|no such key/i.test(e.message)) {
          checks[`events_domain_pending_${group.replace(":", "_")}`] = "ok: 0 (no group yet)";
        } else {
          checks[`events_domain_pending_${group.replace(":", "_")}`] = `fail: ${e.message}`;
        }
      }
    }
  }

  // 503 only if postgres or redis fail; workers absent is non-fatal
  const criticalFail = checks.postgres !== "ok" || checks.redis !== "ok";
  const status = criticalFail ? 503 : 200;
  return jsonResponse(res, status, {
    status: criticalFail ? "unhealthy" : (checks.workers === "ok" ? "ok" : "degraded"),
    checks,
  });
}

let progressCache = null;
let progressCacheAt = 0;
const PROGRESS_CACHE_TTL_MS = Math.max(2000, Number(process.env.ARCHITECT_PROGRESS_CACHE_MS || "10000") || 10000); // Reduced from 15s to 10s for fresher data
const DASHBOARD_TAB_ENVELOPE_CACHE = new Map();

function getDashboardTabEnvelopeCache(tabKey) {
  if (DASHBOARD_TAB_CACHE_TTL_MS <= 0) return null;
  const cached = DASHBOARD_TAB_ENVELOPE_CACHE.get(tabKey);
  if (!cached) return null;
  const now = Date.now();
  if (cached.expiresAt <= now) {
    DASHBOARD_TAB_ENVELOPE_CACHE.delete(tabKey);
    return null;
  }
  return {
    ...cached.envelope,
    _cache: {
      hit: true,
      tab: tabKey,
      age_ms: Math.max(0, now - cached.storedAt),
      ttl_ms: DASHBOARD_TAB_CACHE_TTL_MS,
    },
  };
}

function setDashboardTabEnvelopeCache(tabKey, envelope) {
  if (DASHBOARD_TAB_CACHE_TTL_MS <= 0) return;
  const now = Date.now();
  DASHBOARD_TAB_ENVELOPE_CACHE.set(tabKey, {
    storedAt: now,
    expiresAt: now + DASHBOARD_TAB_CACHE_TTL_MS,
    envelope,
  });
}

function invalidateDashboardTabEnvelopeCache() {
  DASHBOARD_TAB_ENVELOPE_CACHE.clear();
}

async function buildProgressData(force = false) {
  const now = Date.now();
  if (!force && progressCache && now - progressCacheAt < PROGRESS_CACHE_TTL_MS) {
    // Return cached data but mark it as cached
    return { ...progressCache, _cached: true, _cache_age_ms: now - progressCacheAt };
  }

  const out = {
    generated_at: new Date().toISOString(),
    system: { status: "unknown" },
    history: {},
    metrics: {},
    completed: [],
    needs_attention: [],
  };

  const greenPath = latestReportFile("-global-redgreen-status.json");
  const green = readJsonSafe(greenPath);
  if (green) {
    out.system = {
      status: green.status || "unknown",
      green: green.green_count ?? null,
      yellow: green.yellow_count ?? null,
      red: green.red_count ?? null,
      file: greenPath,
    };
  } else {
    const coreRequired = [
      "claw-dispatcher",
      "claw-webhook-server",
      "claw-worker-ai",
      "claw-worker-nas",
      ...(EXTERNAL_CHAT_CHANNELS_ENABLED ? ["claw-gateway"] : []),
    ];
    const pm2List = await parsePm2ListSafe();
    const stateByName = new Map(pm2List.map((p) => [p.name, p.pm2_env?.status || "unknown"]));
    const offlineCore = coreRequired.filter((name) => stateByName.get(name) !== "online");
    const { rows: workerRows } = await pg.query(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('ready','busy') AND NOW() - last_heartbeat <= INTERVAL '90 seconds')::int AS active_workers
       FROM device_registry`
    );
    const activeWorkers = Number(workerRows?.[0]?.active_workers || 0);
    const status =
      offlineCore.length > 0 || activeWorkers < 2 ? "RED" : "GREEN";
    out.system = {
      status,
      green: status === "GREEN" ? 1 : 0,
      yellow: 0,
      red: status === "RED" ? 1 : 0,
      source: "live_fallback",
      detail: `active_workers=${activeWorkers} core_offline=${offlineCore.length}`,
    };
  }

  const launchPath = latestReportFile("-launch-e2e-matrix.json");
  const launch = readJsonSafe(launchPath);
  if (launch) {
    const skippedPlaywright = Array.isArray(launch.results)
      ? launch.results.filter((r) => r?.playwright?.skipped).length
      : 0;
    const skippedUptime = Array.isArray(launch.results)
      ? launch.results.filter((r) => r?.uptime?.skipped).length
      : 0;
    const blockingFailures = launch.blocking_failures ?? null;
    
    // Get yesterday's blocking failures for delta
    const { rows: launchHistoryRows } = await pg.query(
      `SELECT blocking_failures
       FROM launch_e2e_runs
       WHERE generated_at >= NOW() - INTERVAL '48 hours'
         AND generated_at < NOW() - INTERVAL '24 hours'
       ORDER BY generated_at DESC
       LIMIT 1`
    ).catch(() => ({ rows: [] }));
    const yesterdayBlocking = launchHistoryRows[0]?.blocking_failures ?? 0;
    
    out.history.launch_e2e = {
      generated_at: launch.generated_at || null,
      targets: launch.targets ?? null,
      failures: launch.failures ?? null,
      blocking_failures: blockingFailures,
      blocking_failures_delta: blockingFailures != null ? (blockingFailures - yesterdayBlocking) : null,
      skipped_checks: launch.skipped_checks ?? null,
      skipped_playwright: skippedPlaywright,
      skipped_uptime: skippedUptime,
      file: launchPath,
    };
  }

  const secPath = latestReportFile("-security-sweep.json");
  const sec = readJsonSafe(secPath);
  if (sec) {
    out.history.security_sweep = {
      generated_at: sec.generated_at || null,
      status: sec.ok ? "pass" : "fail",
      file: secPath,
    };
  }

  const repoPath = latestReportFile("-github-observability-scan.json");
  const repoFile = readJsonSafe(repoPath);
  let repoPassCount = null;
  let repoFailCount = null;
  
  if (repoFile) {
    repoPassCount = repoFile.pass_count ?? null;
    repoFailCount = repoFile.fail_count ?? null;
    out.history.repo_scan = {
      generated_at: repoFile.generated_at || null,
      repos_total: repoFile.repos_total ?? null,
      pass_count: repoPassCount,
      fail_count: repoFailCount,
      file: repoPath,
    };
  } else {
    const { rows: repoRows } = await pg.query(
      `SELECT
         status, repos_scanned, pass_count, fail_count, finished_at, started_at
       FROM github_repo_scan_runs
       ORDER BY finished_at DESC NULLS LAST, started_at DESC
       LIMIT 1`
    );
    const r = repoRows?.[0];
    if (r) {
      repoPassCount = r.pass_count ?? null;
      repoFailCount = r.fail_count ?? null;
      out.history.repo_scan = {
        generated_at: r.finished_at || r.started_at || null,
        repos_total: r.repos_scanned ?? null,
        pass_count: repoPassCount,
        fail_count: repoFailCount,
        source: "db_fallback",
      };
    }
  }
  
  // Get yesterday's repo scan results for delta
  if (repoPassCount != null) {
    const { rows: repoHistoryRows } = await pg.query(
      `SELECT pass_count, fail_count
       FROM github_repo_scan_runs
       WHERE finished_at >= NOW() - INTERVAL '48 hours'
         AND finished_at < NOW() - INTERVAL '24 hours'
       ORDER BY finished_at DESC
       LIMIT 1`
    ).catch(() => ({ rows: [] }));
    const yesterdayPass = repoHistoryRows[0]?.pass_count ?? 0;
    const yesterdayFail = repoHistoryRows[0]?.fail_count ?? 0;
    
    if (out.history.repo_scan) {
      out.history.repo_scan.pass_count_delta = repoPassCount - yesterdayPass;
      out.history.repo_scan.fail_count_delta = (repoFailCount ?? 0) - yesterdayFail;
    }
  }

  const qaHumanPath = latestReportFile("-qa-human-grade.json");
  const qaHuman = readJsonSafe(qaHumanPath);
  if (qaHuman) {
    out.history.qa_human = {
      generated_at: qaHuman.generated_at || null,
      targets: qaHuman.targets ?? null,
      failed_repos: qaHuman.failed_repos ?? null,
      high_findings: qaHuman.high_findings ?? null,
      file: qaHumanPath,
    };
  }

  const agentMemPath = latestReportFile("-agent-memory-audit.json");
  const agentMem = readJsonSafe(agentMemPath);
  if (agentMem) {
    out.history.agent_memory = {
      generated_at: agentMem.generated_at || null,
      total_agents: agentMem.summary?.total_agents ?? null,
      high_findings: agentMem.summary?.high_findings ?? null,
      missing_integration: agentMem.summary?.missing_integration ?? null,
      file: agentMemPath,
    };
  }

  const schemaAuditPath = latestReportFile("-schema-mismatch-audit.json");
  const schemaAudit = readJsonSafe(schemaAuditPath);
  if (schemaAudit) {
    out.history.schema_audit = {
      generated_at: schemaAudit.generated_at || null,
      invalid_constraints: schemaAudit.invalid_constraints || 0,
      invalid_indexes: schemaAudit.invalid_indexes || 0,
      total_issues: schemaAudit.total_issues || 0,
      file: schemaAuditPath,
    };
  }

  const opportunityPath = latestReportFile("-saas-opportunity-research.json");
  const opportunity = readJsonSafe(opportunityPath);
  out.history.saas_opportunity = {
    generated_at: opportunity?.completed_at || null,
    file: opportunityPath,
    top: Array.isArray(opportunity?.top) ? opportunity.top.slice(0, 4) : [],
  };

  const painPath = latestReportFile("-saas-pain-opportunity-report.json");
  const pain = readJsonSafe(painPath);
  out.history.saas_pain_pipeline = {
    generated_at: pain?.generated_at || null,
    file: painPath,
    records: pain?.collection?.included_records || 0,
    top_pain_points: Array.isArray(pain?.top_pain_points) ? pain.top_pain_points.slice(0, 5) : [],
  };

  const affiliatePath = latestReportFile("-affiliate-rollout-research.json");
  const affiliate = readJsonSafe(affiliatePath);
  out.history.affiliate_research = {
    generated_at: affiliate?.completed_at || null,
    file: affiliatePath,
    sites_discovered: Array.isArray(affiliate?.sites_discovered) ? affiliate.sites_discovered.length : 0,
    top_candidates: Array.isArray(affiliate?.open_source_search?.top_candidates)
      ? affiliate.open_source_search.top_candidates.slice(0, 3)
      : [],
  };

  const symbolicQaPath = path.join(REPORTS_DIR, "symbolic-qa-hub-latest.json");
  const symbolicQa = readJsonSafe(symbolicQaPath);
  out.history.symbolic_qa_hub = {
    generated_at: symbolicQa?.generated_at || null,
    file: symbolicQaPath,
    repos_total: Number(symbolicQa?.repos_total || 0),
    repos_indexed: Number(symbolicQa?.repos_indexed || 0),
    features_mapped: Array.isArray(symbolicQa?.features) ? symbolicQa.features.length : 0,
    queued_tasks: Array.isArray(symbolicQa?.queued_tasks) ? symbolicQa.queued_tasks.length : 0,
    top_features: Array.isArray(symbolicQa?.features)
      ? symbolicQa.features.slice(0, 8).map((f) => ({
          feature_key: f.feature_key,
          title: f.title || f.feature_key,
          top_symbol_count: Array.isArray(f.top_symbols) ? f.top_symbols.length : 0,
          top_repos: Array.from(new Set((f.top_symbols || []).map((s) => s.repo_key).filter(Boolean))).slice(0, 3),
        }))
      : [],
    repos_missing_index: Array.isArray(symbolicQa?.repos_missing_index) ? symbolicQa.repos_missing_index.slice(0, 12) : [],
  };

  const featureRotationPath = path.join(REPORTS_DIR, "daily-feature-rotation-latest.json");
  const featureRotation = readJsonSafe(featureRotationPath);
  const rotationQueued = Array.isArray(featureRotation?.queued) ? featureRotation.queued : [];
  out.history.daily_feature_rotation = {
    generated_at: featureRotation?.generated_at || null,
    file: featureRotationPath,
    repos_considered: Number(featureRotation?.repos_considered || 0),
    features_per_repo: Number(featureRotation?.features_per_repo || 0),
    features_queued: rotationQueued.length,
    features_created: rotationQueued.filter((q) => q && q.created === true).length,
    priority_repos: Array.isArray(featureRotation?.priority_repos) ? featureRotation.priority_repos.slice(0, 12) : [],
    top_feature_keys: Array.from(new Set(rotationQueued.map((q) => q.feature).filter(Boolean))).slice(0, 12),
  };

  const closedLoopPath = path.join(REPORTS_DIR, "closed-loop-daily-latest.json");
  const closedLoop = readJsonSafe(closedLoopPath);
  const closedTargets = Array.isArray(closedLoop?.targets) ? closedLoop.targets : [];
  out.history.closed_loop_daily = {
    generated_at: closedLoop?.generated_at || null,
    file: closedLoopPath,
    chains_targeted: closedTargets.length,
    chains_created: closedTargets.filter((t) => t && t.created === true).length,
    chains_already_active: closedTargets.filter((t) => String(t?.reason || "").includes("duplicate_active_workflow")).length,
    top_targets: closedTargets.slice(0, 12).map((t) => ({
      repo: t.repo,
      feature_key: t.feature_key,
      created: !!t.created,
      reason: t.reason || null,
    })),
  };

  const knowledgePath = path.join(REPORTS_DIR, "knowledge-troll-harvest-latest.json");
  const knowledge = readJsonSafe(knowledgePath);
  const domainEntries = Object.entries(knowledge?.domains || {});
  out.history.knowledge_troll_harvest = {
    generated_at: knowledge?.generated_at || null,
    file: knowledgePath,
    repos_discovered: Number(knowledge?.repos_discovered || 0),
    papers_discovered: Number(knowledge?.papers_discovered || 0),
    domains: domainEntries.length,
    queued_index_tasks: Array.isArray(knowledge?.queued_index_subagent_tasks) ? knowledge.queued_index_subagent_tasks.length : 0,
    queued_pattern_tasks: Array.isArray(knowledge?.queued_pattern_subagent_tasks) ? knowledge.queued_pattern_subagent_tasks.length : 0,
    top_repo_candidates: domainEntries
      .flatMap(([domain, d]) => (d?.top_repo_candidates || []).slice(0, 3).map((c) => ({ domain, key: c.key, score: c.score, url: c.url })))
      .slice(0, 15),
  };

  const robustPath = path.join(REPORTS_DIR, "pattern-robust-builder-latest.json");
  const robust = readJsonSafe(robustPath);
  out.history.pattern_robust_builder = {
    generated_at: robust?.generated_at || null,
    file: robustPath,
    playbooks_updated: Array.isArray(robust?.playbooks_updated) ? robust.playbooks_updated.length : 0,
    top_updates: Array.isArray(robust?.playbooks_updated)
      ? robust.playbooks_updated.slice(0, 12).map((u) => ({
          feature_key: u.feature_key,
          confidence: Number(u.confidence || 0),
          top_repo_sources: Array.isArray(u.top_repo_sources) ? u.top_repo_sources.slice(0, 4) : [],
          top_paper_sources: Array.isArray(u.top_paper_sources) ? u.top_paper_sources.slice(0, 4) : [],
        }))
      : [],
  };

  const kpiFlywheelPath = path.join(REPORTS_DIR, "production-kpi-flywheel-latest.json");
  const kpiFlywheel = readJsonSafe(kpiFlywheelPath);
  out.history.production_kpi_flywheel = {
    generated_at: kpiFlywheel?.generated_at || null,
    file: kpiFlywheelPath,
    score: Number(kpiFlywheel?.score || 0),
    summary: kpiFlywheel?.summary || null,
    gaps: Array.isArray(kpiFlywheel?.gaps) ? kpiFlywheel.gaps.slice(0, 10) : [],
    queued_actions: Array.isArray(kpiFlywheel?.queued_actions) ? kpiFlywheel.queued_actions.length : 0,
    top_actions: Array.isArray(kpiFlywheel?.queued_actions)
      ? kpiFlywheel.queued_actions.slice(0, 10).map((a) => ({
          kpi_key: a.kpi_key,
          severity: a.severity,
          repo: a.repo,
          created: !!a.created,
          reason: a.reason || null,
        }))
      : [],
  };

  const progressEnforcerPath = path.join(REPORTS_DIR, "forward-progress-enforcer-latest.json");
  const progressEnforcer = readJsonSafe(progressEnforcerPath);
  out.history.forward_progress_enforcer = {
    generated_at: progressEnforcer?.generated_at || null,
    file: progressEnforcerPath,
    objectives: Array.isArray(progressEnforcer?.objectives) ? progressEnforcer.objectives.length : 0,
    queued: Array.isArray(progressEnforcer?.queued) ? progressEnforcer.queued.length : 0,
    metrics: progressEnforcer?.metrics || {},
  };

  const streamlinePath = path.join(REPORTS_DIR, "agent-streamline-pulse-latest.json");
  const streamline = readJsonSafe(streamlinePath);
  out.history.agent_streamline_pulse = {
    generated_at: streamline?.generated_at || null,
    file: streamlinePath,
    removed_disallowed_channels: Array.isArray(streamline?.removed_disallowed_channels)
      ? streamline.removed_disallowed_channels
      : [],
    duplicate_singleton_candidates: Array.isArray(streamline?.duplicate_singleton_candidates)
      ? streamline.duplicate_singleton_candidates
      : [],
  };

  try {
    const { rows: learningRows } = await pg.query(
      `SELECT
         (SELECT COUNT(*)::int FROM symbol_feature_playbooks) AS playbooks,
         (SELECT COUNT(DISTINCT feature_key)::int FROM symbol_exemplar_symbols) AS features_indexed,
         (SELECT COUNT(*)::int FROM symbol_exemplar_symbols) AS symbols_indexed,
         (SELECT COUNT(*)::int FROM knowledge_sources WHERE source_type = 'repo' AND status = 'active') AS knowledge_repos,
         (SELECT COUNT(*)::int FROM knowledge_sources WHERE source_type = 'paper' AND status = 'active') AS knowledge_papers,
         (SELECT COUNT(*)::int FROM knowledge_sources WHERE source_type = 'repo' AND status = 'active' AND indexed = TRUE) AS knowledge_repos_indexed,
         (SELECT COUNT(*)::int FROM pattern_insights WHERE created_at >= NOW() - INTERVAL '24 hours') AS insights_24h,
         (SELECT COUNT(*)::int FROM pattern_insights) AS insights_total`
    );
    out.metrics.learning_flywheel = learningRows?.[0] || {};
  } catch {
    out.metrics.learning_flywheel = {
      playbooks: 0,
      features_indexed: 0,
      symbols_indexed: 0,
      knowledge_repos: 0,
      knowledge_papers: 0,
      knowledge_repos_indexed: 0,
      insights_24h: 0,
      insights_total: 0,
    };
  }

  try {
    const { rows: mediaRows } = await pg.query(
      `SELECT
         (SELECT COUNT(*)::int FROM file_index WHERE category IN ('image','video','audio')) AS total_assets,
         (SELECT COUNT(*)::int FROM media_metadata) AS metadata_assets,
         (SELECT COUNT(*)::int FROM media_hashes) AS hashed_assets,
         (SELECT COUNT(*)::int FROM media_visual_catalog) AS visual_assets,
         (SELECT COUNT(*)::int FROM shoot_group_members) AS clustered_assets,
         (SELECT COUNT(*)::int FROM tasks WHERE type = 'media_detect' AND created_at >= NOW() - INTERVAL '7 days') AS detect_runs_7d,
         (SELECT COUNT(*)::int FROM tasks WHERE type = 'media_enrich' AND created_at >= NOW() - INTERVAL '7 days') AS enrich_runs_7d,
         (SELECT COUNT(*)::int FROM tasks WHERE type = 'media_hash' AND created_at >= NOW() - INTERVAL '7 days') AS hash_runs_7d,
         (SELECT COUNT(*)::int FROM tasks WHERE type = 'media_visual_catalog' AND created_at >= NOW() - INTERVAL '7 days') AS visual_runs_7d,
         (SELECT COUNT(*)::int FROM tasks WHERE type = 'cluster_media' AND created_at >= NOW() - INTERVAL '7 days') AS cluster_runs_7d`
    );
    const media = mediaRows?.[0] || {};
    const totalAssets = Number(media.total_assets || 0);
    const metadataAssets = Number(media.metadata_assets || 0);
    const hashedAssets = Number(media.hashed_assets || 0);
    const visualAssets = Number(media.visual_assets || 0);
    const clusteredAssets = Number(media.clustered_assets || 0);
    const pct = (n) => (totalAssets > 0 ? Math.round((Number(n || 0) / totalAssets) * 1000) / 10 : 0);
    out.metrics.media_os = {
      total_assets: totalAssets,
      metadata_assets: metadataAssets,
      hashed_assets: hashedAssets,
      visual_assets: visualAssets,
      clustered_assets: clusteredAssets,
      metadata_backlog: Math.max(0, totalAssets - metadataAssets),
      hash_backlog: Math.max(0, totalAssets - hashedAssets),
      visual_backlog: Math.max(0, totalAssets - visualAssets),
      cluster_backlog: Math.max(0, totalAssets - clusteredAssets),
      metadata_coverage_pct: pct(metadataAssets),
      hash_coverage_pct: pct(hashedAssets),
      visual_coverage_pct: pct(visualAssets),
      cluster_coverage_pct: pct(clusteredAssets),
      detect_runs_7d: Number(media.detect_runs_7d || 0),
      enrich_runs_7d: Number(media.enrich_runs_7d || 0),
      hash_runs_7d: Number(media.hash_runs_7d || 0),
      visual_runs_7d: Number(media.visual_runs_7d || 0),
      cluster_runs_7d: Number(media.cluster_runs_7d || 0),
    };
  } catch {
    out.metrics.media_os = {
      total_assets: 0,
      metadata_assets: 0,
      hashed_assets: 0,
      visual_assets: 0,
      clustered_assets: 0,
      metadata_backlog: 0,
      hash_backlog: 0,
      visual_backlog: 0,
      cluster_backlog: 0,
      metadata_coverage_pct: 0,
      hash_coverage_pct: 0,
      visual_coverage_pct: 0,
      cluster_coverage_pct: 0,
      detect_runs_7d: 0,
      enrich_runs_7d: 0,
      hash_runs_7d: 0,
      visual_runs_7d: 0,
      cluster_runs_7d: 0,
    };
  }

  const { rows: planRows } = await pg.query(
    `SELECT status, COUNT(*)::int AS n
       FROM plans
      WHERE created_at >= NOW() - INTERVAL '7 days'
      GROUP BY status`
  );
  out.metrics.plan_status_7d = planRows;

  const { rows: taskRows } = await pg.query(
    `SELECT status, COUNT(*)::int AS n
       FROM tasks
      WHERE created_at >= NOW() - INTERVAL '7 days'
      GROUP BY status`
  );
  out.metrics.task_status_7d = taskRows;

  const { rows: queueRows } = await pg.query(
    `SELECT status, COUNT(*)::int AS n
       FROM tasks
      WHERE status IN ('CREATED','PENDING','DISPATCHED','RUNNING','FAILED','DEAD_LETTER')
      GROUP BY status`
  );
  const queue = {
    created: 0,
    pending: 0,
    dispatched: 0,
    running: 0,
    failed: 0,
    dead_letter: 0,
  };
  for (const row of queueRows || []) {
    const key = String(row.status || "").toLowerCase();
    if (Object.prototype.hasOwnProperty.call(queue, key)) {
      queue[key] = Number(row.n || 0);
    }
  }
  out.metrics.queue = queue;

  try {
    const { rows: agingRows } = await pg.query(
      `SELECT status, COUNT(*)::int AS n
         FROM tasks
        WHERE status IN ('CREATED','PENDING','DISPATCHED','RUNNING')
          AND created_at < NOW() - INTERVAL '60 minutes'
        GROUP BY status`
    );
    out.metrics.queue_aging = agingRows;
  } catch (err) {
    out.metrics.queue_aging = [];
  }

  try {
    const { rows: tagRows } = await pg.query(
      `SELECT COALESCE(required_tags[1], 'unscoped') AS tag, COUNT(*)::int AS n
         FROM tasks
        WHERE status IN ('CREATED','PENDING','DISPATCHED','RUNNING')
        GROUP BY 1
        ORDER BY n DESC
        LIMIT 12`
    );
    out.metrics.queue_by_tag = tagRows;
  } catch (err) {
    out.metrics.queue_by_tag = [];
  }

  const { rows: recentPlans } = await pg.query(
    `SELECT id, goal, status, intent_tier, created_at
       FROM plans
      ORDER BY created_at DESC
      LIMIT 8`
  );
  out.history.recent_plans = recentPlans;

  const { rows: leadRows } = await pg.query(
    `SELECT
       COUNT(*) FILTER (WHERE brand_slug='skynpatch')::int AS sk_total,
       COUNT(*) FILTER (WHERE brand_slug='skynpatch' AND email IS NOT NULL AND email<>'')::int AS sk_with_email,
       COUNT(*) FILTER (WHERE brand_slug='blackwallstreetopoly')::int AS bws_total,
       COUNT(*) FILTER (WHERE brand_slug='blackwallstreetopoly' AND email IS NOT NULL AND email<>'')::int AS bws_with_email
     FROM leads`
  );
  out.metrics.leads = leadRows[0] || {};

  const { rows: sendRows } = await pg.query(
    `SELECT
       COUNT(*) FILTER (WHERE brand_slug='skynpatch')::int AS sk_sends_total,
       COUNT(*) FILTER (WHERE brand_slug='skynpatch' AND sent_at::date = CURRENT_DATE)::int AS sk_sends_today,
       COUNT(*) FILTER (WHERE brand_slug='skynpatch' AND sent_at::date = CURRENT_DATE - INTERVAL '1 day')::int AS sk_sends_yesterday,
       COUNT(*) FILTER (WHERE brand_slug='skynpatch' AND sent_at::date = CURRENT_DATE AND (delivered_at IS NOT NULL OR status='delivered'))::int AS sk_delivered_today,
       COUNT(*) FILTER (WHERE brand_slug='skynpatch' AND sent_at::date = CURRENT_DATE AND opened_at IS NOT NULL)::int AS sk_opened_today,
       COUNT(*) FILTER (WHERE brand_slug='skynpatch' AND sent_at::date = CURRENT_DATE AND clicked_at IS NOT NULL)::int AS sk_clicked_today,
       COUNT(*) FILTER (WHERE brand_slug='skynpatch' AND opened_at IS NOT NULL)::int AS sk_opened_total,
       COUNT(*) FILTER (WHERE brand_slug='skynpatch' AND clicked_at IS NOT NULL)::int AS sk_clicked_total,
       COUNT(*) FILTER (WHERE brand_slug='blackwallstreetopoly')::int AS bws_sends_total,
       COUNT(*) FILTER (WHERE brand_slug='blackwallstreetopoly' AND sent_at::date = CURRENT_DATE)::int AS bws_sends_today,
       COUNT(*) FILTER (WHERE brand_slug='blackwallstreetopoly' AND sent_at::date = CURRENT_DATE - INTERVAL '1 day')::int AS bws_sends_yesterday,
       COUNT(*) FILTER (WHERE brand_slug='blackwallstreetopoly' AND sent_at::date = CURRENT_DATE AND (delivered_at IS NOT NULL OR status='delivered'))::int AS bws_delivered_today,
       COUNT(*) FILTER (WHERE brand_slug='blackwallstreetopoly' AND sent_at::date = CURRENT_DATE AND opened_at IS NOT NULL)::int AS bws_opened_today,
       COUNT(*) FILTER (WHERE brand_slug='blackwallstreetopoly' AND sent_at::date = CURRENT_DATE AND clicked_at IS NOT NULL)::int AS bws_clicked_today,
       COUNT(*) FILTER (WHERE brand_slug='blackwallstreetopoly' AND opened_at IS NOT NULL)::int AS bws_opened_total,
       COUNT(*) FILTER (WHERE brand_slug='blackwallstreetopoly' AND clicked_at IS NOT NULL)::int AS bws_clicked_total
     FROM email_sends
     WHERE status = 'sent'`
  );
  const sends = sendRows[0] || {};
  out.metrics.sends = {
    ...sends,
    sk_sends_delta: (sends.sk_sends_today || 0) - (sends.sk_sends_yesterday || 0),
    bws_sends_delta: (sends.bws_sends_today || 0) - (sends.bws_sends_yesterday || 0),
  };

  let skynpatchSales = { orders_total: 0, revenue_cents: 0, orders_today: 0, revenue_today_cents: 0, orders_7d: 0, revenue_7d_cents: 0 };
  try {
    const { rows: orderRows } = await pg.query(
      `SELECT
         COUNT(*)::int AS orders_total,
         COALESCE(SUM(amount_total), 0)::bigint AS revenue_cents,
         COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE)::int AS orders_today,
         COALESCE(SUM(amount_total) FILTER (WHERE created_at::date = CURRENT_DATE), 0)::bigint AS revenue_today_cents,
         COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '7 days')::int AS orders_7d,
         COALESCE(SUM(amount_total) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'), 0)::bigint AS revenue_7d_cents
       FROM orders
       WHERE status NOT IN ('payment_failed', 'refunded')`
    );
    const o = orderRows[0];
    if (o) {
      skynpatchSales = {
        orders_total: Number(o.orders_total || 0),
        revenue_cents: Number(o.revenue_cents || 0),
        orders_today: Number(o.orders_today || 0),
        revenue_today_cents: Number(o.revenue_today_cents || 0),
        orders_7d: Number(o.orders_7d || 0),
        revenue_7d_cents: Number(o.revenue_7d_cents || 0),
      };
      skynpatchSales.revenue_dollars = (skynpatchSales.revenue_cents / 100).toFixed(2);
      skynpatchSales.revenue_today_dollars = (skynpatchSales.revenue_today_cents / 100).toFixed(2);
      skynpatchSales.revenue_7d_dollars = (skynpatchSales.revenue_7d_cents / 100).toFixed(2);
    }
  } catch (e) {
    if (!isPoolClosedError(e)) console.warn("[progress] orders query failed:", e.message);
  }
  out.metrics.skynpatch_sales = skynpatchSales;

  const { rows: creditRows } = await pg.query(
    `SELECT
       (SELECT COUNT(*)::int FROM credit_reports) AS reports,
       (SELECT COUNT(*)::int FROM credit_issues WHERE status='open') AS open_issues,
       (SELECT COUNT(*)::int FROM credit_actions WHERE status IN ('queued','blocked','draft','sent')) AS active_actions`
  );
  out.metrics.credit = creditRows[0] || {};

  const { rows: spendRows } = await pg.query(
    `SELECT
       COALESCE(SUM(cost_usd), 0)::numeric AS total_usd,
       COALESCE(SUM(CASE WHEN provider='openai' THEN cost_usd ELSE 0 END), 0)::numeric AS openai_usd,
       COALESCE(SUM(CASE WHEN provider='deepseek' THEN cost_usd ELSE 0 END), 0)::numeric AS deepseek_usd,
       COALESCE(SUM(CASE WHEN provider='gemini' THEN cost_usd ELSE 0 END), 0)::numeric AS gemini_usd,
       COALESCE(SUM(CASE WHEN provider='anthropic' THEN cost_usd ELSE 0 END), 0)::numeric AS anthropic_usd,
       COALESCE(SUM(CASE WHEN provider='ollama' THEN cost_usd ELSE 0 END), 0)::numeric AS ollama_usd
     FROM model_usage
     WHERE created_at >= date_trunc('day', timezone('UTC', now()))`
  );
  const { rows: spendTopModels } = await pg.query(
    `SELECT model_key, provider, ROUND(COALESCE(SUM(cost_usd),0)::numeric, 6) AS usd
     FROM model_usage
     WHERE created_at >= date_trunc('day', timezone('UTC', now()))
     GROUP BY model_key, provider
     ORDER BY usd DESC
     LIMIT 5`
  );
  out.metrics.daily_spend = {
    ...(spendRows[0] || {}),
    top_models: spendTopModels || [],
  };

  const { rows: brandRows } = await pg.query(
    `SELECT slug, provisioning_status, brand_email, default_from_email, sending_domain
       FROM brands
      WHERE slug IN ('skynpatch','blackwallstreetopoly')
      ORDER BY slug`
  );
  out.metrics.brands = brandRows;

  const pm2List = await parsePm2ListSafe();
  const pm2MetaByName = loadConfiguredAppMeta();
  const activeByName = new Map();
  for (const p of pm2List) {
    const name = String(p.name || "");
    const status = String(p.pm2_env?.status || "unknown");
    const runtimeMeta = annotatePm2Process(p, pm2MetaByName);
    if (!activeByName.has(name)) activeByName.set(name, { name, online: 0, total: 0 });
    const row = activeByName.get(name);
    if (!row.runtime_class) row.runtime_class = runtimeMeta.runtime_class;
    if (!row.cron_restart && runtimeMeta.cron_restart) row.cron_restart = runtimeMeta.cron_restart;
    // Intentionally stopped processes should not count as lane outages.
    // Count only actively managed runtime states toward availability denominator.
    if (status !== "stopped") row.total += 1;
    if (status === "online") row.online += 1;
  }
  const names = Array.from(activeByName.values());
  const runtimeSummary = names.reduce((acc, row) => {
    const key = String(row.runtime_class || "unknown");
    if (!acc[key]) acc[key] = { total: 0, online: 0 };
    acc[key].total += Number(row.total || 0) > 0 ? 1 : 1;
    if (Number(row.online || 0) > 0) acc[key].online += 1;
    return acc;
  }, {});
  const countOnline = (pattern) => names.filter((n) => pattern.test(n.name)).reduce((a, b) => a + b.online, 0);
  const countTotal = (pattern) => names.filter((n) => pattern.test(n.name)).reduce((a, b) => a + b.total, 0);
  out.metrics.agent_runtime = {
    generated_at: new Date().toISOString(),
    runtime_summary: runtimeSummary,
    groups: [
      { type: "api_gateway", online: countOnline(EXTERNAL_CHAT_CHANNELS_ENABLED ? /^claw-(architect-api|gateway|webhook-server|discord-gateway)$/ : /^claw-(architect-api|webhook-server)$/), total: countTotal(EXTERNAL_CHAT_CHANNELS_ENABLED ? /^claw-(architect-api|gateway|webhook-server|discord-gateway)$/ : /^claw-(architect-api|webhook-server)$/) },
      { type: "dispatcher_orchestrator", online: countOnline(/^claw-(dispatcher|backlog-orchestrator)$/), total: countTotal(/^claw-(dispatcher|backlog-orchestrator)$/) },
      { type: "workers_ai", online: countOnline(/^claw-worker-ai$/), total: countTotal(/^claw-worker-ai$/) },
      { type: "workers_nas", online: countOnline(/^claw-worker-nas$/), total: countTotal(/^claw-worker-nas$/) },
      { type: "workers_other", online: countOnline(/^claw-worker$/), total: countTotal(/^claw-worker$/) },
      { type: "lead_autopilot", online: countOnline(/^claw-lead-autopilot/), total: countTotal(/^claw-lead-autopilot/) },
      { type: "qa_autofix", online: countOnline(/^claw-(qa-human-blocking|regression-autofix-pulse|needs-attention-autofix)$/), total: countTotal(/^claw-(qa-human-blocking|regression-autofix-pulse|needs-attention-autofix)$/) },
      { type: "maintenance", online: countOnline(/^claw-(agent-memory-maintenance|system-cleanup|telegram-health|ollama-maintenance)$/), total: countTotal(/^claw-(agent-memory-maintenance|system-cleanup|telegram-health|ollama-maintenance)$/) },
    ],
    processes: names
      .filter((n) => /^claw-/.test(n.name))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };

  const offgrid = getOffgridBridgeStatus();
  out.metrics.offgrid_home = {
    heartbeat: offgrid.heartbeat || null,
    pending_commands: offgrid.counters?.pending_commands || 0,
    recent_events: offgrid.counters?.events_100 || 0,
  };

  const nowIso = new Date().toISOString();
  out.history.timeline = [
    { name: "global_status", at: out.generated_at },
    { name: "repo_scan", at: out.history.repo_scan?.generated_at || null },
    { name: "launch_e2e", at: out.history.launch_e2e?.generated_at || null },
    { name: "qa_human", at: out.history.qa_human?.generated_at || null },
    { name: "agent_memory", at: out.history.agent_memory?.generated_at || null },
    { name: "saas_opportunity", at: out.history.saas_opportunity?.generated_at || null },
    { name: "affiliate_research", at: out.history.affiliate_research?.generated_at || null },
    { name: "symbolic_qa_hub", at: out.history.symbolic_qa_hub?.generated_at || null },
    { name: "daily_feature_rotation", at: out.history.daily_feature_rotation?.generated_at || null },
    { name: "closed_loop_daily", at: out.history.closed_loop_daily?.generated_at || null },
    { name: "knowledge_troll_harvest", at: out.history.knowledge_troll_harvest?.generated_at || null },
    { name: "pattern_robust_builder", at: out.history.pattern_robust_builder?.generated_at || null },
    { name: "production_kpi_flywheel", at: out.history.production_kpi_flywheel?.generated_at || null },
    { name: "forward_progress_enforcer", at: out.history.forward_progress_enforcer?.generated_at || null },
    { name: "agent_streamline_pulse", at: out.history.agent_streamline_pulse?.generated_at || null },
  ].map((t) => ({ ...t, age_min: minutesAgo(t.at), now: nowIso }));

  // Get last 20 orchestrator step runs for history table
  const { rows: stepHistoryRows } = await pg.query(
    `SELECT step_name, status, reason, started_at, finished_at, duration_ms
     FROM orchestrator_step_runs
     WHERE step_name IN ('status_redgreen', 'github_scan', 'launch_e2e_matrix', 'repo_normalize_queue', 'git_sites_pulse', 'flow_regression_pulse', 'regression_autofix_pulse', 'security_sweep', 'ai_work_pulse')
     ORDER BY started_at DESC
     LIMIT 20`
  ).catch(() => ({ rows: [] }));
  
  out.history.step_runs = stepHistoryRows.map((r) => ({
    step_name: r.step_name,
    status: r.status,
    reason: r.reason,
    started_at: r.started_at,
    finished_at: r.finished_at,
    duration_ms: r.duration_ms,
    age_min: minutesAgo(r.finished_at || r.started_at),
  }));

  // FIX H4: use module-level FRESHNESS_SLA constant (removed duplicate inline declaration)
  out.metrics.report_freshness = out.history.timeline.map((t) => {
    const sla = FRESHNESS_SLA[t.name] || null;
    const age = Number(t.age_min);
    let status = "green";
    if (!Number.isFinite(age) || !Number.isFinite(sla)) status = "yellow";
    else if (age > sla * 2) status = "red";
    else if (age > sla) status = "yellow";
    return { name: t.name, age_min: t.age_min, sla_min: sla, status };
  });

  // Completed signals
  if (out.system.status === "GREEN") out.completed.push("Global red/green checks are passing.");
  if ((out.history.repo_scan?.pass_count || 0) > 0 && (out.history.repo_scan?.fail_count || 0) === 0) {
    out.completed.push(`GitHub observability baseline passing (${out.history.repo_scan.pass_count} repos).`);
  }
  if ((out.history.qa_human?.targets || 0) > 0 && (out.history.qa_human?.failed_repos || 0) === 0 && (out.history.qa_human?.high_findings || 0) === 0) {
    out.completed.push(`Human-grade QA pass is clean (${out.history.qa_human.targets} repos).`);
  }
  if ((out.history.agent_memory?.total_agents || 0) > 0 && (out.history.agent_memory?.high_findings || 0) === 0) {
    out.completed.push(`Agent memory system audit clean (${out.history.agent_memory.total_agents} agents).`);
  }
  if ((out.metrics.credit?.reports || 0) > 0) {
    out.completed.push(
      `Credit pipeline loaded (${out.metrics.credit.reports} reports, ${out.metrics.credit.open_issues} open issues).`
    );
  }
  if ((out.metrics.learning_flywheel?.playbooks || 0) > 0) {
    out.completed.push(
      `Learning playbooks active (${out.metrics.learning_flywheel.playbooks} playbooks, ${out.metrics.learning_flywheel.features_indexed} indexed features).`
    );
  }
  if ((out.history.knowledge_troll_harvest?.repos_discovered || 0) > 0 || (out.history.knowledge_troll_harvest?.papers_discovered || 0) > 0) {
    out.completed.push(
      `Knowledge harvest discovered ${out.history.knowledge_troll_harvest.repos_discovered} repos and ${out.history.knowledge_troll_harvest.papers_discovered} papers.`
    );
  }
  if ((out.history.pattern_robust_builder?.playbooks_updated || 0) > 0) {
    out.completed.push(
      `Pattern robustness updated ${out.history.pattern_robust_builder.playbooks_updated} feature playbooks.`
    );
  }
  if ((out.history.daily_feature_rotation?.features_created || 0) > 0) {
    out.completed.push(
      `Daily rotation queued ${out.history.daily_feature_rotation.features_created}/${out.history.daily_feature_rotation.features_queued} feature upgrades.`
    );
  }
  if ((out.history.production_kpi_flywheel?.score || 0) > 0) {
    out.completed.push(
      `Production KPI flywheel score ${out.history.production_kpi_flywheel.score} with ${out.history.production_kpi_flywheel.queued_actions} queued improvement action(s).`
    );
  }
  if ((out.history.forward_progress_enforcer?.queued || 0) > 0) {
    out.completed.push(`Forward progress enforcer queued ${out.history.forward_progress_enforcer.queued} unblock action(s).`);
  }
  if ((out.metrics.media_os?.total_assets || 0) > 0) {
    out.completed.push(
      `Media OS indexed ${out.metrics.media_os.total_assets} asset(s) with ${out.metrics.media_os.metadata_coverage_pct}% metadata coverage.`
    );
  }

  // Needs-attention signals
  for (const b of brandRows) {
    if (b.provisioning_status !== "ready") {
      out.needs_attention.push(
        `${b.slug}: sender provisioning status is '${b.provisioning_status}' (send policy may block).`
      );
    }
    if (!b.brand_email && !b.default_from_email) {
      out.needs_attention.push(`${b.slug}: no brand sender email configured.`);
    }
  }
  const localHour = new Date().getHours();
  const skWithEmail = Number(out.metrics?.leads?.sk_with_email || 0);
  if ((out.metrics.sends?.sk_sends_today || 0) === 0 && skWithEmail > 0 && localHour >= 10) {
    out.needs_attention.push("SkynPatch: no emails sent today.");
  }
  const launchBlocking = Number(out.history.launch_e2e?.blocking_failures || 0);
  const launchTotal = Number(out.history.launch_e2e?.failures || 0);
  const launchNonBlocking = Math.max(0, launchTotal - launchBlocking);
  if (launchBlocking > 0) {
    out.needs_attention.push(
      `Launch E2E has ${launchBlocking} blocking failure(s).`
    );
  }
  if (launchNonBlocking > 0) {
    out.needs_attention.push(
      `Launch E2E has ${launchNonBlocking} non-blocking failure(s).`
    );
  }
  if ((out.history.launch_e2e?.skipped_playwright || 0) > 0) {
    out.needs_attention.push(
      `Launch E2E has ${out.history.launch_e2e.skipped_playwright} target(s) with skipped Playwright checks.`
    );
  }
  if ((out.history.qa_human?.failed_repos || 0) > 0) {
    out.needs_attention.push(
      `Human-grade QA has ${out.history.qa_human.failed_repos} repo(s) with failing commands or high-risk gaps.`
    );
  }
  if ((out.history.qa_human?.high_findings || 0) > 0) {
    out.needs_attention.push(
      `Human-grade QA found ${out.history.qa_human.high_findings} high-priority coverage/findings.`
    );
  }
  if ((out.history.agent_memory?.high_findings || 0) > 0) {
    out.needs_attention.push(
      `Agent-memory audit has ${out.history.agent_memory.high_findings} high finding(s).`
    );
  }
  if ((out.history.schema_audit?.total_issues || 0) > 0) {
    out.needs_attention.push(
      `Schema audit reports ${out.history.schema_audit.total_issues} issue(s).`
    );
  }
  if ((out.history.symbolic_qa_hub?.repos_missing_index || []).length > 0) {
    out.needs_attention.push(
      `Symbolic QA still has ${out.history.symbolic_qa_hub.repos_missing_index.length} repo(s) missing index coverage.`
    );
  }
  if ((out.history.production_kpi_flywheel?.score || 0) > 0 && out.history.production_kpi_flywheel.score < 80) {
    out.needs_attention.push(
      `Production KPI flywheel score is ${out.history.production_kpi_flywheel.score} (<80 target).`
    );
  }
  if ((out.history.agent_streamline_pulse?.duplicate_singleton_candidates || []).length > 0) {
    out.needs_attention.push(
      `Agent streamline pulse found ${out.history.agent_streamline_pulse.duplicate_singleton_candidates.length} duplicate singleton candidate(s).`
    );
  }
  if ((out.metrics.media_os?.total_assets || 0) > 0 && (out.metrics.media_os.metadata_backlog || 0) > 0) {
    out.needs_attention.push(
      `Media pipeline metadata backlog is ${out.metrics.media_os.metadata_backlog} asset(s).`
    );
  }
  if ((out.metrics.media_os?.total_assets || 0) > 0 && (out.metrics.media_os.hash_backlog || 0) > 0) {
    out.needs_attention.push(
      `Media pipeline hash backlog is ${out.metrics.media_os.hash_backlog} asset(s).`
    );
  }
  if ((out.metrics.media_os?.total_assets || 0) > 0 && (out.metrics.media_os.visual_backlog || 0) > 0) {
    out.needs_attention.push(
      `Media visual catalog backlog is ${out.metrics.media_os.visual_backlog} asset(s).`
    );
  }
  if (out.metrics.offgrid_home?.heartbeat && out.metrics.offgrid_home.heartbeat.connected === false) {
    out.needs_attention.push("Off-grid smart-home bridge is offline.");
  }

  out.recommendations = [];
  if (launchTotal > 0) {
    out.recommendations.push("Run `npm run e2e:launch:matrix` and focus fixes on failing targets first.");
  } else {
    out.recommendations.push("Launch matrix is clean. Keep `claw-launch-e2e-matrix` on schedule for drift control.");
  }
  if ((out.history.repo_scan?.fail_count || 0) > 0) {
    out.recommendations.push("Run `npm run github:scan -- --strict-baseline` and queue `repo_autofix` on failing repos.");
  } else {
    out.recommendations.push("Repo scan is passing. Prioritize higher-fidelity human QA on top revenue repos.");
  }
  if ((out.metrics.sends?.sk_sends_today || 0) === 0) {
    out.recommendations.push("Unblock SkynPatch send lane first: sender policy + provisioning + live send check.");
  }
  if ((out.history.affiliate_research?.sites_discovered || 0) === 0) {
    out.recommendations.push("Run `npm run affiliate:research` to generate per-site affiliate rollout plans.");
  } else {
    out.recommendations.push(
      `Affiliate research ready for ${out.history.affiliate_research.sites_discovered} site(s): start rollout with click tracking + ledger schema.`
    );
  }
  if ((out.history.saas_pain_pipeline?.records || 0) === 0) {
    out.recommendations.push("Run `npm run saas:pain:report` to mine Reddit/X pain points for weekly product opportunities.");
  } else {
    out.recommendations.push("SaaS pain pipeline has fresh opportunities. Prioritize top recurring pain points for rapid MVP validation.");
  }
  if ((out.history.symbolic_qa_hub?.repos_missing_index || []).length > 0) {
    out.recommendations.push("Run `npm run qa:symbolic:hub` to keep top external repos indexed and mapped.");
  }
  if ((out.metrics.learning_flywheel?.insights_24h || 0) === 0) {
    out.recommendations.push("Run `npm run pattern:robust:build` to refresh pattern insights and strengthen daily learning output.");
  }
  if ((out.history.daily_feature_rotation?.features_created || 0) === 0) {
    out.recommendations.push("Run `npm run feature:rotation:daily` to queue 1-2 feature upgrades per repo for today.");
  }
  if ((out.history.closed_loop_daily?.chains_targeted || 0) === 0) {
    out.recommendations.push("Run `npm run loop:closed:daily` so progress includes active self-correcting feature chains.");
  }
  if (!out.history.production_kpi_flywheel?.generated_at) {
    out.recommendations.push("Run `npm run kpi:flywheel` to generate production KPI score + auto-queued growth actions.");
  } else if ((out.history.production_kpi_flywheel?.score || 0) < 80) {
    out.recommendations.push("Prioritize production KPI flywheel top gaps and complete queued actions before new feature expansion.");
  }
  if (!out.history.forward_progress_enforcer?.generated_at) {
    out.recommendations.push("Run `npm run progress:enforce` to prevent idle loops and force measurable movement.");
  }
  if ((out.metrics.media_os?.total_assets || 0) > 0 && (
    Number(out.metrics.media_os.metadata_backlog || 0) > 0 ||
    Number(out.metrics.media_os.hash_backlog || 0) > 0 ||
    Number(out.metrics.media_os.visual_backlog || 0) > 0
  )) {
    out.recommendations.push("Run `npm run media:chain -- --limit 2000 --hash-limit 5000 --visual-limit 2000` to close media indexing gaps.");
  }

  out.copy_ui_suggestions = {
    source: "rules_plus_research",
    website_copy: [
      "Make the hero KPI-based: '42 sends today • 0 blocking E2E • 62 repos passing'.",
      "Replace generic status labels with action language: 'What changed in the last 24h'.",
      "Show trend deltas for leads, sends, launch failures, and repo failures.",
    ],
    ux_layout: [
      "Top row: command-center KPIs. Middle: blockers + recommended next actions. Bottom: timeline/history.",
      "Add one-click run buttons next to each lane (`status:redgreen`, `e2e:launch:matrix`, `github:scan`).",
      "Persist last 20 run summaries in a compact history table with age + outcome.",
    ],
    affiliate: {
      sites_discovered: out.history.affiliate_research?.sites_discovered || 0,
      top_open_source: out.history.affiliate_research?.top_candidates || [],
      workflow: "track clicks -> attribute orders -> accrue commission -> payout approval",
    },
    ai_lane: {
      preferred_models: ["qwen2.5:14b", "deepseek-coder:6.7b", "llama3.1:8b"],
      workflow: "research -> copy draft -> critique -> final publish checklist",
    },
    saas_opportunities: out.history.saas_opportunity?.top || [],
    learning_flywheel: {
      features_mapped: out.history.symbolic_qa_hub?.features_mapped || 0,
      playbooks_updated: out.history.pattern_robust_builder?.playbooks_updated || 0,
      repos_discovered: out.history.knowledge_troll_harvest?.repos_discovered || 0,
      papers_discovered: out.history.knowledge_troll_harvest?.papers_discovered || 0,
      insights_24h: out.metrics.learning_flywheel?.insights_24h || 0,
    },
    production_kpi: {
      score: out.history.production_kpi_flywheel?.score || 0,
      queued_actions: out.history.production_kpi_flywheel?.queued_actions || 0,
      top_gap: out.history.production_kpi_flywheel?.gaps?.[0]?.key || null,
    },
  };

  // Backward-compatible top-level fields for legacy /api/progress consumers.
  const statusSummary = summarizeStatus(buildAuditFindings(out));
  out.status_summary = statusSummary;
  out.status = String(statusSummary.overall || "unknown").toUpperCase();
  out.launch_e2e = out.history.launch_e2e || {};
  out.human_qa = out.history.qa_human || {};
  out.activeIssues = buildActiveIssues(out, buildAuditFindings(out));

  // Ensure generated_at is always fresh
  out.generated_at = new Date().toISOString();
  progressCache = out;
  progressCacheAt = Date.now();
  return out;
}

async function getProgressSafe(force = false) {
  try {
    return await buildProgressData(force);
  } catch (err) {
    const msg = String(err?.message || "unknown progress error");
    console.error("[architect-api] progress fallback:", msg);
    if (progressCache) {
      return {
        ...progressCache,
        generated_at: new Date().toISOString(),
        degraded: true,
        degraded_reason: msg,
      };
    }
    return {
      generated_at: new Date().toISOString(),
      degraded: true,
      degraded_reason: msg,
      system: { status: "DEGRADED" },
      history: {},
      metrics: {
        queue: { created: 0, pending: 0, dispatched: 0, running: 0, failed: 0, dead_letter: 0 },
      },
      completed: [],
      needs_attention: [`Dashboard degraded: ${msg}`],
      recommendations: ["Retry in a few seconds. If this persists, inspect Postgres connectivity and pool health."],
      copy_ui_suggestions: { source: "fallback", website_copy: [], ux_layout: [] },
    };
  }
}

async function getDashboardProgressSafe() {
  if (progressCache) return progressCache;
  try {
    return await withTimeout(
      getProgressSafe(),
      DASHBOARD_PROGRESS_TIMEOUT_MS,
      "DASHBOARD_PROGRESS_TIMEOUT",
      "dashboard_progress_timeout"
    );
  } catch (err) {
    return {
      generated_at: new Date().toISOString(),
      degraded: true,
      degraded_reason: String(err?.message || "dashboard_progress_unavailable"),
      metrics: { queue: { created: 0, pending: 0, running: 0, dead_letter: 0 } },
      history: { production_kpi_flywheel: { score: 0, queued_actions: 0 } },
      needs_attention: ["Progress context unavailable; proceeding with bounded local context."],
      recommendations: ["Run `npm run -s status:redgreen` and `npm run -s audit:progress:integrity`."],
    };
  }
}

async function handleGetProgress(req, res) {
  const parsed = url.parse(req.url, true);
  const out = await getProgressSafe(parsed.query?.force === "1");
  return jsonResponse(res, 200, out);
}

function parseWindowDays(rawWindow, fallback = 7) {
  const value = String(rawWindow || `${fallback}d`).trim().toLowerCase();
  const m = value.match(/^(\d{1,3})d$/);
  const days = m ? Number(m[1]) : fallback;
  if (!Number.isFinite(days)) return fallback;
  return Math.min(90, Math.max(1, days));
}

function scoreDescThenDateThenKey(items, keyField, dateField) {
  return [...items].sort((a, b) => {
    const s = Number(b.score || 0) - Number(a.score || 0);
    if (s !== 0) return s;
    const d = new Date(String(b[dateField] || 0)).getTime() - new Date(String(a[dateField] || 0)).getTime();
    if (d !== 0) return d;
    return String(a[keyField] || "").localeCompare(String(b[keyField] || ""));
  });
}

async function buildLearningProgress(windowRaw = "7d") {
  const days = parseWindowDays(windowRaw, 7);
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - days * 24 * 60 * 60 * 1000);
  const windowStartIso = windowStart.toISOString();
  const windowEndIso = windowEnd.toISOString();

  let patternRows = [];
  try {
    const { rows } = await pg.query(
      `SELECT
         feature_key AS id,
         MAX(feature_key) AS title,
         ROUND((AVG(confidence)::numeric + (COUNT(*)::numeric * 3)), 3) AS score,
         COALESCE(SUM(COALESCE(jsonb_array_length(evidence->'top_sources'), 0)), 0)::int AS evidence_count,
         MIN(created_at) AS first_seen_at,
         MAX(created_at) AS last_seen_at
       FROM pattern_insights
       WHERE created_at >= $1::timestamptz
         AND created_at <= $2::timestamptz
       GROUP BY feature_key`,
      [windowStartIso, windowEndIso]
    );
    patternRows = rows || [];
  } catch {
    try {
      const { rows } = await pg.query(
        `SELECT
           insight_type AS id,
           insight_type AS title,
           ROUND((AVG(confidence_score)::numeric * 100 + COUNT(*)::numeric), 3) AS score,
           COUNT(*)::int AS evidence_count,
           MIN(created_at) AS first_seen_at,
           MAX(created_at) AS last_seen_at
         FROM bot_learning_insights
         WHERE created_at >= $1::timestamptz
           AND created_at <= $2::timestamptz
         GROUP BY insight_type`,
        [windowStartIso, windowEndIso]
      );
      patternRows = rows || [];
    } catch {
      patternRows = [];
    }
  }

  const newPatterns = scoreDescThenDateThenKey(
    patternRows.map((r) => ({
      id: String(r.id || ""),
      title: String(r.title || r.id || "")
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
      score: Number(r.score || 0),
      evidenceCount: Number(r.evidence_count || 0),
      firstSeenAt: r.first_seen_at ? new Date(r.first_seen_at).toISOString() : windowStartIso,
      lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : windowEndIso,
    })),
    "id",
    "lastSeenAt"
  );

  let libraryRows = [];
  try {
    const { rows } = await pg.query(
      `SELECT
         ks.source_key,
         COALESCE(NULLIF(ks.title, ''), regexp_replace(ks.source_key, '^(repo:|paper:)', '')) AS name,
         COALESCE(NULLIF(ks.domain, ''), 'general') AS category,
         COALESCE(MAX(ks.score), 0)::numeric AS base_score,
         COUNT(pi.id)::int AS checks_completed,
         COALESCE(MIN(pi.created_at), ks.last_index_attempt_at, ks.created_at) AS first_checked_at,
         COALESCE(MAX(pi.created_at), ks.last_index_attempt_at, ks.updated_at, ks.created_at) AS last_checked_at
       FROM knowledge_sources ks
       LEFT JOIN pattern_insights pi
         ON ks.source_key = ANY(pi.source_keys)
        AND pi.created_at >= $1::timestamptz
        AND pi.created_at <= $2::timestamptz
       WHERE ks.status = 'active'
         AND ks.indexed = TRUE
         AND COALESCE(ks.last_index_attempt_at, ks.updated_at, ks.created_at) >= $1::timestamptz
         AND COALESCE(ks.last_index_attempt_at, ks.updated_at, ks.created_at) <= $2::timestamptz
       GROUP BY ks.source_key, name, category, ks.last_index_attempt_at, ks.updated_at, ks.created_at`,
      [windowStartIso, windowEndIso]
    );
    libraryRows = rows || [];
  } catch {
    libraryRows = [];
  }

  const newLibraries = scoreDescThenDateThenKey(
    libraryRows.map((r) => ({
      name: String(r.name || r.source_key || ""),
      category: String(r.category || "general"),
      score: Number(r.base_score || 0) + Number(r.checks_completed || 0) * 5,
      checksCompleted: Number(r.checks_completed || 0),
      firstCheckedAt: r.first_checked_at ? new Date(r.first_checked_at).toISOString() : windowStartIso,
      lastCheckedAt: r.last_checked_at ? new Date(r.last_checked_at).toISOString() : windowEndIso,
    })),
    "name",
    "lastCheckedAt"
  );

  return {
    newPatterns,
    newLibraries,
    meta: {
      windowStart: windowStartIso,
      windowEnd: windowEndIso,
      generatedAt: new Date().toISOString(),
    },
  };
}

async function handleGetProgressLearning(req, res) {
  const parsed = url.parse(req.url, true);
  const out = await buildLearningProgress(parsed.query?.window || "7d");
  return jsonResponse(res, 200, out);
}

function severityRank(sev) {
  if (sev === "red") return 3;
  if (sev === "yellow") return 2;
  return 1;
}

function summarizeStatus(findings = []) {
  const summary = { green: 0, yellow: 0, red: 0, total: findings.length };
  for (const f of findings) {
    if (!f?.severity || !Object.prototype.hasOwnProperty.call(summary, f.severity)) continue;
    summary[f.severity] += 1;
  }
  const overall = summary.red > 0 ? "red" : summary.yellow > 0 ? "yellow" : "green";
  return { ...summary, overall };
}

function actionForLane(lane) {
  const map = {
    system: "status_redgreen",
    qa: "launch_e2e_fix",
    repos: "repo_scan_continue",
    leadgen: "lead_skynpatch_fix",
    credit: "credit_continue",
    security: "security_fix",
    ops: "workflow_continue",
    research: "saas_pain_report",
    media: "media_os_run",
    learning: "learning_flywheel_refresh",
  };
  return map[lane] || "status_redgreen";
}

function buildAuditFindings(progress) {
  const findings = [];
  const pushFinding = (f) => {
    findings.push({
      id: f.id,
      severity: f.severity || "yellow",
      lane: f.lane || "system",
      title: f.title,
      detail: f.detail || "",
      impact: f.impact || "",
      recommendation: f.recommendation || "",
      command: f.command || "",
      action_id: f.action_id || actionForLane(f.lane || "system"),
    });
  };

  for (const g of progress?.metrics?.agent_runtime?.groups || []) {
    if (Number(g.total || 0) > 0 && Number(g.online || 0) === 0) {
      pushFinding({
        id: `lane-down-${g.type}`,
        severity: "red",
        lane: "system",
        title: `${g.type} is offline`,
        detail: `${g.online}/${g.total} online`,
        impact: "This lane is not processing work.",
        recommendation: "Restart PM2 process group and verify health.",
        command: "pm2 restart <lane-process>",
        action_id: "status_redgreen",
      });
    } else if (Number(g.total || 0) > 0 && Number(g.online || 0) < Number(g.total || 0)) {
      pushFinding({
        id: `lane-degraded-${g.type}`,
        severity: "yellow",
        lane: "system",
        title: `${g.type} degraded`,
        detail: `${g.online}/${g.total} online`,
        impact: "Reduced throughput and lower parallelism.",
        recommendation: "Inspect logs for crashed workers and recover.",
        command: "pm2 logs <lane-process> --lines 120 --nostream",
      });
    }
  }

  const queue = progress?.metrics?.queue || {};
  const backlog = Number(queue.created || 0) + Number(queue.pending || 0);
  if (backlog > 50) {
    pushFinding({
      id: "queue-backlog-high",
      severity: "red",
      lane: "jobs_queue",
      title: "Queue backlog is high",
      detail: `created+pending=${backlog}`,
      impact: "New work can be delayed for long periods.",
      recommendation: "Scale workers and clear blocked tasks.",
      command: "npm run tasks:health",
      action_id: "workflow_continue",
    });
  } else if (backlog > 20) {
    pushFinding({
      id: "queue-backlog-present",
      severity: "yellow",
      lane: "jobs_queue",
      title: "Queue has pending work",
      detail: `created+pending=${backlog}`,
      impact: "Work is queued and waiting for capacity.",
      recommendation: "Monitor worker throughput and dispatch latency.",
      command: "npm run tasks:health",
      action_id: "workflow_continue",
    });
  }
  if (Number(queue.dead_letter || 0) > 0) {
    pushFinding({
      id: "queue-deadletter",
      severity: Number(queue.dead_letter) > 20 ? "red" : "yellow",
      lane: "jobs_queue",
      title: "Dead-letter queue has failed tasks",
      detail: `dead_letter=${queue.dead_letter}`,
      impact: "Some workflows are failing repeatedly.",
      recommendation: "Run DLQ reconcile and root-cause failing payloads.",
      command: "npm run tasks:reconcile-deadletters",
      action_id: "workflow_continue",
    });
  }
  // FIX H5: surface queue.failed as an audit finding (was silently ignored before)
  if (Number(queue.failed || 0) > 0) {
    pushFinding({
      id: "queue-failed-tasks",
      severity: Number(queue.failed) > 10 ? "red" : "yellow",
      lane: "jobs_queue",
      title: `${queue.failed} failed task(s) in queue`,
      detail: `failed=${queue.failed} — tasks exhausted retries`,
      impact: "Failed tasks are not retrying; associated workflows may be stalled.",
      recommendation: "Inspect failed tasks and decide to retry or discard.",
      command: "npm run tasks:health",
      action_id: "workflow_continue",
    });
  }

  const media = progress?.metrics?.media_os || {};
  if (Number(media.total_assets || 0) > 0) {
    if (Number(media.metadata_backlog || 0) > 0) {
      pushFinding({
        id: "media-metadata-backlog",
        severity: Number(media.metadata_backlog || 0) > 2000 ? "red" : "yellow",
        lane: "media",
        title: "Media metadata enrichment is behind",
        detail: `metadata_backlog=${media.metadata_backlog}, coverage=${media.metadata_coverage_pct}%`,
        impact: "Metadata/search quality is reduced for media retrieval and automation.",
        recommendation: "Run deterministic enrich/hash/visual chain on pending media.",
        command: "npm run media:chain -- --limit 2000 --hash-limit 5000 --visual-limit 2000",
        action_id: "media_os_run",
      });
    }
    if (Number(media.hash_backlog || 0) > 0) {
      pushFinding({
        id: "media-hash-backlog",
        severity: Number(media.hash_backlog || 0) > 2000 ? "red" : "yellow",
        lane: "media",
        title: "Media hash coverage is incomplete",
        detail: `hash_backlog=${media.hash_backlog}, coverage=${media.hash_coverage_pct}%`,
        impact: "Near-duplicate grouping and similarity clustering are degraded.",
        recommendation: "Run hash stage to complete dHash/aHash coverage.",
        command: "npm run media:chain -- --limit 2000 --hash-limit 5000 --visual-limit 1",
        action_id: "media_os_run",
      });
    }
    if (Number(media.visual_backlog || 0) > 0) {
      pushFinding({
        id: "media-visual-backlog",
        severity: "yellow",
        lane: "media",
        title: "Media visual catalog coverage is incomplete",
        detail: `visual_backlog=${media.visual_backlog}, coverage=${media.visual_coverage_pct}%`,
        impact: "Semantic media search and scene tagging are partially unavailable.",
        recommendation: "Run media visual catalog stage for recent assets.",
        command: "npm run media:chain -- --limit 500 --visual-limit 2000",
        action_id: "media_os_run",
      });
    }
  }

  const learning = progress?.metrics?.learning_flywheel || {};
  if (Number(learning.playbooks || 0) > 0 && Number(learning.insights_24h || 0) === 0) {
    pushFinding({
      id: "learning-flywheel-idle",
      severity: "yellow",
      lane: "learning",
      title: "Learning flywheel has no new insights in 24h",
      detail: `playbooks=${learning.playbooks}, insights_24h=${learning.insights_24h || 0}`,
      impact: "Dashboard learning lane becomes stale and misses newly learned patterns.",
      recommendation: "Run pattern robustness + feature rotation refresh cycle.",
      command: "npm run pattern:robust:build && npm run feature:rotation:daily",
      action_id: "learning_flywheel_refresh",
    });
  }

  const timeline = progress?.history?.timeline || [];
  // FIX H4: use module-level FRESHNESS_SLA constant (removed duplicate inline declaration)
  for (const t of timeline) {
    const ageMin = Number(t.age_min);
    const sla = FRESHNESS_SLA[t.name];
    if (!Number.isFinite(ageMin) || !Number.isFinite(sla)) continue;
    if (ageMin > sla * 2) {
      pushFinding({
        id: `freshness-red-${t.name}`,
        severity: "red",
        lane: "history",
        title: `${t.name} report is stale`,
        detail: `age=${ageMin}m, sla=${sla}m`,
        impact: "Decisions are based on outdated evidence.",
        recommendation: "Regenerate this report now.",
        command: "Use dashboard action controls",
      });
    } else if (ageMin > sla) {
      pushFinding({
        id: `freshness-yellow-${t.name}`,
        severity: "yellow",
        lane: "history",
        title: `${t.name} report nearing staleness`,
        detail: `age=${ageMin}m, sla=${sla}m`,
        impact: "Signal quality is declining.",
        recommendation: "Run report refresh in this lane.",
        command: "Use dashboard action controls",
      });
    }
  }

  for (const note of progress?.needs_attention || []) {
    const text = String(note || "");
    let lane = "system";
    let command = "npm run status:redgreen";
    let actionId = "status_redgreen";
    if (/SkynPatch|blackwallstreetopoly|sender|emails sent/i.test(text)) {
      lane = "leadgen";
      command = "npm run lead:autopilot";
      actionId = "lead_skynpatch_fix";
    } else if (/Launch E2E|Playwright/i.test(text)) {
      lane = "qa";
      command = "npm run e2e:launch:matrix";
      actionId = "launch_e2e_fix";
    } else if (/repo|QA has|Agent-memory/i.test(text)) {
      lane = "repos";
      command = "npm run github:scan -- --strict-baseline";
      actionId = "repo_scan_continue";
    } else if (/credit/i.test(text)) {
      lane = "credit";
      command = "npm run credit:e2e:live";
      actionId = "credit_continue";
    } else if (/Media pipeline|media visual|media hash|media metadata/i.test(text)) {
      lane = "media";
      command = "npm run media:chain";
      actionId = "media_os_run";
    }
    pushFinding({
      id: `needs-${crypto.createHash("md5").update(text).digest("hex").slice(0, 10)}`,
      severity: /blocking|RED|no emails sent|high finding|dead-letter/i.test(text) ? "red" : "yellow",
      lane,
      title: text,
      detail: "Derived from current Needs Attention feed.",
      impact: "This item blocks throughput or quality in its lane.",
      recommendation: "Run mapped lane action and verify after completion.",
      command,
      action_id: actionId,
    });
  }

  const brands = progress?.metrics?.brands || [];
  for (const b of brands) {
    if (String(b.provisioning_status || "") !== "ready") {
      pushFinding({
        id: `brand-provision-${b.slug}`,
        severity: "red",
        lane: "leadgen",
        title: `${b.slug} provisioning not ready`,
        detail: `status=${b.provisioning_status}`,
        impact: "Outbound email policy may block sends.",
        recommendation: "Set brand provisioning to ready after DNS/sender checks.",
        command: "UPDATE brands SET provisioning_status='ready' WHERE slug='<slug>';",
        action_id: "lead_skynpatch_fix",
      });
    }
  }

  const seen = new Set();
  const deduped = findings.filter((f) => {
    if (!f?.id) return false;
    if (seen.has(f.id)) return false;
    seen.add(f.id);
    return true;
  });

  return deduped.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}

function buildActiveIssues(progress, findings = []) {
  const redFindings = findings.filter((f) => String(f?.severity || "").toLowerCase() === "red");
  const queue = progress?.metrics?.queue || {};
  const launchBlocking = Number(progress?.history?.launch_e2e?.blocking_failures || 0);
  const failingChecks = Number(queue.failed || 0) + Number(queue.dead_letter || 0);
  const regressionDetected = launchBlocking > 0;
  const openIncidents = redFindings.length;
  const shouldShowFix = openIncidents > 0 || failingChecks > 0 || regressionDetected;
  return {
    openIncidents,
    failingChecks,
    regressionDetected,
    shouldShowFix,
    open_incidents: openIncidents,
    failing_checks: failingChecks,
    regression_detected: regressionDetected,
    should_show_fix: shouldShowFix,
  };
}

function buildDashboardEnvelope(tab, progress, findings, payload, actions = []) {
  const activeIssues = payload.active_issues || buildActiveIssues(progress, findings);
  return {
    tab,
    generated_at: new Date().toISOString(),
    status_summary: summarizeStatus(findings),
    cards: payload.cards || [],
    actions,
    findings,
    active_issues: activeIssues,
    data: {
      ...(payload.data || {}),
      active_issues: activeIssues,
    },
  };
}

async function handleDashboardTab(req, res, tabKey) {
  const parsed = url.parse(req.url, true);
  const force = String(parsed.query?.force || "0") === "1";
  if (!force) {
    const cached = getDashboardTabEnvelopeCache(tabKey);
    if (cached) {
      return jsonResponse(res, 200, cached);
    }
  }

  const progress = await getDashboardProgressSafe();
  const findings = buildAuditFindings(progress);
  const queue = progress.metrics?.queue || {};
  const runtime = progress.metrics?.agent_runtime || {};
  const topFindings = findings.slice(0, 20);
  let allActions = [];
  try {
    allActions = await withTimeout(
      getDashboardActionsState(),
      DASHBOARD_PROGRESS_TIMEOUT_MS,
      "DASHBOARD_ACTIONS_TIMEOUT",
      "dashboard_actions_timeout"
    );
  } catch {
    allActions = [];
  }
  const laneActions = (lane) => allActions.filter((a) => a.lane === lane);

  if (tabKey === "overview") {
    const payload = {
      cards: [
        { label: "Global Status", value: progress.system?.status || "unknown" },
        { label: "Open Findings", value: findings.length },
        { label: "Queue Backlog", value: Number(queue.created || 0) + Number(queue.pending || 0) },
        { label: "Running Actions", value: allActions.filter((a) => a.running).length },
        { label: "Media Backlog", value: Number(progress.metrics?.media_os?.metadata_backlog || 0) + Number(progress.metrics?.media_os?.hash_backlog || 0) },
      ],
      data: {
        queue,
        media_os: progress.metrics?.media_os || {},
        learning_flywheel: progress.metrics?.learning_flywheel || {},
        completed: progress.completed || [],
        needs_attention: progress.needs_attention || [],
        recommendations: progress.recommendations || [],
      },
    };
    // For overview, use system status for overall status_summary to match the card
    const systemStatus = (progress.system?.status || "unknown").toLowerCase();
    const systemStatusSummary = {
      green: systemStatus === "green" ? 1 : 0,
      yellow: systemStatus === "yellow" ? 1 : 0,
      red: systemStatus === "red" ? 1 : 0,
      total: 1,
      overall: systemStatus === "red" ? "red" : systemStatus === "yellow" ? "yellow" : "green",
    };
    const envelope = buildDashboardEnvelope("overview", progress, topFindings, payload, allActions);
    envelope.status_summary = systemStatusSummary; // Override with system status
    envelope.metrics = progress.metrics || {};
    envelope.history = progress.history || {};
    setDashboardTabEnvelopeCache(tabKey, envelope);
    return jsonResponse(res, 200, envelope);
  }

  if (tabKey === "systems") {
    const payload = {
      cards: [
        { label: "System Lanes", value: (runtime.groups || []).length },
        { label: "Online Processes", value: (runtime.processes || []).reduce((a, p) => a + Number(p.online || 0), 0) },
        { label: "Total Processes", value: (runtime.processes || []).reduce((a, p) => a + Number(p.total || 0), 0) },
      ],
      data: {
        runtime_groups: runtime.groups || [],
        processes: runtime.processes || [],
      },
    };
    const envelope = buildDashboardEnvelope(
      "systems",
      progress,
      topFindings.filter((f) => f.lane === "system"),
      payload,
      laneActions("system")
    );
    setDashboardTabEnvelopeCache(tabKey, envelope);
    return jsonResponse(res, 200, envelope);
  }

  if (tabKey === "agents") {
    const groups = runtime.groups || [];
    const payload = {
      cards: [
        { label: "Agent Groups", value: groups.length },
        { label: "AI Workers", value: groups.find((g) => g.type === "workers_ai")?.online || 0 },
        { label: "NAS Workers", value: groups.find((g) => g.type === "workers_nas")?.online || 0 },
      ],
      data: {
        groups,
        process_count: (runtime.processes || []).length,
      },
    };
    const agentFindings = topFindings.filter((f) =>
      ["system", "qa", "research", "jobs_queue", "media"].includes(String(f.lane || ""))
    );
    const envelope = buildDashboardEnvelope("agents", progress, agentFindings, payload, allActions);
    setDashboardTabEnvelopeCache(tabKey, envelope);
    return jsonResponse(res, 200, envelope);
  }

  if (tabKey === "jobs" || tabKey === "queue") {
    const payload = {
      cards: [
        { label: "Created", value: queue.created || 0 },
        { label: "Pending", value: queue.pending || 0 },
        { label: "Running", value: queue.running || 0 },
        { label: "Dead Letter", value: queue.dead_letter || 0 },
      ],
      data: {
        queue,
        task_status_7d: progress.metrics?.task_status_7d || [],
        plan_status_7d: progress.metrics?.plan_status_7d || [],
        queue_aging: progress.metrics?.queue_aging || [],
        queue_by_tag: progress.metrics?.queue_by_tag || [],
      },
    };
    const envelope = buildDashboardEnvelope(
      tabKey === "jobs" ? "jobs_queue" : "queue",
      progress,
      topFindings.filter((f) => f.lane === "jobs_queue"),
      payload,
      laneActions("ops")
    );
    setDashboardTabEnvelopeCache(tabKey, envelope);
    return jsonResponse(res, 200, envelope);
  }

  if (tabKey === "leads-credit") {
    const sends = progress.metrics?.sends || {};
    const sales = progress.metrics?.skynpatch_sales || {};
    const payload = {
      cards: [
        { label: "SkynPatch Sends Today", value: sends.sk_sends_today || 0 },
        { label: "SkynPatch Opened Today", value: sends.sk_opened_today || 0 },
        { label: "SkynPatch Clicked Today", value: sends.sk_clicked_today || 0 },
        { label: "BWS Sends Today", value: sends.bws_sends_today || 0 },
        { label: "BWS Opened Today", value: sends.bws_opened_today || 0 },
        { label: "BWS Clicked Today", value: sends.bws_clicked_today || 0 },
        { label: "Skyn Patch Orders (7d)", value: sales.orders_7d ?? sales.orders_total ?? 0 },
        { label: "Skyn Patch Revenue (7d)", value: sales.revenue_7d_dollars ?? sales.revenue_dollars ?? "0.00" },
        { label: "Credit Open Issues", value: progress.metrics?.credit?.open_issues || 0 },
        { label: "Credit Active Actions", value: progress.metrics?.credit?.active_actions || 0 },
      ],
      data: {
        leads: progress.metrics?.leads || {},
        sends,
        skynpatch_sales: sales,
        credit: progress.metrics?.credit || {},
        brands: progress.metrics?.brands || [],
      },
    };
    const envelope = buildDashboardEnvelope(
      "leads_credit",
      progress,
      topFindings.filter((f) => ["leadgen", "credit"].includes(f.lane)),
      payload,
      [...laneActions("leadgen"), ...laneActions("credit")]
    );
    setDashboardTabEnvelopeCache(tabKey, envelope);
    return jsonResponse(res, 200, envelope);
  }

  if (tabKey === "qa-e2e") {
    const launch = progress.history?.launch_e2e || {};
    const qaHuman = progress.history?.qa_human || {};
    const payload = {
      cards: [
        { label: "Launch Failures", value: launch.failures || 0 },
        { label: "Blocking", value: launch.blocking_failures || 0 },
        { label: "Skipped Playwright", value: launch.skipped_playwright || 0 },
        { label: "Human High Findings", value: qaHuman.high_findings || 0 },
      ],
      data: {
        launch,
        qa_human: qaHuman,
        agent_memory: progress.history?.agent_memory || {},
      },
    };
    const envelope = buildDashboardEnvelope(
      "qa_e2e",
      progress,
      topFindings.filter((f) => f.lane === "qa"),
      payload,
      laneActions("qa")
    );
    setDashboardTabEnvelopeCache(tabKey, envelope);
    return jsonResponse(res, 200, envelope);
  }

  if (tabKey === "research-copy") {
    const payload = {
      cards: [
        { label: "Affiliate Sites", value: progress.history?.affiliate_research?.sites_discovered || 0 },
        { label: "SaaS Pain Records", value: progress.history?.saas_pain_pipeline?.records || 0 },
        { label: "Copy Suggestions", value: (progress.copy_ui_suggestions?.website_copy || []).length },
      ],
      data: {
        copy_ui_suggestions: progress.copy_ui_suggestions || {},
        saas_opportunity: progress.history?.saas_opportunity || {},
        saas_pain_pipeline: progress.history?.saas_pain_pipeline || {},
        affiliate_research: progress.history?.affiliate_research || {},
      },
    };
    const envelope = buildDashboardEnvelope(
      "research_copy",
      progress,
      topFindings.filter((f) => ["research", "history"].includes(f.lane)),
      payload,
      [...laneActions("research")]
    );
    setDashboardTabEnvelopeCache(tabKey, envelope);
    return jsonResponse(res, 200, envelope);
  }

  if (tabKey === "bot-payments") {
    // Fetch bot payment data
    let paymentData = {
      total_revenue: 0,
      total_credits_sold: 0,
      total_credits_spent: 0,
      active_credit_balances: 0,
      conversion_rate: 0,
      payment_methods: {},
      recent_transactions: [],
      bot_conversions: [],
      conversion_stats: null,
      funnel_metrics: null,
      revenue_projection: null,
    };
    
    try {
      // Get conversion stats (may return null if DB unavailable)
      let conversionStats = null;
      let funnelMetrics = null;
      let revenueProjection = null;
      try {
        const { getConversionStats, getFunnelMetrics, getRevenueProjection } = require("./bot-conversion-tracker");
        conversionStats = await getConversionStats(30);
        funnelMetrics = await getFunnelMetrics(30);
        revenueProjection = await getRevenueProjection();
      } catch (err) {
        console.warn("[architect-api] Bot conversion tracker unavailable:", err.message);
      }
      
      // Get transaction log
      const fsp = require("fs/promises");
      const path = require("path");
      const txLogPath = path.join(__dirname, "..", "agent-state", "commerce", "transactions.jsonl");
      let recentTransactions = [];
      try {
        const txLog = await fsp.readFile(txLogPath, "utf8");
        const lines = txLog.trim().split("\n").filter(Boolean);
        recentTransactions = lines.slice(-20).map(line => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        }).filter(Boolean).reverse();
      } catch {
        // No transaction log yet
      }
      
      // Get credit balances
      const creditsDir = path.join(__dirname, "..", "agent-state", "commerce", "credits");
      let totalCreditsSold = 0;
      let totalCreditsSpent = 0;
      let activeBalances = 0;
      try {
        const creditFiles = await fsp.readdir(creditsDir);
        for (const file of creditFiles) {
          if (file.endsWith(".json")) {
            try {
              const credits = JSON.parse(await fsp.readFile(path.join(creditsDir, file), "utf8"));
              totalCreditsSold += credits.purchased || 0;
              totalCreditsSpent += credits.spent || 0;
              if ((credits.balance || 0) > 0) {
                activeBalances += credits.balance;
              }
            } catch {
              // Skip invalid files
            }
          }
        }
      } catch {
        // Credits directory doesn't exist yet
      }
      
      // Get payment methods breakdown
      const paymentMethods = {};
      for (const tx of recentTransactions) {
        const method = tx.payment_method_type || tx.currency || "unknown";
        paymentMethods[method] = (paymentMethods[method] || 0) + (tx.amount_usd || 0);
      }
      
      // Get bot conversions from database
      let botConversions = [];
      try {
        const { Pool } = require("pg");
        const pg = new Pool({
          host: process.env.POSTGRES_HOST || process.env.CLAW_DB_HOST || "192.168.1.164",
          port: parseInt(process.env.POSTGRES_PORT || process.env.CLAW_DB_PORT || "15432", 10),
          user: process.env.POSTGRES_USER || process.env.CLAW_DB_USER || "claw",
          password: process.env.POSTGRES_PASSWORD || process.env.CLAW_DB_PASSWORD,
          database: process.env.POSTGRES_DB || process.env.CLAW_DB_NAME || "claw_architect",
        });
        
        const convResult = await pg.query(`
          SELECT bot_id, platform, value, converted_at, metadata
          FROM bot_conversions
          ORDER BY converted_at DESC
          LIMIT 20
        `);
        botConversions = convResult.rows;
        await pg.end();
      } catch (err) {
        // Table might not exist or DB unavailable
        console.warn("[architect-api] Bot conversions query failed:", err.message);
      }
      
      // Calculate total revenue from transactions
      const totalRevenue = recentTransactions
        .filter(tx => tx.status === "paid")
        .reduce((sum, tx) => sum + (parseFloat(tx.amount_usd) || 0), 0);
      
      paymentData = {
        total_revenue: totalRevenue,
        total_credits_sold: totalCreditsSold,
        total_credits_spent: totalCreditsSpent,
        active_credit_balances: activeBalances,
        conversion_rate: parseFloat(funnelMetrics?.overall_conversion || 0),
        payment_methods: paymentMethods,
        recent_transactions: recentTransactions.slice(0, 10),
        bot_conversions: botConversions,
        conversion_stats: conversionStats,
        funnel_metrics: funnelMetrics,
        revenue_projection: revenueProjection,
      };
    } catch (err) {
      console.error("[architect-api] Bot payments data fetch failed:", err.message);
      // Continue with empty/default data rather than failing
    }
    
    const payload = {
      cards: [
        { label: "Total Revenue", value: `$${paymentData.total_revenue.toFixed(2)}` },
        { label: "Credits Sold", value: paymentData.total_credits_sold },
        { label: "Credits Spent", value: paymentData.total_credits_spent },
        { label: "Active Balances", value: paymentData.active_credit_balances },
        { label: "Conversion Rate", value: `${paymentData.conversion_rate.toFixed(1)}%` },
      ],
      data: paymentData,
    };
    
    const envelope = buildDashboardEnvelope(
      "bot_payments",
      progress,
      topFindings.filter((f) => f.lane === "system"),
      payload,
      []
    );
    setDashboardTabEnvelopeCache(tabKey, envelope);
    return jsonResponse(res, 200, envelope);
  }

  if (tabKey === "reports") {
    let inventory;
    try {
      inventory = await withTimeout(
        buildReportsInventory(),
        DASHBOARD_PROGRESS_TIMEOUT_MS,
        "DASHBOARD_REPORTS_TIMEOUT",
        "dashboard_reports_timeout"
      );
    } catch (err) {
      if (err?.code && !isPoolClosedError(err)) {
        // Non-pool errors (including timeout) degrade to static report inventory for fast dashboard response.
      }
      const defs = listReportDefinitions();
      const reports = defs.map((def) => ({
        id: def.id,
        name: def.name,
        lane: def.lane,
        last_generated_at: null,
        age_min: null,
        freshness_status: "yellow",
        artifact_path: null,
        last_result: null,
        stale_severity: def.staleSeverity,
        cadence_minutes: def.cadenceMinutes,
        stale_after_minutes: def.staleAfterMinutes,
        refresh_command: def.refreshCommand,
        refresh_task_type: def.refreshTaskType,
        queue_route: def.queueRoute,
        required_tags: def.requiredTags,
        running_refresh: false,
      }));
      inventory = {
        reports,
        summary: {
          total_reports: reports.length,
          green: 0,
          yellow: reports.length,
          red: 0,
          running_refreshes: 0,
        },
      };
    }
    const payload = {
      cards: [
        { label: "Total Reports", value: inventory.summary.total_reports },
        { label: "Freshness Green", value: inventory.summary.green },
        { label: "Freshness Yellow", value: inventory.summary.yellow },
        { label: "Freshness Red", value: inventory.summary.red },
        { label: "Running Refreshes", value: inventory.summary.running_refreshes },
      ],
      data: {
        reports: inventory.reports,
        summary: inventory.summary,
      },
    };
    const envelope = buildDashboardEnvelope(
      "reports",
      progress,
      topFindings.filter((f) => ["history", "qa", "repos", "research", "system"].includes(f.lane)),
      payload,
      allActions
    );
    // Override status_summary with reports summary (includes overall status)
    envelope.status_summary = {
      overall: inventory.summary.overall || "unknown",
      green: inventory.summary.green || 0,
      yellow: inventory.summary.yellow || 0,
      red: inventory.summary.red || 0,
      total: inventory.summary.total_reports || 0,
    };
    setDashboardTabEnvelopeCache(tabKey, envelope);
    return jsonResponse(res, 200, envelope);
  }

  if (tabKey === "history") {
    const timelineCount = (progress.history?.timeline || []).length;
    const payload = {
      cards: [
        { label: "Timeline Events", value: timelineCount },
        { label: "Recent Plans", value: (progress.history?.recent_plans || []).length },
        { label: "Report Sources", value: timelineCount },
      ],
      data: {
        timeline: progress.history?.timeline || [],
        recent_plans: progress.history?.recent_plans || [],
        repo_scan: progress.history?.repo_scan || {},
        launch_e2e: progress.history?.launch_e2e || {},
        qa_human: progress.history?.qa_human || {},
        agent_memory: progress.history?.agent_memory || {},
        symbolic_qa_hub: progress.history?.symbolic_qa_hub || {},
        daily_feature_rotation: progress.history?.daily_feature_rotation || {},
        closed_loop_daily: progress.history?.closed_loop_daily || {},
        knowledge_troll_harvest: progress.history?.knowledge_troll_harvest || {},
        pattern_robust_builder: progress.history?.pattern_robust_builder || {},
        production_kpi_flywheel: progress.history?.production_kpi_flywheel || {},
        forward_progress_enforcer: progress.history?.forward_progress_enforcer || {},
        agent_streamline_pulse: progress.history?.agent_streamline_pulse || {},
        learning_flywheel: progress.metrics?.learning_flywheel || {},
        report_freshness: progress.metrics?.report_freshness || [],
      },
    };
    const envelope = buildDashboardEnvelope(
      "history",
      progress,
      topFindings.filter((f) => f.lane === "history"),
      payload,
      allActions
    );
    setDashboardTabEnvelopeCache(tabKey, envelope);
    return jsonResponse(res, 200, envelope);
  }

  return jsonResponse(res, 404, { error: "unknown_dashboard_tab" });
}

async function handleDashboard(req, res) {
  const dashboardPath = path.join(__dirname, "../dashboard/index.html");
  try {
    const html = fs.readFileSync(dashboardPath, "utf8");
    res.writeHead(200, {
      "Content-Type": "text/html",
      "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0",
    });
    res.end(html);
  } catch (err) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Dashboard not found");
  }
}

async function handleLocalAlternativesDashboard(req, res) {
  const dashboardPath = path.join(__dirname, "../dashboard/local-alternatives.html");
  try {
    const html = fs.readFileSync(dashboardPath, "utf8");
    res.writeHead(200, {
      "Content-Type": "text/html",
      "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0",
    });
    res.end(html);
  } catch (err) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Local alternatives dashboard not found");
  }
}

async function handleOffgridHomeDashboard(req, res) {
  const dashboardPath = path.join(__dirname, "../dashboard/offgrid-home.html");
  try {
    const html = fs.readFileSync(dashboardPath, "utf8");
    res.writeHead(200, {
      "Content-Type": "text/html",
      "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0",
    });
    res.end(html);
  } catch (err) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Off-grid home dashboard not found");
  }
}

async function handleWorkshopOpenclawDashboard(req, res) {
  const dashboardPath = path.join(__dirname, "../dashboard/workshop-openclaw.html");
  try {
    const html = fs.readFileSync(dashboardPath, "utf8");
    res.writeHead(200, {
      "Content-Type": "text/html",
      "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0",
    });
    res.end(html);
  } catch (err) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Workshop page not found");
  }
}

async function handleOpenclawCreatorStudioDashboard(req, res) {
  const dashboardPath = path.join(__dirname, "../dashboard/openclaw-creator-studio.html");
  try {
    const html = fs.readFileSync(dashboardPath, "utf8");
    res.writeHead(200, {
      "Content-Type": "text/html",
      "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0",
    });
    res.end(html);
  } catch (err) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("OpenClaw creator studio page not found");
  }
}

async function handleOpsDashboard(req, res) {
  const dashboardPath = path.join(__dirname, "../dashboard/ops.html");
  try {
    const html = fs.readFileSync(dashboardPath, "utf8");
    res.writeHead(200, {
      "Content-Type": "text/html",
      "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0",
    });
    res.end(html);
  } catch (err) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Ops dashboard not found");
  }
}

async function handleMediaHubDashboard(req, res) {
  const dashboardPath = path.join(__dirname, "../dashboard/media-hub.html");
  try {
    const html = fs.readFileSync(dashboardPath, "utf8");
    res.writeHead(200, {
      "Content-Type": "text/html",
      "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0",
    });
    res.end(html);
  } catch (err) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Media Hub dashboard not found");
  }
}

async function handleMasterpieceDashboard(req, res) {
  const dashboardPath = path.join(__dirname, "../dashboard/masterpiece.html");
  try {
    const html = fs.readFileSync(dashboardPath, "utf8");
    res.writeHead(200, {
      "Content-Type": "text/html",
      "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0",
    });
    res.end(html);
  } catch (err) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Masterpiece dashboard not found");
  }
}

async function handleRequirementExpansionProofDashboard(req, res) {
  const dashboardPath = path.join(__dirname, "../dashboard/requirement-expansion-proof.html");
  try {
    const html = fs.readFileSync(dashboardPath, "utf8");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    res.end(html);
  } catch (err) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Requirement expansion proof dashboard not found");
  }
}

async function handleAICCDashboard(req, res) {
  const dashboardPath = path.join(__dirname, "../dashboard/aicc-content-creator.html");
  try {
    const html = fs.readFileSync(dashboardPath, "utf8");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0",
    });
    res.end(html);
  } catch (err) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("AICC content creator dashboard not found");
  }
}

function parseJsonObjectFromText(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i) || raw.match(/```([\s\S]*?)```/);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]);
    } catch {}
  }
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(raw.slice(first, last + 1));
    } catch {}
  }
  return null;
}

function normalizeHashtag(tag) {
  const t = String(tag || "").trim().replace(/\s+/g, "");
  if (!t) return null;
  return t.startsWith("#") ? t : `#${t}`;
}

function clipText(value, maxLen) {
  return String(value || "").trim().slice(0, Math.max(0, Number(maxLen) || 0));
}

function mediaHubCaptureTypeSql(fi = "fi", mvc = "mvc", mm = "mm") {
  return `
    CASE
      WHEN LOWER(COALESCE(${fi}.ext, '')) IN ('raw','dng','cr2','cr3','nef','arw','raf','rw2','orf','pef','srw','iiq','3fr')
        THEN 'raw_photo'
      WHEN COALESCE(${mvc}.scene_type, '') = 'screenshot'
        OR LOWER(COALESCE(${fi}.path, '')) LIKE '%/screenshots/%'
        OR LOWER(COALESCE(${fi}.path, '')) LIKE '%/screenshot/%'
        OR LOWER(COALESCE(${fi}.name, '')) LIKE '%screenshot%'
        OR EXISTS (
          SELECT 1
          FROM unnest(COALESCE(${mvc}.visual_labels, '{}'::text[])) AS lbl
          WHERE LOWER(lbl) IN ('screenshot', 'ui', 'screen')
        )
        OR EXISTS (
          SELECT 1
          FROM unnest(COALESCE(${mvc}.location_signals, '{}'::text[])) AS sig
          WHERE LOWER(sig) IN ('screenshots', 'screen_recordings')
        )
        THEN 'screenshot'
      WHEN COALESCE(${mvc}.scene_type, '') = 'document'
        OR EXISTS (
          SELECT 1
          FROM unnest(COALESCE(${mvc}.visual_labels, '{}'::text[])) AS lbl
          WHERE LOWER(lbl) IN ('document', 'receipt', 'invoice', 'menu')
        )
        THEN 'document'
      WHEN COALESCE(${mvc}.scene_type, '') = 'design_asset'
        OR EXISTS (
          SELECT 1
          FROM unnest(COALESCE(${mvc}.visual_labels, '{}'::text[])) AS lbl
          WHERE LOWER(lbl) IN ('logo', 'branding', 'marketing_asset')
        )
        THEN 'design_asset'
      WHEN COALESCE(NULLIF(TRIM(${mm}.camera_make), ''), NULLIF(TRIM(${mm}.camera_model), '')) IS NOT NULL
        OR LOWER(COALESCE(${fi}.path, '')) LIKE '%/dcim/%'
        OR LOWER(COALESCE(${fi}.path, '')) LIKE '%/camera/%'
        OR EXISTS (
          SELECT 1
          FROM unnest(COALESCE(${mvc}.location_signals, '{}'::text[])) AS sig
          WHERE LOWER(sig) IN ('camera_roll', 'photos', 'photo_shoot')
        )
        THEN 'camera_photo'
      WHEN COALESCE(${mvc}.scene_type, '') IN ('photo', 'product', 'portrait', 'lifestyle')
        THEN 'photo'
      ELSE 'unknown'
    END
  `;
}

function normalizeMediaHubFilters(query = {}) {
  const limit = Math.max(1, Math.min(300, Number(query.limit || 48) || 48));
  const offset = Math.max(0, Math.min(100000, Number(query.offset || 0) || 0));
  const minMegapixels = Math.max(0, Math.min(500, Number(query.min_megapixels || 0) || 0));
  const minWidth = Math.max(0, Math.min(30000, Number(query.min_width || 0) || 0));
  const minHeight = Math.max(0, Math.min(30000, Number(query.min_height || 0) || 0));
  const mediaClass = String(query.media_class || "").trim().toLowerCase();
  const cameraOnly = ["1", "true", "yes", "on"].includes(String(query.camera_only || "").trim().toLowerCase());
  const allowedSort = new Set([
    "recent",
    "oldest",
    "largest_file",
    "largest_resolution",
    "highest_visual_confidence",
    "review_priority",
  ]);
  const sortBy = String(query.sort_by || "recent").trim().toLowerCase();
  const dedupeMode = String(query.dedupe_mode || "collapse").trim().toLowerCase();
  const allowedDedupeModes = new Set(["collapse", "all", "duplicates_only"]);
  return {
    limit,
    offset,
    brand: String(query.brand || "").trim(),
    hostname: String(query.hostname || "").trim(),
    reviewStatus: String(query.review_status || "").trim(),
    sceneType: String(query.scene_type || "").trim(),
    orientation: String(query.orientation || "").trim(),
    mediaClass,
    minMegapixels,
    minWidth,
    minHeight,
    cameraOnly,
    sortBy: allowedSort.has(sortBy) ? sortBy : "recent",
    dedupeMode: allowedDedupeModes.has(dedupeMode) ? dedupeMode : "collapse",
    q: String(query.q || "").trim(),
  };
}

async function queryMediaHubAssets(filters = {}) {
  const f = normalizeMediaHubFilters(filters);
  const where = [`fi.category = 'image'`];
  const postWhere = [];
  const params = [];
  const add = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (f.brand) where.push(`fi.brand = ${add(f.brand)}`);
  if (f.hostname) where.push(`fi.hostname = ${add(f.hostname)}`);
  if (f.reviewStatus) where.push(`COALESCE(fi.review_status, 'pending') = ${add(f.reviewStatus)}`);
  if (f.sceneType) where.push(`COALESCE(mvc.scene_type, '') ILIKE ${add(`%${f.sceneType}%`)}`);
  if (f.orientation) where.push(`COALESCE(mvc.orientation, '') = ${add(f.orientation)}`);
  if (f.mediaClass === "screenshot") postWhere.push(`base.capture_type = 'screenshot'`);
  if (f.mediaClass === "non_screenshot") postWhere.push(`base.capture_type <> 'screenshot'`);
  if (f.mediaClass === "real_photo") postWhere.push(`base.capture_type IN ('camera_photo', 'photo', 'raw_photo')`);
  if (f.mediaClass === "raw_photo") postWhere.push(`base.capture_type = 'raw_photo'`);
  if (f.mediaClass === "document") postWhere.push(`base.capture_type = 'document'`);
  if (f.mediaClass === "design_asset") postWhere.push(`base.capture_type = 'design_asset'`);
  if (f.minMegapixels > 0) postWhere.push(`COALESCE(base.width, 0) * COALESCE(base.height, 0) >= ${add(Math.round(f.minMegapixels * 1_000_000))}`);
  if (f.minWidth > 0) postWhere.push(`COALESCE(base.width, 0) >= ${add(f.minWidth)}`);
  if (f.minHeight > 0) postWhere.push(`COALESCE(base.height, 0) >= ${add(f.minHeight)}`);
  if (f.cameraOnly) postWhere.push(`COALESCE(NULLIF(TRIM(base.camera_make), ''), NULLIF(TRIM(base.camera_model), '')) IS NOT NULL`);
  if (f.dedupeMode === "collapse") postWhere.push(`base.duplicate_rank = 1`);
  if (f.dedupeMode === "duplicates_only") postWhere.push(`base.duplicate_count > 1`);
  if (f.q) {
    const qv = `%${f.q}%`;
    postWhere.push(`(
      base.path ILIKE ${add(qv)}
      OR base.name ILIKE ${add(qv)}
      OR COALESCE(base.visual_summary, '') ILIKE ${add(qv)}
      OR EXISTS (
        SELECT 1 FROM unnest(COALESCE(base.visual_labels, '{}'::text[])) AS lbl
        WHERE lbl ILIKE ${add(qv)}
      )
      OR COALESCE(base.primary_subject, '') ILIKE ${add(qv)}
      OR COALESCE(base.capture_type, '') ILIKE ${add(qv)}
      OR COALESCE(base.product_match_title, '') ILIKE ${add(qv)}
      OR COALESCE(base.product_match_handle, '') ILIKE ${add(qv)}
      OR COALESCE(base.level2_visual_type, '') ILIKE ${add(qv)}
      OR COALESCE(base.level3_commerce_type, '') ILIKE ${add(qv)}
    )`);
  }

  const sortSql =
    f.sortBy === "oldest"
      ? "COALESCE(base.mtime, base.indexed_at) ASC"
      : f.sortBy === "largest_file"
        ? "COALESCE(base.size_bytes, 0) DESC, COALESCE(base.mtime, base.indexed_at) DESC"
        : f.sortBy === "largest_resolution"
          ? "COALESCE(base.width, 0) * COALESCE(base.height, 0) DESC, COALESCE(base.size_bytes, 0) DESC"
          : f.sortBy === "highest_visual_confidence"
            ? "COALESCE(base.visual_confidence, 0) DESC, COALESCE(base.mtime, base.indexed_at) DESC"
            : f.sortBy === "review_priority"
              ? `CASE COALESCE(base.review_status, 'pending')
                   WHEN 'pending' THEN 0
                   WHEN 'needs_edit' THEN 1
                   WHEN 'rejected' THEN 2
                   WHEN 'approved' THEN 3
                   ELSE 4
                 END ASC,
                 COALESCE(base.visual_confidence, 0) DESC,
                 COALESCE(base.mtime, base.indexed_at) DESC`
              : "COALESCE(base.mtime, base.indexed_at) DESC";

  params.push(f.limit, f.offset);
  const sql = `
    WITH base AS (
      SELECT
        fi.id,
        fi.path,
        fi.name,
        fi.hostname,
        fi.brand,
        fi.ext,
        fi.mime,
        fi.size_bytes,
        fi.mtime,
        fi.indexed_at,
        fi.review_status,
        fi.category_confidence,
        fi.sub_category,
        fi.semantic_tags,
        fi.sha256,
        mvc.scene_type,
        mvc.primary_subject,
        mvc.visual_summary,
        mvc.visual_labels,
        mvc.dominant_color_hex,
        mvc.orientation,
        mvc.confidence AS visual_confidence,
        mvc.analysis_json->'product_match'->>'title' AS product_match_title,
        mvc.analysis_json->'product_match'->>'handle' AS product_match_handle,
        mvc.analysis_json->'product_match'->>'source' AS product_match_source,
        mvc.analysis_json->'rule_levels'->>'level1_capture' AS level1_capture,
        mvc.analysis_json->'rule_levels'->>'level2_visual_type' AS level2_visual_type,
        mvc.analysis_json->'rule_levels'->>'level3_commerce_type' AS level3_commerce_type,
        mm.width,
        mm.height,
        mm.camera_make,
        mm.camera_model,
        mh.dhash_hex,
        mh.ahash_hex,
        ROUND((COALESCE(mm.width, 0)::numeric * COALESCE(mm.height, 0)::numeric) / 1000000.0, 2) AS megapixels,
        ${mediaHubCaptureTypeSql("fi", "mvc", "mm")} AS capture_type,
        CASE
          WHEN COALESCE(fi.sha256, '') <> '' THEN 'sha:' || fi.sha256
          WHEN COALESCE(mh.dhash_hex, '') <> '' THEN 'dh:' || mh.dhash_hex
          WHEN COALESCE(mh.ahash_hex, '') <> '' THEN 'ah:' || mh.ahash_hex
          ELSE 'id:' || fi.id::text
        END AS dedupe_key
      FROM file_index fi
      LEFT JOIN media_visual_catalog mvc ON mvc.file_index_id = fi.id
      LEFT JOIN media_metadata mm ON mm.file_index_id = fi.id
      LEFT JOIN media_hashes mh ON mh.file_index_id = fi.id
      WHERE ${where.join(" AND ")}
    ),
    ranked AS (
      SELECT
        base0.*,
        COUNT(*) OVER (PARTITION BY base0.dedupe_key) AS duplicate_count,
        ROW_NUMBER() OVER (
          PARTITION BY base0.dedupe_key
          ORDER BY
            CASE COALESCE(base0.review_status, 'pending')
              WHEN 'approved' THEN 0
              WHEN 'pending' THEN 1
              WHEN 'needs_edit' THEN 2
              ELSE 3
            END ASC,
            COALESCE(base0.width, 0) * COALESCE(base0.height, 0) DESC,
            COALESCE(base0.size_bytes, 0) DESC,
            COALESCE(base0.mtime, base0.indexed_at) DESC,
            base0.id ASC
        ) AS duplicate_rank
      FROM base base0
    )
    SELECT *
    FROM ranked base
    ${postWhere.length ? `WHERE ${postWhere.join(" AND ")}` : ""}
    ORDER BY ${sortSql}
    LIMIT $${params.length - 1}
    OFFSET $${params.length}
  `;
  const rows = (await pg.query(sql, params)).rows || [];
  return { rows, filters: f };
}

async function getMediaHubDuplicateState(fileIndexId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(fileIndexId || ""))) return null;
  const { rows } = await pg.query(
    `
      WITH target AS (
        SELECT
          fi.id,
          fi.sha256,
          mh.dhash_hex,
          mh.ahash_hex
        FROM file_index fi
        LEFT JOIN media_hashes mh ON mh.file_index_id = fi.id
        WHERE fi.id = $1::uuid
          AND fi.category = 'image'
        LIMIT 1
      ),
      key_target AS (
        SELECT
          id,
          CASE
            WHEN COALESCE(sha256, '') <> '' THEN 'sha:' || sha256
            WHEN COALESCE(dhash_hex, '') <> '' THEN 'dh:' || dhash_hex
            WHEN COALESCE(ahash_hex, '') <> '' THEN 'ah:' || ahash_hex
            ELSE 'id:' || id::text
          END AS dedupe_key
        FROM target
      ),
      grouped AS (
        SELECT
          fi.id AS file_index_id,
          COUNT(*) OVER () AS duplicate_count,
          ROW_NUMBER() OVER (
            ORDER BY
              CASE COALESCE(fi.review_status, 'pending')
                WHEN 'approved' THEN 0
                WHEN 'pending' THEN 1
                WHEN 'needs_edit' THEN 2
                ELSE 3
              END ASC,
              COALESCE(mm.width, 0) * COALESCE(mm.height, 0) DESC,
              COALESCE(fi.size_bytes, 0) DESC,
              COALESCE(fi.mtime, fi.indexed_at) DESC,
              fi.id ASC
          ) AS duplicate_rank
        FROM file_index fi
        LEFT JOIN media_hashes mh ON mh.file_index_id = fi.id
        LEFT JOIN media_metadata mm ON mm.file_index_id = fi.id
        JOIN key_target kt
          ON (
            CASE
              WHEN COALESCE(fi.sha256, '') <> '' THEN 'sha:' || fi.sha256
              WHEN COALESCE(mh.dhash_hex, '') <> '' THEN 'dh:' || mh.dhash_hex
              WHEN COALESCE(mh.ahash_hex, '') <> '' THEN 'ah:' || mh.ahash_hex
              ELSE 'id:' || fi.id::text
            END
          ) = kt.dedupe_key
        WHERE fi.category = 'image'
      ),
      first_row AS (
        SELECT file_index_id AS canonical_file_index_id
        FROM grouped
        WHERE duplicate_rank = 1
        LIMIT 1
      )
      SELECT
        g.file_index_id,
        g.duplicate_count,
        g.duplicate_rank,
        f.canonical_file_index_id
      FROM grouped g
      CROSS JOIN first_row f
      WHERE g.file_index_id = $1::uuid
      LIMIT 1
    `,
    [fileIndexId]
  );
  return rows?.[0] || null;
}

async function ensurePinterestPublishQueueTable() {
  await pg.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`).catch(() => {});
  await pg.query(`
    CREATE TABLE IF NOT EXISTS pinterest_publish_queue (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      file_index_id uuid NOT NULL,
      brand_slug text NULL,
      pinterest_account text NOT NULL,
      board_name text NOT NULL,
      pin_title text NULL,
      pin_description text NULL,
      destination_url text NULL,
      hashtags text[] NOT NULL DEFAULT '{}'::text[],
      caption_variants jsonb NOT NULL DEFAULT '[]'::jsonb,
      status text NOT NULL DEFAULT 'draft',
      created_by text NULL,
      scheduled_for timestamptz NULL,
      review_notes text NULL,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await pg.query(`
    CREATE INDEX IF NOT EXISTS idx_pinterest_publish_queue_status_created_at
      ON pinterest_publish_queue (status, created_at DESC)
  `);
  await pg.query(`
    CREATE INDEX IF NOT EXISTS idx_pinterest_publish_queue_account_board
      ON pinterest_publish_queue (pinterest_account, board_name)
  `);
  await pg.query(`
    CREATE INDEX IF NOT EXISTS idx_pinterest_publish_queue_file_index
      ON pinterest_publish_queue (file_index_id)
  `);
}

function scorePinterestCaption(caption = {}, context = {}) {
  const title = String(caption.title || "").trim();
  const description = String(caption.description || "").trim();
  const hashtags = Array.isArray(caption.hashtags) ? caption.hashtags : [];
  const destinationUrl = String(context.destination_url || "").trim();
  const objective = String(context.objective || "drive_traffic");

  let score = 100;
  const reasons = [];
  if (!title) {
    score -= 25;
    reasons.push("missing_title");
  } else {
    if (title.length > 100) {
      score -= 20;
      reasons.push("title_over_100");
    }
    if (title.length < 25) {
      score -= 8;
      reasons.push("title_too_short");
    }
  }

  if (!description) {
    score -= 30;
    reasons.push("missing_description");
  } else {
    if (description.length > 500) {
      score -= 25;
      reasons.push("description_over_500");
    }
    if (description.length < 80) {
      score -= 12;
      reasons.push("description_too_short");
    }
    if (!/(shop|buy|discover|save|tap|learn|order|explore|book|get)/i.test(description)) {
      score -= 8;
      reasons.push("missing_clear_cta");
    }
  }

  if (objective === "drive_traffic" && destinationUrl && !description.includes(destinationUrl)) {
    score -= 6;
    reasons.push("missing_destination_url_in_description");
  }

  if (hashtags.length < 3) {
    score -= 7;
    reasons.push("low_hashtag_count");
  }
  if (hashtags.length > 12) {
    score -= 6;
    reasons.push("hashtag_overuse");
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    reasons,
  };
}

function deterministicCaptionFromAsset(asset, opts = {}) {
  const brand = opts.brand_slug || asset.brand || "your brand";
  const subject = asset.primary_subject || asset.scene_type || asset.name || "new drop";
  const style = asset.sub_category || asset.scene_type || "";
  const color = asset.dominant_color_hex || "";
  const audience = opts.target_audience || "buyers";
  const title = clipText(`${subject} ${style}`.replace(/\s+/g, " ").trim() + ` | ${brand}`, 100);
  const destinationUrl = opts.destination_url || "";
  const labels = Array.isArray(asset.visual_labels) ? asset.visual_labels : [];
  const semanticTags = Array.isArray(asset.semantic_tags) ? asset.semantic_tags : [];
  const hashtags = Array.from(
    new Set([brand, ...labels.slice(0, 8), ...semanticTags.slice(0, 4)].map(normalizeHashtag).filter(Boolean))
  ).slice(0, 12);
  const benefit = asset.visual_summary || `Built for ${audience} who want a cleaner, more useful result.`;
  const description = clipText(
    `From ${brand}: ${subject}. ${benefit} ${style ? `Style: ${style}. ` : ""}${color ? `Color cue: ${color}. ` : ""}` +
      `Save this pin, then use the link to view details and pricing.` +
      (destinationUrl ? `\n\nShop now: ${destinationUrl}` : ""),
    500
  );
  const altBase = clipText(`${brand} ${subject}. ${benefit}`, 300);
  return { title, description, hashtags, alt_descriptions: [altBase] };
}

async function generateMediaCaption(asset, opts = {}) {
  const fallback = deterministicCaptionFromAsset(asset, opts);
  const systemPrompt =
    "You write high-performing Pinterest captions for ecommerce and brand growth. Return strict JSON only.";
  const userPrompt = JSON.stringify(
    {
      task: "Generate Pinterest copy for manual-first posting. Keep compliant and non-spammy.",
      output_schema: {
        title: "string <= 100 chars",
        description: "string <= 500 chars, CTA and benefit-focused",
        hashtags: ["#tag1", "#tag2"],
        alt_descriptions: ["string", "string"],
      },
      asset: {
        name: asset.name,
        brand: opts.brand_slug || asset.brand || null,
        path: asset.path,
        scene_type: asset.scene_type,
        primary_subject: asset.primary_subject,
        visual_labels: asset.visual_labels || [],
        visual_summary: asset.visual_summary,
        dominant_color_hex: asset.dominant_color_hex,
      },
      context: {
        objective: opts.objective || "drive_traffic",
        tone: opts.tone || "confident",
        target_audience: opts.target_audience || "buyers",
        destination_url: opts.destination_url || null,
      },
      constraints: [
        "Return strict JSON only, no markdown.",
        "Avoid unverifiable claims.",
        "Use 4-10 concise hashtags.",
      ],
    },
    null,
    2
  );

  try {
    const result = await withTimeout(
      routedChat("_default", systemPrompt, userPrompt, {
        max_tokens: 420,
        temperature: 0.35,
        cacheable: false,
        timeout_ms: 45000,
      }),
      DASHBOARD_CHAT_TIMEOUT_MS,
      "MEDIA_CAPTION_TIMEOUT",
      "media_caption_timeout"
    );
    const parsed = parseJsonObjectFromText(result?.text || "");
    if (parsed && typeof parsed === "object") {
      const normalized = {
        title: clipText(parsed.title || fallback.title, 100),
        description: clipText(parsed.description || fallback.description, 500),
        hashtags: Array.from(
          new Set(
            (Array.isArray(parsed.hashtags) ? parsed.hashtags : fallback.hashtags)
              .map(normalizeHashtag)
              .filter(Boolean)
          )
        ).slice(0, 12),
        alt_descriptions: Array.isArray(parsed.alt_descriptions)
          ? parsed.alt_descriptions.map((x) => clipText(x, 300)).filter(Boolean).slice(0, 3)
          : [],
      };
      const quality = scorePinterestCaption(normalized, opts);
      return {
        ...normalized,
        quality_score: quality.score,
        quality_reasons: quality.reasons,
        provider: result?.provider || null,
        model_key: result?.model_key || null,
      };
    }
  } catch {}

  try {
    const local = await withTimeout(
      runLocalAiPrompt({
        prompt: `System:\n${systemPrompt}\n\nUser:\n${userPrompt}`,
        maxTokens: 420,
        timeoutMs: DASHBOARD_FALLBACK_TIMEOUT_MS,
        temperature: 0.35,
      }),
      DASHBOARD_FALLBACK_TIMEOUT_MS,
      "MEDIA_CAPTION_LOCAL_TIMEOUT",
      "media_caption_local_timeout"
    );
    const parsed = parseJsonObjectFromText(local?.output || "");
    if (parsed && typeof parsed === "object") {
      const normalized = {
        title: clipText(parsed.title || fallback.title, 100),
        description: clipText(parsed.description || fallback.description, 500),
        hashtags: Array.from(
          new Set(
            (Array.isArray(parsed.hashtags) ? parsed.hashtags : fallback.hashtags)
              .map(normalizeHashtag)
              .filter(Boolean)
          )
        ).slice(0, 12),
        alt_descriptions: Array.isArray(parsed.alt_descriptions)
          ? parsed.alt_descriptions.map((x) => clipText(x, 300)).filter(Boolean).slice(0, 3)
          : [],
      };
      const quality = scorePinterestCaption(normalized, opts);
      return {
        ...normalized,
        quality_score: quality.score,
        quality_reasons: quality.reasons,
        provider: "ollama",
        model_key: local?.model || "ollama_fallback",
      };
    }
  } catch {}

  const quality = scorePinterestCaption(fallback, opts);
  return {
    title: clipText(fallback.title, 100),
    description: clipText(fallback.description, 500),
    hashtags: Array.from(new Set((fallback.hashtags || []).map(normalizeHashtag).filter(Boolean))).slice(0, 12),
    alt_descriptions: (fallback.alt_descriptions || []).map((x) => clipText(x, 300)).filter(Boolean).slice(0, 3),
    quality_score: quality.score,
    quality_reasons: quality.reasons,
    provider: "deterministic_fallback",
    model_key: null,
  };
}

function contentTypeForImage(filePath, mimeHint) {
  if (mimeHint && /^image\//i.test(String(mimeHint))) return mimeHint;
  const ext = String(path.extname(filePath || "") || "").toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".bmp") return "image/bmp";
  if (ext === ".avif") return "image/avif";
  return "application/octet-stream";
}

// ── Main request handler ──────────────────────────────────────

async function onRequest(req, res) {
  const parsed = url.parse(req.url, true);
  const rawPathname = parsed.pathname || "/";
  const pathname = rawPathname.length > 1 ? rawPathname.replace(/\/+$/, "") : rawPathname;
  const method = req.method || "GET";

  const reqOrigin = String(req.headers.origin || "");
  const defaultOrigin = ALLOWED_ORIGINS[0] || "";
  const allowOrigin = ALLOW_ANY_ORIGIN
    ? (reqOrigin || "*")
    : (reqOrigin && ALLOWED_ORIGINS.includes(reqOrigin) ? reqOrigin : defaultOrigin);
  if (allowOrigin) res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  if (!ALLOW_ANY_ORIGIN && reqOrigin && !ALLOWED_ORIGINS.includes(reqOrigin) && pathname.startsWith("/api/")) {
    return jsonResponse(res, 403, { error: "origin_not_allowed" });
  }
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.writeHead(204);
    res.end();
    return;
  }

  const r = route(method, pathname);
  const planId = r.param("plan_id");
  const action = r.param("action");

  if (pathname === "/health") {
    return handleHealth(req, res);
  }
  if (pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === "/" || pathname === "/index.html" || pathname === "/dashboard" || pathname === "/progress") {
    return handleDashboard(req, res);
  }
  if (pathname === "/local-alternatives" || pathname === "/local-alternatives.html") {
    return handleLocalAlternativesDashboard(req, res);
  }
  if (pathname === "/offgrid-home" || pathname === "/offgrid-home.html") {
    return handleOffgridHomeDashboard(req, res);
  }
  if (pathname === "/workshop-openclaw" || pathname === "/workshop-openclaw.html") {
    return handleWorkshopOpenclawDashboard(req, res);
  }
  if (pathname === "/openclaw-creator-studio" || pathname === "/openclaw-creator-studio.html") {
    return handleOpenclawCreatorStudioDashboard(req, res);
  }
  if (pathname === "/ops" || pathname === "/ops.html") {
    return handleOpsDashboard(req, res);
  }
  if (pathname === "/media-hub" || pathname === "/media-hub.html") {
    return handleMediaHubDashboard(req, res);
  }
  if (pathname === "/masterpiece" || pathname === "/masterpiece.html" || pathname === "/masterpiece-builder") {
    return handleMasterpieceDashboard(req, res);
  }
  if (pathname === "/requirement-expansion-proof" || pathname === "/requirement-expansion-proof.html") {
    return handleRequirementExpansionProofDashboard(req, res);
  }
  if (pathname === "/aicc" || pathname === "/aicc-creator" || pathname === "/aicc-content-creator" || pathname === "/aicc-content-creator.html") {
    return handleAICCDashboard(req, res);
  }

  if (pathname.startsWith("/api/")) {
    const queryApiKey = parsed.query?.api_key;
    if (!checkAuth(req, queryApiKey)) {
      return jsonResponse(res, 401, { error: "Unauthorized — invalid or missing ARCHITECT_API_KEY" });
    }

    if (method === "GET" && pathname === "/api/dashboard/stream") {
      return startDashboardEventStream(req, res);
    }

    if (method === "GET" && pathname === "/api/media-hub/summary") {
      const { rows } = await pg.query(
        `WITH classified AS (
           SELECT
             fi.id,
             COALESCE(fi.review_status, 'pending') AS review_status,
             CASE
               WHEN COALESCE(fi.sha256, '') <> '' THEN 'sha:' || fi.sha256
               WHEN COALESCE(mh.dhash_hex, '') <> '' THEN 'dh:' || mh.dhash_hex
               WHEN COALESCE(mh.ahash_hex, '') <> '' THEN 'ah:' || mh.ahash_hex
               ELSE 'id:' || fi.id::text
             END AS dedupe_key,
             CASE
               WHEN COALESCE(mvc.analysis_json->'product_match'->>'handle', '') <> '' THEN 1
               ELSE 0
             END AS product_matched,
             CASE
               WHEN COALESCE(mvc.analysis_json->'rule_levels'->>'level3_commerce_type', '') <> '' THEN 1
               ELSE 0
             END AS level3_categorized,
             ${mediaHubCaptureTypeSql("fi", "mvc", "mm")} AS capture_type
           FROM file_index fi
           LEFT JOIN media_visual_catalog mvc ON mvc.file_index_id = fi.id
           LEFT JOIN media_metadata mm ON mm.file_index_id = fi.id
           LEFT JOIN media_hashes mh ON mh.file_index_id = fi.id
           WHERE fi.category = 'image'
         ),
         grouped AS (
           SELECT dedupe_key, COUNT(*)::int AS c
           FROM classified
           GROUP BY dedupe_key
         )
         SELECT
           COUNT(*)::int AS total_images,
           (SELECT COUNT(*)::int FROM media_visual_catalog) AS visual_cataloged,
           COUNT(*) FILTER (WHERE review_status = 'pending')::int AS review_pending,
           COUNT(*) FILTER (WHERE review_status = 'approved')::int AS review_approved,
           COUNT(*) FILTER (WHERE capture_type = 'screenshot')::int AS screenshot_images,
           COUNT(*) FILTER (WHERE capture_type IN ('camera_photo', 'photo', 'raw_photo'))::int AS real_photo_images,
           COUNT(*) FILTER (WHERE capture_type = 'raw_photo')::int AS raw_photo_images,
           COUNT(*) FILTER (WHERE product_matched = 1)::int AS product_matched_images,
           COUNT(*) FILTER (WHERE level3_categorized = 1)::int AS level3_categorized_images,
           COALESCE((SELECT COUNT(*)::int FROM grouped WHERE c > 1), 0) AS duplicate_groups,
           COALESCE((SELECT COALESCE(SUM(c - 1), 0)::int FROM grouped WHERE c > 1), 0) AS duplicate_extra_images
         FROM classified`
      );
      let queueCounts = { queue_total: 0, queue_draft: 0, queue_approved: 0, queue_posted: 0 };
      try {
        const q = await pg.query(
          `SELECT
             COUNT(*)::int AS queue_total,
             COUNT(*) FILTER (WHERE status = 'draft')::int AS queue_draft,
             COUNT(*) FILTER (WHERE status = 'approved')::int AS queue_approved,
             COUNT(*) FILTER (WHERE status = 'posted')::int AS queue_posted
           FROM pinterest_publish_queue`
        );
        queueCounts = q.rows?.[0] || queueCounts;
      } catch {}
      return jsonResponse(res, 200, {
        generated_at: new Date().toISOString(),
        summary: { ...(rows?.[0] || {}), ...queueCounts },
      });
    }

    if (method === "GET" && pathname === "/api/dashboard/requirement-expansion-proof") {
      const proofPath = path.join(REPORTS_DIR, "requirement-expansion-proof-latest.json");
      const data = readJsonSafe(proofPath) || {
        generated_at: null,
        goal: null,
        appType: "default",
        proof: {
          ok: false,
          missingCritical: [],
          missingImportant: [],
          assumptionRiskScore: 0,
          qualityScore: 0,
          completenessScore: 0,
          repairsSuggested: [],
          followUpQuestions: [],
          accepted: false,
          sectionScores: {},
          passResults: [],
        },
      };
      return jsonResponse(res, 200, data);
    }

    if (method === "POST" && pathname === "/api/dashboard/requirement-expansion-proof/run") {
      const ROOT = path.join(__dirname, "..");
      const scriptPath = path.join(ROOT, "scripts", "requirement-expansion-pass.js");
      const proofPath = path.join(REPORTS_DIR, "requirement-expansion-proof-latest.json");
      let body = {};
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch (_) {}
      const goal = body.goal || "";
      const appType = body.appType || "default";
      const result = spawnSync("node", [scriptPath, "--goal", goal, "--app-type", appType, "--out", proofPath], {
        cwd: ROOT,
        encoding: "utf8",
        env: process.env,
        timeout: 60000,
      });
      const data = readJsonSafe(proofPath) || {
        generated_at: new Date().toISOString(),
        goal,
        appType,
        proof: { ok: false, missingCritical: [], missingImportant: [], assumptionRiskScore: 0, qualityScore: 0, completenessScore: 0, repairsSuggested: [], followUpQuestions: [], accepted: false, sectionScores: {}, passResults: [] },
        run: { ok: result.status === 0, code: result.status, stderr: (result.stderr || "").slice(0, 500) },
      };
      if (data.run === undefined) data.run = { ok: result.status === 0, code: result.status, stderr: (result.stderr || "").slice(0, 500) };
      return jsonResponse(res, 200, data);
    }

    // ── AICC Content Creator Pipeline ──────────────────────────────────────────
    if (method === "GET" && pathname === "/api/aicc/pipeline") {
      function readReport(name) {
        try {
          const p = path.join(REPORTS_DIR, name);
          return JSON.parse(fs.readFileSync(p, "utf8"));
        } catch { return null; }
      }
      const autopilot  = readReport("autopilot-last-run.json") || {};
      const campaign   = readReport("aicc-campaign-latest.json") || {};
      const abResults  = readReport("aicc-ab-results-latest.json") || {};
      const promoted   = readReport("aicc-promoted-variant-latest.json") || {};
      const tts        = readReport("tts-manifest-latest.json") || {};
      const broll      = readReport("broll-manifest-latest.json") || {};
      const clips      = readReport("clip-manifest-latest.json") || {};
      const avatars    = readReport("avatar-manifest-latest.json") || {};
      const carousels  = readReport("carousel-manifest-latest.json") || {};
      const repurpose  = readReport("content-repurpose-latest.json") || {};
      const lps        = readReport("lp-manifest-latest.json") || {};
      const trend      = readReport("trend-trigger-latest.json") || {};
      // Hook library lives in data/
      let hookLib = {};
      try {
        const hookPath = path.join(ROOT, "data", "hook-library.json");
        hookLib = JSON.parse(fs.readFileSync(hookPath, "utf8"));
      } catch {}
      const countOk  = (manifest, field = "ok")  => (Array.isArray(manifest.variants) ? manifest.variants.filter(v => v[field] !== false).length : (manifest.generated || 0));
      const countFail = (manifest, field = "ok") => (Array.isArray(manifest.variants) ? manifest.variants.filter(v => v[field] === false).length : (manifest.failed || 0));
      return jsonResponse(res, 200, {
        autopilot: {
          ran_at:        autopilot.ran_at || null,
          ended_at:      autopilot.ended_at || null,
          steps_ok:      autopilot.steps_ok || 0,
          steps_failed:  autopilot.steps_failed || 0,
          steps_skipped: autopilot.steps_skipped || 0,
          steps:         autopilot.steps || [],
        },
        campaign: {
          topic:    campaign.topic || null,
          niche:    campaign.niche || null,
          variants: (campaign.variants || []).map(v => ({
            id:       v.id,
            hook:     v.hook || v.hook_text || "",
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
        tts:       { generated: countOk(tts),      failed: countFail(tts) },
        broll:     { generated: countOk(broll),     failed: countFail(broll) },
        clips:     { assembled: countOk(clips),     failed: countFail(clips) },
        avatars:   { generated: countOk(avatars),   failed: countFail(avatars) },
        carousels: { generated: countOk(carousels), failed: countFail(carousels) },
        repurpose: { processed: countOk(repurpose), failed: countFail(repurpose) },
        lps:       { generated: countOk(lps),       failed: countFail(lps) },
        trend_trigger: {
          topic:        trend.topic || null,
          niche:        trend.niche || null,
          score:        trend.score || null,
          triggered_at: trend.triggered_at || null,
        },
        hook_library: {
          total:      hookLib.total || (hookLib.hooks ? hookLib.hooks.length : 0),
          categories: hookLib.hooks
            ? hookLib.hooks.reduce((acc, h) => { acc[h.category] = (acc[h.category] || 0) + 1; return acc; }, {})
            : {},
        },
      });
    }

    if (method === "POST" && pathname === "/api/aicc/run") {
      const autopilotScript = path.join(ROOT, "scripts", "content-creator-autopilot.js");
      if (!fs.existsSync(autopilotScript)) {
        return jsonResponse(res, 404, { error: "autopilot_script_not_found" });
      }
      const result = spawnSync("node", [autopilotScript], {
        cwd: ROOT,
        encoding: "utf8",
        env: process.env,
        timeout: 600000, // 10 min max
      });
      return jsonResponse(res, 200, {
        ok:      result.status === 0,
        code:    result.status,
        stdout:  (result.stdout || "").slice(-2000),
        stderr:  (result.stderr || "").slice(-1000),
        ran_at:  new Date().toISOString(),
      });
    }
    // ── End AICC ───────────────────────────────────────────────────────────────

    if (method === "GET" && pathname === "/api/masterpiece/summary") {
      const scout = readJsonSafe(path.join(__dirname, "..", "scripts", "reports", "dashboard-chatbot-repo-scout-latest.json")) || {};
      const builder = readJsonSafe(path.join(__dirname, "..", "scripts", "reports", "masterpiece-builder-agent-latest.json")) || {};

      const { rows: qRows } = await pg.query(
        `SELECT status, COUNT(*)::int AS count
           FROM tasks
          WHERE type IN ('repo_index_autopatch', 'opencode_controller')
            AND created_at >= NOW() - INTERVAL '7 days'
          GROUP BY status`
      ).catch(() => ({ rows: [] }));

      const queueByStatus = Object.fromEntries(qRows.map((r) => [String(r.status || "unknown"), Number(r.count || 0)]));

      return jsonResponse(res, 200, {
        ok: true,
        generated_at: new Date().toISOString(),
        scout: {
          generated_at: scout.generated_at || null,
          candidates_total: Number(scout.candidates_total || 0),
          applied: Number(scout?.apply?.applied || 0),
          top_repos: (Array.isArray(scout.top_selected) ? scout.top_selected : []).slice(0, 8).map((r) => ({
            repo: r.full_name || r.name || "unknown",
            score: Number(r.rank_score || 0),
            stars: Number(r.stars || 0),
          })),
        },
        builder: {
          generated_at: builder.generated_at || null,
          repos_selected: Array.isArray(builder.repos_selected) ? builder.repos_selected.length : 0,
          queued_created: Number(builder.queued_created || 0),
          queue_repos: (Array.isArray(builder.queue_results) ? builder.queue_results : []).slice(0, 10).map((r) => ({
            repo: r.repo,
            index_created: Boolean(r?.index?.created),
            build_created: Boolean(r?.opencode?.created),
          })),
        },
        queue: queueByStatus,
      });
    }

    if (method === "GET" && pathname === "/api/media-hub/assets") {
      const { rows, filters } = await queryMediaHubAssets(parsed.query || {});
      return jsonResponse(res, 200, {
        generated_at: new Date().toISOString(),
        limit: filters.limit,
        offset: filters.offset,
        assets: rows,
      });
    }

    const mediaImageMatch = pathname.match(/^\/api\/media-hub\/assets\/([0-9a-f-]{36})\/image$/i);
    if (method === "GET" && mediaImageMatch) {
      const fileIndexId = mediaImageMatch[1];
      const { rows } = await pg.query(
        `SELECT id, path, mime, category
           FROM file_index
          WHERE id = $1
          LIMIT 1`,
        [fileIndexId]
      );
      const row = rows?.[0];
      if (!row || row.category !== "image") {
        return jsonResponse(res, 404, { error: "image_not_found" });
      }
      if (!fs.existsSync(row.path)) {
        return jsonResponse(res, 404, { error: "image_file_missing", path: row.path });
      }
      const stat = fs.statSync(row.path);
      res.writeHead(200, {
        "Content-Type": contentTypeForImage(row.path, row.mime),
        "Content-Length": stat.size,
        "Cache-Control": "private, max-age=300",
      });
      fs.createReadStream(row.path).pipe(res);
      return;
    }

    const mediaReviewMatch = pathname.match(/^\/api\/media-hub\/assets\/([0-9a-f-]{36})\/review$/i);
    if (method === "POST" && mediaReviewMatch) {
      const fileIndexId = mediaReviewMatch[1];
      const body = await parseBody(req);
      const next = String(body.review_status || "").trim().toLowerCase();
      const allowed = new Set(["pending", "approved", "needs_edit", "rejected"]);
      if (!allowed.has(next)) {
        return jsonResponse(res, 400, { error: "invalid_review_status" });
      }
      const r = await pg.query(
        `UPDATE file_index
            SET review_status = $2
          WHERE id = $1
        RETURNING id, review_status`,
        [fileIndexId, next]
      );
      if (!r.rows.length) return jsonResponse(res, 404, { error: "asset_not_found" });
      return jsonResponse(res, 200, { ok: true, asset: r.rows[0] });
    }

    if (method === "POST" && pathname === "/api/media-hub/caption/generate") {
      const body = await parseBody(req);
      const fileIndexId = String(body.file_index_id || "").trim();
      if (!fileIndexId) return jsonResponse(res, 400, { error: "file_index_id_required" });
      const { rows } = await pg.query(
        `SELECT
           fi.id, fi.path, fi.name, fi.brand, fi.hostname,
           mvc.scene_type, mvc.primary_subject, mvc.visual_summary, mvc.visual_labels, mvc.dominant_color_hex
         FROM file_index fi
         LEFT JOIN media_visual_catalog mvc ON mvc.file_index_id = fi.id
         WHERE fi.id = $1 AND fi.category = 'image'
         LIMIT 1`,
        [fileIndexId]
      );
      const asset = rows?.[0];
      if (!asset) return jsonResponse(res, 404, { error: "asset_not_found" });
      const caption = await generateMediaCaption(asset, {
        brand_slug: body.brand_slug,
        objective: body.objective,
        tone: body.tone,
        target_audience: body.target_audience,
        destination_url: body.destination_url,
      });
      return jsonResponse(res, 200, {
        generated_at: new Date().toISOString(),
        file_index_id: fileIndexId,
        caption,
      });
    }

    if (method === "POST" && pathname === "/api/media-hub/caption/generate-batch") {
      const body = await parseBody(req);
      const objective = body.objective;
      const tone = body.tone;
      const targetAudience = body.target_audience;
      const destinationUrl = body.destination_url;
      const maxAssets = Math.max(1, Math.min(80, Number(body.max_assets || 24) || 24));
      const concurrency = Math.max(1, Math.min(8, Number(body.concurrency || 4) || 4));
      const ids = Array.isArray(body.file_index_ids)
        ? body.file_index_ids
            .map((v) => String(v || "").trim())
            .filter((v) => /^[0-9a-f-]{36}$/i.test(v))
            .slice(0, maxAssets)
        : [];

      let assets = [];
      if (ids.length) {
        const { rows } = await pg.query(
          `SELECT
             fi.id, fi.path, fi.name, fi.brand, fi.hostname, fi.sub_category, fi.semantic_tags,
             mvc.scene_type, mvc.primary_subject, mvc.visual_summary, mvc.visual_labels, mvc.dominant_color_hex
           FROM file_index fi
           LEFT JOIN media_visual_catalog mvc ON mvc.file_index_id = fi.id
           WHERE fi.category = 'image' AND fi.id = ANY($1::uuid[])
           ORDER BY COALESCE(mvc.updated_at, fi.indexed_at) DESC`,
          [ids]
        );
        assets = rows || [];
      } else {
        const { rows } = await queryMediaHubAssets({
          ...body,
          limit: body.limit || maxAssets,
          offset: body.offset || 0,
        });
        assets = rows.slice(0, maxAssets);
      }

      const out = [];
      let cursor = 0;
      const workers = Array.from({ length: Math.min(concurrency, assets.length || 0) }, async () => {
        while (true) {
          const idx = cursor;
          cursor += 1;
          if (idx >= assets.length) break;
          const asset = assets[idx];
          try {
            const caption = await generateMediaCaption(asset, {
              brand_slug: body.brand_slug || asset.brand || null,
              objective,
              tone,
              target_audience: targetAudience,
              destination_url: destinationUrl,
            });
            out[idx] = {
              file_index_id: asset.id,
              asset: {
                id: asset.id,
                name: asset.name,
                brand: asset.brand,
                scene_type: asset.scene_type,
                primary_subject: asset.primary_subject,
                dominant_color_hex: asset.dominant_color_hex,
              },
              caption,
            };
          } catch (err) {
            out[idx] = {
              file_index_id: asset.id,
              error: err.message,
            };
          }
        }
      });
      await Promise.all(workers);

      return jsonResponse(res, 200, {
        generated_at: new Date().toISOString(),
        total_requested: assets.length,
        concurrency_used: Math.min(concurrency, assets.length || 0),
        captions: out,
      });
    }

    if (method === "GET" && pathname === "/api/media-hub/queue") {
      const limit = Math.max(1, Math.min(200, Number(parsed.query.limit || 80) || 80));
      const status = String(parsed.query.status || "").trim();
      const account = String(parsed.query.pinterest_account || "").trim();
      const where = [];
      const params = [];
      const add = (v) => {
        params.push(v);
        return `$${params.length}`;
      };
      if (status) where.push(`q.status = ${add(status)}`);
      if (account) where.push(`q.pinterest_account = ${add(account)}`);
      params.push(limit);
      const sql = `
        SELECT
          q.*,
          fi.name AS file_name,
          fi.path AS file_path,
          fi.brand AS file_brand
        FROM pinterest_publish_queue q
        LEFT JOIN file_index fi ON fi.id = q.file_index_id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY q.created_at DESC
        LIMIT $${params.length}
      `;
      try {
        await ensurePinterestPublishQueueTable();
        const rows = (await pg.query(sql, params)).rows || [];
        return jsonResponse(res, 200, {
          generated_at: new Date().toISOString(),
          queue: rows,
        });
      } catch (err) {
        return jsonResponse(res, 503, { error: "queue_table_missing_or_unavailable", detail: err.message });
      }
    }

    if (method === "POST" && pathname === "/api/media-hub/queue") {
      const body = await parseBody(req);
      const required = ["file_index_id", "pinterest_account", "board_name"];
      for (const key of required) {
        if (!String(body[key] || "").trim()) {
          return jsonResponse(res, 400, { error: `${key}_required` });
        }
      }
      const hashtags = Array.isArray(body.hashtags)
        ? body.hashtags.map(normalizeHashtag).filter(Boolean).slice(0, 20)
        : [];
      const captionVariants = Array.isArray(body.caption_variants) ? body.caption_variants.slice(0, 8) : [];
      const canonicalOnly = body.canonical_only !== false;
      try {
        if (canonicalOnly) {
          const dup = await getMediaHubDuplicateState(body.file_index_id);
          if (!dup) return jsonResponse(res, 404, { error: "asset_not_found" });
          if (Number(dup.duplicate_rank || 0) !== 1) {
            return jsonResponse(res, 409, {
              error: "non_canonical_duplicate_blocked",
              canonical_only: true,
              file_index_id: body.file_index_id,
              canonical_file_index_id: dup.canonical_file_index_id || null,
              duplicate_rank: Number(dup.duplicate_rank || 0),
              duplicate_count: Number(dup.duplicate_count || 0),
            });
          }
        }
        await ensurePinterestPublishQueueTable();
        const { rows } = await pg.query(
          `INSERT INTO pinterest_publish_queue (
             file_index_id, brand_slug, pinterest_account, board_name,
             pin_title, pin_description, destination_url, hashtags,
             caption_variants, status, created_by, scheduled_for, review_notes
           ) VALUES (
             $1, $2, $3, $4,
             $5, $6, $7, $8::text[],
             $9::jsonb, COALESCE($10, 'draft'), $11, $12, $13
           )
           RETURNING *`,
          [
            body.file_index_id,
            body.brand_slug || null,
            body.pinterest_account,
            body.board_name,
            body.pin_title || null,
            body.pin_description || null,
            body.destination_url || null,
            hashtags,
            JSON.stringify(captionVariants),
            body.status || "draft",
            body.created_by || "media_hub",
            body.scheduled_for || null,
            body.review_notes || null,
          ]
        );
        return jsonResponse(res, 201, { ok: true, queued: rows?.[0] || null });
      } catch (err) {
        return jsonResponse(res, 503, { error: "queue_insert_failed", detail: err.message });
      }
    }

    if (method === "POST" && pathname === "/api/media-hub/queue/auto-from-filters") {
      const body = await parseBody(req);
      const required = ["pinterest_account", "board_name"];
      for (const key of required) {
        if (!String(body[key] || "").trim()) {
          return jsonResponse(res, 400, { error: `${key}_required` });
        }
      }

      const dryRun = body.dry_run === true;
      const maxAssets = Math.max(1, Math.min(300, Number(body.max_assets || body.limit || 80) || 80));
      const useAi = body.use_ai === true;
      const canonicalOnly = body.canonical_only !== false;
      const ids = Array.isArray(body.file_index_ids)
        ? body.file_index_ids
            .map((v) => String(v || "").trim())
            .filter((v) => /^[0-9a-f-]{36}$/i.test(v))
            .slice(0, maxAssets)
        : [];
      let assets = [];
      if (ids.length) {
        const { rows } = await pg.query(
          `SELECT
             fi.id, fi.path, fi.name, fi.brand, fi.hostname, fi.sub_category, fi.semantic_tags,
             mvc.scene_type, mvc.primary_subject, mvc.visual_summary, mvc.visual_labels, mvc.dominant_color_hex
           FROM file_index fi
           LEFT JOIN media_visual_catalog mvc ON mvc.file_index_id = fi.id
           WHERE fi.category = 'image' AND fi.id = ANY($1::uuid[])
           ORDER BY COALESCE(mvc.updated_at, fi.indexed_at) DESC`,
          [ids]
        );
        assets = (rows || []).slice(0, maxAssets);
      } else {
        const { rows } = await queryMediaHubAssets({
          ...body,
          dedupe_mode: canonicalOnly ? "collapse" : (body.dedupe_mode || "collapse"),
          limit: maxAssets,
          offset: body.offset || 0,
          review_status: body.review_status || "approved",
        });
        assets = rows.slice(0, maxAssets);
      }

      const result = {
        dry_run: dryRun,
        inspected: assets.length,
        created: 0,
        skipped_existing: 0,
        skipped_non_canonical: 0,
        errors: 0,
        rows: [],
      };

      if (!dryRun) {
        await ensurePinterestPublishQueueTable();
      }

      for (const asset of assets) {
        try {
          if (canonicalOnly) {
            const dup = await getMediaHubDuplicateState(asset.id);
            if (!dup) {
              result.errors += 1;
              result.rows.push({
                file_index_id: asset.id,
                action: "error",
                error: "asset_not_found",
              });
              continue;
            }
            if (Number(dup.duplicate_rank || 0) !== 1) {
              result.skipped_non_canonical += 1;
              result.rows.push({
                file_index_id: asset.id,
                action: "skipped_non_canonical",
                canonical_file_index_id: dup.canonical_file_index_id || null,
                duplicate_rank: Number(dup.duplicate_rank || 0),
                duplicate_count: Number(dup.duplicate_count || 0),
              });
              continue;
            }
          }

          if (!dryRun) {
            const existing = await pg.query(
              `SELECT id, status
                 FROM pinterest_publish_queue
                WHERE file_index_id = $1
                  AND pinterest_account = $2
                  AND board_name = $3
                  AND COALESCE(status, 'draft') IN ('draft','approved','scheduled','posted')
                ORDER BY created_at DESC
                LIMIT 1`,
              [asset.id, body.pinterest_account, body.board_name]
            );
            if (existing.rows?.length) {
              result.skipped_existing += 1;
              result.rows.push({
                file_index_id: asset.id,
                action: "skipped_existing",
                existing_id: existing.rows[0].id,
                existing_status: existing.rows[0].status,
              });
              continue;
            }
          }

          const captionOpts = {
            brand_slug: body.brand_slug || asset.brand || null,
            objective: body.objective || "drive_traffic",
            tone: body.tone || "confident",
            target_audience: body.target_audience || "buyers",
            destination_url: body.destination_url || null,
          };
          let caption;
          if (useAi) {
            caption = await withTimeout(
              generateMediaCaption(asset, captionOpts),
              MEDIA_HUB_CAPTION_TIMEOUT_MS,
              "MEDIA_HUB_CAPTION_TIMEOUT",
              "media_hub_caption_timeout"
            );
          } else {
            const fallback = deterministicCaptionFromAsset(asset, captionOpts);
            const quality = scorePinterestCaption(fallback, captionOpts);
            caption = {
              ...fallback,
              quality_score: quality.score,
              quality_reasons: quality.reasons,
              provider: "deterministic_fallback",
              model_key: null,
            };
          }

          if (!dryRun) {
            const { rows } = await pg.query(
              `INSERT INTO pinterest_publish_queue (
                 file_index_id, brand_slug, pinterest_account, board_name,
                 pin_title, pin_description, destination_url, hashtags,
                 caption_variants, status, created_by, scheduled_for, review_notes
               ) VALUES (
                 $1, $2, $3, $4,
                 $5, $6, $7, $8::text[],
                 $9::jsonb, COALESCE($10, 'draft'), $11, $12, $13
               )
               RETURNING id, status, created_at`,
              [
                asset.id,
                body.brand_slug || asset.brand || null,
                body.pinterest_account,
                body.board_name,
                caption.title || null,
                caption.description || null,
                body.destination_url || null,
                Array.isArray(caption.hashtags) ? caption.hashtags.slice(0, 20) : [],
                JSON.stringify([
                  {
                    source: "media_hub_auto",
                    quality_score: caption.quality_score,
                    quality_reasons: caption.quality_reasons,
                    generated_at: new Date().toISOString(),
                    caption,
                  },
                ]),
                body.status || "draft",
                body.created_by || "media_hub_auto",
                body.scheduled_for || null,
                body.review_notes || null,
              ]
            );
            result.created += 1;
            result.rows.push({
              file_index_id: asset.id,
              action: "queued",
              queue_id: rows?.[0]?.id || null,
              quality_score: caption.quality_score ?? null,
            });
          } else {
            result.created += 1;
            result.rows.push({
              file_index_id: asset.id,
              action: "dry_run_would_queue",
              quality_score: caption.quality_score ?? null,
            });
          }
        } catch (err) {
          result.errors += 1;
          result.rows.push({
            file_index_id: asset.id,
            action: "error",
            error: err.message,
          });
        }
      }

      return jsonResponse(res, 200, {
        generated_at: new Date().toISOString(),
        max_assets: maxAssets,
        use_ai: useAi,
        canonical_only: canonicalOnly,
        result,
      });
    }

    if (method === "POST" && pathname === "/api/goal") {
      const body = await parseBody(req);
      return handlePostGoal(req, res, body);
    }

    if (method === "POST" && pathname === "/api/orchestrate") {
      const body = await parseBody(req);
      return handlePostOrchestrate(req, res, body);
    }

    const orchestrateStatusMatch = pathname.match(/^\/api\/orchestrate\/([a-f0-9-]{36})$/i);
    if (method === "GET" && orchestrateStatusMatch) {
      const orchestrationId = orchestrateStatusMatch[1];
      const run = ORCHESTRATION_RUNS.get(orchestrationId);
      if (!run) return jsonResponse(res, 404, { error: "orchestration_not_found" });
      return jsonResponse(res, 200, run);
    }


    if (method === "GET" && pathname === "/api/tasks") {
      return handleGetTasks(req, res);
    }

    if (method === "GET" && pathname === "/api/progress") {
      return handleGetProgress(req, res);
    }

    if (method === "GET" && pathname === "/api/progress/learning") {
      return handleGetProgressLearning(req, res);
    }

    if (method === "POST" && pathname === "/api/system/reduce-load") {
      const body = await parseBody(req);
      return handleSystemReduceLoad(req, res, body);
    }

    if (method === "POST" && pathname === "/api/system/resume-load") {
      return handleSystemResumeLoad(req, res);
    }

    if (method === "POST" && pathname === "/api/system/pm2-ensure") {
      return handleSystemPm2Ensure(req, res);
    }

    if (method === "GET" && pathname === "/api/system/status") {
      return handleSystemStatus(req, res);
    }

    if (method === "GET" && pathname === "/api/quarantine/management-integrity") {
      return handleManagementIntegrityQuarantine(req, res);
    }

    const reportHistoryMatch = pathname.match(/^\/api\/dashboard\/reports\/([a-z0-9_:-]+)\/history$/i);
    if (method === "GET" && reportHistoryMatch) {
      const reportId = reportHistoryMatch[1];
      const reportDef = getReportDefinition(reportId);
      if (!reportDef) return jsonResponse(res, 404, { error: "unknown_report_id" });
      let rows = [];
      try {
        rows = await getReportRefreshRows(reportId, 80);
      } catch (err) {
        if (!isPoolClosedError(err)) throw err;
        rows = [];
      }
      return jsonResponse(res, 200, {
        generated_at: new Date().toISOString(),
        report: reportDef,
        history: rows.map(normalizeReportHistoryRow),
      });
    }

    const reportContentMatch = pathname.match(/^\/api\/dashboard\/reports\/([a-z0-9_:-]+)\/content$/i);
    if (method === "GET" && reportContentMatch) {
      const reportId = reportContentMatch[1];
      const reportDef = getReportDefinition(reportId);
      if (!reportDef) return jsonResponse(res, 404, { error: "unknown_report_id" });
      
      const artifact = latestArtifactForReport(reportDef);
      if (!artifact || !artifact.abs) {
        return jsonResponse(res, 404, { 
          error: "artifact_not_found", 
          report_id: reportId,
          message: `No artifact found for report "${reportId}". The report may not have been generated yet.`
        });
      }
      
      try {
        if (!fs.existsSync(artifact.abs)) {
          return jsonResponse(res, 404, { 
            error: "artifact_file_missing", 
            report_id: reportId,
            artifact_path: artifact.abs,
            message: `Artifact file not found at path: ${artifact.abs}`
          });
        }
        
        const content = fs.readFileSync(artifact.abs, "utf8");
        let parsed = null;
        try {
          parsed = JSON.parse(content);
        } catch {
          // Not JSON, return as text
        }
        
        return jsonResponse(res, 200, {
          report_id: reportId,
          artifact_path: artifact.abs,
          artifact_name: artifact.name,
          generated_at: artifact.mtime,
          content: parsed || content,
          is_json: parsed !== null,
        });
      } catch (err) {
        return jsonResponse(res, 500, { 
          error: "failed_to_read_artifact", 
          report_id: reportId,
          message: err.message || "Unknown error reading artifact file"
        });
      }
    }

    const reportRefreshMatch = pathname.match(/^\/api\/dashboard\/reports\/([a-z0-9_:-]+)\/refresh$/i);
    if (method === "POST" && reportRefreshMatch) {
      const reportId = reportRefreshMatch[1];
      const body = await parseBody(req);
      try {
        invalidateDashboardTabEnvelopeCache();
        const queued = await enqueueReportRefresh(
          reportId,
          String(body.requested_by || "dashboard"),
          Number(body.priority || 3)
        );
        return jsonResponse(res, 202, {
          ok: true,
          report_id: reportId,
          ...queued,
        });
      } catch (err) {
        return jsonResponse(res, err.status || 500, { ok: false, error: err.message || "report_refresh_failed" });
      }
    }

    const dashboardTabRoutes = {
      "/api/dashboard/overview": "overview",
      "/api/dashboard/systems": "systems",
      "/api/dashboard/agents": "agents",
      "/api/dashboard/jobs": "jobs",
      "/api/dashboard/queue": "queue",
      "/api/dashboard/leads-credit": "leads-credit",
      "/api/dashboard/qa-e2e": "qa-e2e",
      "/api/dashboard/research-copy": "research-copy",
      "/api/dashboard/reports": "reports",
      "/api/dashboard/reports/": "reports",
      "/api/dashboard/history": "history",
      "/api/dashboard/bot-payments": "bot-payments",
    };
    if (method === "GET" && dashboardTabRoutes[pathname]) {
      return handleDashboardTab(req, res, dashboardTabRoutes[pathname]);
    }

    if (method === "POST" && pathname === "/api/dashboard/research-copy/regenerate") {
      const requestedBy = (await parseBody(req)).requested_by || "dashboard";
      const requesterIp = actionRequesterIp(req);
      // FIX C3: was incorrectly using ["workflow_continue", "repo_scan_continue"] (CI lane, not research)
      const actionIds = ["saas_pain_report", "saas_opportunity", "affiliate_research"];
      const runs = [];
      for (const actionId of actionIds) {
        try {
          const result = runDashboardAction(actionId, requestedBy, requesterIp);
          runs.push({ action_id: actionId, ...result });
        } catch (err) {
          runs.push({ action_id: actionId, accepted: false, error: err.message });
        }
      }
      return jsonResponse(res, 202, { ok: true, requested_by: requestedBy, runs });
    }

    if (method === "GET" && pathname === "/api/dashboard/actions") {
      return jsonResponse(res, 200, {
        generated_at: new Date().toISOString(),
        actions: await getDashboardActionsState(),
      });
    }

    if (method === "GET" && pathname === "/api/dashboard/nudge") {
      const candidates = await getNudgeCandidates();
      return jsonResponse(res, 200, {
        generated_at: new Date().toISOString(),
        nudge_idle_minutes: NUDGE_IDLE_MINUTES,
        candidates: candidates,
      });
    }

    if (method === "POST" && pathname === "/api/dashboard/nudge") {
      const body = await parseBody(req).catch(() => ({}));
      const dryRun = Boolean(body.dry_run);
      const candidates = await getNudgeCandidates();
      if (dryRun) {
        return jsonResponse(res, 200, {
          ok: true,
          dry_run: true,
          generated_at: new Date().toISOString(),
          candidates: candidates,
          message: `Would nudge ${candidates.length} action(s) if execute=true.`,
        });
      }
      const nudged = [];
      for (const c of candidates) {
        try {
          const result = runDashboardAction(c.action_id, "nudge", "system");
          nudged.push({ action_id: c.action_id, name: c.name, accepted: true, ...result });
        } catch (err) {
          nudged.push({ action_id: c.action_id, name: c.name, accepted: false, error: err.message });
        }
      }
      return jsonResponse(res, 200, {
        ok: true,
        generated_at: new Date().toISOString(),
        nudged,
      });
    }

    const actionRunMatch =
      method === "POST" && pathname.match(/^\/api\/dashboard\/actions\/([a-z0-9_:-]+)\/run$/i);
    if (actionRunMatch) {
      const ip = actionRequesterIp(req);
      if (!checkActionRateLimit(ip)) {
        return jsonResponse(res, 429, { ok: false, error: "rate_limited_action_run" });
      }
      const actionId = actionRunMatch[1];
      if (!checkActionCooldown(ip, actionId)) {
        return jsonResponse(res, 429, { ok: false, error: "action_cooldown_active" });
      }
      const body = await parseBody(req);
      try {
        const result = runDashboardAction(actionId, body.requested_by || "dashboard", ip);
        return jsonResponse(res, 202, {
          ok: true,
          accepted_at: new Date().toISOString(),
          ...result,
        });
      } catch (err) {
        return jsonResponse(res, err.status || 500, { ok: false, error: err.message || "action_run_failed" });
      }
    }

    if (method === "GET" && pathname === "/api/local-alternatives/veritap") {
      const repoPath = parsed.query?.repo_path || "$HOME/claw-repos/veritap_2026";
      return jsonResponse(res, 200, scanVeritapServices(repoPath));
    }

    if (method === "GET" && pathname === "/api/local-alternatives/activity") {
      const limit = Math.max(1, Math.min(100, parseInt(parsed.query?.limit || "25", 10) || 25));
      return jsonResponse(res, 200, getRecentActivity(limit));
    }

    if (method === "POST" && pathname === "/api/local-alternatives/ai") {
      const body = await parseBody(req);
      try {
        const result = await runLocalAiPrompt({
          prompt: body.prompt,
          model: body.model,
          maxTokens: Math.max(120, Math.min(420, Number(body.max_tokens || 240))),
          timeoutMs: Math.max(3000, Number(body.timeout_ms || 12000) || 12000),
          temperature: Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : 0.2,
        });
        return jsonResponse(res, 200, result);
      } catch (err) {
        return jsonResponse(res, 400, { ok: false, error: err.message });
      }
    }

    if (method === "POST" && pathname === "/api/dashboard/chat") {
      const body = await parseBody(req);
      const message = String(body.message || body.prompt || "").trim();
      if (!message) return jsonResponse(res, 400, { ok: false, error: "message_required" });
      const requesterIp = actionRequesterIp(req);
      try {
        const progress = await getDashboardProgressSafe();
        const systemPrompt = dashboardChatSystemPrompt(progress);
        const routerAttempt = withTimeout(
          routedChat("_default", systemPrompt, message, {
            max_tokens: Math.max(180, Math.min(900, Number(body.max_tokens || 420))),
            temperature: 0.2,
            cacheable: false,
            timeout_ms: 45000,
          }),
          DASHBOARD_CHAT_TIMEOUT_MS,
          "DASHBOARD_CHAT_TIMEOUT",
          "dashboard_chat_timeout"
        ).then((result) => {
          const reply = String(result?.text || "").trim();
          const modelKey = result?.model_key || null;
          const provider = result?.provider || null;
          const escalationReason = result?.escalation_reason || null;
          if (shouldRejectDashboardChatCandidate(reply, modelKey, provider, escalationReason, result?.degraded === true)) {
            throw new Error("router_degraded_fallback");
          }
          return {
            ok: true,
            reply,
            model_key: modelKey,
            provider,
            confidence: result?.confidence ?? null,
            escalation_reason: escalationReason,
            routing: routingStats(),
          };
        });
        const localAttempt = withTimeout(
          runLocalAiPrompt({
            prompt: `System:\n${systemPrompt}\n\nUser:\n${message}`,
            model: body.model,
            maxTokens: Math.max(120, Math.min(420, Number(body.max_tokens || 240))),
            timeoutMs: DASHBOARD_FALLBACK_TIMEOUT_MS,
            temperature: 0.2,
          }),
          DASHBOARD_FALLBACK_TIMEOUT_MS,
          "DASHBOARD_FALLBACK_TIMEOUT",
          "dashboard_fallback_timeout"
        ).then((fallback) => {
          const reply = String(fallback.output || "").trim();
          const modelKey = fallback.model || "ollama_fallback";
          const provider = "ollama";
          const escalationReason = "router_fallback";
          if (shouldRejectDashboardChatCandidate(reply, modelKey, provider, escalationReason, fallback?.degraded === true)) {
            throw new Error("local_degraded_fallback");
          }
          return {
            ok: true,
            reply,
            model_key: modelKey,
            provider,
            confidence: null,
            escalation_reason: escalationReason,
            routing: routingStats(),
          };
        });
        try {
          const output = await Promise.any([routerAttempt, localAttempt]);
          const workActions = buildDashboardChatWorkActions(message, progress);
          const forceDispatch = /^\/do\s+/i.test(message);
          const imperative = /^(fix|run|queue|do|continue|start)\b/i.test(message.toLowerCase());
          const autoDispatch = forceDispatch || body.auto_dispatch === true || imperative;
          const maxActions = Math.max(1, Math.min(3, Number(body.max_actions || 2) || 2));
          const dispatchedActions = [];
          if (autoDispatch) {
            for (const action of workActions.slice(0, maxActions)) {
              if (!checkActionRateLimit(requesterIp)) break;
              if (!checkActionCooldown(requesterIp, action.id)) continue;
              try {
                const result = runDashboardAction(action.id, "dashboard_chat", requesterIp);
                dispatchedActions.push({ action_id: action.id, ...result });
              } catch (err) {
                dispatchedActions.push({ action_id: action.id, accepted: false, error: err.message || "action_failed" });
              }
            }
          }
          return jsonResponse(res, 200, {
            ...output,
            work_actions: workActions,
            auto_dispatch: autoDispatch,
            dispatched_actions: dispatchedActions,
          });
        } catch (aggErr) {
          // Last-resort retry: direct local model call without the long system prompt.
          try {
            const backup = await withTimeout(
              runLocalAiPrompt({
                prompt: message,
                model: body.model,
                maxTokens: Math.max(96, Math.min(300, Number(body.max_tokens || 180))),
                timeoutMs: DASHBOARD_FALLBACK_TIMEOUT_MS,
                temperature: 0.2,
              }),
              DASHBOARD_FALLBACK_TIMEOUT_MS,
              "DASHBOARD_FALLBACK_RETRY_TIMEOUT",
              "dashboard_fallback_retry_timeout"
            );
            const workActions = buildDashboardChatWorkActions(message, progress);
            const forceDispatch = /^\/do\s+/i.test(message);
            const imperative = /^(fix|run|queue|do|continue|start)\b/i.test(message.toLowerCase());
            const autoDispatch = forceDispatch || body.auto_dispatch === true || imperative;
            const maxActions = Math.max(1, Math.min(3, Number(body.max_actions || 2) || 2));
            const dispatchedActions = [];
            if (autoDispatch) {
              for (const action of workActions.slice(0, maxActions)) {
                if (!checkActionRateLimit(requesterIp)) break;
                if (!checkActionCooldown(requesterIp, action.id)) continue;
                try {
                  const result = runDashboardAction(action.id, "dashboard_chat", requesterIp);
                  dispatchedActions.push({ action_id: action.id, ...result });
                } catch (err) {
                  dispatchedActions.push({ action_id: action.id, accepted: false, error: err.message || "action_failed" });
                }
              }
            }
            return jsonResponse(res, 200, {
              ok: true,
              reply: String(backup.output || "").trim(),
              model_key: backup.model || "ollama_retry",
              provider: "ollama",
              confidence: null,
              escalation_reason: "router_local_retry",
              routing: routingStats(),
              degraded: false,
              work_actions: workActions,
              auto_dispatch: autoDispatch,
              dispatched_actions: dispatchedActions,
            });
          } catch {
            throw aggErr;
          }
        }
      } catch (err) {
        const reason = String(err?.message || err?.errors?.[0]?.message || "dashboard_chat_failed");
        const progress = await getDashboardProgressSafe().catch(() => ({}));
        const payload = dashboardChatRulePayload(message, progress, reason);
        const forceDispatch = /^\/do\s+/i.test(message);
        const imperative = /^(fix|run|queue|do|continue|start)\b/i.test(message.toLowerCase());
        const autoDispatch = forceDispatch || body.auto_dispatch === true || imperative;
        const maxActions = Math.max(1, Math.min(3, Number(body.max_actions || 2) || 2));
        const dispatchedActions = [];
        if (autoDispatch) {
          for (const action of (payload.work_actions || []).slice(0, maxActions)) {
            if (!checkActionRateLimit(requesterIp)) break;
            if (!checkActionCooldown(requesterIp, action.id)) continue;
            try {
              const result = runDashboardAction(action.id, "dashboard_chat", requesterIp);
              dispatchedActions.push({ action_id: action.id, ...result });
            } catch (runErr) {
              dispatchedActions.push({ action_id: action.id, accepted: false, error: runErr.message || "action_failed" });
            }
          }
        }
        return jsonResponse(res, 200, {
          ...payload,
          auto_dispatch: autoDispatch,
          dispatched_actions: dispatchedActions,
        });
      }
    }

    if (method === "POST" && pathname === "/api/local-alternatives/email/draft") {
      const body = await parseBody(req);
      try {
        const row = createEmailDraft(body);
        return jsonResponse(res, 200, { ok: true, draft: row });
      } catch (err) {
        return jsonResponse(res, 400, { ok: false, error: err.message });
      }
    }

    if (method === "POST" && pathname === "/api/local-alternatives/sms/draft") {
      const body = await parseBody(req);
      try {
        const row = createSmsDraft(body);
        return jsonResponse(res, 200, { ok: true, draft: row });
      } catch (err) {
        return jsonResponse(res, 400, { ok: false, error: err.message });
      }
    }

    if (method === "GET" && pathname === "/api/offgrid/status") {
      const status = getOffgridBridgeStatus();
      return jsonResponse(res, 200, status);
    }

    if (method === "GET" && pathname === "/api/offgrid/snapshot") {
      const snapshot = await getOffgridSnapshot();
      return jsonResponse(res, 200, snapshot);
    }

    if (method === "POST" && pathname === "/api/offgrid/mesh/send") {
      const body = await parseBody(req);
      try {
        const row = queueMeshCommand(body.text, body.to || "broadcast", { source: "dashboard" });
        return jsonResponse(res, 200, { ok: true, queued: row });
      } catch (err) {
        return jsonResponse(res, 400, { ok: false, error: err.message });
      }
    }

    if (method === "POST" && pathname === "/api/offgrid/mesh/ingest") {
      const body = await parseBody(req);
      try {
        const row = ingestMeshEvent(body || {});
        return jsonResponse(res, 200, { ok: true, event: row });
      } catch (err) {
        return jsonResponse(res, 400, { ok: false, error: err.message });
      }
    }

    if (method === "POST" && pathname === "/api/offgrid/light") {
      const body = await parseBody(req);
      const entityId = String(body.entity_id || "").trim();
      if (!entityId) return jsonResponse(res, 400, { ok: false, error: "entity_id_required" });
      const on = Boolean(body.on);
      const brightnessPct = body.brightness_pct == null ? null : Number(body.brightness_pct);
      const r = await offgridSetLight(entityId, on, brightnessPct);
      if (!r.ok) return jsonResponse(res, 502, { ok: false, error: r.error, detail: r.data });
      return jsonResponse(res, 200, { ok: true, result: r.data });
    }

    if (method === "POST" && pathname === "/api/offgrid/service") {
      const body = await parseBody(req);
      const domain = String(body.domain || "").trim();
      const service = String(body.service || "").trim();
      if (!domain || !service) return jsonResponse(res, 400, { ok: false, error: "domain_and_service_required" });
      const r = await offgridRunService(domain, service, body.service_data || {});
      if (!r.ok) return jsonResponse(res, 502, { ok: false, error: r.error, detail: r.data });
      return jsonResponse(res, 200, { ok: true, result: r.data });
    }

    if (method === "GET" && pathname === "/api/offgrid/lights/discover") {
      const r = await discoverAllLights();
      if (!r.ok) return jsonResponse(res, 502, { ok: false, error: r.error, lights: [] });
      return jsonResponse(res, 200, { ok: true, lights: r.lights });
    }

    if (method === "POST" && pathname === "/api/offgrid/lights/flicker-test") {
      const body = await parseBody(req);
      const entityIds = Array.isArray(body.entity_ids) ? body.entity_ids : body.entity_id ? [body.entity_id] : [];
      if (entityIds.length === 0) {
        return jsonResponse(res, 400, { ok: false, error: "entity_ids_required" });
      }
      const durationMs = Math.max(200, Math.min(2000, Number(body.duration_ms || 500)));
      const cycles = Math.max(1, Math.min(10, Number(body.cycles || 3)));
      const r = await flickerTest(entityIds, durationMs, cycles);
      if (!r.ok) return jsonResponse(res, 502, { ok: false, error: r.error, results: [] });
      return jsonResponse(res, 200, { ok: true, results: r.results });
    }

    if (method === "GET" && pathname === "/api/offgrid/pattern-pack") {
      const pack = getOffgridHuePatternPack();
      return jsonResponse(res, 200, { ok: true, ...pack });
    }

    if (method === "POST" && pathname === "/api/offgrid/pattern-pack/apply") {
      const body = await parseBody(req);
      const actor = String(body.actor || "offgrid_dashboard").trim();
      const templates = getOffgridPatternTaskTemplates();
      const created = [];
      const skipped = [];

      for (const t of templates) {
        const dedupe = buildTaskIdempotencyKey("opencode_controller", {
          repo: t.repo,
          source: t.source,
          objective: t.objective,
          lane: t.lane,
        });
        const exists = await pg.query(
          `
          SELECT id
          FROM tasks
          WHERE type = 'opencode_controller'
            AND idempotency_key = $1
            AND status IN ('CREATED','DISPATCHED','RUNNING','RETRY','PENDING_APPROVAL')
          LIMIT 1
          `,
          [dedupe]
        );
        if (exists.rows.length) {
          skipped.push({ lane: t.lane, reason: "already_exists", task_id: exists.rows[0].id });
          continue;
        }

        const payload = {
          repo: t.repo,
          source: t.source,
          lane: t.lane,
          objective: t.objective,
          owner: actor,
          acceptance_criteria: [
            "Change list with repo/file paths",
            "Passing command output for touched flow",
            "Artifact/report path with timestamp",
          ],
        };
        const ins = await pg.query(
          `
          INSERT INTO tasks (id, type, payload, status, priority, retry_count, max_retries, idempotency_key, created_at, updated_at)
          VALUES (gen_random_uuid(), 'opencode_controller', $1::jsonb, 'CREATED', $2, 0, 3, $3, NOW(), NOW())
          RETURNING id
          `,
          [JSON.stringify(payload), Number(t.priority || 7), dedupe]
        );
        created.push({ lane: t.lane, task_id: ins.rows[0]?.id || null });
      }

      return jsonResponse(res, 200, {
        ok: true,
        created_count: created.length,
        skipped_count: skipped.length,
        created,
        skipped,
      });
    }

    if (method === "GET" && pathname === "/api/openclaw/creator-pack/topics") {
      return jsonResponse(res, 200, {
        top_topics: [
          {
            name: "OpenClaw VPS Setup + Telegram",
            demand_signal: "High beginner demand, direct practical outcome.",
            easiest_to_teach: true,
            outcome: "Deploy first OpenClaw agent on a VPS and control it from Telegram.",
          },
          {
            name: "OpenClaw + Ollama Local Mode",
            demand_signal: "Strong privacy/cost interest.",
            easiest_to_teach: true,
            outcome: "Run core OpenClaw workflows locally without cloud dependency.",
          },
          {
            name: "Creator Workflow Automation Pack",
            demand_signal: "Content creators want repeatable workflows.",
            easiest_to_teach: true,
            outcome: "Install YouTube/TikTok/comment/repurposing workflows out of the box.",
          },
        ],
        recommended_price_range_usd: [500, 1500],
      });
    }

    if (method === "POST" && pathname === "/api/openclaw/creator-pack/generate") {
      const body = await parseBody(req);
      const payload = {
        package_name: body.package_name || "OpenClaw Creator Pack",
        client_name: body.client_name || "Content Creator",
        complexity: body.complexity || "standard",
        outcome:
          body.outcome ||
          "Set up OpenClaw on macOS, connect Telegram, and run creator workflows in one session.",
        output_dir: body.output_dir || path.join(__dirname, "..", "artifacts", "openclaw-creator-pack"),
      };

      if (body.queue === true) {
        const r = spawnSync(
          "node",
          [
            "cli/create-task.js",
            "--type",
            "openclaw_creator_pack_generate",
            "--payload",
            JSON.stringify(payload),
          ],
          { cwd: path.join(__dirname, ".."), encoding: "utf8" }
        );
        if (r.status !== 0) {
          return jsonResponse(res, 500, { ok: false, error: (r.stderr || "").trim() || "queue_failed" });
        }
        return jsonResponse(res, 200, { ok: true, queued: true, stdout: (r.stdout || "").trim() });
      }

      try {
        const out = generateCreatorPack(payload);
        return jsonResponse(res, 200, out);
      } catch (err) {
        return jsonResponse(res, 500, { ok: false, error: err.message });
      }
    }

    if (method === "GET" && planId && !action) {
      return handleGetPlan(req, res, planId);
    }

    if (method === "POST" && planId && action === "approve") {
      const body = await parseBody(req);
      return handlePostPlanApprove(req, res, body, planId);
    }

    if (method === "POST" && planId && action === "reject") {
      const body = await parseBody(req);
      return handlePostPlanReject(req, res, body, planId);
    }

    if (method === "POST" && planId && action === "confirm") {
      const body = await parseBody(req);
      return handlePostPlanConfirm(req, res, body, planId);
    }

    return jsonResponse(res, 404, { error: "Not found" });
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

// ── Server ────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  onRequest(req, res).catch((err) => {
    console.error("[architect-api] Handler error:", err);
    jsonResponse(res, 500, { error: err.message || "Internal server error" });
  });
});

server.listen(PORT, HOST, () => {
  const displayHost = HOST === "0.0.0.0" ? "localhost" : HOST;
  console.log(`[architect-api] Listening on http://${displayHost}:${PORT} (bind ${HOST})`);
  if (!API_KEY) {
    console.warn("[architect-api] ARCHITECT_API_KEY not set; non-local requests are blocked.");
  }
});
