"use strict";
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const https = require("https");

// Configuration
const ROOT = path.join(__dirname, "..");
const REPORTS = path.join(ROOT, "reports");

/**
 * Parse CLI argument by flag name
 * @param {string} flag - Flag name (e.g., "campaign")
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
 * @param {string} flag - Flag name (e.g., "verbose")
 * @returns {boolean} True if flag is present
 */
function has(flag) {
  return process.argv.includes(`--${flag}`);
}

/**
 * Call LLM API (internal or OpenAI fallback) to generate content
 * @param {string} systemPrompt - System role/instruction
 * @param {string} userPrompt - User query/content to process
 * @returns {promise<string>} Generated text response
 */
async function callLLM(systemPrompt, userPrompt) {
  const apiBase = process.env.AICC_API_BASE || "http://localhost:3000";
  const hasOpenAI = !!process.env.OPENAI_API_KEY;

  // Try internal API first
  if (apiBase && apiBase !== "http://localhost:3000") {
    try {
      return await new Promise((resolve, reject) => {
        const postData = JSON.stringify({
          system: systemPrompt,
          user: userPrompt
        });

        const options = {
          hostname: new URL(apiBase).hostname,
          port: new URL(apiBase).port || 80,
          path: "/api/content/copywriter",
          method: "POST",
          headers: {
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
              resolve(response.text || response.content || "");
            } catch (e) {
              reject(new Error("Failed to parse LLM response"));
            }
          });
        });

        req.on("error", reject);
        req.write(postData);
        req.end();
      });
    } catch (e) {
      if (has("verbose")) console.warn("[callLLM] Internal API failed, trying OpenAI...");
    }
  }

  // Fallback to OpenAI
  if (hasOpenAI) {
    return await new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.7,
        max_tokens: 1000
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
  }

  throw new Error("No LLM API configured. Set AICC_API_BASE or OPENAI_API_KEY");
}

/**
 * Repurpose a campaign variant into multiple platform-specific formats
 * @param {object} variant - Campaign variant with title, hook, hashtags
 * @param {object} clipEntry - Clip manifest entry with mp4_path
 * @returns {promise<object>} Repurposed content object
 */
async function repurposeVariant(variant, clipEntry) {
  const variant_id = variant.id;
  console.log(`[repurposeVariant] Processing: ${variant_id}`);

  try {
    const title = variant.title || variant.id;
    const hook = variant.hook || "";
    const hashtags = (variant.hashtags || []).join(" ");

    // Generate Reel caption
    console.log(`  [repurposeVariant] Generating Reel caption...`);
    const reelCaption = await callLLM(
      "You are a social media expert. Write a short, engaging Instagram Reel caption.",
      `Title: ${title}\nHook: ${hook}\nHashtags: ${hashtags}\n\nWrite a caption under 150 characters that captures attention and includes relevant hashtags.`
    );

    // Generate YouTube description
    console.log(`  [repurposeVariant] Generating YouTube description...`);
    const youtubeDescription = await callLLM(
      "You are a YouTube content strategist. Write compelling video descriptions with CTAs.",
      `Title: ${title}\nHook: ${hook}\n\nWrite a YouTube description (max 500 chars) with a strong call-to-action for affiliate link/product.`
    );

    // Generate email copy
    console.log(`  [repurposeVariant] Generating email copy...`);
    const emailCopy = await callLLM(
      "You are an email marketing copywriter. Write persuasive email campaigns.",
      `Title: ${title}\nHook: ${hook}\n\nWrite an email (200 words) with subject line, teaser, body, and [LINK] placeholder for CTA.`
    );

    // Generate tweet
    console.log(`  [repurposeVariant] Generating tweet...`);
    const tweet = await callLLM(
      "You are a Twitter marketing expert. Write concise, shareable tweets.",
      `Hook: ${hook}\n\nWrite a 280-character tweet that captures the essence and drives engagement. ${hashtags}`
    );

    // Build LP snippet (HTML)
    const htmlSnippet = `<div style="padding: 20px; background: #f5f5f5; border-radius: 8px;">
  <h1 style="font-size: 24px; margin-bottom: 16px;">${title}</h1>
  <p style="font-size: 16px; line-height: 1.6; margin-bottom: 20px;">${hook}</p>
  <a href="#" style="display: inline-block; padding: 12px 24px; background: #007bff; color: white; text-decoration: none; border-radius: 4px; font-weight: bold;">Learn More</a>
</div>`;

    return {
      variant_id,
      reel_caption: reelCaption.trim(),
      youtube_description: youtubeDescription.trim(),
      email_copy: emailCopy.trim(),
      tweet: tweet.trim(),
      lp_snippet: htmlSnippet,
      video_path: clipEntry?.mp4_path || null,
      generated_at: new Date().toISOString()
    };
  } catch (error) {
    console.error(`[repurposeVariant] Error processing ${variant_id}:`, error.message);
    return {
      variant_id,
      error: error.message,
      reel_caption: null,
      youtube_description: null,
      email_copy: null,
      tweet: null,
      lp_snippet: null,
      video_path: clipEntry?.mp4_path || null
    };
  }
}

/**
 * Main entry point
 * Loads campaign and clip manifest, repurposes each variant
 */
async function main() {
  console.log("[content-repurpose] Starting content repurposing pipeline...");

  // Load campaign
  const campaignPath = arg("campaign", path.join(REPORTS, "aicc-campaign-latest.json"));
  if (!fs.existsSync(campaignPath)) {
    console.error(`[content-repurpose] Campaign file not found: ${campaignPath}`);
    process.exit(1);
  }
  const campaign = JSON.parse(fs.readFileSync(campaignPath, "utf8"));
  console.log(`[content-repurpose] Loaded campaign with ${campaign.variants.length} variants`);

  // Load clip manifest
  const clipManifestPath = path.join(REPORTS, "clip-manifest-latest.json");
  let clipManifest = [];
  if (fs.existsSync(clipManifestPath)) {
    try {
      clipManifest = JSON.parse(fs.readFileSync(clipManifestPath, "utf8"));
      console.log(`[content-repurpose] Loaded clip manifest with ${clipManifest.length} entries`);
    } catch (e) {
      console.warn(`[content-repurpose] Failed to parse clip manifest: ${e.message}`);
    }
  } else {
    console.warn("[content-repurpose] Clip manifest not found, proceeding without video paths");
  }

  // Index clip entries by variant_id for easy lookup
  const clipsByVariant = {};
  clipManifest.forEach(entry => {
    if (entry.variant_id) {
      clipsByVariant[entry.variant_id] = entry;
    }
  });

  // Repurpose each variant
  const repurposedVariants = [];
  for (const variant of campaign.variants) {
    const clipEntry = clipsByVariant[variant.id];
    const repurposed = await repurposeVariant(variant, clipEntry);
    repurposedVariants.push(repurposed);

    // Add delay between API calls to avoid rate limiting
    if (repurposedVariants.length < campaign.variants.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  // Write repurpose manifest
  const repurposeManifestPath = path.join(REPORTS, "content-repurpose-latest.json");
  fs.writeFileSync(repurposeManifestPath, JSON.stringify(repurposedVariants, null, 2));
  console.log(`[content-repurpose] Wrote repurpose manifest to ${repurposeManifestPath}`);

  // Summary
  const successCount = repurposedVariants.filter(r => !r.error).length;
  console.log(`[content-repurpose] Completed: ${successCount}/${repurposedVariants.length} variants repurposed successfully`);

  if (successCount < repurposedVariants.length) {
    console.warn(`[content-repurpose] ${repurposedVariants.length - successCount} variants had errors`);
  }
}

// Execute main with error handling
main().catch(error => {
  console.error("[content-repurpose] Fatal error:", error);
  process.exit(1);
});
