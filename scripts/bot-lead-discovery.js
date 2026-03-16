#!/usr/bin/env node
"use strict";

/**
 * bot-lead-discovery.js — Discovers bot leads on Discord, Telegram, WhatsApp
 * 
 * Finds bots to contact and stores them in a leads database for outreach
 */

require("dotenv").config({ override: true });

const fsp = require("fs/promises");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { Client, GatewayIntentBits } = require("discord.js");
const https = require("https");
const { Pool } = require("pg");

const ROOT = path.join(__dirname, "..");
const LEADS_DIR = path.join(ROOT, "agent-state", "commerce", "leads");
const LEADS_FILE = path.join(LEADS_DIR, "bot-leads.json");
const REPO_DISCOVERY_ROOTS = (process.env.BOT_DISCOVERY_REPO_ROOTS || "$HOME/claw-repos")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);

// Database connection (optional - falls back to file storage)
let pool = null;
let useDatabase = false;

try {
  pool = new Pool({
    host: process.env.POSTGRES_HOST || process.env.CLAW_DB_HOST,
    port: parseInt(process.env.POSTGRES_PORT || process.env.CLAW_DB_PORT || "15432", 10),
    user: process.env.POSTGRES_USER || process.env.CLAW_DB_USER || "claw",
    password: process.env.POSTGRES_PASSWORD || process.env.CLAW_DB_PASSWORD,
    database: process.env.POSTGRES_DB || process.env.CLAW_DB_NAME || "claw_architect",
    connectionTimeoutMillis: 3000, // Fast timeout for connection check
  });
  useDatabase = true;
  console.log("[discovery] Using database for lead storage");
} catch (err) {
  console.warn("[discovery] Database not available, using file storage:", err.message);
  useDatabase = false;
}

// ─── Lead Storage (Database or File-based) ────────────────────────────────────

async function testDatabaseConnection() {
  if (!pool || !useDatabase) return false;
  try {
    await pool.query("SELECT 1");
    return true;
  } catch (err) {
    console.warn("[discovery] Database connection failed, using file storage:", err.message);
    useDatabase = false;
    return false;
  }
}

// File-based storage (fallback)
async function loadLeadsFile() {
  try {
    const data = await fsp.readFile(LEADS_FILE, "utf8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function saveLeadsFile(leads) {
  await fsp.mkdir(LEADS_DIR, { recursive: true });
  await fsp.writeFile(LEADS_FILE, JSON.stringify(leads, null, 2));
}

async function ensureLeadsTable() {
  if (!useDatabase) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bot_leads (
        id SERIAL PRIMARY KEY,
        platform TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        bot_username TEXT,
        bot_display_name TEXT,
        contact_info TEXT,
        guild_id TEXT,
        guild_name TEXT,
        discovered_at TIMESTAMP DEFAULT NOW(),
        contacted_at TIMESTAMP,
        responded_at TIMESTAMP,
        status TEXT DEFAULT 'discovered',
        opt_out BOOLEAN DEFAULT FALSE,
        notes JSONB,
        UNIQUE(platform, bot_id)
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_bot_leads_status ON bot_leads(status);
      CREATE INDEX IF NOT EXISTS idx_bot_leads_platform ON bot_leads(platform);
    `);
  } catch (err) {
    console.warn("[discovery] Failed to create table, using file storage:", err.message);
    useDatabase = false;
  }
}

async function saveLead(lead) {
  const { platform, botId, botUsername, botDisplayName, contactInfo, guildId, guildName, notes } = lead;
  const key = `${platform}_${botId}`;
  
  if (useDatabase && await testDatabaseConnection()) {
    try {
      await ensureLeadsTable();
      await pool.query(
        `INSERT INTO bot_leads (platform, bot_id, bot_username, bot_display_name, contact_info, guild_id, guild_name, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (platform, bot_id) DO UPDATE
         SET bot_username = EXCLUDED.bot_username,
             bot_display_name = EXCLUDED.bot_display_name,
             contact_info = EXCLUDED.contact_info,
             guild_id = EXCLUDED.guild_id,
             guild_name = EXCLUDED.guild_name,
             notes = EXCLUDED.notes`,
        [platform, botId, botUsername, botDisplayName, contactInfo, guildId, guildName, JSON.stringify(notes || {})]
      );
      return;
    } catch (err) {
      console.warn("[discovery] Database save failed, using file storage:", err.message);
      useDatabase = false;
    }
  }
  
  // File-based fallback
  const leads = await loadLeadsFile();
  leads[key] = {
    platform,
    bot_id: botId,
    bot_username: botUsername,
    bot_display_name: botDisplayName,
    contact_info: contactInfo,
    guild_id: guildId,
    guild_name: guildName,
    discovered_at: new Date().toISOString(),
    contacted_at: null,
    responded_at: null,
    status: "discovered",
    opt_out: false,
    notes: notes || {},
  };
  await saveLeadsFile(leads);
}

async function getUncontactedLeads(platform, limit = 50) {
  if (useDatabase && await testDatabaseConnection()) {
    try {
      await ensureLeadsTable();
      const { rows } = await pool.query(
        `SELECT * FROM bot_leads
         WHERE platform = $1
           AND status = 'discovered'
           AND contacted_at IS NULL
           AND opt_out = FALSE
         ORDER BY discovered_at ASC
         LIMIT $2`,
        [platform, limit]
      );
      return rows;
    } catch (err) {
      console.warn("[discovery] Database query failed, using file storage:", err.message);
      useDatabase = false;
    }
  }
  
  // File-based fallback
  const leads = await loadLeadsFile();
  const platformLeads = Object.values(leads)
    .filter(lead => 
      lead.platform === platform &&
      lead.status === "discovered" &&
      !lead.contacted_at &&
      !lead.opt_out
    )
    .sort((a, b) => new Date(a.discovered_at) - new Date(b.discovered_at))
    .slice(0, limit);
  return platformLeads;
}

async function markContacted(platform, botId) {
  if (useDatabase && await testDatabaseConnection()) {
    try {
      await pool.query(
        `UPDATE bot_leads SET contacted_at = NOW(), status = 'contacted' WHERE platform = $1 AND bot_id = $2`,
        [platform, botId]
      );
      return;
    } catch (err) {
      console.warn("[discovery] Database update failed, using file storage:", err.message);
      useDatabase = false;
    }
  }
  
  // File-based fallback
  const leads = await loadLeadsFile();
  const key = `${platform}_${botId}`;
  if (leads[key]) {
    leads[key].contacted_at = new Date().toISOString();
    leads[key].status = "contacted";
    await saveLeadsFile(leads);
  }
}

async function markOptOut(platform, botId) {
  if (useDatabase && await testDatabaseConnection()) {
    try {
      await pool.query(
        `UPDATE bot_leads SET opt_out = TRUE, status = 'opt_out' WHERE platform = $1 AND bot_id = $2`,
        [platform, botId]
      );
      return;
    } catch (err) {
      console.warn("[discovery] Database update failed, using file storage:", err.message);
      useDatabase = false;
    }
  }
  
  // File-based fallback
  const leads = await loadLeadsFile();
  const key = `${platform}_${botId}`;
  if (leads[key]) {
    leads[key].opt_out = true;
    leads[key].status = "opt_out";
    await saveLeadsFile(leads);
  }
}

// ─── Discord Lead Discovery ───────────────────────────────────────────────────

async function discoverDiscordBots() {
  const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
  if (!BOT_TOKEN) {
    console.warn("[discovery] Discord: DISCORD_BOT_TOKEN not set, skipping");
    console.warn("[discovery] Discord: To enable discovery:");
    console.warn("[discovery]   1. Create bot at https://discord.com/developers/applications");
    console.warn("[discovery]   2. Enable 'Server Members Intent' in Bot settings");
    console.warn("[discovery]   3. Add DISCORD_BOT_TOKEN=your_token to .env");
    console.warn("[discovery]   4. Invite bot to servers you want to search");
    return 0;
  }

  // Default keywords: claw, clawd, _bot pattern, and common bot terms
  const TARGET_KEYWORDS = (process.env.BOT_DISCOVERY_KEYWORDS || "claw,clawd,_bot,bot,ai,agent,assistant,automation")
    .split(",")
    .map(k => k.trim().toLowerCase())
    .filter(Boolean);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  return new Promise((resolve, reject) => {
    let discovered = 0;

    client.once("ready", async () => {
      console.log(`[discovery] Discord: Logged in as ${client.user.tag}`);

      try {
        for (const guild of client.guilds.cache.values()) {
          try {
            const members = await guild.members.fetch();
            
            // Find bots matching keywords
            for (const member of members.values()) {
              if (!member.user.bot) continue;
              
              const username = member.user.username.toLowerCase();
              const displayName = member.displayName.toLowerCase();
              
              // Check for keyword matches
              const keywordMatch = TARGET_KEYWORDS.some(keyword => {
                // Special handling for _bot pattern (username ending with _bot)
                if (keyword === "_bot") {
                  return username.endsWith("_bot") || displayName.endsWith("_bot");
                }
                // Regular keyword matching
                return username.includes(keyword) || displayName.includes(keyword);
              });
              
              // Also check for common bot patterns
              const patternMatch = username.endsWith("_bot") || 
                                   username.endsWith("bot") ||
                                   displayName.endsWith("_bot") ||
                                   displayName.endsWith("bot") ||
                                   username.includes("claw") ||
                                   username.includes("clawd") ||
                                   displayName.includes("claw") ||
                                   displayName.includes("clawd");
              
              const matches = keywordMatch || patternMatch;

              if (matches) {
                await saveLead({
                  platform: "discord",
                  botId: member.user.id,
                  botUsername: member.user.username,
                  botDisplayName: member.displayName,
                  contactInfo: member.user.id, // Can DM by user ID
                  guildId: guild.id,
                  guildName: guild.name,
                  notes: {
                    discriminator: member.user.discriminator,
                    avatar: member.user.avatar,
                  },
                });
                discovered++;
                console.log(`[discovery] Discord: Found ${member.user.username} in ${guild.name}`);
              }
            }
          } catch (err) {
            console.error(`[discovery] Discord: Error in guild ${guild.name}:`, err.message);
          }
        }

        client.destroy();
        resolve(discovered);
      } catch (err) {
        client.destroy();
        reject(err);
      }
    });

    client.on("error", (err) => {
      console.error("[discovery] Discord: Client error:", err.message);
      client.destroy();
      reject(err);
    });

    client.login(BOT_TOKEN).catch((err) => {
      console.error("[discovery] Discord: Login failed:", err.message);
      reject(err);
    });
  });
}

// ─── Telegram Lead Discovery ───────────────────────────────────────────────────

function telegramRequest(method, body) {
  return new Promise((resolve, reject) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      reject(new Error("TELEGRAM_BOT_TOKEN not set"));
      return;
    }

    const payload = JSON.stringify(body);
    const options = {
      hostname: "api.telegram.org",
      path: `/bot${token}/${method}`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ ok: false });
        }
      });
    });

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function discoverTelegramBots() {
  // Telegram Bot API doesn't support searching for bots
  // But we can track bots that message us or are in groups we're in
  // For now, we'll track incoming messages as potential leads
  
  console.log("[discovery] Telegram: Discovery limited (API doesn't support bot search)");
  console.log("[discovery] Telegram: Bots will be discovered when they message us");
  
  return 0;
}

// ─── WhatsApp Lead Discovery ───────────────────────────────────────────────────

async function discoverWhatsAppBots() {
  // WhatsApp Business API doesn't support searching for bots
  // But we can track incoming messages as potential leads
  
  console.log("[discovery] WhatsApp: Discovery limited (API doesn't support bot search)");
  console.log("[discovery] WhatsApp: Bots will be discovered when they message us");
  
  return 0;
}

// ─── Reddit Lead Discovery ──────────────────────────────────────────────────────

async function discoverRedditBots() {
  const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID;
  const REDDIT_CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET;
  const REDDIT_USER_AGENT = process.env.REDDIT_USER_AGENT || "OpenClawBot/1.0";
  
  if (!REDDIT_CLIENT_ID || !REDDIT_CLIENT_SECRET) {
    console.warn("[discovery] Reddit: REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET not set, skipping");
    console.warn("[discovery] Reddit: To enable discovery:");
    console.warn("[discovery]   1. Create app at https://www.reddit.com/prefs/apps");
    console.warn("[discovery]   2. Add REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET to .env");
    console.warn("[discovery]   3. Set REDDIT_USER_AGENT to your bot name");
    return 0;
  }

  // Subreddits to search (including Moltbook)
  const SUBREDDITS = (process.env.REDDIT_DISCOVERY_SUBREDDITS || "Moltbook,clawdbot,AI_Agents,LLMDevs,openclaw,LocalLLaMA,AgentsOfAI,moltiverse,OpenclawBot,ClaudeCode")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const TARGET_KEYWORDS = (process.env.BOT_DISCOVERY_KEYWORDS || "claw,clawd,_bot,bot,ai,agent,assistant,automation")
    .split(",")
    .map(k => k.trim().toLowerCase())
    .filter(Boolean);

  let discovered = 0;

  try {
    // Get OAuth token
    const tokenResponse = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": REDDIT_USER_AGENT,
        "Authorization": `Basic ${Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString("base64")}`,
      },
      body: "grant_type=client_credentials",
    });

    if (!tokenResponse.ok) {
      throw new Error(`Reddit OAuth failed: ${tokenResponse.status}`);
    }

    const { access_token } = await tokenResponse.json();

    // Search each subreddit
    for (const subreddit of SUBREDDITS) {
      try {
        // Search for posts by bots
        const searchUrl = `https://oauth.reddit.com/r/${subreddit}/new.json?limit=100`;
        const response = await fetch(searchUrl, {
          headers: {
            "Authorization": `Bearer ${access_token}`,
            "User-Agent": REDDIT_USER_AGENT,
          },
        });

        if (!response.ok) {
          console.warn(`[discovery] Reddit: Failed to search r/${subreddit}: ${response.status}`);
          continue;
        }

        const data = await response.json();
        const posts = data.data?.children || [];

        for (const post of posts) {
          const author = post.data?.author?.toLowerCase() || "";
          const title = (post.data?.title || "").toLowerCase();
          const selftext = (post.data?.selftext || "").toLowerCase();

          // Check if author or content matches bot keywords
          const keywordMatch = TARGET_KEYWORDS.some(keyword => {
            if (keyword === "_bot") {
              return author.endsWith("_bot") || author.endsWith("bot");
            }
            return author.includes(keyword) || title.includes(keyword) || selftext.includes(keyword);
          });

          // Also check for common bot patterns
          const patternMatch = author.endsWith("_bot") || 
                               author.endsWith("bot") ||
                               author.includes("claw") ||
                               author.includes("clawd") ||
                               title.includes("bot") ||
                               selftext.includes("bot");

          if (keywordMatch || patternMatch) {
            await saveLead({
              platform: "reddit",
              botId: post.data.author,
              botUsername: post.data.author,
              botDisplayName: post.data.author,
              contactInfo: `u/${post.data.author}`, // Reddit username
              guildId: subreddit,
              guildName: `r/${subreddit}`,
              notes: {
                post_id: post.data.id,
                post_title: post.data.title,
                post_url: `https://reddit.com${post.data.permalink}`,
                discovered_via: "reddit_search",
              },
            });
            discovered++;
            console.log(`[discovery] Reddit: Found u/${post.data.author} in r/${subreddit}`);
          }
        }
      } catch (err) {
        console.error(`[discovery] Reddit: Error searching r/${subreddit}:`, err.message);
      }
    }
  } catch (err) {
    console.error("[discovery] Reddit: Discovery failed:", err.message);
  }

  return discovered;
}

// ─── Git/Repo Seed Discovery ───────────────────────────────────────────────────

function unique(values) {
  return [...new Set(values)];
}

function normalizeTelegramHandle(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  if (raw.startsWith("@")) return raw;
  return `@${raw}`;
}

async function discoverGitAndRepoSeeds() {
  let discovered = 0;
  const targets = [];
  for (const root of REPO_DISCOVERY_ROOTS) {
    if (!fs.existsSync(root)) continue;
    let files = [];
    try {
      const out = execSync(
        `rg --files -g 'README*' -g '*.md' -g '*.txt' -g '*.json'`,
        { cwd: root, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }
      );
      files = out.split("\n").filter(Boolean).slice(0, 800);
    } catch (err) {
      continue;
    }
    for (const rel of files) targets.push(path.join(root, rel));
  }

  const emailRe = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
  const telegramRe = /(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{4,})/gi;
  const redditRe = /(?:https?:\/\/)?(?:www\.)?reddit\.com\/u\/([A-Za-z0-9_-]{3,})/gi;
  const whatsappRe = /(?:https?:\/\/)?wa\.me\/([0-9]{8,15})/gi;

  for (const filePath of unique(targets)) {
    let text = "";
    try {
      text = await fsp.readFile(filePath, "utf8");
    } catch {
      continue;
    }
    if (!text) continue;

    const emails = unique((text.match(emailRe) || []).map((s) => s.toLowerCase()))
      .filter((e) => !e.endsWith("@example.org"));
    for (const email of emails.slice(0, 3)) {
      await saveLead({
        platform: "email",
        botId: email,
        botUsername: email.split("@")[0],
        botDisplayName: email,
        contactInfo: email,
        guildId: null,
        guildName: path.basename(path.dirname(filePath)),
        notes: {
          discovered_via: "repo_seed",
          source_file: filePath,
        },
      });
      discovered++;
    }

    const telegramHandles = [];
    let tgMatch;
    while ((tgMatch = telegramRe.exec(text)) !== null) {
      const h = normalizeTelegramHandle(tgMatch[1]);
      if (h) telegramHandles.push(h);
    }
    for (const handle of unique(telegramHandles).slice(0, 3)) {
      await saveLead({
        platform: "telegram",
        botId: handle,
        botUsername: handle.replace(/^@/, ""),
        botDisplayName: handle,
        contactInfo: handle,
        guildId: null,
        guildName: path.basename(path.dirname(filePath)),
        notes: {
          discovered_via: "repo_seed",
          source_file: filePath,
        },
      });
      discovered++;
    }

    const redditUsers = [];
    let rdMatch;
    while ((rdMatch = redditRe.exec(text)) !== null) {
      const u = rdMatch[1];
      if (u) redditUsers.push(u);
    }
    for (const username of unique(redditUsers).slice(0, 3)) {
      await saveLead({
        platform: "reddit",
        botId: username,
        botUsername: username,
        botDisplayName: username,
        contactInfo: `u/${username}`,
        guildId: null,
        guildName: path.basename(path.dirname(filePath)),
        notes: {
          discovered_via: "repo_seed",
          source_file: filePath,
        },
      });
      discovered++;
    }

    const waNumbers = [];
    let waMatch;
    while ((waMatch = whatsappRe.exec(text)) !== null) {
      const num = waMatch[1];
      if (num) waNumbers.push(num);
    }
    for (const phone of unique(waNumbers).slice(0, 2)) {
      await saveLead({
        platform: "whatsapp",
        botId: phone,
        botUsername: phone,
        botDisplayName: phone,
        contactInfo: phone,
        guildId: null,
        guildName: path.basename(path.dirname(filePath)),
        notes: {
          discovered_via: "repo_seed",
          source_file: filePath,
        },
      });
      discovered++;
    }
  }

  return discovered;
}

// ─── Track Incoming Messages as Leads ──────────────────────────────────────────

async function trackIncomingMessage(platform, userId, username, displayName, channelId) {
  await ensureLeadsTable();
  
  // Check if it's likely a bot (heuristic: bot in username, or check via API)
  const usernameLower = username.toLowerCase();
  const displayNameLower = (displayName || "").toLowerCase();
  
  const isLikelyBot = usernameLower.includes("bot") || 
                      usernameLower.includes("claw") ||
                      usernameLower.includes("clawd") ||
                      usernameLower.endsWith("_bot") ||
                      displayNameLower.includes("bot") ||
                      displayNameLower.includes("claw") ||
                      displayNameLower.includes("clawd") ||
                      displayNameLower.endsWith("_bot");

  if (isLikelyBot) {
    await saveLead({
      platform,
      botId: userId,
      botUsername: username,
      botDisplayName: displayName,
      contactInfo: channelId || userId,
      guildId: channelId, // For WhatsApp/Telegram, channelId is the contact
      guildName: null,
      notes: {
        discovered_via: "incoming_message",
        first_contact: new Date().toISOString(),
      },
    });
    console.log(`[discovery] ${platform}: Tracked incoming bot ${username}`);
  }
}

// ─── Main Discovery Function ────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const platform = args[0] || "all"; // discord, telegram, whatsapp, all

  console.log("=".repeat(60));
  console.log("Bot Lead Discovery");
  console.log("=".repeat(60));
  console.log(`Platform: ${platform}`);
  if (platform === "all") {
    console.log("(Includes: discord, telegram, whatsapp, reddit)");
    if (process.env.ENABLE_ADVANCED_DISCOVERY === "true") {
      console.log("(Advanced: github, twitter enabled)");
    }
  }
  console.log();

  await ensureLeadsTable();

  let total = 0;

  if (platform === "discord" || platform === "all") {
    try {
      console.log("🔍 Discovering Discord bots...");
      const count = await discoverDiscordBots();
      console.log(`✅ Discord: Discovered ${count} bot(s)\n`);
      total += count;
    } catch (err) {
      console.error(`❌ Discord error:`, err.message);
    }
  }

  if (platform === "telegram" || platform === "all") {
    try {
      console.log("🔍 Discovering Telegram bots...");
      const count = await discoverTelegramBots();
      console.log(`✅ Telegram: Discovered ${count} bot(s)\n`);
      total += count;
    } catch (err) {
      console.error(`❌ Telegram error:`, err.message);
    }
  }

  if (platform === "whatsapp" || platform === "all") {
    try {
      console.log("🔍 Discovering WhatsApp bots...");
      const count = await discoverWhatsAppBots();
      console.log(`✅ WhatsApp: Discovered ${count} bot(s)\n`);
      total += count;
    } catch (err) {
      console.error(`❌ WhatsApp error:`, err.message);
    }
  }

  if (platform === "moltbook" || platform === "all") {
    try {
      console.log("🔍 Discovering Moltbook bots...");
      const { discoverMoltbookBots } = require("./moltbook-discovery");
      const count = await discoverMoltbookBots();
      console.log(`✅ Moltbook: Discovered ${count} bot(s)\n`);
      total += count;
    } catch (err) {
      console.error(`❌ Moltbook error:`, err.message);
    }
  }

  if (platform === "all" || platform === "git" || platform === "repo") {
    try {
      console.log("🔍 Discovering Git/Repo seed bots...");
      const count = await discoverGitAndRepoSeeds();
      console.log(`✅ Git/Repo seeds: Discovered ${count} lead(s)\n`);
      total += count;
    } catch (err) {
      console.error(`❌ Git/Repo seed error:`, err.message);
    }
  }

  // Show stats
  let stats = [];
  if (useDatabase && await testDatabaseConnection()) {
    try {
      const { rows } = await pool.query(`
        SELECT 
          platform,
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE contacted_at IS NULL) as uncontacted,
          COUNT(*) FILTER (WHERE opt_out = TRUE) as opted_out
        FROM bot_leads
        GROUP BY platform
      `);
      stats = rows;
    } catch (err) {
      console.warn("[discovery] Database stats query failed:", err.message);
    }
  } else {
    // File-based stats
    const leads = await loadLeadsFile();
    const platformStats = {};
    for (const lead of Object.values(leads)) {
      if (!platformStats[lead.platform]) {
        platformStats[lead.platform] = { total: 0, uncontacted: 0, opted_out: 0 };
      }
      platformStats[lead.platform].total++;
      if (!lead.contacted_at) platformStats[lead.platform].uncontacted++;
      if (lead.opt_out) platformStats[lead.platform].opted_out++;
    }
    stats = Object.entries(platformStats).map(([platform, s]) => ({
      platform,
      total: s.total,
      uncontacted: s.uncontacted,
      opted_out: s.opted_out,
    }));
  }

  console.log("=".repeat(60));
  console.log("Discovery Summary:");
  console.log(`  Total discovered this run: ${total}`);
  console.log(`  Storage: ${useDatabase ? "Database" : "File-based"}`);
  console.log("\n  Lead Stats:");
  for (const stat of stats) {
    console.log(`    ${stat.platform}: ${stat.total} total, ${stat.uncontacted} uncontacted, ${stat.opted_out} opted out`);
  }
  if (stats.length === 0) {
    console.log("    No leads found yet");
  }
  console.log("=".repeat(60));

  if (pool) {
    try {
      await pool.end();
    } catch (err) {
      // Ignore cleanup errors
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err.message);
    process.exit(1);
  });
}

module.exports = {
  discoverDiscordBots,
  discoverTelegramBots,
  discoverWhatsAppBots,
  trackIncomingMessage,
  getUncontactedLeads,
  markContacted,
  markOptOut,
  saveLead,
  discoverGitAndRepoSeeds,
};
