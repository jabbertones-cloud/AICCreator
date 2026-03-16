// agents/playwright-scraper-agent.js
// ─────────────────────────────────────────────────────────────────────────────
// Playwright-based web scraper agent — replaces simple HTTP GET in enrich-leads-email.js
// Handles JS-heavy sites, SPAs, anti-scrape delays, and cookie banners.
//
// Uses the playwright package already in package.json (^1.58.2).
// Chromium browser must be installed: npx playwright install chromium
//
// Registered task types:
//   SCRAPE_CONTACT_PAGE   — extract emails from a business website
//   SCRAPE_PAGE_TEXT      — extract full visible text from any URL
//   SCRAPE_LINKS          — extract all links from a page
//
// CLI usage:
//   node agents/playwright-scraper-agent.js --url https://yourdomain.com
//   node agents/playwright-scraper-agent.js --url https://yourdomain.com --mode contacts
//   node agents/playwright-scraper-agent.js --url https://yourdomain.com --mode text
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

require('dotenv').config();
const { chromium } = require('playwright');
const { register }  = require('./registry');

// ── Constants ─────────────────────────────────────────────────────────────────
const TIMEOUT_MS     = 20_000;
const NAV_TIMEOUT_MS = 30_000;

const JUNK_EMAIL_DOMAINS = new Set([
  'gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com',
  'example.org','sentry.io','sentry-next.io','w3.org','schema.org',
  'google.com','facebook.com','instagram.com','twitter.com','x.com',
  'amazon.com','cloudflare.com','jquery.com','wordpress.org',
]);

const CONTACT_PATHS = [
  '/contact', '/contact-us', '/contactus', '/about', '/about-us',
  '/reach-us', '/get-in-touch', '/info', '/support',
];

// ── Browser pool (singleton) ──────────────────────────────────────────────────
let _browser = null;
async function getBrowser() {
  if (!_browser || !_browser.isConnected()) {
    _browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-gpu-compositing',
        '--use-angle=swiftshader',
      ],
    });
  }
  return _browser;
}

async function closeBrowser() {
  if (_browser) { await _browser.close(); _browser = null; }
}

// ── Core scrape helper ────────────────────────────────────────────────────────
async function scrapePage(url, { waitFor = 'domcontentloaded' } = {}) {
  const browser = await getBrowser();
  const ctx     = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
             + 'AppleWebKit/537.36 (KHTML, like Gecko) '
             + 'Chrome/120.0.0.0 Safari/537.36',
    locale: 'en-US',
  });
  const page = await ctx.newPage();

  try {
    page.setDefaultTimeout(TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

    await page.goto(url, { waitUntil: waitFor, timeout: NAV_TIMEOUT_MS });

    // Dismiss common cookie / GDPR banners so they don't block content
    try {
      await page.click('[id*="accept"],[class*="accept"],[aria-label*="Accept"]',
                       { timeout: 2000 });
    } catch { /* no banner, no problem */ }

    // Wait a beat for any lazy-loaded content
    await page.waitForTimeout(800);

    const html = await page.content();
    const text = await page.evaluate(() => document.body?.innerText ?? '');
    const title = await page.title();
    return { url, html, text, title, ok: true };
  } catch (err) {
    return { url, html: '', text: '', title: '', ok: false, error: err.message };
  } finally {
    await ctx.close();
  }
}

// ── Email extractor ───────────────────────────────────────────────────────────
function extractEmails(html, text) {
  const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

  // 1. mailto: links (most reliable)
  const mailtoRe = /mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi;
  const mailtoEmails = [...html.matchAll(mailtoRe)].map(m => m[1].toLowerCase());

  // 2. Regex over full HTML + visible text
  const rawEmails = [
    ...(html.match(EMAIL_RE) || []),
    ...(text.match(EMAIL_RE) || []),
  ].map(e => e.toLowerCase());

  const all = [...new Set([...mailtoEmails, ...rawEmails])];

  return all.filter(email => {
    const domain = email.split('@')[1];
    if (!domain) return false;
    if (JUNK_EMAIL_DOMAINS.has(domain)) return false;
    if (/\.(png|jpg|gif|svg|css|js|woff|ttf)$/i.test(domain)) return false;
    if (email.includes('..')) return false;
    return true;
  });
}

// ── Link extractor ────────────────────────────────────────────────────────────
async function extractLinks(page, baseUrl) {
  const origin = new URL(baseUrl).origin;
  return page.evaluate((origin) => {
    return [...document.querySelectorAll('a[href]')]
      .map(a => {
        try { return new URL(a.getAttribute('href'), origin).href; } catch { return null; }
      })
      .filter(Boolean);
  }, origin);
}

// ── SCRAPE_CONTACT_PAGE handler ───────────────────────────────────────────────
async function scrapeContactPage({ url, follow_contact_links = true }) {
  if (!url) throw new Error('url is required');

  const origin = new URL(url).origin;
  const visited = new Set();
  const foundEmails = new Set();
  const results = [];

  async function visit(pageUrl) {
    if (visited.has(pageUrl) || visited.size > 6) return;
    visited.add(pageUrl);

    const { html, text, ok, error } = await scrapePage(pageUrl);
    if (!ok) {
      results.push({ url: pageUrl, ok: false, error });
      return;
    }

    const emails = extractEmails(html, text);
    emails.forEach(e => foundEmails.add(e));
    results.push({ url: pageUrl, ok: true, emails });
  }

  // Visit homepage first
  await visit(url);

  // Then try canonical contact paths
  if (follow_contact_links) {
    for (const path of CONTACT_PATHS) {
      if (foundEmails.size >= 3) break;
      await visit(origin + path);
    }
  }

  return {
    site: origin,
    emails: [...foundEmails],
    pages_checked: visited.size,
    page_results: results,
  };
}

// ── SCRAPE_PAGE_TEXT handler ──────────────────────────────────────────────────
async function scrapePageText({ url, wait_for = 'domcontentloaded' }) {
  if (!url) throw new Error('url is required');
  const { text, title, ok, error } = await scrapePage(url, { waitFor: wait_for });
  return { url, title, text: text.trim(), ok, error };
}

// ── SCRAPE_LINKS handler ──────────────────────────────────────────────────────
async function scrapeLinks({ url, internal_only = false }) {
  if (!url) throw new Error('url is required');
  const browser = await getBrowser();
  const ctx  = await browser.newContext();
  const page = await ctx.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    const origin = new URL(url).origin;
    const links  = await extractLinks(page, url);
    const filtered = internal_only
      ? links.filter(l => l.startsWith(origin))
      : links;
    return { url, links: [...new Set(filtered)], count: filtered.length };
  } finally {
    await ctx.close();
  }
}

// ── Register task handlers ────────────────────────────────────────────────────
register('SCRAPE_CONTACT_PAGE', scrapeContactPage);
register('SCRAPE_PAGE_TEXT',    scrapePageText);
register('SCRAPE_LINKS',        scrapeLinks);

// ── CLI mode ──────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : null;
  };

  const url  = getArg('--url');
  const mode = getArg('--mode') || 'contacts';

  if (!url) {
    console.error('Usage: node agents/playwright-scraper-agent.js --url <url> [--mode contacts|text|links]');
    process.exit(1);
  }

  (async () => {
    console.log(`\n🎭 Playwright Scraper — mode: ${mode}`);
    console.log(`   URL: ${url}\n`);

    try {
      let result;
      if (mode === 'contacts') result = await scrapeContactPage({ url });
      else if (mode === 'text') result = await scrapePageText({ url });
      else if (mode === 'links') result = await scrapeLinks({ url });
      else throw new Error(`Unknown mode: ${mode}`);

      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error('Error:', err.message);
      process.exitCode = 1;
    } finally {
      await closeBrowser();
    }
  })();
}

module.exports = { scrapeContactPage, scrapePageText, scrapeLinks, closeBrowser };
