#!/usr/bin/env node
"use strict";

/**
 * bot-discovery-advanced.js — Advanced bot discovery methods
 * 
 * Discovers bots/chatbots/OpenClaw setups via:
 * - GitHub (repos, forks, issues mentioning OpenClaw)
 * - Websites (scanning for chatbot widgets, contact forms)
 * - Email discovery (finding emails from bot operator websites)
 * - Bot marketplaces (Discord Bot List, Top.gg)
 * - Social media (Twitter/X hashtags, LinkedIn)
 * - API/webhook discovery (monitoring for OpenClaw instances)
 */

require("dotenv").config({ override: true });

const https = require("https");
const http = require("http");
const { saveLead } = require("./bot-lead-discovery");

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const TWITTER_BEARER_TOKEN = process.env.TWITTER_BEARER_TOKEN;

// ─── GitHub Discovery ────────────────────────────────────────────────────────────

async function discoverGitHubBots() {
  let discovered = 0;
  let usedFallback = false;

  // Try API first
  if (GITHUB_TOKEN) {
    try {
      discovered = await discoverGitHubBotsViaAPI();
    } catch (err) {
      console.warn("[discovery] GitHub: API failed, using fallback methods:", err.message);
      usedFallback = true;
    }
  } else {
    console.warn("[discovery] GitHub: GITHUB_TOKEN not set, using fallback methods");
    usedFallback = true;
  }

  // Fallback: Web scraping GitHub when API fails
  if (usedFallback || discovered === 0) {
    console.log("[discovery] GitHub: Using fallback discovery methods...");
    const fallbackCount = await discoverGitHubBotsFallback();
    discovered += fallbackCount;
  }

  return discovered;
}

async function discoverGitHubBotsViaAPI() {
  if (!GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN not set");
  }

  const keywords = ["openclaw", "clawdbot", "claw-architect", "bot commerce", "moltbook"];
  let discovered = 0;

  try {
    for (const keyword of keywords) {
      // Search repositories
      const repoUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(keyword)}+bot+OR+chatbot&sort=updated&per_page=50`;
      const repos = await githubRequest(repoUrl);

      for (const repo of repos.items || []) {
        // Check if repo owner is likely a bot operator
        const owner = repo.owner?.login?.toLowerCase() || "";
        const repoName = repo.name?.toLowerCase() || "";
        const description = (repo.description || "").toLowerCase();

        if (owner.includes("bot") || owner.includes("claw") || 
            repoName.includes("bot") || repoName.includes("claw") ||
            description.includes("bot") || description.includes("chatbot")) {
          
          await saveLead({
            platform: "github",
            botId: repo.owner.login,
            botUsername: repo.owner.login,
            botDisplayName: repo.owner.name || repo.owner.login,
            contactInfo: repo.owner.html_url,
            guildId: repo.full_name,
            guildName: repo.name,
            notes: {
              repo_url: repo.html_url,
              repo_description: repo.description,
              stars: repo.stargazers_count,
              language: repo.language,
              discovered_via: "github_repo_search",
            },
          });
          discovered++;
          console.log(`[discovery] GitHub: Found ${repo.owner.login}/${repo.name}`);
        }
      }

      // Search issues mentioning OpenClaw
      const issuesUrl = `https://api.github.com/search/issues?q=${encodeURIComponent(keyword)}+type:issue&sort=updated&per_page=30`;
      const issues = await githubRequest(issuesUrl);

      for (const issue of issues.items || []) {
        const user = issue.user?.login?.toLowerCase() || "";
        if (user.includes("bot") || user.includes("claw")) {
          await saveLead({
            platform: "github",
            botId: issue.user.login,
            botUsername: issue.user.login,
            botDisplayName: issue.user.login,
            contactInfo: issue.user.html_url,
            guildId: issue.repository_url,
            guildName: issue.repository?.full_name || "unknown",
            notes: {
              issue_url: issue.html_url,
              issue_title: issue.title,
              discovered_via: "github_issue_search",
            },
          });
          discovered++;
          console.log(`[discovery] GitHub: Found ${issue.user.login} (from issue)`);
        }
      }

      await sleep(2000); // Rate limiting
    }
  } catch (err) {
    console.error("[discovery] GitHub: Discovery failed:", err.message);
  }

  return discovered;
}

// ─── GitHub Fallback Discovery (when API fails) ──────────────────────────────────

async function discoverGitHubBotsFallback() {
  let discovered = 0;

  try {
    // Public GitHub Search API fallback (works without token, rate-limited)
    console.log("[discovery] GitHub: Using unauthenticated public API fallback...");
    const queries = [
      "openclaw bot",
      "discord bot payment stripe",
      "telegram bot checkout",
      "whatsapp bot payment",
      "ai agent commerce",
      "clawpay",
    ];
    const seen = new Set();

    for (const q of queries) {
      try {
        const repoUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=updated&per_page=30`;
        const repos = await githubRequest(repoUrl, null);
        const items = Array.isArray(repos?.items) ? repos.items : [];

        for (const repo of items) {
          const owner = String(repo?.owner?.login || "").trim();
          if (!owner) continue;
          const repoKey = `${owner}/${String(repo?.name || "").trim()}`.toLowerCase();
          if (seen.has(repoKey)) continue;
          seen.add(repoKey);

          await saveLead({
            platform: "github",
            botId: owner,
            botUsername: owner,
            botDisplayName: owner,
            contactInfo: repo?.owner?.html_url || repo?.html_url || "",
            guildId: repo?.full_name || repoKey,
            guildName: repo?.name || repoKey,
            notes: {
              repo_url: repo?.html_url || null,
              repo_description: repo?.description || null,
              stars: Number(repo?.stargazers_count || 0),
              language: repo?.language || null,
              discovered_via: "github_public_api_search",
              query: q,
            },
          });
          discovered++;
        }
      } catch (err) {
        console.warn(`[discovery] GitHub: Public fallback failed for "${q}":`, err.message);
      }

      // Keep below unauthenticated GitHub API burst limits.
      await sleep(1200);
    }
  } catch (err) {
    console.error("[discovery] GitHub: Fallback discovery failed:", err.message);
  }

  return discovered;
}

async function githubRequest(url, tokenOverride = GITHUB_TOKEN) {
  return new Promise((resolve, reject) => {
    const headers = {
      "User-Agent": "OpenClawBot/1.0",
      "Accept": "application/vnd.github.v3+json",
    };
    if (tokenOverride) {
      headers.Authorization = `token ${tokenOverride}`;
    }

    const options = {
      headers,
    };

    https.get(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode && res.statusCode >= 400) {
            const msg = parsed?.message || `HTTP ${res.statusCode}`;
            reject(new Error(msg));
            return;
          }
          resolve(parsed);
        } catch {
          reject(new Error("Invalid JSON response"));
        }
      });
    }).on("error", reject);
  });
}

// ─── Website/Email Discovery ────────────────────────────────────────────────────

async function discoverWebsiteBots() {
  // Get leads from database that have websites
  // Scan their websites for chatbot mentions, contact forms, or bot-related content
  
  console.log("[discovery] Website: Scanning websites for bot mentions...");
  console.log("[discovery] Website: This requires leads with websites in database");
  console.log("[discovery] Website: Use email-finder.js or lead generation first");
  
  // integrate with existing lead system to scan websites
  // For now, this is a placeholder that can be expanded
  
  return 0;
}

async function discoverEmailBots() {
  // Use existing email-finder.js to find emails from bot operator websites
  // Then check if those emails are associated with bots
  
  console.log("[discovery] Email: Finding emails from bot operator websites...");
  console.log("[discovery] Email: This requires leads with websites in database");
  console.log("[discovery] Email: Steps:");
  console.log("[discovery]   1. Generate leads: node scripts/google-maps-scraper.js");
  console.log("[discovery]   2. Find emails: node scripts/email-finder.js");
  console.log("[discovery]   3. Filter for bot-related keywords in business names");
  
  // Query database for leads with emails that mention bots
  // This would require database access to the leads table
  // For now, this is a placeholder
  
  // query leads table for:
  // - business_name contains: bot, chatbot, AI, automation, claw
  // - email is not null
  // - Save as bot leads with platform="email"
  
  return 0;
}

// ─── Bot Marketplace Discovery ───────────────────────────────────────────────────

async function discoverMarketplaceBots() {
  let discovered = 0;

  // Discord Bot List (top.gg alternative)
  try {
    // Note: Most bot marketplaces require API keys or don't have public search APIs
    // This is a placeholder for when APIs become available
    console.log("[discovery] Marketplace: Bot marketplaces require API access");
    console.log("[discovery] Marketplace: Consider manual discovery on:");
    console.log("[discovery]   - top.gg (Discord bots)");
    console.log("[discovery]   - discord.bots.gg");
    console.log("[discovery]   - botlist.space");
  } catch (err) {
    console.error("[discovery] Marketplace: Discovery failed:", err.message);
  }

  return discovered;
}

// ─── Social Media Discovery ──────────────────────────────────────────────────────

async function discoverTwitterBots() {
  let discovered = 0;
  let usedFallback = false;

  // Try API first
  if (TWITTER_BEARER_TOKEN) {
    try {
      discovered = await discoverTwitterBotsViaAPI();
    } catch (err) {
      console.warn("[discovery] Twitter: API failed, using fallback methods:", err.message);
      usedFallback = true;
    }
  } else {
    console.warn("[discovery] Twitter: TWITTER_BEARER_TOKEN not set, using fallback methods");
    usedFallback = true;
  }

  // Fallback: Web scraping Twitter when API fails
  if (usedFallback || discovered === 0) {
    console.log("[discovery] Twitter: Using fallback discovery methods...");
    const fallbackCount = await discoverTwitterBotsFallback();
    discovered += fallbackCount;
  }

  return discovered;
}

async function discoverTwitterBotsViaAPI() {
  if (!TWITTER_BEARER_TOKEN) {
    throw new Error("TWITTER_BEARER_TOKEN not set");
  }

  const hashtags = ["#openclaw", "#clawdbot", "#botcommerce", "#aibot", "#moltbook"];
  let discovered = 0;

  try {
    for (const hashtag of hashtags) {
      const url = `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(hashtag)}&max_results=50`;
      const response = await twitterRequest(url);

      for (const tweet of response.data || []) {
        const author = tweet.author_id;
        const username = tweet.author_id; // Would need user lookup for username

        // Check if author mentions bots or OpenClaw
        const text = (tweet.text || "").toLowerCase();
        if (text.includes("bot") || text.includes("openclaw") || text.includes("claw")) {
          await saveLead({
            platform: "twitter",
            botId: author,
            botUsername: author,
            botDisplayName: author,
            contactInfo: `https://twitter.com/${author}`,
            guildId: null,
            guildName: null,
            notes: {
              tweet_id: tweet.id,
              tweet_text: tweet.text,
              discovered_via: "twitter_hashtag_search",
            },
          });
          discovered++;
          console.log(`[discovery] Twitter: Found ${author} (${hashtag})`);
        }
      }

      await sleep(2000); // Rate limiting
    }
  } catch (err) {
    console.error("[discovery] Twitter: Discovery failed:", err.message);
  }

  return discovered;
}

// ─── Twitter Fallback Discovery (when API fails) ─────────────────────────────────

async function discoverTwitterBotsFallback() {
  let discovered = 0;

  try {
    // Fallback: Web scraping Twitter when API is unavailable
    console.log("[discovery] Twitter: Scraping Twitter/X for bots...");
    
    const hashtags = ["#openclaw", "#clawdbot", "#botcommerce", "#aibot", "#moltbook"];
    
    for (const hashtag of hashtags) {
      try {
        // Web scraping Twitter search results
        // Placeholder - would implement actual scraping
        console.log(`[discovery] Twitter: Would scrape search results for "${hashtag}"`);
        // discovered += await scrapeTwitterSearch(hashtag);
      } catch (err) {
        console.warn(`[discovery] Twitter: Fallback search failed for "${hashtag}":`, err.message);
      }
    }

  } catch (err) {
    console.error("[discovery] Twitter: Fallback discovery failed:", err.message);
  }

  return discovered;
}

async function twitterRequest(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        "Authorization": `Bearer ${TWITTER_BEARER_TOKEN}`,
        "User-Agent": "OpenClawBot/1.0",
      },
    };

    https.get(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error("Invalid JSON response"));
        }
      });
    }).on("error", reject);
  });
}

// ─── API/Webhook Discovery ───────────────────────────────────────────────────────

async function discoverAPIBots() {
  // Monitor webhook endpoints or API logs for incoming requests from OpenClaw instances
  // This would require access to your own API logs or webhook monitoring
  
  console.log("[discovery] API: Monitor webhook logs for OpenClaw user-agent strings");
  console.log("[discovery] API: Check API access logs for bot-related patterns");
  console.log("[discovery] API: Requires access to server logs or monitoring system");
  
  // integrate with API monitoring/logging system
  // Look for User-Agent strings containing "OpenClaw", "claw", "bot"
  
  return 0;
}

// ─── Main Discovery Function ─────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const method = args[0] || "all";

  console.log("=".repeat(60));
  console.log("Advanced Bot Discovery");
  console.log("=".repeat(60));
  console.log(`Method: ${method}\n`);

  let total = 0;

  if (method === "all" || method === "github") {
    try {
      console.log("🔍 Discovering GitHub bots...");
      const count = await discoverGitHubBots();
      console.log(`✅ GitHub: Discovered ${count} bot(s)\n`);
      total += count;
    } catch (err) {
      console.error(`❌ GitHub error:`, err.message);
    }
  }

  if (method === "all" || method === "website") {
    try {
      console.log("🔍 Discovering website bots...");
      const count = await discoverWebsiteBots();
      console.log(`✅ Website: Discovered ${count} bot(s)\n`);
      total += count;
    } catch (err) {
      console.error(`❌ Website error:`, err.message);
    }
  }

  if (method === "all" || method === "email") {
    try {
      console.log("🔍 Discovering email bots...");
      const count = await discoverEmailBots();
      console.log(`✅ Email: Discovered ${count} bot(s)\n`);
      total += count;
    } catch (err) {
      console.error(`❌ Email error:`, err.message);
    }
  }

  if (method === "all" || method === "marketplace") {
    try {
      console.log("🔍 Discovering marketplace bots...");
      const count = await discoverMarketplaceBots();
      console.log(`✅ Marketplace: Discovered ${count} bot(s)\n`);
      total += count;
    } catch (err) {
      console.error(`❌ Marketplace error:`, err.message);
    }
  }

  if (method === "all" || method === "twitter") {
    try {
      console.log("🔍 Discovering Twitter bots...");
      const count = await discoverTwitterBots();
      console.log(`✅ Twitter: Discovered ${count} bot(s)\n`);
      total += count;
    } catch (err) {
      console.error(`❌ Twitter error:`, err.message);
    }
  }

  if (method === "all" || method === "api") {
    try {
      console.log("🔍 Discovering API bots...");
      const count = await discoverAPIBots();
      console.log(`✅ API: Discovered ${count} bot(s)\n`);
      total += count;
    } catch (err) {
      console.error(`❌ API error:`, err.message);
    }
  }

  console.log("=".repeat(60));
  console.log(`Total discovered: ${total}`);
  console.log("=".repeat(60));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err.message);
    process.exit(1);
  });
}

module.exports = {
  discoverGitHubBots,
  discoverWebsiteBots,
  discoverEmailBots,
  discoverMarketplaceBots,
  discoverTwitterBots,
  discoverAPIBots,
};
