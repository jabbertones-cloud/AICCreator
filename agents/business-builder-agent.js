#!/usr/bin/env node
"use strict";

/**
 * business-builder-agent.js — Business Intelligence Builder Agent
 * 
 * Generates sync scripts, migrations, and API integrations from research findings.
 * Builds data collectors automatically following established patterns.
 */

require("dotenv").config({ override: true });

const fs = require("fs");
const path = require("path");
const { loadAgentPrelude, appendAgentDailyLog } = require("../control/agent-memory");
const { chatJson } = require("../infra/model-router");
const pg = require("../infra/postgres");

const AGENT_ID = "business_builder_agent";

// ─── Load Agent Context ────────────────────────────────────────────────────

function loadContext(...files) {
  const contextDir = path.join(__dirname, "../context");
  return files.map(f => {
    try {
      const safe = path.basename(String(f).replace(/[/\\]/g, ""));
      if (!safe) return `\n--- [empty] ---`;
      const fpath = path.join(contextDir, safe);
      return `\n---\n${fs.readFileSync(fpath, "utf8")}`;
    } catch (_) {
      return `\n--- [${f} not found] ---`;
    }
  }).join("\n");
}

function loadRules(...files) {
  const rulesDir = path.join(__dirname, "..", ".cursor", "rules");
  return files.map(f => {
    try {
      const safe = path.basename(String(f).replace(/[/\\]/g, ""));
      if (!safe) return `\n--- [empty] ---`;
      const fpath = path.join(rulesDir, safe);
      return `\n---\n${fs.readFileSync(fpath, "utf8")}`;
    } catch (_) {
      return `\n--- [${f} not found] ---`;
    }
  }).join("\n");
}

// ─── Builder System Prompt ─────────────────────────────────────────────────

const BUILDER_SYSTEM = `You are the Business Intelligence Builder Agent for OpenClaw.

Your mission: Generate sync scripts, migrations, and API integrations from research findings.
Build data collectors automatically following established patterns.

## Build Process

1. **Read Research**: Load research findings from business_integration_research table
2. **Generate Script**: Create sync script following build patterns template
3. **Create Migration**: Generate migration if schema changes needed
4. **Implement Auth**: Set up authentication flow (OAuth, API key, etc.)
5. **Add Error Handling**: Implement retry logic and error recovery
6. **Test Code**: Validate syntax and structure
7. **Deploy**: Write script to scripts/ directory
8. **Update Status**: Mark build as completed in build queue

## Code Generation Rules

- Follow build patterns from .cursor/rules/business-build-patterns.mdc
- Use consistent error handling patterns
- Implement rate limiting and retry logic
- Store data in unified schema (business_* tables)
- Log all operations to business_sync_logs
- Handle authentication renewals
- Support incremental and full syncs

## Output Format

Return JSON:
{
  "script_path": "scripts/business-{platform}-sync.js",
  "migration_path": "migrations/XXX_{description}.sql" or null,
  "code": "// Generated sync script code...",
  "migration_sql": "CREATE TABLE..." or null,
  "build_status": "completed|failed",
  "build_notes": "notes about the build...",
  "errors": ["error1", ...] or []
}

${loadContext("SOUL.md", "USER.md", "AGENT_PRINCIPLES.md")}
${loadRules("business-build-patterns.mdc", "business-integration-patterns.mdc")}`;

// ─── Build Integration Function ───────────────────────────────────────────

async function buildIntegration(platform, research) {
  console.log(`[builder] Building integration for: ${platform}`);

  const prompt = `Build a sync script for ${platform} integration.

Research findings:
- API Documentation: ${research.api_documentation_url || "N/A"}
- Authentication: ${research.authentication_method || "N/A"}
- Endpoints: ${JSON.stringify(research.api_endpoints || [])}
- Data Available: ${JSON.stringify(research.data_available || [])}
- Complexity: ${research.integration_complexity || "moderate"}

Generate:
1. Sync script: scripts/business-${platform}-sync.js
2. Migration if needed (only if new tables/columns required)
3. Error handling and retry logic
4. Rate limiting
5. Data transformation to unified schema

Follow the build patterns and integration patterns from the rules.`;

  try {
    const result = await chatJson(BUILDER_SYSTEM, prompt, {
      max_tokens: 4000,
      temperature: 0.2,
    });

    if (result && result.code) {
      // Write sync script
      const scriptPath = path.join(__dirname, "..", result.script_path || `scripts/business-${platform}-sync.js`);
      await fs.promises.mkdir(path.dirname(scriptPath), { recursive: true });
      await fs.promises.writeFile(scriptPath, result.code, "utf8");
      console.log(`[builder] Wrote script: ${scriptPath}`);

      // Write migration if provided
      if (result.migration_sql) {
        // Find next migration number
        const migrationsDir = path.join(__dirname, "..", "migrations");
        const files = await fs.promises.readdir(migrationsDir);
        const numbers = files
          .filter(f => /^\d{3}_/.test(f))
          .map(f => parseInt(f.split("_")[0]))
          .filter(n => !isNaN(n));
        const nextNum = numbers.length > 0 ? Math.max(...numbers) + 1 : 77;
        const migrationPath = path.join(migrationsDir, `${String(nextNum).padStart(3, "0")}_business_${platform}_integration.sql`);
        await fs.promises.writeFile(migrationPath, result.migration_sql, "utf8");
        console.log(`[builder] Wrote migration: ${migrationPath}`);
        result.migration_path = migrationPath;
      }

      // Update build queue
      await pg.query(
        `UPDATE business_build_queue 
         SET build_status = $1, 
             sync_script_path = $2,
             migration_path = $3,
             build_notes = $4,
             completed_at = NOW()
         WHERE platform = $5 AND build_status = 'queued'`,
        [
          result.build_status || "completed",
          result.script_path,
          result.migration_path || null,
          result.build_notes || "",
          platform,
        ]
      );

      // Update data source status
      await pg.query(
        `INSERT INTO business_data_sources (platform, platform_display_name, status)
         VALUES ($1, $2, 'connected')
         ON CONFLICT (platform) DO UPDATE SET status = 'connected', updated_at = NOW()`,
        [platform, platform.charAt(0).toUpperCase() + platform.slice(1).replace(/_/g, " ")]
      );

      return { ok: true, script_path: result.script_path, migration_path: result.migration_path };
    }
  } catch (err) {
    console.error(`[builder] Error building ${platform}:`, err.message);
    
    // Mark build as failed
    await pg.query(
      `UPDATE business_build_queue 
       SET build_status = 'failed', build_notes = $1
       WHERE platform = $2`,
      [err.message, platform]
    );
    
    return { ok: false, error: err.message };
  }
}

// ─── Main Agent Function ────────────────────────────────────────────────────

async function main() {
  console.log(`[${AGENT_ID}] Starting build cycle`);

  // Load agent prelude
  const prelude = await loadAgentPrelude(AGENT_ID);
  console.log(`[${AGENT_ID}] Loaded prelude`);

  // Get builds queued
  const { rows: buildQueue } = await pg.query(
    `SELECT bq.*, r.api_documentation_url, r.authentication_method, 
            r.api_endpoints, r.data_available, r.integration_complexity
     FROM business_build_queue bq
     JOIN business_integration_research r ON bq.research_id = r.id
     WHERE bq.build_status = 'queued'
     ORDER BY bq.build_priority DESC, bq.created_at ASC
     LIMIT 3`
  );

  if (buildQueue.length === 0) {
    console.log(`[${AGENT_ID}] No builds queued`);
    await appendAgentDailyLog(AGENT_ID, "No builds queued", {});
    return { ok: true, builds: 0 };
  }

  console.log(`[${AGENT_ID}] Found ${buildQueue.length} builds to process`);

  const results = [];
  for (const build of buildQueue) {
    const result = await buildIntegration(build.platform, build);
    results.push({ platform: build.platform, ...result });
  }

  // Log to daily memory
  const summary = `Built ${results.filter(r => r.ok).length}/${results.length} integrations: ${results.map(r => `${r.platform} (${r.ok ? "ok" : "failed"})`).join(", ")}`;
  await appendAgentDailyLog(AGENT_ID, summary, { results });

  console.log(`[${AGENT_ID}] Build cycle complete: ${summary}`);
  return { ok: true, results };
}

// ─── Run ────────────────────────────────────────────────────────────────────

if (require.main === module) {
  main()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error(`[${AGENT_ID}] Fatal error:`, err);
      process.exit(1);
    });
}

module.exports = { main, buildIntegration };
