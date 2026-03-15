// agents/classify-agent.js
// Semantic file classifier — OpenAI or Ollama provider (configurable).
//
// Two modes:
//   1. Extension-based (instant) — images, video, audio, archives
//      Category + MIME from file extension, no LLM needed.
//
//   2. Semantic pass (OpenAI/Ollama) — text, code, documents
//      Reads content_text from file_index, asks llama3 for:
//        • semantic_tags  (e.g. ['invoice','finance','2024','acme-corp'])
//        • semantic_summary (1-2 sentences)
//        • language (english / spanish / code / etc.)
//      Writes back to file_index and sets classified_at.
//
// Payload options:
//   {}                           — classify all unclassified files in file_index
//   { path: "~/Documents" }      — classify only files under this path
//   { limit: 200 }               — cap how many files to process per run
//   { force: true }              — re-classify even already-classified files
//   { files: ["/a.txt","/b.py"]} — classify a specific list (skips file_index query)
//
// Queue: claw_tasks_io  (io_light worker — Ollama runs on same machine)

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const http = require("http");
const { register } = require("./registry");
const { chat } = require("../infra/model-router");
require("dotenv").config();
const pg = require("../infra/postgres");

const CLASSIFY_PROVIDER = String(process.env.CLASSIFY_PROVIDER || "auto").trim().toLowerCase();
const OPENAI_CLASSIFY_MODEL_KEY = String(process.env.OPENAI_CLASSIFY_MODEL_KEY || "openai_mini").trim();
const OLLAMA_MODEL = process.env.OLLAMA_CLASSIFY_MODEL || "llama3";
const DEFAULT_LIMIT = 500;

function resolveOllamaEndpoint() {
  const raw = String(process.env.OLLAMA_HOST || "127.0.0.1").trim();
  const explicitPort = parseInt(process.env.OLLAMA_PORT || "11434", 10);
  try {
    if (/^https?:\/\//i.test(raw)) {
      const url = new URL(raw);
      return {
        hostname: url.hostname || "127.0.0.1",
        port: Number(url.port || explicitPort || 11434),
      };
    }
  } catch {}
  const cleaned = raw.replace(/^https?:\/\//i, "");
  const [hostOnly, maybePort] = cleaned.split(":");
  return {
    hostname: hostOnly || "127.0.0.1",
    port: Number(maybePort || explicitPort || 11434),
  };
}

const OLLAMA = resolveOllamaEndpoint();

function resolveClassifyProvider() {
  if (CLASSIFY_PROVIDER === "openai") return "openai";
  if (CLASSIFY_PROVIDER === "ollama") return "ollama";
  // auto mode: prefer OpenAI when configured
  if (process.env.OPENAI_API_KEY) return "openai";
  return "ollama";
}

// ── Extension map (same as index-agent, kept in sync) ────────────────────────
const EXT_MAP = {
  jpg:"image/jpeg",jpeg:"image/jpeg",png:"image/png",gif:"image/gif",
  webp:"image/webp",heic:"image/heic",heif:"image/heif",tiff:"image/tiff",
  bmp:"image/bmp",svg:"image/svg+xml",raw:"image/x-raw",
  cr2:"image/x-canon-cr2",nef:"image/x-nikon-nef",arw:"image/x-sony-arw",
  mp4:"video/mp4",mov:"video/quicktime",avi:"video/x-msvideo",
  mkv:"video/x-matroska",wmv:"video/x-ms-wmv",m4v:"video/x-m4v",
  mp3:"audio/mpeg",aac:"audio/aac",wav:"audio/wav",flac:"audio/flac",
  m4a:"audio/mp4",ogg:"audio/ogg",
  pdf:"application/pdf",doc:"application/msword",
  docx:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls:"application/vnd.ms-excel",
  xlsx:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt:"application/vnd.ms-powerpoint",
  pptx:"application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pages:"application/x-iwork-pages-sffpages",
  numbers:"application/x-iwork-numbers-sffnumbers",
  keynote:"application/x-iwork-keynote-sffkey",
  txt:"text/plain",md:"text/markdown",csv:"text/csv",
  json:"application/json",xml:"application/xml",
  js:"text/javascript",ts:"text/typescript",py:"text/x-python",
  sh:"text/x-shellscript",rb:"text/x-ruby",go:"text/x-go",
  rs:"text/x-rust",java:"text/x-java",swift:"text/x-swift",
  zip:"application/zip",tar:"application/x-tar",gz:"application/gzip",
  "7z":"application/x-7z-compressed",rar:"application/vnd.rar",
  dmg:"application/x-apple-diskimage",
};

// Categories that NEVER need LLM (pure binary content)
const BINARY_CATEGORIES = new Set(["image","video","audio","archive"]);

// ── Brand detection (path-based, deterministic) ──────────────────────────────
// Matches the same logic as scripts/classify-claw-files.js so both systems agree.
const BRAND_PATTERNS = [
  // ── Core brands ──────────────────────────────────────────────────────
  { match: /sweetoz/i,                                    brand: "sweetoz"          },
  { match: /reframed|re[\-_\s]framed/i,                   brand: "reframed"         },
  { match: /plush[\s._-]?trap|plushtrap/i,                brand: "plushtrap"        },
  { match: /wmac[\s._-]masters|wmac[\s\/_]/i,             brand: "wmac"             },
  { match: /cold[\s._-]?az[\s._-]?ice|coldazice/i,        brand: "coldazice"        },
  { match: /bips[\s._-]?topper|bipsrtopper/i,             brand: "bipstopper"       },
  { match: /zit[\s._-]?happens|zithappens/i,              brand: "zithappens"       },
  { match: /smash[\s._-]?wraps|smashwraps/i,              brand: "smashwraps"       },
  { match: /skyn[\s._-]?patch|skynpatch/i,                brand: "skynpatch"        },
  { match: /lemon[\s._-]?tree|lemontree/i,                brand: "lemontree"        },
  { match: /bws[\/_]/i,                                   brand: "bws"              },
  { match: /smat[\s._-]?design|SMAt.designs/i,            brand: "smat"             },
  { match: /\/smat\//i,                                   brand: "smat"             },
  { match: /talyoni/i,                                    brand: "talyoni"          },
  { match: /clawdbot|claw[\-_]architect|\/claw\//i,       brand: "clawdbot"         },
  // ── Apps portfolio ───────────────────────────────────────────────────
  { match: /\/gethipd\//i,                                brand: "gethipd"          },
  { match: /\/slangboard\/|\/1\.\s*slangboard\//i,        brand: "slangboard"       },
  { match: /\/sticker.?packs?\/|\/3\.\s*sticker\//i,      brand: "sticker_packs"    },
  { match: /\/social.?dashboard\/|\/4\.\s*social\/|\/5\.\s*mobile\//i, brand: "social_dashboard" },
  { match: /\/face.?off\/|\/6\.\s*face\//i,               brand: "face_off"         },
  { match: /\/cryptocoin\/|\/2\.\s*crypto\//i,            brand: "cryptocoin"       },
  { match: /\/rent.?check\/|\/8\.\s*rent\//i,             brand: "rent_check"       },
  { match: /\/7\.\s*shortcut\//i,                         brand: "shortcut_app"     },
  // ── Design brands (glowtray before glo to avoid false match) ─────────
  { match: /\/glowtray\//i,                               brand: "glowtray"         },
  { match: /\/glo\//i,                                    brand: "glo"              },
  { match: /\/trapcans\//i,                               brand: "trapcans"         },
  { match: /\/pastiesgang\/|\/pasties.?gang\//i,          brand: "pastiesgang"      },
  { match: /\/truefronto\//i,                             brand: "truefronto"       },
  { match: /\/famous\//i,                                 brand: "famous"           },
  { match: /\/rarewoods\//i,                              brand: "rarewoods"        },
  { match: /\/thenny\//i,                                 brand: "thenny"           },
  { match: /\/chefs?.?choice\//i,                         brand: "chefschoice"      },
  { match: /\/brands\/picnic\/|User.*\/picnic\//i,    brand: "picnic"           },
  { match: /\/brands\/draco\/|User.*\/draco\//i,      brand: "draco"            },
  { match: /\/sweet.?(and|&).?giggles\//i,                brand: "sweet_giggles"    },
  { match: /\/crass.?wipes\//i,                           brand: "crass_wipes"      },
  { match: /\/killacam\//i,                               brand: "killacam"         },
  { match: /\/lit.?stick\//i,                             brand: "lit_stick"        },
  { match: /\/treeats\/|\/tre.?eats\//i,                  brand: "treeats"          },
  { match: /\/luxup\//i,                                  brand: "luxup"            },
  { match: /\/cannasort\//i,                              brand: "cannasort"        },
  { match: /\/zutd\//i,                                   brand: "zutd"             },
  { match: /\/designer.?gummies\//i,                      brand: "designer_gummies" },
  { match: /\/sweet.?stache\//i,                          brand: "sweet_stache"     },
  { match: /\/day.?dreamers\/|\/liquid.?dreams\//i,       brand: "day_dreamers"     },
  { match: /\/jetlife\//i,                                brand: "jetlife"          },
  { match: /\/brands\/bootleg\//i,                        brand: "bootleg"          },
  { match: /\/sickwidit\//i,                              brand: "sickwidit"        },
  { match: /\/onac\//i,                                   brand: "onac"             },
  { match: /\/bcp.?caps\//i,                              brand: "bcp_caps"         },
  { match: /\/ecostyle\//i,                               brand: "ecostylegel"      },
  { match: /\/thcvarin\//i,                               brand: "thcvarin"         },
  { match: /\/norcalfarms\/|\/norcal.?farms\//i,          brand: "norcalfarms"      },
  { match: /\/mapsac\//i,                                 brand: "mapsac"           },
  { match: /\/ichiban\//i,                                brand: "ichiban_farms"    },
  { match: /\/cbd.?revamp\//i,                            brand: "cbd_revamp"       },
  { match: /\/brands\/labs\/|User.*\/labs\//i,        brand: "labs"             },
  { match: /\/kens?.?tko\//i,                             brand: "kens_tko"         },
  { match: /\/ipod.?store\//i,                            brand: "ipod_store"       },
  // ── aloc ────────────────────────────────────────────────────────────
  { match: /\/aloc\//i,                                   brand: "aloc"             },
  // ── Cookies wallet passes (two separate dispensary locations) ────────
  // Canonical live mapping:
  // - "CookiesPass ... copy" -> cookies
  // - other "CookiesPass"    -> nirvana
  { match: /CookiesPass.*copy|cookies.*tempe|tempe.*cookies/i, brand: "cookies"   },
  { match: /CookiesPass/i,                                     brand: "nirvana"   },
  { match: /\/cookies\//i,                                     brand: "cookies"   },
  // ── 3D Game Art Academy (website client) ────────────────────────────
  { match: /3DGameArtAcademy|3d.?game.?art.?academy/i,   brand: "3dgameartacademy" },
  // ── Ariel (3D / design work — blender assets, 3D projects) ──────────
  { match: /blenderkit_data|\/ariel\//i,                  brand: "ariel"            },
  // ── scottmanthey GitHub repos ────────────────────────────────────────
  { match: /scottmanthey/i,                               brand: "smat"             },
  // ── Photography / Shoots ────────────────────────────────────────────
  { match: /\/at.?photo\/|\/at photography\//i,           brand: "at_photography"   },
  { match: /\/astrokids\//i,                              brand: "astrokids"        },
  { match: /\/candy.?school\//i,                          brand: "candy_school"     },
  { match: /\/dd.?hemp\//i,                               brand: "dd_hemp"          },
  { match: /\/heaven.?sins\//i,                           brand: "heaven_sins"      },
  { match: /\/ecoco\//i,                                  brand: "ecoco"            },
  { match: /\/talent.?agency\//i,                         brand: "talent_agency"    },
];

function detectBrand(filePath) {
  if (!filePath) return null;
  for (const { match, brand } of BRAND_PATTERNS) {
    if (match.test(filePath)) return brand;
  }
  return null;
}

// ── Ollama HTTP call (no npm deps, Node built-in http) ───────────────────────
function ollamaChat(systemPrompt, userPrompt, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model:  OLLAMA_MODEL,
      stream: false,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt   },
      ],
    });

    const req = http.request(
      { hostname: OLLAMA.hostname, port: OLLAMA.port,
        path: "/api/chat", method: "POST",
        headers: { "Content-Type": "application/json",
                   "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        let data = "";
        res.on("data", chunk => { data += chunk; });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed?.message?.content || "");
          } catch { reject(new Error(`Ollama parse error: ${data.slice(0,200)}`)); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error("Ollama timeout")); });
    req.write(body);
    req.end();
  });
}

async function openaiChat(systemPrompt, userPrompt, timeoutMs = 60000) {
  const result = await chat("classify", systemPrompt, userPrompt, {
    timeout_ms: timeoutMs,
    json_mode: true,
    force_model: OPENAI_CLASSIFY_MODEL_KEY,
  });
  return {
    text: result?.text || "",
    model_used: result?.model_id || OPENAI_CLASSIFY_MODEL_KEY,
  };
}

// ── Parse LLM JSON response safely ───────────────────────────────────────────
function parseTagResponse(raw) {
  // LLM sometimes wraps in ```json ... ``` — strip it
  const clean = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  try {
    const obj = JSON.parse(clean);
    return {
      tags:     Array.isArray(obj.tags)    ? obj.tags.map(String).slice(0, 15) : [],
      summary:  typeof obj.summary === "string" ? obj.summary.slice(0, 500) : null,
      language: typeof obj.language === "string" ? obj.language.slice(0, 50) : null,
    };
  } catch {
    // fallback: extract any quoted words as tags
    const tags = [...raw.matchAll(/"([^"]{2,40})"/g)].map(m => m[1]).slice(0, 8);
    return { tags, summary: null, language: null };
  }
}

// ── Semantic classify via model-router (policy + fallback aware) ──────────────
async function semanticClassify(fileName, ext, category, contentText, brand) {
  const snippet = (contentText || "").slice(0, 3000); // cap context

  // Inject brand context so the LLM can generate brand-specific tags
  const brandHint = brand
    ? `\nBrand context: this file belongs to the "${brand}" brand/project. Include the brand name as a tag.`
    : "";

  const system = `You are a file classification assistant for a multi-brand business OS.
Respond with ONLY valid JSON — no markdown, no explanation.
Schema: { "tags": ["tag1","tag2",...], "summary": "1-2 sentence description", "language": "english|spanish|code|etc" }
Tags should be specific and useful for search: topic, project, brand, person, company, year, type, technology.
Keep tags lowercase, max 15 tags.${brandHint}`;

  const user = `File: ${fileName}
Type: ${category} (${ext || "no extension"})
Content preview:
${snippet || "(binary — no text extracted)"}`;

  const llm = await chat("classify", system, user, { timeout_ms: 45000 });
  return {
    ...parseTagResponse(llm.text || ""),
    model_used: llm.model_used || llm.model_id || llm.model_key || OLLAMA_MODEL,
    provider_used: llm.provider_used || llm.provider || resolveClassifyProvider(),
    confidence: llm.confidence ?? null,
    escalation_reason: llm.escalation_reason || null,
    cost_usd: Number(llm.cost_usd || 0),
    cache_hit: llm.cache_hit === true,
  };
}

// ── Classify a single file_index row ─────────────────────────────────────────
async function classifyRow(row) {
  const isBinary = BINARY_CATEGORIES.has(row.category);

  // Detect brand from full file path
  const brand = detectBrand(row.path);

  let tags = [], summary = null, language = null;
  let confidence = isBinary ? 0.98 : 0.65;
  let reason = isBinary ? `ext:${row.ext || "none"}` : "semantic_fallback";
  let modelUsed = isBinary ? "local-ext" : OLLAMA_MODEL;
  let providerUsed = isBinary ? "deterministic" : resolveClassifyProvider();
  let llmConfidence = null;
  let escalationReason = null;
  let llmCostUsd = 0;
  let cacheHit = false;

  if (!isBinary && (row.content_text || row.name)) {
    try {
      const sem = await semanticClassify(
        row.name, row.ext, row.category || "unknown", row.content_text, brand
      );
      tags = sem.tags;
      summary = sem.summary;
      language = sem.language;
      modelUsed = sem.model_used || modelUsed;
      providerUsed = sem.provider_used || providerUsed;
      llmConfidence = sem.confidence ?? llmConfidence;
      escalationReason = sem.escalation_reason || escalationReason;
      llmCostUsd += Number(sem.cost_usd || 0);
      cacheHit = cacheHit || sem.cache_hit === true;
      if (tags.length > 0 || summary) {
        confidence = 0.85;
        reason = "semantic_tags";
      }
    } catch (err) {
      console.warn(`[classify] semantic error for ${row.name}: ${err.message}`);
      // Non-fatal — still mark classified_at so we don't retry in a hot loop
    }
  }

  // For binary files, derive basic tags from filename + extension only
  // Prepend brand tag if detected so binary assets are still brand-searchable
  if (isBinary && tags.length === 0) {
    const nameParts = row.name.replace(/\.[^.]+$/, "").split(/[\s_\-\.]+/);
    tags = nameParts.filter(p => p.length > 2).map(p => p.toLowerCase()).slice(0, 6);
    if (brand && !tags.includes(brand)) tags.unshift(brand);
  }

  await pg.query(
    `UPDATE file_index SET
       semantic_tags    = $1,
       semantic_summary = $2,
       language         = $3,
       category_confidence = $4,
       category_reason  = $5,
       classified_at    = NOW(),
       classify_model   = $6,
       brand            = $7
     WHERE id = $8`,
    [tags.length ? tags : null, summary, language,
     confidence, reason, modelUsed, brand, row.id]
  );

  if (brand) console.log(`[classify] 🏷  ${row.name} → brand: ${brand}`);
  return {
    model_used: modelUsed,
    provider_used: providerUsed,
    confidence: llmConfidence,
    escalation_reason: escalationReason,
    cost_usd: llmCostUsd,
    cache_hit: cacheHit,
  };
}

// ── Main handler ─────────────────────────────────────────────────────────────
register("classify", async (payload) => {
  const force  = payload?.force  === true;
  const limit  = payload?.limit  || DEFAULT_LIMIT;
  const lowConfidenceThreshold =
    payload?.low_confidence_threshold == null
      ? null
      : Math.max(0, Math.min(1, Number(payload.low_confidence_threshold)));
  const rootPath = payload?.path
    ? (payload.path.startsWith("~/")
        ? path.join(os.homedir(), payload.path.slice(2))
        : payload.path)
    : null;

  // ── Mode A: specific file list (legacy compat) ──────────────────
  if (payload?.files && Array.isArray(payload.files)) {
    let done = 0;
    let totalCostUsd = 0;
    let lastDecision = null;
    for (const fp of payload.files) {
      const ext = path.extname(fp).toLowerCase().replace(".", "");
      const mime = EXT_MAP[ext] || "application/octet-stream";
      let contentText = null;
      try { contentText = fs.readFileSync(fp, "utf8").slice(0, 3000); } catch {}
      const brand = detectBrand(fp);
      const sem = await semanticClassify(
        path.basename(fp), ext, "unknown", contentText, brand
      );
      lastDecision = sem;
      totalCostUsd += Number(sem.cost_usd || 0);
      console.log(`[classify] ${path.basename(fp)} → [${(sem.tags || []).join(", ")}]${brand ? ` (${brand})` : ""}`);
      done++;
    }
    return {
      files_classified: done,
      cost_usd: Number(totalCostUsd.toFixed(6)),
      model_used: lastDecision?.model_used || (resolveClassifyProvider() === "openai" ? OPENAI_CLASSIFY_MODEL_KEY : OLLAMA_MODEL),
      provider_used: lastDecision?.provider_used || resolveClassifyProvider(),
      confidence: lastDecision?.confidence ?? null,
      escalation_reason: lastDecision?.escalation_reason || null,
      cache_hit: lastDecision?.cache_hit === true,
    };
  }

  // ── Mode B: process file_index rows ────────────────────────────
  let query, params;
  if (lowConfidenceThreshold != null && rootPath) {
    query  = `SELECT id, path, name, ext, category, content_text
              FROM file_index
              WHERE path LIKE $1
                AND (
                  classified_at IS NULL
                  OR category = 'unknown'
                  OR category_confidence IS NULL
                  OR category_confidence < $2
                )
              ORDER BY indexed_at DESC LIMIT $3`;
    params = [rootPath + "%", lowConfidenceThreshold, limit];
  } else if (lowConfidenceThreshold != null) {
    query  = `SELECT id, path, name, ext, category, content_text
              FROM file_index
              WHERE classified_at IS NULL
                 OR category = 'unknown'
                 OR category_confidence IS NULL
                 OR category_confidence < $1
              ORDER BY indexed_at DESC LIMIT $2`;
    params = [lowConfidenceThreshold, limit];
  } else if (rootPath && !force) {
    query  = `SELECT id, path, name, ext, category, content_text
              FROM file_index
              WHERE path LIKE $1 AND classified_at IS NULL
              ORDER BY indexed_at DESC LIMIT $2`;
    params = [rootPath + "%", limit];
  } else if (rootPath && force) {
    query  = `SELECT id, path, name, ext, category, content_text
              FROM file_index WHERE path LIKE $1
              ORDER BY indexed_at DESC LIMIT $2`;
    params = [rootPath + "%", limit];
  } else if (!force) {
    query  = `SELECT id, path, name, ext, category, content_text
              FROM file_index WHERE classified_at IS NULL
              ORDER BY indexed_at DESC LIMIT $1`;
    params = [limit];
  } else {
    query  = `SELECT id, path, name, ext, category, content_text
              FROM file_index ORDER BY indexed_at DESC LIMIT $1`;
    params = [limit];
  }

  const { rows } = await pg.query(query, params);

  if (rows.length === 0) {
    console.log("[classify] Nothing to classify.");
    return {
      files_classified: 0,
      cost_usd: 0,
      model_used: resolveClassifyProvider() === "openai" ? OPENAI_CLASSIFY_MODEL_KEY : OLLAMA_MODEL,
    };
  }

  console.log(`[classify] Processing ${rows.length} files with provider=${resolveClassifyProvider()}...`);

  let done = 0, errors = 0;
  let totalCostUsd = 0;
  let lastDecision = null;
  for (const row of rows) {
    try {
      const decision = await classifyRow(row);
      lastDecision = decision || lastDecision;
      totalCostUsd += Number(decision?.cost_usd || 0);
      done++;
      if (done % 10 === 0) {
        console.log(`[classify] ${done}/${rows.length} complete`);
      }
    } catch (err) {
      errors++;
      console.warn(`[classify] failed ${row.name}: ${err.message}`);
    }
  }

  // ── Summary stats ───────────────────────────────────────────────
  const { rows: stats } = await pg.query(
    `SELECT category, COUNT(*) as count
     FROM file_index WHERE classified_at IS NOT NULL
     GROUP BY category ORDER BY count DESC`
  );

  console.log(`[classify] ✓ done=${done} errors=${errors}`);

  return {
    files_classified: done,
    errors,
    remaining: rows.length - done,
    category_totals: Object.fromEntries(stats.map(r => [r.category, parseInt(r.count)])),
    cost_usd: Number(totalCostUsd.toFixed(6)),
    model_used: lastDecision?.model_used || (resolveClassifyProvider() === "openai" ? OPENAI_CLASSIFY_MODEL_KEY : OLLAMA_MODEL),
    provider_used: lastDecision?.provider_used || resolveClassifyProvider(),
    confidence: lastDecision?.confidence ?? null,
    escalation_reason: lastDecision?.escalation_reason || null,
    cache_hit: lastDecision?.cache_hit === true,
  };
});
