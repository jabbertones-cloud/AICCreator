# PayClaw Project Context (OpenClaw Overseer)

**Purpose:** Orientation for creators and swarm agents. Claw-architect does **not** build PayClaw; it provides rules, compliance, infrastructure, and an agent swarm that researches, manages, and updates the PayClaw repo so creators can build it quickly and correctly.

## Repo and product

- **PayClaw repo:** https://github.com/jamonwidit/payclaw  
- **Product:** PayClaw Lite — subscription-based macOS desktop app (DMG) for invoice payment collection via email and SMS. Users supply debtor lists, amounts, due dates; system handles outreach and payment processing. **Not** debt collection; invoices under 45 days only.
- **Source system:** PayClaw is essentially a version of **AutopayAgent** (repo **autopay_ui**). The autopay_ui repo has **most of what PayClaw needs** — Stripe checkout & webhooks, Telnyx SMS, signature verification, message flow, dashboard. It may need cleanup (remove multi-tenant auth, simplify to single-tenant desktop), but the core is there. Repo: https://github.com/jamonwidit/autopay_ui ; local path: `~/claw-repos/autopay_ui`. **Copy and adapt; do not rebuild from scratch.** See `docs/SOURCES.md` for exact files and paths.

## Product requirements

- **Summary dashboard:** The program must include a **summary dashboard** where the user can **upload** (e.g. CSV) or **manually add** the list — i.e. debtors/invoices: name, email, phone, invoice number, amount, due date, description. The dashboard should show list summary, status, and support validate/dedupe and invalid-number handling. See compliance and message templates for locked copy; scheduling and send rates are server-controlled.
- **Reporting:** Dashboard should also show invoice statuses, success rates, payments collected, fees; export for audits (per plan).

## Where things live in claw-architect

| What | Location |
|------|----------|
| **Rules** (must follow when working on PayClaw) | `.cursor/rules/payclaw-overseer.mdc` |
| **Compliance** (10DLC, risk categories, attestation, templates) | `docs/payclaw/COMPLIANCE.md`, `config/payclaw/risk-categories.json`, `config/payclaw/message-templates.txt` |
| **Research** (Telnyx, Stripe Connect, DMG; kept current by swarm) | `docs/payclaw/RESEARCH.md` or `agent-state/payclaw-research/` |
| **Launcher** (seed repo, copy compliance, register managed_repos) | `npm run payclaw:launch` → `scripts/payclaw-launch.js` |
| **Update options** (how to push rules/compliance into PayClaw repo) | `docs/payclaw/UPDATE.md` |
| **Distributed build** (all machines contribute, push to git) | `docs/payclaw/DISTRIBUTED-BUILD.md` — run `npm run payclaw:dispatch:chunks` |
| **This context** | `docs/payclaw/CONTEXT.md` |

## How the swarm operates

1. **Research:** Tasks with focus `payclaw` (e.g. research_sync, research_signals) or dedicated research keep PayClaw-specific docs (Telnyx 10DLC, Stripe Connect, Electron DMG) updated in claw-architect. Creators and update flow read these.
2. **Manage:** PayClaw is registered in `managed_repos`. Mission control or a recurring task can run `github_repo_status` / sync for PayClaw and write status (e.g. to `agent-state/payclaw-research/status.md`) so “what’s left” and assignment are visible.
3. **Update:** When rules or compliance change, the swarm can (a) re-run `payclaw:launch` to re-copy compliance/templates into the PayClaw repo, (b) run a `payclaw_sync_rules`-style task to copy `docs/payclaw/*` into PayClaw and commit, or (c) queue opencode_controller with “update PayClaw repo per latest rules/compliance.” The swarm does not write product code; it keeps the repo aligned with rules and info.

## Creators

Humans or agents (e.g. opencode_controller) who implement PayClaw in the PayClaw repo. They use the rules, compliance, and research above. The swarm oversees and equips; it does not replace the builder.
