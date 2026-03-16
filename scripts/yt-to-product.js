"use strict";
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync } = require("child_process");

// Configuration
const ROOT = path.join(__dirname, "..");
const REPORTS = path.join(ROOT, "reports");

/**
 * Parse CLI argument by flag name
 * @param {string} flag - Flag name (e.g., "transcript")
 * @param {string} fallback - Default value if flag not provided
 * @returns {string} Argument value or fallback
 */
function arg(flag, fallback) {
  const index = process.argv.indexOf(`--${flag}`);
  if (index > -1 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

/**
 * Check if a flag is present in CLI arguments
 * @param {string} flag - Flag name (e.g., "ebook")
 * @returns {boolean} True if flag is present
 */
function has(flag) {
  return process.argv.includes(`--${flag}`);
}

/**
 * Create URL slug from text
 * @param {string} text - Input text
 * @returns {string} Slugified version
 */
function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .substring(0, 50);
}

/**
 * Summarize YouTube transcript into structured markdown guide
 * Uses OpenAI API if available, otherwise returns raw transcript excerpt
 * @param {string} transcriptText - Full transcript text
 * @param {string} topic - Topic name or title
 * @returns {promise<string>} Markdown-formatted guide
 */
async function summarizeTranscript(transcriptText, topic) {
  const truncatedText = transcriptText.substring(0, 8000);

  // If OpenAI API key is available, use it
  if (process.env.OPENAI_API_KEY) {
    try {
      console.log("[summarizeTranscript] Calling OpenAI API...");
      return await new Promise((resolve, reject) => {
        const postData = JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: "You are a content strategist. Convert this YouTube transcript into a structured PDF guide with the following sections: Overview, Key Takeaways (5 bullets), Step-by-Step Guide, Affiliate Resources, Call to Action. Format as markdown."
            },
            {
              role: "user",
              content: truncatedText
            }
          ],
          temperature: 0.7,
          max_tokens: 2000
        });

        const options = {
          hostname: "api.openai.com",
          port: 443,
          path: "/v1/chat/completions",
          method: "POST",
          headers: {
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(postData)
          }
        };

        const req = https.request(options, (res) => {
          let data = "";
          res.on("data", chunk => { data += chunk; });
          res.on("end", () => {
            try {
              const response = JSON.parse(data);
              if (response.choices && response.choices[0]) {
                resolve(response.choices[0].message.content);
              } else {
                reject(new Error("Invalid OpenAI response"));
              }
            } catch (e) {
              reject(e);
            }
          });
        });

        req.on("error", reject);
        req.write(postData);
        req.end();
      });
    } catch (error) {
      console.warn("[summarizeTranscript] OpenAI API failed:", error.message);
      console.log("[summarizeTranscript] Falling back to raw transcript");
    }
  }

  // Fallback: return structured markdown with transcript excerpt
  return `# ${topic}

## Overview
${truncatedText.substring(0, 500)}...

## Key Takeaways
- [To be completed from video]
- [To be completed from video]
- [To be completed from video]
- [To be completed from video]
- [To be completed from video]

## Step-by-Step Guide
${truncatedText.substring(500, 1500)}

## Affiliate Resources
- Resource 1
- Resource 2
- Resource 3

## Call to Action
For more detailed guidance on ${topic}, download this complete guide.
`;
}

/**
 * Render markdown content to PDF or markdown file
 * Uses wkhtmltopdf if available, otherwise creates markdown file
 * @param {string} markdownContent - Markdown-formatted content
 * @param {string} outputPath - Path for output PDF/MD file
 * @returns {promise<object>} Result with ok status and path
 */
async function renderPdf(markdownContent, outputPath) {
  try {
    // Check if wkhtmltopdf is available
    let hasWkhtmltopdf = false;
    try {
      execSync("which wkhtmltopdf", { stdio: "pipe" });
      hasWkhtmltopdf = true;
    } catch (e) {
      console.warn("[renderPdf] wkhtmltopdf not found, using markdown output");
    }

    if (hasWkhtmltopdf) {
      // Convert markdown to HTML
      const htmlContent = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body {
      font-family: Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 800px;
      margin: 0;
      padding: 1in;
      background: white;
    }
    h1 {
      font-size: 32px;
      margin-bottom: 20px;
      color: #222;
    }
    h2 {
      font-size: 24px;
      margin-top: 30px;
      margin-bottom: 15px;
      color: #444;
      border-bottom: 2px solid #007bff;
      padding-bottom: 10px;
    }
    h3 {
      font-size: 18px;
      margin-top: 20px;
      margin-bottom: 10px;
      color: #666;
    }
    p {
      margin-bottom: 12px;
      text-align: justify;
    }
    ul, ol {
      margin-bottom: 12px;
      margin-left: 20px;
    }
    li {
      margin-bottom: 8px;
    }
    a {
      color: #007bff;
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
${markdownContent}
</body>
</html>`;

      // Write temporary HTML file
      const tempHtmlPath = outputPath.replace(/\.pdf$/, ".temp.html");
      fs.writeFileSync(tempHtmlPath, htmlContent);

      // Convert HTML to PDF using wkhtmltopdf
      try {
        execSync(`wkhtmltopdf "${tempHtmlPath}" "${outputPath}"`, { stdio: "pipe" });
        fs.unlinkSync(tempHtmlPath); // Clean up temp file
        console.log(`[renderPdf] PDF generated: ${outputPath}`);
        return { ok: true, path: outputPath };
      } catch (e) {
        console.error("[renderPdf] wkhtmltopdf conversion failed:", e.message);
        fs.unlinkSync(tempHtmlPath);
        throw e;
      }
    } else {
      // Fallback to markdown file
      const mdPath = outputPath.replace(/\.pdf$/, ".md");
      fs.writeFileSync(mdPath, markdownContent);
      console.log(`[renderPdf] Markdown file generated (PDF generation requires wkhtmltopdf): ${mdPath}`);
      return { ok: true, path: mdPath, note: "PDF generation requires wkhtmltopdf" };
    }
  } catch (error) {
    console.error("[renderPdf] Error:", error.message);
    return { ok: false, error: error.message };
  }
}

/**
 * Create a Stripe product and price for the PDF guide
 * @param {string} title - Product title
 * @param {string} pdfPath - Path to PDF file
 * @param {number} price - Price in cents (default 700 = $7.00)
 * @returns {promise<object>} Stripe product info or error
 */
async function createStripeProduct(title, pdfPath, price = 700) {
  if (!process.env.STRIPE_SECRET_KEY) {
    console.warn("[createStripeProduct] STRIPE_SECRET_KEY not set, skipping product creation");
    return { ok: false, error: "STRIPE_SECRET_KEY not set" };
  }

  try {
    console.log("[createStripeProduct] Creating Stripe product...");

    // Step 1: Create product
    const productData = new URLSearchParams();
    productData.append("name", title);
    productData.append("description", `Digital guide: ${title}`);
    productData.append("type", "service");

    const productResult = await new Promise((resolve, reject) => {
      const options = {
        hostname: "api.stripe.com",
        port: 443,
        path: "/v1/products",
        method: "POST",
        auth: `${process.env.STRIPE_SECRET_KEY}:`,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(productData.toString())
        }
      };

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", chunk => { data += chunk; });
        res.on("end", () => {
          try {
            const response = JSON.parse(data);
            if (response.id) {
              resolve(response);
            } else {
              reject(new Error(response.error?.message || "Failed to create product"));
            }
          } catch (e) {
            reject(e);
          }
        });
      });

      req.on("error", reject);
      req.write(productData.toString());
      req.end();
    });

    const productId = productResult.id;
    console.log(`[createStripeProduct] Product created: ${productId}`);

    // Step 2: Create price
    const priceData = new URLSearchParams();
    priceData.append("product", productId);
    priceData.append("unit_amount", price.toString());
    priceData.append("currency", "usd");

    const priceResult = await new Promise((resolve, reject) => {
      const options = {
        hostname: "api.stripe.com",
        port: 443,
        path: "/v1/prices",
        method: "POST",
        auth: `${process.env.STRIPE_SECRET_KEY}:`,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(priceData.toString())
        }
      };

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", chunk => { data += chunk; });
        res.on("end", () => {
          try {
            const response = JSON.parse(data);
            if (response.id) {
              resolve(response);
            } else {
              reject(new Error(response.error?.message || "Failed to create price"));
            }
          } catch (e) {
            reject(e);
          }
        });
      });

      req.on("error", reject);
      req.write(priceData.toString());
      req.end();
    });

    const priceId = priceResult.id;
    console.log(`[createStripeProduct] Price created: ${priceId}`);

    return {
      ok: true,
      product_id: productId,
      price_id: priceId,
      payment_link_base: `https://buy.stripe.com/test/...`,
      amount_usd: (price / 100).toFixed(2)
    };
  } catch (error) {
    console.error("[createStripeProduct] Error:", error.message);
    return { ok: false, error: error.message };
  }
}

/**
 * Main entry point
 * Loads transcript or uses topic, summarizes, renders PDF, creates Stripe product
 */
async function main() {
  console.log("[yt-to-product] Starting YouTube-to-product pipeline...");

  // Parse arguments
  const transcriptPath = arg("transcript", path.join(REPORTS, "youtube-transcript-visual-index-latest.json"));
  const topic = arg("topic", "Digital Marketing Guide");
  const price = parseInt(arg("price", "700"));
  const ebookMode = has("ebook");

  console.log(`[yt-to-product] Topic: ${topic}`);
  console.log(`[yt-to-product] Price: $${(price / 100).toFixed(2)}`);
  console.log(`[yt-to-product] Ebook mode: ${ebookMode}`);

  let transcriptText = "";

  // Load transcript or use topic for ebook mode
  if (ebookMode) {
    console.log("[yt-to-product] Using ebook mode (topic-only)");
    transcriptText = `Create a comprehensive guide about: ${topic}`;
  } else {
    if (fs.existsSync(transcriptPath)) {
      try {
        const transcriptData = JSON.parse(fs.readFileSync(transcriptPath, "utf8"));

        // Extract text from transcript
        if (transcriptData.segments && Array.isArray(transcriptData.segments)) {
          // Standard format: array of segments with text field
          transcriptText = transcriptData.segments
            .map(seg => seg.text || "")
            .join(" ");
        } else if (typeof transcriptData === "string") {
          // Plain string format
          transcriptText = transcriptData;
        } else if (transcriptData.content) {
          // Alternative: content field
          transcriptText = transcriptData.content;
        } else {
          // Fallback: convert to string
          transcriptText = JSON.stringify(transcriptData);
        }

        console.log(`[yt-to-product] Loaded transcript (${transcriptText.length} chars)`);
      } catch (e) {
        console.error(`[yt-to-product] Failed to parse transcript: ${e.message}`);
        process.exit(1);
      }
    } else {
      console.error(`[yt-to-product] Transcript file not found: ${transcriptPath}`);
      process.exit(1);
    }
  }

  // Summarize transcript
  console.log("[yt-to-product] Summarizing content...");
  const markdownContent = await summarizeTranscript(transcriptText, topic);

  // Render PDF
  const slug = slugify(topic);
  const pdfPath = path.join(REPORTS, `product-${slug}-guide.pdf`);
  console.log(`[yt-to-product] Rendering PDF to ${pdfPath}...`);
  const renderResult = await renderPdf(markdownContent, pdfPath);

  if (!renderResult.ok) {
    console.error("[yt-to-product] PDF rendering failed:", renderResult.error);
    process.exit(1);
  }

  // Create Stripe product
  console.log("[yt-to-product] Creating Stripe product...");
  const stripeResult = await createStripeProduct(topic, renderResult.path, price);

  // Write product manifest
  const productManifest = {
    topic,
    slug,
    pdf_path: renderResult.path,
    stripe_product_id: stripeResult.ok ? stripeResult.product_id : null,
    stripe_price_id: stripeResult.ok ? stripeResult.price_id : null,
    amount_usd: (price / 100).toFixed(2),
    created_at: new Date().toISOString(),
    stripe_error: stripeResult.ok ? null : stripeResult.error
  };

  const productManifestPath = path.join(REPORTS, "product-latest.json");
  fs.writeFileSync(productManifestPath, JSON.stringify(productManifest, null, 2));
  console.log(`[yt-to-product] Wrote product manifest to ${productManifestPath}`);

  // Summary
  console.log("\n[yt-to-product] Pipeline completed:");
  console.log(`  - Topic: ${topic}`);
  console.log(`  - PDF: ${renderResult.path}`);
  if (stripeResult.ok) {
    console.log(`  - Stripe Product ID: ${stripeResult.product_id}`);
    console.log(`  - Stripe Price ID: ${stripeResult.price_id}`);
    console.log(`  - Price: $${(price / 100).toFixed(2)}`);
  } else {
    console.warn(`  - Stripe creation failed: ${stripeResult.error}`);
  }
}

// Execute main with error handling
main().catch(error => {
  console.error("[yt-to-product] Fatal error:", error);
  process.exit(1);
});
