# SEO Audit & AI Search Readiness Checker + llms.txt Generator

[![Run on Apify](https://apify.com/ext/run-on-apify.png)](https://apify.com/mirumiru_miru17/seo-ai-readiness-audit)

**Run it in the cloud with no setup: [apify.com/mirumiru_miru17/seo-ai-readiness-audit](https://apify.com/mirumiru_miru17/seo-ai-readiness-audit)**

Find out in one run whether a website can rank on Google **and** show up in AI answers from ChatGPT, Claude, Perplexity and Gemini.

This Actor crawls every page on a domain and gives you:

- an **SEO score (0–100)** with the exact issues on every page
- an **AI search readiness score (0–100)** for GEO / AEO (generative engine optimization)
- an **AI crawler access check**: is GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot or Google-Extended blocked in robots.txt?
- a **ready-to-publish `llms.txt`** built from the site's own pages
- a **shareable HTML report** in English or Japanese

No API keys, no login, no setup. Paste a URL and press Start.

## Who it's for

- **SEO and marketing agencies** auditing client sites, including AI-search (GEO) audits
- **Site owners** who want to know why traffic from ChatGPT or Perplexity is zero
- **Developers** who need an `llms.txt` file without writing it by hand
- **AI agents** — works as a tool through the Apify MCP server, so an agent can audit any site on request

## What it checks

**Every page (SEO)**
- Missing or badly sized `<title>`
- Missing or overly long meta description
- Missing H1 or multiple H1 tags
- Missing canonical link
- Pages set to `noindex` (meta tag or `X-Robots-Tag` header)
- Missing `<html lang>` and mobile viewport
- Missing Open Graph title/image (social previews)
- Structured data (JSON-LD) and which schema types are used
- Images without alt text
- Thin content
- Broken internal links (404/410/5xx), optional external link check

**Whole site (AI search readiness / GEO)**
- `llms.txt` present and valid
- AI crawlers allowed or blocked in robots.txt — split into **AI search bots** (OAI-SearchBot, ChatGPT-User, Claude-SearchBot, Claude-User, PerplexityBot, Perplexity-User) and **AI training bots** (GPTBot, ClaudeBot, Google-Extended, Applebot-Extended, CCBot, meta-externalagent, Bytespider, Amazonbot)
- robots.txt and XML sitemap present
- Share of pages with structured data, meta descriptions and enough readable text

Blocking an AI **search** bot removes the site from that assistant's answers, so it lowers the score. Blocking a **training** bot is a policy choice, so it is reported but not penalized.

## Input

| Field | Description |
| --- | --- |
| `startUrl` | Home page of the site to audit. Only the same hostname is crawled. |
| `maxPages` | Maximum pages to audit (default 50). Also caps the cost of the run. |
| `checkExternalLinks` | Also check up to 300 outbound links for 404s. |
| `generateLlmsTxt` | Build a ready-to-publish `llms.txt` (default on). |
| `language` | Report language: `en` or `ja`. |

## Output

- **Dataset** — one row per page with `score`, `url`, `issues`, `brokenLinks` and `structuredDataTypes`, worst pages first.
- **`SUMMARY`** — SEO score, AI readiness score, AI crawler access table, site-level issues, most common issues, worst pages.
- **`REPORT.html`** — a clean report you can send to a client or your team.
- **`llms.txt`** — upload it to the root of the site (`https://yoursite.com/llms.txt`).

Example `SUMMARY` (shortened):

```json
{
  "site": "https://example.com",
  "siteScore": 72,
  "aiReadinessScore": 55,
  "blockedAiSearchCrawlers": ["PerplexityBot"],
  "blockedAiTrainingCrawlers": ["GPTBot", "CCBot"],
  "hasLlmsTxt": false,
  "llmsTxtDraftGenerated": true,
  "topIssues": [{ "issue": "Missing meta description", "pages": 14 }]
}
```

Example generated `llms.txt`:

```text
# Example Shop

> Handmade goods shipped worldwide.

## Pages

- [Example Shop | Handmade goods](https://example.com/): Handmade goods shipped worldwide.

## Blog

- [How we make our mugs](https://example.com/blog/mugs): A look at our studio process.
```

## Pricing

Pay per event: you are charged a small fixed price **per audited page** and nothing for platform usage. Error pages are not charged. Set `maxPages` or a maximum cost per run, and the crawl stops when the limit is reached. See the Pricing tab for the current price.

## FAQ

**What is llms.txt?** A plain-text file at the root of a site that tells AI models what the site is about and which pages matter, similar to how a sitemap helps search engines.

**What is GEO / AEO?** Generative engine optimization (also called answer engine optimization): making a site easy for AI assistants to find, read and cite.

**Is it safe to run on any site?** The crawler respects robots.txt and only visits the hostname you enter. Use it on sites you own or manage, or for client audits.

**Can I run it every week?** Yes. Schedule it in Apify and get an alert when the score drops.

**Can an AI agent use it?** Yes. Add it to the Apify MCP server (`https://mcp.apify.com`) and any MCP client can call it.

## More tools from the same author

- [Bulk PageSpeed & Core Web Vitals Checker](https://apify.com/mirumiru_miru17/page-speed-core-web-vitals): Lighthouse scores, LCP/CLS/TBT and top fixes for a list of URLs
- [Japanese OCR: Image, PDF, Receipt & Invoice to Text](https://apify.com/mirumiru_miru17/image-pdf-ocr-japanese): text from images and scanned PDFs, Japanese incl. vertical
- [Audio & Video to Text Transcriber (Whisper)](https://apify.com/mirumiru_miru17/audio-video-transcriber): transcripts and SRT subtitles in Japanese and 90+ languages

---

## 日本語

サイト全体を1回で診断し、**Google検索で上位に出られる状態か**と、**ChatGPT・Claude・Perplexity・GeminiなどのAI検索に表示される状態か**をまとめてチェックします。

- **SEOスコア（100点満点）** と、ページごとの具体的な問題点
- **AI検索対応スコア（100点満点）**（GEO / AEO対策）
- **AIクローラーのブロック確認**：robots.txtでGPTBot・OAI-SearchBot・ClaudeBot・PerplexityBotなどを止めていないか（AI検索用と学習用を分けて判定）
- **そのまま公開できる `llms.txt` の自動生成**
- **日本語のHTMLレポート**（取引先にそのまま渡せます）

APIキーやログインは不要です。URLを入れて「Start」を押すだけ。レポートを日本語にするには `language` を「日本語」にしてください。料金は**診断したページ数に応じた従量課金**で、プラットフォーム利用料はかかりません。

## Run locally

```bash
npm install
mkdir -p storage/key_value_stores/default
echo '{"startUrl":"https://example.com","maxPages":20}' > storage/key_value_stores/default/INPUT.json
npm start
```

Results are written to `storage/datasets/default` and `storage/key_value_stores/default/` (`SUMMARY.json`, `REPORT.html`, `llms.txt`).

## License

MIT
