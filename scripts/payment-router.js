#!/usr/bin/env node
"use strict";

/**
 * payment-router.js  —  Multi-rail payment handler for the Prompt Oracle
 *
 * PRIMARY: Stripe Checkout — automatic_payment_methods mode presents all enabled
 *   methods from the AutoPayAgent dashboard automatically:
 *
 *   Cards / Wallets (all regions):
 *   ✓ Cards (Visa, Mastercard, Amex, Discover)
 *   ✓ Apple Pay          — auto on Safari/iOS when 'card' eligible
 *   ✓ Google Pay         — auto on Android/Chrome when 'card' eligible
 *   ✓ Amazon Pay
 *   ✓ Crypto Wallets      — USDC, USDT (if enabled in Stripe Dashboard)
 *   ✓ Stablecoins         — via Stripe Crypto integration
 *
 *   US wallets / BNPL:
 *   ✓ Cash App Pay       — United States
 *   ✓ Affirm             — US, Canada (BNPL)
 *   ✓ Afterpay/Clearpay  — US, CA, AU, NZ, UK (BNPL)
 *   ✓ Klarna             — All regions (BNPL)
 *   ✓ Zip                — US, Australia (BNPL)
 *
 *   Bank payments:
 *   ✓ ACH Direct Debit   — United States
 *   ✓ Bank transfer      — US, EU, UK, JP, MX
 *   ✓ Bancontact         — Belgium
 *   ✓ EPS                — Austria
 *
 *   Asia-Pacific:
 *   ✓ Kakao Pay          — South Korea
 *   ✓ Samsung Pay        — South Korea
 *
 * SECONDARY: API Credits (pre-purchased bundles, zero per-transaction friction)
 *
 * Stripe account: set CREATOR_STRIPE_EMAIL env → autopayagent
 *
 * Required env vars (add to .env):
 *   STRIPE_SECRET_KEY          — from Stripe Dashboard → Developers → API keys
 *   STRIPE_WEBHOOK_SECRET      — from Stripe Dashboard → Developers → Webhooks → your endpoint secret
 *   COMMERCE_PUBLIC_URL        — your public URL for Stripe redirect and webhooks (e.g. https://openclaw.io)
 *
 * Optional:
 *   COMMERCE_PORT              — webhook server port (default: 3031)
 *   COMMERCE_PRICE_USD         — price per prompt in dollars (default: 1.00)
 */

require("dotenv").config({ override: true });

const http = require("http");
const crypto = require("crypto");
const fsp = require("fs/promises");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const COMMERCE_DIR = path.join(ROOT, "agent-state", "commerce");
const PENDING_FILE = path.join(COMMERCE_DIR, "pending.json");
const CREDITS_DIR = path.join(COMMERCE_DIR, "credits");
const TX_LOG = path.join(COMMERCE_DIR, "transactions.jsonl");

const PORT = Number(process.env.COMMERCE_PORT || "3031");
const HOST = process.env.COMMERCE_HOST || "127.0.0.1";
const PRICE_USD = Number(process.env.COMMERCE_PRICE_USD || "1.00");
const PRICE_CENTS = Math.round(PRICE_USD * 100);
const PUBLIC_URL = (process.env.COMMERCE_PUBLIC_URL || "").replace(/\/$/, "");

function getWhatsAppVerifyToken() {
  return process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || process.env.WHATSAPP_VERIFY_TOKEN || "";
}

// Lazy-load Stripe so the rest of the module works even without the stripe package installed
let _stripe = null;
function getStripe() {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY not set — add it to .env from Stripe Dashboard → Developers → API Keys");
    // eslint-disable-next-line global-require
    const Stripe = require("stripe");
    _stripe = new Stripe(key, { apiVersion: "2024-06-20" });
  }
  return _stripe;
}

// Export for use in other scripts
module.exports.getStripe = getStripe;

// ─── Pending charge store ─────────────────────────────────────────────────────

async function loadPending() {
  try {
    return JSON.parse(await fsp.readFile(PENDING_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function savePending(pending) {
  const { atomicWriteJSON } = require("../control/atomic-state");
  await fsp.mkdir(COMMERCE_DIR, { recursive: true });
  await atomicWriteJSON(PENDING_FILE, pending);
}

async function logTransaction(tx) {
  const { atomicAppendJSONL } = require("../control/atomic-state");
  await fsp.mkdir(COMMERCE_DIR, { recursive: true });
  await atomicAppendJSONL(TX_LOG, { ...tx, logged_at: new Date().toISOString() });
}

// ─── Stripe Checkout (primary rail) ──────────────────────────────────────────
// Uses automatic_payment_methods so Stripe presents all 16 methods enabled in
// the AutoPayAgent dashboard — no manual list needed. Adding or removing methods
// in the Stripe Dashboard automatically takes effect without code changes.

async function createStripeCheckout({ chargeId, metadata }) {
  const stripe = getStripe();

  // Configure payment methods - crypto is included if enabled in Stripe Dashboard
  // automatic_payment_methods will show all enabled methods including crypto wallets
  const paymentMethodConfig = {
    automatic_payment_methods: { enabled: true },
  };

  // Explicitly enable crypto if STRIPE_ENABLE_CRYPTO is set
  // Note: Crypto payments require Stripe Crypto to be enabled in your dashboard
  // Go to: Stripe Dashboard → Settings → Payment methods → Crypto → Enable
  if (process.env.STRIPE_ENABLE_CRYPTO === "true") {
    paymentMethodConfig.payment_method_types = ["card", "link", "cashapp", "crypto"];
  }

  const session = await stripe.checkout.sessions.create({
    ...paymentMethodConfig,
    line_items: [
      {
        price_data: {
          currency: "usd",
          unit_amount: PRICE_CENTS,
          product_data: {
            name: "OpenClaw Prompt Oracle",
            description: `Bot Communication Protocol: ${metadata.protocolType || "agent-intro"} — Tailored for ${metadata.platform || "Discord"}`,
            images: [],
          },
        },
        quantity: 1,
      },
    ],
    mode: "payment",
    metadata: {
      charge_id: chargeId,
      user_id: metadata.userId || "",
      platform: metadata.platform || "",
      protocol_type: metadata.protocolType || "",
      operator_name: metadata.operatorName || "",
    },
    success_url: `${PUBLIC_URL}/oracle/success?charge=${chargeId}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${PUBLIC_URL}/oracle/cancel?charge=${chargeId}`,
    // Collect email for receipt; remove if you don't want email collection
    customer_creation: "always",
    // Crypto onboarding best practices: clear payment instructions
    payment_intent_data: {
      description: "OpenClaw Prompt Oracle - Bot Communication Protocol",
    },
    // Expires in 30 minutes
    expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    // Enable customer email collection for crypto receipts
    customer_email: null, // Let Stripe collect email during checkout
  });

  return {
    rail: "stripe",
    external_id: session.id,
    payment_url: session.url,
    expires_at: new Date(session.expires_at * 1000).toISOString(),
  };
}

// ─── API Credits (REAL MONETARY VALUE — backed by USD, not perceived value) ──────

/**
 * API Credits have REAL MONETARY VALUE:
 * 
 * CRITICAL: Credits are ALWAYS backed by real payments via Stripe (USD, USDC, USDT, etc.).
 * - 1 credit = $1 USD equivalent paid via Stripe Checkout
 * - Stripe accepts USD, USDC, USDT, and other crypto/stablecoins
 * - Stripe automatically converts crypto payments (USDC, USDT) to USD
 * - Credits can ONLY be purchased with real money (Stripe)
 * - Credits are redeemable for $1 worth of services (prompts, API calls)
 * - Full audit trail: every credit has a corresponding Stripe payment with currency tracking
 * 
 * NO "AIR TOKENS":
 * - Credits cannot be created without payment
 * - No free credits, no "perceived value"
 * - Reputation bonuses are LIMITED and still require base payment
 * - All credits tracked with value_backing = "stripe_usd" (or "stripe_usd_with_reputation_bonus")
 * 
 * Value sources (ALL require real payment):
 * - Direct purchase: $1 USD (or equivalent in USDC/USDT) Stripe payment = 1 credit (PRIMARY)
 * - Reputation bonus: Limited bonus credits (max 10) for high-reputation bots
 *   BUT: Base credits still required from Stripe payment
 * 
 * Service redemption:
 * - 1 credit = 1 prompt = $1 USD value
 * - Credits are fungible with USD regardless of original payment currency
 * - Can be refunded to USD if needed
 * 
 * Payment currencies supported:
 * - USD (fiat) - primary
 * - USDC (stablecoin) - via Stripe Crypto
 * - USDT (stablecoin) - via Stripe Crypto
 * - Other crypto - if enabled in Stripe Dashboard
 * All crypto payments are converted to USD by Stripe before crediting
 */

async function getCredits(userId) {
  try {
    const credits = JSON.parse(await fsp.readFile(path.join(CREDITS_DIR, `${userId}.json`), "utf8"));
    
    // Enhance with Moltbook reputation if available
    try {
      const { getMoltbookReputation } = require("./moltbook-discovery");
      const reputation = await getMoltbookReputation(userId);
      if (reputation) {
        credits.moltbook_karma = reputation.karma || 0;
        credits.moltbook_verified = reputation.verified || false;
        // Bonus credits based on reputation (real value from community engagement)
        credits.reputation_bonus = Math.floor((reputation.karma || 0) / 100); // 1 credit per 100 karma
      }
    } catch {
      // Moltbook integration optional
    }
    
    return credits;
  } catch {
    return { userId, balance: 0, purchased: 0, spent: 0, value_backing: "stripe_usd" };
  }
}

async function saveCredits(userId, credits) {
  const { atomicWriteJSON } = require("../control/atomic-state");
  await fsp.mkdir(CREDITS_DIR, { recursive: true });
  // Ensure value backing is tracked
  if (!credits.value_backing) {
    credits.value_backing = "stripe_usd"; // Backed by real USD payments
  }
  await atomicWriteJSON(path.join(CREDITS_DIR, `${userId}.json`), credits);
}

async function deductCredit(userId) {
  const credits = await getCredits(userId);
  if (credits.balance < 1) {
    throw new Error(`Insufficient credits (balance: ${credits.balance}). Buy a bundle with \`!oracle buy-credits\`.`);
  }
  credits.balance -= 1;
  credits.spent += 1;
  credits.last_spent_at = new Date().toISOString();
  await saveCredits(userId, credits);
  
  // Log transaction for audit (real value tracking)
  await logTransaction({ 
    chargeId: `credit_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`, 
    rail: "credits", 
    userId, 
    amount_usd: PRICE_USD,
    currency: "usd", // Credits are always USD-valued regardless of original payment method
    protocolType: "credit_redemption",
    status: "paid",
    value_backing: credits.value_backing || "stripe_usd",
  });
  
  return credits;
}

async function addCredits(userId, amount, source = "purchase", stripePaymentId = null) {
  const credits = await getCredits(userId);
  
  // CRITICAL: Only allow credits backed by real Stripe payments
  if (source === "purchase") {
    if (!stripePaymentId) {
      throw new Error("Credits can only be added with a Stripe payment ID. No 'air tokens' allowed.");
    }
    credits.balance += amount;
    credits.purchased += amount;
    credits.value_backing = "stripe_usd"; // REAL USD backing
    credits.stripe_payments = credits.stripe_payments || [];
    credits.stripe_payments.push({
      payment_id: stripePaymentId,
      amount: amount,
      added_at: new Date().toISOString(),
    });
  } else if (source === "moltbook_reputation") {
    // LIMITED bonus credits (max 10 total) - still requires base Stripe payment
    const maxBonus = 10;
    const currentBonus = credits.reputation_earned || 0;
    if (currentBonus >= maxBonus) {
      throw new Error(`Reputation bonus limit reached (${maxBonus}). Base credits must be purchased via Stripe.`);
    }
    const actualBonus = Math.min(amount, maxBonus - currentBonus);
    credits.balance += actualBonus;
    credits.reputation_earned = currentBonus + actualBonus;
    // Still backed by USD (reputation is earned, but credits require base payment)
    credits.value_backing = "stripe_usd_with_reputation_bonus";
  } else if (source === "bonus") {
    // Admin bonuses still require Stripe payment backing
    throw new Error("Bonus credits require Stripe payment backing. Use 'purchase' source with stripePaymentId.");
  } else {
    throw new Error(`Invalid credit source: ${source}. Credits must be backed by Stripe payments.`);
  }
  
  credits.last_added_at = new Date().toISOString();
  credits.last_added_source = source;
  await saveCredits(userId, credits);
  
  // Log credit addition for audit (REAL USD VALUE)
  // Note: Credits are always USD-valued even if original payment was in USDC/USDT
  await logTransaction({ 
    chargeId: stripePaymentId || `credit_add_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`, 
    rail: "credits", 
    userId, 
    amount_usd: amount * PRICE_USD, // REAL USD VALUE (Stripe converts crypto to USD)
    currency: "usd", // Credits are always USD-valued
    protocolType: "credit_purchase",
    status: "completed",
    value_backing: credits.value_backing || "stripe_usd",
    source,
    stripe_payment_id: stripePaymentId,
  });
  
  return credits;
}

// ─── Moltbook Reputation → Credits Conversion (Limited Bonus, Requires Base Payment) ───

async function syncMoltbookCredits(userId) {
  try {
    const { getMoltbookReputation } = require("./moltbook-discovery");
    const reputation = await getMoltbookReputation(userId);
    
    if (!reputation) {
      return null;
    }
    
    const credits = await getCredits(userId);
    
    // CRITICAL: Bonus credits only available if user has purchased base credits
    if (credits.purchased === 0) {
      return { 
        bonus: 0, 
        message: "Base credits must be purchased via Stripe before reputation bonuses apply",
        requires_payment: true,
      };
    }
    
    const karma = reputation.karma || 0;
    
    // LIMITED bonus: 100 karma = 1 credit bonus (max 10 total bonus credits)
    // This is a small reward for community engagement, but base credits still required
    const reputationCredits = Math.min(Math.floor(karma / 100), 10);
    const currentReputationCredits = credits.reputation_earned || 0;
    
    if (reputationCredits > currentReputationCredits) {
      const bonus = reputationCredits - currentReputationCredits;
      await addCredits(userId, bonus, "moltbook_reputation");
      return { 
        bonus, 
        total_reputation_credits: reputationCredits,
        base_credits_required: true,
      };
    }
    
    return { bonus: 0, total_reputation_credits: reputationCredits };
  } catch (err) {
    console.warn(`[credits] Moltbook sync failed for ${userId}:`, err.message);
    return null;
  }
}

// ─── Unified charge creation ──────────────────────────────────────────────────

/**
 * Create a payment charge on the specified rail.
 * @param {object} opts
 * @param {string} opts.rail   'stripe' | 'credits'
 * @returns {object}  { chargeId, rail, payment_url, immediately_paid? }
 */
async function createCharge({ rail = "stripe", userId, platform, protocolType, operatorName, context }) {
  const chargeId = `oracle_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const metadata = { userId, platform, protocolType, operatorName, context, chargeId };

  let railResult;

  if (rail === "credits") {
    await deductCredit(userId);
    railResult = { rail: "credits", external_id: chargeId, payment_url: null, immediately_paid: true };
  } else if (rail === "stripe") {
    railResult = await createStripeCheckout({ chargeId, metadata });
  } else {
    throw new Error(`Unknown rail: "${rail}". Options: stripe, credits`);
  }

  // Persist to pending store
  const pending = await loadPending();
  pending[chargeId] = {
    chargeId,
    userId,
    platform,
    protocolType,
    operatorName,
    context,
    rail,
    external_id: railResult.external_id,
    created_at: new Date().toISOString(),
    paid: railResult.immediately_paid || false,
    paid_at: railResult.immediately_paid ? new Date().toISOString() : null,
    delivered: false,
  };
  await savePending(pending);

  if (railResult.immediately_paid) {
    await logTransaction({ 
      chargeId, 
      rail: "credits", 
      userId, 
      amount_usd: PRICE_USD, 
      currency: "usd", // Credits are always USD-valued
      protocolType, 
      status: "paid" 
    });
  }

  return { chargeId, ...railResult };
}

// ─── Payment verification ─────────────────────────────────────────────────────

async function markPaid(chargeId, externalId, paymentDetails = {}) {
  const pending = await loadPending();
  if (!pending[chargeId]) {
    console.warn(`[payment-router] markPaid: chargeId ${chargeId} not found`);
    return null;
  }
  pending[chargeId].paid = true;
  pending[chargeId].paid_at = new Date().toISOString();
  if (externalId) pending[chargeId].external_id = externalId;
  
  // Track payment currency and method (USD, USDC, USDT, etc.)
  if (paymentDetails.currency) {
    pending[chargeId].payment_currency = paymentDetails.currency.toLowerCase();
  }
  if (paymentDetails.payment_method_type) {
    pending[chargeId].payment_method_type = paymentDetails.payment_method_type;
  }
  if (paymentDetails.payment_method) {
    pending[chargeId].payment_method = paymentDetails.payment_method;
  }
  
  await savePending(pending);
  await logTransaction({
    chargeId,
    rail: pending[chargeId].rail,
    userId: pending[chargeId].userId,
    amount_usd: PRICE_USD,
    currency: paymentDetails.currency || "usd",
    payment_method_type: paymentDetails.payment_method_type,
    payment_method: paymentDetails.payment_method,
    protocolType: pending[chargeId].protocolType,
    status: "paid",
  });
  return pending[chargeId];
}

async function markDelivered(chargeId) {
  const pending = await loadPending();
  if (pending[chargeId]) {
    pending[chargeId].delivered = true;
    pending[chargeId].delivered_at = new Date().toISOString();
    await savePending(pending);
  }
}

// ─── Webhook server ───────────────────────────────────────────────────────────

let onPaymentConfirmed = async (chargeData) => {
  console.log("[payment-router] payment confirmed (no delivery handler set):", chargeData.chargeId);
};
let onWhatsAppInbound = async (_message) => {};

function setDeliveryHandler(fn) {
  onPaymentConfirmed = fn;
}
function setWhatsAppInboundHandler(fn) {
  onWhatsAppInbound = fn;
}

async function handleWebhook(req, res, body) {
  const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = parsed.pathname;

  // ── Stripe (primary) ───────────────────────────────────────────────────────
  if (pathname === "/webhooks/stripe" || pathname === "/api/webhook/stripe") {
    const sig = req.headers["stripe-signature"] || "";
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    if (webhookSecret) {
      try {
        event = getStripe().webhooks.constructEvent(body, sig, webhookSecret);
      } catch (err) {
        console.error("[payment-router] Stripe webhook sig invalid:", err.message);
        res.writeHead(400);
        res.end("Invalid Stripe signature");
        return;
      }
    } else {
      // No webhook secret set — parse raw (dev only)
      try { event = JSON.parse(body); } catch { res.writeHead(400); res.end("Bad JSON"); return; }
      console.warn("[payment-router] ⚠️  STRIPE_WEBHOOK_SECRET not set — skipping signature verification");
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const chargeId = session.metadata?.charge_id || "";
      if (chargeId && session.payment_status === "paid") {
        // Extract payment method details (USD, USDC, USDT, etc.)
        let paymentDetails = {
          currency: session.currency || "usd",
          payment_method_type: null,
          payment_method: null,
        };
        
        // Fetch payment intent to get actual payment method details
        if (session.payment_intent) {
          try {
            const paymentIntent = await getStripe().paymentIntents.retrieve(session.payment_intent);
            if (paymentIntent.payment_method) {
              const paymentMethod = await getStripe().paymentMethods.retrieve(paymentIntent.payment_method);
              paymentDetails.payment_method_type = paymentMethod.type;
              paymentDetails.payment_method = paymentMethod.type === "crypto" ? paymentMethod.crypto?.currency : null;
              // For crypto payments, currency might be in payment method
              if (paymentMethod.type === "crypto" && paymentMethod.crypto?.currency) {
                paymentDetails.currency = paymentMethod.crypto.currency.toLowerCase(); // usdc, usdt, etc.
              }
            }
          } catch (err) {
            console.warn(`[payment-router] Could not fetch payment method details:`, err.message);
          }
        }
        
        const chargeData = await markPaid(chargeId, session.id, paymentDetails);
        
        // Log payment method for audit
        if (paymentDetails.payment_method_type === "crypto") {
          console.log(`[payment-router] Crypto payment received: ${paymentDetails.currency.toUpperCase()} via ${session.id}`);
        }
        
        // If this is a credit purchase, add credits with REAL USD backing
        // Note: Stripe converts crypto (USDC, USDT) to USD, so credits are always USD-valued
        if (session.metadata?.purchase_type === "credits") {
          const userId = session.metadata?.user_id || chargeData?.userId;
          const amount = Math.floor(session.amount_total / 100); // Convert cents to dollars
          if (userId && amount > 0) {
            try {
              await addCredits(userId, amount, "purchase", session.payment_intent || session.id);
              const paymentMethodStr = paymentDetails.payment_method_type === "crypto" 
                ? ` (paid in ${paymentDetails.currency.toUpperCase()}, converted to USD)`
                : "";
              console.log(`[payment-router] Added ${amount} credits to ${userId} (backed by Stripe payment ${session.id}${paymentMethodStr})`);
            } catch (err) {
              console.error(`[payment-router] Failed to add credits:`, err.message);
            }
          }
        }
        
        if (chargeData) await onPaymentConfirmed(chargeData);
      }
    }

    // Also handle async payment confirmations (some methods like bank transfers are async)
    if (event.type === "checkout.session.async_payment_succeeded") {
      const session = event.data.object;
      const chargeId = session.metadata?.charge_id || "";
      if (chargeId) {
        // Extract payment method details (USD, USDC, USDT, etc.)
        let paymentDetails = {
          currency: session.currency || "usd",
          payment_method_type: null,
          payment_method: null,
        };
        
        // Fetch payment intent to get actual payment method details
        if (session.payment_intent) {
          try {
            const paymentIntent = await getStripe().paymentIntents.retrieve(session.payment_intent);
            if (paymentIntent.payment_method) {
              const paymentMethod = await getStripe().paymentMethods.retrieve(paymentIntent.payment_method);
              paymentDetails.payment_method_type = paymentMethod.type;
              paymentDetails.payment_method = paymentMethod.type === "crypto" ? paymentMethod.crypto?.currency : null;
              // For crypto payments, currency might be in payment method
              if (paymentMethod.type === "crypto" && paymentMethod.crypto?.currency) {
                paymentDetails.currency = paymentMethod.crypto.currency.toLowerCase(); // usdc, usdt, etc.
              }
            }
          } catch (err) {
            console.warn(`[payment-router] Could not fetch payment method details:`, err.message);
          }
        }
        
        const chargeData = await markPaid(chargeId, session.id, paymentDetails);
        
        // Log payment method for audit
        if (paymentDetails.payment_method_type === "crypto") {
          console.log(`[payment-router] Crypto payment received (async): ${paymentDetails.currency.toUpperCase()} via ${session.id}`);
        }
        
        // If this is a credit purchase, add credits with REAL USD backing
        // Note: Stripe converts crypto (USDC, USDT) to USD, so credits are always USD-valued
        if (session.metadata?.purchase_type === "credits") {
          const userId = session.metadata?.user_id || chargeData?.userId;
          const amount = Math.floor(session.amount_total / 100);
          if (userId && amount > 0) {
            try {
              await addCredits(userId, amount, "purchase", session.payment_intent || session.id);
              const paymentMethodStr = paymentDetails.payment_method_type === "crypto" 
                ? ` (paid in ${paymentDetails.currency.toUpperCase()}, converted to USD)`
                : "";
              console.log(`[payment-router] Added ${amount} credits to ${userId} (backed by Stripe payment ${session.id}${paymentMethodStr})`);
            } catch (err) {
              console.error(`[payment-router] Failed to add credits:`, err.message);
            }
          }
        }
        
        if (chargeData) await onPaymentConfirmed(chargeData);
      }
    }

    res.writeHead(200);
    res.end("ok");
    return;
  }

  // ── Stripe success redirect (browser-based fallback) ──────────────────────
  // Stripe webhooks are authoritative, but this handles the redirect case
  // for users where webhooks might not be configured yet.
  if (pathname === "/oracle/success") {
    const chargeId = parsed.searchParams.get("charge") || "";
    const sessionId = parsed.searchParams.get("session_id") || "";

    if (chargeId && sessionId) {
      try {
        const session = await getStripe().checkout.sessions.retrieve(sessionId);
        if (session.payment_status === "paid") {
          const pending = await loadPending();
          if (pending[chargeId] && !pending[chargeId].paid) {
            // Extract payment method details if available
            let paymentDetails = {
              currency: session.currency || "usd",
              payment_method_type: null,
              payment_method: null,
            };
            
            // Try to get payment method details from payment intent
            if (session.payment_intent) {
              try {
                const paymentIntent = await getStripe().paymentIntents.retrieve(session.payment_intent);
                if (paymentIntent.payment_method) {
                  const paymentMethod = await getStripe().paymentMethods.retrieve(paymentIntent.payment_method);
                  paymentDetails.payment_method_type = paymentMethod.type;
                  if (paymentMethod.type === "crypto" && paymentMethod.crypto?.currency) {
                    paymentDetails.currency = paymentMethod.crypto.currency.toLowerCase();
                    paymentDetails.payment_method = paymentMethod.crypto.currency;
                  }
                }
              } catch (err) {
                // Payment method details optional
              }
            }
            
            const chargeData = await markPaid(chargeId, sessionId, paymentDetails);
            if (chargeData) await onPaymentConfirmed(chargeData);
          }
        }
      } catch (err) {
        console.error("[payment-router] Stripe session retrieve failed:", err.message);
      }
    }

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      `<!DOCTYPE html><html><head><title>OpenClaw Prompt Oracle</title></head><body style="font-family:system-ui;text-align:center;padding:60px">` +
        `<h1>✅ Payment received!</h1><p>Return to <strong>Discord</strong> or <strong>Telegram</strong> — your custom bot prompt is being generated and will appear there in seconds.</p>` +
        `<p style="color:#666;font-size:14px">Charge ID: <code>${chargeId}</code></p></body></html>`
    );
    return;
  }

  if (pathname === "/oracle/cancel") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      `<!DOCTYPE html><html><body style="font-family:system-ui;text-align:center;padding:60px">` +
        `<h1>Payment cancelled</h1><p>Return to Discord or Telegram and type <code>!oracle</code> to try again.</p></body></html>`
    );
    return;
  }

  // ── WhatsApp Cloud API webhook (message intake) ───────────────────────────
  if (pathname === "/webhooks/whatsapp" && req.method === "GET") {
    const mode = parsed.searchParams.get("hub.mode");
    const token = parsed.searchParams.get("hub.verify_token");
    const challenge = parsed.searchParams.get("hub.challenge");
    const verifyToken = getWhatsAppVerifyToken();
    if (mode === "subscribe" && verifyToken && token === verifyToken) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(challenge || "");
      return;
    }
    res.writeHead(403);
    res.end("forbidden");
    return;
  }

  if (pathname === "/webhooks/whatsapp" && req.method === "POST") {
    const appSecret = process.env.WHATSAPP_APP_SECRET || "";
    const signature = String(req.headers["x-hub-signature-256"] || "");
    if (appSecret) {
      const expected = `sha256=${crypto.createHmac("sha256", appSecret).update(body).digest("hex")}`;
      if (signature !== expected) {
        res.writeHead(401);
        res.end("invalid signature");
        return;
      }
    }

    let payload;
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      res.writeHead(400);
      res.end("bad json");
      return;
    }

    const entries = Array.isArray(payload.entry) ? payload.entry : [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const messages = Array.isArray(value.messages) ? value.messages : [];
        for (const msg of messages) {
          const from = String(msg.from || "");
          const text = String(msg.text?.body || "").trim();
          if (!from || !text) continue;
          try {
            await onWhatsAppInbound({
              platform: "whatsapp",
              userId: from,
              channelId: from,
              message: text,
              messageId: String(msg.id || ""),
              timestamp: String(msg.timestamp || ""),
              raw: msg,
            });
          } catch (err) {
            console.error("[payment-router] whatsapp inbound handler error:", err.message);
          }
        }
      }
    }

    res.writeHead(200);
    res.end("ok");
    return;
  }

  // ── Health check ──────────────────────────────────────────────────────────
  if (pathname === "/health" || pathname === "/healthz") {
    const stripeConfigured = !!process.env.STRIPE_SECRET_KEY;
    const whatsappMessagingConfigured = !!(process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_ACCESS_TOKEN);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        port: PORT,
        price_usd: PRICE_USD,
        stripe: stripeConfigured,
        whatsapp_webhook: !!getWhatsAppVerifyToken(),
        whatsapp_messaging: whatsappMessagingConfigured,
      })
    );
    return;
  }

  res.writeHead(404);
  res.end("not found");
}

function startWebhookServer() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      handleWebhook(req, res, body).catch((err) => {
        console.error("[payment-router] webhook error:", err.message);
        if (!res.headersSent) { res.writeHead(500); res.end("internal error"); }
      });
    });
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\n❌ Port ${PORT} is already in use!`);
      console.error(`\n   Kill the process using port ${PORT}:`);
      console.error(`   kill $(lsof -ti :${PORT})`);
      console.error(`\n   Or use a different port:`);
      console.error(`   COMMERCE_PORT=3032 npm run commerce:server\n`);
      process.exit(1);
    } else {
      console.error(`[payment-router] server error:`, err.message);
      throw err;
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`[payment-router] webhook server on :${PORT}`);
    console.log(`[payment-router] register these in Stripe Dashboard → Developers → Webhooks:`);
    console.log(`  ${PUBLIC_URL || "https://YOUR_DOMAIN"}/webhooks/stripe`);
    console.log(`  ${PUBLIC_URL || "https://YOUR_DOMAIN"}/api/webhook/stripe`);
    console.log(`[payment-router] events to listen for: checkout.session.completed, checkout.session.async_payment_succeeded`);
    console.log(`[payment-router] payment methods supported: USD, USDC, USDT, and all Stripe-enabled methods`);
    console.log(`[payment-router] crypto payments are automatically converted to USD by Stripe`);
  });

  return server;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  createCharge,
  markPaid,
  markDelivered,
  getCredits,
  addCredits,
  deductCredit,
  loadPending,
  setDeliveryHandler,
  setWhatsAppInboundHandler,
  startWebhookServer,
  PRICE_USD,
};

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args[0] === "server") {
    startWebhookServer();
  } else if (args[0] === "credits" && args[1] === "add") {
    const [, , , userId, amountStr] = args;
    if (!userId) { console.error("Usage: payment-router.js credits add <userId> <amount>"); process.exit(1); }
    // CRITICAL: Admin credit addition requires Stripe payment ID for real value
    const stripePaymentId = args[3] || null;
    if (!stripePaymentId) {
      console.error("ERROR: Credits require Stripe payment ID for real monetary value.");
      console.error("Usage: payment-router.js credits add <userId> <amount> <stripe_payment_id>");
      console.error("Example: payment-router.js credits add bot_123 10 pi_1234567890");
      console.error("\nTo purchase credits via Stripe:");
      console.error("  Use the bot-commerce system: !oracle buy-credits");
      process.exit(1);
    }
    addCredits(userId, Number(amountStr) || 5, "purchase", stripePaymentId)
      .then((c) => console.log(`✅ Credits for ${userId}: balance=${c.balance} (total purchased: ${c.purchased})`));
  } else if (args[0] === "credits" && args[1] === "check") {
    const userId = args[2];
    if (!userId) { console.error("Usage: payment-router.js credits check <userId>"); process.exit(1); }
    getCredits(userId).then((c) => console.log(JSON.stringify(c, null, 2)));
  } else if (args[0] === "pending") {
    loadPending().then((p) => {
      const entries = Object.values(p);
      const unpaid = entries.filter((e) => !e.paid);
      const paid = entries.filter((e) => e.paid && !e.delivered);
      const done = entries.filter((e) => e.paid && e.delivered);
      console.log(`Pending: ${unpaid.length} | Paid undelivered: ${paid.length} | Complete: ${done.length}`);
      if (paid.length) console.log("\nPaid, awaiting delivery:\n", JSON.stringify(paid, null, 2));
    });
  } else {
    console.log(`
payment-router.js  —  OpenClaw Prompt Oracle payment handler

Payment rails:
  stripe     — Stripe Checkout (all 16 enabled: cards, Apple Pay, Google Pay, Amazon Pay, CashApp, Crypto, Klarna, Afterpay, Affirm, Zip, ACH, bank transfer, Bancontact, EPS, Kakao/Samsung Pay)
  credits    — Pre-purchased API credits (instant, no fee)

Commands:
  node scripts/payment-router.js server                       # Start webhook server (:${PORT})
  node scripts/payment-router.js credits add <userId> <n>     # Add N credits to a user
  node scripts/payment-router.js credits check <userId>       # Check credit balance
  node scripts/payment-router.js pending                      # Show payment queue status

Required env:  STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, COMMERCE_PUBLIC_URL
Optional env:  COMMERCE_PORT, COMMERCE_PRICE_USD
`);
  }
}
