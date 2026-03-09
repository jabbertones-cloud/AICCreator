# Content Marketing Machine — AICCreator Playbook

**Source:** Oliver Henry (Startup Ideas podcast), Inayan research, faceless content briefs.

## Draft-First Human-Finalize

**Higher virality:** Bot creates draft → human adds trending music on phone → post natively.

| Step | Who | Action |
|------|-----|--------|
| 1 | Bot | Generate content (script, hook, visuals) |
| 2 | Bot | Output to `outputs/drafts/<platform>/` with manifest |
| 3 | Human | Open draft folder on phone, add trending audio |
| 4 | Human | Post natively (TikTok, Reels, Shorts) |

**Commands:**
```bash
node scripts/aicc-autopublish.js draft --campaign reports/aicc-campaign-latest.json --platforms tiktok,instagram
```

## Hook + Demo Format

Oliver Henry pattern: text hook + demo clip/slide combination.
- Write hooks in a text file
- Script combines each hook with demo assets
- Produces batch variants for slideshow/carousel

**Commands:**
```bash
# 1. Create data/hooks.txt (one hook per line)
# 2. Add demo assets to data/demos/
node scripts/text-hooks-batch.js --hooks data/hooks.txt --topic "AI tools"
node scripts/aicc-autopublish.js draft --campaign reports/hook-demo-campaign-latest.json
```

## TikTok Slideshow

- Niche: `tiktok-slideshow`
- Hook-dominant first slide, demo/body slides follow
- Works with `carousel-gen` + video assembly

## Text Hooks Batch

File: `data/hooks.txt`
```
Most creators miss this {topic} shift until it's too late.
This {topic} update quietly changed the game today.
If you're building with AI, this {topic} move matters now.
```

Replace `{topic}` via `--topic` flag or leave for manual fill.

## Campaign Niches

| Niche | Use case |
|-------|----------|
| `tiktok-slideshow` | TikTok slideshow hook+demo (Oliver Henry) |
| `hook-demo` | Text hooks + script combination batch |
| `viral-faceless` | Short-form retention optimization |
| `ai-clone-news` | Rapid AI market change |
| `tiktok-affiliate` | TikTok affiliate marketing |
| `youtube-faceless` | Faceless YouTube growth |

## Full Pipeline

1. **Research** — `weekly-trends-brief`, `hook-thief`, Reddit/Inayan
2. **Campaign** — `aicc-campaign-engine --topic X --niche tiktok-slideshow`
3. **Hooks batch** (optional) — `text-hooks-batch --hooks data/hooks.txt`
4. **Carousel** — `carousel-gen --campaign reports/aicc-campaign-latest.json`
5. **Draft** — `aicc-autopublish draft` (human finalize on phone)
6. **Publish** — `aicc-autopublish run-due` (or human posts from drafts)

## Platform Draft Output

`outputs/drafts/<platform>/<variant_id>/`
- `manifest.json` — caption, hashtags, hook, title
- `*.mp4` — video (if available)
- Human: add trending music, post natively

## Mobile App Monetization from Content Traffic

**Flow (Oliver Henry pattern):** Content → Traffic → App → Revenue

| Step | Action | Tools |
|------|--------|-------|
| 1 | Create viral content (slideshows, hooks) | aicc-campaign-engine, carousel-gen |
| 2 | Publish to TikTok/Reels/Shorts | aicc-autopublish (draft or live) |
| 3 | Direct viewers to app (bio link, CTA) | TIKTOK_SHOP_AFFILIATE_URL, affiliate CTA |
| 4 | App monetization (subscription, IAP, ads) | Mobile app (external) |

**Env:** `TIKTOK_SHOP_AFFILIATE_URL` — UTM-tagged link in caption for app/shop.
**CTA templates:** "Link in bio", "Tap for the full workflow", "Download the app".

## TikTok Hook Analytics

Export TikTok post analytics (views, likes, caption) to JSON. See `data/tiktok-analytics-export.json.example` for format.
```bash
cp data/tiktok-analytics-export.json.example reports/tiktok-analytics-export.json
# Edit reports/tiktok-analytics-export.json with your data
node scripts/tiktok-hook-analytics.js --input reports/tiktok-analytics-export.json --update-library
```
Ranks hooks by viral score, updates hook-library.json for reuse.

## Hook Library → Campaign

```bash
node scripts/hook-library-to-campaign.js --to-hooks-txt --to-campaign --topic "AI tools"
```
Exports hook-library to hooks.txt and runs text-hooks-batch.

## Larry-Style Automation

```bash
node scripts/larry-autopublish-agent.js schedule   # Fill queue
node scripts/larry-autopublish-agent.js run        # Process due
```
Run via cron or PM2 for continuous posting.

## Video Assembly (Slides → Reels/Shorts)

```bash
node scripts/slides-to-video.js --manifest reports/carousel-manifest-latest.json --variant-id <uuid>
```
Assembles carousel slides into vertical video with ffmpeg.

## TikTok API Draft Upload

TikTok Content Posting API supports draft via **Upload to Inbox**: `POST /v2/post/publish/inbox/video/init/` (requires `video.upload` scope). Video goes to creator's TikTok app inbox for human to add music and publish. Set `AICC_TIKTOK_DRAFT=true` and use verified video URL. Default: local `outputs/drafts/` for maximum compatibility.
