# PayClaw — Full Build Spec (Mac DMG app powered by OpenClaw-lite)

**Canonical build specification for creators and the PayClaw swarm.**  
Source: OpenClaw overseer. Do not invent features outside this spec.

**Code source:** The **autopay_ui** repo (https://github.com/jamonwidit/autopay_ui) has most of what PayClaw needs — Stripe, Telnyx, webhooks, message flow. Copy and adapt from `~/claw-repos/autopay_ui`; may need cleanup (single-tenant, desktop-only). See `docs/SOURCES.md`.

---

## 0) What PayClaw is (tight scope)

PayClaw is a Mac desktop app for small businesses to collect payment on recent invoices via email + SMS with a Stripe pay link and Telnyx messaging—with hard guardrails so they can't spam.

### Non-negotiables

- **You (PayClaw) control** Telnyx + 10DLC campaign(s) + messaging rules.
- **Customer only provides:** business identity, recipients, invoice info, schedule preferences, Stripe Connect account.
- **The product is invoice payment collection, not "debt collection."**

---

## 1) Compliance + eligibility rules (for approvals + safety)

### Business eligibility (onboarding disqualifier)

Add a "Business type" picker with an explicit restricted list. If any match → hard block.

**Auto-reject categories (examples):**

- Debt collection agencies / debt buyers / collections law firms
- Payday loans / title loans
- Gambling, adult, firearms, controlled substances
- "Lead gen" for restricted verticals
- Political messaging

**Use:** `config/payclaw/risk-categories.json` (canonical list).

### Required checkbox attestations

1. "I only message people who have an existing business relationship with me."
2. "These messages are for invoices under 45 days old."
3. "This is not debt collection."
4. "Recipients can opt out (STOP)."
5. "I will not upload purchased lists."

Store attestation with timestamp and business type selected.

### Required message content (always)

Every SMS must include:

- Business name
- "Invoice" context
- Link to Stripe invoice/checkout
- Opt-out instruction (STOP)
- HELP keyword support

**Example compliant SMS (template):**

```
{{BUSINESS_NAME}}: Invoice {{INVOICE_ID}} for ${{AMOUNT}} is due. Pay here: {{SHORT_LINK}} Reply STOP to opt out. HELP for help.
```

### 10DLC cost realities (Telnyx)

Telnyx publishes pass-through 10DLC fees and carrier message fees. Key ones: brand application fee, campaign review fee, monthly campaign fees, and per-message carrier fees. Design guardrails so customers can't trigger compliance fines.

**Important implication:** You don't want "every customer gets their own brand+campaign" unless your pricing model supports it. One PayClaw umbrella brand/campaign covers all numbers; merchants do not register their own.

---

## 2) Pricing model (simple, profitable, defensible)

### Plan: PayClaw Number Seat

- **$25/mo per number** (includes software seat + scheduling + compliance guardrails)
- Includes one credit pack (or let them choose)
- Additional credit packs optional

### Credit packs

- **Starter:** 500 SMS included
- **Growth:** 2,000 SMS included
- **Pro:** 10,000 SMS included
- **Overage:** $0.03/SMS (or $0.02 at Pro tier)

### Hard caps (anti-spam & cost control)

- **Daily max sends per number** (default 100/day; configurable but capped)
- **Hourly cap**
- **Quiet hours** by recipient timezone

### Revenue expansion

- **Stripe Connect take-rate:** e.g. 1% + $0.30 (or flat platform fee per paid invoice)
- Optional add-on: "skip tracing / enrichment" (later)

---

## 3) Messaging workflow (exact flows)

### Core objects (data model)

- **CustomerAccount**
- **StripeConnectAccount** (connected)
- **MessagingNumber** (PayClaw-controlled Telnyx number; assigned to customer)
- **Recipient** (name, phone, email, timezone guess)
- **Invoice** (id, amount, due date, created date, status, stripe_link)
- **MessagePlan** (schedule, cadence, channel mix)
- **MessageSend** (audit row: when, to, result, carrier status, cost)
- **OptOut** (phone-level global opt-out + per-business opt-out)

### Flow A — import recipients + invoices

1. Customer uploads CSV (name, phone, email, amount, invoice_id, invoice_date)
2. App validates:
   - invoice_date <= 45 days
   - phone format
   - duplicates
   - restricted keywords in "notes" fields (optional)
3. Customer picks schedule:
   - "Polite 3-touch" (Day 0 SMS, Day 2 email, Day 5 SMS)
   - "Firmer 5-touch"
4. App shows preview of all messages before enabling "Start campaign"

### Flow B — sending rules (guardrails-first)

Always obey:

- timezone quiet hours
- daily/hourly cap
- global opt-outs
- per-recipient max touches per week
- Always include STOP/HELP language in SMS
- If link domain flagged → stop campaign automatically (anti-phishing safeguard)

### Flow C — payment + reconciliation

- Stripe webhook events update invoice status:
  - **paid** → mark green ✅
  - **partially paid** → yellow ⚠️
  - **overdue/unpaid** after X days → red ⛔ (stop at 45 days)
- App dashboard updates in near real-time

---

## 4) Mac app UI (every page + key controls)

### A) Welcome / onboarding

- **Page 1 — What PayClaw does:** "Collect invoice payments via compliant SMS/email" / "Not for debt collection" / Next
- **Page 2 — Eligibility:** Business type dropdown + auto-reject rules / Attestation checkboxes (invoice <45 days, etc.)
- **Page 3 — Stripe Connect:** "Connect your Stripe account" / OAuth connect button (embedded webview) / Status: Connected / Not connected
- **Page 4 — Phone number:** "Choose your PayClaw number" / Show assigned number(s) + status / "Select from available numbers" / Transparent billing: "$25/mo per number seat"
- **Page 5 — Defaults:** Default sending window (e.g. 9am–6pm recipient local) / Daily cap selector (default 50/day) / Tone (Polite / Standard / Firm) / Done

### B) Main app layout (sidebar)

1. Dashboard
2. Campaigns
3. Invoices
4. Recipients
5. Messages
6. Settings
7. Support / Compliance

### 1) Dashboard

**Top cards:** Sent Today | Paid Today | Outstanding $ | Opt-outs today

**Main table (by invoice):**

| Recipient | Amount | Status pill (green/yellow/red) | Last sent | Next scheduled | Paid timestamp | Actions |

**Status logic:**

- **Green:** paid
- **Yellow:** sent but not paid, within schedule window
- **Red:** invoice aging near 45 days OR multiple touches without response (still within policy)

### 2) Campaigns

- Create new campaign
- Choose template (3-touch, 5-touch, etc.)
- Upload CSV
- Preview messages
- Start / Pause / Stop
- "Stop automatically at 45 days"

### 3) Invoices

- List/search
- Invoice detail view: timeline of touches, stripe link
- Manual "mark paid" disabled unless webhook (avoid fraud)

### 4) Recipients

- Per-recipient history
- Opt-out status
- "Never message again" button (writes opt-out)

### 5) Messages (audit + deliverability)

Timeline: timestamp, channel, to, template, status, carrier result, cost  
Filters: failed only, undelivered, opted out

### 6) Settings

- **Billing:** number seats, credit packs, overage pricing
- **Scheduling:** quiet hours, daily caps
- **Compliance:** business name, support email, opt-out keywords
- **Integrations:** Stripe connected status (readonly), Telnyx (hidden/locked)

### 7) Support / Compliance

- "Approved Use" quick doc
- "Opt-out / complaints" handling
- Export audit logs (CSV)

---

## 5) "OpenClaw-lite" runtime inside PayClaw

Inside the DMG you ship:

- **PayClaw.app** (SwiftUI shell)
- **Local backend service** (Node/Go/Python) embedded + launched as a LaunchAgent
- **Local SQLite** for UI state (fast)
- **Remote Postgres** (optional) for centralized ops + telemetry + reconciliation
- **Remote job runner** (optional) or local BullMQ/Redis—not ideal on customer machines unless needed

### Strong recommendation for "lite"

**Don't ship the full distributed OpenClaw orchestration to customer Macs.**

Ship a single-purpose deterministic engine:

- schedule generator
- send worker
- webhook listener
- policy gate

Keep "AI" out of the customer runtime by default (or use only for copy suggestions with strict templates).

---

## 6) Guardrails & limitations

### Must-have guardrails

- Hard daily cap per number (cannot be raised above your max)
- Hard hourly cap
- Per-recipient cap (e.g. max 1 SMS/day, max 3/week)
- Mandatory quiet hours by recipient timezone
- Global opt-out registry stored centrally (reinstall can't bypass)
- Template-only messages (no freeform texting)
- Invoice age enforcement (cutoff at 45 days)
- Approved link domains only (Stripe domain + approved redirect)
- Complaint kill switch (opt-out rate spikes or carrier flags → auto pause)

### What NOT to include

- No "import any list and blast"
- No freeform "chat" UI to text arbitrary numbers
- No ability to change message body outside approved templates
- No ability to add more numbers without your approval flow

---

## 7) macOS DMG distribution (Apple notarization)

Modern macOS users hit Gatekeeper unless you:

- Sign with Developer ID
- Notarize the app with Apple
- "Staple" the notarization ticket to the app/DMG

Use `notarytool` and stapling. Plan notarization as part of the release pipeline.

---

## 8) Timeline (realistic)

### Phase 1 — "Working desktop MVP"

- SwiftUI shell + embedded backend
- CSV import → schedule → send SMS/email
- Stripe Connect + webhook reconciliation
- Dashboard green/yellow/red + message audit log
- Hard guardrails enforced server-side

### Phase 2 — "Polished DMG + update system"

- Auto-update (Sparkle or similar)
- Notarization pipeline
- Better onboarding + diagnostics

### Phase 3 — "Scale + ops hardening"

- Central policy control, fraud controls
- Abuse detection, deliverability tuning
- Support tooling

---

## References

- `docs/payclaw/COMPLIANCE.md` — 10DLC, attestation, prohibited content
- `config/payclaw/risk-categories.json` — business-type auto-reject list
- `config/payclaw/message-templates.txt` — locked SMS/email templates
- `config/payclaw/attestations.txt` — onboarding checkbox wording
- `.cursor/rules/payclaw-overseer.mdc` — agent rules
