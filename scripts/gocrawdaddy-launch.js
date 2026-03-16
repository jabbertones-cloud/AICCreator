#!/usr/bin/env node
"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { v4: uuid } = require("uuid");
const pg = require("../infra/postgres");
const { resolveRouting, isKnownTaskType } = require("../config/task-routing");
const { validatePayload } = require("../schemas/payloads");
const { buildTaskIdempotencyKey } = require("../control/idempotency");

const ACTIVE_STATUSES = ["CREATED", "DISPATCHED", "RUNNING", "RETRY", "PENDING_APPROVAL"];
const ROOT = path.join(__dirname, "..");
const ARGS = process.argv.slice(2);

function arg(flag, fallback = null) {
  const i = ARGS.indexOf(flag);
  if (i < 0 || i + 1 >= ARGS.length) return fallback;
  return ARGS[i + 1];
}

function has(flag) {
  return ARGS.includes(flag);
}

function nowIso() {
  return new Date().toISOString();
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
    [idempotencyKey, ACTIVE_STATUSES]
  );
  return rows.length > 0;
}

async function createTaskIfNeeded(type, payload, priority = 5, dryRun = false) {
  if (!isKnownTaskType(type)) throw new Error(`Unknown task type: ${type}`);
  validatePayload(type, payload || {});
  const idempotencyKey = buildTaskIdempotencyKey(type, payload || {});
  if (await taskExists(idempotencyKey)) {
    return { created: false, reason: "duplicate_active", type, idempotencyKey };
  }

  if (dryRun) {
    return { created: true, dry_run: true, type, payload, priority, idempotencyKey };
  }

  const id = uuid();
  const routing = resolveRouting(type);
  await pg.query(
    `INSERT INTO tasks (id, type, payload, status, priority, worker_queue, required_tags, idempotency_key)
     VALUES ($1,$2,$3::jsonb,'CREATED',$4,$5,$6,$7)`,
    [id, type, JSON.stringify(payload || {}), priority, routing.queue, routing.required_tags, idempotencyKey]
  );
  await pg.query(`SELECT pg_notify('task_created', $1)`, [id]).catch(() => {});
  return { created: true, id, type, priority };
}

function writeIfMissing(filePath, content) {
  if (fs.existsSync(filePath)) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return true;
}

function scaffoldRepo(repoPath) {
  fs.mkdirSync(repoPath, { recursive: true });

  const readme = `# GoCrawdaddy

OpenClaw VPS Hosting SaaS.

## Positioning
- Launch and manage OpenClaw stacks on VPS with one guided flow.
- Focus: founders/operators who want production-safe automation without DevOps overhead.

## MVP
- Workspace/project onboarding
- VPS provider setup runbooks (Hetzner, DO, AWS)
- Provisioning templates (Docker, PM2, Redis/Postgres hardening)
- Health dashboard (workers, queues, costs, failures)
- Daily backup + restore verification
- Provider-agnostic deploy pipeline

## Status
- Scaffolding initialized by claw-architect launcher.
- Core implementation queued through OpenCode controller tasks.
`;

  const prd = `# GoCrawdaddy MVP PRD

Generated: ${nowIso()}

## Outcome
User can create an OpenClaw environment on a VPS and keep it healthy with minimal manual operations.

## Core Jobs-to-be-Done
1. Stand up OpenClaw reliably on fresh VPS.
2. Connect model providers with low-cost routing defaults.
3. Monitor queue health, workers, and spend from one dashboard.
4. Auto-run maintenance and backup jobs safely.

## v1 Feature Set
1. Guided Setup Wizard:
- provider + host checks
- env template generation
- install script with dry-run preview
2. Runtime Control:
- restart/scale workers
- queue depth + dead-letter visibility
- per-lane health checks
3. Cost + Usage:
- model/provider usage rollup
- per-run cost estimate + alerts
4. Safety:
- destructive-action guards
- evidence artifacts for fallbacks and ops actions

## Success Metrics
- Time to first healthy deployment < 25 minutes
- Red/green status >= 95% daily
- No critical queue outage > 15 min
`;

  const arch = `# Architecture Notes

## Initial Stack
- Web: Next.js dashboard
- API: Node/Express control-plane
- State: Postgres + Redis
- Runtime: BullMQ workers + PM2
- Infra templates: Docker Compose + cloud-init scripts

## Build Sequence
1. Auth + tenant bootstrap
2. VPS template generator
3. Deploy runner and health probes
4. Queue + worker controls
5. Cost/reporting modules
`;

  const install = `#!/usr/bin/env bash
set -euo pipefail
echo "[GoCrawdaddy] bootstrap placeholder"
echo "Implement provider adapters + install flow here."
`;

  // ── Phase-2: Express API server skeleton with concurrency caps + replay hashing ──
  const apiServer = `"use strict";
/**
 * GoCrawdaddy Control-Plane API
 *
 * Phase-2 hardening: every action endpoint is protected by:
 *   1. concurrencyCapMiddleware  — Redis INCR/DECR atomic cap per action
 *   2. replayMiddleware          — SHA-256 request hashing + Postgres response cache
 *
 * Middleware is loaded from control/ and requires:
 *   - Redis (REDIS_URL / default localhost:6379)
 *   - Postgres (POSTGRES_HOST / CLAW_DB_HOST)
 *
 * Add new endpoints following the pattern in /api/action/:actionId below.
 */

require("dotenv").config();
const express = require("express");
const { capMiddleware }    = require("./control/concurrency-cap");
const { replayMiddleware } = require("./control/replay-hash");

const app = express();
app.use(express.json());

// ── Health ──────────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ── Actions ─────────────────────────────────────────────────────────────────
// Cap: 3 concurrent per actionId (e.g. 3 simultaneous deploy:prod runs allowed)
// Replay: cache successful responses for 5 min — identical re-submits get the
//         stored result immediately without re-running the action.
app.post(
  "/api/action/:actionId",
  capMiddleware((req) => \`action:\${req.params.actionId}\`, 3, { ttlSeconds: 900 }),
  replayMiddleware({
    ttlSeconds: 300,
    extraFieldsFn: (req) => ({ actionId: req.params.actionId }),
  }),
  async (req, res) => {
    // dispatch to action handler
    res.json({ ok: true, action: req.params.actionId, queued: true });
  }
);

// ── Reports ─────────────────────────────────────────────────────────────────
// Cap: 2 concurrent refreshes per report type
// Replay: cache report responses for 2 min
app.post(
  "/api/report/:type/refresh",
  capMiddleware((req) => \`report:\${req.params.type}\`, 2, { ttlSeconds: 600 }),
  replayMiddleware({
    ttlSeconds: 120,
    extraFieldsFn: (req) => ({ reportType: req.params.type }),
  }),
  async (req, res) => {
    // enqueue report refresh
    res.json({ ok: true, report: req.params.type, enqueued: true });
  }
);

const PORT = Number(process.env.PORT || 4052);
const HOST = process.env.HOST || "127.0.0.1";
app.listen(PORT, HOST, () => console.log(\`GoCrawdaddy API listening on \${HOST}:\${PORT}\`));

module.exports = app;
`;

  // ── Phase-2 control modules: copied from claw-architect pattern ─────────────
  // The full implementations live in claw-architect/control/ and will be
  // replicated here by the OpenCode controller. These stubs ensure imports
  // resolve immediately so the server boots during development.
  const concurrencyCapStub = `"use strict";
/**
 * concurrency-cap.js stub
 * Full implementation: copy from claw-architect/control/concurrency-cap.js
 * Requires: infra/redis.js (ioredis wrapper)
 */
const { capMiddleware, withCap, acquireCap, releaseCap, getCap, ConcurrencyCapError } =
  require("../../claw-architect/control/concurrency-cap"); // dev symlink path
module.exports = { capMiddleware, withCap, acquireCap, releaseCap, getCap, ConcurrencyCapError };
`;

  const replayHashStub = `"use strict";
/**
 * replay-hash.js stub
 * Full implementation: copy from claw-architect/control/replay-hash.js
 * Requires: infra/postgres.js (pg-pool wrapper)
 */
const { replayMiddleware, buildRequestHash, lookupReplay, storeReplay, sweepExpiredReplays } =
  require("../../claw-architect/control/replay-hash"); // dev symlink path
module.exports = { replayMiddleware, buildRequestHash, lookupReplay, storeReplay, sweepExpiredReplays };
`;

  const phase2Docs = `# GoCrawdaddy Phase-2 API Hardening

## What Was Added

### Per-Endpoint Concurrency Caps (\`control/concurrency-cap.js\`)

Uses Redis INCR/DECR for atomic concurrency counting. Solves the race condition
in query-based approaches. Falls back to an in-process Map if Redis is unavailable.

**How to apply:**
\`\`\`js
const { capMiddleware } = require("./control/concurrency-cap");

app.post("/api/action/:actionId",
  capMiddleware(req => \`action:\${req.params.actionId}\`, 3),
  handler
);
\`\`\`

**Return on cap exceeded:** HTTP 429 with \`Retry-After\` header.

**Standalone (non-HTTP):**
\`\`\`js
const { withCap } = require("./control/concurrency-cap");
await withCap("report:launch_e2e", 2, () => runReport());
\`\`\`

### Replay-Safe Response Hashing (\`control/replay-hash.js\`)

SHA-256 of (method + path + body + optional headers) stored in PostgreSQL.
Identical re-submissions within the TTL window return the cached response
without re-executing the handler.

**How to apply:**
\`\`\`js
const { replayMiddleware } = require("./control/replay-hash");

app.post("/api/report/:type/refresh",
  replayMiddleware({ ttlSeconds: 120 }),
  handler
);
\`\`\`

**Explicit caller override:** send \`X-Idempotency-Key: <uuid>\` header.
Response will include \`X-Replay-Cached: true|false\` and \`X-Replay-Hash\`.

**Postgres table auto-created:** \`replay_responses\` with TTL sweep every 60s.

## Defaults

| Setting | Value |
|---------|-------|
| Concurrency default TTL | 900s (15 min) |
| Replay default TTL | 300s (5 min) |
| Max cached body size | 64 KB |
| Replay sweep interval | 60s |
| 429 Retry-After hint | 30s |
`;

  const created = [];
  if (writeIfMissing(path.join(repoPath, "README.md"), readme)) created.push("README.md");
  if (writeIfMissing(path.join(repoPath, "docs", "PRD.md"), prd)) created.push("docs/PRD.md");
  if (writeIfMissing(path.join(repoPath, "docs", "ARCHITECTURE.md"), arch)) created.push("docs/ARCHITECTURE.md");
  if (writeIfMissing(path.join(repoPath, "docs", "PHASE2-API-HARDENING.md"), phase2Docs)) created.push("docs/PHASE2-API-HARDENING.md");
  if (writeIfMissing(path.join(repoPath, "api", "server.js"), apiServer)) created.push("api/server.js");
  if (writeIfMissing(path.join(repoPath, "control", "concurrency-cap.js"), concurrencyCapStub)) created.push("control/concurrency-cap.js");
  if (writeIfMissing(path.join(repoPath, "control", "replay-hash.js"), replayHashStub)) created.push("control/replay-hash.js");
  if (writeIfMissing(path.join(repoPath, "ops", "install.sh"), install)) {
    fs.chmodSync(path.join(repoPath, "ops", "install.sh"), 0o755);
    created.push("ops/install.sh");
  }

  return created;
}

async function ensureManagedRepo(clientName, repoUrl, localPath, branch, notes, dryRun) {
  const select = await pg.query(
    `SELECT id, client_name, repo_url, local_path, branch, notes, status
       FROM managed_repos
      WHERE lower(client_name) = lower($1)
      LIMIT 1`,
    [clientName]
  );

  if (select.rows.length > 0) {
    if (dryRun) {
      return { action: "exists", row: select.rows[0] };
    }
    const row = select.rows[0];
    await pg.query(
      `UPDATE managed_repos
          SET repo_url = $2,
              local_path = $3,
              branch = $4,
              notes = COALESCE($5, notes),
              status = 'active'
        WHERE id = $1`,
      [row.id, repoUrl, localPath, branch, notes || row.notes]
    );
    return { action: "updated", id: row.id };
  }

  if (dryRun) {
    return { action: "would_insert", client_name: clientName, repo_url: repoUrl, local_path: localPath };
  }

  const ins = await pg.query(
    `INSERT INTO managed_repos (client_name, repo_url, branch, local_path, notes, status)
     VALUES ($1, $2, $3, $4, $5, 'active')
     RETURNING id`,
    [clientName, repoUrl, branch, localPath, notes]
  );
  return { action: "inserted", id: ins.rows[0].id };
}

async function main() {
  const dryRun = has("--dry-run");
  const clientName = String(arg("--name", "GoCrawdaddy"));
  const repoUrl = String(arg("--repo-url", "https://github.com/smanthey/GoCrawdaddy"));
  const branch = String(arg("--branch", "main"));
  const localPath = String(arg("--local-path", "$HOME/claw-repos/GoCrawdaddy"));
  const domain = String(arg("--domain", "gocrawdaddy.com"));
  const includeScaffold = !has("--no-scaffold");

  await ensureRoutingColumns();

  let scaffoldCreated = [];
  if (includeScaffold && !dryRun) {
    scaffoldCreated = scaffoldRepo(localPath);
  }

  const managed = await ensureManagedRepo(
    clientName,
    repoUrl,
    localPath,
    branch,
    "OpenClaw VPS hosting SaaS build lane (autogenerated by gocrawdaddy-launch).",
    dryRun
  );

  const queued = [];

  queued.push(await createTaskIfNeeded("research_sync", {
    dry_run: false,
    source: "gocrawdaddy_launch",
    focus: "openclaw_vps_hosting_saas",
  }, 4, dryRun));

  queued.push(await createTaskIfNeeded("research_signals", {
    dry_run: false,
    source: "gocrawdaddy_launch",
    topic: "openclaw_vps_hosting",
  }, 4, dryRun));

  queued.push(await createTaskIfNeeded("affiliate_research", {
    host: domain,
    limit: 25,
    dry_run: false,
  }, 5, dryRun));

  queued.push(await createTaskIfNeeded("opencode_controller", {
    repo: clientName,
    source: "gocrawdaddy_launch",
    objective: "Build GoCrawdaddy MVP: OpenClaw VPS hosting SaaS with guided setup, provisioning templates, health dashboard, queue controls, and cost monitoring. Prioritize production-safe defaults and complete E2E smoke coverage for onboarding and deploy flows.",
    max_iterations: 6,
    quality_target: 96,
    auto_iterate: true,
  }, 5, dryRun));

  queued.push(await createTaskIfNeeded("opencode_controller", {
    repo: clientName,
    source: "gocrawdaddy_launch",
    objective: "Create conversion-ready landing copy + pricing tiers for GoCrawdaddy (starter/pro/agency), including VPS setup outcome framing and onboarding CTA flow.",
    max_iterations: 3,
    quality_target: 92,
    auto_iterate: true,
  }, 4, dryRun));

  const createdCount = queued.filter((q) => q.created).length;
  const skippedCount = queued.length - createdCount;

  console.log(JSON.stringify({
    ok: true,
    dry_run: dryRun,
    client_name: clientName,
    repo_url: repoUrl,
    local_path: localPath,
    managed_repo: managed,
    scaffold_created: scaffoldCreated,
    tasks_created: createdCount,
    tasks_skipped_duplicates: skippedCount,
    queued,
  }, null, 2));
}

main()
  .catch((err) => {
    console.error("[gocrawdaddy-launch] fatal:", err.message || String(err));
    process.exit(1);
  })
  .finally(async () => {
    await pg.end().catch(() => {});
  });
