#!/usr/bin/env node
"use strict";
require("dotenv").config();

/**
 * lp-gen.js
 * Landing page generator - creates responsive HTML landing pages for campaigns.
 *
 * Usage:
 *   node scripts/lp-gen.js --campaign reports/aicc-campaign-latest.json
 *   node scripts/lp-gen.js --campaign reports/aicc-campaign-latest.json --all
 *   node scripts/lp-gen.js --campaign reports/aicc-campaign-latest.json --email-hub https://api.example.com/email
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const REPORTS = path.join(ROOT, "reports");
const LP_DIR = path.join(ROOT, "media", "lp");

fs.mkdirSync(LP_DIR, { recursive: true });
fs.mkdirSync(REPORTS, { recursive: true });

/**
 * Parse command-line arguments
 */
function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  return String(process.argv[i + 1] || "").trim() || fallback;
}

function has(flag) {
  return process.argv.includes(flag);
}

/**
 * Convert text to URL-friendly slug
 */
function slugify(text) {
  if (!text) return "page";
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 50);
}

/**
 * Read JSON file with fallback
 */
function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Generate landing page content using OpenAI or fallback template
 */
async function generateLPContent(campaign, variant) {
  // Try OpenAI first if key is available
  if (process.env.OPENAI_API_KEY) {
    try {
      console.log(`[lp-gen] generating content for variant: ${variant.id}`);
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [
            {
              role: "system",
              content:
                "You are a high-converting landing page copywriter. Generate compelling LP content. Return ONLY valid JSON with: headline (80 chars max), subheadline (150 chars max), benefits array of 3 strings (50 chars each max), cta_text (20 chars max). No markdown, pure JSON.",
            },
            {
              role: "user",
              content: `Campaign: "${campaign.topic || "Product Launch"}"\nVariant: "${
                variant.title || variant.hook || "New Offer"
              }"\nDescription: "${variant.description || ""}"\n\nGenerate persuasive landing page copy.`,
            },
          ],
          temperature: 0.8,
          max_tokens: 500,
        }),
      });

      const json = await response.json();
      if (json.choices && json.choices[0] && json.choices[0].message) {
        try {
          const content = json.choices[0].message.content.trim();
          const parsed = JSON.parse(content);
          if (parsed.headline && parsed.benefits) {
            return {
              headline: String(parsed.headline || "").substring(0, 80),
              subheadline: String(parsed.subheadline || "").substring(0, 150),
              benefits: (parsed.benefits || []).map((b) => String(b).substring(0, 100)),
              cta_text: String(parsed.cta_text || "Get Access").substring(0, 30),
              cta_url: variant.affiliate_url || campaign.affiliate_url || "#",
            };
          }
        } catch (parseErr) {
          console.warn("[lp-gen] failed to parse OpenAI response, using fallback");
        }
      }
    } catch (err) {
      console.warn("[lp-gen] OpenAI generation failed, using fallback:", err.message);
    }
  }

  // Fallback template
  return {
    headline: (variant.title || variant.hook || "Unlock Your Potential").substring(0, 80),
    subheadline: (variant.description || "Discover the secret used by top creators").substring(0, 150),
    benefits: [
      "Save hours of manual work every week",
      "Proven results trusted by thousands",
      "Get instant access to exclusive content",
    ],
    cta_text: "Get Instant Access",
    cta_url: variant.affiliate_url || campaign.affiliate_url || "#",
  };
}

/**
 * Build complete HTML landing page
 */
function buildHTML(lpContent, variant, emailHubUrl) {
  const hasAffiliate = lpContent.cta_url && lpContent.cta_url !== "#";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="${lpContent.subheadline}">
  <title>${lpContent.headline}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
      background: #ffffff;
      color: #333;
      line-height: 1.6;
    }
    .container {
      max-width: 600px;
      margin: 0 auto;
      padding: 20px;
    }
    header {
      text-align: center;
      padding: 40px 0 20px;
      border-bottom: 2px solid #f0f0f0;
      margin-bottom: 40px;
    }
    .logo {
      display: inline-block;
      width: 60px;
      height: 60px;
      background: #E94560;
      border-radius: 50%;
      margin-bottom: 20px;
      opacity: 0.9;
    }
    h1 {
      font-size: 36px;
      font-weight: 700;
      color: #000;
      margin-bottom: 12px;
      line-height: 1.2;
    }
    .subheadline {
      font-size: 18px;
      color: #666;
      margin-bottom: 40px;
      font-weight: 300;
    }
    .benefits {
      margin: 40px 0;
      padding: 30px;
      background: #f9f9f9;
      border-radius: 8px;
      border-left: 4px solid #E94560;
    }
    .benefits h2 {
      font-size: 20px;
      margin-bottom: 20px;
      color: #000;
    }
    .benefit-item {
      display: flex;
      align-items: flex-start;
      margin-bottom: 16px;
    }
    .benefit-item:last-child {
      margin-bottom: 0;
    }
    .benefit-check {
      color: #E94560;
      font-weight: bold;
      margin-right: 12px;
      font-size: 20px;
    }
    .benefit-text {
      color: #555;
      font-size: 16px;
    }
    .email-form {
      background: #f0f0f0;
      padding: 30px;
      border-radius: 8px;
      margin: 40px 0;
    }
    .email-form h3 {
      font-size: 20px;
      margin-bottom: 20px;
      color: #000;
    }
    .form-group {
      margin-bottom: 12px;
    }
    .form-group:last-child {
      margin-bottom: 0;
    }
    input[type="text"],
    input[type="email"] {
      width: 100%;
      padding: 12px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 16px;
      font-family: inherit;
    }
    input[type="text"]:focus,
    input[type="email"]:focus {
      outline: none;
      border-color: #E94560;
      box-shadow: 0 0 0 3px rgba(233, 69, 96, 0.1);
    }
    .cta-button {
      display: block;
      width: 100%;
      padding: 16px;
      background: #E94560;
      color: white;
      border: none;
      border-radius: 4px;
      font-size: 18px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.3s ease;
      margin-top: 20px;
      text-decoration: none;
      text-align: center;
    }
    .cta-button:hover {
      background: #d63a50;
    }
    .cta-button:active {
      transform: scale(0.98);
    }
    footer {
      text-align: center;
      padding: 40px 0 20px;
      border-top: 2px solid #f0f0f0;
      margin-top: 40px;
      font-size: 12px;
      color: #999;
    }
    .disclosure {
      font-size: 11px;
      color: #ccc;
      margin-top: 10px;
    }
    @media (max-width: 480px) {
      h1 {
        font-size: 28px;
      }
      .subheadline {
        font-size: 16px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo"></div>
      <h1>${escapeHtml(lpContent.headline)}</h1>
      <p class="subheadline">${escapeHtml(lpContent.subheadline)}</p>
    </header>

    <div class="benefits">
      <h2>What You'll Get</h2>
      ${lpContent.benefits
        .map(
          (benefit) => `
      <div class="benefit-item">
        <span class="benefit-check">✓</span>
        <span class="benefit-text">${escapeHtml(benefit)}</span>
      </div>
      `
        )
        .join("")}
    </div>

    ${
      emailHubUrl
        ? `
    <form class="email-form" method="POST" action="${escapeHtml(emailHubUrl)}">
      <h3>Get Instant Access</h3>
      <div class="form-group">
        <input type="text" name="name" placeholder="Your Name" required>
      </div>
      <div class="form-group">
        <input type="email" name="email" placeholder="Your Email" required>
      </div>
      <button type="submit" class="cta-button">${escapeHtml(lpContent.cta_text)}</button>
    </form>
    `
        : ""
    }

    ${
      hasAffiliate
        ? `
    <a href="${escapeHtml(lpContent.cta_url)}" class="cta-button">${escapeHtml(lpContent.cta_text)}</a>
    `
        : ""
    }

    <footer>
      <p>&copy; ${new Date().getFullYear()} All rights reserved.</p>
      ${
        hasAffiliate
          ? '<p class="disclosure">#ad #sponsored - This page contains affiliate links</p>'
          : ""
      }
    </footer>
  </div>
</body>
</html>`;
}

/**
 * Escape HTML special characters for safe output
 */
function escapeHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Main entry point
 */
async function main() {
  const campaignFile = arg("--campaign", path.join(REPORTS, "aicc-campaign-latest.json"));
  const emailHubUrl = arg("--email-hub", process.env.EMAIL_HUB_URL || "");
  const processAll = has("--all");

  if (!fs.existsSync(campaignFile)) {
    console.error(`[lp-gen] error: campaign file not found: ${campaignFile}`);
    process.exit(1);
  }

  const campaign = readJson(campaignFile, null);
  if (!campaign || !Array.isArray(campaign.variants)) {
    console.error("[lp-gen] error: invalid campaign manifest (missing variants array)");
    process.exit(1);
  }

  const variantsToProcess = processAll ? campaign.variants : campaign.variants.slice(0, 1);
  const manifest = [];

  for (const variant of variantsToProcess) {
    if (!variant.id) {
      console.warn("[lp-gen] warning: variant missing id, skipping");
      continue;
    }

    console.log(`[lp-gen] generating landing page for variant: ${variant.id}`);

    // Generate LP content
    const lpContent = await generateLPContent(campaign, variant);

    // Build HTML
    const html = buildHTML(lpContent, variant, emailHubUrl);

    // Write to file
    const filename = `${slugify(variant.title || variant.id)}.html`;
    const htmlPath = path.join(LP_DIR, filename);
    fs.writeFileSync(htmlPath, html);

    console.log(`[lp-gen] wrote landing page: ${htmlPath}`);

    manifest.push({
      variant_id: variant.id,
      html_path: htmlPath,
      headline: lpContent.headline,
      url_slug: path.basename(htmlPath, ".html"),
    });
  }

  // Write manifest
  const manifestPath = path.join(REPORTS, "lp-manifest-latest.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        total: manifest.length,
        campaign_topic: campaign.topic,
        landing_pages: manifest,
      },
      null,
      2
    )
  );

  console.log(`[lp-gen] generated ${manifest.length} landing pages`);
  console.log(`[lp-gen] manifest: ${manifestPath}`);
}

main().catch((err) => {
  console.error(`[lp-gen] fatal: ${err.message}`);
  process.exit(1);
});
