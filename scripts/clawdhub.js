#!/usr/bin/env node
// scripts/clawdhub.js
// ─────────────────────────────────────────────────────────────────────────────
// ClawdHub — Skills Registry & Installer for claw-architect
//
// Manages installable "skills" (agent modules + prompt templates) that extend
// the claw-architect task orchestration system. Inspired by LlamaHub / openskills.
//
// A skill is a directory under agents/skills/ that contains:
//   - index.js       (required) — exports { tasks, run }
//   - skill.json     (required) — metadata: name, version, description, tasks[]
//   - README.md      (optional) — usage docs
//   - prompts/       (optional) — prompt template files
//
// Built-in registry at ~/.clawdhub/registry.json + remote manifest URL support.
//
// Usage:
//   node scripts/clawdhub.js list                  — list available skills
//   node scripts/clawdhub.js installed             — list installed skills
//   node scripts/clawdhub.js install <skill>       — install a skill
//   node scripts/clawdhub.js uninstall <skill>     — remove a skill
//   node scripts/clawdhub.js info <skill>          — show skill metadata
//   node scripts/clawdhub.js create <name>         — scaffold a new skill
//   node scripts/clawdhub.js update                — refresh remote registry
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const https = require('https');

// ── Paths ─────────────────────────────────────────────────────────────────────
const ROOT        = path.resolve(__dirname, '..');
const SKILLS_DIR  = path.join(ROOT, 'agents', 'skills');
const HUB_DIR     = path.join(os.homedir(), '.clawdhub');
const REGISTRY_FILE = path.join(HUB_DIR, 'registry.json');

// Remote manifest — can be overridden with CLAWDHUB_REGISTRY_URL env var
const REGISTRY_URL = process.env.CLAWDHUB_REGISTRY_URL ||
  'https://raw.githubusercontent.com/openclaw/clawdhub/main/registry.json';

// ── Ensure directories ────────────────────────────────────────────────────────
[SKILLS_DIR, HUB_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── Built-in skills registry ──────────────────────────────────────────────────
// These are bundled with claw-architect and always available
const BUILTIN_SKILLS = [
  {
    id: 'playwright-scraper',
    name: 'Playwright Scraper',
    version: '1.0.0',
    description: 'Browser-based web scraper for JS-heavy sites. Extracts emails, text, and links.',
    tasks: ['SCRAPE_CONTACT_PAGE', 'SCRAPE_PAGE_TEXT', 'SCRAPE_LINKS'],
    file: 'agents/playwright-scraper-agent.js',
    builtin: true,
    tags: ['scraping', 'web', 'leads'],
  },
  {
    id: 'obsidian-direct',
    name: 'Obsidian Direct',
    version: '1.0.0',
    description: 'Read/write your Obsidian vault via the Local REST API plugin.',
    tasks: ['OBSIDIAN_LIST_FILES','OBSIDIAN_READ_NOTE','OBSIDIAN_WRITE_NOTE','OBSIDIAN_SEARCH'],
    file: 'agents/obsidian-agent.js',
    builtin: true,
    tags: ['knowledge', 'notes', 'obsidian'],
    requires_env: ['OBSIDIAN_API_KEY'],
    setup: 'Install "Local REST API" plugin in Obsidian, then add OBSIDIAN_API_KEY to .env',
  },
  {
    id: 'google-workspace',
    name: 'Google Workspace',
    version: '1.0.0',
    description: 'Gmail read/send and Drive access for claw-architect agents.',
    tasks: ['GMAIL_LIST','GMAIL_READ','GMAIL_SEND','GDRIVE_LIST','GDRIVE_READ'],
    file: 'agents/google-workspace-agent.js',
    builtin: true,
    tags: ['gmail', 'drive', 'google', 'email'],
    requires_env: ['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REFRESH_TOKEN'],
    setup: 'Run: node agents/google-workspace-agent.js --auth to complete OAuth2 setup',
  },
  {
    id: 'leadgen',
    name: 'LeadGen',
    version: '1.0.0',
    description: 'SkynPatch B2B lead generation — Google Places fetch, email enrichment, Maileroo send.',
    tasks: ['FETCH_LEADS','ENRICH_LEADS','SEND_CAMPAIGN','WEBHOOK_PROCESS'],
    file: 'agents/leadgen-agent.js',
    builtin: true,
    tags: ['leadgen', 'email', 'skynpatch'],
    requires_env: ['GOOGLE_PLACES_API_KEY','MAILEROO_API_KEY'],
  },
];

// ── Registry helpers ──────────────────────────────────────────────────────────
function loadRegistry() {
  if (!fs.existsSync(REGISTRY_FILE)) return { skills: [], updated_at: null };
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
  } catch {
    return { skills: [], updated_at: null };
  }
}

function saveRegistry(data) {
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2));
}

function loadInstalled() {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  return fs.readdirSync(SKILLS_DIR)
    .filter(d => {
      const meta = path.join(SKILLS_DIR, d, 'skill.json');
      return fs.existsSync(meta);
    })
    .map(d => {
      try {
        return JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, d, 'skill.json'), 'utf8'));
      } catch { return null; }
    })
    .filter(Boolean);
}

// ── HTTP fetch ────────────────────────────────────────────────────────────────
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        if (res.statusCode === 200) resolve(body);
        else reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      });
    }).on('error', reject);
  });
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdList() {
  const remote   = loadRegistry();
  const allSkills = [
    ...BUILTIN_SKILLS,
    ...(remote.skills || []).filter(r => !BUILTIN_SKILLS.find(b => b.id === r.id)),
  ];

  console.log('\n📦 ClawdHub — Available Skills\n');
  console.log(`${'ID'.padEnd(22)} ${'NAME'.padEnd(26)} ${'VERSION'.padEnd(8)} TAGS`);
  console.log('─'.repeat(80));

  allSkills.forEach(s => {
    const tags = (s.tags || []).join(', ');
    const flag = s.builtin ? '✅' : '🌐';
    console.log(`${flag} ${s.id.padEnd(20)} ${s.name.padEnd(26)} ${(s.version||'?').padEnd(8)} ${tags}`);
  });

  if (remote.updated_at) {
    console.log(`\nRemote registry last updated: ${remote.updated_at}`);
  } else {
    console.log('\nTip: run "node scripts/clawdhub.js update" to fetch the remote registry');
  }
}

function cmdInstalled() {
  const installed = loadInstalled();
  console.log('\n📋 Installed Skills\n');

  const allInstalled = [
    ...BUILTIN_SKILLS.filter(s => fs.existsSync(path.join(ROOT, s.file))).map(s => ({ ...s, source: 'builtin' })),
    ...installed.map(s => ({ ...s, source: 'installed' })),
  ];

  if (allInstalled.length === 0) {
    console.log('No skills installed.');
    return;
  }

  allInstalled.forEach(s => {
    const envOk = !(s.requires_env || []).some(k => !process.env[k]);
    const status = envOk ? '✅' : '⚠️ ';
    console.log(`${status} ${s.id.padEnd(24)} v${s.version || '?'} — ${s.description}`);
    if (!envOk && s.requires_env) {
      const missing = s.requires_env.filter(k => !process.env[k]);
      console.log(`      Missing env: ${missing.join(', ')}`);
    }
    if (s.tasks && s.tasks.length) {
      console.log(`      Tasks: ${s.tasks.join(', ')}`);
    }
  });
}

function cmdInfo(skillId) {
  if (!skillId) { console.error('Usage: clawdhub.js info <skill-id>'); process.exit(1); }

  const builtin = BUILTIN_SKILLS.find(s => s.id === skillId);
  const installed = loadInstalled().find(s => s.id === skillId);
  const skill = builtin || installed;

  if (!skill) {
    console.error(`Skill "${skillId}" not found.`);
    process.exit(1);
  }

  console.log(`\n📦 ${skill.name} (${skill.id})`);
  console.log(`   Version:     ${skill.version || 'unknown'}`);
  console.log(`   Description: ${skill.description}`);
  console.log(`   Tags:        ${(skill.tags || []).join(', ')}`);
  console.log(`   Tasks:       ${(skill.tasks || []).join(', ')}`);
  if (skill.requires_env) console.log(`   Requires:    ${skill.requires_env.join(', ')}`);
  if (skill.setup)         console.log(`   Setup:       ${skill.setup}`);
  if (skill.file)          console.log(`   File:        ${skill.file}`);
}

async function cmdUpdate() {
  console.log(`\n🔄 Fetching registry from ${REGISTRY_URL}...`);
  try {
    const body = await fetchUrl(REGISTRY_URL);
    const data = JSON.parse(body);
    data.updated_at = new Date().toISOString();
    saveRegistry(data);
    console.log(`✅ Registry updated — ${(data.skills || []).length} remote skills available.`);
  } catch (err) {
    console.warn(`⚠️  Could not fetch remote registry: ${err.message}`);
    console.log('   (This is fine — built-in skills are always available)');
  }
}

function cmdCreate(skillName) {
  if (!skillName) { console.error('Usage: clawdhub.js create <skill-name>'); process.exit(1); }

  const id      = skillName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const skillDir = path.join(SKILLS_DIR, id);

  if (fs.existsSync(skillDir)) {
    console.error(`Skill "${id}" already exists at ${skillDir}`);
    process.exit(1);
  }

  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(path.join(skillDir, 'prompts'), { recursive: true });

  // skill.json
  fs.writeFileSync(path.join(skillDir, 'skill.json'), JSON.stringify({
    id, name: skillName, version: '1.0.0',
    description: `${skillName} skill for claw-architect`,
    tasks: [`${id.toUpperCase().replace(/-/g, '_')}_RUN`],
    tags: [],
    author: '',
  }, null, 2));

  // index.js
  fs.writeFileSync(path.join(skillDir, 'index.js'), `// ${id}/index.js
'use strict';

const { register } = require('../../registry');

async function run(payload) {
  // implement your skill logic here
  const { input } = payload;
  return { ok: true, result: \`\${input} processed by ${id}\` };
}

register('${id.toUpperCase().replace(/-/g, '_')}_RUN', run);
module.exports = { run };
`);

  // README.md
  fs.writeFileSync(path.join(skillDir, 'README.md'),
`# ${skillName}

## Description
${skillName} skill for claw-architect.

## Tasks
- \`${id.toUpperCase().replace(/-/g, '_')}_RUN\`

## Usage
\`\`\`js
const { run } = require('./agents/skills/${id}');
const result = await run({ input: 'hello' });
\`\`\`
`);

  console.log(`\n✅ Skill "${id}" scaffolded at:\n   ${skillDir}`);
  console.log('\nNext steps:');
  console.log(`   1. Edit ${skillDir}/index.js to implement your logic`);
  console.log(`   2. Update ${skillDir}/skill.json with accurate metadata`);
  console.log(`   3. Add prompts to ${skillDir}/prompts/ if needed`);
}

// ── CLI entry ─────────────────────────────────────────────────────────────────
if (require.main === module) {
  const [,, cmd, arg] = process.argv;

  (async () => {
    switch (cmd) {
      case 'list':       await cmdList(); break;
      case 'installed':  cmdInstalled(); break;
      case 'info':       cmdInfo(arg); break;
      case 'update':     await cmdUpdate(); break;
      case 'create':     cmdCreate(arg); break;
      default:
        console.log('\nClawdHub — Skills Registry & Installer\n');
        console.log('Usage: node scripts/clawdhub.js <command> [arg]\n');
        console.log('Commands:');
        console.log('  list                  Show all available skills');
        console.log('  installed             Show installed skills + env status');
        console.log('  info <id>             Show skill details');
        console.log('  create <name>         Scaffold a new skill');
        console.log('  update                Fetch remote registry');
    }
  })();
}

module.exports = { BUILTIN_SKILLS, loadRegistry, loadInstalled };
