// SEO & AI-Readiness Site Audit — Apify Actor
// Crawls one website (same host only, respects robots.txt), audits every page,
// and outputs per-page issues + a 0-100 score. Charges one event per audited page.
import { Actor, log } from 'apify';
import { CheerioCrawler } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    startUrl,
    maxPages = 50,
    checkExternalLinks = false,
    language = 'en',
} = input;

if (!startUrl || !/^https?:\/\//i.test(startUrl)) {
    await Actor.fail('Input "startUrl" must be a full URL starting with http:// or https://');
}

const ja = language === 'ja';
const LABELS = {
    'missing-title': ['Missing <title>', '<title>がない'],
    'title-too-short': ['Title too short', 'タイトルが短すぎる'],
    'title-too-long': ['Title too long', 'タイトルが長すぎる'],
    'missing-meta-description': ['Missing meta description', 'meta descriptionがない'],
    'meta-description-too-long': ['Meta description too long', 'meta descriptionが長すぎる'],
    'missing-h1': ['Missing H1', 'H1がない'],
    'multiple-h1-tags': ['Multiple H1 tags', 'H1が複数ある'],
    'missing-canonical-link': ['Missing canonical link', 'canonicalタグがない'],
    'page-is-set-to-noindex': ['Page is set to noindex', 'noindexが設定されている'],
    'missing-html-lang': ['Missing <html lang>', '<html lang>がない'],
    'missing-mobile-viewport-meta': ['Missing mobile viewport meta', 'スマホ用viewport設定がない'],
    'missing-open-graph-title-image': ['Missing Open Graph title/image', 'OGPが不足'],
    'no-structured-data': ['No structured data (JSON-LD)', '構造化データがない'],
    'image-s-without-alt-text': ['Images without alt text', 'alt属性のない画像'],
    'thin-content': ['Thin content', '本文が少ない'],
    'broken-links': ['Broken links', 'リンク切れ'],
};
const t = (en, jp) => (ja ? jp : en);
const origin = new URL(startUrl).origin;
const host = new URL(startUrl).host;

// ---------- site-level checks (robots.txt / sitemap / llms.txt) ----------
async function fetchStatus(url) {
    try {
        const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
        const text = res.ok ? await res.text() : '';
        return { status: res.status, text };
    } catch (e) {
        return { status: 0, text: '', error: e.message };
    }
}

const robots = await fetchStatus(`${origin}/robots.txt`);
const sitemapFromRobots = (robots.text.match(/^\s*sitemap:\s*(\S+)/gim) || [])
    .map((l) => l.replace(/^\s*sitemap:\s*/i, '').trim());
const sitemapUrl = sitemapFromRobots[0] || `${origin}/sitemap.xml`;
const sitemap = await fetchStatus(sitemapUrl);
const llms = await fetchStatus(`${origin}/llms.txt`);
const aiBots = ['GPTBot', 'ClaudeBot', 'Google-Extended', 'PerplexityBot', 'CCBot'];
const blockedAiBots = aiBots.filter((bot) => {
    const re = new RegExp(`user-agent:\\s*${bot}[\\s\\S]*?disallow:\\s*/\\s*$`, 'im');
    return re.test(robots.text);
});

const siteIssues = [];
if (robots.status !== 200) siteIssues.push(t('robots.txt not found', 'robots.txtがありません'));
if (sitemap.status !== 200 || !/<urlset|<sitemapindex/i.test(sitemap.text)) {
    siteIssues.push(t('XML sitemap not found', 'XMLサイトマップが見つかりません'));
}
if (llms.status !== 200) siteIssues.push(t('llms.txt not found (AI search readiness)', 'llms.txtがありません（AI検索対応）'));
if (blockedAiBots.length) {
    siteIssues.push(t(`AI crawlers blocked in robots.txt: ${blockedAiBots.join(', ')}`,
        `robots.txtでAIクローラーをブロック中: ${blockedAiBots.join(', ')}`));
}

// ---------- page crawl ----------
const linkStatus = new Map(); // url -> status code (internal pages)
const pageResults = [];
let charged = 0;
let limitReached = false;

const crawler = new CheerioCrawler({
    maxRequestsPerCrawl: maxPages,
    maxConcurrency: 5,
    respectRobotsTxtFile: true,
    requestHandlerTimeoutSecs: 60,
    ignoreHttpErrorStatusCodes: [404, 410, 500, 502, 503],
    async requestHandler({ request, $, response, enqueueLinks }) {
        if (limitReached) return;
        const url = request.loadedUrl || request.url;
        const status = response.statusCode;
        linkStatus.set(request.url, status);
        if (status >= 400) return; // recorded as broken; not audited/charged

        const issues = [];
        let score = 100;
        const codes = [];
        const add = (points, en, jp) => { score -= points; issues.push(t(en, jp)); codes.push(issueKey(en)); };

        const title = $('head > title').first().text().trim();
        const desc = $('meta[name="description"]').attr('content')?.trim() ?? '';
        const h1s = $('h1');
        const canonical = $('link[rel="canonical"]').attr('href');
        const robotsMeta = ($('meta[name="robots"]').attr('content') || '').toLowerCase();
        const lang = $('html').attr('lang');
        const viewport = $('meta[name="viewport"]').length > 0;
        const ogTitle = $('meta[property="og:title"]').length > 0;
        const ogImage = $('meta[property="og:image"]').length > 0;
        const jsonLd = $('script[type="application/ld+json"]').length;
        const imgs = $('img');
        const imgsNoAlt = imgs.filter((_, el) => !($(el).attr('alt') ?? '').trim()).length;
        const words = $('body').text().replace(/\s+/g, ' ').trim().length;

        // Japanese titles are shorter in characters, so use char ranges that work for both.
        if (!title) add(15, 'Missing <title>', '<title>がありません');
        else if (title.length < 10) add(5, `Title too short (${title.length} chars)`, `タイトルが短すぎます（${title.length}文字）`);
        else if (title.length > 65) add(5, `Title too long (${title.length} chars)`, `タイトルが長すぎます（${title.length}文字）`);
        if (!desc) add(10, 'Missing meta description', 'meta descriptionがありません');
        else if (desc.length > 160) add(3, `Meta description too long (${desc.length} chars)`, `meta descriptionが長すぎます（${desc.length}文字）`);
        if (h1s.length === 0) add(10, 'Missing H1', 'H1がありません');
        else if (h1s.length > 1) add(3, `Multiple H1 tags (${h1s.length})`, `H1が複数あります（${h1s.length}個）`);
        if (!canonical) add(5, 'Missing canonical link', 'canonicalタグがありません');
        if (robotsMeta.includes('noindex')) add(20, 'Page is set to noindex', 'noindexが設定されています');
        if (!lang) add(3, 'Missing <html lang>', '<html lang>がありません');
        if (!viewport) add(10, 'Missing mobile viewport meta', 'スマホ用viewport設定がありません');
        if (!ogTitle || !ogImage) add(3, 'Missing Open Graph title/image', 'OGP（og:title / og:image）が不足しています');
        if (!jsonLd) add(5, 'No structured data (JSON-LD)', '構造化データ（JSON-LD）がありません');
        if (imgsNoAlt > 0) add(Math.min(10, imgsNoAlt * 2), `${imgsNoAlt} image(s) without alt text`, `alt属性のない画像が${imgsNoAlt}枚あります`);
        if (words < 300) add(5, 'Thin content (very little text)', '本文が非常に少ないページです');

        const outLinks = [];
        $('a[href]').each((_, el) => {
            try {
                const u = new URL($(el).attr('href'), url);
                if (/^https?:$/.test(u.protocol)) { u.hash = ''; outLinks.push(u.href); }
            } catch { /* ignore malformed */ }
        });

        pageResults.push({
            url, status, score: Math.max(0, score), title, titleLength: title.length,
            metaDescriptionLength: desc.length, h1Count: h1s.length, imagesWithoutAlt: imgsNoAlt,
            hasCanonical: !!canonical, hasStructuredData: jsonLd > 0, issues, codes,
            internalLinks: outLinks.filter((l) => new URL(l).host === host),
            externalLinks: outLinks.filter((l) => new URL(l).host !== host),
        });

        // Pay-per-event: one charge per audited page. Stops when the user's budget is reached.
        const chargeResult = await Actor.charge({ eventName: 'page-audited' });
        charged++;
        if (chargeResult?.eventChargeLimitReached) {
            limitReached = true;
            log.info('Spending limit reached — stopping crawl.');
            await crawler.autoscaledPool?.abort();
            return;
        }

        await enqueueLinks({ strategy: 'same-hostname' });
    },
    failedRequestHandler({ request }, error) {
        linkStatus.set(request.url, 0);
        log.warning(`Failed: ${request.url} — ${error.message}`);
    },
});

await crawler.run([startUrl]);

// ---------- broken links ----------
const brokenInternal = [...linkStatus].filter(([, s]) => s >= 400 || s === 0);
const externalBroken = [];
if (checkExternalLinks) {
    const externals = [...new Set(pageResults.flatMap((p) => p.externalLinks))].slice(0, 300);
    for (const u of externals) {
        const r = await fetchStatus(u);
        if (r.status >= 400 || r.status === 0) externalBroken.push({ url: u, status: r.status });
    }
}
for (const p of pageResults) {
    const broken = p.internalLinks.filter((l) => brokenInternal.some(([b]) => b === l));
    const brokenExt = p.externalLinks.filter((l) => externalBroken.some((b) => b.url === l));
    const n = broken.length + brokenExt.length;
    if (n) {
        p.score = Math.max(0, p.score - Math.min(15, n * 5));
        p.issues.push(t(`${n} broken link(s) on this page`, `このページにリンク切れが${n}件あります`));
        p.codes.push('broken-links');
    }
    p.brokenLinks = [...broken, ...brokenExt];
    delete p.internalLinks; delete p.externalLinks;
}

// ---------- output ----------
pageResults.sort((a, b) => a.score - b.score);
await Actor.pushData(pageResults);

const avg = pageResults.length
    ? Math.round(pageResults.reduce((s, p) => s + p.score, 0) / pageResults.length) : 0;
const siteScore = Math.max(0, avg - siteIssues.length * 3);
const issueCounts = {};
for (const p of pageResults) for (const c of p.codes) issueCounts[c] = (issueCounts[c] || 0) + 1;
for (const p of pageResults) delete p.codes;
const summary = {
    site: origin,
    siteScore,
    pagesAudited: pageResults.length,
    brokenInternalUrls: brokenInternal.map(([u, s]) => ({ url: u, status: s })),
    brokenExternalUrls: externalBroken,
    siteIssues,
    hasLlmsTxt: llms.status === 200,
    blockedAiCrawlers: blockedAiBots,
    topIssues: Object.entries(issueCounts).sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([code, pages]) => ({ issue: LABELS[code] ? t(...LABELS[code]) : code, pages })),
    worstPages: pageResults.slice(0, 10).map((p) => ({ url: p.url, score: p.score })),
};
await Actor.setValue('SUMMARY', summary);
await Actor.setValue('REPORT.html', renderHtml(summary, pageResults), { contentType: 'text/html; charset=utf-8' });
log.info(`Done. Site score ${siteScore}/100, ${pageResults.length} pages audited, ${charged} charged.`);

await Actor.exit();

function issueKey(en) {
    return en.replace(/\s*\(.*\)$/, '').replace(/^\d+ /, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function renderHtml(s, pages) {
    const rows = pages.map((p) => `<tr><td>${p.score}</td><td><a href="${esc(p.url)}">${esc(p.url)}</a></td><td>${p.issues.map(esc).join('<br>')}</td></tr>`).join('');
    return `<!doctype html><html lang="${ja ? 'ja' : 'en'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t('SEO Audit', 'SEO診断')} — ${esc(s.site)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:960px;margin:24px auto;padding:0 16px;color:#222}h1{font-size:22px}.score{font-size:48px;font-weight:700}table{border-collapse:collapse;width:100%;font-size:14px}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left;vertical-align:top}</style>
<h1>${t('SEO & AI-Readiness Audit', 'SEO・AI検索対応 診断レポート')}: ${esc(s.site)}</h1>
<div class="score">${s.siteScore}/100</div>
<p>${t('Pages audited', '診断ページ数')}: ${s.pagesAudited} / ${t('Broken internal URLs', '内部リンク切れ')}: ${s.brokenInternalUrls.length}</p>
<h2>${t('Site-level issues', 'サイト全体の問題')}</h2><ul>${s.siteIssues.map((i) => `<li>${esc(i)}</li>`).join('') || `<li>${t('None', 'なし')}</li>`}</ul>
<h2>${t('Most common issues', 'よくある問題')}</h2><ul>${s.topIssues.map((i) => `<li>${esc(i.issue)} — ${i.pages} ${t('pages', 'ページ')}</li>`).join('')}</ul>
<h2>${t('Pages (worst first)', 'ページ別（スコアの低い順）')}</h2><table><tr><th>${t('Score', '点')}</th><th>URL</th><th>${t('Issues', '問題点')}</th></tr>${rows}</table></html>`;
}
