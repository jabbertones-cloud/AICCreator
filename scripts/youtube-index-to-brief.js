#!/usr/bin/env node
"use strict";

/**
 * youtube-index-to-brief.js
 * Reads reports/youtube-transcript-visual-index-latest.json and produces a single
 * builder brief/spec (docs/INAYAN-BUILDER-VIDEO-SPEC.md) from combined transcript
 * text across all videos. Handles empty transcripts (e.g. dry-run or timedtext unavailable).
 *
 * Usage:
 *   node scripts/youtube-index-to-brief.js
 *   node scripts/youtube-index-to-brief.js --in ./reports/youtube-transcript-visual-index-latest.json --out ./docs/INAYAN-BUILDER-VIDEO-SPEC.md
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DEFAULT_IN = path.join(ROOT, "reports", "youtube-transcript-visual-index-latest.json");
const DEFAULT_OUT = path.join(ROOT, "docs", "INAYAN-BUILDER-VIDEO-SPEC.md");

function getArg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  return String(process.argv[i + 1] || "").trim() || fallback;
}

function main() {
  const inPath = getArg("--in", DEFAULT_IN);
  const outPath = getArg("--out", DEFAULT_OUT);

  if (!fs.existsSync(inPath)) {
    console.error(`Input not found: ${inPath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(inPath, "utf8");
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.error(`Invalid JSON: ${inPath}`);
    process.exit(1);
  }

  const rows = Array.isArray(data.rows) ? data.rows : [];
  const summary = data.summary || {};
  const sections = [];

  // 1) Goal (from plan + any transcript hint)
  const allText = rows
    .filter((r) => !r.error)
    .map((r) => {
      if (r.content_input?.transcript) return String(r.content_input.transcript);
      if (r.transcript?.segments?.length) return (r.transcript.segments || []).map((s) => s.text).join(" ");
      return "";
    })
    .join("\n\n");
  const hasTranscript = allText.length > 0;

  sections.push(`# Inayan Builder — Video-derived spec

Generated from YouTube transcript+visual index. Use as the spec/starting point for what Inayan builder should do.

- **Source index:** \`${path.basename(inPath)}\`
- **Generated:** ${new Date().toISOString()}
- **Videos indexed:** ${summary.counts?.indexed ?? rows.length}
- **With transcript:** ${summary.counts?.with_transcript ?? (hasTranscript ? rows.length : 0)}

## Goal

Build and ship **InayanBuilderBot** as a product that:
- Researches Reddit and GitHub for a repo's domain (builder automation, dashboards, auth, payments, etc.).
- Finds similar repos to index, benchmark, and compare.
- Benchmarks the indexed repo (and similar ones) using claw-architect tools (repo-completion-gap, capability-factory, feature-benchmark).
- Compares the app to best-case exemplars and fills gaps (docs, code, or tasks).
- Exposes APIs for Mission Control / builder-gap-pulse: Reddit search, GitHub research, research fusion (magic-run).
- Is continuously improved from real use (builder pulse, repo_autofix, opencode_controller).`);

  // 2) Source video IDs
  sections.push(`## Source video IDs

| Video ID | URL | Title | Has transcript |
|----------|-----|-------|----------------|
`);
  for (const r of rows) {
    const id = r.video_id || "";
    const url = r.url || `https://youtu.be/${id}`;
    const title = r.metadata?.title || "(no title)";
    const hasT = r.transcript?.has_transcript ? "yes" : "no";
    sections.push(`| ${id} | ${url} | ${title} | ${hasT} |`);
  }

  const allCommentThemes = [...new Set(
    rows.flatMap((r) => Array.isArray(r.content_input?.comment_themes) ? r.content_input.comment_themes : [])
  )];
  const allCtaMoments = rows.flatMap((r) => Array.isArray(r.content_input?.cta_moments) ? r.content_input.cta_moments : []);
  const topComments = rows.flatMap((r) => Array.isArray(r.content_input?.top_comments) ? r.content_input.top_comments : [])
    .slice(0, 20);

  // 3) Combined transcript (if any)
  if (hasTranscript) {
    sections.push(`## Combined transcript (excerpt)

Concatenated segment text from all videos with captions. Use for steps, features, and quality bar.

\`\`\`
${allText.slice(0, 50000).replace(/```/g, "`​`​`")}
\`\`\`
`);
  } else {
    sections.push(`## Combined transcript

No transcript text in the index (e.g. dry-run or captions unavailable). Re-run \`npm run youtube:index:auto\` with yt-dlp installed and sufficient disk, or run with \`--keyshots 0\` to get metadata+subs only. Then re-run this script to regenerate the brief with transcript content.
`);
  }

  sections.push(`## Content input intelligence

- **Comment themes:** ${allCommentThemes.length ? allCommentThemes.join(", ") : "(none)"}
- **CTA moments detected:** ${allCtaMoments.length}
- **Top comments captured:** ${topComments.length}
`);

  if (topComments.length) {
    sections.push(`### Top comments (excerpt)

| Author | Likes | Comment |
|--------|-------|---------|
`);
    for (const c of topComments.slice(0, 10)) {
      const author = c.author || "(unknown)";
      const likes = Number(c.like_count || 0);
      const comment = String(c.text || "").replace(/\|/g, "\\|").slice(0, 220);
      sections.push(`| ${author} | ${likes} | ${comment} |`);
    }
  }

  // 4) Steps and features (canonical from plan)
  sections.push(`## Steps (from plan)

1. **Index** — jCodeMunch index_folder for claw-architect and InayanBuilderBot (and similar repos).
2. **Research** — Reddit search + builder research agenda (from rolling gap report).
3. **Benchmark** — repo-completion-gap, capability-factory, feature-benchmark vs exemplars.
4. **Update** — Apply improvements, remove placeholders, fix gaps; queue repo_autofix / opencode_controller as needed.
5. **Integrate** — Document endpoints, env, runbook; Mission Control / builder-gap-pulse can call InayanBuilderBot APIs.

## Features to implement

- **Reddit search API** — Query-driven Reddit research (subreddits, ranking).
- **GitHub research API** — Repo discovery, releases, signals.
- **Research fusion** — Combine Reddit + GitHub into a single research output (magic-run).
- **Runbook and env** — README, RUNBOOK.md, .env.example; clone-and-run friendly.
- **Quality bar** — Align with sections_to_complete where applicable (observability, security_sweep, e2e if relevant).
`);

  const md = sections.join("\n\n");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, md);
  console.log(`Wrote: ${outPath}`);

  const jsonPath = getArg("--json", null);
  if (jsonPath) {
    const manifest = {
      generated_at: new Date().toISOString(),
      brief_path: outPath,
      source_index: inPath,
      video_count: rows.length,
      source_video_ids: rows.map((r) => r.video_id).filter(Boolean),
      with_transcript: summary.counts?.with_transcript ?? rows.filter((r) => r.transcript?.has_transcript).length,
      goal: "Build and ship InayanBuilderBot; research Reddit/GitHub; expose APIs; content creator pipeline.",
    };
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(manifest, null, 2));
    console.log(`Wrote: ${jsonPath}`);
  }
}

main();
