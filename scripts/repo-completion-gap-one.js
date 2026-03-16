#!/usr/bin/env node
"use strict";

/**
 * repo-completion-gap-one.js
 * Run full-completion gap analysis for one repo at a time.
 * Uses capability factory + optional feature benchmark; records to rolling report.
 * Usage: node scripts/repo-completion-gap-one.js --repo <name>
 *        node scripts/repo-completion-gap-one.js --repo all
 *        node scripts/repo-completion-gap-one.js --next
 *        node scripts/repo-completion-gap-one.js --repo <name> --dry-run
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

require("dotenv").config({ path: path.join(__dirname, "../.env") });

const ROOT = path.join(__dirname, "..");
const CLAW_REPOS = process.env.CLAW_REPOS_ROOT || process.env.CLAW_REPOS || path.join(process.env.HOME || require("os").homedir(), "claw-repos");
const REPORTS_DIR = path.join(ROOT, "reports");
const CAPABILITY_REPORT_DIR = path.join(ROOT, "reports", "capability-factory");
const ROLLING_PATH = path.join(REPORTS_DIR, "repo-completion-gap-rolling.json");
const { loadMasterList } = require("../config/repo-completion-master-list-loader");

function getArg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  const v = String(process.argv[i + 1] || "").trim();
  return v || fallback;
}

function hasArg(flag) {
  return process.argv.includes(flag);
}

// loadMasterList from repo-completion-master-list-loader (uses .local or env path)

function existingRepos() {
  const master = loadMasterList();
  const names = [...(master.priority_repos || []), ...(master.additional_repos || [])];
  return names.filter((name) => {
    const p = path.join(CLAW_REPOS, name);
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  });
}

function pickNextRepo() {
  const list = existingRepos();
  if (!list.length) return null;
  let rolling = [];
  try {
    rolling = JSON.parse(fs.readFileSync(ROLLING_PATH, "utf8"));
  } catch {
    // new file
  }
  const recent = new Set((rolling.slice(-list.length * 2) || []).map((r) => r.repo));
  const next = list.find((r) => !recent.has(r)) || list[0];
  return next;
}

function runCapabilityFactory(repoName) {
  const res = spawnSync(
    "node",
    [
      path.join(ROOT, "scripts", "capability-factory.js"),
      "--root", CLAW_REPOS,
      "--repos", repoName,
      "--max-files", "3500",
      "--max-file-bytes", "786432",
    ],
    { cwd: ROOT, env: process.env, stdio: "pipe", encoding: "utf8" }
  );
  return res;
}

function readLatestCapabilityReport() {
  const latestPath = path.join(CAPABILITY_REPORT_DIR, "latest.json");
  if (!fs.existsSync(latestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(latestPath, "utf8"));
  } catch {
    return null;
  }
}

function runFeatureBenchmark(repoName) {
  const repoKey = `local/${repoName}`;
  const res = spawnSync(
    "node",
    [
      path.join(ROOT, "scripts", "feature-benchmark-score.js"),
      "--repo", repoKey,
      "--source", "repo_completion_gap",
    ],
    { cwd: ROOT, env: process.env, stdio: "pipe", encoding: "utf8" }
  );
  return { ok: res.status === 0, stderr: res.stderr || "" };
}

function deriveSections(master, reportForRepo) {
  const sections = {};
  const sectionIds = master.sections_to_complete || [];
  for (const id of sectionIds) {
    sections[id] = { status: "incomplete", detail: "" };
  }

  if (!reportForRepo) return sections;

  const capabilityByDomain = {
    billing: ["stripe_checkout", "stripe_webhooks"],
    comms: ["telnyx_sms"],
    auth: ["auth"],
    webhooks: ["webhooks_signature_verify"],
    tenancy: ["admin_setup"],
    email: ["email_setup"],
    queue: ["queue_retry"],
    observability: ["observability"],
    e2e: ["e2e"],
    security: ["security_sweep"],
  };

  let authAnyPresent = false;
  let emailAnyPresent = false;
  let observabilityAnyPresent = false;
  for (const cap of reportForRepo.capabilityFindings || []) {
    const id = cap.id;
    const domain = cap.domain;
    const present = cap.present && cap.score >= 50;
    if (domain === "auth" && present) authAnyPresent = true;
    if (domain === "email" && present) emailAnyPresent = true;
    if (domain === "observability" && present) observabilityAnyPresent = true;
    if (id === "billing.stripe.checkout") sections.stripe_checkout = { status: present ? "complete" : "gap", detail: `score=${cap.score}` };
    if (id === "billing.stripe.webhooks") sections.stripe_webhooks = { status: present ? "complete" : "gap", detail: `score=${cap.score} securityCoverage=${cap.securityCoverage}` };
    if (id === "comms.telnyx.sms") sections.telnyx_sms = { status: present ? "complete" : "incomplete", detail: `score=${cap.score}` };
    if (id === "webhooks.signature_verify") sections.webhooks_signature_verify = { status: present ? "complete" : "incomplete", detail: `score=${cap.score}` };
    if (id === "auth.better_auth" || id === "auth.api_key") sections.auth = { status: present ? "complete" : "incomplete", detail: id === "auth.api_key" ? "api-key" : "better-auth" };
    if (id === "tenancy.multitenant") sections.admin_setup = { status: present ? "complete" : "incomplete", detail: `tenant signals=${present}` };
    if (id === "email.maileroo" || id === "email.resend" || domain === "email") sections.email_setup = { status: present ? "complete" : "incomplete", detail: cap.id || "" };
    if (id === "queue.retry_worker" || id === "queue.bullmq") sections.queue_retry = { status: present ? "complete" : "incomplete", detail: `score=${cap.score}` };
    if (id === "observability.logging_health" || id === "observability.logging") sections.observability = { status: present ? "complete" : "incomplete", detail: `score=${cap.score}` };
    if (id === "qa.e2e_playwright") sections.e2e = { status: present ? "complete" : "incomplete", detail: `score=${cap.score}` };
    if (id === "security.runtime_baseline" || id === "security.audit") sections.security_sweep = { status: present ? "complete" : "incomplete", detail: cap.id || `score=${cap.score}` };
  }
  if (!String(sections.auth?.status || "").startsWith("complete") && authAnyPresent) {
    sections.auth = { status: "complete", detail: "auth capability baseline present" };
  }
  if (!String(sections.email_setup?.status || "").startsWith("complete") && emailAnyPresent) {
    sections.email_setup = { status: "complete", detail: "email provider capability present" };
  }
  if (!String(sections.observability?.status || "").startsWith("complete") && observabilityAnyPresent) {
    sections.observability = { status: "complete", detail: "observability capability present" };
  }

  const critical = (reportForRepo.issues || []).filter((i) => i.severity === "critical").length;
  const high = (reportForRepo.issues || []).filter((i) => i.severity === "high").length;
  if (critical > 0 || high > 0) {
    sections.capability_factory_health = { status: "gap", detail: `critical=${critical} high=${high}` };
  } else if (reportForRepo.score >= 65) {
    sections.capability_factory_health = { status: "complete", detail: `score=${reportForRepo.score}` };
  }

  return sections;
}

// Section -> GitHub search query for finding benchmark repos to fill gaps
const SECTION_GITHUB_QUERIES = {
  email_setup: "resend email verification webhook OR maileroo",
  admin_setup: "multitenant organization_id nextjs OR tenant resolver",
  auth: "better-auth",
  stripe_checkout: "stripe checkout session",
  stripe_webhooks: "stripe webhook signature verification idempotency",
  telnyx_sms: "telnyx sms webhook",
  webhooks_signature_verify: "webhook signature verification",
  queue_retry: "bullmq retry queue worker",
  observability: "observability logging metrics audit",
  e2e: "playwright e2e test OR cypress",
  security_sweep: "security audit dependency",
  capability_factory_health: "stripe webhook auth capability",
  feature_benchmark_vs_exemplar: "feature benchmark exemplar",
};

const SECTION_TO_BEST_CASE_KEY = {
  email_setup: "email_delivery",
  admin_setup: "admin_ui",
  auth: "auth",
  stripe_checkout: "stripe_webhooks",
  stripe_webhooks: "stripe_webhooks",
  feature_benchmark_vs_exemplar: "feature_benchmark",
  capability_factory_health: "capability_factory",
};

function buildBenchmarkLookup(sections, bestCaseRef) {
  const lookup = {};
  const incomplete = Object.entries(sections).filter(([, v]) => v.status !== "complete");
  for (const [sectionId, info] of incomplete) {
    const q = SECTION_GITHUB_QUERIES[sectionId] || sectionId.replace(/_/g, " ");
    const encoded = encodeURIComponent(q);
    const refKey = SECTION_TO_BEST_CASE_KEY[sectionId] || sectionId;
    lookup[sectionId] = {
      status: info.status,
      detail: info.detail,
      best_case_ref: bestCaseRef[refKey] || bestCaseRef.admin_ui || bestCaseRef.capability_factory || "",
      github_search_query: q,
      github_search_url: `https://github.com/search?type=repositories&q=${encoded}`,
    };
  }
  return lookup;
}

function runGapForRepo(repoName, dryRun, options = {}) {
  const { fullSummary = false, repoIndex = 0, totalRepos = 1 } = options;
  const repoPath = path.join(CLAW_REPOS, repoName);
  if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
    console.error(`[repo-completion-gap-one] Skip (missing dir): ${repoName}`);
    return null;
  }

  const master = loadMasterList();
  const startedAt = new Date().toISOString();

  // 1) Run capability factory for this repo only
  console.log(`[repo-completion-gap-one] Running capability factory for ${repoName}...`);
  const cfRes = runCapabilityFactory(repoName);
  if (cfRes.status !== 0 && !dryRun) {
    console.error("[repo-completion-gap-one] capability-factory failed:", cfRes.stderr?.slice(0, 500));
  }

  const capReport = readLatestCapabilityReport();
  let reportForRepo = null;
  if (capReport && Array.isArray(capReport.repos)) {
    reportForRepo = capReport.repos.find((r) => r.repo === repoName) || null;
  }

  const issues = reportForRepo?.issues || [];
  const nextActions = [];
  for (const code of ["AUTH_NOT_STANDARDIZED", "STRIPE_WEBHOOK_SECURITY_GAP", "TELNYX_SIGNATURE_VERIFY_MISSING", "MULTITENANT_BASELINE_MISSING", "FORBIDDEN_PATTERN"]) {
    if (issues.some((i) => i.code === code)) {
      if (code === "AUTH_NOT_STANDARDIZED") nextActions.push("Migrate auth to better-auth; remove legacy auth");
      if (code === "STRIPE_WEBHOOK_SECURITY_GAP") nextActions.push("Enforce Stripe webhook signature verification + idempotency");
      if (code === "TELNYX_SIGNATURE_VERIFY_MISSING") nextActions.push("Add Telnyx webhook signature verification");
      if (code === "MULTITENANT_BASELINE_MISSING") nextActions.push("Add tenant resolver and organization_id guardrails");
      if (code === "FORBIDDEN_PATTERN") nextActions.push("Remove placeholder patterns");
    }
  }

  // 2) Optionally run feature benchmark (requires index)
  let featureBenchmarkRun = null;
  const repoKey = `local/${repoName}`;
  const indexDir = path.join(process.env.HOME || require("os").homedir(), ".code-index");
  const indexPath = path.join(indexDir, `${repoKey.replace(/\//g, "-")}.json`);
  if (fs.existsSync(indexPath) && !dryRun) {
    console.log(`[repo-completion-gap-one] Running feature benchmark for local/${repoName}...`);
    featureBenchmarkRun = runFeatureBenchmark(repoName);
  } else if (!fs.existsSync(indexPath)) {
    featureBenchmarkRun = { ok: false, stderr: "index_not_found" };
  }

  const sections = deriveSections(master, reportForRepo);
  if (featureBenchmarkRun?.ok) {
    sections.feature_benchmark_vs_exemplar = { status: "complete", detail: "run completed" };
  } else if (featureBenchmarkRun && !featureBenchmarkRun.ok) {
    sections.feature_benchmark_vs_exemplar = { status: "incomplete", detail: featureBenchmarkRun.stderr?.slice(0, 80) || "not run" };
  }

  // E2E: mark complete if repo has Playwright or Cypress
  if (sections.e2e && sections.e2e.status !== "complete") {
    const hasPlaywright = fs.existsSync(path.join(repoPath, "e2e", "playwright.config.ts")) ||
      fs.existsSync(path.join(repoPath, "e2e", "playwright.config.js")) ||
      fs.existsSync(path.join(repoPath, "playwright.config.ts")) ||
      fs.existsSync(path.join(repoPath, "playwright.config.js"));
    const hasCypress = fs.existsSync(path.join(repoPath, "cypress.config.ts")) ||
      fs.existsSync(path.join(repoPath, "cypress.config.js")) ||
      fs.existsSync(path.join(repoPath, "cypress", "config"));
    if (hasPlaywright || hasCypress) {
      sections.e2e = { status: "complete", detail: hasPlaywright ? "playwright" : "cypress" };
    }
  }

  const benchmark_lookup = buildBenchmarkLookup(sections, master.best_case_sources || {});
  const gapRecord = {
    repo: repoName,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    capability_score: reportForRepo?.score ?? null,
    capability_factory_exit_code: cfRes.status,
    sections,
    issues: issues.map((i) => ({ code: i.code, severity: i.severity, detail: i.detail })),
    next_actions: nextActions,
    best_case_ref: master.best_case_sources || {},
    benchmark_lookup,
    feature_benchmark_run: featureBenchmarkRun?.ok ?? null,
  };

  if (!dryRun) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 24);
    const onePath = path.join(REPORTS_DIR, `repo-completion-gap-${repoName}-${stamp}.json`);
    fs.writeFileSync(onePath, JSON.stringify(gapRecord, null, 2));
    console.log(`[repo-completion-gap-one] Wrote ${onePath}`);

    let rolling = [];
    try {
      rolling = JSON.parse(fs.readFileSync(ROLLING_PATH, "utf8"));
    } catch {
      rolling = [];
    }
    rolling.push(gapRecord);
    fs.writeFileSync(ROLLING_PATH, JSON.stringify(rolling, null, 2));
    console.log(`[repo-completion-gap-one] Appended to ${ROLLING_PATH} (${rolling.length} total)`);
  }

  const incomplete = Object.entries(gapRecord.sections).filter(([, v]) => v.status !== "complete");
  console.log(`[repo-completion-gap-one] ${repoName}: score=${gapRecord.capability_score} incomplete=${incomplete.length} next_actions=${gapRecord.next_actions.length}`);

  if (fullSummary) {
    if (totalRepos > 1) {
      console.log("\n" + "=".repeat(60) + `\n=== Gap summary: ${repoName} (${repoIndex + 1}/${totalRepos}) ===\n` + "=".repeat(60));
    } else {
      console.log("\n=== Gap summary ===");
    }
    console.log(JSON.stringify(gapRecord, null, 2));
    if (incomplete.length) {
      console.log("\nSections to complete:", incomplete.map(([k, v]) => `${k}=${v.status}`).join(", "));
    }
    if (gapRecord.next_actions.length) {
      console.log("\nNext actions:", gapRecord.next_actions.join("; "));
    }
    if (Object.keys(gapRecord.benchmark_lookup).length > 0) {
      console.log("\nBenchmark lookup (GitHub / best-case):");
      for (const [sid, lu] of Object.entries(gapRecord.benchmark_lookup)) {
        console.log(`  ${sid}: ${lu.github_search_url}`);
        if (lu.best_case_ref) console.log(`    best_case: ${lu.best_case_ref}`);
      }
    }
  }
  return gapRecord;
}

function main() {
  const dryRun = hasArg("--dry-run");
  const useNext = hasArg("--next");
  const repoArg = getArg("--repo", null);

  let repoNames = [];
  if (repoArg === "all") {
    repoNames = existingRepos();
    if (!repoNames.length) {
      console.error("No repos found (master list dirs missing under CLAW_REPOS?)");
      process.exit(2);
    }
    console.log(`[repo-completion-gap-one] --repo all => ${repoNames.length} repos`);
  } else if (useNext) {
    const nextRepo = pickNextRepo();
    if (!nextRepo) {
      console.error("No repo found for --next (no existing dirs in master list?)");
      process.exit(2);
    }
    repoNames = [nextRepo];
    console.log(`[repo-completion-gap-one] --next => ${nextRepo}`);
  } else if (repoArg) {
    repoNames = [repoArg];
  }

  if (!repoNames.length) {
    console.error("Usage: node scripts/repo-completion-gap-one.js --repo <name> | --repo all | --next [--dry-run]");
    process.exit(2);
  }

  const results = [];
  const totalRepos = repoNames.length;
  repoNames.forEach((repoName, repoIndex) => {
    const record = runGapForRepo(repoName, dryRun, {
      fullSummary: true,
      repoIndex,
      totalRepos,
    });
    if (record) results.push(record);
  });

  if (totalRepos > 1 && results.length > 0) {
    console.log("\n=== All repos summary ===");
    console.log(`Completed ${results.length}/${totalRepos} repos. Rolling report: ${ROLLING_PATH}`);
  }
}

main();
