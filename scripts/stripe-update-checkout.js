#!/usr/bin/env node
/**
 * stripe-update-checkout.js
 * ──────────────────────────────────────────────────────────────────────────
 * Adds MOQ / shipping / payment / returns info to the custom_text block
 * of every SkynPatch Stripe Payment Link. This text appears above the
 * "Pay" button on the Stripe hosted checkout page.
 *
 * Safe to run multiple times — idempotent update.
 *
 * Usage:
 *   node scripts/stripe-update-checkout.js            # update all links
 *   node scripts/stripe-update-checkout.js --dry-run  # preview only
 *   node scripts/stripe-update-checkout.js --key starter_bundle  # one link only
 */
"use strict";

const https  = require("https");
const path   = require("path");
const fs     = require("fs");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const DRY_RUN    = process.argv.includes("--dry-run");
const FORCED_KEY = (() => {
  const i = process.argv.indexOf("--key");
  return i >= 0 ? process.argv[i + 1] : null;
})();

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_KEY && !DRY_RUN) {
  console.error("STRIPE_SECRET_KEY not set in .env");
  process.exit(1);
}

const PRODUCTS_FILE = path.join(__dirname, "../.stripe-products.json");
if (!fs.existsSync(PRODUCTS_FILE)) {
  console.error("❌  .stripe-products.json not found. Run stripe-setup-products.js first.");
  process.exit(1);
}
const stripeData = JSON.parse(fs.readFileSync(PRODUCTS_FILE, "utf8"));

// ── Checkout info block ───────────────────────────────────────────────────
// This text appears above the Pay button on every payment link page.
// Stripe allows up to 1200 characters.
const CHECKOUT_CUSTOM_TEXT =
  "Minimum Order: 1 master case (50 packs). " +
  "Shipping: In-stock inventory ships within 2 business days; delivered in 5–8 business days via standard ground. " +
  "Payment: Secure card payment via Stripe — no net terms on first order. " +
  "Returns: Wellness consumables are non-returnable. Damaged or incorrect shipments are replaced at no charge — contact shop@skynpatch.com within 7 days. " +
  "Volume pricing available on multi-case orders. Contact shop@skynpatch.com or (xxx) xxx-xxxx.";

// ── Stripe helper ─────────────────────────────────────────────────────────

function stripePost(endpoint, params) {
  const body = new URLSearchParams(params).toString();
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "api.stripe.com",
      path:     endpoint,
      method:   "POST",
      headers:  {
        "Authorization":  `Bearer ${STRIPE_KEY}`,
        "Content-Type":   "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
        "Stripe-Version": "2024-06-20",
      },
    };
    const req = https.request(opts, res => {
      let raw = "";
      res.on("data", d => raw += d);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, data: raw }); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n");
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║     STRIPE CHECKOUT — ADD MOQ / SHIPPING / RETURNS TEXT     ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  if (DRY_RUN) console.log("  ⚠️  DRY RUN — no Stripe API calls\n");

  console.log("  Custom text preview:");
  console.log(`  "${CHECKOUT_CUSTOM_TEXT}"`);
  console.log(`\n  Length: ${CHECKOUT_CUSTOM_TEXT.length} / 1200 chars\n`);

  if (CHECKOUT_CUSTOM_TEXT.length > 1200) {
    console.error("  ❌ Custom text exceeds Stripe 1200-char limit. Shorten CHECKOUT_CUSTOM_TEXT.");
    process.exit(1);
  }

  let updated = 0, skipped = 0, failed = 0;

  for (const [key, data] of Object.entries(stripeData)) {
    // Skip non-product entries (e.g. updatedAt timestamp)
    if (!data || typeof data !== "object" || !data.paymentLinkId) {
      if (key !== "updatedAt") console.log(`  ⏭️  ${key}: no paymentLinkId — skipping`);
      skipped++;
      continue;
    }
    if (FORCED_KEY && key !== FORCED_KEY) continue;

    console.log(`  → ${key.padEnd(22)} ${data.paymentLinkId}`);

    if (DRY_RUN) {
      console.log(`     [DRY RUN] would update custom_text.submit.message`);
      continue;
    }

    try {
      const res = await stripePost(`/v1/payment_links/${data.paymentLinkId}`, {
        "custom_text[submit][message]": CHECKOUT_CUSTOM_TEXT,
      });
      if (res.status === 200) {
        console.log(`     ✓ updated`);
        updated++;
      } else {
        console.error(`     ✗ HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 150)}`);
        failed++;
      }
    } catch (e) {
      console.error(`     ✗ ${e.message}`);
      failed++;
    }
  }

  console.log(`\n  ✅ Updated: ${updated}  Skipped: ${skipped}  Failed: ${failed}\n`);
  if (!DRY_RUN && updated > 0) {
    console.log("  Checkout pages now show MOQ / shipping / payment / returns info.\n");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
