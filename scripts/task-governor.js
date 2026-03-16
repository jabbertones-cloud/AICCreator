#!/usr/bin/env node
"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const pg = require("../infra/postgres");
const { createToolBudget } = require("../control/mcp-tool-budget");

const ROOT = path.join(__dirname, "..");
const REPORTS_DIR = path.join(ROOT, "reports");
const GOVERNOR_LOCK_KEY = 91020401;

const DRY_RUN = process.argv.includes("--dry-run");
const USE_LLM = ["1", "true", "yes", "on"].includes(String(process.env.TASK_GOVERNOR_USE_LLM || "false").toLowerCase());

const THRESHOLDS = {
  deadLetterCritical: Number(process.env.TASK_GOVERNOR_DLQ_CRIT || 1),
  staleDispatchedCritical: Number(process.env.TASK_GOVERNOR_STALE_DISPATCHED_CRIT || 10),
  staleCreatedCritical: Number(process.env.TASK_GOVERNOR_STALE_CREATED_CRIT || 20),
  staleRunningCritical: Number(process.env.TASK_GOVERNOR_STALE_RUNNING_CRIT || 8),
  queueBacklogHigh: Number(process.env.TASK_GOVERNOR_QUEUE_HIGH || 250),
  throughputLowPerHour: Number(process.env.TASK_GOVERNOR_TPUT_LOW || 20),
  loopStaleTypeCritical: Number(process.env.TASK_GOVERNOR_LOOP_STALE_TYPE_CRIT || 60),
  progressTopSharePct: Number(process.env.TASK_GOVERNOR_PROGRESS_TOP_SHARE_PCT || 70),
};

const ACTIVE_STATUSES = ["CREATED", "PENDING", "DISPATCHED", "RUNNING", "RETRY"];
let RAW_QUERY_REF = null;

function cap(text, n = 3000) {
  const s = String(text || "");
  return s.length <= n ? s : `${s.slice(0, n)}\n...[truncated]`;
}

function createRunBudget() {
  return createToolBudget({
    maxCalls: Number(process.env.TASK_GOVERNOR_TOOL_BUDGET_MAX_CALLS || process.env.MCP_TOOL_BUDGET_MAX_CALLS || 60),
    maxTokensPerTool: Number(process.env.TASK_GOVERNOR_TOOL_BUDGET_MAX_TOKENS_PER_TOOL || process.env.MCP_TOOL_BUDGET_MAX_TOKENS_PER_TOOL || 12000),
    maxTokensTotal: Number(process.env.TASK_GOVERNOR_TOOL_BUDGET_MAX_TOKENS_TOTAL || process.env.MCP_TOOL_BUDGET_MAX_TOKENS_TOTAL || 120000),
  });
}

function runCommand(cmd, args, timeoutMs = 10 * 60 * 1000, budget = null, toolName = "shell_command") {
  const started = new Date().toISOString();
  const commandStr = [cmd, ...args].join(" ");
  const guard = budget ? budget.record(toolName, commandStr) : { allowed: true, violations: [] };
  if (!guard.allowed) {
    return {
      command: commandStr,
      started_at: started,
      finished_at: new Date().toISOString(),
      ok: false,
      blocked_by_budget: true,
      code: 429,
      stdout_tail: "",
      stderr_tail: `tool_budget_exceeded: ${guard.violations.join(", ")}`,
      error: `tool_budget_exceeded: ${guard.violations.join(", ")}`,
    };
  }
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    env: process.env,
  });
  return {
    command: commandStr,
    started_at: started,
    finished_at: new Date().toISOString(),
    ok: Number(res.status || 0) === 0,
    code: Number(res.status || 0),
    stdout_tail: cap(res.stdout, 2500),
    stderr_tail: cap(res.stderr, 2500),
    error: res.error ? String(res.error.message || res.error) : null,
  };
}

async function collectMetrics() {
  const statusCounts = await pg.query(
    `SELECT status, count(*)::int AS n
       FROM tasks
      GROUP BY status`
  );

  const freshness = await pg.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'DEAD_LETTER')::int AS dead_letter,
       COUNT(*) FILTER (WHERE status IN ('CREATED','PENDING') AND created_at < NOW() - INTERVAL '30 minutes')::int AS stale_created,
       COUNT(*) FILTER (WHERE status = 'DISPATCHED' AND updated_at < NOW() - INTERVAL '20 minutes')::int AS stale_dispatched,
       COUNT(*) FILTER (WHERE status = 'RUNNING' AND updated_at < NOW() - INTERVAL '90 minutes')::int AS stale_running,
       COUNT(*) FILTER (WHERE status = ANY($1::text[]))::int AS active_backlog,
       COUNT(*) FILTER (WHERE status = 'COMPLETED' AND completed_at >= NOW() - INTERVAL '60 minutes')::int AS completed_1h,
       COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '60 minutes')::int AS created_1h
     FROM tasks`,
    [ACTIVE_STATUSES]
  );

  const topErrors = await pg.query(
    `SELECT COALESCE(last_error, dead_letter_reason, 'unknown') AS err, COUNT(*)::int AS n
       FROM tasks
      WHERE status = 'DEAD_LETTER'
      GROUP BY err
      ORDER BY n DESC
      LIMIT 8`
  );

  const staleByType = await pg.query(
    `SELECT type, count(*)::int AS n
       FROM tasks
      WHERE status IN ('CREATED','PENDING','DISPATCHED')
        AND created_at < NOW() - INTERVAL '45 minutes'
      GROUP BY type
      ORDER BY n DESC
      LIMIT 20`
  );

  const activeByType = await pg.query(
    `SELECT type, status, count(*)::int AS n
       FROM tasks
      WHERE status = ANY($1::text[])
      GROUP BY type, status
      ORDER BY n DESC
      LIMIT 40`,
    [ACTIVE_STATUSES]
  );

  const completionMix = await pg.query(
    `SELECT type, count(*)::int AS n
       FROM tasks
      WHERE status = 'COMPLETED'
        AND completed_at >= NOW() - INTERVAL '60 minutes'
      GROUP BY type
      ORDER BY n DESC
      LIMIT 12`
  );

  const duplicateKeys = await pg.query(
    `SELECT type, idempotency_key, count(*)::int AS n
       FROM tasks
      WHERE status = ANY($1::text[])
        AND COALESCE(idempotency_key,'') <> ''
      GROUP BY type, idempotency_key
      HAVING count(*) > 3
      ORDER BY n DESC
      LIMIT 25`,
    [ACTIVE_STATUSES]
  );

  const completedTotal = (completionMix.rows || []).reduce((acc, r) => acc + Number(r.n || 0), 0);
  const topCompleted = completionMix.rows?.[0] || null;
  const topSharePct = completedTotal > 0 ? Math.round((Number(topCompleted?.n || 0) / completedTotal) * 100) : 0;

  return {
    by_status: statusCounts.rows,
    freshness: freshness.rows[0] || {},
    dead_letter_top_errors: topErrors.rows || [],
    stale_by_type_45m: staleByType.rows || [],
    active_by_type: activeByType.rows || [],
    completion_mix_1h: completionMix.rows || [],
    duplicate_idempotency_families: duplicateKeys.rows || [],
    productivity: {
      completed_total_1h: completedTotal,
      top_completed_type: topCompleted?.type || null,
      top_completed_count: Number(topCompleted?.n || 0),
      top_completed_share_pct: topSharePct,
    },
  };
}

function evaluateRisks(metrics, checks) {
  const f = metrics.freshness || {};
  const p = metrics.productivity || {};
  const risks = [];

  if (!checks.runtime_audit.ok) risks.push({ level: "critical", key: "runtime_audit_failed", detail: "runtime-audit failed" });
  if (!checks.task_contract.ok) risks.push({ level: "critical", key: "task_contract_mismatch", detail: "task contract audit failed" });
  if (!checks.schema_audit.ok) risks.push({ level: "critical", key: "schema_mismatch", detail: "schema audit failed" });
  if (!checks.bind_guard.ok) risks.push({ level: "critical", key: "bind_security_regression", detail: "bind guard failed" });
  if (!checks.progress_integrity.ok) {
    risks.push({ level: "high", key: "progress_integrity_failed", detail: "progress integrity audit failed" });
  }

  if (Number(f.dead_letter || 0) >= THRESHOLDS.deadLetterCritical) {
    risks.push({ level: "critical", key: "dead_letter_backlog", detail: `dead_letter=${f.dead_letter}` });
  }
  if (Number(f.stale_dispatched || 0) >= THRESHOLDS.staleDispatchedCritical) {
    risks.push({ level: "high", key: "stale_dispatched", detail: `stale_dispatched=${f.stale_dispatched}` });
  }
  if (Number(f.stale_created || 0) >= THRESHOLDS.staleCreatedCritical) {
    risks.push({ level: "high", key: "stale_created", detail: `stale_created=${f.stale_created}` });
  }
  if (Number(f.stale_running || 0) >= THRESHOLDS.staleRunningCritical) {
    risks.push({ level: "high", key: "stale_running", detail: `stale_running=${f.stale_running}` });
  }
  if (
    Number(f.active_backlog || 0) >= THRESHOLDS.queueBacklogHigh &&
    Number(f.completed_1h || 0) < THRESHOLDS.throughputLowPerHour
  ) {
    risks.push({
      level: "high",
      key: "throughput_stall",
      detail: `active_backlog=${f.active_backlog}, completed_1h=${f.completed_1h}`,
    });
  }

  const worstStaleType = (metrics.stale_by_type_45m || [])[0];
  if (Number(worstStaleType?.n || 0) >= THRESHOLDS.loopStaleTypeCritical) {
    risks.push({
      level: "high",
      key: "loop_pressure",
      detail: `stale_45m_top_type=${worstStaleType.type}:${worstStaleType.n}`,
    });
  }

  if ((metrics.duplicate_idempotency_families || []).length > 0) {
    risks.push({
      level: "high",
      key: "duplicate_idempotency_loops",
      detail: `families=${metrics.duplicate_idempotency_families.length}`,
    });
  }

  if (
    Number(p.top_completed_share_pct || 0) >= THRESHOLDS.progressTopSharePct &&
    Number(f.stale_created || 0) >= THRESHOLDS.staleCreatedCritical
  ) {
    risks.push({
      level: "high",
      key: "progress_pattern",
      detail: `top_completed_share_pct=${p.top_completed_share_pct}, stale_created=${f.stale_created}`,
    });
  }

  return risks;
}

function decideActions(risks) {
  const actions = [];
  const has = (key) => risks.some((r) => r.key === key);

  if (has("dead_letter_backlog")) {
    actions.push({
      id: "reconcile_deadletters",
      kind: "command",
      reason: "Dead-letter backlog detected",
      cmd: "npm",
      args: ["run", "-s", "tasks:reconcile-deadletters", "--", "--requeue"],
    });
  }

  if (has("loop_pressure") || has("duplicate_idempotency_loops") || has("progress_pattern")) {
    actions.push({
      id: "prune_loop_duplicates",
      kind: "internal",
      reason: "Loop pattern detected in stale active queue",
    });
  }

  if (has("stale_dispatched") || has("stale_running") || has("runtime_audit_failed")) {
    actions.push({
      id: "uptime_watchdog_recovery",
      kind: "command",
      reason: "Runtime staleness detected",
      cmd: "node",
      args: ["scripts/uptime-watchdog-hourly.js", "--no-diagnosis"],
    });
  }

  if (has("throughput_stall") || has("stale_created") || has("progress_pattern")) {
    actions.push({
      id: "forward_progress_enforcer",
      kind: "command",
      reason: "Force measurable product progress",
      cmd: "npm",
      args: ["run", "-s", "progress:enforce"],
    });
  }

  if (has("progress_integrity_failed")) {
    actions.push({
      id: "forward_progress_enforcer_integrity",
      kind: "command",
      reason: "Progress integrity failure requires explicit net movement enforcement",
      cmd: "npm",
      args: ["run", "-s", "progress:enforce"],
    });
  }

  if (has("task_contract_mismatch")) {
    actions.push({
      id: "recheck_contract_alignment",
      kind: "command",
      reason: "Task contract mismatch",
      cmd: "npm",
      args: ["run", "-s", "audit:tasks"],
    });
  }

  if (has("schema_mismatch")) {
    actions.push({
      id: "recheck_schema_alignment",
      kind: "command",
      reason: "Schema mismatch",
      cmd: "npm",
      args: ["run", "-s", "schema:audit:json"],
    });
  }

  return actions;
}

async function pruneLoopDuplicates() {
  const res = await pg.query(
    `WITH ranked AS (
       SELECT
         id,
         type,
         idempotency_key,
         status,
         created_at,
         ROW_NUMBER() OVER (
           PARTITION BY type, idempotency_key
           ORDER BY
             CASE status
               WHEN 'RUNNING' THEN 1
               WHEN 'DISPATCHED' THEN 2
               WHEN 'RETRY' THEN 3
               WHEN 'PENDING' THEN 4
               WHEN 'CREATED' THEN 5
               ELSE 6
             END,
             created_at DESC
         ) AS rn
       FROM tasks
       WHERE status = ANY($1::text[])
         AND COALESCE(idempotency_key,'') <> ''
         AND created_at < NOW() - INTERVAL '30 minutes'
     ), victims AS (
       SELECT id
       FROM ranked
       WHERE rn > 1
       ORDER BY created_at ASC
       LIMIT 400
     )
     UPDATE tasks t
        SET status = 'CANCELLED',
            completed_at = NOW(),
            updated_at = NOW(),
            last_error = COALESCE(t.last_error,'') || ' [task-governor:loop-pruned]'
      WHERE t.id IN (SELECT id FROM victims)
      RETURNING t.id, t.type, t.idempotency_key`,
    [ACTIVE_STATUSES]
  );

  return {
    ok: true,
    pruned: res.rowCount || 0,
    sample: (res.rows || []).slice(0, 20),
  };
}

async function executeAction(action, budget = null) {
  if (action.kind === "internal" && action.id === "prune_loop_duplicates") {
    const started = new Date().toISOString();
    const out = await pruneLoopDuplicates();
    return {
      ...action,
      started_at: started,
      finished_at: new Date().toISOString(),
      ok: !!out.ok,
      code: out.ok ? 0 : 1,
      stdout_tail: cap(JSON.stringify(out), 2500),
      stderr_tail: "",
      error: null,
    };
  }

  if (action.kind === "command") {
    return { ...action, ...runCommand(action.cmd, action.args, 35 * 60 * 1000, budget, "action_command") };
  }

  return {
    ...action,
    ok: false,
    code: 1,
    error: `Unknown action kind: ${action.kind}`,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    stdout_tail: "",
    stderr_tail: "",
  };
}

async function maybeLlmSummary(report, budget = null) {
  if (!USE_LLM || DRY_RUN) return null;
  const guard = budget ? budget.record("llm_summary", JSON.stringify({
    risks: report.risks?.length || 0,
    decisions: report.decisions?.length || 0,
    executions: report.executions?.length || 0,
  })) : { allowed: true, violations: [] };
  if (!guard.allowed) {
    return `LLM summary skipped: tool_budget_exceeded (${guard.violations.join(", ")})`;
  }
  try {
    const { chat } = require("../infra/model-router");
    const system = "You are a senior task master. Summarize real productivity progress and if loop-pruning worked.";
    const user = JSON.stringify(
      {
        risks: report.risks,
        productivity: report.metrics.productivity,
        freshness: report.metrics.freshness,
        stale_by_type_45m: report.metrics.stale_by_type_45m.slice(0, 10),
        duplicate_families: report.metrics.duplicate_idempotency_families.slice(0, 10),
        actions_executed: report.executions.map((x) => ({ id: x.id, ok: x.ok, code: x.code })),
      },
      null,
      2
    );
    const res = await chat("triage", system, user, { max_tokens: 900 });
    return res?.text || null;
  } catch (err) {
    return `LLM summary unavailable: ${err.message}`;
  }
}

async function main() {
  const budget = createRunBudget();
  const lock = await pg.query(`SELECT pg_try_advisory_lock($1) AS ok`, [GOVERNOR_LOCK_KEY]);
  if (!lock.rows?.[0]?.ok) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: "governor_lock_held" }, null, 2));
    return 0;
  }

  const rawQuery = pg.query.bind(pg);
  RAW_QUERY_REF = rawQuery;
  pg.query = (text, values) => {
    const sample = typeof text === "string"
      ? text
      : (text && typeof text === "object" && typeof text.text === "string" ? text.text : "unknown_query");
    const normalized = String(sample || "").toLowerCase();
    if (normalized.includes("pg_try_advisory_lock") || normalized.includes("pg_advisory_unlock")) {
      if (typeof text === "string") return rawQuery({ text, values, query_timeout: 15000 });
      if (text && typeof text === "object" && !Object.prototype.hasOwnProperty.call(text, "query_timeout")) {
        return rawQuery({ ...text, query_timeout: 15000 });
      }
      return rawQuery(text, values);
    }
    const guard = budget.record("postgres_query", sample);
    if (!guard.allowed) {
      throw new Error(`tool_budget_exceeded: ${guard.violations.join(", ")}`);
    }
    if (typeof text === "string") return rawQuery({ text, values, query_timeout: 15000 });
    if (text && typeof text === "object" && !Object.prototype.hasOwnProperty.call(text, "query_timeout")) {
      return rawQuery({ ...text, query_timeout: 15000 });
    }
    return rawQuery(text, values);
  };

  const started = new Date().toISOString();
  const report = {
    started_at: started,
    generated_at: null,
    dry_run: DRY_RUN,
    use_llm: USE_LLM,
    checks: {},
    metrics: null,
    post_metrics: null,
    risks: [],
    post_risks: [],
    decisions: [],
    executions: [],
    summary: null,
    ok: true,
  };

  try {
    report.checks.runtime_audit = runCommand("npm", ["run", "-s", "audit:runtime"], 10 * 60 * 1000, budget, "check_command");
    report.checks.schema_audit = runCommand("npm", ["run", "-s", "schema:audit:json"], 10 * 60 * 1000, budget, "check_command");
    report.checks.task_contract = runCommand("npm", ["run", "-s", "audit:tasks"], 10 * 60 * 1000, budget, "check_command");
    report.checks.bind_guard = runCommand("npm", ["run", "-s", "security:bind:guard"], 10 * 60 * 1000, budget, "check_command");
    report.checks.progress_integrity = runCommand("node", [
      "scripts/progress-integrity-audit.js",
      "--lock-timeout-ms",
      "6000",
      "--statement-timeout-ms",
      "30000",
      "--query-timeout-ms",
      "20000",
      "--fail-open-on-timeout",
    ], 10 * 60 * 1000, budget, "check_command");

    report.metrics = await collectMetrics();
    report.risks = evaluateRisks(report.metrics, report.checks);
    report.decisions = decideActions(report.risks);

    if (!DRY_RUN) {
      for (const action of report.decisions) {
        const exec = await executeAction(action, budget);
        report.executions.push(exec);
      }
      // Re-sample queue state after actions so transient criticals (e.g., DLQ) can clear within the same cycle.
      report.post_metrics = await collectMetrics();
      report.post_risks = evaluateRisks(report.post_metrics, report.checks);
    }

    report.summary = await maybeLlmSummary(report, budget);
    const finalRisks = report.post_risks.length ? report.post_risks : report.risks;
    const failedCritical = finalRisks.some((r) => r.level === "critical");
    const failedExec = report.executions.some((e) => !e.ok);
    report.ok = !failedCritical && !failedExec;
  } catch (err) {
    report.ok = false;
    report.fatal_error = String(err?.message || err);
  }

  report.generated_at = new Date().toISOString();
  report.budget = budget.snapshot();
  report.ok = report.ok && report.budget.ok;

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const latest = path.join(REPORTS_DIR, "task-governor-latest.json");
  const stamped = path.join(REPORTS_DIR, `task-governor-${Date.now()}.json`);
  fs.writeFileSync(latest, JSON.stringify(report, null, 2));
  fs.writeFileSync(stamped, JSON.stringify(report, null, 2));

  console.log(
    JSON.stringify(
      {
        ok: report.ok,
        risks: report.risks.length,
        decisions: report.decisions.map((d) => d.id),
        executions_failed: report.executions.filter((e) => !e.ok).length,
        top_completed_share_pct: report.metrics?.productivity?.top_completed_share_pct || 0,
        stale_created: Number(report.metrics?.freshness?.stale_created || 0),
        fatal_error: report.fatal_error || null,
        budget_ok: report.budget?.ok ?? true,
        report: latest,
      },
      null,
      2
    )
  );
  return report.ok ? 0 : 1;
}

let exitCode = 0;
main()
  .then((code) => {
    exitCode = Number.isInteger(code) ? code : 0;
  })
  .catch((err) => {
    console.error("[task-governor] fatal:", err.message);
    exitCode = 1;
  })
  .finally(async () => {
    if (RAW_QUERY_REF) {
      await RAW_QUERY_REF({ text: `SELECT pg_advisory_unlock($1)`, values: [GOVERNOR_LOCK_KEY], query_timeout: 15000 }).catch(() => {});
    } else {
      await pg.query(`SELECT pg_advisory_unlock($1)`, [GOVERNOR_LOCK_KEY]).catch(() => {});
    }
    await pg.end().catch(() => {});
    process.exit(exitCode);
  });
