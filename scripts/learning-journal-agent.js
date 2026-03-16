#!/usr/bin/env node
"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const pg = require("../infra/postgres");
const { sendEmail } = require("../infra/send-email");
const { resolveRouting, isKnownTaskType } = require("../config/task-routing");
const { validatePayload } = require("../schemas/payloads");
const { buildTaskIdempotencyKey } = require("../control/idempotency");
const { appendAgentDailyLog, STATE_ROOT, ensureDir } = require("../control/agent-memory");
const { enqueueOnce } = require("../core/queue");

const ROOT = path.join(__dirname, "..");
const REPORTS_DIR = path.join(ROOT, "reports");
const AGENT_ID = "learning_journal_agent";
const DEFAULT_EMAIL_TO = process.env.LEARNING_JOURNAL_EMAIL || "creator@localhost";
const ACTIVE_TASK_STATUSES = ["CREATED", "DISPATCHED", "RUNNING", "RETRY", "PENDING_APPROVAL", "PENDING"];

const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(f);
const getArg = (flag, fallback = null) => {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};

const HOURS = Math.max(1, Number(getArg("--hours", "24")) || 24);
const DRY_RUN = hasFlag("--dry-run");
const NO_SWARM = hasFlag("--no-swarm");
const EMAIL_TO = String(getArg("--email-to", process.env.LEARNING_JOURNAL_EMAIL_TO || "")).trim();

function nowIso() {
  return new Date().toISOString();
}

function reportPath(name) {
  return path.join(REPORTS_DIR, name);
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function tryQuery(sql, params = []) {
  try {
    const { rows } = await pg.query(sql, params);
    return rows;
  } catch {
    return null;
  }
}

function compactText(v, max = 220) {
  const s = String(v || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length <= max ? s : `${s.slice(0, max - 1)}...`;
}

async function collectTaskMetrics(hours) {
  const totals = await tryQuery(
    `SELECT
       COUNT(*) FILTER (WHERE created_at >= NOW() - ($1 || ' hours')::interval)::int AS created,
       COUNT(*) FILTER (WHERE completed_at >= NOW() - ($1 || ' hours')::interval AND status = 'COMPLETED')::int AS completed,
       COUNT(*) FILTER (WHERE completed_at >= NOW() - ($1 || ' hours')::interval AND status = 'FAILED')::int AS failed,
       COUNT(*) FILTER (WHERE completed_at >= NOW() - ($1 || ' hours')::interval AND status = 'DEAD_LETTER')::int AS dead_letter,
       COUNT(*) FILTER (WHERE status IN ('CREATED','PENDING','DISPATCHED','RUNNING','RETRY'))::int AS active_open
     FROM tasks`,
    [String(hours)]
  );

  const byType = await tryQuery(
    `SELECT type,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
            COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
            COUNT(*) FILTER (WHERE status = 'DEAD_LETTER')::int AS dead_letter
       FROM tasks
      WHERE COALESCE(completed_at, created_at) >= NOW() - ($1 || ' hours')::interval
      GROUP BY type
      ORDER BY total DESC
      LIMIT 15`,
    [String(hours)]
  );

  const recentCompleted = await tryQuery(
    `SELECT id, type, title, plan_id, completed_at
       FROM tasks
      WHERE status = 'COMPLETED'
        AND completed_at >= NOW() - ($1 || ' hours')::interval
      ORDER BY completed_at DESC
      LIMIT 25`,
    [String(hours)]
  );

  const issuePatterns = await tryQuery(
    `SELECT
       type,
       COALESCE(NULLIF(SPLIT_PART(COALESCE(last_error, ''), E'\\n', 1), ''), 'unknown_error') AS signature,
       COUNT(*)::int AS occurrences,
       MAX(COALESCE(completed_at, created_at)) AS last_seen
     FROM tasks
     WHERE status IN ('FAILED', 'DEAD_LETTER')
       AND COALESCE(completed_at, created_at) >= NOW() - ($1 || ' hours')::interval
     GROUP BY type, COALESCE(NULLIF(SPLIT_PART(COALESCE(last_error, ''), E'\\n', 1), ''), 'unknown_error')
     ORDER BY occurrences DESC, last_seen DESC
     LIMIT 12`,
    [String(hours)]
  );

  const planSummary = await tryQuery(
    `SELECT
       COUNT(*)::int AS plans_created,
       COUNT(*) FILTER (WHERE status = 'completed')::int AS plans_completed,
       COUNT(*) FILTER (WHERE status = 'active')::int AS plans_active,
       AVG(NULLIF(total_tasks, 0))::numeric(10,2) AS avg_tasks_per_plan
     FROM plans
     WHERE created_at >= NOW() - ($1 || ' hours')::interval`,
    [String(hours)]
  );

  return {
    totals: totals?.[0] || null,
    by_type: byType || [],
    recent_completed: recentCompleted || [],
    issue_patterns: issuePatterns || [],
    plan_summary: planSummary?.[0] || null,
  };
}

async function collectResearchMetrics(hours) {
  const signals = await tryQuery(
    `SELECT s.domain_key,
            s.signal_type,
            s.urgency,
            s.requires_action,
            s.summary,
            u.url,
            COALESCE(u.published_at, u.created_at) AS published_at
       FROM external_update_signals s
       JOIN external_updates u ON u.id = s.update_id
      WHERE COALESCE(u.published_at, u.created_at) >= NOW() - ($1 || ' hours')::interval
      ORDER BY COALESCE(u.published_at, u.created_at) DESC
      LIMIT 20`,
    [String(hours)]
  );

  const signalCounts = await tryQuery(
    `SELECT signal_type, urgency, COUNT(*)::int AS count
       FROM external_update_signals s
       JOIN external_updates u ON u.id = s.update_id
      WHERE COALESCE(u.published_at, u.created_at) >= NOW() - ($1 || ' hours')::interval
      GROUP BY signal_type, urgency
      ORDER BY count DESC
      LIMIT 20`,
    [String(hours)]
  );

  const knowledgeRows = await tryQuery(
    `SELECT source_type,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE indexed = TRUE)::int AS indexed_total,
            COUNT(*) FILTER (WHERE created_at >= NOW() - ($1 || ' hours')::interval)::int AS added_in_window
       FROM knowledge_sources
      GROUP BY source_type
      ORDER BY total DESC`,
    [String(hours)]
  );

  const library = await tryQuery(
    `SELECT
       (SELECT COUNT(*)::int FROM symbol_feature_playbooks) AS playbooks_total,
       (SELECT COUNT(*)::int FROM symbol_exemplar_symbols) AS symbol_exemplars_total,
       (SELECT COUNT(*)::int FROM symbol_exemplar_symbols WHERE created_at >= NOW() - ($1 || ' hours')::interval) AS symbol_exemplars_new,
       (SELECT COUNT(*)::int FROM pattern_insights WHERE created_at >= NOW() - ($1 || ' hours')::interval) AS pattern_insights_new,
       (SELECT COUNT(*)::int FROM pattern_insights) AS pattern_insights_total`,
    [String(hours)]
  );

  const files = {
    knowledge_troll_harvest: readJsonSafe(reportPath("knowledge-troll-harvest-latest.json")),
    pattern_robust_builder: readJsonSafe(reportPath("pattern-robust-builder-latest.json")),
    symbolic_qa_hub: readJsonSafe(reportPath("symbolic-qa-hub-latest.json")),
    daily_feature_rotation: readJsonSafe(reportPath("daily-feature-rotation-latest.json")),
    production_kpi_flywheel: readJsonSafe(reportPath("production-kpi-flywheel-latest.json")),
  };

  return {
    signals: signals || [],
    signal_counts: signalCounts || [],
    knowledge_sources: knowledgeRows || [],
    library_snapshot: library?.[0] || null,
    report_files: {
      knowledge_troll_harvest: {
        repos_discovered: Number(files.knowledge_troll_harvest?.repos_discovered || 0),
        papers_discovered: Number(files.knowledge_troll_harvest?.papers_discovered || 0),
        queued_index_subagent_tasks: Array.isArray(files.knowledge_troll_harvest?.queued_index_subagent_tasks)
          ? files.knowledge_troll_harvest.queued_index_subagent_tasks.length
          : 0,
      },
      pattern_robust_builder: {
        playbooks_updated: Array.isArray(files.pattern_robust_builder?.playbooks_updated)
          ? files.pattern_robust_builder.playbooks_updated.length
          : 0,
      },
      symbolic_qa_hub: {
        features: Array.isArray(files.symbolic_qa_hub?.features) ? files.symbolic_qa_hub.features.length : 0,
        repos_missing_index: Array.isArray(files.symbolic_qa_hub?.repos_missing_index)
          ? files.symbolic_qa_hub.repos_missing_index.length
          : 0,
      },
      daily_feature_rotation: {
        repos_considered: Number(files.daily_feature_rotation?.repos_considered || 0),
        queued: Array.isArray(files.daily_feature_rotation?.queued)
          ? files.daily_feature_rotation.queued.length
          : 0,
      },
      production_kpi_flywheel: {
        score: Number(files.production_kpi_flywheel?.score || 0),
        score_delta: Number(files.production_kpi_flywheel?.score_delta || 0),
      },
    },
  };
}

async function collectAgentMemorySignals(hours) {
  const rows = await tryQuery(
    `SELECT agent_id AS agent,
            COUNT(*)::int AS entries,
            SUM(CASE WHEN content_type = 'learned' THEN 1 ELSE 0 END)::int AS learned_entries,
            SUM(CASE WHEN content_type = 'blocker' THEN 1 ELSE 0 END)::int AS blocker_entries,
            SUM(CASE WHEN content_type = 'strategy' THEN 1 ELSE 0 END)::int AS strategy_entries,
            MAX(created_at) AS last_entry_at
       FROM agent_memory
      WHERE created_at >= NOW() - ($1 || ' hours')::interval
      GROUP BY agent_id
      ORDER BY entries DESC
      LIMIT 20`,
    [String(hours)]
  );
  return rows || [];
}

async function ensureRoutingColumns() {
  await pg.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS required_tags TEXT[] DEFAULT '{}'`);
  await pg.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS idempotency_key TEXT`);
}

async function taskExists(idempotencyKey) {
  const { rows } = await pg.query(
    `SELECT 1
       FROM tasks
      WHERE idempotency_key = $1
        AND status = ANY($2::text[])
      LIMIT 1`,
    [idempotencyKey, ACTIVE_TASK_STATUSES]
  );
  return rows.length > 0;
}

async function enqueueTask(type, payload) {
  return enqueueOnce({ type, payload, activeStatuses: ACTIVE_TASK_STATUSES });
}

function buildTopIssues(issuePatterns) {
  return (issuePatterns || [])
    .filter((x) => Number(x.occurrences || 0) > 0)
    .slice(0, 5)
    .map((x) => ({
      type: x.type,
      signature: compactText(x.signature || "unknown_error", 160),
      occurrences: Number(x.occurrences || 0),
      last_seen: x.last_seen,
    }));
}

async function enqueueSwarmActions(report, hours, dryRun) {
  const issuePatterns = buildTopIssues(report?.task_metrics?.issue_patterns || []);
  const hourBucket = new Date().toISOString().slice(0, 13);
  const queued = [];

  for (const issue of issuePatterns.slice(0, 3)) {
    const payload = {
      error: `${issue.type}: ${issue.signature}`,
      context: {
        source: AGENT_ID,
        window_hours: hours,
        occurrences: issue.occurrences,
        last_seen: issue.last_seen,
        hour_bucket: hourBucket,
      },
    };
    if (dryRun) {
      queued.push({ created: false, dry_run: true, type: "triage", payload });
    } else {
      queued.push(await enqueueTask("triage", payload));
    }
  }

  const signalsFound = Array.isArray(report?.research_metrics?.signals)
    ? report.research_metrics.signals.length
    : 0;
  if (signalsFound === 0) {
    const payload = {
      source: AGENT_ID,
      reason: "journal_detected_no_fresh_signals",
      days: Math.max(1, Math.ceil(hours / 24)),
      hour_bucket: hourBucket,
    };
    if (dryRun) {
      queued.push({ created: false, dry_run: true, type: "research_signals", payload });
    } else {
      queued.push(await enqueueTask("research_signals", payload));
    }
  }

  return queued;
}

function buildMarkdownReport(report) {
  const t = report.task_metrics || {};
  const r = report.research_metrics || {};
  const a = report.agent_memory || [];
  const totals = t.totals || {};
  const library = r.library_snapshot || {};

  const lines = [];
  lines.push(`# Learning Journal (${report.window_hours}h)`);
  lines.push("");
  lines.push(`Generated: ${report.generated_at}`);
  lines.push("");
  lines.push("## Progress Snapshot");
  lines.push(`- Tasks created: ${Number(totals.created || 0)}`);
  lines.push(`- Tasks completed: ${Number(totals.completed || 0)}`);
  lines.push(`- Tasks failed: ${Number(totals.failed || 0)}`);
  lines.push(`- Dead letters: ${Number(totals.dead_letter || 0)}`);
  lines.push(`- Active open tasks: ${Number(totals.active_open || 0)}`);
  lines.push("");

  lines.push("## Top Issue Patterns");
  const topIssues = buildTopIssues(t.issue_patterns || []);
  if (!topIssues.length) {
    lines.push("- No repeated failure patterns detected in this window.");
  } else {
    for (const issue of topIssues) {
      lines.push(`- ${issue.type}: ${issue.signature} (x${issue.occurrences})`);
    }
  }
  lines.push("");

  lines.push("## AI/News/Library Research");
  lines.push(`- External signals captured: ${Array.isArray(r.signals) ? r.signals.length : 0}`);
  lines.push(`- Knowledge repos discovered (latest): ${Number(r.report_files?.knowledge_troll_harvest?.repos_discovered || 0)}`);
  lines.push(`- Knowledge papers discovered (latest): ${Number(r.report_files?.knowledge_troll_harvest?.papers_discovered || 0)}`);
  lines.push(`- Pattern insights new (${report.window_hours}h): ${Number(library.pattern_insights_new || 0)}`);
  lines.push(`- Symbol exemplar additions (${report.window_hours}h): ${Number(library.symbol_exemplars_new || 0)}`);
  lines.push("");

  lines.push("## Agent Activity");
  if (!a.length) {
    lines.push("- No agent_memory rows found in the current window.");
  } else {
    for (const row of a.slice(0, 10)) {
      lines.push(`- ${row.agent}: entries=${row.entries}, blockers=${row.blocker_entries}, learned=${row.learned_entries}, strategy=${row.strategy_entries}`);
    }
  }

  if (Array.isArray(report.swarm_actions) && report.swarm_actions.length) {
    lines.push("");
    lines.push("## Swarm Follow-ups Queued");
    for (const q of report.swarm_actions) {
      const suffix = q.created ? `id=${q.id}` : q.reason || (q.dry_run ? "dry_run" : "not_created");
      lines.push(`- ${q.type}: ${suffix}`);
    }
  }

  return lines.join("\n") + "\n";
}

function toHtml(report, markdown) {
  const esc = (s) => String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");

  const topDone = (report.task_metrics?.recent_completed || []).slice(0, 12);
  const topIssues = buildTopIssues(report.task_metrics?.issue_patterns || []).slice(0, 8);
  const topSignals = (report.research_metrics?.signals || []).slice(0, 8);

  const doneRows = topDone.map((x) => `<li><b>${esc(x.type)}</b> ${esc(compactText(x.title || x.id, 120))} <i>${esc(x.completed_at || "")}</i></li>`).join("");
  const issueRows = topIssues.map((x) => `<li><b>${esc(x.type)}</b> ${esc(x.signature)} (x${x.occurrences})</li>`).join("");
  const signalRows = topSignals.map((x) => `<li><b>[${esc(x.urgency)}]</b> ${esc(x.summary)} ${x.url ? `(<a href=\"${esc(x.url)}\">source</a>)` : ""}</li>`).join("");

  return `<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Arial, sans-serif; color: #111; line-height: 1.45;">
    <h2>OpenClaw Learning Journal - Last ${report.window_hours} Hours</h2>
    <p><b>Generated:</b> ${esc(report.generated_at)}</p>

    <h3>System Progress</h3>
    <ul>
      <li>Tasks created: <b>${Number(report.task_metrics?.totals?.created || 0)}</b></li>
      <li>Tasks completed: <b>${Number(report.task_metrics?.totals?.completed || 0)}</b></li>
      <li>Tasks failed: <b>${Number(report.task_metrics?.totals?.failed || 0)}</b></li>
      <li>Dead letters: <b>${Number(report.task_metrics?.totals?.dead_letter || 0)}</b></li>
      <li>Active open tasks: <b>${Number(report.task_metrics?.totals?.active_open || 0)}</b></li>
    </ul>

    <h3>What Was Done</h3>
    <ul>${doneRows || "<li>No completed task records in this window.</li>"}</ul>

    <h3>Recurring Issue Patterns</h3>
    <ul>${issueRows || "<li>No repeated issue patterns detected.</li>"}</ul>

    <h3>AI/News/Library Findings</h3>
    <ul>
      <li>External update signals: <b>${Array.isArray(report.research_metrics?.signals) ? report.research_metrics.signals.length : 0}</b></li>
      <li>Knowledge repos discovered (latest): <b>${Number(report.research_metrics?.report_files?.knowledge_troll_harvest?.repos_discovered || 0)}</b></li>
      <li>Knowledge papers discovered (latest): <b>${Number(report.research_metrics?.report_files?.knowledge_troll_harvest?.papers_discovered || 0)}</b></li>
      <li>Symbol exemplar additions (${report.window_hours}h): <b>${Number(report.research_metrics?.library_snapshot?.symbol_exemplars_new || 0)}</b></li>
      <li>Pattern insights added (${report.window_hours}h): <b>${Number(report.research_metrics?.library_snapshot?.pattern_insights_new || 0)}</b></li>
    </ul>
    <ul>${signalRows || "<li>No fresh external signals captured in this window.</li>"}</ul>

    <h3>Swarm Follow-ups</h3>
    <ul>
      ${(report.swarm_actions || []).map((x) => `<li>${esc(x.type)}: ${esc(x.created ? `queued ${x.id || ""}` : x.reason || (x.dry_run ? "dry_run" : "not_queued"))}</li>`).join("") || "<li>No follow-up actions were queued.</li>"}
    </ul>

    <h3>Journal Markdown</h3>
    <pre style="white-space: pre-wrap; background: #f8f8f8; padding: 12px; border-radius: 8px;">${esc(markdown)}</pre>
  </body>
</html>`;
}

function updateSharedJournalFiles(markdown) {
  ensureDir(path.join(STATE_ROOT, "shared-context"));
  ensureDir(path.join(STATE_ROOT, "handoffs"));

  const journalPath = path.join(STATE_ROOT, "shared-context", "JOURNAL-LATEST.md");
  fs.writeFileSync(journalPath, markdown, "utf8");

  const intelPath = path.join(STATE_ROOT, "handoffs", "DAILY-INTEL.md");
  const prev = fs.existsSync(intelPath) ? fs.readFileSync(intelPath, "utf8") : "# Daily Intel\n\n";
  const stamp = new Date().toISOString();
  const block = [
    `## ${stamp} learning_journal_agent`,
    "",
    ...markdown.split("\n").slice(0, 30),
    "",
  ].join("\n");

  // Keep handoff bounded for prompt efficiency.
  const next = `${block}\n${prev}`.slice(0, 22000);
  fs.writeFileSync(intelPath, next, "utf8");
}

async function maybeSendEmail(report, markdown) {
  const to = EMAIL_TO || (hasFlag("--email") ? DEFAULT_EMAIL_TO : "");
  if (!to) return { sent: false, reason: "email_not_requested" };

  const fromEmail = String(process.env.MAILEROO_FROM_EMAIL || process.env.EMAIL_FROM || "").trim();
  if (!fromEmail) {
    return { sent: false, reason: "missing_from_email" };
  }

  const subject = `OpenClaw Daily Learning Journal - ${new Date().toISOString().slice(0, 10)} (${report.window_hours}h)`;
  const html = toHtml(report, markdown);
  const plain = markdown;

  if (DRY_RUN) {
    return { sent: false, dry_run: true, to, subject };
  }

  try {
    const result = await sendEmail({
      to,
      subject,
      html,
      plain,
      fromName: process.env.MAILEROO_FROM_NAME || "OpenClaw Journal",
      fromEmail,
      provider: process.env.JOURNAL_EMAIL_PROVIDER || undefined,
    });

    return {
      sent: Number(result?.status || 0) >= 200 && Number(result?.status || 0) < 300,
      to,
      status: result?.status || 0,
      provider: result?.provider || null,
      messageId: result?.messageId || null,
    };
  } catch (err) {
    return {
      sent: false,
      to,
      reason: "send_failed",
      error: compactText(err.message || "unknown send error", 240),
    };
  }
}

async function main() {
  const generatedAt = nowIso();
  const taskMetrics = await collectTaskMetrics(HOURS);
  const researchMetrics = await collectResearchMetrics(HOURS);
  const agentMemory = await collectAgentMemorySignals(HOURS);

  const report = {
    ok: true,
    generated_at: generatedAt,
    agent_id: AGENT_ID,
    window_hours: HOURS,
    task_metrics: taskMetrics,
    research_metrics: researchMetrics,
    agent_memory: agentMemory,
    swarm_actions: [],
    email: null,
    dry_run: DRY_RUN,
  };

  if (!NO_SWARM) {
    report.swarm_actions = await enqueueSwarmActions(report, HOURS, DRY_RUN);
  }

  const markdown = buildMarkdownReport(report);
  updateSharedJournalFiles(markdown);

  ensureDir(REPORTS_DIR);
  const stampedJson = reportPath(`${Date.now()}-learning-journal.json`);
  const latestJson = reportPath("learning-journal-latest.json");
  const latestMd = reportPath("learning-journal-latest.md");
  fs.writeFileSync(stampedJson, JSON.stringify(report, null, 2), "utf8");
  fs.writeFileSync(latestJson, JSON.stringify(report, null, 2), "utf8");
  fs.writeFileSync(latestMd, markdown, "utf8");

  report.email = await maybeSendEmail(report, markdown);
  fs.writeFileSync(latestJson, JSON.stringify(report, null, 2), "utf8");

  await appendAgentDailyLog(AGENT_ID, {
    goal: `Analyze last ${HOURS}h system output, identify patterns, and publish journal handoff`,
    task_type: "learning_journal",
    summary: `status=ok | completed=${Number(taskMetrics?.totals?.completed || 0)} failed=${Number(taskMetrics?.totals?.failed || 0)} dead_letter=${Number(taskMetrics?.totals?.dead_letter || 0)} signals=${Array.isArray(researchMetrics?.signals) ? researchMetrics.signals.length : 0}`,
    learned: `Top issue patterns tracked=${buildTopIssues(taskMetrics?.issue_patterns || []).length}; library_delta_symbols=${Number(researchMetrics?.library_snapshot?.symbol_exemplars_new || 0)}; pattern_insights_new=${Number(researchMetrics?.library_snapshot?.pattern_insights_new || 0)}`,
    metrics: {
      tasks_completed: Number(taskMetrics?.totals?.completed || 0),
      tasks_failed: Number(taskMetrics?.totals?.failed || 0),
      dead_letter: Number(taskMetrics?.totals?.dead_letter || 0),
      issue_patterns: buildTopIssues(taskMetrics?.issue_patterns || []).length,
      signals: Array.isArray(researchMetrics?.signals) ? researchMetrics.signals.length : 0,
      swarm_actions: Array.isArray(report.swarm_actions) ? report.swarm_actions.length : 0,
    },
    next_focus: "Use top issue signatures to drive targeted triage and reduce repeated failures in next cycle.",
    tags: ["journal", "learning", "patterns", "swarm", "research"],
    model_used: "learning-journal-agent",
    cost_usd: 0,
    open_loops: report.email?.sent ? [] : ["Daily email not sent; verify email sender configuration if expected."],
  }).catch(() => {});

  console.log(JSON.stringify({
    ok: true,
    generated_at: generatedAt,
    report: {
      latest_json: latestJson,
      latest_md: latestMd,
    },
    swarm_actions: report.swarm_actions,
    email: report.email,
  }, null, 2));
}

main()
  .catch((err) => {
    console.error("[learning-journal-agent] fatal:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pg.end().catch(() => {});
  });
