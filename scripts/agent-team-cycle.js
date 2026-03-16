#!/usr/bin/env node
"use strict";

require("dotenv").config();

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  appendAgentDailyLog,
  buildLearnedFromText,
  extractTextMetrics,
} = require("../control/agent-memory");

const ROOT = path.join(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config", "agent-team.json");
const REPORT_DIR = path.join(ROOT, "scripts", "reports");
const NOTES_ROOT = path.join(os.homedir(), "notes", "agents");
const SHARED_DIR = path.join(NOTES_ROOT, "shared-context");
const SESSIONS_DIR = path.join(NOTES_ROOT, "sessions");
const STATE_ROOT = path.join(ROOT, "agent-state");

const args = process.argv.slice(2);

function arg(flag, fallback = null) {
  const i = args.indexOf(flag);
  return i >= 0 ? (args[i + 1] || fallback) : fallback;
}

function has(flag) {
  return args.includes(flag);
}

function nowIso() {
  return new Date().toISOString();
}

function dateKey(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function latestReport(suffix) {
  if (!fs.existsSync(REPORT_DIR)) return null;
  const files = fs.readdirSync(REPORT_DIR).filter((f) => f.endsWith(suffix)).sort();
  if (!files.length) return null;
  return path.join(REPORT_DIR, files[files.length - 1]);
}

function runCommand(cmd) {
  const res = spawnSync("bash", ["-lc", cmd], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
    timeout: 900000,
  });
  return {
    ok: Number(res.status || 0) === 0,
    code: Number(res.status || 0),
    stdout: String(res.stdout || "").trim().slice(-1200),
    stderr: String(res.stderr || "").trim().slice(-1200),
    command: cmd,
  };
}

function loadConfig() {
  const cfg = readJson(CONFIG_PATH, []);
  if (!Array.isArray(cfg) || !cfg.length) {
    throw new Error("config/agent-team.json must be a non-empty array");
  }
  return cfg;
}

function initWorkspace(agents) {
  ensureDir(NOTES_ROOT);
  ensureDir(SHARED_DIR);
  ensureDir(SESSIONS_DIR);

  const ownerMap = {};
  for (const a of agents) ownerMap[a.writer_file] = a.id;

  const ownershipPath = path.join(SHARED_DIR, "OWNERSHIP.json");
  fs.writeFileSync(ownershipPath, JSON.stringify(ownerMap, null, 2));

  for (const a of agents) {
    const writerPath = path.join(SHARED_DIR, a.writer_file);
    if (!fs.existsSync(writerPath)) {
      fs.writeFileSync(
        writerPath,
        `# ${a.writer_file}\n\n- owner: ${a.id}\n- rule: one writer per file\n- created_at: ${nowIso()}\n\n`
      );
    }

    const sessionDir = path.join(SESSIONS_DIR, a.session_folder || a.id);
    ensureDir(sessionDir);
    const sessionFile = path.join(sessionDir, "SESSION.md");
    if (!fs.existsSync(sessionFile)) {
      fs.writeFileSync(
        sessionFile,
        `# Session - ${a.name}\n\n- agent_id: ${a.id}\n- writes_to: ${a.writer_file}\n- cron: ${a.cron}\n- created_at: ${nowIso()}\n\n`
      );
    }
  }
}

function initAgentState(agents) {
  const userPath = path.join(STATE_ROOT, "USER.md");
  ensureDir(path.dirname(userPath));
  if (!fs.existsSync(userPath)) {
    fs.writeFileSync(
      userPath,
      "# USER\n\n- owner: <USER>\n- preference: concise actionable updates\n- non-negotiable: no destructive actions without explicit approval\n\n"
    );
  }

  const feedbackPath = path.join(STATE_ROOT, "shared-context", "FEEDBACK-LOG.md");
  ensureDir(path.dirname(feedbackPath));
  if (!fs.existsSync(feedbackPath)) {
    fs.writeFileSync(feedbackPath, "# Feedback Log\n\n");
  }

  for (const a of agents) {
    const dir = path.join(STATE_ROOT, "agents", a.id);
    const memoryDir = path.join(dir, "memory");
    ensureDir(memoryDir);

    const soulPath = path.join(dir, "SOUL.md");
    if (!fs.existsSync(soulPath)) {
      fs.writeFileSync(
        soulPath,
        `# ${a.name} Soul\n\n- mission: keep ${a.writer_file} current and useful.\n- operating mode: deterministic first, then constrained synthesis.\n- non-goal: placeholder updates with no evidence.\n- success: each run appends concrete outcomes, blockers, and next actions.\n`
      );
    }

    const memPath = path.join(dir, "MEMORY.md");
    if (!fs.existsSync(memPath)) {
      fs.writeFileSync(
        memPath,
        `# ${a.name} Memory\n\n- keep durable rules and recurrent fixes here\n- promote repeated daily findings into this file weekly\n`
      );
    }

    const agentsPath = path.join(dir, "AGENTS.md");
    if (!fs.existsSync(agentsPath)) {
      fs.writeFileSync(
        agentsPath,
        `# ${a.name} Runbook\n\n- one writer file: ${a.writer_file}\n- cron target: ${a.cron}\n- refresh command: ${a.refresh_command || "none"}\n`
      );
    }
  }
}

function loadSignalPack() {
  const week = latestReport("-saas-opportunity-research.json");
  const affiliate = latestReport("-affiliate-rollout-research.json");
  const pain = latestReport("-saas-pain-opportunity-report.json");
  const security = latestReport("-security-runtime.json");
  const redgreen = latestReport("-global-redgreen-status.json");
  const weeklyBrief = path.join(os.homedir(), "notes", "briefs", "weekly");
  const weeklyFile = fs.existsSync(weeklyBrief)
    ? fs.readdirSync(weeklyBrief).filter((f) => f.endsWith(".md")).sort().pop()
    : null;

  return {
    weekPath: week,
    affiliatePath: affiliate,
    painPath: pain,
    securityPath: security,
    redgreenPath: redgreen,
    weeklyBriefPath: weeklyFile ? path.join(weeklyBrief, weeklyFile) : null,
    week: readJson(week, {}),
    affiliate: readJson(affiliate, {}),
    pain: readJson(pain, {}),
    security: readJson(security, {}),
    redgreen: readJson(redgreen, {}),
  };
}

function makeContent(agent, signalPack) {
  const topSaas = Array.isArray(signalPack.week?.top) ? signalPack.week.top.slice(0, 3) : [];
  const painPoints = Array.isArray(signalPack.pain?.top_pain_points) ? signalPack.pain.top_pain_points.slice(0, 3) : [];
  const affiliateActions = Array.isArray(signalPack.affiliate?.recommended_next_actions)
    ? signalPack.affiliate.recommended_next_actions.slice(0, 3)
    : [];
  const lines = [];

  lines.push(`## ${nowIso()}`);
  lines.push(`- agent: ${agent.id}`);

  if (agent.id === "pa_coordinator") {
    lines.push("- summary: Daily coordination brief generated.");
    lines.push("- focus_today:");
    lines.push("  - Review latest weekly brief and assign top 3 execution items.");
    lines.push("  - Confirm team lanes posted updates to their owned files.");
    lines.push("  - Escalate any blocker in SECURITY_STATUS.md or SHIP_LOG.md.");
  } else if (agent.id === "x_growth") {
    lines.push("- summary: X draft queue updated.");
    topSaas.forEach((x, i) => {
      lines.push(`- draft_${i + 1}: Build-in-public angle on ${x.id} (score ${x.total_score || "n/a"})`);
    });
    if (!topSaas.length) lines.push("- draft_1: Share one practical AI+SaaS lesson with a concrete workflow.");
  } else if (agent.id === "opportunities_scout") {
    lines.push("- summary: Opportunity shortlist refreshed.");
    topSaas.forEach((x, i) => {
      lines.push(`- opp_${i + 1}: ${x.id} | rec=${x.recommendation || "n/a"} | total=${x.total_score || "n/a"}`);
    });
    painPoints.forEach((p, i) => lines.push(`- pain_${i + 1}: ${(p.summary || p.key || "unknown")} (freq ${p.frequency || 0})`));
  } else if (agent.id === "trading_paper") {
    lines.push("- summary: Paper-trading lane check-in completed.");
    lines.push("- guardrail: NO live-money actions. Paper mode only.");
    lines.push("- next: run signal scan and execute paper cycle with explicit logs.");
  } else if (agent.id === "security_monitor") {
    lines.push("- summary: Security monitor status updated.");
    const failed = Number(signalPack.security?.summary?.checks_failed || 0);
    lines.push(`- runtime_checks_failed: ${failed}`);
    lines.push(`- runtime_status: ${signalPack.security?.summary?.status || "unknown"}`);
  } else if (agent.id === "builder") {
    lines.push("- summary: Build/ship lane updated.");
    affiliateActions.forEach((a, i) => lines.push(`- ship_item_${i + 1}: ${a}`));
    if (!affiliateActions.length) lines.push("- ship_item_1: no fresh affiliate actions found in current report.");
  } else {
    lines.push("- summary: generic team update.");
  }

  lines.push("- sources:");
  [
    signalPack.weekPath,
    signalPack.painPath,
    signalPack.affiliatePath,
    signalPack.weeklyBriefPath,
    signalPack.securityPath,
    signalPack.redgreenPath,
  ].filter(Boolean).forEach((s) => lines.push(`  - ${s}`));
  lines.push("");
  return lines.join("\n");
}

function appendOwnedFile(agent, content) {
  const ownership = readJson(path.join(SHARED_DIR, "OWNERSHIP.json"), {});
  if (!ownership[agent.writer_file]) throw new Error(`writer file not registered: ${agent.writer_file}`);
  if (ownership[agent.writer_file] !== agent.id) {
    throw new Error(`one-writer rule violation: ${agent.id} cannot write ${agent.writer_file}`);
  }
  const writerPath = path.join(SHARED_DIR, agent.writer_file);
  fs.appendFileSync(writerPath, content);
  return writerPath;
}

function appendSessionLog(agent, writerPath, cmdResult) {
  const sessionDir = path.join(SESSIONS_DIR, agent.session_folder || agent.id);
  ensureDir(sessionDir);
  const runLog = path.join(sessionDir, `${dateKey()}-runs.md`);
  const lines = [];
  lines.push(`## ${nowIso()}`);
  lines.push(`- writes_to: ${writerPath}`);
  if (cmdResult) {
    lines.push(`- refresh_command: ${cmdResult.command}`);
    lines.push(`- refresh_ok: ${cmdResult.ok}`);
    lines.push(`- refresh_code: ${cmdResult.code}`);
    if (!cmdResult.ok && cmdResult.stderr) lines.push(`- refresh_error: ${cmdResult.stderr.replace(/\n/g, " ").slice(0, 400)}`);
  }
  lines.push("");
  fs.appendFileSync(runLog, `${lines.join("\n")}\n`);
}

async function sendTelegramSummary(agents) {
  // Telegram notifications disabled by default; do not send to operator.
  if (String(process.env.NOTIFY_TELEGRAM_ENABLED || "0").trim() !== "1") {
    return { sent: false, reason: "telegram_notifications_disabled" };
  }
  const token = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = String(process.env.TELEGRAM_MONITORING_CHAT_ID || process.env.TELEGRAM_CHAT_ID || "").trim();
  if (!token || !chatId) {
    return { sent: false, reason: "telegram_not_configured" };
  }

  const lines = [];
  lines.push("Agent Team Update (links only)");
  for (const a of agents) {
    const writerPath = path.join(SHARED_DIR, a.writer_file);
    lines.push(`- ${a.name}: ${writerPath}`);
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: lines.join("\n"),
      disable_web_page_preview: true,
    }),
  });
  const data = await res.json().catch(() => ({}));
  return { sent: Boolean(data.ok), status: res.status, detail: data.description || null };
}

async function main() {
  const config = loadConfig();
  initWorkspace(config);
  initAgentState(config);
  const selected = String(arg("--agent", "")).trim().toLowerCase();
  const doAll = has("--all");
  const doRefresh = has("--refresh");
  const sendTelegram = has("--telegram-summary");

  const targets = doAll ? config : config.filter((a) => a.id === selected);
  if (!targets.length) {
    throw new Error("no target agents selected. Use --all or --agent <id>");
  }

  const signalPack = loadSignalPack();
  const outputs = [];

  for (const agent of targets) {
    const cmdResult = doRefresh && agent.refresh_command ? runCommand(agent.refresh_command) : null;
    const content = makeContent(agent, signalPack);
    const writerPath = appendOwnedFile(agent, content);
    appendSessionLog(agent, writerPath, cmdResult);
    const metrics = cmdResult
      ? extractTextMetrics(cmdResult.stdout || "", cmdResult.stderr || "").metrics
      : undefined;
    const learned = cmdResult
      ? buildLearnedFromText(cmdResult.stdout || "", cmdResult.stderr || "", agent.id)
      : `Updated ${agent.writer_file} without external refresh command.`;
    await appendAgentDailyLog(agent.id, {
      goal: `${agent.name} writer cycle`,
      task_type: "agent_team_cycle",
      actions_taken: `updated ${agent.writer_file}${cmdResult ? ` via ${agent.refresh_command}` : ""}`,
      summary: `status=${cmdResult ? (cmdResult.ok ? "ok" : "fail") : "ok"} | writer=${agent.writer_file} | refresh=${cmdResult ? cmdResult.code : "n/a"}`,
      learned,
      metrics,
      blocker: cmdResult && !cmdResult.ok ? (cmdResult.stderr || cmdResult.stdout || "refresh_failed").slice(0, 300) : undefined,
      next_focus: cmdResult && !cmdResult.ok ? "repair refresh command and rerun" : `continue scheduled updates for ${agent.writer_file}`,
      tags: [agent.id, "agent-team", "shared-context"],
      model_used: "agent-team-cycle",
      cost_usd: 0,
      open_loops: cmdResult && !cmdResult.ok ? ["refresh command failed; inspect session log and command stderr"] : undefined,
    });
    outputs.push({
      agent: agent.id,
      writer_file: writerPath,
      refresh_ok: cmdResult ? cmdResult.ok : null,
      refresh_code: cmdResult ? cmdResult.code : null,
    });
  }

  let telegram = null;
  if (sendTelegram) telegram = await sendTelegramSummary(targets);

  const out = {
    generated_at: nowIso(),
    notes_root: NOTES_ROOT,
    shared_dir: SHARED_DIR,
    sessions_dir: SESSIONS_DIR,
    updated: outputs,
    telegram,
  };

  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(`[agent-team-cycle] fatal: ${err.message}`);
  process.exit(1);
});
