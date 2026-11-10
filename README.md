# SEO & AI Search Monitor: Weekly Audit, Alerts + llms.txt

[![Run on Apify](https://apify.com/ext/run-on-apify.png)](https://apify.com/mirumiru_miru17/seo-ai-readiness-audit)

**Run it in the cloud with no setup: [apify.com/mirumiru_miru17/seo-ai-readiness-audit](https://apify.com/mirumiru_miru17/seo-ai-readiness-audit)**

Websites break quietly. A plugin update sets pages to `noindex`, a new robots.txt blocks ChatGPT and Perplexity, the sitemap disappears, links start returning 404. You usually find out weeks later, when traffic is already gone.

This Actor audits your websites for **SEO** and **AI search readiness (GEO / AEO)** and, when you schedule it, **compares every run with the previous one** and alerts you only when something got worse.

- **SEO score (0–100)** with the exact issues on every page
- **AI search readiness score (0–100)**: can ChatGPT, Claude, Perplexity and Gemini find and read the site?
- **Change detection**: score drops, pages that became `noindex`, newly blocked AI crawlers, new broken links, removed `llms.txt` / sitemap / robots.txt
- **Alerts** to Slack, Discord, Make, Zapier, n8n or any webhook — or just an email from Apify when the run is marked failed
- **Many sites in one run**: monitor all your client sites with one schedule
- **Ready-to-publish `llms.txt`** built from each site's own pages
- **Shareable HTML report** in English or Japanese

No API keys, no login. Paste URLs, press Start, then add a schedule.

## Set up weekly monitoring in 3 steps

1. Enter your sites in **Websites to monitor** and press **Start**. The first run is saved as the baseline.
2. Open **Schedules** in Apify Console and run this Actor (with the same input) every week or every day.
3. Optional: paste a Slack or Discord webhook into **Alert webhook URL**, or turn on **Mark run as failed on regression** and Apify will email you about failed runs.

From then on, every run tells you what changed since the last one. If nothing got worse, you hear nothing.

## Who it's for

- **SEO and web agencies** watching many client sites — catch problems before the client does
- **Site owners** who want to know the day their site drops out of Google or AI answers
- **Developers** checking that a deploy did not break SEO (`noindex`, canonical, robots.txt)
- **AI agents** — works as a tool through the Apify MCP server

## What it detects between runs

| Change | Why it matters |
| --- | --- |
| Page became `noindex` | The page will disappear from Google and AI search |
| AI search crawler newly blocked in robots.txt (OAI-SearchBot, ChatGPT-User, Claude-SearchBot, PerplexityBot…) | The site stops appearing in that assistant's answers |
| `llms.txt`, XML sitemap or robots.txt no longer reachable | AI models and search engines lose their map of the site |
| New broken URLs (404 / 410 / 5xx) | Bad for users and crawl budget |
| Site or page score dropped (configurable threshold) | Shows which pages lost titles, descriptions, H1, structured data… |
| AI training crawler newly blocked (GPTBot, ClaudeBot, Google-Extended…) | Reported as info — it is a policy choice |
| Improvements and new pages | Reported too, so you can show progress to clients |

## What it checks on every run

**Every page (SEO)**
- Missing or badly sized `<title>`, missing or long meta description
- Missing H1 or multiple H1 tags, missing canonical link
- `noindex` (meta tag or `X-Robots-Tag` header)
- Missing `<html lang>`, mobile viewport, Open Graph title/image
- Structured data (JSON-LD) and schema types
- Images without alt text, thin content, broken links (optional external link check)

**Whole site (AI search readiness / GEO)**
- `llms.txt` present and valid
- AI crawlers allowed or blocked in robots.txt, split into **AI search bots** and **AI training bots**
- robots.txt and XML sitemap present
- Share of pages with structured data, meta descriptions and enough readable text

## Input

| Field | Description |
| --- | --- |
| `startUrls` | Websites to monitor. Only the same hostname is crawled for each. |
| `maxPages` | Maximum pages per site (default 50). Also caps the cost. Keep it the same between runs. |
| `monitorChanges` | Compare with the previous run (default on). |
| `alertWebhookUrl` | Slack / Discord / Make / Zapier / n8n / any JSON webhook. |
| `alertOn` | `regressions` (default), `changes` or `always`. |
| `scoreDropThreshold` | Ignore score changes smaller than this (default 3 points). |
| `failOnRegression` | Mark the run as failed when something got worse (for Apify email notifications). |
| `checkExternalLinks` | Also check up to 300 outbound links per site. |
| `generateLlmsTxt` | Build a ready-to-publish `llms.txt` (default on). |
| `language` | `en` or `ja` for issues, alerts and the report. |

## Output

- **`REPORT.html`** — scores, changes since the last run, AI crawler access and every page's issues. Send it to a client as is.
- **`CHANGES`** — per site: `changeStatus` (`baseline`, `regressed`, `improved`, `unchanged`), score changes and the list of changes.
- **Dataset** — one row per page with `site`, `score`, `scoreChange`, `newIssues`, `issues`, `brokenLinks`.
- **`SUMMARY`** — full site summary (an object with `sites` when you monitor more than one site).
- **`llms.txt`** — upload it to the root of the site (`llms-<host>.txt` for each site when you monitor several).

Example `CHANGES` entry:

```json
{
  "site": "https://example.com",
  "changeStatus": "regressed",
  "siteScore": 70,
  "siteScoreChange": -30,
  "aiReadinessScore": 50,
  "aiReadinessScoreChange": -50,
  "changes": [
    { "severity": "regression", "type": "page-noindex", "message": "Page became noindex (will drop out of Google and AI search): https://example.com/pricing", "url": "https://example.com/pricing" },
    { "severity": "regression", "type": "ai-search-bot-blocked", "message": "AI search crawler newly blocked in robots.txt: PerplexityBot" },
    { "severity": "regression", "type": "llms-txt-removed", "message": "llms.txt is no longer reachable" }
  ]
}
```

Example Slack / Discord alert:

```text
SEO & AI search monitor: 1 site(s) regressed
🔴 https://example.com — SEO 70 (-30), AI 50 (-50)
  • Page became noindex (will drop out of Google and AI search): https://example.com/pricing
  • AI search crawler newly blocked in robots.txt: PerplexityBot
  • llms.txt is no longer reachable
Report: https://api.apify.com/v2/key-value-stores/…/records/REPORT.html
```

The webhook body is JSON with `text` (Slack, Make, Zapier, n8n), `content` (Discord) and the full `sites` data for custom handlers.

## Pricing

Pay per event: a small fixed price **per audited page**, nothing for platform usage. Error pages are not charged. `maxPages` and the run's maximum cost cap what you pay. Example: 3 sites × 50 pages, weekly = 600 pages a month. See the Pricing tab for the current price.

## FAQ

**Where are previous results stored?** In a key-value store named `seo-ai-monitor-state` in your own Apify account. Delete it to start from a fresh baseline.

**Why does the first run show no changes?** It is the baseline. Changes appear from the second run.

**What is llms.txt?** A plain-text file at the root of a site that tells AI models what the site is about and which pages matter, similar to a sitemap.

**What is GEO / AEO?** Generative engine optimization (answer engine optimization): making a site easy for AI assistants to find, read and cite.

**Is it safe to run on any site?** The crawler respects robots.txt and only visits the hostnames you enter. Use it on sites you own or manage, or for client audits.

**Can an AI agent use it?** Yes. Add it to the Apify MCP server (`https://mcp.apify.com`) and any MCP client can call it.

## More tools from the same author

- [Bulk PageSpeed & Core Web Vitals Checker](https://apify.com/mirumiru_miru17/page-speed-core-web-vitals): Lighthouse scores, LCP/CLS/TBT and top fixes for a list of URLs
- [Japanese OCR: Image, PDF, Receipt & Invoice to Text](https://apify.com/mirumiru_miru17/image-pdf-ocr-japanese): text from images and scanned PDFs, Japanese incl. vertical
- [Audio & Video to Text Transcriber (Whisper)](https://apify.com/mirumiru_miru17/audio-video-transcriber): transcripts and SRT subtitles in Japanese and 90+ languages

---

## 日本語

サイトの**SEO**と**AI検索（ChatGPT・Claude・Perplexity・Gemini）対応**を診断し、定期実行すると**前回との違いを自動で比較**して、悪くなったときだけ知らせます。

- プラグイン更新でページが `noindex` になった
- robots.txtの変更でChatGPTやPerplexityのクローラーをブロックしてしまった
- サイトマップや `llms.txt` が消えた
- リンク切れが増えた、ページの点数が下がった

こうした「気づかないうちに起きる事故」を毎週（毎日でも）チェックします。複数サイトを1回でまとめて監視できるので、制作会社・SEO会社のクライアント管理にも向いています。

**使い方（3ステップ）**
1. 「Websites to monitor」にURLを入れて「Start」（初回は基準として保存）
2. Apifyの「Schedules」で毎週実行に設定
3. 必要ならSlack・DiscordのWebhook URLを入れる（またはメール通知用に「Mark run as failed on regression」をオン）

レポート・通知を日本語にするには `language` を「日本語」にしてください。料金は**診断したページ数に応じた従量課金**で、プラットフォーム利用料はかかりません。

## Run locally

```bash
npm install
mkdir -p storage/key_value_stores/default
echo '{"startUrls":["https://example.com"],"maxPages":20}' > storage/key_value_stores/default/INPUT.json
npm start
```

Results are written to `storage/datasets/default` and `storage/key_value_stores/default/` (`SUMMARY.json`, `CHANGES.json`, `REPORT.html`, `llms.txt`). Run it twice to see change detection.

## License

MIT
