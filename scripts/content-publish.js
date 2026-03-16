#!/usr/bin/env node
/**
 * content-publish.js — content:publish:queue CLI hook + task handler
 * ─────────────────────────────────────────────────────────────────────────────
 * Dispatches an approved content variant to its channel adapter.
 * Each channel adapter calls the appropriate @claw/* canonical module.
 *
 * Usage:
 *   node scripts/content-publish.js --variant-id <uuid>
 *   node scripts/content-publish.js --draft-id <uuid>  # publishes all approved variants
 *   node scripts/content-publish.js --brief-id <uuid>  # queues all approved variants
 *   node scripts/content-publish.js --variant-id <uuid> --dry-run
 */
"use strict";

const { Pool }    = require("pg");
const path        = require("path");
const { v4: uuidv4 } = require("uuid");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const pool = new Pool({
  host:     process.env.POSTGRES_HOST || process.env.CLAW_DB_HOST,
  port:     parseInt(process.env.POSTGRES_PORT || process.env.CLAW_DB_PORT || "15432", 10),
  user:     process.env.POSTGRES_USER || process.env.CLAW_DB_USER || "claw",
  password: process.env.POSTGRES_PASSWORD || process.env.CLAW_DB_PASSWORD,
  database: process.env.POSTGRES_DB || process.env.CLAW_DB_NAME || "claw_architect",
});

// ── Channel adapters ──────────────────────────────────────────────────────────

async function sendEmail(variant, brand) {
  const { sendEmail: sendTransactional } = require("../infra/send-email");
  const toAddr = variant.meta?.to_email || process.env.CONTENT_TEST_EMAIL || "test@localhost";
  const result = await sendTransactional({
    apiKey:    process.env.MAILEROO_API_KEY,
    fromEmail: brand.sending_email || process.env.MAILEROO_FROM_EMAIL,
    fromName:  brand.name,
    to:        toAddr,
    subject:   variant.subject_line,
    html:      markdownToHtml(variant.body),
    plain:     variant.body,
  });
  const messageId = result?.body?.data?.message_id || result?.body?.data?.id || result?.body?.id;
  return { externalId: messageId, status: "sent" };
}

async function sendSms(variant, brand) {
  const { sendSms: telnyxSend } = require("./telnyx-sms");

  const result = await telnyxSend({
    to:   variant.meta?.to_phone || "",
    text: variant.body,
    from: brand.sms_from || process.env.TELNYX_FROM_NUMBER,
  });

  return { externalId: result.messageId, status: "sent" };
}

async function publishBlog(variant, brand) {
  // Posts to GitHub as MDX, triggers Vercel deploy
  const { Octokit } = require("@octokit/rest");
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

  const slug = variant.meta?.slug || `post-${Date.now()}`;
  const filePath = `content/blog/${slug}.mdx`;
  const content  = Buffer.from(`---
title: "${variant.body?.split("\n")[0]?.replace(/^#+\s*/, "") || "New Post"}"
date: "${new Date().toISOString()}"
---

${variant.body || ""}
`).toString("base64");

  const repo = brand.meta?.blog_repo || process.env.BLOG_REPO;
  if (!repo) throw new Error("BLOG_REPO not configured for brand");
  const [owner, repoName] = repo.split("/");

  const { data } = await octokit.repos.createOrUpdateFileContents({
    owner, repo: repoName, path: filePath, message: `content: ${slug}`, content,
  });

  return { externalId: data.commit.sha, status: "published" };
}

// Simple markdown → HTML for email (no external dep)
function markdownToHtml(md = "") {
  return md
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/\n\n/g, "</p><p>")
    .replace(/^/, "<p>")
    .replace(/$/, "</p>");
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

async function dispatchVariant(variantId, dryRun = false) {
  const { rows } = await pool.query(`
    SELECT cv.*, cd.status AS draft_status, cb.channel, cb.brand_id,
           b.slug AS brand_slug, b.name AS brand_name,
           cv.body AS body, cv.subject_line, cv.cta_text, cv.cta_url
    FROM   content_variants cv
    JOIN   content_drafts   cd ON cd.id = cv.draft_id
    JOIN   content_briefs   cb ON cb.id = cv.brief_id
    JOIN   brands           b  ON b.id  = cb.brand_id
    WHERE  cv.id = $1
  `, [variantId]);

  if (!rows.length) throw new Error(`Variant not found: ${variantId}`);
  const variant = rows[0];

  if (variant.draft_status !== "approved") {
    throw new Error(`Draft not approved (status: ${variant.draft_status}). Cannot publish.`);
  }
  if (variant.published_at) {
    console.log(`⚠  Variant ${variantId} already published at ${variant.published_at}`);
    return;
  }

  console.log(`📤 Publishing variant: ${variantId}`);
  console.log(`   Channel : ${variant.channel}`);
  console.log(`   Brand   : ${variant.brand_name}`);

  if (dryRun) {
    console.log("── DRY RUN — would dispatch to channel adapter");
    return;
  }

  // Mark as queued
  await pool.query(
    "UPDATE content_variants SET publish_status = 'queued', updated_at = NOW() WHERE id = $1",
    [variantId]
  );

  let result;
  const brand = { name: variant.brand_name, slug: variant.brand_slug };

  try {
    switch (variant.channel) {
      case "email":     result = await sendEmail(variant, brand); break;
      case "sms":       result = await sendSms(variant, brand);   break;
      case "blog":      result = await publishBlog(variant, brand); break;
      default:
        // Queue for n8n or manual dispatch (Instagram, LinkedIn, push)
        result = { externalId: null, status: `queued_external:${variant.channel}` };
        console.log(`⚠  Channel ${variant.channel} — queued for n8n / manual dispatch`);
    }
  } catch (err) {
    await pool.query(`
      UPDATE content_variants
      SET publish_status = 'failed', publish_error = $1, updated_at = NOW()
      WHERE id = $2
    `, [err.message, variantId]);
    throw err;
  }

  // Update variant + write publish log
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      UPDATE content_variants
      SET publish_status = 'sent', published_at = NOW(),
          external_id = $1, updated_at = NOW()
      WHERE id = $2
    `, [result.externalId, variantId]);

    await client.query(`
      INSERT INTO content_publish_log (
        variant_id, draft_id, brief_id, brand_id, channel, external_id, published_at
      )
      SELECT $1, cv.draft_id, cv.brief_id, cb.brand_id, cb.channel, $2, NOW()
      FROM   content_variants cv
      JOIN   content_briefs   cb ON cb.id = cv.brief_id
      WHERE  cv.id = $1
    `, [variantId, result.externalId]);

    // Mark brief as published if this is the first publish
    await client.query(`
      UPDATE content_briefs
      SET status = 'published', updated_at = NOW()
      WHERE id = (SELECT brief_id FROM content_variants WHERE id = $1)
        AND status != 'published'
    `, [variantId]);

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  console.log(`✅ Published`);
  console.log(`   External ID : ${result.externalId || "(queued external)"}`);
  console.log(`   Status      : ${result.status}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const get  = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i+1] : null; };
  const has  = (f) => args.includes(f);

  const variantId = get("--variant-id");
  const draftId   = get("--draft-id");
  const briefId   = get("--brief-id");
  const dryRun    = has("--dry-run");

  if (variantId) {
    await dispatchVariant(variantId, dryRun);
  } else if (draftId) {
    const { rows } = await pool.query(
      "SELECT id FROM content_variants WHERE draft_id = $1 AND (publish_status IS NULL OR publish_status != 'sent')",
      [draftId]
    );
    console.log(`Found ${rows.length} variant(s) for draft ${draftId}`);
    for (const { id } of rows) await dispatchVariant(id, dryRun);
  } else if (briefId) {
    const { rows } = await pool.query(`
      SELECT cv.id FROM content_variants cv
      JOIN content_drafts cd ON cd.id = cv.draft_id
      WHERE cv.brief_id = $1 AND cd.status = 'approved'
        AND (cv.publish_status IS NULL OR cv.publish_status != 'sent')
    `, [briefId]);
    console.log(`Found ${rows.length} approved variant(s) for brief ${briefId}`);
    for (const { id } of rows) await dispatchVariant(id, dryRun);
  } else {
    console.error("❌ Provide --variant-id, --draft-id, or --brief-id");
    process.exit(1);
  }

  await pool.end();
}

main().catch((err) => {
  console.error("❌ Fatal:", err.message);
  pool.end().catch(() => {});
  process.exit(1);
});

module.exports = { dispatchVariant };
