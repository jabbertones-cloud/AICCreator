#!/usr/bin/env node
/**
 * enrich-leads-email.js
 * ──────────────────────────────────────────────────────────────────────────
 * FREE email enrichment — scrapes the business's own website looking for
 * contact email addresses. No paid API required.
 *
 * Strategy (in order):
 *   1. Fetch homepage  → scan for mailto: links and plain email addresses
 *   2. Fetch /contact, /contact-us, /about, /about-us pages
 *   3. If still nothing: try common email patterns (info@, hello@, contact@)
 *      and validate the domain has a valid MX record
 *   4. Skip if website is blank or unreachable
 *
 * Usage:
 *   node scripts/enrich-leads-email.js              # process all leads with website but no email
 *   node scripts/enrich-leads-email.js --dry-run    # show what would be set, no DB writes
 *   node scripts/enrich-leads-email.js --limit 50   # process at most 50 leads
 *   node scripts/enrich-leads-email.js --id 123     # single lead by ID
 */
"use strict";

const https   = require("https");
const http    = require("http");
const dns     = require("dns").promises;
const path    = require("path");
const { Pool } = require("pg");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

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

const DRY_RUN  = process.argv.includes("--dry-run");
const LIMIT    = (() => { const i = process.argv.indexOf("--limit"); return i >= 0 ? parseInt(process.argv[i+1]) : 200; })();
const LEAD_ID  = (() => { const i = process.argv.indexOf("--id");    return i >= 0 ? String(process.argv[i+1]) : null; })();

// ── Email regex ───────────────────────────────────────────────────────────
// Matches typical email addresses found in HTML source or text
const EMAIL_RE = /\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/g;

// Domains to skip even if extracted from HTML (tracking pixels, social, CDN)
const JUNK_DOMAINS = new Set([
  "example.org", "yourdomain.com", "domain.com", "email.com",
  "sentry.io", "google.com", "googleapis.com", "gstatic.com",
  "cloudflare.com", "mailchimp.com", "klaviyo.com", "sendgrid.net",
  "facebook.com", "instagram.com", "twitter.com", "tiktok.com",
  "youtube.com", "amazon.com", "amazonaws.com", "wix.com", "shopify.com",
  "squarespace.com", "godaddy.com", "wordpress.com",
]);

// ── HTTP fetch with timeout ───────────────────────────────────────────────

function fetchUrl(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const proto = url.startsWith("https") ? https : http;
    let raw = "";
    const req = proto.get(url, { timeout: timeoutMs }, (res) => {
      // Follow one redirect
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        resolve(fetchUrl(res.headers.location, timeoutMs));
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 400) {
        resolve(null);
        return;
      }
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 500_000) { req.destroy(); } // 500KB cap
      });
      res.on("end", () => resolve(raw));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

// ── Extract emails from HTML string ──────────────────────────────────────

function extractEmails(html, domain) {
  if (!html) return [];
  const found = new Set();

  // Priority: mailto: links first
  const mailtoRe = /mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi;
  let m;
  while ((m = mailtoRe.exec(html)) !== null) {
    found.add(m[1].toLowerCase());
  }

  // Then plain email text
  const allEmails = html.match(EMAIL_RE) || [];
  for (const e of allEmails) {
    found.add(e.toLowerCase());
  }

  // Filter: prefer same domain or contact-style prefix — buyer/wholesale first for B2B
  const contactPrefixes = ["wholesale", "buyer", "purchasing", "merchandise", "sales", "orders",
                            "info", "hello", "contact", "shop", "support", "office", "team", "hi", "hey"];

  const results = [...found].filter(e => {
    const [localPart, eDomain] = e.split("@");
    if (!eDomain) return false;
    if (JUNK_DOMAINS.has(eDomain)) return false;
    // Prefer same-domain emails, but also keep contact-prefix emails from any domain
    const sameDomain = eDomain === domain || eDomain.endsWith("." + domain);
    const isContact  = contactPrefixes.includes(localPart);
    return sameDomain || isContact;
  });

  // Sort: same-domain first; then buyer-style prefix (wholesale, buyer, purchasing) > other contact > rest
  const buyerPrefixes = ["wholesale", "buyer", "purchasing", "merchandise"];
  results.sort((a, b) => {
    const ad = a.split("@")[1]; const bd = b.split("@")[1];
    const al = a.split("@")[0]; const bl = b.split("@")[0];
    const aScore = (ad === domain ? 10 : 0) + (buyerPrefixes.includes(al) ? 8 : contactPrefixes.includes(al) ? 5 : 0);
    const bScore = (bd === domain ? 10 : 0) + (buyerPrefixes.includes(bl) ? 8 : contactPrefixes.includes(bl) ? 5 : 0);
    return bScore - aScore;
  });

  return results;
}

// ── Domain MX check ───────────────────────────────────────────────────────

async function hasMxRecord(domain) {
  try {
    const records = await dns.resolveMx(domain);
    return records.length > 0;
  } catch {
    return false;
  }
}

// ── Main enrichment logic for one lead ───────────────────────────────────

async function enrichLead(lead) {
  const website = (lead.website || "").trim();
  if (!website) return { email: null, method: "no_website" };

  // Normalize URL
  let baseUrl = website;
  if (!baseUrl.startsWith("http")) baseUrl = "https://" + baseUrl;
  baseUrl = baseUrl.replace(/\/$/, "");

  // Extract domain
  let domain;
  try { domain = new URL(baseUrl).hostname.replace(/^www\./, ""); }
  catch { return { email: null, method: "bad_url" }; }

  // Pages to check — buyer/wholesale first (decision-maker emails), then general contact
  const pagesToCheck = [
    `${baseUrl}/wholesale`,
    `${baseUrl}/for-retailers`,
    `${baseUrl}/purchasing`,
    `${baseUrl}/contact`,
    `${baseUrl}/contact-us`,
    baseUrl,
    `${baseUrl}/about`,
    `${baseUrl}/about-us`,
    `${baseUrl}/reach-us`,
    `${baseUrl}/get-in-touch`,
  ];

  for (const pageUrl of pagesToCheck) {
    await sleep(300); // polite crawl delay
    const html = await fetchUrl(pageUrl);
    const emails = extractEmails(html, domain);
    if (emails.length > 0) {
      return { email: emails[0], allFound: emails, method: "scraped:" + pageUrl };
    }
  }

  // Fallback: guess the most common prefix (info@) after confirming the
  // domain has valid MX records. No SMTP verification — just MX presence.
  const hasMx = await hasMxRecord(domain);
  if (hasMx) {
    return { email: `info@${domain}`, method: "guessed_mx_verified:" + domain };
  }

  return { email: null, method: "not_found" };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n");
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║         SKYNPATCH LEAD EMAIL ENRICHER  (free scraper)       ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  if (DRY_RUN) console.log("  ⚠️  DRY RUN — no DB writes\n");

  // Fetch leads that have a website but no email
  const whereParts = [];
  const params = [];
  if (LEAD_ID) {
    params.push(LEAD_ID);
    whereParts.push(`id = $${params.length}::uuid`);
  } else {
    whereParts.push(`website IS NOT NULL AND website != ''`);
    whereParts.push(`(email IS NULL OR email = '')`);
    whereParts.push(`status != 'unsubscribed'`);
  }
  params.push(LIMIT);

  const { rows: leads } = await pool.query(
    `SELECT id, business_name, website, city, state
       FROM leads
      WHERE ${whereParts.join(" AND ")}
      LIMIT $${params.length}`,
    params
  );

  console.log(`  📋 Leads to enrich: ${leads.length.toLocaleString()}\n`);

  let enriched = 0, notFound = 0, guessed = 0;

  for (const lead of leads) {
    process.stdout.write(`  ${lead.business_name.slice(0, 40).padEnd(41)} ${(lead.city || "").padEnd(18)}`);

    const result = await enrichLead(lead);

    if (result.email) {
      const isGuessed = result.method.startsWith("guessed");
      process.stdout.write(`→ ${result.email}  [${isGuessed ? "guessed" : "scraped"}]\n`);

      if (!DRY_RUN) {
        await pool.query(
          `UPDATE leads SET email = $1, notes = COALESCE(notes||'; ','') || $2 WHERE id = $3`,
          [result.email, "email_source:" + result.method, lead.id]
        );
      }

      if (isGuessed) guessed++; else enriched++;
    } else {
      process.stdout.write(`→ (not found)\n`);
      notFound++;
    }
  }

  console.log(`\n  ✅ Scraped emails found : ${enriched}`);
  console.log(`  🔮 Guessed (MX verified): ${guessed}`);
  console.log(`  ❌ Not found            : ${notFound}`);
  console.log(`  📊 Total processed      : ${leads.length}\n`);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
