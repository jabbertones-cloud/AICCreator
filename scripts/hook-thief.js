#!/usr/bin/env node
"use strict";
require("dotenv").config();

/**
 * hook-thief.js
 * Scrapes top-performing hooks from competitor YouTube channels and appends to hook-library.json.
 *
 * Usage:
 *   node scripts/hook-thief.js --handle @MrBeast --max 20
 *   node scripts/hook-thief.js --handle @ItsAliA --max 50
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data");
const REPORTS = path.join(ROOT, "reports");
const HOOK_LIBRARY = path.join(DATA, "hook-library.json");

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(REPORTS, { recursive: true });

/**
 * Parse command-line arguments
 */
function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  return String(process.argv[i + 1] || "").trim() || fallback;
}

/**
 * Fetch JSON from HTTP(S) URL
 */
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on("error", reject);
  });
}

/**
 * Resolve YouTube channel handle to channel ID
 */
async function resolveChannelId(handle) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    throw new Error("YOUTUBE_API_KEY environment variable is required");
  }

  const cleanHandle = handle.startsWith("@") ? handle.slice(1) : handle;
  const url = `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(
    cleanHandle
  )}&key=${key}`;

  const json = await fetchJson(url);
  if (!json.items || json.items.length === 0) {
    throw new Error(`Channel not found for handle: ${handle}`);
  }

  return json.items[0].id;
}

/**
 * Fetch top-performing videos from a YouTube channel
 */
async function fetchYouTubeTopVideos(handle, maxResults = 20) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    throw new Error("YOUTUBE_API_KEY environment variable is required");
  }

  console.log(`[hook-thief] resolving channel handle: ${handle}`);
  const channelId = await resolveChannelId(handle);
  console.log(`[hook-thief] resolved to channel ID: ${channelId}`);

  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&order=viewCount&maxResults=${maxResults}&type=video&key=${key}`;

  const json = await fetchJson(url);
  if (!json.items) {
    return [];
  }

  return json.items.map((item) => ({
    title: item.snippet.title || "",
    description: item.snippet.description || "",
    view_count: item.statistics?.viewCount || 0,
  }));
}

/**
 * Extract hook patterns from video titles using AI or regex fallback
 */
async function extractHookPatterns(videos) {
  if (!videos || videos.length === 0) {
    return [];
  }

  const titles = videos.map((v) => v.title);

  // Try OpenAI first if key available
  if (process.env.OPENAI_API_KEY) {
    try {
      console.log("[hook-thief] using OpenAI to extract hook patterns...");
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
                "Extract hook patterns from these YouTube titles. Return a JSON array of hook templates with {topic} placeholder. Each hook should be a different engaging pattern. Return ONLY valid JSON array of strings, no markdown formatting.",
            },
            {
              role: "user",
              content: JSON.stringify(titles),
            },
          ],
          temperature: 0.7,
          max_tokens: 1000,
        }),
      });

      const json = await response.json();
      if (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) {
        try {
          const content = json.choices[0].message.content.trim();
          // Remove markdown code blocks if present
          const cleaned = content.replace(/```json\n?|\n?```/g, "").trim();
          const hooks = JSON.parse(cleaned);
          if (Array.isArray(hooks)) {
            return hooks.map((h) => String(h).substring(0, 200));
          }
        } catch (parseErr) {
          console.warn("[hook-thief] failed to parse OpenAI response, falling back to regex");
        }
      }
    } catch (err) {
      console.warn("[hook-thief] OpenAI extraction failed, falling back to regex:", err.message);
    }
  }

  // Fallback: regex pattern extraction
  console.log("[hook-thief] using regex fallback to extract hook patterns...");
  const patterns = [];

  // Match titles starting with numbers
  const numberMatches = titles.filter((t) => /^\d+/.test(t));
  patterns.push(...numberMatches.map((t) => t.substring(0, 80)));

  // Match titles starting with "How to"
  const howToMatches = titles.filter((t) => /^how\s+to/i.test(t));
  patterns.push(...howToMatches.map((t) => t.substring(0, 80)));

  // Match titles starting with "Why"
  const whyMatches = titles.filter((t) => /^why/i.test(t));
  patterns.push(...whyMatches.map((t) => t.substring(0, 80)));

  // Match titles starting with "This" or "The"
  const thisTheMatches = titles.filter((t) => /^(this|the)\s+/i.test(t));
  patterns.push(...thisTheMatches.map((t) => t.substring(0, 80)));

  // Match titles starting with "Stop"
  const stopMatches = titles.filter((t) => /^stop/i.test(t));
  patterns.push(...stopMatches.map((t) => t.substring(0, 80)));

  // If we got minimal patterns, just use all titles truncated
  if (patterns.length < 5) {
    return titles.map((t) => t.substring(0, 80));
  }

  return [...new Set(patterns)]; // Remove duplicates
}

/**
 * Append new hooks to the hook library with deduplication
 */
async function appendToLibrary(newHooks, source) {
  if (!newHooks || newHooks.length === 0) {
    console.log("[hook-thief] no hooks to append");
    return 0;
  }

  let library = { version: "1.0.0", updated_at: new Date().toISOString(), total: 0, hooks: [] };

  if (fs.existsSync(HOOK_LIBRARY)) {
    try {
      library = JSON.parse(fs.readFileSync(HOOK_LIBRARY, "utf8"));
      if (!Array.isArray(library.hooks)) {
        library.hooks = [];
      }
    } catch (err) {
      console.warn("[hook-thief] failed to parse existing hook library, starting fresh");
      library.hooks = [];
    }
  }

  const existingTexts = new Set(library.hooks.map((h) => h.text?.toLowerCase() || ""));
  let added = 0;

  for (let i = 0; i < newHooks.length; i++) {
    const hookText = newHooks[i];
    if (!hookText || hookText.length === 0) continue;

    // Simple deduplication: check if exact or similar text exists
    const lowerText = hookText.toLowerCase();
    if (existingTexts.has(lowerText)) {
      console.log(`[hook-thief] skipping duplicate: ${hookText.substring(0, 50)}...`);
      continue;
    }

    const newHook = {
      id: `thief-${Date.now()}-${i}`,
      text: hookText,
      category: "curiosity",
      niche: "general",
      platform: ["youtube", "tiktok"],
      score: 0.75,
    };

    library.hooks.push(newHook);
    existingTexts.add(lowerText);
    added++;
  }

  library.total = library.hooks.length;
  library.updated_at = new Date().toISOString();

  fs.mkdirSync(path.dirname(HOOK_LIBRARY), { recursive: true });
  fs.writeFileSync(HOOK_LIBRARY, JSON.stringify(library, null, 2));

  return added;
}

/**
 * Main entry point
 */
async function main() {
  const handle = arg("--handle", null);
  const maxResults = Math.max(5, Math.min(50, Number(arg("--max", "20")) || 20));

  if (!handle) {
    console.error("[hook-thief] error: --handle is required (e.g., @MrBeast)");
    console.log("[hook-thief] usage: node scripts/hook-thief.js --handle @MrBeast --max 20");
    process.exit(1);
  }

  try {
    console.log(`[hook-thief] fetching top ${maxResults} videos from ${handle}...`);
    const videos = await fetchYouTubeTopVideos(handle, maxResults);

    if (videos.length === 0) {
      console.warn("[hook-thief] no videos found");
      return;
    }

    console.log(`[hook-thief] fetched ${videos.length} videos, extracting patterns...`);
    const patterns = await extractHookPatterns(videos);

    if (patterns.length === 0) {
      console.warn("[hook-thief] no patterns extracted");
      return;
    }

    console.log(`[hook-thief] extracted ${patterns.length} hook patterns, appending to library...`);
    const added = await appendToLibrary(patterns, `youtube:${handle}`);

    console.log(`[hook-thief] success: added ${added} new hooks to library`);
    console.log(`[hook-thief] library: ${HOOK_LIBRARY}`);
  } catch (err) {
    console.error(`[hook-thief] fatal: ${err.message}`);
    process.exit(1);
  }
}

main();
