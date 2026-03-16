#!/usr/bin/env node
"use strict";
/**
 * youtube-transcript-visual-index
 * ------------------------------
 * Standalone, OpenClaw-free indexing utility:
 * - gathers transcript signals
 * - gathers visual keyshot signals (when tooling exists)
 * - computes a practical quality benchmark per video
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const https = require("https");

function hasBinary(name) {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function run(bin, args, opts = {}) {
  return execFileSync(bin, args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: opts.encoding || "utf8",
    maxBuffer: opts.maxBuffer || 32 * 1024 * 1024,
  });
}

function parseArgs(argv) {
  const out = { urls: [], urlsFile: null, out: null, keyshots: 6, scene: 0.4, dryRun: false, comments: false, fullAnalysis: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") out.urls.push(String(argv[++i] || "").trim());
    else if (a === "--urls-file") out.urlsFile = String(argv[++i] || "").trim();
    else if (a === "--out") out.out = String(argv[++i] || "").trim();
    else if (a === "--keyshots") out.keyshots = Math.max(0, Math.min(24, Number(argv[++i] || 6) || 6));
    else if (a === "--scene") out.scene = Math.max(0.1, Math.min(0.95, Number(argv[++i] || 0.4) || 0.4));
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--comments") out.comments = true;
    else if (a === "--full-analysis") out.fullAnalysis = true;
  }
  return out;
}

function parseVideoId(urlOrId) {
  const raw = String(urlOrId || "").trim();
  if (!raw) return null;
  if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) return raw;
  try {
    const u = new URL(raw);
    if (u.hostname.includes("youtu.be")) return (u.pathname || "").replace(/^\//, "").slice(0, 11);
    if (u.searchParams.get("v")) return u.searchParams.get("v").slice(0, 11);
    const m = u.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
    if (m) return m[1];
    return null;
  } catch {
    return null;
  }
}

function readUrls(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/g)
    .map((x) => x.trim())
    .filter((x) => x && !x.startsWith("#"));
}

function parseVtt(vtt) {
  const lines = String(vtt || "").split(/\r?\n/g);
  const segments = [];
  let current = null;
  for (const line of lines) {
    if (!line.trim() || /^WEBVTT/i.test(line.trim()) || /^NOTE/i.test(line.trim())) continue;
    if (line.includes("-->") && /^\d/.test(line.trim())) {
      if (current && current.text) segments.push(current);
      const parts = line.split("-->").map((p) => p.trim());
      current = { start: parts[0], end: parts[1], text: "" };
      continue;
    }
    if (!current) continue;
    current.text = `${current.text} ${line.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()}`.trim();
  }
  if (current && current.text) segments.push(current);
  return segments;
}

function uniqWords(text, max = 30) {
  const stop = new Set(["the", "and", "for", "with", "that", "this", "from", "you", "your", "have", "are", "was", "will", "they", "them"]);
  const freq = new Map();
  for (const t of String(text || "").toLowerCase().split(/[^a-z0-9]+/g)) {
    if (!t || t.length < 3 || stop.has(t)) continue;
    freq.set(t, (freq.get(t) || 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([w]) => w);
}

function timestampToSeconds(ts) {
  const raw = String(ts || "").trim();
  if (!raw) return null;
  const first = raw.split(".")[0];
  const parts = first.split(":").map((p) => Number(p));
  if (parts.some((p) => Number.isNaN(p))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return null;
}

function summarizeHookFirst30s(segments) {
  const hookText = (segments || [])
    .filter((s) => {
      const sec = timestampToSeconds(s.start);
      return sec !== null && sec <= 30;
    })
    .map((s) => s.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return hookText ? hookText.slice(0, 320) : "";
}

function extractCtaMoments(segments) {
  const ctaPattern = /\b(subscribe|follow|comment|like|share|click|join|buy|signup|sign up|link in bio|check out)\b/i;
  return (segments || [])
    .filter((s) => ctaPattern.test(String(s.text || "")))
    .slice(0, 20)
    .map((s) => ({
      timestamp: s.start || null,
      text: String(s.text || "").slice(0, 220),
    }));
}

function sentimentForText(text) {
  const positive = new Set(["good", "great", "best", "love", "win", "helpful", "amazing", "easy", "success", "better"]);
  const negative = new Set(["bad", "worst", "hate", "hard", "broken", "wrong", "problem", "scam", "confusing", "difficult"]);
  let score = 0;
  for (const token of String(text || "").toLowerCase().split(/[^a-z0-9]+/g)) {
    if (!token) continue;
    if (positive.has(token)) score += 1;
    if (negative.has(token)) score -= 1;
  }
  if (score > 0) return "positive";
  if (score < 0) return "negative";
  return "neutral";
}

function sentimentByTimestamp(segments) {
  return (segments || [])
    .slice(0, 120)
    .map((s) => ({
      timestamp: s.start || null,
      sentiment: sentimentForText(s.text || ""),
    }));
}

function commentThemes(comments, max = 8) {
  const all = (comments || []).map((c) => c.text || "").join(" ");
  return uniqWords(all, max);
}

function isQuestion(text) {
  return /\?/.test(String(text || ""));
}

function isSurpriseClaim(text) {
  return /\b(secret|nobody tells you|you won't believe|shocking|crazy|insane|never|always|instantly|guaranteed)\b/i.test(String(text || ""));
}

function firstEventTime(segments, predicate) {
  for (const s of segments || []) {
    if (predicate(s.text || "")) return s.start || null;
  }
  return null;
}

function classifyHookType(hookText) {
  const t = String(hookText || "").toLowerCase();
  if (!t) return "unknown";
  if (/\b(wait|what if|guess|did you know|ever wondered)\b/.test(t)) return "curiosity";
  if (/\b(proven|expert|years|studies|data|official)\b/.test(t)) return "authority";
  if (/\b(new|first|never seen|novel|different)\b/.test(t)) return "novelty";
  if (/\b(shock|crazy|insane|unbelievable|scary)\b/.test(t)) return "shock";
  if (/\b(save|earn|improve|benefit|get more|faster)\b/.test(t)) return "direct benefit";
  if (/\b(wrong|myth|everyone says|actually)\b/.test(t)) return "contrarian";
  if (/\b(now|today|before it's too late|hurry|urgent)\b/.test(t)) return "urgency";
  return "curiosity";
}

function summarizeHookPhrase(segments) {
  const hookWindow = (segments || [])
    .filter((s) => {
      const sec = timestampToSeconds(s.start);
      return sec !== null && sec <= 8;
    })
    .map((s) => s.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return hookWindow ? hookWindow.slice(0, 180) : "";
}

function extractSceneBoundaries(durationSec, sceneChangeCount) {
  if (!durationSec || sceneChangeCount <= 0) return [];
  const step = durationSec / (sceneChangeCount + 1);
  const boundaries = [];
  for (let i = 1; i <= sceneChangeCount; i++) {
    boundaries.push(Number((i * step).toFixed(2)));
  }
  return boundaries;
}

function transitionDensityPer10s(durationSec, sceneChangeCount) {
  if (!durationSec || durationSec <= 0) return 0;
  return Number(((sceneChangeCount / durationSec) * 10).toFixed(3));
}

function averageShotLength(durationSec, sceneChangeCount) {
  if (!durationSec || durationSec <= 0) return null;
  return Number((durationSec / (sceneChangeCount + 1)).toFixed(3));
}

function captionChangeRate(durationSec, transcriptSegments) {
  if (!durationSec || durationSec <= 0) return 0;
  return Number((((transcriptSegments || []).length / durationSec) * 10).toFixed(3));
}

function estimateWordTimestamps(segments, maxWords = 300) {
  const out = [];
  for (const s of segments || []) {
    if (out.length >= maxWords) break;
    const words = String(s.text || "").trim().split(/\s+/g).filter(Boolean);
    const start = timestampToSeconds(s.start);
    const end = timestampToSeconds(s.end);
    if (!words.length || start === null || end === null || end <= start) continue;
    const step = (end - start) / words.length;
    for (let i = 0; i < words.length; i++) {
      out.push({
        word: words[i],
        start: Number((start + i * step).toFixed(3)),
      });
      if (out.length >= maxWords) break;
    }
  }
  return out;
}

function buildSpeakerSegments(segments, max = 120) {
  return (segments || []).slice(0, max).map((s) => ({
    speaker: "unknown",
    start: s.start || null,
    end: s.end || null,
    text: String(s.text || "").slice(0, 180),
  }));
}

function fetchCaptionViaTimedText(videoId) {
  const urls = [
    `https://www.youtube.com/api/timedtext?lang=en&v=${videoId}&fmt=vtt`,
    `https://www.youtube.com/api/timedtext?lang=en&kind=asr&v=${videoId}&fmt=vtt`,
  ];

  return new Promise((resolve) => {
    const tryOne = (idx) => {
      if (idx >= urls.length) return resolve(null);
      https
        .get(urls[idx], { headers: { "User-Agent": "claw-architect-yt-indexer/1.0" } }, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (d) => (body += d));
          res.on("end", () => {
            if (res.statusCode === 200 && body && body.includes("-->")) return resolve(body);
            return tryOne(idx + 1);
          });
        })
        .on("error", () => tryOne(idx + 1));
    };
    tryOne(0);
  });
}

function collectMetadata(url) {
  // yt-dlp JSON is our highest-fidelity metadata path and stays stable across most YouTube surface changes.
  const raw = run("yt-dlp", ["-J", "--skip-download", url]);
  const j = JSON.parse(raw);
  return {
    id: j.id || null,
    title: j.title || null,
    description: j.description || null,
    channel: j.channel || j.uploader || null,
    duration: j.duration || null,
    view_count: j.view_count || null,
    like_count: j.like_count || null,
    upload_date: j.upload_date || null,
    webpage_url: j.webpage_url || url,
    thumbnail: j.thumbnail || null,
    tags: Array.isArray(j.tags) ? j.tags.slice(0, 40) : [],
  };
}

function extractCommentsWithYtDlp(url, tempDir, videoId, maxTopComments = 100) {
  run("yt-dlp", [
    "--skip-download",
    "--write-comments",
    "--write-info-json",
    "--no-clean-infojson",
    "-o", path.join(tempDir, "%(id)s.%(ext)s"),
    url,
  ]);
  const infoFile = fs.readdirSync(tempDir).find((f) => f.startsWith(videoId) && f.endsWith(".info.json"));
  if (!infoFile) return { total: 0, top_comments: [] };
  const info = JSON.parse(fs.readFileSync(path.join(tempDir, infoFile), "utf8"));
  const comments = Array.isArray(info.comments) ? info.comments : [];
  const mapped = comments.map((c) => ({
    id: c.id || null,
    author: c.author || c.author_id || null,
    text: String(c.text || "").replace(/\s+/g, " ").trim(),
    like_count: Number(c.like_count || 0),
    reply_count: Number(c.reply_count || 0),
    timestamp: c.timestamp ? new Date(c.timestamp * 1000).toISOString() : null,
  }));
  const topComments = mapped
    .filter((c) => c.text)
    .sort((a, b) => b.like_count - a.like_count)
    .slice(0, maxTopComments);
  return {
    total: comments.length,
    top_comments: topComments,
  };
}

function extractTranscriptWithYtDlp(url, tempDir, videoId) {
  run("yt-dlp", [
    "--skip-download",
    "--write-subs",
    "--write-auto-subs",
    "--sub-langs", "en.*,en",
    "--sub-format", "vtt",
    "-o", path.join(tempDir, "%(id)s.%(ext)s"),
    url,
  ]);
  const files = fs.readdirSync(tempDir).filter((f) => f.startsWith(videoId) && f.endsWith(".vtt"));
  if (!files.length) return null;
  const candidate = files.find((f) => /\.en\./.test(f)) || files[0];
  return fs.readFileSync(path.join(tempDir, candidate), "utf8");
}

function downloadVideoForAnalysis(url, tempDir, videoId, maxSeconds = 180) {
  const outPattern = path.join(tempDir, "video.%(ext)s");
  const section = `*0-${Math.min(maxSeconds, 300)}`;
  run("yt-dlp", ["--download-sections", section, "-f", "bv*[height<=480]+ba/b[height<=480]/b", "-o", outPattern, url]);
  return fs.readdirSync(tempDir)
    .map((f) => path.join(tempDir, f))
    .find((f) => fs.statSync(f).isFile() && /video\.(mp4|webm|mkv)$/i.test(path.basename(f))) || null;
}

function runHookAnalysisPython(videoPath, outPath, maxDurationSec, rootDir) {
  const pyScript = path.join(rootDir, "scripts", "youtube-hook-analysis.py");
  if (!fs.existsSync(pyScript)) return null;
  const venvPy = path.join(rootDir, ".venv-hook-analysis", "bin", "python3");
  const pyBin = fs.existsSync(venvPy) ? venvPy : (hasBinary("python3") ? "python3" : "python");
  try {
    const { spawnSync } = require("child_process");
    const py = spawnSync(pyBin, ["-u", pyScript, "--video", videoPath, "--out", outPath, "--max-duration", String(maxDurationSec)], {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 600000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (py.status !== 0) return null;
    return JSON.parse(fs.readFileSync(outPath, "utf8"));
  } catch {
    return null;
  }
}

function createKeyshots(url, tempDir, videoId, scene, maxFrames) {
  // Keep extraction window short for predictable run time and disk usage.
  const outPattern = path.join(tempDir, "video.%(ext)s");
  run("yt-dlp", ["--download-sections", "*0-90", "-f", "bv*[height<=480]+ba/b[height<=480]/b", "-o", outPattern, url]);
  const video = fs.readdirSync(tempDir)
    .map((f) => path.join(tempDir, f))
    .find((f) => fs.statSync(f).isFile() && /video\.(mp4|webm|mkv)$/i.test(path.basename(f)));
  if (!video) return [];

  const shotPattern = path.join(tempDir, `${videoId}_shot_%03d.jpg`);
  run("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-i", video,
    "-vf", `select='gt(scene,${scene})',scale=640:-1`,
    "-vsync", "vfr",
    "-frames:v", String(maxFrames),
    shotPattern,
  ]);

  return fs.readdirSync(tempDir)
    .filter((f) => f.startsWith(`${videoId}_shot_`) && f.endsWith(".jpg"))
    .sort()
    .map((f) => path.join(tempDir, f));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.join(__dirname, "..");
  const urlsFile = args.urlsFile || (args.urls.length ? null : path.join(root, "data", "youtube-urls.txt"));
  const outPath = args.out || path.join(root, "reports", "youtube-transcript-visual-index-latest.json");
  const outDir = path.dirname(outPath);
  fs.mkdirSync(outDir, { recursive: true });

  const inputUrls = [...args.urls, ...readUrls(urlsFile)];
  const dedup = [...new Set(inputUrls.map((u) => u.trim()).filter(Boolean))];
  const targets = dedup.map((u) => ({ url: u, videoId: parseVideoId(u) })).filter((x) => !!x.videoId);

  const ytdlp = hasBinary("yt-dlp");
  const ffmpeg = hasBinary("ffmpeg");

  if (!targets.length) throw new Error("No valid YouTube URLs or IDs found.");
  if (!ytdlp && !args.dryRun) {
    throw new Error("yt-dlp is required for full indexing. Install it or run --dry-run.");
  }

  const rows = [];
  for (const t of targets) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `ytidx-${t.videoId}-`));
    try {
      const metadata = ytdlp ? collectMetadata(t.url) : { id: t.videoId, webpage_url: t.url };

      let transcriptVtt = null;
      if (ytdlp && !args.dryRun) {
        try { transcriptVtt = extractTranscriptWithYtDlp(t.url, tempDir, t.videoId); } catch {}
      }
      if (!transcriptVtt) {
        transcriptVtt = await fetchCaptionViaTimedText(t.videoId);
      }

      const transcriptSegments = parseVtt(transcriptVtt || "");
      const transcriptText = transcriptSegments.map((s) => s.text).join(" ").trim();
      const keyPhrases = uniqWords(transcriptText, 24);

      const keyshots = (!args.dryRun && ytdlp && ffmpeg && args.keyshots > 0)
        ? createKeyshots(t.url, tempDir, t.videoId, args.scene, args.keyshots)
        : [];

      let videoPath = null;
      if (keyshots.length > 0) {
        videoPath = fs.readdirSync(tempDir)
          .map((f) => path.join(tempDir, f))
          .find((f) => fs.statSync(f).isFile() && /video\.(mp4|webm|mkv)$/i.test(path.basename(f))) || null;
      }
      if (!videoPath && args.fullAnalysis && !args.dryRun && ytdlp && ffmpeg) {
        videoPath = downloadVideoForAnalysis(t.url, tempDir, t.videoId, 180);
      }

      let pyAnalysis = null;
      if (videoPath && args.fullAnalysis && !args.dryRun) {
        const pyOutPath = path.join(tempDir, "hook-analysis.json");
        pyAnalysis = runHookAnalysisPython(videoPath, pyOutPath, 180, path.join(__dirname, ".."));
      }

      const visualSignals = {
        keyshot_count: keyshots.length,
        keyshots,
        thumbnail: metadata.thumbnail || null,
        has_visual_extract: keyshots.length > 0,
      };

      const transcriptSignals = {
        has_transcript: transcriptSegments.length > 0,
        segment_count: transcriptSegments.length,
        text_chars: transcriptText.length,
        top_terms: keyPhrases,
      };

      let commentsData = { total: 0, top_comments: [] };
      if (args.comments && ytdlp && !args.dryRun) {
        try {
          commentsData = extractCommentsWithYtDlp(t.url, tempDir, t.videoId);
        } catch {
          commentsData = { total: 0, top_comments: [] };
        }
      }

      const contentInput = {
        title: metadata.title || null,
        description: metadata.description || null,
        publish_date: metadata.upload_date || null,
        transcript: transcriptText,
        top_comments: commentsData.top_comments,
        comment_themes: commentThemes(commentsData.top_comments),
        hook_summary_30s: summarizeHookFirst30s(transcriptSegments),
        on_screen_topics: [...new Set([...(metadata.tags || []), ...keyPhrases])].slice(0, 16),
        scene_change_count: keyshots.length,
        cta_moments: extractCtaMoments(transcriptSegments),
        sentiment_by_timestamp: sentimentByTimestamp(transcriptSegments),
      };

      const durationSec = Number(metadata.duration || 0) || 0;
      const hookPhrase = summarizeHookPhrase(transcriptSegments);
      const hookType = classifyHookType(hookPhrase);
      const firstQuestionTime = firstEventTime(transcriptSegments, isQuestion);
      const firstSurpriseClaimTime = firstEventTime(transcriptSegments, isSurpriseClaim);
      const sceneBoundaries = extractSceneBoundaries(durationSec, keyshots.length);

      const hookTransitionAnalysis = {
        video_id: t.videoId,
        start_hook_window: {
          s0_5: (transcriptSegments || []).filter((s) => {
            const sec = timestampToSeconds(s.start);
            return sec !== null && sec <= 5;
          }).map((s) => s.text).join(" ").trim(),
          s0_8: (transcriptSegments || []).filter((s) => {
            const sec = timestampToSeconds(s.start);
            return sec !== null && sec <= 8;
          }).map((s) => s.text).join(" ").trim(),
          s0_15: (transcriptSegments || []).filter((s) => {
            const sec = timestampToSeconds(s.start);
            return sec !== null && sec <= 15;
          }).map((s) => s.text).join(" ").trim(),
        },
        word_timestamps: (pyAnalysis?.word_timestamps?.length ? pyAnalysis.word_timestamps : null) || estimateWordTimestamps(transcriptSegments),
        speaker_segments: (pyAnalysis?.speaker_segments?.length ? pyAnalysis.speaker_segments : null) || buildSpeakerSegments(transcriptSegments),
        scene_boundaries: (pyAnalysis?.scene_boundaries?.length ? pyAnalysis.scene_boundaries : null) || sceneBoundaries,
        transition_density_per_10s: pyAnalysis?.transition_density_per_10s ?? transitionDensityPer10s(durationSec, keyshots.length),
        on_screen_text: pyAnalysis?.on_screen_text?.length ? pyAnalysis.on_screen_text : [],
        first_question_time: firstQuestionTime,
        first_surprise_claim_time: firstSurpriseClaimTime,
        caption_change_rate: captionChangeRate(durationSec, transcriptSegments),
        average_shot_length: pyAnalysis?.average_shot_length ?? averageShotLength(durationSec, keyshots.length),
        hard_cut_count: pyAnalysis?.hard_cut_count ?? keyshots.length,
        fade_count: pyAnalysis?.fade_count ?? 0,
        hook_phrase: hookPhrase,
        hook_type: hookType,
      };

      const pipelineCoverage = {
        capture_download: ytdlp,
        segment_shots_transitions: (pyAnalysis?.pipeline_coverage?.segment_shots) ?? (ffmpeg && args.keyshots > 0),
        transcribe: (pyAnalysis?.pipeline_coverage?.transcribe) ?? (transcriptSegments.length > 0),
        diarize_speakers: pyAnalysis?.pipeline_coverage?.diarize_speakers ?? false,
        ocr_on_screen_text: pyAnalysis?.pipeline_coverage?.ocr_on_screen_text ?? false,
        rank_hooks: hookPhrase.length > 0,
      };

      if (pyAnalysis?.transcript && !transcriptText) {
        contentInput.transcript = pyAnalysis.transcript;
      }
      if (pyAnalysis?.on_screen_text?.length) {
        contentInput.on_screen_topics = [...new Set([...(contentInput.on_screen_topics || []), ...pyAnalysis.on_screen_text.slice(0, 12)])];
      }

      // Weighted for real-world utility: transcript completeness matters most, visuals are next.
      const benchmark = {
        quality_score: Math.round((
          (transcriptSignals.has_transcript ? 55 : 0)
          + Math.min(25, transcriptSignals.segment_count / 6)
          + Math.min(20, visualSignals.keyshot_count * 4)
        ) * 100) / 100,
        gates: {
          transcript_present: transcriptSignals.has_transcript,
          visuals_present: visualSignals.has_visual_extract,
        },
      };

      rows.push({
        video_id: t.videoId,
        url: metadata.webpage_url || t.url,
        metadata,
        transcript: {
          ...transcriptSignals,
          segments: transcriptSegments.slice(0, 500),
        },
        comments: commentsData,
        visual: visualSignals,
        benchmark,
        content_input: contentInput,
        hook_transition_analysis: hookTransitionAnalysis,
        pipeline_coverage: pipelineCoverage,
      });
    } catch (err) {
      rows.push({ video_id: t.videoId, url: t.url, error: String(err.message || err) });
    } finally {
      try {
        for (const f of fs.readdirSync(tempDir)) {
          const abs = path.join(tempDir, f);
          if (fs.statSync(abs).isFile()) fs.unlinkSync(abs);
        }
        fs.rmdirSync(tempDir);
      } catch {}
    }
  }

  const summary = {
    generated_at: new Date().toISOString(),
    source_mode: { ytdlp, ffmpeg, dry_run: args.dryRun, comments: args.comments, full_analysis: args.fullAnalysis },
    counts: {
      requested: targets.length,
      indexed: rows.filter((r) => !r.error).length,
      failed: rows.filter((r) => !!r.error).length,
      with_transcript: rows.filter((r) => r.transcript?.has_transcript).length,
      with_visuals: rows.filter((r) => r.visual?.has_visual_extract).length,
      with_comments: rows.filter((r) => (r.comments?.total || 0) > 0).length,
    },
    top_ranked: rows
      .filter((r) => !r.error)
      .sort((a, b) => (b.benchmark?.quality_score || 0) - (a.benchmark?.quality_score || 0))
      .slice(0, 10)
      .map((r) => ({ video_id: r.video_id, title: r.metadata?.title || null, quality_score: r.benchmark?.quality_score || 0 })),
  };

  const payload = { summary, rows };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`youtube_transcript_visual_index complete: ${outPath}`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(`youtube_transcript_visual_index failed: ${err.message}`);
  process.exit(1);
});
