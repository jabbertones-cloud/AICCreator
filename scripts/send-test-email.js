#!/usr/bin/env node
/**
 * send-test-email.js
 * ──────────────────────────────────────────────────────────────────────────
 * Sends a preview of the outbound B2B email to a specified address.
 * Uses the same Maileroo sender and template logic as daily-send-scheduler.js.
 *
 * Usage:
 *   node scripts/send-test-email.js                              # → shop@skynpatch.com
 *   node scripts/send-test-email.js --to recipient@yourdomain.com  # any address
 *   node scripts/send-test-email.js --variant margin            # subject/hook variant
 *   node scripts/send-test-email.js --variant convenience
 *   node scripts/send-test-email.js --variant question
 *   node scripts/send-test-email.js --variant sellthru
 *   node scripts/send-test-email.js --variant loss
 *   node scripts/send-test-email.js --variant diff
 *   node scripts/send-test-email.js --variant wholesale
 *
 * Available variants: margin | convenience | question | sellthru | loss | diff | wholesale
 *
 * Rotating sections (for conversion testing): --margin-bar N --conversion-block N --cta-block N --section-header N
 * Example: --conversion-block 1 --cta-block 2
 */
"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const { sendMaileroo } = require("../infra/send-email");
const { buildEmailHtml } = require("./daily-send-scheduler");
const { resolveBrandSender, enforceSender } = require("../infra/outbound-email-policy");

const ORDER_URL = process.env.SKYNPATCH_WHOLESALE_PAGE_URL || "https://skynpatch.com/wholesale";

// ── CLI args ──────────────────────────────────────────────────────────────

const toEmail = (() => {
  const i = process.argv.indexOf("--to");
  return i >= 0 ? String(process.argv[i + 1] || "").trim() : "shop@skynpatch.com";
})();

const variantKey = (() => {
  const i = process.argv.indexOf("--variant");
  return i >= 0 ? String(process.argv[i + 1] || "margin").trim() : "margin";
})();

// Optional: force specific rotating section indices for conversion testing
const getRotatingIndex = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? parseInt(process.argv[i + 1], 10) : undefined;
};

// ── Variant library ───────────────────────────────────────────────────────
// Mirrors the seeded variants in migration 026_experiment_engine.sql

const SUBJECTS = {
  margin:      "Health stores seeing 58% margin on this",
  convenience: "The wellness patch your customers are already searching for",
  question:    "Quick question about your supplement shelf",
  sellthru:    "A compact wellness add-on your team can sell quickly",
  loss:        "Are your customers buying this on Amazon instead?",
  diff:        "The wellness patch your customers are already buying online",
  wholesale:   "Wholesale opportunity for {{store_name}}",
  default:     "Wholesale wellness patches — Skyn Patch intro",
};

const HOOKS = {
  margin:
    "Most health stores see 58–60% margin on Skyn Patch. " +
    "It's one of the highest-margin categories on the shelf — no mixing, no prep, minimal staff training.",
  convenience:
    "Your customers are already searching for wellness patches online. " +
    "Skyn Patch lets you offer them in-store — scan-ready GS1 barcodes, zero prep, " +
    "and a compact shelf footprint that fits near checkout.",
  question:
    "Do you carry any topical wellness products? " +
    "Most stores we work with saw solid sell-through in the first 30 days — " +
    "just from positioning the patches near checkout alongside supplements.",
  sellthru:
    "Skyn Patch is built for fast retail execution — compact shelf footprint, clear positioning, and easy to explain at checkout. " +
    "Sleep, Energy, Vitality, Immunity, and Recovery in a single-use patch format.",
  loss:
    "Independent stores that pass on topical wellness are watching that category go to Amazon. " +
    "Skyn Patch gives you a scan-ready, shelf-ready way to capture that category in your store.",
  diff:
    "Your customers are already buying wellness patches online. Skyn Patch lets you capture that spend " +
    "in-store — with 8–12 hour slow-release delivery and GS1-registered barcodes.",
  wholesale:
    "We're looking for a few new wholesale partners in your area. " +
    "Skyn Patch carries 58% retail margin, ships within 2 business days, and is GS1-registered — " +
    "scan-ready for any POS system from day one.",
  default:
    "We make single-use wellness patches — Sleep, Energy, Vitality, Immunity, and Recovery — " +
    "that sit near checkout and sell without staff effort. No pills, no powders, " +
    "8–12 hours of slow-release delivery through the skin.",
};

const CTAS = {
  margin:      "Reply YES and I'll send the wholesale sheet.",
  convenience: "See the full wholesale sheet and pricing here: " + ORDER_URL,
  question:    "Reply YES and I'll send the wholesale sheet.",
  sellthru:    "Want to start with a sample first? Hit reply.",
  loss:        "Capture that category in your store. Reply YES for the wholesale sheet.",
  diff:        "Reply YES and I'll send the full wholesale sheet — or order the Starter Bundle directly below.",
  wholesale:   "Reply YES and I'll send the full wholesale sheet and current pricing.",
  default:     "Reply YES and I'll send the full wholesale sheet, or order the Starter Bundle directly below.",
};

// ── HTML builder (mirrors daily-send-scheduler.js buildEmailHtml) ─────────

// Uses same full template as live sends: all 7 SKUs, images, order grid, brief description each, CTAs.

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const sender = await resolveBrandSender(
    "skynpatch",
    process.env.MAILEROO_FROM_NAME || "Scott",
    process.env.MAILEROO_FROM_EMAIL
  );
  const fromName = sender.fromName;
  const fromEmail = sender.fromEmail;
  enforceSender({ brandSlug: "skynpatch", fromEmail, provisioningStatus: sender.provisioningStatus });
  const bizName  = "SkynPatch Preview";

  const hookText = HOOKS[variantKey] || HOOKS.default;
  const ctaLine  = CTAS[variantKey]  || CTAS.default;
  const subject  = (SUBJECTS[variantKey] || SUBJECTS.default)
    .replace("{{store_name}}", bizName);
  const lead = { business_name: bizName, email: toEmail };
  const rotating = {};
  const marginBarI = getRotatingIndex("margin-bar");
  const conversionI = getRotatingIndex("conversion-block");
  const ctaBlockI = getRotatingIndex("cta-block");
  const sectionHeaderI = getRotatingIndex("section-header");
  if (marginBarI != null) rotating.marginBar = marginBarI;
  if (conversionI != null) rotating.conversionBlock = conversionI;
  if (ctaBlockI != null) rotating.ctaBlock = ctaBlockI;
  if (sectionHeaderI != null) rotating.sectionHeader = sectionHeaderI;
  const html = buildEmailHtml(lead, fromName, { hook: hookText, cta: ctaLine, ...rotating });

  console.log("\n");
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║          SKYNPATCH — SEND TEST EMAIL                        ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");
  console.log(`  To      : ${toEmail}`);
  console.log(`  Subject : ${subject}`);
  console.log(`  Variant : ${variantKey}`);
  console.log(`  From    : ${fromName} <${fromEmail || "(MAILEROO_FROM_EMAIL not set)"}>`);
  console.log(`  CTA URL : ${ORDER_URL}\n`);

  const hasSendKey = process.env.RESEND_API_KEY || process.env.MAILEROO_API_KEY;
  if (!hasSendKey) {
    console.error("  ❌ RESEND_API_KEY or MAILEROO_API_KEY not set in .env");
    process.exit(1);
  }
  if (!fromEmail) {
    console.error("  ❌ MAILEROO_FROM_EMAIL not set in .env");
    process.exit(1);
  }

  try {
    const result = await sendMaileroo({
      to:        toEmail,
      subject,
      html,
      fromName,
      fromEmail,
      apiKey:    process.env.MAILEROO_API_KEY,
    });

    if (result.status === 200 || result.status === 201) {
      const msgId = result.body?.data?.message_id || result.body?.data?.id
        || result.body?.data?.reference_id || result.body?.reference_id
        || result.body?.message_id || result.body?.id || "(none)";
      console.log(`  ✅ Sent successfully! Maileroo message ID: ${msgId}`);
      console.log(`\n  Check ${toEmail} to preview the email in a real inbox.\n`);
    } else {
      console.error(`  ❌ Send failed: HTTP ${result.status}`);
      console.error(JSON.stringify(result.body, null, 2));
      process.exit(1);
    }
  } catch (e) {
    console.error(`  ❌ Error: ${e.message}`);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
