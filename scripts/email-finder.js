#!/usr/bin/env node
// scripts/email-finder.js
// ─────────────────────────────────────────────────────────────────────────────
// Free Email Finder — NO paid API required
//
// Uses a 3-layer approach to find professional B2B emails:
//
//  Layer 1 — Website scrape (Playwright)
//    Navigate to the business website and scrape mailto: links,
//    contact forms, and visible email text from /contact, /about, /team pages.
//
//  Layer 2 — Pattern generation + SMTP verification
//    Generate common email patterns from the person/business name:
//      info@, hello@, contact@, owner@, manager@
//      firstname@, firstname.lastname@, flastname@, firstnamelastname@
//    Then verify each candidate via:
//      a) MX record lookup (DNS) — is there a mail server?
//      b) SMTP RCPT TO handshake (port 25) — does the address exist?
//         Without sending any email.
//
//  Layer 3 — Hunter.io / Apollo free tier API (optional)
//    If HUNTER_API_KEY or APOLLO_API_KEY set in .env, use their free
//    monthly quota (25 searches for Hunter, 600 for Apollo) as a bonus.
//
// Results are upserted into leads.email column.
//
// Usage:
//   node scripts/email-finder.js --limit 50
//   node scripts/email-finder.js --id 123               (single lead by ID)
//   node scripts/email-finder.js --domain yourdomain.com   (find emails for domain)
//   node scripts/email-finder.js --name "Jane Smith" --domain yourdomain.com
//   node scripts/email-finder.js --dry-run --limit 20
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

require('dotenv').config();
const dns   = require('dns').promises;
const net   = require('net');
const https = require('https');
const http  = require('http');
const { chromium } = require('playwright');
const { Pool } = require('pg');

const dbHost = process.env.POSTGRES_HOST || process.env.CLAW_DB_HOST || process.env.DB_HOST;
const dbPort = parseInt(process.env.POSTGRES_PORT || process.env.CLAW_DB_PORT || process.env.DB_PORT || '15432', 10);
const dbName = process.env.POSTGRES_DB || process.env.CLAW_DB_NAME || process.env.DB_NAME || 'claw_architect';
const dbUser = process.env.POSTGRES_USER || process.env.CLAW_DB_USER || process.env.DB_USER || 'claw';
const dbPass = process.env.POSTGRES_PASSWORD || process.env.CLAW_DB_PASSWORD || process.env.DB_PASSWORD;

if (!dbHost || !dbPass) {
  throw new Error('Missing DB env vars. Set POSTGRES_* (preferred) or CLAW_DB_* / DB_* including password.');
}

// ── DB ────────────────────────────────────────────────────────────────────────
const pool = new Pool({
  host: dbHost,
  port: dbPort,
  database: dbName,
  user: dbUser,
  password: dbPass,
});

// ── Config ────────────────────────────────────────────────────────────────────
const HUNTER_KEY = process.env.HUNTER_API_KEY  || '';
const APOLLO_KEY = process.env.APOLLO_API_KEY  || '';

const args    = process.argv.slice(2);
const getArg  = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i+1] : null; };
const hasFlag = (f) => args.includes(f);

const LIMIT    = parseInt(getArg('--limit') || '50', 10);
const LEAD_ID  = getArg('--id');
const DOMAIN   = getArg('--domain');
const NAME     = getArg('--name');
const DRY_RUN  = hasFlag('--dry-run');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function ensureLeadSchema() {
  await pool.query(`
    ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS created_at       TIMESTAMPTZ DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS email_source     TEXT,
      ADD COLUMN IF NOT EXISTS email_found_at   TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS contact_name     TEXT,
      ADD COLUMN IF NOT EXISTS contact_title    TEXT,
      ADD COLUMN IF NOT EXISTS contact_linkedin TEXT
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads_contacts (
      id            SERIAL PRIMARY KEY,
      lead_id       UUID REFERENCES leads(id) ON DELETE SET NULL,
      full_name     TEXT NOT NULL,
      title         TEXT,
      location      TEXT,
      company_name  TEXT,
      linkedin_url  TEXT UNIQUE,
      search_query  TEXT,
      source        TEXT DEFAULT 'linkedin',
      email         TEXT,
      enriched_at   TIMESTAMPTZ,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// ── Email patterns ────────────────────────────────────────────────────────────
// Pattern frequency order based on analysis of 10M+ B2B email datasets:
// first.last (28%) > first (19%) > flast (17%) > info (13%) > others
function generatePatterns(name, domain) {
  if (!domain) return [];

  const clean  = (name || '').toLowerCase().replace(/[^a-z\s]/g, '').trim();
  const parts  = clean.split(/\s+/).filter(Boolean);
  const first  = parts[0] || '';
  const last   = parts[parts.length - 1] || '';
  const fi     = first[0] || '';

  // Build name-based patterns in frequency order (first when name is known)
  const namePats = first ? [
    `${first}.${last}@${domain}`,   // #1 most common (28%)
    `${first}@${domain}`,           // #2 (19%)
    `${fi}${last}@${domain}`,       // #3 flast (17%)
    `${fi}.${last}@${domain}`,      // #4 f.last
    `${first}${last}@${domain}`,    // firstname+lastname
    `${last}.${first}@${domain}`,   // last.first
    `${last}${fi}@${domain}`,       // lastf
    `${first}_${last}@${domain}`,   // first_last (less common)
  ] : [];

  // Generic business patterns — buyer/wholesale first (decision-makers), then general
  const genericPats = [
    `wholesale@${domain}`,
    `buyer@${domain}`,
    `purchasing@${domain}`,
    `merchandise@${domain}`,
    `sales@${domain}`,
    `orders@${domain}`,
    `info@${domain}`,
    `hello@${domain}`,
    `contact@${domain}`,
    `owner@${domain}`,
    `manager@${domain}`,
    `store@${domain}`,
    `support@${domain}`,
  ];

  // When we have a name: try name patterns first (more personalized, higher response rate)
  // When no name: try generic patterns
  const ordered = name ? [...namePats, ...genericPats] : genericPats;
  return [...new Set(ordered.filter(Boolean))];
}

// ── MX record check ───────────────────────────────────────────────────────────
const mxCache = new Map();
async function hasMX(domain) {
  if (mxCache.has(domain)) return mxCache.get(domain);
  try {
    const records = await dns.resolveMx(domain);
    const has = records && records.length > 0;
    mxCache.set(domain, has);
    return has;
  } catch {
    mxCache.set(domain, false);
    return false;
  }
}

// ── Port-25 availability probe (one-time per session) ────────────────────────
// Many ISPs and cloud hosts block outbound port 25. Rather than wasting 8s per
// address timing out, we probe once on startup and skip SMTP if it's blocked.
let port25Available = null; // null = untested, true/false = result

async function checkPort25() {
  if (port25Available !== null) return port25Available;
  return new Promise((resolve) => {
    const sock = net.createConnection(25, 'aspmx.l.google.com');
    const timer = setTimeout(() => { sock.destroy(); port25Available = false; resolve(false); }, 4000);
    sock.on('connect', () => { clearTimeout(timer); sock.destroy(); port25Available = true; resolve(true); });
    sock.on('error',   () => { clearTimeout(timer); port25Available = false; resolve(false); });
  });
}

// ── Catch-all server detection ────────────────────────────────────────────────
// A "catch-all" server accepts RCPT TO for any address, including probe ones.
// Without this check, SMTP verify would incorrectly mark random patterns as valid.
// We send RCPT TO for a provably-invalid address first. If it returns 250, the
// server is catch-all and SMTP results are unreliable for this domain.
const catchAllCache = new Map(); // domain → boolean

async function isCatchAll(mxHost, domain, timeout = 6000) {
  if (catchAllCache.has(domain)) return catchAllCache.get(domain);

  const probeAddr = `xzy_noreply_${Date.now()}@${domain}`;
  const result = await smtpConnect(mxHost, probeAddr, timeout);

  // If the probe address is accepted, it's catch-all
  const catchAll = (result === 'accepted');
  catchAllCache.set(domain, catchAll);
  if (catchAll) console.log(`   ⚠️  ${domain} is catch-all — SMTP verify unreliable`);
  return catchAll;
}

// ── Core SMTP RCPT TO handshake ───────────────────────────────────────────────
// Returns: 'accepted' | 'rejected' | 'unknown'
function smtpConnect(mxHost, email, timeout = 8000) {
  return new Promise((resolve) => {
    const sock = net.createConnection(25, mxHost);
    let stage = 0;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      sock.destroy();
      resolve('unknown'); // timeout = port blocked or slow server
    }, timeout);

    const send = (msg) => { try { sock.write(msg + '\r\n'); } catch {} };

    sock.on('data', (data) => {
      const resp = data.toString();
      if (timedOut) return;

      if (stage === 0 && resp.startsWith('220')) {
        stage = 1; send('EHLO verify.local');
      } else if (stage === 1 && (resp.includes('250') || resp.includes('220'))) {
        stage = 2; send('MAIL FROM:<probe@verify.local>');
      } else if (stage === 2 && resp.startsWith('250')) {
        stage = 3; send(`RCPT TO:<${email}>`);
      } else if (stage === 3) {
        const code = parseInt(resp.slice(0, 3));
        // 250/251/252 = accepted, 550/551/553 = rejected, anything else = unknown
        const verdict = (code >= 250 && code <= 252) ? 'accepted'
                      : (code >= 550 && code <= 553) ? 'rejected'
                      : 'unknown';
        send('QUIT');
        clearTimeout(timer);
        sock.destroy();
        resolve(verdict);
      }
    });

    sock.on('error',   () => { clearTimeout(timer); resolve('unknown'); });
    sock.on('close',   () => { clearTimeout(timer); resolve('unknown'); });
  });
}

// ── SMTP verify (with catch-all guard) ───────────────────────────────────────
async function smtpVerify(email, timeout = 8000) {
  const [, domain] = email.split('@');
  if (!domain) return false;

  // Skip if port 25 is blocked in this environment
  const p25 = await checkPort25();
  if (!p25) return false; // silently skip — will rely on website scrape + patterns

  // Get MX record (cached via hasMX() above)
  let mxHost;
  try {
    const records = await dns.resolveMx(domain);
    if (!records || records.length === 0) return false;
    records.sort((a, b) => a.priority - b.priority);
    mxHost = records[0].exchange;
  } catch {
    return false;
  }

  // Catch-all check (once per domain)
  const catchAll = await isCatchAll(mxHost, domain, timeout);
  if (catchAll) return false; // can't trust any result from this server

  // Real verification
  const verdict = await smtpConnect(mxHost, email, timeout);
  return verdict === 'accepted';
}

// ── Website scraper (Layer 1) ─────────────────────────────────────────────────
async function scrapeEmailFromWebsite(websiteUrl) {
  if (!websiteUrl) return [];

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-gpu',
        '--disable-gpu-compositing',
        '--use-angle=swiftshader',
      ],
    });
    const ctx  = await browser.newContext({
      userAgent: 'Mozilla/5.0 (compatible; EmailFinder/1.0)',
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(15_000);

    const found = new Set();
    const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
    const JUNK = /\.(png|jpg|gif|svg|woff|ttf|css|js)$/i;

    const origin = new URL(websiteUrl).origin;
    const paths  = ['', '/contact', '/contact-us', '/about', '/about-us', '/team', '/staff'];

    for (const p of paths) {
      try {
        await page.goto(origin + p, { waitUntil: 'domcontentloaded', timeout: 12_000 });
        const html = await page.content();
        const text = await page.evaluate(() => document.body?.innerText || '');

        // mailto: links
        const mailtos = [...html.matchAll(/mailto:([^"' >?]+)/gi)].map(m => m[1].toLowerCase());
        mailtos.forEach(e => { if (!JUNK.test(e.split('@')[1] || '')) found.add(e); });

        // Regex scan
        const raw = [...(html + text).matchAll(EMAIL_RE)].map(m => m[0].toLowerCase());
        raw.forEach(e => {
          const dom = e.split('@')[1] || '';
          if (!JUNK.test(dom) && !['google','facebook','sentry','example'].some(j => dom.includes(j))) {
            found.add(e);
          }
        });

        if (found.size > 0) break; // Stop once we find something

      } catch { /* page not found, continue */ }
    }

    await ctx.close();
    return [...found];
  } catch {
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

// ── Hunter.io free tier (Layer 3, optional) ───────────────────────────────────
function hunterLookup(domain) {
  return new Promise((resolve) => {
    if (!HUNTER_KEY) return resolve([]);
    const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${HUNTER_KEY}&limit=5`;
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          const emails = (data?.data?.emails || []).map(e => e.value).filter(Boolean);
          resolve(emails);
        } catch { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

// ── Apollo.io free tier domain lookup (Layer 3, optional) ────────────────────
function apolloLookup(domain) {
  return new Promise((resolve) => {
    if (!APOLLO_KEY) return resolve([]);
    const body = JSON.stringify({ api_key: APOLLO_KEY, q_organization_domains: domain, page: 1, per_page: 5 });
    const req  = https.request({
      hostname: 'api.apollo.io',
      path: '/v1/mixed_people/search',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data  = JSON.parse(Buffer.concat(chunks).toString());
          const people = data?.people || [];
          const emails = people.map(p => p.email).filter(e => e && !e.includes('*'));
          resolve(emails);
        } catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.write(body);
    req.end();
  });
}

// ── Find email for one lead ───────────────────────────────────────────────────
async function findEmailForLead(lead) {
  const { id, business_name, website, contact_name } = lead;
  let domain = null;

  if (website) {
    try { domain = new URL(website).hostname.replace(/^www\./, ''); } catch {}
  }

  console.log(`\n🔍 [${id}] ${business_name}${domain ? ' → ' + domain : ' (no website)'}`);

  const found = [];

  // Layer 1: Scrape website
  if (website) {
    const scraped = await scrapeEmailFromWebsite(website);
    if (scraped.length > 0) {
      console.log(`   🌐 Website: ${scraped.join(', ')}`);
      found.push(...scraped.map(e => ({ email: e, method: 'website_scrape', confidence: 'high' })));
    }
  }

  // Layer 2: Pattern + SMTP
  if (found.length === 0 && domain) {
    const hasMx = await hasMX(domain);
    if (hasMx) {
      const patterns = generatePatterns(contact_name || business_name, domain);
      console.log(`   📧 Testing ${patterns.length} patterns via SMTP...`);

      // Test generics first, then name patterns
      for (const candidate of patterns.slice(0, 20)) {
        const valid = await smtpVerify(candidate);
        if (valid) {
          console.log(`   ✅ SMTP verified: ${candidate}`);
          found.push({ email: candidate, method: 'smtp_verify', confidence: 'medium' });
          if (found.length >= 2) break; // Stop after finding 2
        }
        await sleep(300); // Small delay between SMTP checks
      }

      // If SMTP checks fail (many servers block port 25), fall back to returning
      // the generic "best guess" info@ with low confidence
      if (found.length === 0) {
        const guess = `info@${domain}`;
        console.log(`   💡 Fallback guess: ${guess}`);
        found.push({ email: guess, method: 'pattern_guess', confidence: 'low' });
      }
    } else {
      console.log(`   ⚠️  No MX record for ${domain}`);
    }
  }

  // Layer 3: Hunter.io / Apollo (free quota)
  if (found.filter(f => f.confidence !== 'low').length === 0 && domain) {
    const [hunterEmails, apolloEmails] = await Promise.all([
      hunterLookup(domain),
      apolloLookup(domain),
    ]);
    const apiEmails = [...new Set([...hunterEmails, ...apolloEmails])];
    if (apiEmails.length > 0) {
      console.log(`   🎯 API found: ${apiEmails.join(', ')}`);
      apiEmails.forEach(e => found.push({ email: e, method: 'api_lookup', confidence: 'high' }));
    }
  }

  return found;
}

// ── Get leads needing email enrichment ───────────────────────────────────────
async function getLeadsToEnrich(limit, id = null) {
  const query = id
    ? `SELECT
         l.id,
         l.business_name,
         l.website,
         COALESCE(NULLIF(l.contact_name, ''), c.full_name) AS contact_name,
         COALESCE(NULLIF(l.contact_title, ''), c.title) AS contact_title,
         COALESCE(NULLIF(l.contact_linkedin, ''), c.linkedin_url) AS contact_linkedin
       FROM leads l
       LEFT JOIN LATERAL (
         SELECT lc.full_name, lc.title, lc.linkedin_url
         FROM leads_contacts lc
         WHERE lc.lead_id = l.id
            OR LOWER(TRIM(lc.company_name)) = LOWER(TRIM(l.business_name))
         ORDER BY lc.created_at DESC
         LIMIT 1
       ) c ON TRUE
       WHERE l.id = $1`
    : `SELECT
         l.id,
         l.business_name,
         l.website,
         COALESCE(NULLIF(l.contact_name, ''), c.full_name) AS contact_name,
         COALESCE(NULLIF(l.contact_title, ''), c.title) AS contact_title,
         COALESCE(NULLIF(l.contact_linkedin, ''), c.linkedin_url) AS contact_linkedin
       FROM leads l
       LEFT JOIN LATERAL (
         SELECT lc.full_name, lc.title, lc.linkedin_url
         FROM leads_contacts lc
         WHERE lc.lead_id = l.id
            OR LOWER(TRIM(lc.company_name)) = LOWER(TRIM(l.business_name))
         ORDER BY lc.created_at DESC
         LIMIT 1
       ) c ON TRUE
       WHERE l.brand_slug = COALESCE($2, l.brand_slug)
         AND (l.email IS NULL OR l.email = '')
         AND l.website IS NOT NULL
       ORDER BY COALESCE(l.updated_at, l.fetched_at, l.created_at) DESC
       LIMIT $1`;

  const params = id ? [id] : [limit, process.env.LEADGEN_BRAND_SLUG || null];
  const result = await pool.query(query, params);
  return result.rows;
}

// ── Update lead with found email ──────────────────────────────────────────────
async function updateLeadEmail(lead, email, method) {
  await pool.query(
    `UPDATE leads
       SET email = $1,
           email_source = $2,
           email_found_at = NOW(),
           contact_name = COALESCE(NULLIF($3,''), contact_name),
           contact_title = COALESCE(NULLIF($4,''), contact_title),
           contact_linkedin = COALESCE(NULLIF($5,''), contact_linkedin),
           updated_at = NOW()
     WHERE id = $6`,
    [email, method, lead.contact_name || null, lead.contact_title || null, lead.contact_linkedin || null, lead.id]
  ).catch(async () => {
    // Backward compatibility for older DBs
    await pool.query(
      `ALTER TABLE leads
         ADD COLUMN IF NOT EXISTS email_source     TEXT,
         ADD COLUMN IF NOT EXISTS email_found_at   TIMESTAMPTZ,
         ADD COLUMN IF NOT EXISTS contact_name     TEXT,
         ADD COLUMN IF NOT EXISTS contact_title    TEXT,
         ADD COLUMN IF NOT EXISTS contact_linkedin TEXT,
         ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ DEFAULT NOW()`
    );
    await pool.query(
      `UPDATE leads
         SET email = $1,
             email_source = $2,
             email_found_at = NOW(),
             contact_name = COALESCE(NULLIF($3,''), contact_name),
             contact_title = COALESCE(NULLIF($4,''), contact_title),
             contact_linkedin = COALESCE(NULLIF($5,''), contact_linkedin),
             updated_at = NOW()
       WHERE id = $6`,
      [email, method, lead.contact_name || null, lead.contact_title || null, lead.contact_linkedin || null, lead.id]
    );
  });
}

// ── Domain-only mode ──────────────────────────────────────────────────────────
async function runDomainMode() {
  const results = await findEmailForLead({
    id: 0,
    business_name: DOMAIN,
    website: `https://${DOMAIN}`,
    contact_name: NAME || null,
  });

  console.log(`\n📬 Results for ${DOMAIN}:`);
  if (results.length === 0) {
    console.log('   No emails found');
  } else {
    results.forEach(r => console.log(`   ${r.confidence.toUpperCase()} | ${r.method} | ${r.email}`));
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  await ensureLeadSchema();

  // Domain-only mode (no DB needed)
  if (DOMAIN && !LEAD_ID) {
    await runDomainMode();
    await pool.end();
    return;
  }

  const leads = await getLeadsToEnrich(LIMIT, LEAD_ID);
  console.log(`\n📋 ${leads.length} leads to process`);

  if (leads.length === 0) {
    console.log('Nothing to enrich. Run google-maps-scraper.js first to populate leads.');
    await pool.end();
    return;
  }

  let found = 0, failed = 0;

  for (const lead of leads) {
    try {
      const results = await findEmailForLead(lead);

      if (results.length === 0) {
        failed++;
        continue;
      }

      // Pick best result (highest confidence)
      const best = results.sort((a, b) => {
        const order = { high: 3, medium: 2, low: 1 };
        return (order[b.confidence] || 0) - (order[a.confidence] || 0);
      })[0];

      if (!DRY_RUN) {
        await updateLeadEmail(lead, best.email, best.method);
      }

      found++;
      await sleep(500 + Math.random() * 800);

    } catch (err) {
      console.error(`   Error for ${lead.business_name}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n✅ Done: ${found} emails found, ${failed} no email found`);
  if (DRY_RUN) console.log('   (DRY RUN — nothing saved to DB)');

  await pool.end();
}

main().catch(err => {
  console.error('Fatal:', err.message);
  pool.end();
  process.exit(1);
});
