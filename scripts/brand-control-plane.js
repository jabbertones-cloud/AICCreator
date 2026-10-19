#!/usr/bin/env node
"use strict";

const http = require("http");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const pg = require("../infra/postgres");
const { resolveRouting, isKnownTaskType } = require("../config/task-routing");
const { validatePayload } = require("../schemas/payloads");
const { buildTaskIdempotencyKey } = require("../control/idempotency");
const { encryptSecret } = require("../infra/secrets-crypto");
const {
  detectFlags,
  inferCategory,
  chooseChannels,
  computePrice,
  listingTemplate,
  canonicalTitle,
} = require("../control/sell/rules");

const PORT = Number.parseInt(String(process.env.BRAND_CONTROL_PORT || "4050"), 10) || 4050;
const CDN_URL = (process.env.BRAND_INSTALL_CDN_URL || "https://cdn.claw-architect.local").replace(/\/+$/, "");
const ACTIVE_TASK_STATUSES = ["CREATED", "DISPATCHED", "RUNNING", "RETRY", "PENDING_APPROVAL"];
const SELL_UPLOAD_DIR = path.join(__dirname, "../artifacts/sell-items");
const SYSTEM_DASHBOARD_URLS = (process.env.SYSTEM_DASHBOARD_URLS || process.env.GLOBAL_STATUS_URLS || "https://skynpatch.com")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

let _routingColsEnsured = false;
function uuidv4() {
  return crypto.randomUUID();
}

function getGoogleApis() {
  try {
    return require("googleapis").google;
  } catch (err) {
    throw new Error("googleapis module is required for credit OAuth setup. Run npm install before using /v1/credit/oauth/* routes.");
  }
}

async function ensureRoutingColumns() {
  if (_routingColsEnsured) return;
  await pg.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS required_tags TEXT[] DEFAULT '{}'`);
  await pg.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS idempotency_key TEXT`);
  _routingColsEnsured = true;
}

function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c.toString();
      if (raw.length > 25_000_000) {
        reject(new Error("payload_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function collectBuffer(req, maxBytes = 75_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error("payload_too_large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseContentDisposition(value) {
  const out = {};
  for (const part of String(value || "").split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    const key = rawKey && rawKey.trim().toLowerCase();
    if (!key || rawValue.length === 0) continue;
    out[key] = rawValue.join("=").trim().replace(/^"|"$/g, "");
  }
  return out;
}

function parseMultipartFormData(req, body) {
  const contentType = String(req.headers["content-type"] || "");
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = boundaryMatch && (boundaryMatch[1] || boundaryMatch[2]);
  if (!boundary) throw new Error("missing_multipart_boundary");

  const delimiter = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = [];
  let cursor = 0;

  while (cursor < body.length) {
    let start = body.indexOf(delimiter, cursor);
    if (start < 0) break;
    start += delimiter.length;
    if (body[start] === 45 && body[start + 1] === 45) break;
    if (body[start] === 13 && body[start + 1] === 10) start += 2;

    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), start);
    if (headerEnd < 0) break;
    const rawHeaders = body.slice(start, headerEnd).toString("utf8");
    let dataStart = headerEnd + 4;
    let next = body.indexOf(delimiter, dataStart);
    if (next < 0) break;
    let dataEnd = next;
    if (body[dataEnd - 2] === 13 && body[dataEnd - 1] === 10) dataEnd -= 2;

    const headers = {};
    for (const line of rawHeaders.split("\r\n")) {
      const idx = line.indexOf(":");
      if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
    const disposition = parseContentDisposition(headers["content-disposition"]);
    const name = disposition.name;
    const filename = disposition.filename;
    const value = body.slice(dataStart, dataEnd);

    if (name && filename) {
      files.push({
        field: name,
        filename,
        mime_type: headers["content-type"] || "application/octet-stream",
        buffer: value,
      });
    } else if (name) {
      const text = value.toString("utf8");
      if (Object.prototype.hasOwnProperty.call(fields, name)) {
        fields[name] = Array.isArray(fields[name]) ? [...fields[name], text] : [fields[name], text];
      } else {
        fields[name] = text;
      }
    }

    cursor = next;
  }

  return { fields, files };
}

async function readSellIntakePayload(req) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (contentType.includes("multipart/form-data")) {
    const body = await collectBuffer(req);
    const { fields, files } = parseMultipartFormData(req, body);
    const channels = fields.channels
      ? (Array.isArray(fields.channels) ? fields.channels : [fields.channels])
      : [];
    return {
      title: fields.title || "",
      notes: fields.notes || "",
      sub_brand: fields.sub_brand || "",
      location_code: fields.location_code || "",
      qty_confirmed: Number(fields.qty_confirmed || 0),
      inventory_confidence: Number(fields.inventory_confidence || 1),
      desired_velocity: fields.desired_velocity || "normal",
      price_policy: fields.price_policy || "normal",
      mode: fields.mode || "one_off",
      preferred_channels: channels.length ? channels : ["ebay"],
      photos: files
        .filter((f) => f.field === "photos" && f.buffer.length > 0)
        .map((f) => ({
          filename: f.filename,
          mime_type: f.mime_type,
          buffer: f.buffer,
        })),
    };
  }

  const raw = await collectBody(req);
  return raw ? JSON.parse(raw) : {};
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function html(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function renderOAuthSetupForm(prefill = {}, note = "") {
  const clientId = escapeHtml(prefill.client_id || process.env.GOOGLE_OAUTH_CLIENT_ID || "");
  const clientSecret = escapeHtml(prefill.client_secret || process.env.GOOGLE_OAUTH_CLIENT_SECRET || "");
  const redirectUri = escapeHtml(
    prefill.redirect_uri ||
      process.env.GOOGLE_OAUTH_REDIRECT_URI ||
      `http://127.0.0.1:${PORT}/v1/credit/oauth/callback`
  );
  const senderEmail = escapeHtml(prefill.sender_email || process.env.GMAIL_SENDER_EMAIL || "");
  const hasQuickStart = Boolean((prefill.client_id || process.env.GOOGLE_OAUTH_CLIENT_ID || "").trim()) &&
    Boolean((prefill.client_secret || process.env.GOOGLE_OAUTH_CLIENT_SECRET || "").trim());
  const noteHtml = note ? `<p style="color:#b45309"><strong>${escapeHtml(note)}</strong></p>` : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Credit Gmail OAuth Setup</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif; margin: 24px; color:#111827; }
    .card { max-width: 760px; border:1px solid #e5e7eb; border-radius: 12px; padding: 20px; }
    h1 { margin-top: 0; font-size: 22px; }
    label { display:block; margin-top: 14px; font-weight: 600; }
    input { width:100%; padding:10px; border:1px solid #d1d5db; border-radius: 8px; margin-top:6px; }
    button { margin-top: 18px; padding:10px 14px; border-radius:8px; border:0; background:#111827; color:#fff; cursor:pointer; }
    .muted { color:#6b7280; font-size:14px; margin-top:8px; }
    code { background:#f3f4f6; padding:2px 6px; border-radius:4px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Credit Gmail OAuth Setup</h1>
    <p>Use this local page to configure Google OAuth for credit send/reply automation.</p>
    ${noteHtml}
    ${hasQuickStart ? `
      <form method="POST" action="/v1/credit/oauth/quick-start">
        <button type="submit">Connect Google (One Click)</button>
      </form>
      <p class="muted">Uses saved <code>GOOGLE_OAUTH_CLIENT_ID</code>/<code>GOOGLE_OAUTH_CLIENT_SECRET</code> and auto-detects sender email after login.</p>
      <hr style="margin:16px 0;border:none;border-top:1px solid #e5e7eb" />
    ` : ""}
    <form method="POST" action="/v1/credit/oauth/start">
      <label>Google OAuth Client ID</label>
      <input name="client_id" required value="${clientId}" />
      <label>Google OAuth Client Secret</label>
      <input name="client_secret" required value="${clientSecret}" />
      <label>Redirect URI</label>
      <input name="redirect_uri" required value="${redirectUri}" />
      <label>Sender Email (optional)</label>
      <input name="sender_email" value="${senderEmail}" />
      <button type="submit">Continue to Google Consent</button>
    </form>
    <p class="muted">Expected redirect URI in Google Cloud should match exactly, usually <code>http://127.0.0.1:${PORT}/v1/credit/oauth/callback</code>.</p>
  </div>
</body>
</html>`;
}

function renderOAuthResult(ok, title, details) {
  const safeTitle = escapeHtml(title);
  const safeDetails = escapeHtml(details);
  const color = ok ? "#065f46" : "#991b1b";
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${safeTitle}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;margin:24px;color:#111827">
  <div style="max-width:760px;border:1px solid #e5e7eb;border-radius:12px;padding:20px">
    <h1 style="margin-top:0;color:${color}">${safeTitle}</h1>
    <pre style="white-space:pre-wrap;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px">${safeDetails}</pre>
    <p>Next:</p>
    <ol>
      <li><code>npm run credit:oauth:check</code></li>
      <li><code>pm2 restart claw-worker-ai claw-worker-nas --update-env</code></li>
      <li><code>npm run credit:e2e:live</code></li>
    </ol>
    <p><a href="/v1/credit/oauth/setup">Back to OAuth Setup</a></p>
  </div>
</body>
</html>`;
}

function upsertEnvVar(filePath, key, value) {
  const raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const lines = raw.split(/\r?\n/);
  const escaped = String(value == null ? "" : value);
  let replaced = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith(`${key}=`)) {
      lines[i] = `${key}=${escaped}`;
      replaced = true;
      break;
    }
  }
  if (!replaced) lines.push(`${key}=${escaped}`);
  const next = `${lines.filter((l, i, arr) => !(i === arr.length - 1 && l === "")).join("\n")}\n`;
  fs.writeFileSync(filePath, next, "utf8");
}

function saveGoogleOAuthEnv({ clientId, clientSecret, redirectUri, refreshToken, senderEmail }) {
  const envPath = path.join(__dirname, "../.env");
  upsertEnvVar(envPath, "GOOGLE_OAUTH_CLIENT_ID", clientId);
  upsertEnvVar(envPath, "GOOGLE_OAUTH_CLIENT_SECRET", clientSecret);
  upsertEnvVar(envPath, "GOOGLE_OAUTH_REDIRECT_URI", redirectUri);
  upsertEnvVar(envPath, "GOOGLE_OAUTH_REFRESH_TOKEN", refreshToken);
  if (senderEmail) upsertEnvVar(envPath, "GMAIL_SENDER_EMAIL", senderEmail);
}

const oauthStateStore = new Map();

function beginGoogleOAuth(res, cfg) {
  const google = getGoogleApis();
  const state = crypto.randomBytes(18).toString("hex");
  oauthStateStore.set(state, { ...cfg, createdAt: Date.now() });
  for (const [k, v] of oauthStateStore.entries()) {
    if ((Date.now() - Number(v.createdAt || 0)) > 15 * 60 * 1000) oauthStateStore.delete(k);
  }

  const oauth2 = new google.auth.OAuth2(cfg.clientId, cfg.clientSecret, cfg.redirectUri);
  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.modify",
    ],
    state,
  });

  res.writeHead(302, { Location: authUrl });
  res.end();
}

function safeFileName(name) {
  const base = path.basename(String(name || "upload.bin"));
  return base.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "upload.bin";
}

function renderSellDashboard(items = []) {
  const rows = items
    .map(
      (i) => `<tr>
        <td>${escapeHtml(i.sku || "-")}</td>
        <td>${escapeHtml(i.title || "(untitled)")}</td>
        <td>${escapeHtml(i.sub_brand || "-")}</td>
        <td>${escapeHtml(i.location_code || "-")}</td>
        <td>${escapeHtml(i.status || "")}</td>
        <td>${escapeHtml(i.price_policy || "normal")}</td>
        <td>${escapeHtml((i.preferred_channels || []).join(", "))}</td>
        <td>${escapeHtml(String(i.qty_confirmed || 0))}</td>
        <td>${escapeHtml(String(i.qty_reserved || 0))}</td>
        <td>${escapeHtml(Number(i.inventory_confidence || 0).toFixed(2))}</td>
        <td>${escapeHtml(String(i.media_count || 0))}</td>
        <td>${escapeHtml(i.list_price == null ? "-" : `$${Number(i.list_price).toFixed(2)}`)}</td>
        <td><button type="button" onclick="processItem('${escapeHtml(i.id)}')">Process</button></td>
        <td>${escapeHtml(new Date(i.created_at).toLocaleString())}</td>
      </tr>`
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Selling System Intake</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif; margin: 24px; color:#111827; }
    .grid { display:grid; grid-template-columns: 1fr 1fr; gap: 18px; }
    .card { border:1px solid #e5e7eb; border-radius: 12px; padding: 16px; }
    h1,h2 { margin-top: 0; }
    label { display:block; margin-top: 10px; font-weight: 600; }
    input, textarea, select { width:100%; padding:9px; border:1px solid #d1d5db; border-radius: 8px; margin-top:6px; }
    .chips { display:flex; gap:10px; margin-top:8px; flex-wrap: wrap; }
    .chips label { font-weight: 500; margin-top: 0; }
    button { margin-top: 14px; padding:10px 14px; border-radius:8px; border:0; background:#111827; color:#fff; cursor:pointer; }
    table { width:100%; border-collapse: collapse; margin-top:8px; }
    th, td { text-align:left; border-bottom:1px solid #e5e7eb; padding:8px 6px; font-size:14px; }
    .muted { color:#6b7280; font-size: 13px; }
    @media (max-width: 1000px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <h1>Selling System Dashboard</h1>
  <p class="muted">Upload photos + basic product info. The system creates a case file for extraction/pricing/listing.</p>
  <div class="grid">
    <div class="card">
      <h2>New Item Intake</h2>
      <form id="sellForm">
        <label>Title (optional)</label>
        <input name="title" />
        <label>Notes</label>
        <textarea name="notes" rows="4"></textarea>
        <label>Sub-brand (optional)</label>
        <input name="sub_brand" placeholder="Cookies / Nirvana / etc" />
        <label>Location Code</label>
        <input name="location_code" placeholder="A1-BIN-04" />
        <label>Count Confirmed (on hand)</label>
        <input name="qty_confirmed" type="number" min="0" value="1" />
        <label>Inventory Confidence (0-1)</label>
        <input name="inventory_confidence" type="number" min="0" max="1" step="0.01" value="1" />
        <label>Velocity</label>
        <select name="desired_velocity">
          <option value="fast">Fast sell</option>
          <option value="normal" selected>Normal</option>
          <option value="max">Max margin</option>
        </select>
        <label>Pricing Policy</label>
        <select name="price_policy">
          <option value="liquidate">Fast Liquidation</option>
          <option value="normal" selected>Normal</option>
          <option value="max_margin">Max Margins</option>
        </select>
        <label>Mode</label>
        <select name="mode">
          <option value="one_off" selected>One-off item</option>
          <option value="repeat_sku">Repeat SKU (Shopify style)</option>
        </select>
        <label>Preferred Channels</label>
        <div class="chips">
          <label><input type="checkbox" name="channels" value="ebay" checked /> eBay</label>
          <label><input type="checkbox" name="channels" value="etsy" /> Etsy</label>
          <label><input type="checkbox" name="channels" value="craigslist" /> Craigslist</label>
          <label><input type="checkbox" name="channels" value="facebook_marketplace" /> Facebook Marketplace</label>
        </div>
        <label>Photos (front/back/label/scale preferred)</label>
        <input id="photos" name="photos" type="file" multiple accept="image/*" />
        <button type="submit">Create Item + Upload</button>
      </form>
      <p id="status" class="muted"></p>
    </div>
    <div class="card">
      <h2>Recent Items</h2>
      <p id="queueSummary" class="muted">Loading queues...</p>
      <table>
        <thead>
          <tr><th>SKU</th><th>Title</th><th>Sub-brand</th><th>Location</th><th>Status</th><th>Policy</th><th>Channels</th><th>On Hand</th><th>Reserved</th><th>Conf</th><th>Photos</th><th>Price</th><th>Action</th><th>Created</th></tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="14" class="muted">No items yet.</td></tr>'}</tbody>
      </table>
    </div>
  </div>
  <script>
    document.getElementById('sellForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const status = document.getElementById('status');
      status.textContent = 'Uploading...';
      try {
        const form = e.currentTarget;
        const formData = new FormData();
        const values = new FormData(form);
        const channels = Array.from(form.querySelectorAll('input[name="channels"]:checked')).map(x => x.value);
        formData.set('title', values.get('title') || '');
        formData.set('notes', values.get('notes') || '');
        formData.set('sub_brand', values.get('sub_brand') || '');
        formData.set('location_code', values.get('location_code') || '');
        formData.set('qty_confirmed', values.get('qty_confirmed') || '0');
        formData.set('inventory_confidence', values.get('inventory_confidence') || '1');
        formData.set('desired_velocity', values.get('desired_velocity') || 'normal');
        formData.set('price_policy', values.get('price_policy') || 'normal');
        formData.set('mode', values.get('mode') || 'one_off');
        for (const channel of (channels.length ? channels : ['ebay'])) formData.append('channels', channel);
        for (const f of Array.from(document.getElementById('photos').files || [])) {
          formData.append('photos', f, f.name);
        }
        const res = await fetch('/v1/sell/intake', {
          method: 'POST',
          body: formData
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'upload_failed');
        status.textContent = 'Created ' + json.item.sku + ' with ' + json.media_saved + ' photo(s). Refreshing...';
        setTimeout(() => window.location.reload(), 700);
      } catch (err) {
        status.textContent = 'Error: ' + err.message;
      }
    });
    async function processItem(itemId){
      const status = document.getElementById('status');
      status.textContent = 'Processing ' + itemId + '...';
      try{
        const res = await fetch('/v1/sell/process/' + encodeURIComponent(itemId), { method: 'POST' });
        const json = await res.json();
        if(!res.ok) throw new Error(json.error || 'process_failed');
        status.textContent = 'Processed ' + (json.item?.sku || itemId) + ' => ' + (json.item?.status || '');
        setTimeout(()=>window.location.reload(), 700);
      } catch(err){
        status.textContent = 'Process error: ' + err.message;
      }
    }
    async function refreshQueues(){
      try{
        const r = await fetch('/v1/sell/queues');
        const j = await r.json();
        if(!r.ok) throw new Error(j.error || 'queue_fetch_failed');
        document.getElementById('queueSummary').textContent =
          'Sell Next: ' + (j.sell_next?.length || 0) +
          ' | Cross-post: ' + (j.cross_post?.length || 0) +
          ' | Stuck: ' + (j.stuck?.length || 0);
      }catch(err){
        document.getElementById('queueSummary').textContent = 'Queue load error: ' + err.message;
      }
    }
    refreshQueues();
  </script>
</body>
</html>`;
}

async function loadRecentSellItems(limit = 30) {
  const { rows } = await pg.query(
    `SELECT i.id, i.sku, i.title, i.sub_brand, i.location_code, i.status, i.price_policy, i.list_price, i.preferred_channels, i.qty_confirmed, i.qty_reserved, i.inventory_confidence, i.created_at,
            COUNT(m.id)::int AS media_count
       FROM sell_items i
       LEFT JOIN sell_item_media m ON m.item_id = i.id
      GROUP BY i.id
      ORDER BY i.created_at DESC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

async function createSellIntake(payload) {
  const desiredVelocity = ["fast", "normal", "max"].includes(payload.desired_velocity)
    ? payload.desired_velocity
    : "normal";
  const channels = Array.isArray(payload.preferred_channels) && payload.preferred_channels.length
    ? payload.preferred_channels.slice(0, 6).map((x) => String(x))
    : ["ebay"];
  const pricePolicy = ["liquidate", "normal", "max_margin"].includes(String(payload.price_policy || "normal"))
    ? String(payload.price_policy)
    : "normal";
  const mode = ["one_off", "repeat_sku"].includes(String(payload.mode || "one_off"))
    ? String(payload.mode)
    : "one_off";
  const subBrand = payload.sub_brand ? String(payload.sub_brand).trim() : null;
  const locationCode = payload.location_code ? String(payload.location_code).trim() : null;
  const qtyConfirmed = Math.max(0, Number(payload.qty_confirmed || 0) || 0);
  const qtyEstimated = Math.max(1, Number(payload.qty_estimated || qtyConfirmed || 1) || 1);
  const inventoryConfidence = Math.max(0, Math.min(1, Number(payload.inventory_confidence || 1) || 1));
  const photos = Array.isArray(payload.photos) ? payload.photos : [];
  if (photos.length < 1) {
    throw new Error("at least one photo is required");
  }
  if (photos.length > 12) {
    throw new Error("max 12 photos per item");
  }

  const itemId = uuidv4();
  const sku = `ITM-${new Date().toISOString().slice(0,10).replaceAll("-","")}-${itemId.slice(0, 8).toUpperCase()}`;
  await pg.query(
    `INSERT INTO sell_items (id, sku, title, notes, desired_velocity, preferred_channels, price_policy, mode, sub_brand, location_code, qty_estimated, qty_confirmed, inventory_confidence, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'INGESTED')`,
    [
      itemId,
      sku,
      payload.title || null,
      payload.notes || null,
      desiredVelocity,
      channels,
      pricePolicy,
      mode,
      subBrand,
      locationCode,
      qtyEstimated,
      qtyConfirmed,
      inventoryConfidence,
    ]
  );

  const itemDir = path.join(SELL_UPLOAD_DIR, itemId);
  fs.mkdirSync(itemDir, { recursive: true });

  let saved = 0;
  for (let i = 0; i < photos.length; i += 1) {
    const p = photos[i] || {};
    const mime = String(p.mime_type || "application/octet-stream");
    let buf = Buffer.isBuffer(p.buffer) ? p.buffer : null;
    if (!buf) {
      const dataUrl = String(p.data_url || "");
      const m = dataUrl.match(/^data:(.+);base64,(.+)$/);
      if (!m) continue;
      buf = Buffer.from(m[2], "base64");
    }
    if (buf.length > 10 * 1024 * 1024) throw new Error(`photo_too_large:${i + 1}`);
    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    const name = safeFileName(p.filename || `photo-${i + 1}.bin`);
    const filePath = path.join(itemDir, name);
    fs.writeFileSync(filePath, buf);

    await pg.query(
      `INSERT INTO sell_item_media (item_id, role, file_path, mime_type, size_bytes, sha256)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [itemId, null, filePath, mime, buf.length, sha]
    );
    saved += 1;
  }
  if (saved === 0) throw new Error("no_valid_photos_saved");
  return { item_id: itemId, sku, media_saved: saved };
}

async function loadSellItem(itemId) {
  const { rows } = await pg.query(`SELECT * FROM sell_items WHERE id = $1`, [itemId]);
  return rows[0] || null;
}

async function loadSellMedia(itemId) {
  const { rows } = await pg.query(
    `SELECT id, file_path, mime_type, size_bytes, sha256, created_at FROM sell_item_media WHERE item_id = $1 ORDER BY created_at ASC`,
    [itemId]
  );
  return rows;
}

async function processSellItem(itemId) {
  const item = await loadSellItem(itemId);
  if (!item) throw new Error("item_not_found");
  const media = await loadSellMedia(itemId);
  const flags = detectFlags(item, media);
  const category = inferCategory(item, media);
  const pricing = computePrice(item, category);
  const channelsOut = chooseChannels(item, category, flags, pricing);
  const pricingWithMargins = {
    ...pricing,
    margin_by_channel: channelsOut.margin_by_channel || {},
  };
  const title = canonicalTitle(item, category);
  const blockedByMargin = (channelsOut.channels || []).length === 0;
  const foremanStatus = blockedByMargin ? "blocked" : (flags.length ? "needs_info" : "approve");
  const questions = [];
  if (flags.includes("NEEDS_PHOTOS")) questions.push("Upload at least 3 photos.");
  if (flags.includes("NEEDS_LABEL_PHOTO")) questions.push("Upload one close-up label/model photo.");
  if (blockedByMargin) questions.push("Expected net margin is below floor for all channels. Adjust price/cost/shipping assumptions.");

  const listingPackets = channelsOut.channels.map((c) => listingTemplate(item, c, category, pricingWithMargins, flags));

  await pg.query("BEGIN");
  try {
    await pg.query(`DELETE FROM sell_listings WHERE item_id = $1 AND status IN ('draft','ready_for_approval')`, [itemId]);
    for (const p of listingPackets) {
      await pg.query(
        `INSERT INTO sell_listings (item_id, channel, title, description, specifics_json, listing_packet_json, status)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`,
        [
          itemId,
          p.channel,
          p.title,
          p.description,
          JSON.stringify(p.specifics || {}),
          JSON.stringify(p.listing_packet_json || {}),
          foremanStatus === "approve" ? "ready_for_approval" : "draft",
        ]
      );
    }
    await pg.query(
      `UPDATE sell_items
          SET category = $2,
              channel_recommendations = $3::jsonb,
              flags = $4::jsonb,
              foreman_status = $5,
              next_questions = $6::jsonb,
              canonical_title = $7,
              list_price = $8,
              pricing_json = $9::jsonb,
              listing_json = $10::jsonb,
              status = $11,
              updated_at = NOW()
        WHERE id = $1`,
      [
        itemId,
        category,
        JSON.stringify(channelsOut),
        JSON.stringify(flags),
        foremanStatus,
        JSON.stringify(questions),
        title,
        pricing.list_price,
        JSON.stringify(pricingWithMargins),
        JSON.stringify({ channels: channelsOut.channels, generated_count: listingPackets.length }),
        foremanStatus === "approve" ? "READY_FOR_APPROVAL" : "NEEDS_LISTING_INFO",
      ]
    );
    await pg.query(
      `INSERT INTO sell_pipeline_runs (item_id, step_name, status, detail, result_json)
       VALUES ($1,'rules_pipeline','completed','processed',$2::jsonb)`,
      [itemId, JSON.stringify({ category, flags, channels: channelsOut.channels, pricing: pricingWithMargins, foremanStatus })]
    );
    await pg.query("COMMIT");
  } catch (err) {
    await pg.query("ROLLBACK");
    throw err;
  }
  return {
    item_id: itemId,
    category,
    flags,
    channels: channelsOut.channels,
    pricing: pricingWithMargins,
    status: foremanStatus === "approve" ? "READY_FOR_APPROVAL" : "NEEDS_LISTING_INFO",
  };
}

async function loadSellItemDetail(itemId) {
  const item = await loadSellItem(itemId);
  if (!item) return null;
  const media = await loadSellMedia(itemId);
  const { rows: listings } = await pg.query(
    `SELECT id, channel, title, status, external_listing_id, external_url, created_at, updated_at
       FROM sell_listings
      WHERE item_id = $1
      ORDER BY created_at DESC`,
    [itemId]
  );
  const { rows: runs } = await pg.query(
    `SELECT step_name, status, detail, result_json, created_at
       FROM sell_pipeline_runs
      WHERE item_id = $1
      ORDER BY created_at DESC
      LIMIT 50`,
    [itemId]
  );
  return { item, media, listings, runs };
}

async function loadSellQueues() {
  const { rows: sellNext } = await pg.query(
    `SELECT id, sku, title, sub_brand, location_code, status, qty_confirmed, qty_reserved, inventory_confidence, preferred_channels, created_at
       FROM sell_items
      WHERE status IN ('INGESTED','READY_FOR_APPROVAL','NEEDS_LISTING_INFO')
        AND GREATEST(COALESCE(qty_confirmed,0) - COALESCE(qty_reserved,0), 0) > 0
      ORDER BY created_at ASC
      LIMIT 200`
  );
  const { rows: crossPost } = await pg.query(
    `SELECT
       i.id, i.sku, i.title, i.preferred_channels,
       COUNT(DISTINCT l.channel)::int AS listed_channels
     FROM sell_items i
     LEFT JOIN sell_listings l ON l.item_id = i.id AND l.status IN ('draft','ready_for_approval','published')
     WHERE i.status IN ('READY_FOR_APPROVAL','PUBLISHED')
     GROUP BY i.id
     HAVING COUNT(DISTINCT l.channel) < GREATEST(array_length(i.preferred_channels, 1), 1)
     ORDER BY i.created_at DESC
     LIMIT 200`
  );
  const { rows: stuck } = await pg.query(
    `SELECT
       i.id, i.sku, i.title,
       l.channel, l.status AS listing_status, i.list_price AS price, l.views_count, l.watchers_count,
       l.created_at, l.updated_at,
       EXTRACT(EPOCH FROM (NOW() - COALESCE(l.last_activity_at, l.updated_at, l.created_at)))/86400.0 AS stale_days
     FROM sell_listings l
     JOIN sell_items i ON i.id = l.item_id
     WHERE l.status IN ('published','ready_for_approval')
       AND COALESCE(l.last_activity_at, l.updated_at, l.created_at) < NOW() - INTERVAL '14 days'
       AND COALESCE(l.watchers_count, 0) <= 1
     ORDER BY stale_days DESC
     LIMIT 200`
  );
  const { rows: publishPriority } = await pg.query(
    `SELECT
       i.id, i.sku, i.title, i.status, i.list_price,
       COALESCE(i.channel_recommendations->>'strategy','') AS strategy,
       ch.channel,
       (ch.priority)::int AS priority,
       COALESCE((i.pricing_json->'margin_by_channel'->ch.channel->>'expected_net')::numeric, 0) AS expected_net
     FROM sell_items i
     JOIN LATERAL jsonb_to_recordset(
       CASE
         WHEN jsonb_typeof(i.channel_recommendations->'ranked_channels') = 'array'
         THEN i.channel_recommendations->'ranked_channels'
         ELSE '[]'::jsonb
       END
     ) AS ch(channel text, priority int) ON TRUE
     WHERE i.status IN ('READY_FOR_APPROVAL','PUBLISHED')
     ORDER BY ch.priority DESC, expected_net DESC, i.updated_at DESC
     LIMIT 200`
  );
  return { sell_next: sellNext, cross_post: crossPost, stuck, publish_priority: publishPriority };
}

function pm2Snapshot() {
  try {
    const raw = execSync("pm2 jlist", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map((p) => ({
      name: p.name,
      status: p.pm2_env?.status || "unknown",
      restarts: Number(p.pm2_env?.restart_time || 0),
      uptime_ms: Number((Date.now() - Number(p.pm2_env?.pm_uptime || Date.now())) || 0),
      cpu: Number(p.monit?.cpu || 0),
      mem: Number(p.monit?.memory || 0),
    })) : [];
  } catch {
    return [];
  }
}

async function checkUrls(urls) {
  const out = [];
  for (const url of urls) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(8000) });
      out.push({ url, ok: res.status >= 200 && res.status < 500, status: res.status, latency_ms: Date.now() - t0 });
    } catch (err) {
      out.push({ url, ok: false, status: 0, latency_ms: Date.now() - t0, error: err.message });
    }
  }
  return out;
}

function healthClass(ok) {
  return ok ? "ok" : "bad";
}

async function loadSystemDashboardData() {
  const [workersQ, scansQ, spendQ, routingQ, creditQ, leadQ, orchesQ, launchQ, tasksDailyQ, schemaQ, urls] = await Promise.all([
    pg.query(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('ready','busy') AND NOW()-last_heartbeat <= INTERVAL '90 seconds')::int AS active_workers,
         COUNT(*) FILTER (WHERE status IN ('ready','busy') AND NOW()-last_heartbeat <= INTERVAL '90 seconds' AND (capabilities->>'node_role')='ai_worker')::int AS active_ai,
         COUNT(*) FILTER (WHERE status IN ('ready','busy') AND NOW()-last_heartbeat <= INTERVAL '90 seconds' AND (capabilities->>'node_role')='nas_worker')::int AS active_nas
       FROM device_registry`
    ),
    pg.query(
      `SELECT repos_scanned, pass_count, fail_count, started_at, finished_at
       FROM github_repo_scan_runs
       WHERE status='completed'
       ORDER BY finished_at DESC NULLS LAST
       LIMIT 1`
    ),
    pg.query(
      `SELECT
         COALESCE(SUM(cost_usd), 0)::numeric AS total,
         COALESCE(SUM(CASE WHEN provider='openai' THEN cost_usd ELSE 0 END), 0)::numeric AS openai,
         COALESCE(SUM(CASE WHEN provider='anthropic' THEN cost_usd ELSE 0 END), 0)::numeric AS anthropic,
         COALESCE(SUM(CASE WHEN model_key='openai_codex' THEN cost_usd ELSE 0 END), 0)::numeric AS codex
       FROM model_usage
       WHERE created_at >= date_trunc('day', timezone('UTC', now()))`
    ),
    pg.query(
      `SELECT
         COUNT(*)::int AS total_calls,
         COUNT(*) FILTER (WHERE routing_outcome='success')::int AS success_calls,
         COUNT(*) FILTER (WHERE routing_outcome='error')::int AS error_calls,
         COUNT(*) FILTER (WHERE escalation_reason IS NOT NULL)::int AS fallback_calls
       FROM model_usage
       WHERE created_at >= date_trunc('day', timezone('UTC', now()))`
    ),
    pg.query(
      `SELECT
         (SELECT COUNT(*)::int FROM credit_reports) AS reports,
         (SELECT COUNT(*)::int FROM credit_issues WHERE status='open') AS open_issues,
         (SELECT COUNT(*)::int FROM credit_actions WHERE status IN ('queued','draft','blocked','sent')) AS active_actions,
         (SELECT COUNT(*)::int FROM credit_correspondence) AS correspondence`
    ),
    pg.query(
      `SELECT
         (SELECT COUNT(*)::int FROM leads WHERE brand_slug='skynpatch') AS leads_total,
         (SELECT COUNT(*)::int FROM leads WHERE brand_slug='skynpatch' AND email IS NOT NULL AND email <> '') AS leads_with_email,
         (SELECT COUNT(*)::int FROM email_sends WHERE brand_slug='skynpatch') AS sends_total,
         (SELECT COUNT(*)::int FROM email_sends WHERE brand_slug='skynpatch' AND (delivered_at IS NOT NULL OR status='delivered')) AS delivered,
         (SELECT COUNT(*)::int FROM email_sends WHERE brand_slug='skynpatch' AND opened_at IS NOT NULL) AS opened,
         (SELECT COUNT(*)::int FROM email_sends WHERE brand_slug='skynpatch' AND clicked_at IS NOT NULL) AS clicked`
    ),
    pg.query(
      `SELECT step_name, status, reason, started_at, duration_ms
       FROM orchestrator_step_runs
       ORDER BY started_at DESC
       LIMIT 30`
    ),
    pg.query(
      `SELECT generated_at, targets, passes, failures, blocking_failures
       FROM launch_e2e_runs
       ORDER BY generated_at DESC
       LIMIT 1`
    ).catch(() => ({ rows: [] })),
    pg.query(
      `SELECT
         day::date,
         SUM(created_tasks)::int AS created_tasks,
         SUM(completed_tasks)::int AS completed_tasks
       FROM (
         SELECT
           date_trunc('day', created_at) AS day,
           COUNT(*)::int AS created_tasks,
           0::int AS completed_tasks
         FROM tasks
         WHERE created_at >= NOW() - INTERVAL '7 days'
         GROUP BY 1
         UNION ALL
         SELECT
           date_trunc('day', completed_at) AS day,
           0::int AS created_tasks,
           COUNT(*)::int AS completed_tasks
         FROM tasks
         WHERE completed_at >= NOW() - INTERVAL '7 days'
         GROUP BY 1
       ) x
       GROUP BY day
       ORDER BY day DESC`
    ),
    pg.query(
      `SELECT
         (SELECT count(*) FROM pg_constraint WHERE NOT convalidated)::int AS invalid_constraints,
         (SELECT count(*) FROM pg_index WHERE NOT indisvalid)::int AS invalid_indexes`
    ),
    checkUrls(SYSTEM_DASHBOARD_URLS),
  ]);

  return {
    generated_at: new Date().toISOString(),
    pm2: pm2Snapshot(),
    workers: workersQ.rows[0] || {},
    repo_scan: scansQ.rows[0] || null,
    spend: spendQ.rows[0] || {},
    routing: routingQ.rows[0] || {},
    credit: creditQ.rows[0] || {},
    lead: leadQ.rows[0] || {},
    orchestrator_history: orchesQ.rows || [],
    launch_e2e: launchQ.rows?.[0] || null,
    tasks_daily: tasksDailyQ.rows || [],
    schema: schemaQ.rows[0] || {},
    urls,
  };
}

function renderSystemDashboard(d) {
  const pm2Rows = (d.pm2 || []).map((p) => `
    <tr>
      <td>${escapeHtml(p.name)}</td>
      <td><span class="pill ${p.status === "online" ? "ok" : "bad"}">${escapeHtml(p.status)}</span></td>
      <td>${p.restarts}</td>
      <td>${(p.uptime_ms / 3600000).toFixed(1)}h</td>
      <td>${p.cpu.toFixed(1)}%</td>
      <td>${(p.mem / (1024 * 1024)).toFixed(1)} MB</td>
    </tr>
  `).join("");

  const urlRows = (d.urls || []).map((u) => `
    <tr><td>${escapeHtml(u.url)}</td><td><span class="pill ${healthClass(u.ok)}">${u.ok ? "up" : "down"}</span></td><td>${u.status}</td><td>${u.latency_ms}ms</td><td>${escapeHtml(u.error || "")}</td></tr>
  `).join("");

  const orchesRows = (d.orchestrator_history || []).map((r) => `
    <tr><td>${escapeHtml(r.step_name)}</td><td><span class="pill ${r.status === "COMPLETED" ? "ok" : (r.status === "FAILED" ? "bad" : "warn")}">${escapeHtml(r.status)}</span></td><td>${escapeHtml(r.reason || "")}</td><td>${escapeHtml(new Date(r.started_at).toLocaleString())}</td><td>${r.duration_ms || 0}ms</td></tr>
  `).join("");

  const taskRows = (d.tasks_daily || []).map((r) => `
    <tr><td>${escapeHtml(String(r.day).slice(0,10))}</td><td>${r.created_tasks}</td><td>${r.completed_tasks}</td></tr>
  `).join("");

  const repo = d.repo_scan || {};
  const schemaOk = Number(d.schema?.invalid_constraints || 0) === 0 && Number(d.schema?.invalid_indexes || 0) === 0;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Claw Command Center</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:#f8fafc;color:#111827;margin:0}
.wrap{padding:18px 22px}
h1{margin:0 0 8px 0}.muted{color:#6b7280;font-size:13px}
.grid{display:grid;grid-template-columns:repeat(4,minmax(200px,1fr));gap:12px;margin:14px 0}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:12px}
.big{font-size:22px;font-weight:700}.ok{background:#dcfce7;color:#166534}.bad{background:#fee2e2;color:#991b1b}.warn{background:#fef9c3;color:#854d0e}
.pill{padding:2px 8px;border-radius:999px;font-size:12px;font-weight:700}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden}
th,td{border-bottom:1px solid #f1f5f9;padding:8px 10px;text-align:left;font-size:13px}
th{background:#f8fafc}
.section{margin-top:14px}
@media(max-width:1200px){.grid{grid-template-columns:repeat(2,minmax(200px,1fr));}}
</style>
</head>
<body><div class="wrap">
  <h1>Claw Command Center</h1>
  <div class="muted">Generated ${escapeHtml(new Date(d.generated_at).toLocaleString())} • auto-refresh 30s • <a href="/v1/system/status">JSON</a></div>

  <div class="grid">
    <div class="card"><div class="muted">Workers</div><div class="big">${d.workers.active_workers || 0}</div><div class="muted">AI ${d.workers.active_ai || 0} • NAS ${d.workers.active_nas || 0}</div></div>
    <div class="card"><div class="muted">Repo Scan</div><div class="big">${repo.pass_count || 0}/${repo.repos_scanned || 0}</div><div class="muted">fails ${repo.fail_count || 0}</div></div>
    <div class="card"><div class="muted">Credit</div><div class="big">${d.credit.open_issues || 0}</div><div class="muted">open • actions ${d.credit.active_actions || 0}</div></div>
    <div class="card"><div class="muted">Lead/Sales</div><div class="big">${d.lead.sends_total || 0}</div><div class="muted">sends • delivered ${d.lead.delivered || 0}</div></div>
    <div class="card"><div class="muted">Model Spend (UTC Today)</div><div class="big">$${Number(d.spend.total || 0).toFixed(3)}</div><div class="muted">OpenAI $${Number(d.spend.openai || 0).toFixed(3)} • Anthropic $${Number(d.spend.anthropic || 0).toFixed(3)}</div></div>
    <div class="card"><div class="muted">Routing</div><div class="big">${d.routing.success_calls || 0}</div><div class="muted">success • errors ${d.routing.error_calls || 0} • fallback ${d.routing.fallback_calls || 0}</div></div>
    <div class="card"><div class="muted">Schema</div><div class="big"><span class="pill ${schemaOk ? "ok" : "bad"}">${schemaOk ? "healthy" : "issues"}</span></div><div class="muted">invalid constraints ${d.schema.invalid_constraints || 0} • indexes ${d.schema.invalid_indexes || 0}</div></div>
    <div class="card"><div class="muted">Launch E2E</div><div class="big">${d.launch_e2e ? `${d.launch_e2e.passes || 0}/${d.launch_e2e.targets || 0}` : "-"}</div><div class="muted">blocking fails ${d.launch_e2e?.blocking_failures ?? "-"}</div></div>
  </div>

  <div class="section">
    <h3>Core Services (PM2)</h3>
    <table><thead><tr><th>Service</th><th>Status</th><th>Restarts</th><th>Uptime</th><th>CPU</th><th>Memory</th></tr></thead><tbody>${pm2Rows}</tbody></table>
  </div>

  <div class="section">
    <h3>Website Uptime</h3>
    <table><thead><tr><th>URL</th><th>Status</th><th>HTTP</th><th>Latency</th><th>Error</th></tr></thead><tbody>${urlRows}</tbody></table>
  </div>

  <div class="section">
    <h3>Orchestrator History (latest 30)</h3>
    <table><thead><tr><th>Step</th><th>Status</th><th>Reason</th><th>Started</th><th>Duration</th></tr></thead><tbody>${orchesRows}</tbody></table>
  </div>

  <div class="section">
    <h3>Task Throughput (7 days)</h3>
    <table><thead><tr><th>Day</th><th>Created</th><th>Completed</th></tr></thead><tbody>${taskRows}</tbody></table>
  </div>
</div>
<script>setTimeout(()=>window.location.reload(),30000);</script>
</body></html>`;
}

function installSnippet(brand) {
  return {
    public_key: brand.public_key,
    script: `<script src="${CDN_URL}/brand-sdk.js" data-brand-key="${brand.public_key}" async></script>`,
  };
}

async function activeProvisionTaskExists(brandId) {
  const { rows } = await pg.query(
    `SELECT 1
       FROM tasks
      WHERE type = 'brand_provision'
        AND payload->>'brand_id' = $1
        AND status = ANY($2::text[])
      LIMIT 1`,
    [brandId, ACTIVE_TASK_STATUSES]
  );
  return rows.length > 0;
}

async function queueProvisionTask(brandId, requestedBy) {
  const type = "brand_provision";
  if (!isKnownTaskType(type)) throw new Error(`Unknown task type: ${type}`);
  const payload = {
    brand_id: brandId,
    requested_by: requestedBy || "api",
  };
  validatePayload(type, payload);
  await ensureRoutingColumns();

  const idempotencyKey = buildTaskIdempotencyKey(type, payload);
  if (await activeProvisionTaskExists(brandId)) {
    return { created: false, reason: "duplicate_active" };
  }

  const routing = resolveRouting(type);
  const id = uuidv4();
  await pg.query(
    `INSERT INTO tasks (id, type, payload, status, worker_queue, required_tags, idempotency_key)
     VALUES ($1,$2,$3,'CREATED',$4,$5,$6)`,
    [id, type, payload, routing.queue, routing.required_tags, idempotencyKey]
  );
  return { created: true, id };
}

async function getBrandStatus(idOrSlug) {
  const { rows } = await pg.query(
    `SELECT id, slug, name, primary_domain, sending_subdomain, sending_domain, default_from_name, default_from_email,
            dns_provider, dns_zone_id, timezone, public_key, provisioning_status, provisioning_error, provisioning_meta,
            last_provisioned_at, created_at, updated_at
       FROM brands
      WHERE id::text = $1 OR slug = $1
      LIMIT 1`,
    [idOrSlug]
  );
  const brand = rows[0];
  if (!brand) return null;

  const { rows: taskRows } = await pg.query(
    `SELECT id, status, created_at, started_at, completed_at, last_error
       FROM tasks
      WHERE type='brand_provision'
        AND payload->>'brand_id' = $1
      ORDER BY created_at DESC
      LIMIT 10`,
    [brand.id]
  );
  const { rows: runRows } = await pg.query(
    `SELECT step_name, status, detail, payload_json, started_at, completed_at
       FROM brand_provision_runs
      WHERE brand_id = $1
      ORDER BY started_at DESC
      LIMIT 20`,
    [brand.id]
  );
  return { brand, tasks: taskRows, runs: runRows };
}

async function upsertBrandAndSecrets(body) {
  const name = String(body.name || "").trim();
  if (!name) throw new Error("name is required");
  const primaryDomain = String(body.primary_domain || "").trim().toLowerCase();
  if (!primaryDomain) throw new Error("primary_domain is required");

  const sendingSubdomain = String(body.sending_subdomain || "mail").trim().toLowerCase();
  const sendingDomain = `${sendingSubdomain}.${primaryDomain}`;
  const slug = slugify(body.slug || name);
  if (!slug) throw new Error("invalid slug/name");

  const defaultFromName = String(body.default_from_name || name).trim();
  const defaultFromEmail = String(body.default_from_email || `hello@${primaryDomain}`).trim().toLowerCase();

  const dnsProvider = body.dns?.provider ? String(body.dns.provider).trim().toLowerCase() : null;
  const dnsZoneId = body.dns?.zone_id ? String(body.dns.zone_id).trim() : null;
  const timezone = String(body.timezone || "America/Phoenix").trim();

  const publicKey = `pub_${crypto.randomBytes(12).toString("hex")}`;
  const mailerooApiKey = body.maileroo?.api_key || null;
  const stripeWebhookSecret = body.stripe?.webhook_secret || null;
  const cloudflareApiToken = body.dns?.api_token || null;

  await pg.query("BEGIN");
  try {
    const up = await pg.query(
      `INSERT INTO brands (
         slug, name, primary_domain, sending_subdomain, sending_domain,
         default_from_name, default_from_email, dns_provider, dns_zone_id, timezone,
         public_key, provisioning_status, provisioning_error, updated_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'queued',NULL,NOW())
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name,
         primary_domain = EXCLUDED.primary_domain,
         sending_subdomain = EXCLUDED.sending_subdomain,
         sending_domain = EXCLUDED.sending_domain,
         default_from_name = EXCLUDED.default_from_name,
         default_from_email = EXCLUDED.default_from_email,
         dns_provider = EXCLUDED.dns_provider,
         dns_zone_id = EXCLUDED.dns_zone_id,
         timezone = EXCLUDED.timezone,
         provisioning_status = 'queued',
         provisioning_error = NULL,
         updated_at = NOW()
       RETURNING id, slug, name, public_key, provisioning_status, primary_domain, sending_domain`,
      [
        slug,
        name,
        primaryDomain,
        sendingSubdomain,
        sendingDomain,
        defaultFromName,
        defaultFromEmail,
        dnsProvider,
        dnsZoneId,
        timezone,
        publicKey,
      ]
    );

    const brand = up.rows[0];
    await pg.query(
      `UPDATE brands
          SET public_key = COALESCE(public_key, $2)
        WHERE id = $1`,
      [brand.id, publicKey]
    );

    await pg.query(
      `INSERT INTO brand_secrets (
         brand_id, maileroo_api_key_encrypted, stripe_webhook_secret_encrypted, cloudflare_api_token_encrypted, secrets_json, updated_at
       )
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (brand_id) DO UPDATE SET
         maileroo_api_key_encrypted = COALESCE(EXCLUDED.maileroo_api_key_encrypted, brand_secrets.maileroo_api_key_encrypted),
         stripe_webhook_secret_encrypted = COALESCE(EXCLUDED.stripe_webhook_secret_encrypted, brand_secrets.stripe_webhook_secret_encrypted),
         cloudflare_api_token_encrypted = COALESCE(EXCLUDED.cloudflare_api_token_encrypted, brand_secrets.cloudflare_api_token_encrypted),
         secrets_json = brand_secrets.secrets_json || EXCLUDED.secrets_json,
         updated_at = NOW()`,
      [
        brand.id,
        mailerooApiKey ? encryptSecret(mailerooApiKey) : null,
        stripeWebhookSecret ? encryptSecret(stripeWebhookSecret) : null,
        cloudflareApiToken ? encryptSecret(cloudflareApiToken) : null,
        JSON.stringify({
          maileroo_account_ref: body.maileroo?.account_ref || null,
          dns_api_token_ref: body.dns?.api_token_ref || null,
          stripe_webhook_ref: body.stripe?.webhook_ref || null,
        }),
      ]
    );

    await pg.query("COMMIT");
    return brand;
  } catch (err) {
    await pg.query("ROLLBACK");
    throw err;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    const pathname = u.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "GET" && pathname === "/healthz") {
      return json(res, 200, { ok: true, service: "brand-control-plane", ts: new Date().toISOString() });
    }

    if (req.method === "GET" && (pathname === "/v1/system/dashboard" || pathname === "/dashboard")) {
      const data = await loadSystemDashboardData();
      return html(res, 200, renderSystemDashboard(data));
    }

    if (req.method === "GET" && pathname === "/v1/system/status") {
      const data = await loadSystemDashboardData();
      return json(res, 200, data);
    }

    if (req.method === "GET" && (pathname === "/v1/sell/dashboard" || pathname === "/sell")) {
      const items = await loadRecentSellItems(30);
      return html(res, 200, renderSellDashboard(items));
    }

    if (req.method === "GET" && pathname === "/v1/sell/items") {
      const items = await loadRecentSellItems(100);
      return json(res, 200, { items });
    }

    if (req.method === "GET" && pathname === "/v1/sell/queues") {
      const q = await loadSellQueues();
      return json(res, 200, q);
    }

    const sellItemMatch = pathname.match(/^\/v1\/sell\/items\/([^/]+)$/);
    if (req.method === "GET" && sellItemMatch) {
      const itemId = decodeURIComponent(sellItemMatch[1]);
      const detail = await loadSellItemDetail(itemId);
      if (!detail) return json(res, 404, { error: "item_not_found" });
      return json(res, 200, detail);
    }

    if (req.method === "POST" && pathname === "/v1/sell/intake") {
      const body = await readSellIntakePayload(req);
      const out = await createSellIntake(body);
      const { rows } = await pg.query(
        `SELECT id, sku, title, notes, desired_velocity, preferred_channels, status, created_at
           FROM sell_items WHERE id = $1`,
        [out.item_id]
      );
      return json(res, 201, {
        ok: true,
        item: rows[0] || null,
        media_saved: out.media_saved,
      });
    }

    const sellProcessMatch = pathname.match(/^\/v1\/sell\/process\/([^/]+)$/);
    if (req.method === "POST" && sellProcessMatch) {
      const itemId = decodeURIComponent(sellProcessMatch[1]);
      const result = await processSellItem(itemId);
      const detail = await loadSellItemDetail(itemId);
      return json(res, 200, { ok: true, result, item: detail?.item || null });
    }

    if (req.method === "GET" && (pathname === "/v1/credit/oauth/setup" || pathname === "/credit/oauth/setup")) {
      return html(res, 200, renderOAuthSetupForm());
    }

    if (req.method === "POST" && pathname === "/v1/credit/oauth/start") {
      const raw = await collectBody(req);
      const form = new URLSearchParams(raw || "");
      const clientId = String(form.get("client_id") || "").trim();
      const clientSecret = String(form.get("client_secret") || "").trim();
      const redirectUri = String(form.get("redirect_uri") || "").trim();
      const senderEmail = String(form.get("sender_email") || "").trim().toLowerCase();

      if (!clientId || !clientSecret || !redirectUri) {
        return html(res, 400, renderOAuthSetupForm(
          { client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, sender_email: senderEmail },
          "All required fields must be filled."
        ));
      }

      beginGoogleOAuth(res, { clientId, clientSecret, redirectUri, senderEmail });
      return;
    }

    if (req.method === "POST" && pathname === "/v1/credit/oauth/quick-start") {
      const clientId = String(process.env.GOOGLE_OAUTH_CLIENT_ID || "").trim();
      const clientSecret = String(process.env.GOOGLE_OAUTH_CLIENT_SECRET || "").trim();
      const redirectUri = String(process.env.GOOGLE_OAUTH_REDIRECT_URI || `http://127.0.0.1:${PORT}/v1/credit/oauth/callback`).trim();
      const senderEmail = String(process.env.GMAIL_SENDER_EMAIL || "").trim().toLowerCase();

      if (!clientId || !clientSecret) {
        return html(
          res,
          400,
          renderOAuthSetupForm(
            {},
            "Missing GOOGLE_OAUTH_CLIENT_ID/GOOGLE_OAUTH_CLIENT_SECRET in .env. Fill once below, then one-click will work."
          )
        );
      }
      beginGoogleOAuth(res, { clientId, clientSecret, redirectUri, senderEmail });
      return;
    }

    if (req.method === "GET" && pathname === "/v1/credit/oauth/callback") {
      const code = String(u.searchParams.get("code") || "");
      const state = String(u.searchParams.get("state") || "");
      if (!code || !state) {
        return html(res, 400, renderOAuthResult(false, "OAuth callback missing code/state", "Retry setup from /v1/credit/oauth/setup"));
      }
      const cfg = oauthStateStore.get(state);
      if (!cfg) {
        return html(res, 400, renderOAuthResult(false, "OAuth state expired", "Restart setup and complete consent within 15 minutes."));
      }
      oauthStateStore.delete(state);

      try {
        const google = getGoogleApis();
        const oauth2 = new google.auth.OAuth2(cfg.clientId, cfg.clientSecret, cfg.redirectUri);
        const tokenRes = await oauth2.getToken(code);
        const tokens = tokenRes.tokens || {};
        const refreshToken = String(tokens.refresh_token || "").trim();
        if (!refreshToken) {
          return html(
            res,
            400,
            renderOAuthResult(
              false,
              "No refresh token returned",
              "Google did not return a refresh token. Re-run and ensure prompt=consent, and remove prior app access if needed."
            )
          );
        }

        oauth2.setCredentials(tokens);
        const gmail = google.gmail({ version: "v1", auth: oauth2 });
        let email = cfg.senderEmail;
        try {
          const profile = await gmail.users.getProfile({ userId: "me" });
          if (!email && profile?.data?.emailAddress) email = String(profile.data.emailAddress).toLowerCase();
        } catch (_) {
          // ignore profile lookup errors; sender email remains optional
        }

        saveGoogleOAuthEnv({
          clientId: cfg.clientId,
          clientSecret: cfg.clientSecret,
          redirectUri: cfg.redirectUri,
          refreshToken,
          senderEmail: email,
        });

        return html(
          res,
          200,
          renderOAuthResult(
            true,
            "OAuth setup completed",
            `Saved GOOGLE_OAUTH_* to .env\nSender email: ${email || "(not set)"}\nYou can now run credit send/reply workflows.`
          )
        );
      } catch (err) {
        return html(res, 500, renderOAuthResult(false, "OAuth token exchange failed", err.message || String(err)));
      }
    }

    if (req.method === "POST" && pathname === "/v1/brands") {
      const raw = await collectBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const brand = await upsertBrandAndSecrets(body);
      const queue = await queueProvisionTask(brand.id, String(req.headers["x-user"] || "api"));
      const status = await getBrandStatus(brand.id);
      return json(res, 202, {
        brand_id: brand.id,
        status: status.brand.provisioning_status,
        task: queue,
        install: installSnippet(status.brand),
      });
    }

    const statusMatch = pathname.match(/^\/v1\/brands\/([^/]+)\/status$/);
    if (req.method === "GET" && statusMatch) {
      const key = decodeURIComponent(statusMatch[1]);
      const status = await getBrandStatus(key);
      if (!status) return json(res, 404, { error: "brand_not_found" });
      return json(res, 200, {
        brand: status.brand,
        install: installSnippet(status.brand),
        provisioning_tasks: status.tasks,
        provisioning_runs: status.runs,
      });
    }

    return json(res, 404, { error: "not_found" });
  } catch (err) {
    return json(res, 500, { error: err.message || String(err) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[brand-control-plane] listening on http://127.0.0.1:${PORT}`);
});
