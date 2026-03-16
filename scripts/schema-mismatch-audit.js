#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

// Load .env: AICCreator first, then fallback to claw-architect (../../claw-architect or CLAW_ARCHITECT_ROOT)
const ROOT_DIR = path.join(__dirname, "..");
const envPaths = [path.join(ROOT_DIR, ".env")];
const archRoot = process.env.CLAW_ARCHITECT_ROOT || path.join(ROOT_DIR, "..", "..", "claw-architect");
if (fs.existsSync(path.join(archRoot, ".env"))) envPaths.push(path.join(archRoot, ".env"));
for (const p of envPaths) {
  if (fs.existsSync(p)) require("dotenv").config({ path: p, override: false });
}

const JSON_OUT = process.argv.includes("--json");
const STRICT = process.argv.includes("--strict");

const ROOT = path.join(__dirname, "..");
const MIGRATIONS_DIR = path.join(ROOT, "migrations");

const REQUIRED_TABLE_COLUMNS = Object.freeze({
  tasks: ["id", "type", "payload", "status", "worker_queue", "required_tags", "idempotency_key"],
  schema_migrations: ["version", "applied_at", "filename"],
  credit_person_profiles: ["id", "external_key", "full_name", "created_at", "updated_at"],
  credit_reports: ["id", "person_id", "bureau", "report_date", "source_type", "created_at"],
  credit_items: ["id", "report_id", "person_id", "item_type", "balance", "credit_limit"],
  credit_issues: ["id", "person_id", "issue_type", "severity", "status", "recommended_workflow"],
  credit_actions: ["id", "person_id", "issue_id", "action_type", "channel", "status", "payload_json"],
  credit_deadlines: ["id", "person_id", "issue_id", "deadline_type", "due_date", "status"],
  loyalty_members: ["id", "email", "phone", "status", "created_at"],
  loyalty_webhook_events: ["id", "provider", "source_system", "event_type", "event_id", "event_version", "schema_version", "processing_status", "received_at", "retry_count"],
  loyalty_order_events: ["id", "provider", "event_type", "event_id", "order_id", "store_id", "payload_json", "created_at"],
  loyalty_order_line_items: ["id", "order_event_id", "line_no", "sku", "quantity", "payload_json", "created_at"],
  loyalty_domain_events: ["id", "provider", "source_event_id", "domain_event_type", "domain_event_key", "payload_json", "created_at"],
  loyalty_outreach_queue: ["id", "member_id", "channel", "template_key", "status", "created_at"],
});

const STATUS_ENUM_EXPECTATIONS = Object.freeze([
  {
    table: "tasks",
    column: "status",
    mustContain: ["CREATED", "RUNNING", "COMPLETED", "FAILED", "DEAD_LETTER", "CANCELLED"],
  },
  {
    table: "loyalty_webhook_events",
    column: "processing_status",
    mustContain: ["queued", "processed", "failed"],
  },
  {
    table: "loyalty_outreach_queue",
    column: "status",
    mustContain: ["queued", "sent", "failed", "skipped"],
  },
  {
    table: "credit_issues",
    column: "status",
    mustContain: ["open", "in_review", "resolved", "dismissed"],
  },
  {
    table: "credit_actions",
    column: "status",
    mustContain: ["draft", "queued", "sent", "completed", "blocked", "cancelled"],
  },
]);

function makePool() {
  // Prefer CLAW_DB_* so audits and migration runner target the same database by default.
  const dbHost = process.env.CLAW_DB_HOST || process.env.POSTGRES_HOST;
  const dbPort = parseInt(process.env.CLAW_DB_PORT || process.env.POSTGRES_PORT || "15432", 10);
  const dbUser = process.env.CLAW_DB_USER || process.env.POSTGRES_USER || "claw";
  const dbPass = process.env.CLAW_DB_PASSWORD || process.env.POSTGRES_PASSWORD;
  const dbName = process.env.CLAW_DB_NAME || process.env.POSTGRES_DB || "claw_architect";
  if (!dbHost || !dbPass) {
    throw new Error("Missing DB env. Set POSTGRES_HOST and POSTGRES_PASSWORD.");
  }
  return new Pool({ host: dbHost, port: dbPort, user: dbUser, password: dbPass, database: dbName });
}

function listMigrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((filename) => ({
      filename,
      version: filename.match(/^(\d+)/)?.[1] || null,
      path: path.join(MIGRATIONS_DIR, filename),
    }));
}

function findDuplicateVersions(files) {
  const byVersion = new Map();
  for (const f of files) {
    if (!f.version) continue;
    if (!byVersion.has(f.version)) byVersion.set(f.version, []);
    byVersion.get(f.version).push(f.filename);
  }
  const out = [];
  for (const [version, names] of byVersion.entries()) {
    if (names.length > 1) out.push({ version, files: names });
  }
  return out;
}

async function getAppliedVersions(pool) {
  const { rows } = await pool.query(
    "SELECT version, filename, applied_at FROM schema_migrations ORDER BY version, applied_at"
  );
  return rows;
}

async function getColumnMap(pool) {
  const { rows } = await pool.query(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
     ORDER BY table_name, ordinal_position`
  );
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.table_name)) m.set(r.table_name, new Set());
    m.get(r.table_name).add(r.column_name);
  }
  return m;
}

async function getIntegrity(pool) {
  const { rows } = await pool.query(
    `SELECT
      (SELECT count(*) FROM pg_constraint WHERE NOT convalidated) AS invalid_constraints,
      (SELECT count(*) FROM pg_index WHERE NOT indisvalid) AS invalid_indexes`
  );
  return {
    invalid_constraints: Number(rows[0]?.invalid_constraints || 0),
    invalid_indexes: Number(rows[0]?.invalid_indexes || 0),
  };
}

async function getCheckDefs(pool, table) {
  const { rows } = await pool.query(
    `SELECT pg_get_constraintdef(c.oid) AS def
     FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = $1
       AND c.contype = 'c'`,
    [table]
  );
  return rows.map((r) => String(r.def || ""));
}

async function main() {
  const report = {
    ok: true,
    failures: [],
    warnings: [],
    stats: {},
  };

  const files = listMigrationFiles();
  report.stats.migration_files = files.length;

  const dupVersions = findDuplicateVersions(files);
  if (dupVersions.length) {
    report.warnings.push({
      code: "DUPLICATE_MIGRATION_VERSIONS",
      detail: dupVersions,
    });
  }

  const pool = makePool();
  try {
    const applied = await getAppliedVersions(pool);
    const appliedVersions = new Set(applied.map((r) => r.version));
    const fileVersions = new Set(files.map((f) => f.version).filter(Boolean));

    const pendingVersions = [...fileVersions].filter((v) => !appliedVersions.has(v)).sort();
    const unknownApplied = [...appliedVersions].filter((v) => !fileVersions.has(v)).sort();

    report.stats.migration_versions_in_files = fileVersions.size;
    report.stats.migration_versions_applied = appliedVersions.size;
    report.stats.pending_versions = pendingVersions.length;
    report.stats.applied_without_file = unknownApplied.length;

    if (pendingVersions.length) {
      report.failures.push({
        code: "PENDING_MIGRATIONS",
        detail: pendingVersions,
      });
    }
    if (unknownApplied.length) {
      report.warnings.push({
        code: "APPLIED_VERSIONS_WITHOUT_FILE",
        detail: unknownApplied,
      });
    }

    const integrity = await getIntegrity(pool);
    report.stats.invalid_constraints = integrity.invalid_constraints;
    report.stats.invalid_indexes = integrity.invalid_indexes;
    if (integrity.invalid_constraints > 0) {
      report.failures.push({ code: "INVALID_CONSTRAINTS", detail: integrity.invalid_constraints });
    }
    if (integrity.invalid_indexes > 0) {
      report.failures.push({ code: "INVALID_INDEXES", detail: integrity.invalid_indexes });
    }

    const colMap = await getColumnMap(pool);
    for (const [table, cols] of Object.entries(REQUIRED_TABLE_COLUMNS)) {
      if (!colMap.has(table)) {
        report.failures.push({ code: "MISSING_TABLE", detail: table });
        continue;
      }
      const actual = colMap.get(table);
      const missing = cols.filter((c) => !actual.has(c));
      if (missing.length) {
        report.failures.push({
          code: "MISSING_COLUMNS",
          detail: { table, missing },
        });
      }
    }

    for (const check of STATUS_ENUM_EXPECTATIONS) {
      const defs = await getCheckDefs(pool, check.table);
      const joined = defs.join(" || ").toLowerCase();
      const missing = check.mustContain.filter((v) => !joined.includes(String(v).toLowerCase()));
      if (missing.length) {
        report.failures.push({
          code: "STATUS_CHECK_MISMATCH",
          detail: { table: check.table, column: check.column, missing_values: missing },
        });
      }
    }
  } finally {
    await pool.end();
  }

  report.ok = report.failures.length === 0;

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("\n=== Schema Mismatch Audit ===\n");
    console.log(`ok: ${report.ok ? "YES" : "NO"}`);
    console.log(`migration files: ${report.stats.migration_files}`);
    console.log(`migration versions (files/applied): ${report.stats.migration_versions_in_files}/${report.stats.migration_versions_applied}`);
    console.log(`pending versions: ${report.stats.pending_versions}`);
    console.log(`invalid constraints: ${report.stats.invalid_constraints}`);
    console.log(`invalid indexes: ${report.stats.invalid_indexes}`);

    if (report.failures.length) {
      console.log("\nFAILURES:");
      for (const f of report.failures) {
        console.log(`- ${f.code}: ${JSON.stringify(f.detail)}`);
      }
    }
    if (report.warnings.length) {
      console.log("\nWARNINGS:");
      for (const w of report.warnings) {
        console.log(`- ${w.code}: ${JSON.stringify(w.detail)}`);
      }
    }
    if (!report.failures.length && !report.warnings.length) {
      console.log("\nNo schema mismatches detected.");
    }
    console.log("");
  }

  if (!report.ok || (STRICT && report.warnings.length > 0)) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`schema-mismatch-audit fatal: ${err.message}`);
  process.exit(1);
});
