#!/usr/bin/env node
"use strict";

require("dotenv").config();
const { v4: uuidv4 } = require("uuid");
const pg = require("../infra/postgres");
const { resolveRouting } = require("../config/task-routing");
const { validatePayload } = require("../schemas/payloads");
const { buildTaskIdempotencyKey } = require("../control/idempotency");

function arg(flag, fallback = null) {
  const args = process.argv.slice(2);
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
}

function has(flag) {
  return process.argv.slice(2).includes(flag);
}

async function main() {
  const brand_slug = String(arg("--brand", "")).trim();
  const channel = String(arg("--channel", "")).trim();
  const topic = String(arg("--topic", "")).trim();
  const target_audience = String(arg("--audience", "")).trim();
  const tone = String(arg("--tone", "clear, persuasive, specific")).trim();
  const goal = String(arg("--goal", "")).trim();
  const notebook_context = String(arg("--notebook-context", "")).trim();
  const iterations = Number(arg("--iterations", "2"));
  const batch = Number(arg("--batch", "1"));
  const persist_brief = !has("--no-persist-brief");
  const dry_run = has("--dry-run");
  const sources = String(arg("--sources", ""))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const payload = {
    brand_slug,
    channel,
    topic,
    target_audience: target_audience || undefined,
    tone: tone || undefined,
    goal: goal || undefined,
    notebook_context: notebook_context || undefined,
    iterations: Number.isFinite(iterations) ? iterations : 2,
    persist_brief,
    sources: sources.length ? sources : undefined,
  };

  validatePayload("copy_lab_run", payload);

  if (dry_run) {
    console.log("DRY RUN payload:");
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (batch > 1) {
    // Batch mode: queue multiple tasks
    const promises = [];
    for (let b = 0; b < batch; b++) {
      const id = uuidv4();
      const routing = resolveRouting("copy_lab_run");
      const idempotency_key = buildTaskIdempotencyKey("copy_lab_run", payload);

      const p = pg.query(
        `INSERT INTO tasks (
          id, type, payload, status, priority, worker_queue, required_tags, idempotency_key, title
        ) VALUES ($1,$2,$3,'CREATED',$4,$5,$6,$7,$8)`,
        [
          id,
          "copy_lab_run",
          JSON.stringify(payload),
          4,
          routing.queue,
          routing.required_tags || [],
          idempotency_key,
          `Copy Lab: ${brand_slug} ${channel} ${topic}`.slice(0, 240),
        ]
      );
      promises.push(p);
      promises.push(pg.query(`SELECT pg_notify('task_created', $1)`, [id]).catch(() => {}));
    }

    await Promise.all(promises);
    console.log(`Queued ${batch} copy_lab_run tasks`);
    console.log(`brand=${brand_slug} channel=${channel} topic=${topic}`);
  } else {
    // Single task mode
    const id = uuidv4();
    const routing = resolveRouting("copy_lab_run");
    const idempotency_key = buildTaskIdempotencyKey("copy_lab_run", payload);

    await pg.query(
      `INSERT INTO tasks (
        id, type, payload, status, priority, worker_queue, required_tags, idempotency_key, title
      ) VALUES ($1,$2,$3,'CREATED',$4,$5,$6,$7,$8)`,
      [
        id,
        "copy_lab_run",
        JSON.stringify(payload),
        4,
        routing.queue,
        routing.required_tags || [],
        idempotency_key,
        `Copy Lab: ${brand_slug} ${channel} ${topic}`.slice(0, 240),
      ]
    );

    await pg.query(`SELECT pg_notify('task_created', $1)`, [id]).catch(() => {});

    console.log("Queued copy_lab_run task:");
    console.log(`task_id=${id}`);
    console.log(`queue=${routing.queue}`);
    console.log(`brand=${brand_slug} channel=${channel} topic=${topic}`);
  }
}

main()
  .catch((err) => {
    console.error(`copy-lab-run failed: ${err.message}`);
    process.exit(1);
  })
  .finally(async () => {
    await pg.end().catch(() => {});
  });

