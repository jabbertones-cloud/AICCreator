# PayClaw — Code Sources to Copy and Learn From

**For agents and creators.** This document tells you exactly where to find code to copy, adapt, and learn from when building PayClaw. Use explicit paths; OpenClaw knows these repos.

---

## Primary source: autopay_ui (AutopayAgent)

**The `autopay_ui` repo has most of what PayClaw needs.** Stripe checkout/webhooks, Telnyx SMS, message flow, dashboard, and credit logic are already implemented. It may need cleanup (remove multi-tenant auth, simplify to single-tenant desktop), but the core is there. Clone it from claw-repos or the git repo below; copy and adapt rather than rebuilding from scratch.

- **Git repo:** https://github.com/jamonwidit/autopay_ui  
- **Local path:** `~/claw-repos/autopay_ui` (or `$REPOS_BASE_PATH/autopay_ui`)

---

## 1. Git Repos (local paths)

Base path: `$REPOS_BASE_PATH` or `~/claw-repos` (default).

| Repo | Local Path | What to copy |
|------|------------|--------------|
| **autopay_ui** (AutopayAgent) | `~/claw-repos/autopay_ui` | Stripe, Telnyx, webhooks, message flow, dashboard |
| **payclaw** (this product) | `~/claw-repos/payclaw` | Where you build; gets compliance from claw-architect |

Use `process.env.REPOS_BASE_PATH || path.join(os.homedir(), 'claw-repos')` when resolving paths in scripts.

---

## 2. AutopayAgent (autopay_ui) — Files to Copy From

**Path:** `~/claw-repos/autopay_ui` (or `$REPOS_BASE_PATH/autopay_ui`)

### Backend / payment logic (copy and adapt)

| File | Purpose |
|------|---------|
| `text-to-pay-endpoints.js` | API routes for payment requests, Stripe, webhooks |
| `text-to-pay-sms-service.js` | Telnyx SMS sending |
| `text-to-pay-app.js` | Main app wiring |
| `text-to-pay-pricing.js` | Credit/pricing logic |
| `server/` | Express routes, Stripe Connect, DB |
| `databases/` | Schema, migrations |

### Frontend (learn structure; PayClaw may use SwiftUI or Electron)

| Path | Purpose |
|------|---------|
| `client/` | React dashboard — CSV upload, invoice list, status, scheduling |
| `public/` | Static assets |

### What NOT to copy from autopay_ui

- Multi-tenant auth, JWT, user signup
- Anything that assumes multiple merchants in one DB — PayClaw is single-tenant desktop

---

## 3. Swift / Mac Shell References

### In claw-repos

- **glitch-app:** `~/claw-repos/glitch-app` — Has Swift in `node_modules/expo-*` (Expo modules). Not ideal for learning Mac shell patterns; useful only if using React Native/Expo.

### External (learn from, don't copy)

- **Apple SwiftUI:** https://developer.apple.com/documentation/swiftui
- **SwiftUI Mac app tutorial:** https://developer.apple.com/tutorials/swiftui
- **DMG + notarization:** `notarytool`, `xcrun stapler` — see `docs/payclaw/SPEC.md` §7
- **Electron alternative:** If you wrap autopay_ui's React client in Electron instead of SwiftUI, see `electron-builder` for DMG packaging.

### SPEC recommendation

`docs/payclaw/SPEC.md` §5: PayClaw.app (SwiftUI shell) + embedded Node backend as LaunchAgent. Use autopay_ui's **backend logic** (Stripe, Telnyx, scheduling) and build a **native SwiftUI** shell, or ship **Electron** wrapping the existing React client.

---

## 4. Capability Factory (what OpenClaw knows)

OpenClaw's capability factory scores autopay_ui as having:

- `billing.stripe.checkout` (score 100)
- `billing.stripe.webhooks` (score 100)
- `comms.telnyx.sms` (score 100)
- `webhooks.signature_verify` (score 100)

These implementations live in autopay_ui. Search those capability names in the repo to find the exact files.

---

## 5. Quick Commands for Agents

```bash
# List autopay_ui entry points
ls -la ~/claw-repos/autopay_ui/*.js
ls -la ~/claw-repos/autopay_ui/server/
ls -la ~/claw-repos/autopay_ui/client/

# Resolve path (Node)
const REPOS = process.env.REPOS_BASE_PATH || path.join(require('os').homedir(), 'claw-repos');
const autopayPath = path.join(REPOS, 'autopay_ui');
const payclawPath = path.join(REPOS, 'payclaw');
```

---

## 6. Compliance (claw-architect, not autopay_ui)

PayClaw-specific config lives in **claw-architect** and is copied by `payclaw:launch`:

- `config/payclaw/risk-categories.json`
- `config/payclaw/message-templates.txt`
- `config/payclaw/attestations.txt`
- `docs/payclaw/SPEC.md`
- `docs/payclaw/COMPLIANCE.md`

Do **not** copy these from autopay_ui. Use the claw-architect versions; they are canonical.
