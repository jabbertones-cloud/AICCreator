#!/usr/bin/env node
/**
 * daily-send-scheduler.js
 * ──────────────────────────────────────────────────────────────────────────
 * Manages the Maileroo domain warm-up ramp and executes the daily email batch.
 *
 * Ramp schedule (days since first send):
 *   Days  1–7  :  20/day
 *   Days  8–14 :  50/day
 *   Days 15–21 : 100/day
 *   Days 22–28 : 200/day
 *   Days 29+   : 500/day
 *
 * Usage:
 *   node scripts/daily-send-scheduler.js              # run today's batch
 *   node scripts/daily-send-scheduler.js --dry-run    # show what would send, no sends
 *   node scripts/daily-send-scheduler.js --status     # show ramp progress only
 *   node scripts/daily-send-scheduler.js --reset      # reset ramp day counter (⚠️  careful)
 *
 * Run daily via cron:
 *   0 9 * * * cd $HOME/claw-architect && node scripts/daily-send-scheduler.js >> logs/email-sends.log 2>&1
 */
"use strict";

const path    = require("path");
const fs      = require("fs");
const crypto = require("crypto");
const { Pool } = require("pg");
const { sendMaileroo } = require("../infra/send-email");
const { resolveBrandSender, enforceSender } = require("../infra/outbound-email-policy");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

// Load Stripe payment links if stripe-setup-products.js has been run
const STRIPE_PRODUCTS_FILE = path.join(__dirname, "../.stripe-products.json");
const STRIPE_LINKS = fs.existsSync(STRIPE_PRODUCTS_FILE)
  ? JSON.parse(fs.readFileSync(STRIPE_PRODUCTS_FILE))
  : {};
/** Main "Order bundle" / wholesale form link — always the site page (Next.js /wholesale). */
const SKYNPATCH_WHOLESALE_PAGE_URL = process.env.SKYNPATCH_WHOLESALE_PAGE_URL || "https://skynpatch.com/wholesale";
const BUNDLE_URL = SKYNPATCH_WHOLESALE_PAGE_URL;
const UNSUBSCRIBE_BASE_URL = (process.env.UNSUBSCRIBE_BASE_URL || "https://skynpatch.com").replace(/\/$/, "");
const UNSUBSCRIBE_SECRET   = process.env.UNSUBSCRIBE_SECRET || process.env.RESEND_WEBHOOK_SECRET || process.env.MAILEROO_WEBHOOK_SECRET || "";

function buildUnsubscribeUrl(email) {
  if (!email || !UNSUBSCRIBE_SECRET) return null;
  const e = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  const sig = crypto.createHmac("sha256", UNSUBSCRIBE_SECRET).update(e).digest("hex");
  return `${UNSUBSCRIBE_BASE_URL}/api/webhook/unsubscribe?e=${encodeURIComponent(e)}&s=${sig}`;
}
const ORDER_URL  = BUNDLE_URL;

const dbHost = process.env.POSTGRES_HOST || process.env.CLAW_DB_HOST;
const dbPort = parseInt(process.env.POSTGRES_PORT || process.env.CLAW_DB_PORT || "15432", 10);
const dbUser = process.env.POSTGRES_USER || process.env.CLAW_DB_USER || "claw";
const dbPass = process.env.POSTGRES_PASSWORD || process.env.CLAW_DB_PASSWORD;
const dbName = process.env.POSTGRES_DB || process.env.CLAW_DB_NAME || "claw_architect";

if (!dbHost || !dbPass) {
  throw new Error("Missing DB env vars. Set POSTGRES_* (preferred) or CLAW_DB_* including password.");
}

const pool = new Pool({
  host: dbHost,
  port: dbPort,
  user: dbUser,
  password: dbPass,
  database: dbName,
});

const DRY_RUN     = process.argv.includes("--dry-run");
const STATUS_ONLY = process.argv.includes("--status");
const RESET       = process.argv.includes("--reset");
const MAX_SENDS   = Math.max(1, parseInt((() => {
  const i = process.argv.indexOf("--max-sends");
  return i >= 0 ? process.argv[i + 1] : "999999";
})(), 10) || 999999);
const FORCED_EMAIL = (() => {
  const i = process.argv.indexOf("--to-email");
  return i >= 0 ? String(process.argv[i + 1] || "").trim() : "";
})();
const FORCED_NAME = (() => {
  const i = process.argv.indexOf("--to-name");
  return i >= 0 ? String(process.argv[i + 1] || "").trim() : "SkynPatch Team";
})();

// Experiment engine — non-fatal if tables not yet migrated
let experiment = null;
try {
  experiment = require("./experiment-engine");
} catch (e) {
  console.warn(`[scheduler] experiment engine unavailable — sending static template: ${e.message}`);
}

// Ramp-up: [maxDay, dailyLimit]
const RAMP_SCHEDULE = [
  [7,   20],
  [14,  50],
  [21, 100],
  [28, 200],
  [Infinity, 500],
];

// State file — tracks first send date and daily counts
const STATE_FILE = path.join(__dirname, "../.leadgen-state.json");

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
    catch { /* fall through */ }
  }
  return { firstSendDate: null, totalSent: 0, daySends: {} };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function todayStr() {
  return new Date().toISOString().split("T")[0];
}

function getDayNumber(state) {
  if (!state.firstSendDate) return 1;
  const first = new Date(state.firstSendDate);
  const now   = new Date();
  const diff  = Math.floor((now - first) / (1000 * 60 * 60 * 24));
  return diff + 1;
}

function getDailyLimit(dayNumber) {
  for (const [maxDay, limit] of RAMP_SCHEDULE) {
    if (dayNumber <= maxDay) return limit;
  }
  return 500;
}

async function getDbSendsToday(brandSlug, template, tz = process.env.TZ || "America/Phoenix") {
  const { rows } = await pool.query(
    `WITH bounds AS (
       SELECT
         date_trunc('day', NOW() AT TIME ZONE $3) AT TIME ZONE $3 AS day_start,
         (date_trunc('day', NOW() AT TIME ZONE $3) + INTERVAL '1 day') AT TIME ZONE $3 AS day_end
     )
     SELECT COUNT(*)::int AS sends_today
     FROM email_sends es
     CROSS JOIN bounds b
     WHERE es.brand_slug = $1
       AND es.template = $2
       AND es.sent_at >= b.day_start
       AND es.sent_at < b.day_end`,
    [brandSlug, template, tz]
  );
  return Number(rows?.[0]?.sends_today || 0);
}

// ── Maileroo send ─────────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Rotating sections for conversion testing — experiment engine or random pick
const ROTATING = {
  marginBar: [
    "~58% retail margin · GS1 barcodes · Ships in 2 business days · 1-case MOQ",
    "High-margin wellness category · Scan-ready · Ships fast · One case minimum",
    "58% margin at MSRP · Shelf-ready · 2-day shipping · Low commitment",
  ],
  conversionBlock: [
    {
      title: "Why vitamin & wellness patches are a no-brainer add",
      bullets: [
        ["Fast-growing segment", "Transdermal wellness is one of the fastest-growing categories. Customers are already searching for it; give them a shelf option."],
        ["Minimal space", "Small footprint. Fits at checkout, next to supplements, or in a wellness strip. No bulky bottles or refrigeration."],
        ["High margin, high return", "~58% at MSRP. One of the best margin categories on the shelf. Strong dollar return per foot."],
        ["Repeat purchase", "4-patch packs drive reorders. Sleep, Energy, Recovery are ongoing needs; customers come back."],
      ],
    },
    {
      title: "Why stores are adding Skyn Patch",
      bullets: [
        ["Category growth", "Wellness patches are exploding. Be the first in your area to stock them."],
        ["Easy to sell", "No mixing, no prep. Staff just ring it up. Fits anywhere near supplements."],
        ["Real margins", "~58% at MSRP. Compare that to vitamins or snacks — this category wins."],
        ["Customers return", "Sleep and Energy drive reorders. Build basket and loyalty fast."],
      ],
    },
    {
      title: "The retail case for wellness patches",
      bullets: [
        ["Demand is there", "Customers search for patches online. Capture that spend in your store."],
        ["Tiny shelf space", "Stores fit 7 SKUs in less than a linear foot. High $/sq ft."],
        ["58% margin", "One of the strongest margin categories. Strong dollar return per foot."],
        ["Ongoing needs", "Sleep, Energy, Recovery = repeat purchases. Build loyalty."],
      ],
    },
    {
      title: "Why add patches to your wellness section",
      bullets: [
        ["Fast-growing segment", "Transdermal wellness is booming. Give customers what they're already buying online."],
        ["Minimal footprint", "Fits at checkout or by supplements. No refrigeration, no bulk."],
        ["Best-in-class margin", "~58% at MSRP. Strong dollar return per linear foot."],
        ["Repeat buyers", "4-patch packs = ongoing needs. Sleep, Energy, Recovery bring them back."],
      ],
    },
  ],
  ctaBlock: [
    { tagline: "Order any mix of 7 SKUs", title: "Wholesale order form", subtitle: "Set quantity per SKU · Shipping: $5 first case + $1 per additional (auto)", btn: "Build your order →" },
    { tagline: "Mix & match 7 SKUs", title: "Order form", subtitle: "One click — no account. $5 first case + $1 extra. Ships in 2 days.", btn: "Build your order →" },
    { tagline: "7 SKUs · one form", title: "Wholesale order form", subtitle: "Set quantity per SKU · Shipping auto-calculated · Ships in 2 business days", btn: "Order now →" },
  ],
  sectionHeader: [
    "All 7 SKUs — or use a single-product link below",
    "Shop by SKU below — each links to the order form with 1 case pre-filled",
    "All 7 SKUs — one-click order per SKU or mix-and-match on the form",
  ],
};

function pickRotating(key, variants, seed) {
  const options = ROTATING[key];
  if (!options?.length) return null;
  const fromVariant = variants?.[key];
  if (fromVariant != null && options[fromVariant]) return options[fromVariant];
  const idx = seed != null ? Math.abs(seed) % options.length : Math.floor(Math.random() * options.length);
  return options[idx];
}

function buildEmailHtml(lead, fromName, variants = {}) {
  // variants.hook / variants.cta override from experiment engine if available
  const hookText = variants.hook || null;
  const ctaText  = variants.cta  || null;
  const seed = lead?.id ? String(lead.id).split("").reduce((a, c) => a + c.charCodeAt(0), 0) : Date.now();

  const bizName = esc(lead.business_name);

  // Rotating sections (for conversion testing)
  const marginBar = pickRotating("marginBar", variants, seed) ?? ROTATING.marginBar[0];
  const conversionBlock = pickRotating("conversionBlock", variants, seed) ?? ROTATING.conversionBlock[0];
  const ctaBlock = pickRotating("ctaBlock", variants, seed) ?? ROTATING.ctaBlock[0];
  const sectionHeader = pickRotating("sectionHeader", variants, seed) ?? ROTATING.sectionHeader[0];

  // ── Stripe data — all 5 core SKUs + bundle (created for these emails) ──
  const bundle     = STRIPE_LINKS.starter_bundle;
  const bundlePrice = bundle ? "$" + (Number(bundle.amount) / 100) : "$900";
  const bundleUrl   = SKYNPATCH_WHOLESALE_PAGE_URL;
  const unsubscribeHref = buildUnsubscribeUrl(lead.email) || "mailto:unsubscribe@skynpatch.com?subject=Unsubscribe%20from%20Skyn%20Patch%20wholesale";

  // Product images: use same URLs as site (public/_bag.webp) so they load in email clients.
  const SKU_IMAGES = {
    zzzzz:     "https://skynpatch.com/images/zzzzzz_bag.webp",
    longevity: "https://skynpatch.com/images/longevity_bag.webp",
    grace:     "https://skynpatch.com/images/grace_bag.webp",
    lust:      "https://skynpatch.com/images/lust_bag.webp",
    ignite:    "https://skynpatch.com/images/ignite_bag.webp",
    synergy:   "https://skynpatch.com/images/synergy_bag.webp",
    pre_party: "https://skynpatch.com/images/preparty_bag.webp",
  };
  const FALLBACK_SKU_IMAGE = "https://skynpatch.com/images/zzzzzz_bag.webp";
  const TOP_HERO_GIF = process.env.SKYNPATCH_TOP_GIF_URL || "https://skynpatch.com/images/patch.gif";

  // All 7 SKUs — fixed order: Sleep, Longevity, Grace, Lust, Ignite, Synergy, Pre Party.
  // Each has image + brief description (benefit + ingredients). Keys map to STRIPE_LINKS where available.
  const SKUS = [
    {
      key: "zzzzz", label: "Zzzzz Sleep Patch", headline: "Sleep",
      benefit: "Steady melatonin + botanicals for deep rest.",
      ingredients: "Melatonin · L-Theanine · Magnesium · Passionflower · 5-HTP",
    },
    {
      key: "longevity", label: "Longevity NAD+ Patch", headline: "Longevity",
      benefit: "NAD+, NMN & antioxidants for healthy aging.",
      ingredients: "NAD+ · NMN · NR · Resveratrol · B Complex · Glutathione",
    },
    {
      // Grace: no wholesale Stripe product yet — falls back to bundleUrl (contact to order)
      key: "grace", label: "Grace Menopause Patch", headline: "Menopause",
      benefit: "Hot flash, mood & bone support with botanicals.",
      ingredients: "Black Cohosh · Ashwagandha · Vitamin D · Boron · Evening Primrose",
    },
    {
      // Lust: no wholesale Stripe product yet — falls back to bundleUrl (contact to order)
      key: "lust", label: "Lust Libido Patch", headline: "Libido",
      benefit: "Circulation & desire support for men & women.",
      ingredients: "Maca · Ginkgo Biloba · L-Arginine · Ashwagandha · Zinc",
    },
    {
      key: "ignite", label: "Ignite Energy Patch", headline: "Energy",
      benefit: "Clean energy for up to 12 hrs, no caffeine crash.",
      ingredients: "B12 · L-Carnitine · CoQ10 · Rhodiola Rosea · Magnesium",
    },
    {
      key: "synergy", label: "Synergy Metabolic Patch", headline: "Metabolic",
      benefit: "Appetite, glucose & digestion balance.",
      ingredients: "Berberine · Chromium · Green Tea · Gymnema · Bitter Melon",
    },
    {
      key: "pre_party", label: "Pre Party Hangover Patch", headline: "Recovery",
      benefit: "Liver support & hydration before drinking.",
      ingredients: "Milk Thistle · NAC · B Complex · Alpha Lipoic Acid · Electrolytes",
    },
  ];

  // Build individual SKU rows — "Order this SKU" links to wholesale page with that SKU = 1
  const skuRows = SKUS.map((sku) => {
    const link    = STRIPE_LINKS[sku.key];
    const price   = link ? "$" + (Number(link.amount) / 100) : "$250";
    // Order this SKU → goes to wholesale page with this SKU pre-filled to 1
    const orderThisSkuUrl = `${bundleUrl}${bundleUrl.includes("?") ? "&" : "?"}${encodeURIComponent(sku.key)}=1`;
    const ctaBtn = `<a href="${esc(orderThisSkuUrl)}"
            style="display:inline-block;margin-top:6px;font-family:Arial,sans-serif;
                   font-size:11px;font-weight:bold;color:#f0c040;background:#111111;
                   text-decoration:none;padding:5px 10px;border-radius:2px;">
           Order this SKU →
         </a>`
    const imgUrl = SKU_IMAGES[sku.key] || FALLBACK_SKU_IMAGE;
    const imgCell = `<td style="vertical-align:top;width:80px;padding-right:12px;">
          <img src="${esc(imgUrl)}" alt="${esc(sku.label)}" width="80" height="80" style="display:block;width:80px;height:80px;object-fit:cover;border-radius:4px;border:1px solid #eee;" />
        </td>`;
    return `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #eeeeee;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              ${imgCell}
              <td style="vertical-align:top;width:62%;">
                <div style="font-family:Arial,sans-serif;font-size:13px;font-weight:bold;color:#111111;">
                  ${esc(sku.label)}
                </div>
                <div style="font-family:Arial,sans-serif;font-size:12px;color:#555555;margin-top:2px;">
                  ${esc(sku.benefit)}
                </div>
                <div style="font-family:Arial,sans-serif;font-size:11px;color:#999999;margin-top:3px;">
                  ${esc(sku.ingredients)}
                </div>
              </td>
              <td style="vertical-align:top;text-align:right;white-space:nowrap;padding-left:12px;">
                <div style="font-family:Arial,sans-serif;font-size:13px;font-weight:bold;color:#111111;">
                  ${price}/case
                </div>
                <div style="font-family:Arial,sans-serif;font-size:11px;color:#777777;margin-top:1px;">
                  50 packs of 4 patches per case
                </div>
                ${ctaBtn}
              </td>
            </tr>
          </table>
        </td>
      </tr>`;
  }).join("");

  // Hook paragraph — experiment engine override or direct-sales default
  const hookPara = hookText
    ? esc(hookText)
    : `We carry 7 transdermal wellness patches — Sleep, Energy, Vitality, Immunity, Recovery, Lust, Grace — shelf-ready with GS1 barcodes, 36-month shelf life, and ~58% retail margin at MSRP. One case minimum. Shipping auto-calculated: $5 first case + $1 per additional.`;

  // CTA line — experiment override or static (recreates wholesale page offer, no iframe)
  const ctaLine = ctaText
    ? esc(ctaText)
    : `Set quantity per SKU on our order form (link below). One click to the form — no account needed. Or use the per-SKU links for a single product.`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Skyn Patch Wholesale</title>
</head>
<body style="margin:0;padding:0;background:#f0f0f0;font-family:Arial,sans-serif;">

<!-- Preview text (inbox preview / stop the scroll) -->
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;color:#f0f0f0;">
Vitamin patches: fast-growing segment, tiny shelf space, ~58% margin, strong repeat purchase. 7 SKUs. Order any mix — $5 first case + $1 per additional.
</div>

<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f0f0;padding:24px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0"
       style="background:#ffffff;max-width:600px;border-radius:4px;overflow:hidden;
              box-shadow:0 1px 4px rgba(0,0,0,0.08);">

  <!-- Top hero GIF (Zzzzz / sleep) -->
  <tr>
    <td style="padding:0;vertical-align:top;line-height:0;">
      <img src="${esc(TOP_HERO_GIF)}" alt="Skyn Patch — Wear Your Wellness" width="600" height="auto" style="display:block;width:100%;max-width:600px;height:auto;border:0;" />
    </td>
  </tr>

  <!-- Header -->
  <tr>
    <td style="background:#111111;padding:22px 28px;">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td>
            <div style="font-family:Georgia,serif;font-size:22px;color:#ffffff;
                        font-style:italic;font-weight:bold;letter-spacing:0.5px;">
              Skyn Patch
            </div>
            <div style="font-family:Arial,sans-serif;font-size:11px;color:#888888;margin-top:2px;">
              Wear Your Wellness™ &nbsp;·&nbsp; Wholesale Partner Offer
            </div>
          </td>
          <td align="right">
            <div style="font-family:Arial,sans-serif;font-size:11px;color:#888888;line-height:1.8;">
              <a href="https://skynpatch.com" style="color:#f0c040;text-decoration:none;">skynpatch.com</a><br>
              (xxx) xxx-xxxx
            </div>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- Margin callout bar (rotating) -->
  <tr>
    <td style="background:#f0c040;padding:10px 28px;">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="font-family:Arial,sans-serif;font-size:12px;font-weight:bold;color:#111111;">
            ${esc(marginBar)}
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- Body -->
  <tr>
    <td style="padding:24px 28px 8px;">

      <p style="margin:0 0 14px;font-size:14px;color:#222222;line-height:1.5;">
        Hi ${bizName},
      </p>

      <!-- Conversion block (rotating) -->
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;background:#f8f8f8;border-left:4px solid #f0c040;border-radius:3px;">
        <tr>
          <td style="padding:14px 18px;">
            <div style="font-family:Arial,sans-serif;font-size:11px;font-weight:bold;color:#111111;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:10px;">${esc(conversionBlock.title)}</div>
            <table width="100%" cellpadding="0" cellspacing="0">
              ${conversionBlock.bullets.map(([bold, desc]) => `<tr><td style="padding:3px 0;font-size:13px;color:#333333;line-height:1.5;"><span style="color:#f0c040;font-weight:bold;">✓</span> <strong>${esc(bold)}</strong> — ${esc(desc)}</td></tr>`).join("")}
            </table>
          </td>
        </tr>
      </table>

      <p style="margin:0 0 20px;font-size:14px;color:#333333;line-height:1.75;">
        ${hookPara}
      </p>

      <p style="margin:0 0 14px;font-size:14px;color:#333333;line-height:1.6;">
        ${ctaLine}
      </p>

    </td>
  </tr>

  <!-- Order form CTA (rotating) -->
  <tr>
    <td style="padding:0 28px 16px;">
      <table width="100%" cellpadding="0" cellspacing="0"
             style="background:#111111;border-radius:3px;overflow:hidden;">
        <tr>
          <td style="padding:16px 20px;">
            <div style="font-family:Arial,sans-serif;font-size:11px;font-weight:bold;
                        color:#f0c040;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">
              ${esc(ctaBlock.tagline)}
            </div>
            <div style="font-family:Georgia,serif;font-size:16px;color:#ffffff;font-weight:bold;">
              ${esc(ctaBlock.title)}
            </div>
            <div style="font-family:Arial,sans-serif;font-size:13px;color:#aaaaaa;margin-top:4px;">
              ${esc(ctaBlock.subtitle)}
            </div>
          </td>
          <td style="padding:16px 20px;text-align:right;white-space:nowrap;">
            <a href="${esc(bundleUrl)}"
               style="display:inline-block;background:#f0c040;color:#111111;
                      font-family:Arial,sans-serif;font-size:14px;font-weight:bold;
                      text-decoration:none;padding:12px 24px;border-radius:2px;">
              ${esc(ctaBlock.btn)}
            </a>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- Bundle option -->
  <tr>
    <td style="padding:0 28px 8px;">
      <table width="100%" cellpadding="0" cellspacing="0"
             style="background:#f8f8f8;border:1px solid #eee;border-radius:3px;">
        <tr>
          <td style="padding:12px 16px;">
            <span style="font-family:Arial,sans-serif;font-size:13px;color:#333;">Starter Bundle (all 4 core) — ${bundlePrice}</span>
            <a href="${esc(bundleUrl)}" style="margin-left:10px;font-size:12px;font-weight:bold;color:#f0c040;">Order bundle →</a>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- Product hero (Starter Bundle — Zzzzz, Ignite, Longevity, Synergy) -->
  <tr>
    <td style="padding:16px 28px 8px;">
      <a href="${esc(bundleUrl)}"><img src="https://skynpatch.com/images/wholesale-bundle.png" alt="Skyn Patch Starter Bundle — Zzzzz, Ignite, Longevity, Synergy" width="544" height="300" style="display:block;width:100%;max-width:544px;height:auto;border-radius:4px;border:1px solid #eee;" /></a>
    </td>
  </tr>

  <!-- Individual SKU section header (rotating) -->
  <tr>
    <td style="padding:12px 28px 4px;">
      <div style="font-family:Arial,sans-serif;font-size:11px;font-weight:bold;color:#111111;
                  text-transform:uppercase;letter-spacing:0.8px;border-bottom:2px solid #111111;
                  padding-bottom:6px;">
        ${esc(sectionHeader)}
      </div>
    </td>
  </tr>

  <!-- Individual SKU rows -->
  <tr>
    <td style="padding:0 28px 8px;">
      <table width="100%" cellpadding="0" cellspacing="0">
        ${skuRows}
      </table>
    </td>
  </tr>

  <!-- Shipping + scarcity (matches wholesale page copy) -->
  <tr>
    <td style="padding:12px 28px 20px;">
      <table width="100%" cellpadding="0" cellspacing="0"
             style="background:#fffbf0;border-left:3px solid #f0c040;border-radius:2px;">
        <tr>
          <td style="padding:12px 16px;font-family:Arial,sans-serif;font-size:12px;
                     color:#555555;line-height:1.7;">
            📦 <strong>Shipping:</strong> Starter Bundle (4 cases) ships for $8 when ordered alone, or adds $4 shipping when combined with a wholesale order. Regular wholesale orders: $5 first case + $1 per additional (same as on our order form).<br>
            <strong>In stock</strong> — ships within 2 business days. Need 3+ cases? Reply for volume pricing.
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- Trust signals -->
  <tr>
    <td style="padding:0 28px 22px;">
      <p style="margin:0;font-family:Arial,sans-serif;font-size:11px;color:#999999;
                border-top:1px solid #eeeeee;padding-top:14px;line-height:1.8;">
        GS1-registered barcodes (UPC prefix 0085005) — scan-ready for any POS.<br>
        36-month shelf life &nbsp;·&nbsp; Shelf-ready display included &nbsp;·&nbsp;
        White-label available on large orders.
      </p>
    </td>
  </tr>

  <!-- Sign-off -->
  <tr>
    <td style="padding:0 28px 28px;">
      <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:#333333;line-height:1.6;">
        — ${esc(fromName)}<br>
        <span style="color:#888888;font-size:11px;">
          Skyn Patch &nbsp;·&nbsp;
          <a href="mailto:shop@skynpatch.com" style="color:#888888;">shop@skynpatch.com</a>
          &nbsp;·&nbsp; (xxx) xxx-xxxx
        </span>
      </p>
    </td>
  </tr>

  <!-- CAN-SPAM footer: address + unsubscribe (one-click webhook link when secret set) -->
  <tr>
    <td style="background:#f9f9f9;padding:14px 28px;border-top:1px solid #eeeeee;">
      <p style="margin:0;font-family:Arial,sans-serif;font-size:10px;color:#aaaaaa;
                line-height:1.6;text-align:center;">
        Skyn Patch &nbsp;·&nbsp; 1730 S El Camino Dr, Tempe, AZ 85281 &nbsp;·&nbsp;
        <a href="https://skynpatch.com" style="color:#aaaaaa;">skynpatch.com</a><br>
        You received this because your business may carry wellness products.<br>
        <a href="${esc(unsubscribeHref)}"
           style="display:inline-block;margin-top:8px;font-family:Arial,sans-serif;font-size:11px;
                  color:#888888;text-decoration:underline;">Unsubscribe</a>
        &nbsp;·&nbsp; Or reply UNSUBSCRIBE or email
        <a href="mailto:unsubscribe@skynpatch.com" style="color:#aaaaaa;">unsubscribe@skynpatch.com</a>
      </p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

async function mailerooSend(to, toName, subject, html, sender) {
  const MAX_ATTEMPTS = 3;
  const RETRY_MS     = [0, 2000, 5000]; // immediate, 2s, 5s backoff
  let lastResult;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (RETRY_MS[attempt] > 0) await sleep(RETRY_MS[attempt]);
    try {
      lastResult = await sendMaileroo({
        to,
        subject,
        html,
        fromName: sender.fromName,
        fromEmail: sender.fromEmail,
        apiKey: process.env.MAILEROO_API_KEY,
        provider: "resend", // Skyn Patch uses Resend
      });
      // 2xx = success; 4xx = permanent failure (don't retry); 5xx = transient (retry)
      if (lastResult.status >= 200 && lastResult.status < 300) return lastResult;
      if (lastResult.status >= 400 && lastResult.status < 500) return lastResult; // client error, no retry
      // 5xx — retry
      console.warn(`  [maileroo] HTTP ${lastResult.status} attempt ${attempt + 1}/${MAX_ATTEMPTS} — will retry`);
    } catch (e) {
      // Network error — retry
      lastResult = { status: 0, body: {}, _err: e };
      console.warn(`  [maileroo] network error attempt ${attempt + 1}/${MAX_ATTEMPTS}: ${e.message}`);
    }
  }
  return lastResult;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function decodeUnicodeEscapes(input) {
  return String(input).replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}

function sanitizeEmail(raw) {
  if (!raw) return null;
  let email = decodeUnicodeEscapes(raw).trim();
  email = email.replace(/^mailto:/i, "");
  email = email.replace(/["'<>]/g, "");
  email = email.replace(/\s+/g, "");
  if (email.includes(",")) email = email.split(",")[0].trim();
  if (email.includes(";")) email = email.split(";")[0].trim();
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email)
    ? email.toLowerCase()
    : null;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  await pool.query(`
    ALTER TABLE brands
      ADD COLUMN IF NOT EXISTS from_name   TEXT,
      ADD COLUMN IF NOT EXISTS brand_email TEXT
  `).catch(() => {});

  const state   = loadState();
  const today   = todayStr();
  const dayNum  = getDayNumber(state);
  const limit   = getDailyLimit(dayNum);
  const dbSentToday = await getDbSendsToday("skynpatch", "skynpatch_b2b_intro");
  const fileSentToday = Number(state.daySends[today] || 0);
  const sentToday = dbSentToday;
  const remaining = Math.max(0, limit - sentToday);

  if (fileSentToday !== dbSentToday) {
    state.daySends[today] = dbSentToday;
    saveState(state);
    console.log(`  ↺ Synced state day count from DB (${fileSentToday} -> ${dbSentToday})`);
  }

  console.log("\n");
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║          SKYNPATCH DAILY EMAIL SCHEDULER                    ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");
  console.log(`  📅 Today           : ${today}`);
  console.log(`  📈 Ramp day        : ${dayNum}`);
  console.log(`  📊 Daily limit     : ${limit} emails`);
  console.log(`  ✉️  Sent today      : ${sentToday}`);
  console.log(`  🔄 Remaining today : ${remaining}\n`);

  if (STATUS_ONLY) {
    console.log("  (status only — no sends)\n");
    await pool.end();
    return;
  }

  if (RESET) {
    const newState = { firstSendDate: null, totalSent: 0, daySends: {} };
    saveState(newState);
    console.log("  ⚠️  State reset. Next run will start ramp from Day 1.\n");
    await pool.end();
    return;
  }

  if (remaining <= 0 && !FORCED_EMAIL) {
    console.log(`  ✅ Daily limit (${limit}) already reached for today.\n`);
    await pool.end();
    return;
  }
  if (FORCED_EMAIL) console.log("  📤 Forced recipient — sending regardless of daily limit.\n");

  if (DRY_RUN) console.log("  ⚠️  DRY RUN — no actual sends\n");

  // Fetch unsent leads with email addresses, prioritized by category
  const runLimit = Math.max(0, Math.min(remaining, MAX_SENDS));
  const sender = await resolveBrandSender(
    "skynpatch",
    process.env.MAILEROO_FROM_NAME || "Scott",
    process.env.MAILEROO_FROM_EMAIL
  );
  const fromName = sender.fromName;
  const fromEmail = sender.fromEmail;
  enforceSender({ brandSlug: "skynpatch", fromEmail, provisioningStatus: sender.provisioningStatus });
  const { rows: queriedLeads } = await pool.query(`
    SELECT l.*, b.name AS brand_name, b.from_name
    FROM leads l
    LEFT JOIN brands b ON b.slug = l.brand_slug
    WHERE l.email IS NOT NULL
      AND l.email != ''
      AND l.status != 'unsubscribed'
      AND l.status != 'bounced'
      AND NOT EXISTS (
        SELECT 1 FROM email_sends es
        WHERE es.lead_id = l.id AND es.template = 'skynpatch_b2b_intro'
      )
    ORDER BY
      CASE WHEN l.contact_title IS NOT NULL AND (
        l.contact_title ILIKE '%buyer%' OR l.contact_title ILIKE '%purchasing%'
        OR l.contact_title ILIKE '%wholesale%' OR l.contact_title ILIKE '%merchandise%'
        OR l.contact_title ILIKE '%procurement%'
      ) THEN 0 ELSE 1 END,
      CASE l.category
        WHEN 'gym'               THEN 1
        WHEN 'yoga studio'       THEN 1
        WHEN 'health food store' THEN 2
        WHEN 'spa'               THEN 2
        WHEN 'pharmacy'          THEN 3
        ELSE 4
      END,
      l.id ASC
    LIMIT $1
  `, [runLimit]);
  const leads = FORCED_EMAIL
    ? [{
        id: null,
        brand_slug: process.env.LEADGEN_BRAND_SLUG || "skynpatch",
        business_name: FORCED_NAME || "SkynPatch Team",
        email: FORCED_EMAIL,
        from_name: fromName,
        category: "preview",
      }]
    : queriedLeads;

  console.log(`  📋 Ready to send : ${leads.length} leads`);
  if (MAX_SENDS < 999999) console.log(`  🎛️  Max sends this run: ${MAX_SENDS}`);
  console.log("");

  let sent = 0, failed = 0, skipped = 0;

  for (const lead of leads) {
    const leadName = String(lead.business_name || lead.to_name || "Unknown Lead");
    const cleanEmail = sanitizeEmail(lead.email);
    if (!cleanEmail) {
      process.stdout.write(`  → ${leadName.slice(0,40).padEnd(41)} ${String(lead.email || "").slice(0,35).padEnd(36)} [invalid email, skipped]\n`);
      if (!FORCED_EMAIL) {
        await pool.query(
          `INSERT INTO email_sends
             (lead_id, brand_slug, to_email, to_name, subject, template, status, sent_at)
           VALUES ($1,$2,$3,$4,$5,$6,'failed',NOW())
           ON CONFLICT (lead_id, template) DO NOTHING`,
          [lead.id, lead.brand_slug, lead.email, leadName, "(invalid email)", "skynpatch_b2b_intro"]
        ).catch(() => {});
      }
      failed++;
      continue;
    }

    // Select A/B variant combo for this lead (falls back to defaults if engine unavailable)
    const combo   = experiment ? await experiment.selectVariantCombo(lead.category || 'health_store').catch(() => ({})) : {};
    const content = experiment ? await experiment.resolveVariantContent(combo).catch(() => ({})) : {};

    // Variant subject or static fallback
    const subject = content.subject
      ? content.subject.replace('{{store_name}}', leadName)
      : `Skyn Patch wholesale — 58% margin, 6 SKUs in stock, order in this email`;

    const html = buildEmailHtml(lead, lead.from_name || fromName, {
      hook: content.hook || null,
      cta:  content.cta  || null,
    });

    process.stdout.write(`  → ${leadName.slice(0,40).padEnd(41)} ${cleanEmail.slice(0,35).padEnd(36)}`);

    if (DRY_RUN) {
      process.stdout.write(" [DRY RUN]\n");
      sent++;
      continue;
    }

    try {
      // ── Dedup guard: claim the slot BEFORE calling Maileroo ──────────────
      // Uses INSERT ... ON CONFLICT DO NOTHING (migration 027 adds unique constraint
      // on (lead_id, template)). If another run already claimed this slot we get
      // 0 rows inserted and skip, preventing any duplicate send.
      let claimed = true;
      if (!FORCED_EMAIL) {
        const claimRes = await pool.query(
          `INSERT INTO email_sends
             (lead_id, brand_slug, to_email, to_name, subject, template, status, sent_at)
           VALUES ($1,$2,$3,$4,$5,$6,'sending',NOW())
           ON CONFLICT (lead_id, template) DO NOTHING
           RETURNING id`,
          [lead.id, lead.brand_slug, cleanEmail, leadName, subject, "skynpatch_b2b_intro"]
        );
        if (claimRes.rowCount === 0) {
          // Another run beat us to it — skip this lead silently
          process.stdout.write(" [already claimed, skipped]\n");
          skipped++;
          continue;
        }
        // Keep the new record's id for the update below
        lead._sendRecordId = claimRes.rows[0].id;
      }

      const result = await mailerooSend(cleanEmail, leadName, subject, html, { fromName, fromEmail });

      if (result.status === 200 || result.status === 201) {
        const mailerooId = result.body?.data?.message_id || result.body?.data?.id
          || result.body?.data?.reference_id || result.body?.reference_id
          || result.body?.message_id || result.body?.id || null;
        if (!FORCED_EMAIL) {
          // Update the pre-claimed record to 'sent'
          await pool.query(
            `UPDATE email_sends
             SET status='sent', maileroo_id=$1, sent_at=NOW()
             WHERE id=$2`,
            [mailerooId, lead._sendRecordId]
          );
          await pool.query("UPDATE leads SET status='emailed' WHERE id=$1 AND status='new'", [lead.id]);
          // Log which variant combo was used — feeds the revenue attribution loop
          if (experiment?.logSend) {
            experiment.logSend(lead.id, combo, lead.category || 'health_store').catch(() => {});
          }
        }
        process.stdout.write(" ✓\n");
        sent++;
      } else {
        if (!FORCED_EMAIL && lead._sendRecordId) {
          // Mark as failed so dashboards can see it; will NOT retry (slot is taken)
          // To retry a failed send, delete the email_sends row and re-run
          await pool.query(
            `UPDATE email_sends SET status='failed' WHERE id=$1`,
            [lead._sendRecordId]
          ).catch(() => {});
        }
        process.stdout.write(` ✗ HTTP ${result.status}\n`);
        failed++;
      }
    } catch (e) {
      if (!FORCED_EMAIL && lead._sendRecordId) {
        await pool.query(
          `UPDATE email_sends SET status='failed' WHERE id=$1`,
          [lead._sendRecordId]
        ).catch(() => {});
      }
      process.stdout.write(` ✗ ${e.message.slice(0, 40)}\n`);
      failed++;
    }

    // Small delay between sends to avoid rate limits
    await sleep(500);
  }

  // Update state
  if (!DRY_RUN && sent > 0 && !FORCED_EMAIL) {
    if (!state.firstSendDate) state.firstSendDate = today;
    state.daySends[today] = (state.daySends[today] || 0) + sent;
    state.totalSent = (state.totalSent || 0) + sent;
    saveState(state);
  }

  console.log(`\n  ✅ Sent    : ${sent}`);
  console.log(`  ❌ Failed  : ${failed}`);
  console.log(`  ⏭️  Skipped : ${skipped}`);
  console.log(`  📊 Total ever sent: ${(state.totalSent || 0) + (DRY_RUN ? 0 : sent)}\n`);

  // Remind about tomorrow's limit
  const tomorrowDay = dayNum + 1;
  const tomorrowLimit = getDailyLimit(tomorrowDay);
  if (tomorrowLimit !== limit) {
    console.log(`  📈 Tomorrow (day ${tomorrowDay}): ramp increases to ${tomorrowLimit} emails/day\n`);
  }

  await pool.end();
  // Close experiment engine pool if it was loaded (it creates its own pool)
  if (experiment?.closePool) await experiment.closePool().catch(() => {});
}

if (require.main === module) {
  main().catch(async (e) => {
    console.error(e);
    await pool.end().catch(() => {});
    if (experiment?.closePool) await experiment.closePool().catch(() => {});
    process.exit(1);
  });
} else {
  module.exports = { buildEmailHtml };
}
