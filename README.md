# SEO & AI-Readiness Site Audit

[![Run on Apify](https://apify.com/ext/run-on-apify.png)](https://apify.com/mirumiru_miru17/seo-ai-readiness-audit)

**Run it in the cloud with no setup: [apify.com/mirumiru_miru17/seo-ai-readiness-audit](https://apify.com/mirumiru_miru17/seo-ai-readiness-audit)**


Audit a whole website in one run. This Actor crawls every page on the same domain, finds the SEO problems that stop pages from ranking, checks whether AI search engines (ChatGPT, Claude, Perplexity, Google AI) can read your site, and gives you a **0–100 score** plus a ready-to-share **HTML report in English or Japanese**.

No API keys, no login, no setup. Paste a URL and press Start.

## What it checks

**Every page**
- Missing or badly sized `<title>`
- Missing or overly long meta description
- Missing H1 or multiple H1 tags
- Missing canonical link
- Pages accidentally set to `noindex`
- Missing `<html lang>` and mobile viewport
- Missing Open Graph title/image (social previews)
- Missing structured data (JSON-LD)
- Images without alt text
- Thin content
- Broken internal links (404/410/5xx), optional external link check

**Whole site**
- robots.txt present
- XML sitemap present
- `llms.txt` present (AI search readiness)
- AI crawlers blocked in robots.txt (GPTBot, ClaudeBot, Google-Extended, PerplexityBot, CCBot)

## Input

| Field | Description |
| --- | --- |
| `startUrl` | Home page of the site to audit. Only the same hostname is crawled. |
| `maxPages` | Maximum pages to audit (default 50). |
| `checkExternalLinks` | Also check up to 300 outbound links for 404s. |
| `language` | Report language: `en` or `ja`. |

## Output

- **Dataset**: one row per page with `score`, `url`, `issues` and `brokenLinks`, sorted worst first.
- **Key-value store `SUMMARY`**: site score, site-level issues, most common issues, worst pages.
- **Key-value store `REPORT.html`**: a clean report you can send to a client or your team.

Example dataset row:

```json
{
  "url": "https://example.com/blog/post",
  "score": 62,
  "issues": ["Missing meta description", "Multiple H1 tags (2)", "3 image(s) without alt text"],
  "brokenLinks": ["https://example.com/old-page"]
}
```

## Good to know

- The crawler respects robots.txt and only visits the site you enter.
- Use it on sites you own or manage, or for client audits.
- Runs on Apify's cloud, so you can schedule it weekly and get alerted when the score drops.

---

## 日本語

サイト全体を一度に診断します。同じドメインの全ページを巡回し、検索順位を下げるSEOの問題と、ChatGPTなどのAI検索に読まれる状態かを調べ、**100点満点のスコア**と**日本語のHTMLレポート**を出力します。

APIキーやログインは不要です。URLを入れて「Start」を押すだけで使えます。レポートを日本語にするには `language` を「日本語」にしてください。

**主なチェック項目**
- タイトル、meta description、H1、canonical、noindex、alt属性、構造化データ、リンク切れ
- robots.txt、XMLサイトマップ、llms.txt、AIクローラーのブロック有無

## Run locally

```bash
npm install
mkdir -p storage/key_value_stores/default
echo '{"startUrl":"https://example.com","maxPages":20}' > storage/key_value_stores/default/INPUT.json
npm start
```

Results are written to `storage/datasets/default` and `storage/key_value_stores/default/REPORT.html`.

## License

MIT
