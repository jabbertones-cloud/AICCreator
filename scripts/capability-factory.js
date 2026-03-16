#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const ARGS = process.argv.slice(2);
const ROOT = getArg("--root", process.env.CLAW_REPOS_ROOT || "$HOME/claw-repos");
const REPOS_ARG = getArg("--repos", "");
const OUT_DIR = getArg("--out", path.join(process.cwd(), "reports", "capability-factory"));
const PHASE = String(getArg("--phase", "all")).toLowerCase();
const MAX_FILES = Number(getArg("--max-files", "5000"));
const MAX_FILE_BYTES = Number(getArg("--max-file-bytes", String(768 * 1024)));
const LOCKFILE_RE = /(^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|poetry\.lock|Pipfile\.lock)$/i;

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".vercel",
  "playwright-report",
  "test-results",
]);
const CODE_EXTS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".json", ".sql", ".yml", ".yaml", ".env"]);

function getArg(flag, fallback = null) {
  const idx = ARGS.indexOf(flag);
  if (idx < 0 || idx + 1 >= ARGS.length) return fallback;
  return ARGS[idx + 1];
}

function nowStamp() {
  const d = new Date();
  return d.toISOString().replace(/[:.]/g, "-");
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readText(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return "";
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function listRepos(root) {
  if (REPOS_ARG.trim()) {
    return REPOS_ARG.split(",").map((x) => x.trim()).filter(Boolean);
  }
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));
}

function walkFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (out.length >= MAX_FILES) return out;
      out.push(full);
    }
  }
  return out;
}

function matchPattern(text, pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escaped, "i");
  return re.test(text);
}

function analyzeRepo(repoName, repoPath, cfg) {
  const files = walkFiles(repoPath);
  const codeFiles = files.filter((f) => CODE_EXTS.has(path.extname(f).toLowerCase()));
  const fileCache = codeFiles.map((f) => {
    const txt = readText(f);
    return { file: f, rel: path.relative(repoPath, f).replace(/\\/g, "/"), txt };
  }).filter((x) => x.txt);

  const capabilityFindings = [];
  for (const cap of cfg.capabilities || []) {
    const required = cap.required_patterns || [];
    const security = cap.required_security_patterns || [];
    const optional = cap.optional_patterns || [];

    const matchesByFile = [];
    const matchedRequired = new Set();
    const matchedSecurity = new Set();
    const matchedOptional = new Set();

    for (const { rel, txt } of fileCache) {
      const reqHits = required.filter((p) => matchPattern(txt, p));
      const secHits = security.filter((p) => matchPattern(txt, p));
      const optHits = optional.filter((p) => matchPattern(txt, p));
      if (reqHits.length || secHits.length || optHits.length) {
        reqHits.forEach((x) => matchedRequired.add(x));
        secHits.forEach((x) => matchedSecurity.add(x));
        optHits.forEach((x) => matchedOptional.add(x));
        matchesByFile.push({ file: rel, reqHits, secHits, optHits });
      }
    }

    const requiredCoverage = required.length ? matchedRequired.size / required.length : 1;
    const securityCoverage = security.length ? matchedSecurity.size / security.length : 1;
    const optionalCoverage = optional.length ? matchedOptional.size / optional.length : 1;
    const present = required.length === 0 ? false : matchedRequired.size === required.length;
    const score = Math.round(((requiredCoverage * 0.7) + (securityCoverage * 0.2) + (optionalCoverage * 0.1)) * 100);

    capabilityFindings.push({
      id: cap.id,
      domain: cap.domain,
      present,
      score,
      requiredCoverage: round(requiredCoverage),
      securityCoverage: round(securityCoverage),
      optionalCoverage: round(optionalCoverage),
      filesMatched: matchesByFile.length,
      sampleFiles: matchesByFile.slice(0, 15),
    });
  }

  const FORBIDDEN_SKIP_RE = /(^|\/)config\/capabilities\.yaml$/i;
  const forbiddenHits = [];
  for (const pattern of cfg.forbidden_global_patterns || []) {
    const hits = [];
    for (const { rel, txt } of fileCache) {
      if (LOCKFILE_RE.test(rel) || FORBIDDEN_SKIP_RE.test(rel)) continue;
      if (!matchPattern(txt, pattern)) continue;
      if (pattern === "fake") {
        if (/(^|\/)scripts\/capability-factory\.js$/i.test(rel)) continue;
        const without = txt.replace(/hasFakeCaret/gi, "hasXCaret");
        if (!matchPattern(without, "fake")) continue;
      }
      hits.push(rel);
      if (hits.length >= 10) break;
    }
    if (hits.length) forbiddenHits.push({ pattern, files: hits });
  }

  const capabilityMap = Object.fromEntries(capabilityFindings.map((c) => [c.id, c]));
  const securityThresholdByCapability = {
    "billing.stripe.webhooks": 0.5,
    "comms.telnyx.sms": 0.5,
    "webhooks.signature_verify": 0.5,
  };
  const issues = [];
  const hasBetterAuth = capabilityMap["auth.better_auth"]?.present;
  const hasLegacy = capabilityMap["auth.legacy_nextauth"]?.present || capabilityMap["auth.supabase_auth"]?.present;
  if (hasLegacy && !hasBetterAuth) {
    issues.push({ severity: "critical", code: "AUTH_NOT_STANDARDIZED", detail: "legacy auth detected without better-auth baseline" });
  }
  if (
    capabilityMap["billing.stripe.checkout"]?.present &&
    capabilityMap["billing.stripe.webhooks"]?.securityCoverage <
      (securityThresholdByCapability["billing.stripe.webhooks"] || 1)
  ) {
    issues.push({ severity: "critical", code: "STRIPE_WEBHOOK_SECURITY_GAP", detail: "stripe checkout present but webhook security coverage is incomplete" });
  }
  if (capabilityMap["comms.telnyx.sms"]?.present && capabilityMap["webhooks.signature_verify"]?.present !== true) {
    issues.push({ severity: "high", code: "TELNYX_SIGNATURE_VERIFY_MISSING", detail: "telnyx present without strong webhook signature verify signals" });
  }
  if (!capabilityMap["tenancy.multitenant"]?.present) {
    issues.push({ severity: "high", code: "MULTITENANT_BASELINE_MISSING", detail: "no tenant/org/workspace signals detected" });
  }
  for (const hit of forbiddenHits) {
    issues.push({ severity: "medium", code: "FORBIDDEN_PATTERN", detail: `${hit.pattern} in ${hit.files.length} file(s)` });
  }

  const avgScore = capabilityFindings.length
    ? Math.round(capabilityFindings.reduce((n, x) => n + x.score, 0) / capabilityFindings.length)
    : 0;
  const health = Math.max(0, avgScore - (issues.filter((i) => i.severity === "critical").length * 20) - (issues.filter((i) => i.severity === "high").length * 10));

  return {
    repo: repoName,
    path: repoPath,
    scannedFiles: fileCache.length,
    capabilityFindings,
    forbiddenHits,
    issues,
    score: health,
  };
}

function pickCanonicalCandidates(reports) {
  const byCapability = new Map();
  for (const repo of reports) {
    for (const c of repo.capabilityFindings) {
      if (!c.present) continue;
      const current = byCapability.get(c.id);
      const candidate = {
        capability: c.id,
        repo: repo.repo,
        score: c.score,
        filesMatched: c.filesMatched,
        issuePenalty: repo.issues.filter((i) => i.severity === "critical").length * 15 + repo.issues.filter((i) => i.severity === "high").length * 8,
      };
      candidate.rankScore = candidate.score - candidate.issuePenalty;
      if (!current || candidate.rankScore > current.rankScore) byCapability.set(c.id, candidate);
    }
  }
  return Array.from(byCapability.values()).sort((a, b) => b.rankScore - a.rankScore);
}

function buildRolloutPlan(reports) {
  const plan = [];
  for (const r of reports.sort((a, b) => a.score - b.score)) {
    const critical = r.issues.filter((i) => i.severity === "critical");
    const high = r.issues.filter((i) => i.severity === "high");
    if (!critical.length && !high.length) continue;
    plan.push({
      repo: r.repo,
      priority: critical.length ? "P0" : "P1",
      score: r.score,
      critical: critical.map((i) => i.code),
      high: high.map((i) => i.code),
      nextActions: deriveActions(r),
    });
  }
  return plan;
}

function deriveActions(report) {
  const actions = [];
  const codes = new Set(report.issues.map((i) => i.code));
  if (codes.has("AUTH_NOT_STANDARDIZED")) actions.push("migrate runtime auth handlers to better-auth and remove legacy auth imports");
  if (codes.has("STRIPE_WEBHOOK_SECURITY_GAP")) actions.push("enforce stripe webhook signature verification + replay/idempotency guard");
  if (codes.has("TELNYX_SIGNATURE_VERIFY_MISSING")) actions.push("add telnyx signature verification and reject unsigned webhook payloads");
  if (codes.has("MULTITENANT_BASELINE_MISSING")) actions.push("add tenant resolver and organization_id guardrails");
  if (codes.has("FORBIDDEN_PATTERN")) actions.push("remove placeholder patterns and replace with deterministic real data paths");
  return actions;
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

function markdownReport(summary) {
  const lines = [];
  lines.push("# Capability Factory Report");
  lines.push("");
  lines.push(`Generated: ${summary.generatedAt}`);
  lines.push(`Repos scanned: ${summary.repos.length}`);
  lines.push("");
  lines.push("## Top Risk Repos");
  lines.push("");
  const topRisk = [...summary.repos].sort((a, b) => a.score - b.score).slice(0, 12);
  for (const r of topRisk) {
    const crit = r.issues.filter((i) => i.severity === "critical").length;
    const high = r.issues.filter((i) => i.severity === "high").length;
    lines.push(`- ${r.repo}: score=${r.score}, critical=${crit}, high=${high}`);
  }
  lines.push("");
  lines.push("## Canonical Candidates");
  lines.push("");
  for (const c of summary.canonicalCandidates) {
    lines.push(`- ${c.capability}: ${c.repo} (rank=${c.rankScore}, score=${c.score}, files=${c.filesMatched})`);
  }
  lines.push("");
  lines.push("## Rollout Plan");
  lines.push("");
  for (const item of summary.rolloutPlan.slice(0, 25)) {
    lines.push(`- [${item.priority}] ${item.repo}: ${item.nextActions.join("; ")}`);
  }
  lines.push("");
  return lines.join("\n");
}

function main() {
  const cfgPath = path.join(process.cwd(), "config", "capabilities.yaml");
  if (!fs.existsSync(cfgPath)) {
    throw new Error(`missing_config:${cfgPath}`);
  }
  const cfg = yaml.load(fs.readFileSync(cfgPath, "utf8"));
  const repos = listRepos(ROOT);
  const reports = [];

  for (const repo of repos) {
    const repoPath = path.join(ROOT, repo);
    if (!fs.existsSync(repoPath)) continue;
    try {
      reports.push(analyzeRepo(repo, repoPath, cfg));
    } catch (err) {
      reports.push({
        repo,
        path: repoPath,
        scannedFiles: 0,
        capabilityFindings: [],
        forbiddenHits: [],
        issues: [{ severity: "critical", code: "SCAN_FAILED", detail: err.message }],
        score: 0,
      });
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    root: ROOT,
    repos,
    canonicalCandidates: pickCanonicalCandidates(reports),
    rolloutPlan: buildRolloutPlan(reports),
  };
  summary.repos = reports;

  ensureDir(OUT_DIR);
  const stamp = nowStamp();
  const jsonPath = path.join(OUT_DIR, `capability-factory-${stamp}.json`);
  const mdPath = path.join(OUT_DIR, `capability-factory-${stamp}.md`);
  const latestJson = path.join(OUT_DIR, "latest.json");
  const latestMd = path.join(OUT_DIR, "latest.md");

  const inventory = reports.map((r) => ({
    repo: r.repo,
    scannedFiles: r.scannedFiles,
    capabilitiesDetected: r.capabilityFindings.filter((c) => c.present).map((c) => c.id),
    capabilityFindings: r.capabilityFindings,
    forbiddenHits: r.forbiddenHits,
  }));
  const scoreboard = reports.map((r) => ({
    repo: r.repo,
    score: r.score,
    issues: r.issues,
    capabilityScores: r.capabilityFindings.map((c) => ({ id: c.id, present: c.present, score: c.score })),
  })).sort((a, b) => b.score - a.score);

  const phase1Path = path.join(OUT_DIR, `phase1-inventory-${stamp}.json`);
  const phase2Path = path.join(OUT_DIR, `phase2-scoreboard-${stamp}.json`);
  const phase3Path = path.join(OUT_DIR, `phase3-rollout-${stamp}.json`);
  const phase1Latest = path.join(OUT_DIR, "phase1-latest.json");
  const phase2Latest = path.join(OUT_DIR, "phase2-latest.json");
  const phase3Latest = path.join(OUT_DIR, "phase3-latest.json");

  if (PHASE === "all" || PHASE === "1") {
    fs.writeFileSync(phase1Path, JSON.stringify({ generatedAt: summary.generatedAt, repos: inventory }, null, 2));
    fs.writeFileSync(phase1Latest, JSON.stringify({ generatedAt: summary.generatedAt, repos: inventory }, null, 2));
  }
  if (PHASE === "all" || PHASE === "2") {
    fs.writeFileSync(phase2Path, JSON.stringify({ generatedAt: summary.generatedAt, scoreboard, canonicalCandidates: summary.canonicalCandidates }, null, 2));
    fs.writeFileSync(phase2Latest, JSON.stringify({ generatedAt: summary.generatedAt, scoreboard, canonicalCandidates: summary.canonicalCandidates }, null, 2));
  }
  if (PHASE === "all" || PHASE === "3") {
    fs.writeFileSync(phase3Path, JSON.stringify({ generatedAt: summary.generatedAt, rolloutPlan: summary.rolloutPlan }, null, 2));
    fs.writeFileSync(phase3Latest, JSON.stringify({ generatedAt: summary.generatedAt, rolloutPlan: summary.rolloutPlan }, null, 2));
  }

  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));
  fs.writeFileSync(mdPath, markdownReport(summary) + "\n");
  fs.writeFileSync(latestJson, JSON.stringify(summary, null, 2));
  fs.writeFileSync(latestMd, markdownReport(summary) + "\n");

  const criticalCount = reports.reduce((n, r) => n + r.issues.filter((i) => i.severity === "critical").length, 0);
  const highCount = reports.reduce((n, r) => n + r.issues.filter((i) => i.severity === "high").length, 0);
  console.log("\n=== Capability Factory ===\n");
  console.log(`root: ${ROOT}`);
  console.log(`phase: ${PHASE}`);
  console.log(`repos_scanned: ${reports.length}`);
  console.log(`critical_issues: ${criticalCount}`);
  console.log(`high_issues: ${highCount}`);
  console.log(`report_json: ${jsonPath}`);
  console.log(`report_md: ${mdPath}`);
  console.log("");

  const worst = [...reports].sort((a, b) => a.score - b.score).slice(0, 10);
  for (const r of worst) {
    const crit = r.issues.filter((i) => i.severity === "critical").length;
    const high = r.issues.filter((i) => i.severity === "high").length;
    console.log(`- ${r.repo}: score=${r.score} critical=${crit} high=${high}`);
  }

  if (PHASE === "1" || PHASE === "2") {
    process.exit(0);
  }
  process.exit(criticalCount > 0 ? 2 : 0);
}

try {
  main();
} catch (err) {
  console.error("FAIL:", err.message);
  process.exit(1);
}
