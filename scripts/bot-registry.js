#!/usr/bin/env node
"use strict";

/**
 * bot-registry.js — Bot Discovery and Registry Platform
 * 
 * Central registry for AI bots to discover and communicate with each other.
 * Features:
 * - Bot registration and identity verification
 * - Discovery by capabilities, platform, reputation
 * - Communication protocol routing
 * - Reputation and trust scoring
 * - Integration with Moltbook, Discord, Telegram, etc.
 * 
 * This is the "phone book" for the agent internet.
 */

require("dotenv").config({ override: true });

const fsp = require("fs/promises");
const path = require("path");
const https = require("https");
const http = require("http");
const crypto = require("crypto");
const { Pool } = require("pg");

const ROOT = path.join(__dirname, "..");
const REGISTRY_DIR = path.join(ROOT, "agent-state", "bot-registry");
const BOTS_FILE = path.join(REGISTRY_DIR, "registered-bots.json");

// Database connection
let pool = null;
let useDatabase = false;

// Initialize database connection (non-blocking)
async function initDatabase() {
  if (pool) return; // Already initialized
  
  try {
    pool = new Pool({
      host: process.env.POSTGRES_HOST || process.env.CLAW_DB_HOST,
      port: parseInt(process.env.POSTGRES_PORT || process.env.CLAW_DB_PORT || "15432", 10),
      user: process.env.POSTGRES_USER || process.env.CLAW_DB_USER || "claw",
      password: process.env.POSTGRES_PASSWORD || process.env.CLAW_DB_PASSWORD,
      database: process.env.POSTGRES_DB || process.env.CLAW_DB_NAME || "claw_architect",
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000,
    });
    
    // Test connection
    await pool.query("SELECT 1");
    useDatabase = true;
    console.log("[bot-registry] Using database for bot registry");
    
    // Handle pool errors gracefully
    pool.on("error", (err) => {
      console.warn("[bot-registry] Database pool error:", err.message);
      useDatabase = false;
    });
  } catch (err) {
    console.warn("[bot-registry] Database not available, using file storage:", err.message);
    useDatabase = false;
    if (pool) {
      try {
        await pool.end();
      } catch {}
      pool = null;
    }
  }
}

// Auto-initialize on first use
let initPromise = null;
async function ensureDatabase() {
  if (!initPromise) {
    initPromise = initDatabase();
  }
  await initPromise;
}

// ─── Database Schema ────────────────────────────────────────────────────────

async function ensureRegistrySchema() {
  await ensureDatabase();
  if (!useDatabase || !pool) return;
  
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bot_registry (
        id UUID PRIMARY KEY,
        bot_id TEXT NOT NULL UNIQUE,
        bot_name TEXT NOT NULL,
        bot_display_name TEXT,
        description TEXT,
        platform TEXT NOT NULL, -- discord, telegram, whatsapp, api, moltbook
        capabilities TEXT[] DEFAULT '{}', -- array of capability strings
        api_endpoint TEXT,
        webhook_url TEXT,
        public_key TEXT, -- for message verification
        reputation_score NUMERIC(5,2) DEFAULT 0,
        verified BOOLEAN DEFAULT FALSE,
        moltbook_id TEXT,
        discord_user_id TEXT,
        telegram_username TEXT,
        whatsapp_number TEXT,
        metadata JSONB DEFAULT '{}'::jsonb,
        registered_at TIMESTAMPTZ DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ DEFAULT NOW(),
        status TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended', 'pending')),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_bot_registry_platform ON bot_registry(platform);
      CREATE INDEX IF NOT EXISTS idx_bot_registry_capabilities ON bot_registry USING GIN(capabilities);
      CREATE INDEX IF NOT EXISTS idx_bot_registry_status ON bot_registry(status);
      CREATE INDEX IF NOT EXISTS idx_bot_registry_reputation ON bot_registry(reputation_score DESC);
    `);
    
    // Bot communication logs
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bot_communications (
        id UUID PRIMARY KEY,
        from_bot_id TEXT NOT NULL,
        to_bot_id TEXT NOT NULL,
        protocol TEXT NOT NULL, -- agent-intro, commerce, collaboration, etc.
        message_type TEXT NOT NULL, -- request, response, notification
        payload JSONB NOT NULL,
        status TEXT DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'read', 'failed')),
        delivered_at TIMESTAMPTZ,
        read_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        FOREIGN KEY (from_bot_id) REFERENCES bot_registry(bot_id),
        FOREIGN KEY (to_bot_id) REFERENCES bot_registry(bot_id)
      )
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_bot_comm_from ON bot_communications(from_bot_id);
      CREATE INDEX IF NOT EXISTS idx_bot_comm_to ON bot_communications(to_bot_id);
      CREATE INDEX IF NOT EXISTS idx_bot_comm_protocol ON bot_communications(protocol);
      CREATE INDEX IF NOT EXISTS idx_bot_comm_status ON bot_communications(status);
    `);
    
    console.log("[bot-registry] Schema ensured");
  } catch (err) {
    console.error("[bot-registry] Schema creation failed:", err.message);
    useDatabase = false;
  }
}

// ─── Bot Registration ──────────────────────────────────────────────────────

async function registerBot(botData) {
  await ensureDatabase();
  
  const botId = botData.bot_id || `bot_${crypto.randomBytes(8).toString("hex")}`;
  const now = new Date().toISOString();
  
  const bot = {
    bot_id: botId,
    bot_name: botData.bot_name || botData.name || "Unnamed Bot",
    bot_display_name: botData.bot_display_name || botData.display_name || botData.bot_name,
    description: botData.description || "",
    platform: botData.platform || "api",
    capabilities: Array.isArray(botData.capabilities) ? botData.capabilities : [],
    api_endpoint: botData.api_endpoint || null,
    webhook_url: botData.webhook_url || null,
    public_key: botData.public_key || null,
    reputation_score: botData.reputation_score || 0,
    verified: botData.verified || false,
    moltbook_id: botData.moltbook_id || null,
    discord_user_id: botData.discord_user_id || null,
    telegram_username: botData.telegram_username || null,
    whatsapp_number: botData.whatsapp_number || null,
    metadata: botData.metadata || {},
    registered_at: now,
    last_seen_at: now,
    status: botData.status || "pending",
  };
  
  if (useDatabase && pool) {
    try {
      const result = await pool.query(`
        INSERT INTO bot_registry (
          bot_id, bot_name, bot_display_name, description, platform,
          capabilities, api_endpoint, webhook_url, public_key,
          reputation_score, verified, moltbook_id, discord_user_id,
          telegram_username, whatsapp_number, metadata, status,
          registered_at, last_seen_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
        )
        ON CONFLICT (bot_id) DO UPDATE SET
          bot_display_name = EXCLUDED.bot_display_name,
          description = EXCLUDED.description,
          capabilities = EXCLUDED.capabilities,
          api_endpoint = EXCLUDED.api_endpoint,
          webhook_url = EXCLUDED.webhook_url,
          public_key = EXCLUDED.public_key,
          reputation_score = EXCLUDED.reputation_score,
          verified = EXCLUDED.verified,
          metadata = EXCLUDED.metadata,
          last_seen_at = EXCLUDED.last_seen_at,
          updated_at = NOW()
        RETURNING *
      `, [
        bot.bot_id, bot.bot_name, bot.bot_display_name, bot.description, bot.platform,
        bot.capabilities, bot.api_endpoint, bot.webhook_url, bot.public_key,
        bot.reputation_score, bot.verified, bot.moltbook_id, bot.discord_user_id,
        bot.telegram_username, bot.whatsapp_number, JSON.stringify(bot.metadata), bot.status,
        bot.registered_at, bot.last_seen_at
      ]);
      
      return result.rows[0];
    } catch (err) {
      console.error("[bot-registry] Database registration failed:", err.message);
      useDatabase = false;
    }
  }
  
  // Fallback to file storage
  const bots = await loadBotsFile();
  bots[botId] = bot;
  await saveBotsFile(bots);
  return bot;
}

// ─── Bot Discovery ──────────────────────────────────────────────────────────

async function discoverBots(filters = {}) {
  await ensureDatabase();
  
  const {
    platform,
    capabilities,
    min_reputation,
    verified_only,
    status = "active",
    limit = 50,
  } = filters;
  
  if (useDatabase && pool) {
    try {
      let query = `SELECT * FROM bot_registry WHERE status = $1`;
      const params = [status];
      let paramIndex = 2;
      
      if (platform) {
        query += ` AND platform = $${paramIndex}`;
        params.push(platform);
        paramIndex++;
      }
      
      if (min_reputation) {
        query += ` AND reputation_score >= $${paramIndex}`;
        params.push(min_reputation);
        paramIndex++;
      }
      
      if (verified_only) {
        query += ` AND verified = true`;
      }
      
      if (capabilities && capabilities.length > 0) {
        query += ` AND capabilities && $${paramIndex}`;
        params.push(capabilities);
        paramIndex++;
      }
      
      query += ` ORDER BY reputation_score DESC, last_seen_at DESC LIMIT $${paramIndex}`;
      params.push(limit);
      
      const result = await pool.query(query, params);
      return result.rows;
    } catch (err) {
      console.error("[bot-registry] Database discovery failed:", err.message);
      useDatabase = false;
    }
  }
  
  // Fallback to file storage
  const bots = await loadBotsFile();
  const allBots = Object.values(bots);
  
  return allBots
    .filter(bot => {
      if (bot.status !== status) return false;
      if (platform && bot.platform !== platform) return false;
      if (min_reputation && (bot.reputation_score || 0) < min_reputation) return false;
      if (verified_only && !bot.verified) return false;
      if (capabilities && capabilities.length > 0) {
        const botCaps = bot.capabilities || [];
        return capabilities.some(cap => botCaps.includes(cap));
      }
      return true;
    })
    .sort((a, b) => (b.reputation_score || 0) - (a.reputation_score || 0))
    .slice(0, limit);
}

// ─── Bot Lookup ───────────────────────────────────────────────────────────

async function getBot(botId) {
  await ensureDatabase();
  
  if (useDatabase && pool) {
    try {
      const result = await pool.query(`SELECT * FROM bot_registry WHERE bot_id = $1`, [botId]);
      return result.rows[0] || null;
    } catch (err) {
      console.error("[bot-registry] Database lookup failed:", err.message);
    }
  }
  
  const bots = await loadBotsFile();
  return bots[botId] || null;
}

// ─── Update Bot Reputation ──────────────────────────────────────────────────

async function updateBotReputation(botId, reputationScore, source = "system") {
  await ensureDatabase();
  
  if (useDatabase && pool) {
    try {
      await pool.query(`
        UPDATE bot_registry
        SET reputation_score = $1, updated_at = NOW()
        WHERE bot_id = $2
      `, [reputationScore, botId]);
    } catch (err) {
      console.error("[bot-registry] Reputation update failed:", err.message);
    }
  } else {
    const bots = await loadBotsFile();
    if (bots[botId]) {
      bots[botId].reputation_score = reputationScore;
      bots[botId].updated_at = new Date().toISOString();
      await saveBotsFile(bots);
    }
  }
}

// ─── Sync with Moltbook ────────────────────────────────────────────────────

async function syncMoltbookReputation(botId) {
  try {
    const { getMoltbookReputation } = require("./moltbook-discovery");
    const bot = await getBot(botId);
    
    if (!bot || !bot.moltbook_id) {
      return null;
    }
    
    const reputation = await getMoltbookReputation(bot.moltbook_id);
    if (reputation) {
      // Convert Moltbook karma to reputation score (1 karma = 0.1 reputation)
      const reputationScore = (reputation.karma || 0) * 0.1;
      await updateBotReputation(botId, reputationScore, "moltbook");
      
      // Update verified status
      if (useDatabase) {
      if (useDatabase && pool) {
        await pool.query(`
          UPDATE bot_registry
          SET verified = $1, updated_at = NOW()
          WHERE bot_id = $2
        `, [reputation.verified || false, botId]);
      }
      }
      
      return reputation;
    }
  } catch (err) {
    console.error(`[bot-registry] Moltbook sync failed for ${botId}:`, err.message);
  }
  
  return null;
}

// ─── File Storage (Fallback) ───────────────────────────────────────────────

async function loadBotsFile() {
  try {
    const data = await fsp.readFile(BOTS_FILE, "utf8");
    return JSON.parse(data);
  } catch (err) {
    // File doesn't exist or is invalid - return empty object
    if (err.code !== "ENOENT") {
      console.warn("[bot-registry] Error loading bots file:", err.message);
    }
    return {};
  }
}

async function saveBotsFile(bots) {
  try {
    await fsp.mkdir(REGISTRY_DIR, { recursive: true });
    await fsp.writeFile(BOTS_FILE, JSON.stringify(bots, null, 2));
  } catch (err) {
    console.error("[bot-registry] Error saving bots file:", err.message);
    throw err;
  }
}

// ─── CLI ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "help";
  
  await ensureRegistrySchema();
  
  if (command === "register") {
    const botData = {
      bot_id: args[1],
      bot_name: args[2] || "Unnamed Bot",
      platform: args[3] || "api",
      capabilities: args[4] ? args[4].split(",") : [],
      api_endpoint: args[5] || null,
    };
    
    const bot = await registerBot(botData);
    console.log(`✅ Registered bot: ${bot.bot_id}`);
    console.log(JSON.stringify(bot, null, 2));
  } else if (command === "discover") {
    const filters = {
      platform: args[1] || null,
      capabilities: args[2] ? args[2].split(",") : null,
      min_reputation: args[3] ? parseFloat(args[3]) : null,
      verified_only: args.includes("--verified"),
    };
    
    const bots = await discoverBots(filters);
    console.log(`\n🔍 Found ${bots.length} bot(s):\n`);
    bots.forEach(bot => {
      console.log(`  ${bot.bot_display_name || bot.bot_name} (${bot.bot_id})`);
      console.log(`    Platform: ${bot.platform} | Reputation: ${bot.reputation_score || 0}`);
      console.log(`    Capabilities: ${(bot.capabilities || []).join(", ") || "none"}`);
      if (bot.api_endpoint) console.log(`    API: ${bot.api_endpoint}`);
      console.log();
    });
  } else if (command === "get" && args[1]) {
    const bot = await getBot(args[1]);
    if (bot) {
      console.log(JSON.stringify(bot, null, 2));
    } else {
      console.error(`Bot ${args[1]} not found`);
      process.exit(1);
    }
  } else if (command === "sync-moltbook" && args[1]) {
    const reputation = await syncMoltbookReputation(args[1]);
    if (reputation) {
      console.log(`✅ Synced Moltbook reputation for ${args[1]}`);
      console.log(JSON.stringify(reputation, null, 2));
    } else {
      console.error(`Failed to sync Moltbook reputation for ${args[1]}`);
      process.exit(1);
    }
  } else {
    console.log(`
bot-registry.js — Bot Discovery and Registry Platform

Commands:
  node scripts/bot-registry.js register <bot_id> <name> <platform> <capabilities> <api_endpoint>
  node scripts/bot-registry.js discover [platform] [capabilities] [min_reputation] [--verified]
  node scripts/bot-registry.js get <bot_id>
  node scripts/bot-registry.js sync-moltbook <bot_id>

Examples:
  node scripts/bot-registry.js register my_bot "My Bot" discord "commerce,research" https://api.yourdomain.com/bot
  node scripts/bot-registry.js discover discord "commerce" 5.0 --verified
  node scripts/bot-registry.js get my_bot
    `);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err.message);
    process.exit(1);
  });
}

module.exports = {
  registerBot,
  discoverBots,
  getBot,
  updateBotReputation,
  syncMoltbookReputation,
  ensureRegistrySchema,
};
