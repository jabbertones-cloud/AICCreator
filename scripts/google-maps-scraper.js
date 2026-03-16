#!/usr/bin/env node
// scripts/google-maps-scraper.js  v2
// ─────────────────────────────────────────────────────────────────────────────
// Google Maps Scraper — NO API KEY REQUIRED
//
// v2 improvements over v1:
//   • Multi-strategy selector engine — 3 fallback layers when Google rotates
//     their minified class names (which they do regularly)
//   • List-view extraction first — pulls name/address/rating directly from
//     the sidebar cards WITHOUT clicking, which is 4x faster and more stable
//   • Click-for-detail second pass — only clicks cards that are missing phone
//     or website to fill in those fields
//   • Multi-city support: --cities "Phoenix,Scottsdale,Tempe,Mesa"
//   • --test flag: opens one URL, prints what it finds, exits (debugging)
//   • Stealth hardening: removes navigator.webdriver, __playwright__, chrome
//     flags, spoofs plugins array, mocks screen dimensions
//   • Retry logic: 3 attempts per query with different user agents on failure
//
// Usage:
//   node scripts/google-maps-scraper.js --query "health food store" --city "Phoenix, AZ"
//   node scripts/google-maps-scraper.js --all-categories --city "Phoenix, AZ"
//   node scripts/google-maps-scraper.js --all-categories --cities "Phoenix,Scottsdale,Tempe"
//   node scripts/google-maps-scraper.js --test --query "yoga studio" --city "Phoenix, AZ"
//   node scripts/google-maps-scraper.js --all-categories --city "Phoenix, AZ" --visible
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

require('dotenv').config();
const { chromium } = require('playwright');
const { Pool }     = require('pg');
const { LEAD_CATEGORIES } = require('../config/lead-categories');

const dbHost = process.env.POSTGRES_HOST || process.env.CLAW_DB_HOST || process.env.DB_HOST;
const dbPort = parseInt(process.env.POSTGRES_PORT || process.env.CLAW_DB_PORT || process.env.DB_PORT || '15432', 10);
const dbName = process.env.POSTGRES_DB || process.env.CLAW_DB_NAME || process.env.DB_NAME || 'claw_architect';
const dbUser = process.env.POSTGRES_USER || process.env.CLAW_DB_USER || process.env.DB_USER || 'claw';
const dbPass = process.env.POSTGRES_PASSWORD || process.env.CLAW_DB_PASSWORD || process.env.DB_PASSWORD;

if (!dbHost || !dbPass) {
  throw new Error('Missing DB env vars. Set POSTGRES_* (preferred) or CLAW_DB_* / DB_* including password.');
}

const pool = new Pool({
  host: dbHost,
  port: dbPort,
  database: dbName,
  user: dbUser,
  password: dbPass,
});

const CATEGORIES = LEAD_CATEGORIES;
const BRAND_SLUG = process.env.LEADGEN_BRAND_SLUG || 'skynpatch';

// Rotate user agents on retries
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
];

const args      = process.argv.slice(2);
const getArg    = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i+1] : null; };
const hasFlag   = (f) => args.includes(f);
const QUERY     = getArg('--query');
const CITY      = getArg('--city')   || 'Phoenix, AZ';
const CITIES    = getArg('--cities');   // comma-separated
const LIMIT     = parseInt(getArg('--limit') || '30', 10);
const ALL_CATS  = hasFlag('--all-categories');
const DRY_RUN   = hasFlag('--dry-run');
const HEADLESS  = !hasFlag('--visible');
const TEST_MODE = hasFlag('--test');

const sleep    = (ms) => new Promise(r => setTimeout(r, ms));
const randMs   = (lo, hi) => lo + Math.random() * (hi - lo);

// ── Stealth init script injected into every page ──────────────────────────────
const STEALTH_SCRIPT = `
  // Remove automation flags
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  delete navigator.__proto__.webdriver;

  // Spoof plugins (real browsers have them)
  Object.defineProperty(navigator, 'plugins', {
    get: () => [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
      { name: 'Chrome PDF Viewer',  filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
      { name: 'Native Client',      filename: 'internal-nacl-plugin' },
    ]
  });

  // Spoof languages
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

  // Remove Playwright-specific globals
  delete window.__playwright;
  delete window.__pw_manual;
  delete window.callPhantom;
  delete window._phantom;

  // chrome object (real Chrome has this)
  if (!window.chrome) window.chrome = { runtime: {}, loadTimes: function(){}, csi: function(){} };
`;

// ── Multi-strategy text extraction from Google Maps DOM ───────────────────────
// Google rotates minified class names but semantic structure stays consistent.
// Each strategy tries a different approach; first one that returns data wins.

const EXTRACT_LIST_ITEMS = `
  (() => {
    const results = [];

    // ── Strategy A: role="article" cards (current Maps format ~2024-2025) ──
    const articles = document.querySelectorAll('[role="article"]');
    for (const art of articles) {
      const linkEl = art.querySelector('a[href*="/maps/place/"]');
      const allText = [...art.querySelectorAll('span, div')]
        .map(el => el.textContent.trim())
        .filter(t => t.length > 0 && t.length < 200);

      // Name: usually the first substantial text node inside the article
      const nameEl = art.querySelector('div[class*="fontHeadline"], [aria-label]') ||
                     art.querySelector('span[class*="hfpxzc"]') ||
                     linkEl;
      const name = nameEl ? (nameEl.getAttribute('aria-label') || nameEl.textContent.trim()) : '';

      // Rating: find text matching X.X pattern near a star icon
      const ratingText = allText.find(t => /^\\d\\.\\d$/.test(t)) || '';
      const rating = ratingText ? parseFloat(ratingText) : null;

      // Review count: "(NNN)" or "NNN reviews"
      const reviewText = allText.find(t => /\\(\\d+\\)/.test(t) || /\\d+ reviews?/i.test(t)) || '';
      const reviewMatch = reviewText.match(/\\d+/);
      const reviewCount = reviewMatch ? parseInt(reviewMatch[0]) : null;

      // Category + address: typically 3rd and 4th text blocks
      const metaTexts = allText.filter(t => t !== name && t !== ratingText && !/^\\(/.test(t));

      const href = linkEl ? linkEl.href : '';
      const coordMatch = href.match(/@(-?\\d+\\.\\d+),(-?\\d+\\.\\d+)/);

      if (name && name.length > 2) {
        results.push({
          name,
          href,
          rating,
          reviewCount,
          metaTexts: metaTexts.slice(0, 6),
          lat: coordMatch ? parseFloat(coordMatch[1]) : null,
          lng: coordMatch ? parseFloat(coordMatch[2]) : null,
        });
      }
    }

    // ── Strategy B: data-result-index attributes (older Maps format) ──
    if (results.length === 0) {
      const items = document.querySelectorAll('[data-result-index]');
      for (const item of items) {
        const nameEl = item.querySelector('[aria-label], h3, h2, .fontHeadlineLarge');
        const name = nameEl ? (nameEl.getAttribute('aria-label') || nameEl.textContent.trim()) : '';
        const linkEl = item.querySelector('a[href*="/maps/place/"]');
        const href = linkEl ? linkEl.href : '';
        if (name) results.push({ name, href, rating: null, reviewCount: null, metaTexts: [], lat: null, lng: null });
      }
    }

    // ── Strategy C: scan all place links (most robust fallback) ──
    if (results.length === 0) {
      const links = [...document.querySelectorAll('a[href*="/maps/place/"]')];
      const seen = new Set();
      for (const link of links) {
        const name = link.getAttribute('aria-label') || link.textContent.trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const coordMatch = link.href.match(/@(-?\\d+\\.\\d+),(-?\\d+\\.\\d+)/);
        results.push({
          name,
          href: link.href,
          rating: null, reviewCount: null, metaTexts: [],
          lat: coordMatch ? parseFloat(coordMatch[1]) : null,
          lng: coordMatch ? parseFloat(coordMatch[2]) : null,
        });
      }
    }

    return results;
  })()
`;

// Extract detail panel data (phone, website, full address) after clicking a card
const EXTRACT_DETAIL_PANEL = `
  (() => {
    // Phone: look for tel: links or text matching phone patterns
    const telLink = document.querySelector('a[href^="tel:"]');
    const phone = telLink
      ? telLink.href.replace('tel:', '')
      : (() => {
          const allText = document.body.innerText;
          const m = allText.match(/\\(\\d{3}\\)\\s*\\d{3}[\\-\\.]\\d{4}|\\d{3}[\\-\\.]\\d{3}[\\-\\.]\\d{4}/);
          return m ? m[0] : '';
        })();

    // Website: first external link that isn't google.com
    const webLink = [...document.querySelectorAll('a[href^="http"]')]
      .find(a => !a.href.includes('google.com') && !a.href.includes('goo.gl'));
    const website = webLink ? webLink.href.split('?')[0].replace(/\\/$/, '') : '';

    // Address: look for address-related aria labels or common address patterns
    const addrEl = document.querySelector('[aria-label*="ddress" i], [data-item-id*="address"]');
    const address = addrEl
      ? (addrEl.getAttribute('aria-label') || addrEl.textContent).replace(/^Address:?\s*/i, '').trim()
      : '';

    // Category from buttons at top of detail panel
    const catButtons = [...document.querySelectorAll('button[jsaction*="category"], .DkEaL, [aria-label*="category" i]')];
    const category = catButtons.map(b => b.textContent.trim()).filter(t => t.length < 50)[0] || '';

    return { phone, website, address, category };
  })()
`;

// ── Core scrape for one query + city ─────────────────────────────────────────
async function scrapeGoogleMaps({ query, city, limit, attempt = 0 }) {
  const { city: cityName, state } = parseCityState(city);
  const searchQuery = `${query} near ${city}`;
  const mapsUrl = `https://www.google.com/maps/search/${encodeURIComponent(searchQuery)}`;

  console.log(`\n🗺️  "${searchQuery}"  (attempt ${attempt + 1})`);

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-gpu-compositing',
      '--use-angle=swiftshader',
    ],
  });

  const ctx = await browser.newContext({
    userAgent: USER_AGENTS[attempt % USER_AGENTS.length],
    locale: 'en-US',
    viewport: { width: 1280, height: 800 },
  });

  await ctx.addInitScript(STEALTH_SCRIPT);
  const page = await ctx.newPage();
  const results = [];

  try {
    await page.goto(mapsUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await sleep(randMs(1200, 2200));

    // Dismiss cookie / consent overlays
    for (const sel of ['button[aria-label*="Accept"]', 'button[jsname*="higCR"]', '#L2AGLb', 'button:has-text("Accept all")']) {
      try { await page.click(sel, { timeout: 1500 }); await sleep(400); break; } catch {}
    }

    // Wait for list panel to appear — try multiple possible containers
    let listContainer = null;
    for (const sel of ['[role="feed"]', '[role="main"] [role="article"]', '.m6QErb', '[data-result-index="0"]']) {
      try {
        await page.waitForSelector(sel, { timeout: 8000 });
        listContainer = await page.$(sel.split(' ')[0]); // scroll target
        break;
      } catch {}
    }

    if (!listContainer) {
      // Check if we got a CAPTCHA or block page
      const title = await page.title();
      if (title.includes('sorry') || title.includes('unusual')) {
        throw new Error('Google detected bot — try again later or use --visible');
      }
    }

    // ── Phase 1: Extract directly from list view (no clicks) ──────────────────
    const scrollTarget = listContainer || await page.$('body');
    const scrollSteps  = Math.ceil(limit / 7);

    for (let s = 0; s < scrollSteps; s++) {
      if (scrollTarget) {
        await scrollTarget.evaluate(el => el.scrollBy(0, 700));
      }
      await sleep(randMs(900, 1500));
    }

    const rawCards = await page.evaluate(EXTRACT_LIST_ITEMS);
    console.log(`   📋 List view: ${rawCards.length} cards`);

    if (TEST_MODE) {
      console.log('\n── TEST MODE: First 3 raw cards ──');
      rawCards.slice(0, 3).forEach((c, i) => console.log(`${i+1}. ${JSON.stringify(c, null, 2)}`));
      return [];
    }

    // ── Phase 2: Click cards that need phone / website enrichment ─────────────
    // Get all "place" links from the current page state
    const placeLinks = await page.$$('a[href*="/maps/place/"]');
    const toEnrich   = placeLinks.slice(0, Math.min(limit, placeLinks.length));

    for (let i = 0; i < toEnrich.length; i++) {
      const link  = toEnrich[i];
      const rawCard = rawCards[i] || {};

      // Skip if we already have both phone and website
      const detailNeeded = !rawCard.phone || !rawCard.website;

      let detail = { phone: '', website: '', address: '', category: '' };

      if (detailNeeded) {
        try {
          await link.click();
          await sleep(randMs(1200, 1800));
          detail = await page.evaluate(EXTRACT_DETAIL_PANEL);
        } catch { /* panel didn't open, use what we have */ }
      }

      // Parse metaTexts into address / category
      const meta = rawCard.metaTexts || [];
      const guessedAddress  = meta.find(t => /\d/.test(t) && t.includes(',')) || meta[1] || '';
      const guessedCategory = meta.find(t => /store|studio|spa|gym|center|clinic|therapy|market|health/i.test(t)) || meta[0] || '';

      const addrStr    = detail.address || guessedAddress;
      const addrParts  = addrStr.split(',').map(s => s.trim());
      const streetAddr = addrParts.slice(0, -2).join(', ') || addrStr;

      results.push({
        name:         rawCard.name,
        address:      streetAddr,
        city:         cityName,
        state:        state,
        phone:        detail.phone   || null,
        website:      detail.website || null,
        category:     detail.category || guessedCategory || query,
        rating:       rawCard.rating,
        review_count: rawCard.reviewCount,
        lat:          rawCard.lat,
        lng:          rawCard.lng,
        place_id:     (rawCard.href || '').match(/0x[0-9a-f]+:0x[0-9a-f]+/i)?.[0] || null,
      });

      const short = `${rawCard.name}${detail.phone ? ' | ' + detail.phone : ''}${detail.website ? ' | ' + new URL(detail.website).hostname : ''}`;
      console.log(`   ✓ ${short}`);

      if (results.length >= limit) break;
      await sleep(randMs(400, 800));
    }

  } finally {
    await ctx.close();
    await browser.close();
  }

  return results;
}

// ── Retry wrapper ─────────────────────────────────────────────────────────────
async function scrapeWithRetry({ query, city, limit }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const results = await scrapeGoogleMaps({ query, city, limit, attempt });
      if (results.length > 0 || TEST_MODE) return results;
      console.log(`   ⚠️  0 results (attempt ${attempt+1}) — retrying...`);
    } catch (err) {
      console.error(`   ❌ Error (attempt ${attempt+1}): ${err.message}`);
      if (attempt < 2) await sleep(5000 + attempt * 3000);
    }
  }
  return [];
}

// ── DB save ───────────────────────────────────────────────────────────────────
async function ensureSchema() {
  const pg = require("../infra/postgres");
  // Check if migration has been applied
  const { rows } = await pg.query(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables 
      WHERE table_name = 'leads'
    ) as exists
  `);
  
  if (!rows[0].exists) {
    throw new Error('Migration 078 must be applied first. Run: node scripts/run-migrations.js --only 078');
  }
}

async function saveResults(businesses, source = 'google_maps_scraper') {
  if (DRY_RUN) {
    console.log(`\n[DRY RUN] ${businesses.length} businesses`);
    businesses.slice(0, 5).forEach(b => console.log(`  → ${b.name} | ${b.city} | ${b.website || 'no site'}`));
    return 0;
  }
  let saved = 0;
  let failed = 0;
  for (const b of businesses) {
    try {
      if (b.place_id) {
        await pool.query(`
          INSERT INTO leads
            (brand_slug, business_name, address, city, state, phone, website, category, source, lat, lng, place_id, rating, review_count)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
          ON CONFLICT (place_id) DO UPDATE SET
            brand_slug   = EXCLUDED.brand_slug,
            business_name= EXCLUDED.business_name,
            address      = COALESCE(EXCLUDED.address, leads.address),
            city         = COALESCE(EXCLUDED.city, leads.city),
            state        = COALESCE(EXCLUDED.state, leads.state),
            phone        = COALESCE(EXCLUDED.phone, leads.phone),
            website      = COALESCE(EXCLUDED.website, leads.website),
            category     = COALESCE(EXCLUDED.category, leads.category),
            source       = EXCLUDED.source,
            lat          = COALESCE(EXCLUDED.lat, leads.lat),
            lng          = COALESCE(EXCLUDED.lng, leads.lng),
            rating       = COALESCE(EXCLUDED.rating, leads.rating),
            review_count = COALESCE(EXCLUDED.review_count, leads.review_count),
            updated_at   = NOW()
        `, [BRAND_SLUG, b.name, b.address, b.city, b.state, b.phone, b.website, b.category,
            source, b.lat, b.lng, b.place_id, b.rating, b.review_count]);
      } else {
        await pool.query(`
          INSERT INTO leads
            (brand_slug, business_name, address, city, state, phone, website, category, source, lat, lng, rating, review_count)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
          ON CONFLICT (brand_slug, business_name, city, state) DO UPDATE SET
            brand_slug   = EXCLUDED.brand_slug,
            address      = COALESCE(EXCLUDED.address, leads.address),
            state        = COALESCE(EXCLUDED.state, leads.state),
            phone        = COALESCE(EXCLUDED.phone, leads.phone),
            website      = COALESCE(EXCLUDED.website, leads.website),
            category     = COALESCE(EXCLUDED.category, leads.category),
            source       = EXCLUDED.source,
            lat          = COALESCE(EXCLUDED.lat, leads.lat),
            lng          = COALESCE(EXCLUDED.lng, leads.lng),
            rating       = COALESCE(EXCLUDED.rating, leads.rating),
            review_count = COALESCE(EXCLUDED.review_count, leads.review_count),
            updated_at   = NOW()
        `, [BRAND_SLUG, b.name, b.address, b.city, b.state, b.phone, b.website, b.category,
            source, b.lat, b.lng, b.rating, b.review_count]);
      }
      saved++;
    } catch (err) {
      if (err && err.code === "23505") {
        try {
          await pool.query(
            `UPDATE leads
             SET address = COALESCE($1, address),
                 phone = COALESCE($2, phone),
                 website = COALESCE($3, website),
                 category = COALESCE($4, category),
                 source = $5,
                 lat = COALESCE($6, lat),
                 lng = COALESCE($7, lng),
                 rating = COALESCE($8, rating),
                 review_count = COALESCE($9, review_count),
                 updated_at = NOW()
             WHERE brand_slug = $10
               AND business_name = $11
               AND city = $12
               AND state = $13`,
            [b.address, b.phone, b.website, b.category, source, b.lat, b.lng, b.rating, b.review_count, BRAND_SLUG, b.name, b.city, b.state]
          );
          saved++;
          console.log(`   ↺ Deduped existing lead: ${b.name} (${b.city || "?"})`);
          continue;
        } catch (_) {
          // fall through to standard error path
        }
      }
      failed++;
      console.error(`    DB save failed for "${b.name}" (${b.city || "?"}): ${err.message}`);
    }
  }
  console.log(`   💾 Saved ${saved}/${businesses.length} to DB${failed ? ` (${failed} failed)` : ""}`);
  return saved;
}

function parseCityState(s) {
  const [city, ...rest] = s.split(',').map(x => x.trim());
  return { city, state: rest.join(', ') };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!QUERY && !ALL_CATS) {
    console.log('\nUsage:');
    console.log('  node scripts/google-maps-scraper.js --query "yoga studio" --city "Phoenix, AZ"');
    console.log('  node scripts/google-maps-scraper.js --all-categories --city "Phoenix, AZ"');
    console.log('  node scripts/google-maps-scraper.js --all-categories --cities "Phoenix,Scottsdale,Tempe"');
    console.log('  node scripts/google-maps-scraper.js --test --query "gym" --city "Phoenix, AZ"');
    process.exit(0);
  }

  await ensureSchema();

  const cityList  = CITIES ? CITIES.split(',').map(c => c.trim()) : [CITY];
  const queryList = ALL_CATS ? CATEGORIES : [QUERY];

  let totalSaved = 0;

  for (const city of cityList) {
    for (const q of queryList) {
      const biz = await scrapeWithRetry({ query: q, city, limit: LIMIT });
      totalSaved += await saveResults(biz);

      if (queryList.length > 1 || cityList.length > 1) {
        const pause = randMs(4000, 8000);
        console.log(`\n⏳ ${(pause/1000).toFixed(1)}s cooldown...`);
        await sleep(pause);
      }
    }
  }

  console.log(`\n✅ Total: ${totalSaved} leads saved`);
  await pool.end();
}

main().catch(err => { console.error('Fatal:', err); pool.end(); process.exit(1); });
