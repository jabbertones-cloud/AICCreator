#!/usr/bin/env node
"use strict";

/**
 * builder-research-agenda.js
 * Build a prioritized research agenda from repo-completion gap reports so the builder
 * (and InayanBuilderBot) can find better ways to discover incomplete/gaps/issues to research.
 * Consumes rolling gap report or latest per-repo gap; emits JSON + MD with GitHub/Reddit
 * search targets and issue-to-research mapping.
 *
 * Usage:
 *   node scripts/builder-research-agenda.js --rolling
 *   node scripts/builder-research-agenda.js --repo <name>
 *   node scripts/builder-research-agenda.js --repo <name1>,<name2>
 */

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "../.env") });

const ROOT = path.join(__dirname, "..");
const REPORTS_DIR = path.join(ROOT, "reports");
const ROLLING_PATH = path.join(REPORTS_DIR, "repo-completion-gap-rolling.json");
const OUT_JSON = path.join(REPORTS_DIR, "builder-research-agenda-latest.json");
const OUT_MD = path.join(REPORTS_DIR, "builder-research-agenda-latest.md");

function getArg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  const v = String(process.argv[i + 1] || "").trim();
  return v || fallback;
}

function hasArg(flag) {
  return process.argv.includes(flag);
}

// Suggested Reddit/search queries per section (for builder to run in addition to GitHub)
const SECTION_REDDIT_QUERIES = {
  email_setup: "resend maileroo email verification webhook setup",
  admin_setup: "multitenant nextjs tenant resolver organization_id",
  auth: "better-auth nextjs authentication",
  stripe_checkout: "stripe checkout session nextjs",
  stripe_webhooks: "stripe webhook signature verification idempotency",
  telnyx_sms: "telnyx sms webhook verification",
  webhooks_signature_verify: "webhook signature verification best practices",
  queue_retry: "bullmq retry queue worker node",
  observability: "observability logging metrics node express",
  e2e: "playwright cypress e2e testing",
  security_sweep: "npm audit security dependency",
  capability_factory_health: "stripe webhook auth capability patterns",
};

// Issue code -> suggested research/fix query
const ISSUE_RESEARCH_SUGGESTION = {
  AUTH_NOT_STANDARDIZED: "better-auth migration from next-auth",
  STRIPE_WEBHOOK_SECURITY_GAP: "stripe webhook signature verification idempotency",
  TELNYX_SIGNATURE_VERIFY_MISSING: "telnyx webhook signature verification",
  MULTITENANT_BASELINE_MISSING: "multitenant tenant resolver nextjs",
  FORBIDDEN_PATTERN: "remove placeholder/example-domain patterns",
};

function latestGapFileForRepo(repoName) {
  const base = `repo-completion-gap-${repoName}-`;
  let best = null;
  let bestTime = "";
  try {
    const files = fs.readdirSync(REPORTS_DIR);
    for (const f of files) {
      if (f.startsWith(base) && f.endsWith(".json") && f.length > base.length) {
        const stamp = f.slice(base.length, -5);
        if (stamp > bestTime) {
          bestTime = stamp;
          best = path.join(REPORTS_DIR, f);
        }
      }
    }
  } catch {
    // ignore
  }
  return best;
}

function loadRecords(reposArg, useRolling) {
  let records = [];
  if (useRolling) {
    if (!fs.existsSync(ROLLING_PATH)) return [];
    const raw = fs.readFileSync(ROLLING_PATH, "utf8");
    const data = JSON.parse(raw);
    records = Array.isArray(data) ? data : [data];
    const byRepo = new Map();
    for (const r of records) {
      if (r.repo) byRepo.set(r.repo, r);
    }
    records = Array.from(byRepo.values());
  } else if (reposArg) {
    const repoNames = reposArg.split(",").map((s) => s.trim()).filter(Boolean);
    for (const repo of repoNames) {
      const fp = latestGapFileForRepo(repo);
      if (fp) {
        const raw = fs.readFileSync(fp, "utf8");
        const one = JSON.parse(raw);
        records.push(Array.isArray(one) ? one[0] : one);
      }
    }
  }
  return records;
}

function hasGaps(record) {
  if (!record?.sections) return false;
  const incomplete = Object.values(record.sections).filter((v) => v && v.status !== "complete");
  if (incomplete.length > 0) return true;
  return Array.isArray(record.next_actions) && record.next_actions.length > 0;
}

function buildResearchAgenda(records) {
  const agenda = {
    generated_at: new Date().toISOString(),
    repos_with_gaps: 0,
    research_targets: [],
    issues_to_research: [],
    next_actions_to_research: [],
    by_repo: {},
  };

  for (const record of records) {
    if (!hasGaps(record)) continue;
    const repo = record.repo || "unknown";
    agenda.repos_with_gaps += 1;

    const repoTargets = [];
    const lookup = record.benchmark_lookup || {};

    for (const [sectionId, lu] of Object.entries(lookup)) {
      const redditQuery = SECTION_REDDIT_QUERIES[sectionId] || lu.github_search_query || sectionId.replace(/_/g, " ");
      repoTargets.push({
        section_id: sectionId,
        status: lu.status,
        detail: lu.detail,
        github_search_query: lu.github_search_query,
        github_search_url: lu.github_search_url,
        best_case_ref: lu.best_case_ref || "",
        reddit_search_suggestion: redditQuery,
      });
      agenda.research_targets.push({
        repo,
        section_id: sectionId,
        status: lu.status,
        github_search_query: lu.github_search_query,
        github_search_url: lu.github_search_url,
        best_case_ref: lu.best_case_ref || "",
        reddit_search_suggestion: redditQuery,
      });
    }

    for (const issue of record.issues || []) {
      const suggestion = ISSUE_RESEARCH_SUGGESTION[issue.code] || issue.detail;
      agenda.issues_to_research.push({
        repo,
        code: issue.code,
        severity: issue.severity,
        detail: issue.detail,
        research_suggestion: suggestion,
      });
    }

    for (const action of record.next_actions || []) {
      agenda.next_actions_to_research.push({
        repo,
        next_action: action,
        research_suggestion: action,
      });
    }

    agenda.by_repo[repo] = {
      capability_score: record.capability_score,
      incomplete_sections: Object.entries(record.sections || {}).filter(([, v]) => v && v.status !== "complete").map(([k, v]) => ({ id: k, status: v.status, detail: v.detail })),
      research_targets: repoTargets,
      issues: (record.issues || []).map((i) => ({ code: i.code, severity: i.severity, detail: i.detail })),
      next_actions: record.next_actions || [],
    };
  }

  return agenda;
}

function markdownReport(agenda) {
  const lines = [
    "# Builder research agenda",
    "",
    "Prioritized list of incomplete sections, issues, and next actions with suggested GitHub and Reddit searches for the builder (and InayanBuilderBot) to research.",
    "",
    `Generated: ${agenda.generated_at} | Repos with gaps: ${agenda.repos_with_gaps}`,
    "",
    "---",
    "",
  ];

  if (agenda.repos_with_gaps === 0) {
    lines.push("No repos with gaps in the selected report(s).");
    return lines.join("\n");
  }

  for (const [repo, data] of Object.entries(agenda.by_repo)) {
    lines.push(`## ${repo} (score=${data.capability_score ?? "—"})`);
    lines.push("");
    lines.push("### Incomplete sections → research targets");
    lines.push("");
    for (const t of data.research_targets) {
      lines.push(`- **${t.section_id}** (${t.status})`);
      lines.push(`  - GitHub: [\`${t.github_search_query}\`](${t.github_search_url})`);
      lines.push(`  - Reddit/search: \`${t.reddit_search_suggestion}\``);
      if (t.best_case_ref) lines.push(`  - Best-case ref: ${t.best_case_ref}`);
      lines.push("");
    }
    if (data.issues.length) {
      lines.push("### Issues to research");
      lines.push("");
      for (const i of data.issues) {
        const suggestion = ISSUE_RESEARCH_SUGGESTION[i.code] || i.detail;
        lines.push(`- **${i.code}** (${i.severity}): ${i.detail}`);
        lines.push(`  - Research: \`${suggestion}\``);
        lines.push("");
      }
    }
    if (data.next_actions.length) {
      lines.push("### Next actions");
      lines.push("");
      for (const a of data.next_actions) lines.push(`- ${a}`);
      lines.push("");
    }
    lines.push("---");
    lines.push("");
  }

  lines.push("## How the builder uses this");
  lines.push("");
  lines.push("1. **Gap pulse:** `npm run builder:gap:pulse -- --repos <name>` runs gap analysis and queues repo_autofix + opencode_controller with gap context (benchmark_lookup, issues, quality_gate_scripts).");
  lines.push("2. **Research agenda:** This file and `builder-research-agenda-latest.json` list per-repo GitHub search URLs and Reddit/search suggestions for each incomplete section and issue.");
  lines.push("3. **Benchmark lookup:** `npm run repo:benchmark:lookup -- --repo <name>` or `--rolling` produces `repo-completion-benchmark-lookup-latest.md` with the same GitHub links.");
  lines.push("4. **Quality gates:** Before considering a build complete, run and pass the repo's check/build, lint, test, test:e2e (when defined). repo_autofix runs these; see docs/BUILDER-PROFESSIONAL-COMPLETION.md.");
  lines.push("5. **InayanBuilderBot:** Can consume this JSON or the benchmark lookup report to drive Reddit/GitHub research stages and filter candidates by section_id.");
  lines.push("");

  return lines.join("\n");
}

function main() {
  const reposArg = getArg("--repo", null);
  const useRolling = hasArg("--rolling");

  if (!reposArg && !useRolling) {
    console.error("Usage: node scripts/builder-research-agenda.js --rolling | --repo InayanBuilderBot[,CaptureInbound]");
    process.exit(2);
  }

  const records = loadRecords(reposArg, useRolling);
  const agenda = buildResearchAgenda(records);

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(agenda, null, 2));
  fs.writeFileSync(OUT_MD, markdownReport(agenda));

  console.log("[builder-research-agenda] Wrote", OUT_JSON);
  console.log("[builder-research-agenda] Wrote", OUT_MD);
  console.log("[builder-research-agenda] Repos with gaps:", agenda.repos_with_gaps, "| Research targets:", agenda.research_targets.length, "| Issues:", agenda.issues_to_research.length);
}

main();
