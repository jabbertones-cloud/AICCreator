const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aicc-media-os-"));
}

function run(args, options = {}) {
  return spawnSync("node", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "pipe",
    ...options,
  });
}

test("disclosure gate passes disclosed Plushtrap virtual creator campaign", () => {
  const dir = tmpDir();
  const campaign = path.join(dir, "campaign.json");
  const out = path.join(dir, "gate.json");
  fs.writeFileSync(
    campaign,
    JSON.stringify({
      variants: [
        {
          id: "v1",
          title: "Mika sample run",
          hook: "We changed one detail.",
          body: "Disclosure: virtual Plushtrap creator. Sample testing in studio.",
          cta: "Save this.",
          description: "AI-assisted Plushtrap story.",
        },
      ],
    })
  );

  const r = run(["scripts/aicc-disclosure-gate.js", "--campaign", campaign, "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(result.ok, true);
  assert.equal(result.failed, 0);
});

test("disclosure gate blocks undisclosed campaign", () => {
  const dir = tmpDir();
  const campaign = path.join(dir, "campaign.json");
  const out = path.join(dir, "gate.json");
  fs.writeFileSync(
    campaign,
    JSON.stringify({
      variants: [
        {
          id: "v1",
          title: "Factory visit",
          body: "We visited supplier floor and this is real customer proof.",
        },
      ],
    })
  );

  const r = run(["scripts/aicc-disclosure-gate.js", "--campaign", campaign, "--out", out]);
  assert.notEqual(r.status, 0);
  const result = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(result.ok, false);
  assert.equal(result.failed, 1);
  assert.match(result.checks[0].failures.join(","), /missing_virtual_creator_disclosure/);
});

test("source ledger gate blocks publish use of assumptions", () => {
  const dir = tmpDir();
  const ledger = path.join(dir, "ledger.jsonl");
  const add = run([
    "scripts/aicc-source-ledger.js",
    "add",
    "--ledger",
    ledger,
    "--claim",
    "Directional trend note",
    "--status",
    "operator_assumption",
    "--allowed-use",
    "publish",
  ]);
  assert.equal(add.status, 0, add.stderr);

  const gate = run(["scripts/aicc-source-ledger.js", "gate", "--ledger", ledger]);
  assert.notEqual(gate.status, 0);
});

test("render queue add and dry-run submit", () => {
  const dir = tmpDir();
  const queue = path.join(dir, "render.jsonl");
  const add = run([
    "scripts/aicc-render-queue.js",
    "add",
    "--queue",
    queue,
    "--shot-type",
    "human_motion",
    "--prompt",
    "Mika virtual Plushtrap creator phone clip",
    "--credits-checked",
  ]);
  assert.equal(add.status, 0, add.stderr);

  const submit = run(["scripts/aicc-render-queue.js", "submit", "--queue", queue, "--dry-run"]);
  assert.equal(submit.status, 0, submit.stderr);
  const rows = fs.readFileSync(queue, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "submitted");
  assert.match(rows[0].external_prompt_id, /^dry:/);
});
