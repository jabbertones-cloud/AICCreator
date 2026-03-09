#!/usr/bin/env node
"use strict";
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const REPORTS = path.join(ROOT, "reports");
const CAROUSEL_DIR = path.join(ROOT, "media", "carousel");
const MEDIA_BROLL = path.join(ROOT, "media", "broll");
const MEDIA_DEMOS = path.join(ROOT, "data", "demos");

fs.mkdirSync(CAROUSEL_DIR, { recursive: true });

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function hasCanvas() {
  try {
    require.resolve("@napi-rs/canvas");
    return true;
  } catch {
    return false;
  }
}

async function generateSlideWithPuppeteer(slideContent, outputPath) {
  const tempHtmlPath = path.join(CAROUSEL_DIR, `temp_${Date.now()}.html`);

  const { title, hook, body, slideIndex, totalSlides } = slideContent;

  const htmlContent = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      margin: 0;
      padding: 0;
      width: 1080px;
      height: 1080px;
      background: white;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      position: relative;
      overflow: hidden;
    }
    .slide-container {
      width: 100%;
      height: 100%;
      padding: 60px;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      text-align: center;
      position: relative;
    }
    .title {
      font-size: 64px;
      font-weight: bold;
      color: #000;
      margin: 0 0 30px 0;
      line-height: 1.2;
    }
    .hook {
      font-size: 48px;
      color: #E63946;
      margin: 20px 0;
      line-height: 1.3;
      font-weight: 600;
    }
    .body {
      font-size: 36px;
      color: #333;
      margin: 30px 0;
      line-height: 1.4;
    }
    .progress-dots {
      position: absolute;
      bottom: 40px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      gap: 12px;
    }
    .dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #ccc;
    }
    .dot.active {
      background: #E63946;
      width: 32px;
      border-radius: 6px;
    }
  </style>
</head>
<body>
  <div class="slide-container">
    ${title ? `<div class="title">${escapeHtml(title)}</div>` : ""}
    ${hook ? `<div class="hook">${escapeHtml(hook)}</div>` : ""}
    ${body ? `<div class="body">${escapeHtml(body)}</div>` : ""}
    <div class="progress-dots">
      ${Array.from({ length: totalSlides }, (_, i) => `<div class="dot ${i === slideIndex - 1 ? "active" : ""}"></div>`).join("")}
    </div>
  </div>
  <script>
    function escapeHtml(text) {
      const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
      };
      return text.replace(/[&<>"']/g, m => map[m]);
    }
  </script>
</body>
</html>`;

  fs.writeFileSync(tempHtmlPath, htmlContent);

  try {
    const cmd = `node -e "const p=require('puppeteer');(async()=>{const b=await p.launch({args:['--no-sandbox']});const pg=await b.newPage();await pg.setViewport({width:1080,height:1080});await pg.goto('file://${tempHtmlPath}');await pg.screenshot({path:'${outputPath}'});await b.close();})()"`;
    execSync(cmd, { stdio: "pipe" });
    fs.unlinkSync(tempHtmlPath);
    return { ok: true, path: outputPath };
  } catch (err) {
    fs.unlinkSync(tempHtmlPath).catch(() => {});
    return { ok: false, error: err.message };
  }
}

function escapeHtml(text) {
  const map = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return String(text).replace(/[&<>"']/g, (m) => map[m]);
}

function buildSlides(variant) {
  const hook = variant.hook || "";
  const body = variant.body || "";
  const cta = variant.cta || "";
  const topic = variant.title ? variant.title.split("|")[0].trim() : "Content";

  const bodyParts = body.split(/(?:Problem:|System:|Proof:|Execution:)/);
  const cleanParts = bodyParts
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, 3);

  const slides = [
    {
      index: 1,
      title: "Hook",
      hook: hook,
      body: null,
      text: hook,
    },
    {
      index: 2,
      title: "The Problem",
      hook: null,
      body: cleanParts[0] || "Missing key insights",
      text: cleanParts[0] || "Missing key insights",
    },
    {
      index: 3,
      title: "Key Point 1",
      hook: null,
      body: cleanParts[1] ? cleanParts[1].slice(0, 80) : "Critical insight",
      text: cleanParts[1] ? cleanParts[1].slice(0, 80) : "Critical insight",
    },
    {
      index: 4,
      title: "Key Point 2",
      hook: null,
      body: cleanParts[2]
        ? cleanParts[2].slice(0, 80)
        : "Drive engagement and reach",
      text: cleanParts[2] ? cleanParts[2].slice(0, 80) : "Drive engagement and reach",
    },
    {
      index: 5,
      title: "Key Point 3",
      hook: null,
      body: "Build systems that scale automatically",
      text: "Build systems that scale automatically",
    },
    {
      index: 6,
      title: "Social Proof",
      hook: null,
      body: "Join thousands shipping daily",
      text: "Join thousands shipping daily",
    },
    {
      index: 7,
      title: "Final CTA",
      hook: cta,
      body: null,
      text: cta,
    },
  ];

  return slides;
}

/**
 * Hook+demo format: slide 1 = text hook only, slides 2+ = demo images from media pool.
 * Use with --format hook-demo and --media-pool path/to/demos
 */
function buildSlidesHookDemo(variant, demoImagePaths = []) {
  const hook = variant.hook || variant.title || "";
  const cta = variant.cta || "Save this. Use it in your next post.";

  const slides = [
    { index: 1, title: "Hook", hook, body: null, text: hook, isHook: true },
  ];

  if (demoImagePaths.length > 0) {
    demoImagePaths.slice(0, 5).forEach((imgPath, i) => {
      slides.push({
        index: slides.length + 1,
        title: `Demo ${i + 1}`,
        hook: null,
        body: null,
        text: `Demo image ${i + 1}`,
        imagePath: imgPath,
        isDemo: true,
      });
    });
  } else {
    slides.push({
      index: 2,
      title: "Key Point",
      hook: null,
      body: (variant.description || variant.body || "").slice(0, 80),
      text: (variant.description || variant.body || "").slice(0, 80),
      isDemo: false,
    });
  }

  slides.push({
    index: slides.length + 1,
    title: "CTA",
    hook: cta,
    body: null,
    text: cta,
    isHook: false,
  });

  return slides.map((s, i) => ({ ...s, index: i + 1 }));
}

function listMediaPool(mediaPoolDir) {
  if (!mediaPoolDir || !fs.existsSync(mediaPoolDir)) return [];
  return fs
    .readdirSync(mediaPoolDir)
    .filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f))
    .map((f) => path.join(mediaPoolDir, f))
    .sort();
}

async function main() {
  const campaignPath = arg("--campaign", null);
  const format = (arg("--format", "default") || "default").toLowerCase();
  const mediaPoolDir = arg("--media-pool", null) || MEDIA_DEMOS;

  if (!campaignPath) {
    console.error("--campaign flag is required");
    process.exit(1);
  }

  let campaign;
  try {
    campaign = JSON.parse(fs.readFileSync(campaignPath, "utf8"));
  } catch (err) {
    console.error(`Failed to read campaign: ${err.message}`);
    process.exit(1);
  }

  const variants = campaign.variants || [];
  if (!Array.isArray(variants) || !variants.length) {
    console.error("Campaign has no variants");
    process.exit(1);
  }

  const demoPaths = listMediaPool(mediaPoolDir);
  const useHookDemo = format === "hook-demo" || campaign.format === "hook_demo";

  const carouselManifest = [];

  for (let vIdx = 0; vIdx < variants.length; vIdx++) {
    const variant = variants[vIdx];
    const demosForVariant = demoPaths.length > 0
      ? demoPaths.slice((vIdx * 3) % demoPaths.length)
      : [];
    const slides = useHookDemo
      ? buildSlidesHookDemo(variant, demosForVariant)
      : buildSlides(variant);
    const variantSlides = [];

    for (const slide of slides) {
      const slideOutputPath = path.join(
        CAROUSEL_DIR,
        `${variant.id}_slide_${slide.index}.png`
      );

      console.log(
        `[carousel-gen] Generating slide ${slide.index}/7 for variant ${variant.id}`
      );

      const totalSlides = slides.length;
      let result;
      if (slide.imagePath && fs.existsSync(slide.imagePath)) {
        try {
          fs.copyFileSync(slide.imagePath, slideOutputPath);
          result = { ok: true, path: slideOutputPath };
        } catch (e) {
          result = { ok: false, error: e.message };
        }
      } else {
        result = await generateSlideWithPuppeteer(
            {
              title: slide.title,
              hook: slide.hook,
              body: slide.body,
              slideIndex: slide.index,
              totalSlides,
            },
            slideOutputPath
          );
      }

      if (result.ok) {
        variantSlides.push({
          index: slide.index,
          text: slide.text,
          image_path: slideOutputPath,
        });
      } else {
        console.warn(
          `[carousel-gen] Failed to generate slide ${slide.index}: ${result.error}`
        );
      }
    }

    if (variantSlides.length > 0) {
      carouselManifest.push({
        variant_id: variant.id,
        slides_count: variantSlides.length,
        slides: variantSlides,
      });
    }
  }

  const manifestPath = path.join(REPORTS, "carousel-manifest-latest.json");
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(carouselManifest, null, 2));

  console.log(`[carousel-gen] Wrote manifest to ${manifestPath}`);
  console.log(
    `[carousel-gen] Generated ${carouselManifest.length} carousel(s) with ${carouselManifest.reduce((sum, c) => sum + c.slides_count, 0)} total slides`
  );

  if (!hasCanvas()) {
    console.log(
      "[carousel-gen] Note: puppeteer not found. Install with: npm install puppeteer"
    );
  }
}

main().catch((err) => {
  console.error(`carousel-gen failed: ${err.message}`);
  process.exit(1);
});
