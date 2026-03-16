// agents/google-workspace-agent.js
// ─────────────────────────────────────────────────────────────────────────────
// Google Workspace — Gmail + Drive connector for claw-architect
//
// Uses the official `googleapis` npm package (OAuth2).
// Designed for creator@yourdomain.com (or any Google Workspace account).
//
// ── One-time OAuth2 Setup ────────────────────────────────────────────────────
//  1. Go to https://console.cloud.google.com
//  2. Create a project → APIs & Services → Enable:
//       - Gmail API
//       - Google Drive API
//  3. OAuth 2.0 Credentials → Desktop App → Download JSON
//  4. Run:  node agents/google-workspace-agent.js --auth
//     Follow the URL, paste the code, tokens are saved to .google-tokens.json
//  5. Copy to .env:
//       GOOGLE_CLIENT_ID=...
//       GOOGLE_CLIENT_SECRET=...
//       GOOGLE_REFRESH_TOKEN=...   (from .google-tokens.json)
//
// Registered task types:
//   GMAIL_LIST       — list recent email threads
//   GMAIL_READ       — read a specific message
//   GMAIL_SEND       — send an email
//   GMAIL_LABEL      — apply a label to a message
//   GDRIVE_LIST      — list files in Drive
//   GDRIVE_READ      — read a Google Doc as plain text
//   GDRIVE_SEARCH    — search Drive for files
//
// CLI usage:
//   node agents/google-workspace-agent.js --auth
//   node agents/google-workspace-agent.js --cmd gmail-list --limit 10
//   node agents/google-workspace-agent.js --cmd gmail-send --to bob@yourdomain.com \
//     --subject "Hello" --body "Hey there"
//   node agents/google-workspace-agent.js --cmd drive-list --folder root
//   node agents/google-workspace-agent.js --cmd drive-search --query "SkynPatch"
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { register } = require('./registry');

// ── Try loading googleapis (optional dep) ─────────────────────────────────────
let google;
try {
  google = require('googleapis').google;
} catch {
  // Not installed yet — we show a helpful error when commands run
}

const TOKENS_FILE = path.join(__dirname, '..', '.google-tokens.json');

// ── Config ────────────────────────────────────────────────────────────────────
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI  = 'urn:ietf:wg:oauth:2.0:oob'; // desktop app flow
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive.readonly',
];

// ── OAuth2 client factory ─────────────────────────────────────────────────────
function getOAuth2Client() {
  if (!google)        throw new Error('googleapis not installed. Run: npm install googleapis');
  if (!CLIENT_ID)     throw new Error('GOOGLE_CLIENT_ID not set in .env');
  if (!CLIENT_SECRET) throw new Error('GOOGLE_CLIENT_SECRET not set in .env');

  const auth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

  // Load stored tokens
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (refreshToken) {
    auth.setCredentials({ refresh_token: refreshToken });
  } else if (fs.existsSync(TOKENS_FILE)) {
    const tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    auth.setCredentials(tokens);
  } else {
    throw new Error('No Google tokens found. Run: node agents/google-workspace-agent.js --auth');
  }

  // Auto-refresh on token expiry
  auth.on('tokens', (tokens) => {
    if (tokens.refresh_token) {
      const existing = fs.existsSync(TOKENS_FILE)
        ? JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'))
        : {};
      fs.writeFileSync(TOKENS_FILE, JSON.stringify({ ...existing, ...tokens }, null, 2));
    }
  });

  return auth;
}

// ── GMAIL_LIST ────────────────────────────────────────────────────────────────
async function gmailList({ limit = 20, query = '', label = 'INBOX' } = {}) {
  const auth  = getOAuth2Client();
  const gmail = google.gmail({ version: 'v1', auth });

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    maxResults: limit,
    q: [query, `label:${label}`].filter(Boolean).join(' '),
  });

  const messages = listRes.data.messages || [];

  const details = await Promise.all(
    messages.slice(0, limit).map(async ({ id }) => {
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Date'],
      });
      const headers = {};
      (msg.data.payload?.headers || []).forEach(h => { headers[h.name] = h.value; });
      return {
        id,
        subject: headers.Subject || '(no subject)',
        from:    headers.From    || '',
        date:    headers.Date    || '',
        snippet: msg.data.snippet || '',
      };
    })
  );

  return { messages: details, count: details.length, query };
}

// ── GMAIL_READ ────────────────────────────────────────────────────────────────
async function gmailRead({ message_id }) {
  if (!message_id) throw new Error('message_id is required');
  const auth  = getOAuth2Client();
  const gmail = google.gmail({ version: 'v1', auth });

  const msg = await gmail.users.messages.get({
    userId: 'me', id: message_id, format: 'full',
  });

  const headers = {};
  (msg.data.payload?.headers || []).forEach(h => { headers[h.name] = h.value; });

  // Extract body text
  function decodeBody(payload) {
    if (!payload) return '';
    if (payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf8');
    }
    if (payload.parts) {
      for (const part of payload.parts) {
        const text = decodeBody(part);
        if (text) return text;
      }
    }
    return '';
  }

  const bodyRaw  = decodeBody(msg.data.payload);
  const bodyText = bodyRaw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  return {
    id:      message_id,
    subject: headers.Subject || '',
    from:    headers.From    || '',
    to:      headers.To      || '',
    date:    headers.Date    || '',
    body:    bodyText.slice(0, 4000),
  };
}

// ── GMAIL_SEND ────────────────────────────────────────────────────────────────
async function gmailSend({ to, subject, body, html_body, from_name = 'Scott @ SkynPatch' }) {
  if (!to)      throw new Error('to is required');
  if (!subject) throw new Error('subject is required');

  const auth  = getOAuth2Client();
  const gmail = google.gmail({ version: 'v1', auth });

  const profile = await gmail.users.getProfile({ userId: 'me' });
  const fromEmail = profile.data.emailAddress;

  const contentType = html_body ? 'text/html' : 'text/plain';
  const bodyContent = html_body || body || '';

  const raw = [
    `From: "${from_name}" <${fromEmail}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: ${contentType}; charset=UTF-8`,
    '',
    bodyContent,
  ].join('\r\n');

  const encoded = Buffer.from(raw).toString('base64url');

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encoded },
  });

  return { ok: true, message_id: res.data.id, thread_id: res.data.threadId };
}

// ── GMAIL_LABEL ───────────────────────────────────────────────────────────────
async function gmailLabel({ message_id, add_labels = [], remove_labels = [] }) {
  if (!message_id) throw new Error('message_id is required');
  const auth  = getOAuth2Client();
  const gmail = google.gmail({ version: 'v1', auth });

  await gmail.users.messages.modify({
    userId: 'me',
    id: message_id,
    requestBody: { addLabelIds: add_labels, removeLabelIds: remove_labels },
  });

  return { ok: true, message_id, add_labels, remove_labels };
}

// ── GDRIVE_LIST ───────────────────────────────────────────────────────────────
async function driveList({ folder = 'root', limit = 30, mime_type = '' } = {}) {
  const auth  = getOAuth2Client();
  const drive = google.drive({ version: 'v3', auth });

  const q = [
    `'${folder}' in parents`,
    'trashed = false',
    mime_type ? `mimeType = '${mime_type}'` : '',
  ].filter(Boolean).join(' and ');

  const res = await drive.files.list({
    q,
    pageSize: limit,
    fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink)',
  });

  return {
    files: res.data.files || [],
    count: (res.data.files || []).length,
    folder,
  };
}

// ── GDRIVE_READ ───────────────────────────────────────────────────────────────
async function driveRead({ file_id }) {
  if (!file_id) throw new Error('file_id is required');
  const auth  = getOAuth2Client();
  const drive = google.drive({ version: 'v3', auth });

  // Get file metadata
  const meta = await drive.files.get({
    fileId: file_id,
    fields: 'id,name,mimeType',
  });

  const mime = meta.data.mimeType;

  // Google Docs → export as plain text
  if (mime === 'application/vnd.google-apps.document') {
    const res = await drive.files.export(
      { fileId: file_id, mimeType: 'text/plain' },
      { responseType: 'stream' }
    );
    const chunks = [];
    await new Promise((resolve, reject) => {
      res.data.on('data', c => chunks.push(c));
      res.data.on('end', resolve);
      res.data.on('error', reject);
    });
    const text = Buffer.concat(chunks).toString('utf8');
    return { ok: true, file_id, name: meta.data.name, mime, text: text.slice(0, 10_000) };
  }

  // Binary / other — return metadata only
  return {
    ok: true, file_id, name: meta.data.name, mime,
    note: 'Binary file — use webViewLink to open in browser',
  };
}

// ── GDRIVE_SEARCH ─────────────────────────────────────────────────────────────
async function driveSearch({ query, limit = 20 }) {
  if (!query) throw new Error('query is required');
  const auth  = getOAuth2Client();
  const drive = google.drive({ version: 'v3', auth });

  const res = await drive.files.list({
    q: `fullText contains '${query.replace(/'/g, "\\'")}' and trashed = false`,
    pageSize: limit,
    fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
  });

  return { query, files: res.data.files || [], count: (res.data.files || []).length };
}

// ── Register task handlers ────────────────────────────────────────────────────
register('GMAIL_LIST',    gmailList);
register('GMAIL_READ',    gmailRead);
register('GMAIL_SEND',    gmailSend);
register('GMAIL_LABEL',   gmailLabel);
register('GDRIVE_LIST',   driveList);
register('GDRIVE_READ',   driveRead);
register('GDRIVE_SEARCH', driveSearch);

// ── OAuth2 Auth flow (CLI --auth) ─────────────────────────────────────────────
async function runAuthFlow() {
  if (!google) {
    console.error('\n⚠️  googleapis not installed.');
    console.error('   Run: npm install googleapis\n');
    process.exit(1);
  }
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('\n⚠️  GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be in .env');
    console.error('   1. Go to https://console.cloud.google.com');
    console.error('   2. APIs & Services → Credentials → Create OAuth 2.0 Client (Desktop App)');
    console.error('   3. Add client_id and client_secret to .env\n');
    process.exit(1);
  }

  const auth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  const url  = auth.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });

  console.log('\n🔐 Google Workspace OAuth2 Setup\n');
  console.log('1. Open this URL in your browser:');
  console.log(`\n   ${url}\n`);
  console.log('2. Sign in as creator@yourdomain.com');
  console.log('3. Allow permissions');
  console.log('4. Copy the authorization code\n');

  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  rl.question('Paste authorization code: ', async (code) => {
    rl.close();
    try {
      const { tokens } = await auth.getToken(code.trim());
      auth.setCredentials(tokens);
      fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
      console.log('\n✅ Tokens saved to .google-tokens.json');
      console.log('\nAdd to .env:');
      console.log(`   GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
    } catch (err) {
      console.error('Error exchanging code:', err.message);
    }
  });
}

// ── CLI mode ──────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i+1] : null; };

  if (args.includes('--auth')) {
    runAuthFlow();
  } else {
    const cmd   = getArg('--cmd') || 'help';
    const limit = parseInt(getArg('--limit') || '10', 10);
    const to    = getArg('--to');
    const subj  = getArg('--subject');
    const body  = getArg('--body');
    const query = getArg('--query') || '';
    const id    = getArg('--id')    || '';
    const folder = getArg('--folder') || 'root';

    (async () => {
      try {
        let result;
        switch (cmd) {
          case 'gmail-list':   result = await gmailList({ limit, query }); break;
          case 'gmail-read':   result = await gmailRead({ message_id: id }); break;
          case 'gmail-send':   result = await gmailSend({ to, subject: subj, body }); break;
          case 'drive-list':   result = await driveList({ folder, limit }); break;
          case 'drive-search': result = await driveSearch({ query, limit }); break;
          case 'drive-read':   result = await driveRead({ file_id: id }); break;
          default:
            console.log('\nUsage: node agents/google-workspace-agent.js [--auth] [--cmd <cmd>]\n');
            console.log('Commands:');
            console.log('  --auth                  Run OAuth2 setup flow');
            console.log('  --cmd gmail-list        List recent emails');
            console.log('  --cmd gmail-read --id   Read a message');
            console.log('  --cmd gmail-send --to --subject --body');
            console.log('  --cmd drive-list        List Drive files');
            console.log('  --cmd drive-search --query');
            console.log('  --cmd drive-read --id   Read a Google Doc');
            return;
        }
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error('Error:', err.message);
        process.exitCode = 1;
      }
    })();
  }
}

module.exports = { gmailList, gmailRead, gmailSend, gmailLabel, driveList, driveRead, driveSearch };
