#!/usr/bin/env node
/**
 * stripe-webhook-handler.js
 * ──────────────────────────────────────────────────────────────────────────
 * Handles Stripe webhook events for SkynPatch wholesale orders.
 * Mounted into webhook-server.js at POST /api/webhook/stripe
 * NOTE: This handler is for SkynPatch order lifecycle + attribution only.
 * Prompt Oracle payment confirmation is handled by scripts/payment-router.js.
 *
 * Events handled:
 *   checkout.session.completed  → store order, email buyer + admin
 *   payment_intent.succeeded    → update order status
 *   payment_intent.payment_failed → log failed payment
 *   charge.refunded             → update order, email buyer
 *
 * Emails sent via Maileroo (same setup as lead gen):
 *   - Buyer: order confirmation with items, shipping estimate, contact info
 *   - Admin (shop@skynpatch.com): new order alert with full details
 */
"use strict";

const crypto = require("crypto");
const path   = require("path");
const { Pool } = require("pg");
const { sendMaileroo } = require("../infra/send-email");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const pool = new Pool({
  host:     process.env.POSTGRES_HOST     || process.env.CLAW_DB_HOST,
  port:     parseInt(process.env.POSTGRES_PORT || process.env.CLAW_DB_PORT || "15432", 10),
  user:     process.env.POSTGRES_USER     || process.env.CLAW_DB_USER || "claw",
  password: process.env.POSTGRES_PASSWORD || process.env.CLAW_DB_PASSWORD,
  database: process.env.POSTGRES_DB       || process.env.CLAW_DB_NAME || "claw_architect",
  max: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000,
});

if (!process.env.POSTGRES_HOST && !process.env.CLAW_DB_HOST) {
  throw new Error("[stripe-wh] Missing DB host env var. Set POSTGRES_HOST or CLAW_DB_HOST.");
}
if (!process.env.POSTGRES_PASSWORD && !process.env.CLAW_DB_PASSWORD) {
  throw new Error("[stripe-wh] Missing DB password env var. Set POSTGRES_PASSWORD or CLAW_DB_PASSWORD.");
}

process.on("SIGTERM", () => { pool.end().catch(() => {}); });
process.on("SIGINT",  () => { pool.end().catch(() => {}); });

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const MAILEROO_KEY   = process.env.MAILEROO_API_KEY;
const FROM_EMAIL     = process.env.MAILEROO_FROM_EMAIL || "shop@skynpatch.com";
const FROM_NAME      = process.env.MAILEROO_FROM_NAME  || "Scott";
const ADMIN_EMAIL    = process.env.ADMIN_EMAIL         || "shop@skynpatch.com";

let experiment = null;
try {
  experiment = require("./experiment-engine");
} catch (e) {
  console.warn(`[stripe-wh] experiment engine unavailable: ${e.message}`);
}

// ── Signature verification ─────────────────────────────────────────────────

function verifyStripeSignature(rawBody, sigHeader) {
  if (!STRIPE_WEBHOOK_SECRET) {
    console.warn("[stripe-wh] STRIPE_WEBHOOK_SECRET not set — skipping verification");
    return true;
  }
  // Stripe signature: "t=timestamp,v1=hash,..."
  const parts = {};
  sigHeader.split(",").forEach(p => {
    const [k, v] = p.split("=");
    parts[k] = v;
  });
  if (!parts.t || !parts.v1) return false;
  const payload  = `${parts.t}.${rawBody}`;
  const expected = crypto.createHmac("sha256", STRIPE_WEBHOOK_SECRET).update(payload).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
  } catch { return false; }
}

// ── Maileroo send ──────────────────────────────────────────────────────────

function sendEmail(to, subject, html) {
  if (!MAILEROO_KEY) { console.warn("[stripe-wh] MAILEROO_API_KEY not set — skipping email"); return Promise.resolve(); }
  return sendMaileroo({
    to,
    subject,
    html,
    fromName: FROM_NAME,
    fromEmail: FROM_EMAIL,
    apiKey: MAILEROO_KEY,
  })
    .then((res) => {
      console.log(`[stripe-wh] email → ${to} HTTP ${res.status}`);
    })
    .catch((e) => {
      console.error("[stripe-wh] email error:", e.message);
    });
}

function esc(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function formatCents(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

// ── Email templates ────────────────────────────────────────────────────────

function buyerConfirmationEmail(session, lineItems) {
  const name    = esc(session.customer_details?.name || session.custom_fields?.find(f=>f.key==="business_name")?.text?.value || "Wholesale Partner");
  const email   = session.customer_details?.email || "";
  const address = session.shipping_details?.address || session.customer_details?.address || {};
  const addrStr = [address.line1, address.line2, address.city, address.state, address.postal_code].filter(Boolean).join(", ");
  const total   = formatCents(session.amount_total || 0);
  const orderId = session.id;

  const itemRows = (lineItems || []).map(item => `
    <tr>
      <td style="font-family:Arial,sans-serif;font-size:13px;color:#333;padding:8px 10px;border-top:1px solid #eee;">${esc(item.description || item.price?.product?.name || "Item")}</td>
      <td style="font-family:Arial,sans-serif;font-size:13px;color:#333;padding:8px 10px;text-align:center;border-top:1px solid #eee;">${item.quantity}</td>
      <td style="font-family:Arial,sans-serif;font-size:13px;font-weight:bold;color:#333;padding:8px 10px;text-align:right;border-top:1px solid #eee;">${formatCents(item.amount_total || 0)}</td>
    </tr>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Order Confirmed</title></head>
<body style="margin:0;padding:0;background:#f8f8f8;font-family:Georgia,serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f8f8;padding:20px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;max-width:600px;">

  <tr><td style="background:#000;padding:24px 32px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td><div style="font-family:Georgia,serif;font-size:28px;color:#fff;font-style:italic;font-weight:bold;">Skyn Patch</div>
          <div style="font-family:Arial,sans-serif;font-size:11px;color:#ccc;margin-top:3px;">Wear Your Wellness™</div></td>
      <td align="right" style="font-family:Arial,sans-serif;font-size:12px;color:#ccc;line-height:1.7;">
        <a href="https://skynpatch.com" style="color:#ccc;">skynpatch.com</a><br>
        shop@skynpatch.com<br>(xxx) xxx-xxxx</td>
    </tr></table>
  </td></tr>

  <tr><td style="background:#f0c040;padding:12px 32px;text-align:center;">
    <div style="font-family:Arial,sans-serif;font-size:15px;font-weight:bold;color:#000;">✓ Order Confirmed — Thank You!</div>
  </td></tr>

  <tr><td style="padding:28px 32px 16px;">
    <p style="margin:0 0 10px;font-family:Arial,sans-serif;font-size:14px;color:#333;">Hi ${name},</p>
    <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6;">
      Thank you for your wholesale order! We've received your payment and your order is being prepared.
      You can expect delivery within <strong>7–10 business days</strong>.
    </p>
  </td></tr>

  <tr><td style="padding:0 32px 20px;">
    <div style="font-family:Arial,sans-serif;font-size:12px;font-weight:bold;color:#000;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Order Summary</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #ddd;border-radius:4px;overflow:hidden;">
      <tr style="background:#333;">
        <td style="font-family:Arial,sans-serif;font-size:11px;font-weight:bold;color:#fff;padding:8px 10px;">Item</td>
        <td style="font-family:Arial,sans-serif;font-size:11px;font-weight:bold;color:#fff;padding:8px 10px;text-align:center;">Qty</td>
        <td style="font-family:Arial,sans-serif;font-size:11px;font-weight:bold;color:#fff;padding:8px 10px;text-align:right;">Total</td>
      </tr>
      ${itemRows}
      <tr style="background:#f9f9f9;">
        <td colspan="2" style="font-family:Arial,sans-serif;font-size:13px;font-weight:bold;color:#333;padding:10px 10px;border-top:2px solid #333;text-align:right;">Order Total:</td>
        <td style="font-family:Arial,sans-serif;font-size:14px;font-weight:bold;color:#333;padding:10px 10px;text-align:right;border-top:2px solid #333;">${total}</td>
      </tr>
    </table>
  </td></tr>

  ${addrStr ? `<tr><td style="padding:0 32px 20px;">
    <div style="font-family:Arial,sans-serif;font-size:12px;font-weight:bold;color:#000;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Shipping To</div>
    <div style="font-family:Arial,sans-serif;font-size:13px;color:#555;">${name}<br>${esc(addrStr)}</div>
  </td></tr>` : ""}

  <tr><td style="padding:0 32px 28px;">
    <div style="background:#f5f5f5;border-left:4px solid #f0c040;padding:14px 16px;border-radius:2px;">
      <div style="font-family:Arial,sans-serif;font-size:13px;color:#333;line-height:1.7;">
        📦 <strong>Shipping:</strong> 7–10 business days after order confirmation<br>
        🔄 <strong>Reorders:</strong> Reply to this email or call (xxx) xxx-xxxx<br>
        📦 <strong>Display:</strong> Shelf-ready display stands included with first order<br>
        🏷️  <strong>Order Ref:</strong> <code style="font-size:11px;color:#888;">${esc(orderId)}</code>
      </div>
    </div>
  </td></tr>

  <tr><td style="padding:0 32px 28px;text-align:center;">
    <p style="font-family:Arial,sans-serif;font-size:13px;color:#333;">Questions? We're easy to reach:</p>
    <p style="font-family:Arial,sans-serif;font-size:13px;color:#333;">
      <a href="mailto:shop@skynpatch.com" style="color:#000;font-weight:bold;">shop@skynpatch.com</a>
      &nbsp;&nbsp;|&nbsp;&nbsp;
      <a href="tel:0000000000" style="color:#000;font-weight:bold;">(xxx) xxx-xxxx</a>
    </p>
  </td></tr>

  <tr><td style="background:#f5f5f5;padding:14px 32px;border-top:1px solid #e0e0e0;text-align:center;">
    <div style="font-family:Georgia,serif;font-size:12px;color:#555;font-style:italic;">
      Add wearable wellness to your shelves.<br>
      <span style="font-size:11px;color:#888;">Customers understand it. Staff can sell it. Stores reorder it.</span>
    </div>
  </td></tr>

  <tr><td style="padding:14px 32px;border-top:1px solid #eee;">
    <p style="margin:0;font-family:Arial,sans-serif;font-size:10px;color:#aaa;text-align:center;line-height:1.6;">
      Skyn Patch &middot; Tempe, AZ &middot; <a href="https://skynpatch.com" style="color:#aaa;">skynpatch.com</a><br>
      This is a transactional order confirmation — you cannot unsubscribe from order receipts.
    </p>
  </td></tr>

</table></td></tr></table>
</body></html>`;
}

function adminAlertEmail(session, lineItems) {
  const buyerName  = session.customer_details?.name || session.custom_fields?.find(f=>f.key==="business_name")?.text?.value || "(unknown)";
  const buyerEmail = session.customer_details?.email || "(no email)";
  const buyerPhone = session.customer_details?.phone || "(no phone)";
  const address    = session.shipping_details?.address || session.customer_details?.address || {};
  const addrStr    = [address.line1, address.city, address.state, address.postal_code].filter(Boolean).join(", ");
  const total      = formatCents(session.amount_total || 0);
  const orderId    = session.id;

  const itemList = (lineItems || []).map(item =>
    `• ${item.description || "Item"} × ${item.quantity} = ${formatCents(item.amount_total || 0)}`
  ).join("<br>");

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>New Wholesale Order</title></head>
<body style="margin:0;padding:20px;font-family:Arial,sans-serif;background:#f8f8f8;">
<div style="max-width:560px;background:#fff;padding:28px;border-radius:8px;border-left:6px solid #f0c040;">
  <h2 style="margin:0 0 4px;font-size:20px;color:#000;">🛒 New Wholesale Order — ${esc(total)}</h2>
  <p style="margin:0 0 20px;font-size:13px;color:#888;">Skyn Patch · ${new Date().toLocaleString()}</p>

  <table width="100%" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px;color:#333;">
    <tr><td style="font-weight:bold;width:130px;border-bottom:1px solid #eee;">Buyer</td><td style="border-bottom:1px solid #eee;">${esc(buyerName)}</td></tr>
    <tr><td style="font-weight:bold;border-bottom:1px solid #eee;">Email</td><td style="border-bottom:1px solid #eee;"><a href="mailto:${esc(buyerEmail)}" style="color:#000;">${esc(buyerEmail)}</a></td></tr>
    <tr><td style="font-weight:bold;border-bottom:1px solid #eee;">Phone</td><td style="border-bottom:1px solid #eee;">${esc(buyerPhone)}</td></tr>
    <tr><td style="font-weight:bold;border-bottom:1px solid #eee;">Ship to</td><td style="border-bottom:1px solid #eee;">${esc(addrStr || "—")}</td></tr>
    <tr><td style="font-weight:bold;border-bottom:1px solid #eee;">Items</td><td style="border-bottom:1px solid #eee;">${itemList}</td></tr>
    <tr><td style="font-weight:bold;border-bottom:2px solid #000;">TOTAL</td><td style="font-weight:bold;font-size:16px;border-bottom:2px solid #000;">${esc(total)}</td></tr>
    <tr><td style="font-weight:bold;color:#888;padding-top:10px;">Order ID</td><td style="color:#888;font-size:11px;padding-top:10px;font-family:monospace;">${esc(orderId)}</td></tr>
  </table>

  <div style="margin-top:20px;padding:12px 16px;background:#fffbea;border-radius:4px;font-size:13px;color:#555;line-height:1.8;">
    ✅ Payment collected via Stripe — nothing to charge<br>
    📦 Ship within 7–10 business days<br>
    📬 Buyer confirmation email sent automatically
  </div>

  <p style="margin-top:16px;font-size:12px;color:#aaa;">
    Stripe session: <a href="https://dashboard.stripe.com/payments/${esc(session.payment_intent || orderId)}" style="color:#aaa;">${esc(orderId)}</a>
  </p>
</div>
</body></html>`;
}

function buyerConfirmationEmailBlackWallStreet(session, lineItems) {
  const name    = esc(session.customer_details?.name || session.custom_fields?.find(f=>f.key==="business_name")?.text?.value || "Wholesale Partner");
  const total   = formatCents(session.amount_total || 0);
  const itemRows = (lineItems || []).map(item => `
    <tr>
      <td style="font-family:Arial,sans-serif;font-size:13px;color:#333;padding:8px 10px;border-top:1px solid #eee;">${esc(item.description || "Wholesale Case Pack")}</td>
      <td style="font-family:Arial,sans-serif;font-size:13px;color:#333;padding:8px 10px;text-align:center;border-top:1px solid #eee;">${item.quantity || 1}</td>
      <td style="font-family:Arial,sans-serif;font-size:13px;font-weight:bold;color:#333;padding:8px 10px;text-align:right;border-top:1px solid #eee;">${formatCents(item.amount_total || session.amount_total || 0)}</td>
    </tr>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Order Confirmed</title></head>
<body style="margin:0;padding:0;background:#f8f8f8;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f8f8;padding:20px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;max-width:600px;">
  <tr><td style="background:#000;padding:24px 32px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td><div style="font-family:Arial,sans-serif;font-size:24px;color:#fff;font-weight:bold;">Black Wall Street Monopoly</div>
          <div style="font-family:Arial,sans-serif;font-size:11px;color:#ccc;margin-top:3px;">Educational Board Game</div></td>
      <td align="right" style="font-family:Arial,sans-serif;font-size:12px;color:#ccc;line-height:1.7;">
        <a href="https://www.etsy.com/shop/BlackWallStreetopoly" style="color:#ccc;">etsy.com/shop/BlackWallStreetopoly</a></td>
    </tr></table>
  </td></tr>
  <tr><td style="background:#f0c040;padding:12px 32px;text-align:center;">
    <div style="font-family:Arial,sans-serif;font-size:15px;font-weight:bold;color:#000;">✓ Order Confirmed — Thank You!</div>
  </td></tr>
  <tr><td style="padding:28px 32px 16px;">
    <p style="margin:0 0 10px;font-family:Arial,sans-serif;font-size:14px;color:#333;">Hi ${name},</p>
    <p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6;">
      Thank you for your wholesale order! We've received your payment and your order is being prepared.
      You can expect delivery within <strong>7–10 business days</strong>.
    </p>
  </td></tr>
  <tr><td style="padding:0 32px 20px;">
    <div style="font-family:Arial,sans-serif;font-size:12px;font-weight:bold;color:#000;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Order Summary</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #ddd;border-radius:4px;overflow:hidden;">
      <tr style="background:#333;">
        <td style="font-family:Arial,sans-serif;font-size:11px;font-weight:bold;color:#fff;padding:8px 10px;">Item</td>
        <td style="font-family:Arial,sans-serif;font-size:11px;font-weight:bold;color:#fff;padding:8px 10px;text-align:center;">Qty</td>
        <td style="font-family:Arial,sans-serif;font-size:11px;font-weight:bold;color:#fff;padding:8px 10px;text-align:right;">Total</td>
      </tr>
      ${itemRows || `<tr><td colspan="3" style="font-family:Arial,sans-serif;font-size:13px;color:#333;padding:8px 10px;">Wholesale Case Pack</td></tr>`}
      <tr style="background:#f9f9f9;">
        <td colspan="2" style="font-family:Arial,sans-serif;font-size:13px;font-weight:bold;color:#000;padding:8px 10px;">TOTAL</td>
        <td style="font-family:Arial,sans-serif;font-size:13px;font-weight:bold;color:#000;padding:8px 10px;text-align:right;">${esc(total)}</td>
      </tr>
    </table>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

function adminAlertEmailBlackWallStreet(session, lineItems) {
  const buyerName  = session.customer_details?.name || session.custom_fields?.find(f=>f.key==="business_name")?.text?.value || "(unknown)";
  const buyerEmail = session.customer_details?.email || "(no email)";
  const buyerPhone = session.customer_details?.phone || "(no phone)";
  const address    = session.shipping_details?.address || session.customer_details?.address || {};
  const addrStr    = [address.line1, address.city, address.state, address.postal_code].filter(Boolean).join(", ");
  const total      = formatCents(session.amount_total || 0);
  const orderId    = session.id;
  const itemList = (lineItems || []).map(item =>
    `• ${item.description || "Item"} × ${item.quantity || 1} = ${formatCents(item.amount_total || 0)}`
  ).join("<br>") || "• Wholesale Case Pack";

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>New Wholesale Order</title></head>
<body style="margin:0;padding:20px;font-family:Arial,sans-serif;background:#f8f8f8;">
<div style="max-width:560px;background:#fff;padding:28px;border-radius:8px;border-left:6px solid #f0c040;">
  <h2 style="margin:0 0 4px;font-size:20px;color:#000;">🛒 New Black Wall Street Monopoly Order — ${esc(total)}</h2>
  <p style="margin:0 0 20px;font-size:13px;color:#888;">Black Wall Street Monopoly · ${new Date().toLocaleString()}</p>
  <table width="100%" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px;color:#333;">
    <tr><td style="font-weight:bold;width:130px;border-bottom:1px solid #eee;">Buyer</td><td style="border-bottom:1px solid #eee;">${esc(buyerName)}</td></tr>
    <tr><td style="font-weight:bold;border-bottom:1px solid #eee;">Email</td><td style="border-bottom:1px solid #eee;"><a href="mailto:${esc(buyerEmail)}" style="color:#000;">${esc(buyerEmail)}</a></td></tr>
    <tr><td style="font-weight:bold;border-bottom:1px solid #eee;">Phone</td><td style="border-bottom:1px solid #eee;">${esc(buyerPhone)}</td></tr>
    <tr><td style="font-weight:bold;border-bottom:1px solid #eee;">Ship to</td><td style="border-bottom:1px solid #eee;">${esc(addrStr || "—")}</td></tr>
    <tr><td style="font-weight:bold;border-bottom:1px solid #eee;">Items</td><td style="border-bottom:1px solid #eee;">${itemList}</td></tr>
    <tr><td style="font-weight:bold;border-bottom:2px solid #000;">TOTAL</td><td style="font-weight:bold;font-size:16px;border-bottom:2px solid #000;">${esc(total)}</td></tr>
    <tr><td style="font-weight:bold;color:#888;padding-top:10px;">Order ID</td><td style="color:#888;font-size:11px;padding-top:10px;font-family:monospace;">${esc(orderId)}</td></tr>
  </table>
  <div style="margin-top:20px;padding:12px 16px;background:#fffbea;border-radius:4px;font-size:13px;color:#555;line-height:1.8;">
    ✅ Payment collected via Stripe — nothing to charge<br>
    📦 Ship within 7–10 business days<br>
    📬 Buyer confirmation email sent automatically
  </div>
  <p style="margin-top:16px;font-size:12px;color:#aaa;">
    Stripe session: <a href="https://dashboard.stripe.com/payments/${esc(session.payment_intent || orderId)}" style="color:#aaa;">${esc(orderId)}</a>
  </p>
</div>
</body></html>`;
}

// ── Database: store order ──────────────────────────────────────────────────

async function storeOrder(session, lineItems) {
  // Ensure orders table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id             SERIAL PRIMARY KEY,
      stripe_session_id TEXT UNIQUE NOT NULL,
      stripe_payment_intent TEXT,
      buyer_name     TEXT,
      buyer_email    TEXT,
      buyer_phone    TEXT,
      shipping_address TEXT,
      amount_total   INTEGER,
      currency       TEXT DEFAULT 'usd',
      items_json     JSONB,
      status         TEXT DEFAULT 'confirmed',
      buyer_emailed  BOOLEAN DEFAULT FALSE,
      admin_emailed  BOOLEAN DEFAULT FALSE,
      created_at     TIMESTAMP DEFAULT NOW()
    )
  `);

  const address = session.shipping_details?.address || session.customer_details?.address || {};
  const addrStr = [address.line1, address.line2, address.city, address.state, address.postal_code, address.country].filter(Boolean).join(", ");

  const buyerName  = session.customer_details?.name
    || session.custom_fields?.find(f => f.key === "business_name")?.text?.value
    || null;

  await pool.query(
    `INSERT INTO orders
       (stripe_session_id, stripe_payment_intent, buyer_name, buyer_email, buyer_phone,
        shipping_address, amount_total, currency, items_json, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'confirmed')
     ON CONFLICT (stripe_session_id) DO UPDATE
       SET status='confirmed', buyer_name=EXCLUDED.buyer_name`,
    [
      session.id,
      session.payment_intent || null,
      buyerName,
      session.customer_details?.email || null,
      session.customer_details?.phone || null,
      addrStr || null,
      session.amount_total || 0,
      session.currency || "usd",
      JSON.stringify(lineItems || []),
    ]
  );
}

async function findLeadForAttribution({ metadataLeadId, buyerEmail, brandSlug = "skynpatch" }) {
  if (metadataLeadId) return metadataLeadId;
  if (!buyerEmail) return null;

  // Prefer lead linked to the latest outbound send to this email (brand-specific).
  const bySends = await pool.query(
    `SELECT es.lead_id
       FROM email_sends es
       JOIN leads l ON l.id = es.lead_id
      WHERE lower(es.to_email) = lower($1)
        AND l.brand_slug = $2
      ORDER BY es.sent_at DESC
      LIMIT 1`,
    [buyerEmail, brandSlug]
  );
  if (bySends.rows[0]?.lead_id) return bySends.rows[0].lead_id;

  // Fallback: direct lead match (brand-specific).
  const byLead = await pool.query(
    `SELECT id
       FROM leads
      WHERE lower(email) = lower($1)
        AND brand_slug = $2
      ORDER BY fetched_at DESC
      LIMIT 1`,
    [buyerEmail, brandSlug]
  );
  return byLead.rows[0]?.id || null;
}

async function attributeOrderRevenue({ leadId, orderId, valueCents }) {
  if (!experiment || typeof experiment.attributeRevenue !== "function") return;
  if (!leadId || !orderId || !valueCents) return;
  try {
    await experiment.attributeRevenue(leadId, orderId, valueCents);
  } catch (e) {
    console.error(`[stripe-wh] experiment attribution failed: ${e.message}`);
  }
}

// ── Webhook event handlers ─────────────────────────────────────────────────

async function handleCheckoutCompleted(event) {
  const session = event.data.object;
  const brand = session.metadata?.brand || "skynpatch"; // Default to skynpatch for backward compatibility
  console.log(`[stripe-wh] checkout.session.completed [${brand}] → ${session.id} $${(session.amount_total/100).toFixed(2)}`);

  // We need line items — Stripe doesn't include them in the event; fetch separately
  const lineItems = []; // Will be enriched if Stripe returns them
  // Note: to get full line items you'd call GET /v1/checkout/sessions/{id}/line_items
  // We include the metadata SKU from the session itself for now
  const metaItems = session.metadata?.sku
    ? [{ description: session.metadata.sku, quantity: 1, amount_total: session.amount_total }]
    : lineItems;

  await storeOrder(session, metaItems);

  const buyerEmail = session.customer_details?.email || null;
  const leadId = await findLeadForAttribution({
    metadataLeadId: session.metadata?.lead_id || null,
    buyerEmail,
    brandSlug: brand === "blackwallstreetopoly" ? "blackwallstreetopoly" : "skynpatch",
  });
  await attributeOrderRevenue({
    leadId,
    orderId: session.payment_intent || session.id,
    valueCents: session.amount_total || 0,
  });
  const buyerName  = session.customer_details?.name
    || session.custom_fields?.find(f => f.key === "business_name")?.text?.value
    || "Wholesale Partner";

  // Send buyer confirmation (brand-specific)
  if (buyerEmail) {
    let html, subject;
    if (brand === "blackwallstreetopoly") {
      html = buyerConfirmationEmailBlackWallStreet(session, metaItems);
      subject = `Your Black Wall Street Monopoly Order is Confirmed — ${formatCents(session.amount_total)}`;
    } else {
      html = buyerConfirmationEmail(session, metaItems);
      subject = `Your Skyn Patch Order is Confirmed — ${formatCents(session.amount_total)}`;
    }
    await sendEmail(buyerEmail, subject, html);
    await pool.query("UPDATE orders SET buyer_emailed=TRUE WHERE stripe_session_id=$1", [session.id]);
    console.log(`[stripe-wh] buyer confirmation [${brand}] → ${buyerEmail}`);
  }

  // Send admin alert (brand-specific)
  const adminHtml = brand === "blackwallstreetopoly" 
    ? adminAlertEmailBlackWallStreet(session, metaItems)
    : adminAlertEmail(session, metaItems);
  const adminSubject = brand === "blackwallstreetopoly"
    ? `🛒 New Black Wall Street Monopoly Order ${formatCents(session.amount_total)} — ${buyerName}`
    : `🛒 New Wholesale Order ${formatCents(session.amount_total)} — ${buyerName}`;
  await sendEmail(ADMIN_EMAIL, adminSubject, adminHtml);
  await pool.query("UPDATE orders SET admin_emailed=TRUE WHERE stripe_session_id=$1", [session.id]);
  console.log(`[stripe-wh] admin alert [${brand}] → ${ADMIN_EMAIL}`);
}

async function handlePaymentIntentSucceeded(event) {
  const pi = event.data.object;
  console.log(`[stripe-wh] payment_intent.succeeded → ${pi.id}`);
  await pool.query(
    `UPDATE orders SET status='confirmed' WHERE stripe_payment_intent=$1`,
    [pi.id]
  ).catch(() => {});

  const orderRow = await pool.query(
    `SELECT buyer_email, amount_total FROM orders WHERE stripe_payment_intent=$1 ORDER BY created_at DESC LIMIT 1`,
    [pi.id]
  ).catch(() => ({ rows: [] }));

  const leadId = await findLeadForAttribution({
    metadataLeadId: pi.metadata?.lead_id || null,
    buyerEmail: orderRow.rows[0]?.buyer_email || pi.receipt_email || null,
  });
  await attributeOrderRevenue({
    leadId,
    orderId: pi.id,
    valueCents: orderRow.rows[0]?.amount_total || pi.amount_received || pi.amount || 0,
  });
}

async function handlePaymentFailed(event) {
  const pi = event.data.object;
  console.log(`[stripe-wh] payment_intent.payment_failed → ${pi.id}`);
  await pool.query(
    `UPDATE orders SET status='payment_failed' WHERE stripe_payment_intent=$1`,
    [pi.id]
  ).catch(() => {}); // Table may not exist yet
}

async function handleRefund(event) {
  const charge = event.data.object;
  console.log(`[stripe-wh] charge.refunded → ${charge.id}`);
  await pool.query(
    `UPDATE orders SET status='refunded' WHERE stripe_payment_intent=$1`,
    [charge.payment_intent]
  ).catch(() => {});
}

// ── Main exported handler (called from webhook-server.js) ─────────────────

module.exports = {
  verifyStripeSignature,
  async handleStripeWebhook(rawBody, sigHeader) {
    if (!verifyStripeSignature(rawBody, sigHeader)) {
      return { ok: false, code: 401, message: "invalid stripe signature" };
    }
    let event;
    try { event = JSON.parse(rawBody); }
    catch { return { ok: false, code: 400, message: "bad json" }; }

    const type = event.type;
    console.log(`[stripe-wh] event: ${type}`);

    try {
      switch (type) {
        case "checkout.session.completed":   await handleCheckoutCompleted(event); break;
        case "payment_intent.succeeded":     await handlePaymentIntentSucceeded(event); break;
        case "payment_intent.payment_failed": await handlePaymentFailed(event);   break;
        case "charge.refunded":              await handleRefund(event);            break;
        default:
          console.log(`[stripe-wh] unhandled event: ${type}`);
      }
      return { ok: true, code: 200 };
    } catch (e) {
      console.error(`[stripe-wh] handler error ${type}: ${e.message}`);
      return { ok: false, code: 500, message: e.message };
    }
  },
};
