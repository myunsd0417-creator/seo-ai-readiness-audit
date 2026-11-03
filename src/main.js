// SEO & AI Search Readiness Audit + llms.txt Generator — Apify Actor
// Crawls one website (same hostname only, respects robots.txt), audits every page for
// SEO and AI-search (GEO/AEO) readiness, and outputs:
//   - dataset: one row per page (worst first)
//   - SUMMARY: site score, AI-readiness score, AI crawler access, top issues
//   - REPORT.html: shareable report (English or Japanese)
//   - llms.txt: ready-to-publish draft built from the crawled pages
// Pricing: pay per event — one "page-audited" event per audited page. No platform usage fees.
import { Actor, log } from 'apify';
import { CheerioCrawler } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    startUrl,
    maxPages = 50,
    checkExternalLinks = false,
    generateLlmsTxt = true,
    language = 'en',
} = input;

if (!startUrl || !/^https?:\/\//i.test(startUrl)) {
    await Actor.fail('Input "startUrl" must be a full URL starting with http:// or https://');
}

const ja = language === 'ja';
const t = (en, jp) => (ja ? jp : en);
const origin = new URL(startUrl).origin;
const host = new URL(startUrl).host;

// Issue catalogue: code -> [English label, Japanese label]
const LABELS = {
    'missing-title': ['Missing <title>', '<title>がない'],
    'title-too-short': ['Title too short', 'タイトルが短すぎる'],
    'title-too-long': ['Title too long', 'タイトルが長すぎる'],
    'missing-meta-description': ['Missing meta description', 'meta descriptionがない'],
    'meta-description-too-long': ['Meta description too long', 'meta descriptionが長すぎる'],
    'missing-h1': ['Missing H1', 'H1がない'],
    'multiple-h1': ['Multiple H1 tags', 'H1が複数ある'],
    'missing-canonical': ['Missing canonical link', 'canonicalタグがない'],
    noindex: ['Page is set to noindex', 'noindexが設定されている'],
    'missing-lang': ['Missing <html lang>', '<html lang>がない'],
    'missing-viewport': ['Missing mobile viewport meta', 'スマホ用viewport設定がない'],
    'missing-og': ['Missing Open Graph title/image', 'OGPが不足'],
    'no-structured-data': ['No structured data (JSON-LD)', '構造化データがない'],
    'images-without-alt': ['Images without alt text', 'alt属性のない画像'],
    'thin-content': ['Thin content', '本文が少ない'],
    'broken-links': ['Broken links', 'リンク切れ'],
};

// ---------- helpers ----------
async function fetchText(url) {
    try {
        const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
        const text = res.ok ? await res.text() : '';
        return { status: res.status, text, type: res.headers.get('content-type') || '' };
    } catch (e) {
        return { status: 0, text: '', type: '', error: e.message };
    }
}

// Parse robots.txt into groups: [{ agents: ['gptbot'], rules: [{ type: 'disallow', path: '/' }] }]
function parseRobots(text) {
    const groups = [];
    let current = null;
    let lastWasAgent = false;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, '').trim();
        if (!line) continue;
        const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
        if (!m) continue;
        const key = m[1].toLowerCase();
        const value = m[2].trim();
        if (key === 'user-agent') {
            if (!lastWasAgent || !current) {
                current = { agents: [], rules: [] };
                groups.push(current);
            }
            current.agents.push(value.toLowerCase());
            lastWasAgent = true;
        } else {
            if ((key === 'allow' || key === 'disallow') && current) current.rules.push({ type: key, path: value });
            lastWasAgent = false;
        }
    }
    return groups;
}

// Is the whole site blocked for this bot? Uses the bot's own group if present, else the "*" group.
function isSiteBlocked(groups, bot) {
    const name = bot.toLowerCase();
    const own = groups.filter((g) => g.agents.includes(name));
    const applicable = own.length ? own : groups.filter((g) => g.agents.includes('*'));
    const rules = applicable.flatMap((g) => g.rules);
    const disallowAll = rules.some((r) => r.type === 'disallow' && r.path === '/');
    const allowAll = rules.some((r) => r.type === 'allow' && r.path === '/');
    return { blocked: disallowAll && !allowAll, viaWildcard: !own.length };
}

// AI crawlers. "search" bots fetch pages to answer users in AI search/chat — blocking them
// removes the site from AI answers. "training" bots collect data for model training — blocking is a policy choice.
const AI_BOTS = [
    { name: 'OAI-SearchBot', owner: 'OpenAI (ChatGPT search)', kind: 'search' },
    { name: 'ChatGPT-User', owner: 'OpenAI (ChatGPT browsing)', kind: 'search' },
    { name: 'Claude-SearchBot', owner: 'Anthropic (Claude search)', kind: 'search' },
    { name: 'Claude-User', owner: 'Anthropic (Claude browsing)', kind: 'search' },
    { name: 'PerplexityBot', owner: 'Perplexity', kind: 'search' },
    { name: 'Perplexity-User', owner: 'Perplexity (browsing)', kind: 'search' },
    { name: 'GPTBot', owner: 'OpenAI (training)', kind: 'training' },
    { name: 'ClaudeBot', owner: 'Anthropic (training)', kind: 'training' },
    { name: 'Google-Extended', owner: 'Google (Gemini)', kind: 'training' },
    { name: 'Applebot-Extended', owner: 'Apple (Apple Intelligence)', kind: 'training' },
    { name: 'CCBot', owner: 'Common Crawl', kind: 'training' },
    { name: 'meta-externalagent', owner: 'Meta AI', kind: 'training' },
    { name: 'Bytespider', owner: 'ByteDance', kind: 'training' },
    { name: 'Amazonbot', owner: 'Amazon', kind: 'training' },
];

// ---------- site-level checks (robots.txt / sitemap / llms.txt) ----------
const robots = await fetchText(`${origin}/robots.txt`);
const robotsGroups = robots.status === 200 ? parseRobots(robots.text) : [];
const sitemapFromRobots = (robots.text.match(/^\s*sitemap:\s*(\S+)/gim) || [])
    .map((l) => l.replace(/^\s*sitemap:\s*/i, '').trim());
const sitemapUrl = sitemapFromRobots[0] || `${origin}/sitemap.xml`;
const sitemap = await fetchText(sitemapUrl);
const hasSitemap = sitemap.status === 200 && /<urlset|<sitemapindex/i.test(sitemap.text);
const llms = await fetchText(`${origin}/llms.txt`);
const hasLlmsTxt = llms.status === 200 && llms.text.trim().length > 0 && !/<html/i.test(llms.text.slice(0, 500));
const llmsTxtValid = hasLlmsTxt && /^#\s+\S/m.test(llms.text.trim().split(/\r?\n/)[0]);

const aiCrawlerAccess = AI_BOTS.map((b) => {
    const r = isSiteBlocked(robotsGroups, b.name);
    return { bot: b.name, owner: b.owner, kind: b.kind, blocked: r.blocked, blockedByWildcard: r.blocked && r.viaWildcard };
});
const blockedSearchBots = aiCrawlerAccess.filter((b) => b.blocked && b.kind === 'search').map((b) => b.bot);
const blockedTrainingBots = aiCrawlerAccess.filter((b) => b.blocked && b.kind === 'training').map((b) => b.bot);

const siteIssues = [];
if (robots.status !== 200) siteIssues.push(t('robots.txt not found', 'robots.txtがありません'));
if (!hasSitemap) siteIssues.push(t('XML sitemap not found', 'XMLサイトマップが見つかりません'));
if (!hasLlmsTxt) siteIssues.push(t('llms.txt not found — a draft was generated for you (AI search readiness)', 'llms.txtがありません（下書きを自動生成しました・AI検索対応）'));
else if (!llmsTxtValid) siteIssues.push(t('llms.txt does not start with a "# Site name" heading', 'llms.txtの1行目が「# サイト名」の形式になっていません'));
if (blockedSearchBots.length) {
    siteIssues.push(t(`AI search crawlers blocked in robots.txt (site will not appear in AI answers): ${blockedSearchBots.join(', ')}`,
        `robots.txtでAI検索用クローラーをブロック中（AIの回答に表示されません）: ${blockedSearchBots.join(', ')}`));
}

// ---------- page crawl ----------
const linkStatus = new Map(); // internal url -> status code
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
        if (status >= 400) return; // recorded as broken; not audited, not charged

        const issues = [];
        const codes = [];
        let score = 100;
        const add = (code, points, en, jp) => { score -= points; issues.push(t(en, jp)); codes.push(code); };

        const title = $('head > title').first().text().trim();
        const desc = $('meta[name="description"]').attr('content')?.trim() ?? '';
        const h1s = $('h1');
        const canonical = $('link[rel="canonical"]').attr('href');
        const robotsMeta = ($('meta[name="robots"]').attr('content') || '').toLowerCase();
        const robotsHeader = String(response.headers?.['x-robots-tag'] || '').toLowerCase();
        const noindex = robotsMeta.includes('noindex') || robotsHeader.includes('noindex');
        const lang = $('html').attr('lang');
        const viewport = $('meta[name="viewport"]').length > 0;
        const ogTitle = $('meta[property="og:title"]').length > 0;
        const ogImage = $('meta[property="og:image"]').length > 0;
        const siteName = $('meta[property="og:site_name"]').attr('content')?.trim() || '';
        const jsonLdBlocks = $('script[type="application/ld+json"]');
        const schemaTypes = new Set();
        jsonLdBlocks.each((_, el) => {
            try {
                const collect = (node) => {
                    if (!node || typeof node !== 'object') return;
                    if (Array.isArray(node)) { node.forEach(collect); return; }
                    const tp = node['@type'];
                    if (tp) (Array.isArray(tp) ? tp : [tp]).forEach((x) => schemaTypes.add(String(x)));
                    if (node['@graph']) collect(node['@graph']);
                };
                collect(JSON.parse($(el).contents().text()));
            } catch { /* invalid JSON-LD is reported as missing types */ }
        });
        const imgs = $('img');
        const imgsNoAlt = imgs.filter((_, el) => $(el).attr('alt') === undefined).length;
        const textLength = $('body').clone().find('script,style,noscript').remove().end()
            .text().replace(/\s+/g, ' ').trim().length;

        if (!title) add('missing-title', 15, 'Missing <title>', '<title>がありません');
        else if (title.length < 10) add('title-too-short', 5, `Title too short (${title.length} chars)`, `タイトルが短すぎます（${title.length}文字）`);
        else if (title.length > 65) add('title-too-long', 5, `Title too long (${title.length} chars)`, `タイトルが長すぎます（${title.length}文字）`);
        if (!desc) add('missing-meta-description', 10, 'Missing meta description', 'meta descriptionがありません');
        else if (desc.length > 160) add('meta-description-too-long', 3, `Meta description too long (${desc.length} chars)`, `meta descriptionが長すぎます（${desc.length}文字）`);
        if (h1s.length === 0) add('missing-h1', 10, 'Missing H1', 'H1がありません');
        else if (h1s.length > 1) add('multiple-h1', 3, `Multiple H1 tags (${h1s.length})`, `H1が複数あります（${h1s.length}個）`);
        if (!canonical) add('missing-canonical', 5, 'Missing canonical link', 'canonicalタグがありません');
        if (noindex) add('noindex', 20, 'Page is set to noindex', 'noindexが設定されています');
        if (!lang) add('missing-lang', 3, 'Missing <html lang>', '<html lang>がありません');
        if (!viewport) add('missing-viewport', 10, 'Missing mobile viewport meta', 'スマホ用viewport設定がありません');
        if (!ogTitle || !ogImage) add('missing-og', 3, 'Missing Open Graph title/image', 'OGP（og:title / og:image）が不足しています');
        if (!schemaTypes.size) add('no-structured-data', 5, 'No structured data (JSON-LD)', '構造化データ（JSON-LD）がありません');
        if (imgsNoAlt > 0) add('images-without-alt', Math.min(10, imgsNoAlt * 2), `${imgsNoAlt} image(s) without alt text`, `alt属性のない画像が${imgsNoAlt}枚あります`);
        if (textLength < 300) add('thin-content', 5, 'Thin content (very little text)', '本文が非常に少ないページです');

        const outLinks = [];
        $('a[href]').each((_, el) => {
            try {
                const u = new URL($(el).attr('href'), url);
                if (/^https?:$/.test(u.protocol)) { u.hash = ''; outLinks.push(u.href); }
            } catch { /* ignore malformed */ }
        });

        pageResults.push({
            url,
            status,
            score: Math.max(0, score),
            title,
            titleLength: title.length,
            metaDescription: desc,
            metaDescriptionLength: desc.length,
            h1Count: h1s.length,
            imagesWithoutAlt: imgsNoAlt,
            hasCanonical: !!canonical,
            noindex,
            structuredDataTypes: [...schemaTypes],
            textLength,
            issues,
            codes,
            siteName,
            internalLinks: outLinks.filter((l) => new URL(l).host === host),
            externalLinks: outLinks.filter((l) => new URL(l).host !== host),
        });

        // Pay per event: one charge per audited page. Stops when the user's spending limit is reached.
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
const brokenInternalSet = new Set([...linkStatus].filter(([, s]) => s >= 400 || s === 0).map(([u]) => u));
const externalBroken = [];
if (checkExternalLinks) {
    const externals = [...new Set(pageResults.flatMap((p) => p.externalLinks))].slice(0, 300);
    for (const u of externals) {
        const r = await fetchText(u);
        if (r.status >= 400 || r.status === 0) externalBroken.push({ url: u, status: r.status });
    }
}
const externalBrokenSet = new Set(externalBroken.map((b) => b.url));
for (const p of pageResults) {
    const broken = [...new Set(p.internalLinks.filter((l) => brokenInternalSet.has(l)))];
    const brokenExt = [...new Set(p.externalLinks.filter((l) => externalBrokenSet.has(l)))];
    const n = broken.length + brokenExt.length;
    if (n) {
        p.score = Math.max(0, p.score - Math.min(15, n * 5));
        p.issues.push(t(`${n} broken link(s) on this page`, `このページにリンク切れが${n}件あります`));
        p.codes.push('broken-links');
    }
    p.brokenLinks = [...broken, ...brokenExt];
    delete p.internalLinks;
    delete p.externalLinks;
}

// ---------- scores ----------
const n = pageResults.length;
const share = (fn) => (n ? pageResults.filter(fn).length / n : 0);
const avg = n ? Math.round(pageResults.reduce((s, p) => s + p.score, 0) / n) : 0;
const siteScore = Math.max(0, avg - siteIssues.length * 3);

// AI search readiness (GEO/AEO): can AI crawlers reach the site, and can models understand it?
let aiReadinessScore = 100;
const aiChecks = [];
const aiCheck = (ok, points, en, jp) => {
    aiChecks.push({ check: t(en, jp), passed: ok });
    if (!ok) aiReadinessScore -= points;
};
aiCheck(!blockedSearchBots.length, Math.min(40, blockedSearchBots.length * 10), 'AI search crawlers are allowed in robots.txt', 'robots.txtでAI検索クローラーを許可している');
aiCheck(hasLlmsTxt, 15, 'llms.txt is published', 'llms.txtを公開している');
aiCheck(!hasLlmsTxt || llmsTxtValid, 5, 'llms.txt starts with a "# Site name" heading', 'llms.txtが「# サイト名」で始まっている');
aiCheck(hasSitemap, 10, 'XML sitemap is available', 'XMLサイトマップがある');
aiCheck(share((p) => p.structuredDataTypes.length > 0) >= 0.5, 10, 'At least half of pages have structured data (JSON-LD)', '半数以上のページに構造化データがある');
aiCheck(share((p) => p.metaDescriptionLength > 0) >= 0.8, 10, 'At least 80% of pages have a meta description', '80%以上のページにmeta descriptionがある');
aiCheck(share((p) => p.textLength < 300) <= 0.3, 5, 'Most pages have enough readable text', 'ほとんどのページに十分な本文がある');
aiCheck(share((p) => p.noindex) < 0.2, 5, 'Few pages are set to noindex', 'noindexのページが少ない');
aiReadinessScore = Math.max(0, aiReadinessScore);

// ---------- llms.txt draft ----------
function buildLlmsTxt() {
    const home = pageResults.find((p) => new URL(p.url).pathname === '/' ) || pageResults[0];
    const name = (home?.siteName || home?.title || host).replace(/\s+/g, ' ').trim();
    const summaryLine = (home?.metaDescription || '').replace(/\s+/g, ' ').trim();
    const sections = new Map();
    for (const p of [...pageResults].sort((a, b) => a.url.localeCompare(b.url))) {
        if (p.noindex || p.status >= 400) continue;
        const seg = new URL(p.url).pathname.split('/').filter(Boolean)[0];
        const key = seg ? decodeURIComponent(seg).replace(/[-_]+/g, ' ') : 'Pages';
        const label = key.charAt(0).toUpperCase() + key.slice(1);
        if (!sections.has(label)) sections.set(label, []);
        const list = sections.get(label);
        if (list.length < 50) {
            const linkTitle = (p.title || p.url).replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim();
            const d = p.metaDescription.replace(/\s+/g, ' ').trim();
            list.push(`- [${linkTitle}](${p.url})${d ? `: ${d}` : ''}`);
        }
    }
    const order = [...sections.keys()].sort((a, b) => (a === 'Pages' ? -1 : b === 'Pages' ? 1 : a.localeCompare(b)));
    const out = [`# ${name}`, ''];
    if (summaryLine) out.push(`> ${summaryLine}`, '');
    for (const s of order) out.push(`## ${s}`, '', ...sections.get(s), '');
    return `${out.join('\n').trim()}\n`;
}
const llmsTxtDraft = generateLlmsTxt && n ? buildLlmsTxt() : null;

// ---------- output ----------
pageResults.sort((a, b) => a.score - b.score);
const issueCounts = {};
for (const p of pageResults) for (const c of p.codes) issueCounts[c] = (issueCounts[c] || 0) + 1;
for (const p of pageResults) { delete p.codes; delete p.siteName; }
await Actor.pushData(pageResults);

const summary = {
    site: origin,
    siteScore,
    aiReadinessScore,
    pagesAudited: n,
    siteIssues,
    aiReadinessChecks: aiChecks,
    hasLlmsTxt,
    llmsTxtValid,
    llmsTxtDraftGenerated: !!llmsTxtDraft,
    hasSitemap,
    aiCrawlerAccess,
    blockedAiSearchCrawlers: blockedSearchBots,
    blockedAiTrainingCrawlers: blockedTrainingBots,
    brokenInternalUrls: [...linkStatus].filter(([, s]) => s >= 400 || s === 0).map(([url, status]) => ({ url, status })),
    brokenExternalUrls: externalBroken,
    topIssues: Object.entries(issueCounts).sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([code, pages]) => ({ issue: LABELS[code] ? t(...LABELS[code]) : code, pages })),
    worstPages: pageResults.slice(0, 10).map((p) => ({ url: p.url, score: p.score })),
};
await Actor.setValue('SUMMARY', summary);
await Actor.setValue('REPORT.html', renderHtml(summary, pageResults), { contentType: 'text/html; charset=utf-8' });
if (llmsTxtDraft) await Actor.setValue('llms.txt', llmsTxtDraft, { contentType: 'text/plain; charset=utf-8' });
log.info(`Done. Site score ${siteScore}/100, AI readiness ${aiReadinessScore}/100, ${n} pages audited, ${charged} charged.`);

await Actor.exit();

// ---------- HTML report ----------
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function renderHtml(s, pages) {
    const rows = pages.map((p) => `<tr><td>${p.score}</td><td><a href="${esc(p.url)}">${esc(p.url)}</a></td><td>${p.issues.map(esc).join('<br>') || '—'}</td></tr>`).join('');
    const bots = s.aiCrawlerAccess.map((b) => `<tr><td>${esc(b.bot)}</td><td>${esc(b.owner)}</td><td>${b.kind === 'search' ? t('AI search', 'AI検索') : t('Training', '学習')}</td><td class="${b.blocked ? 'bad' : 'ok'}">${b.blocked ? t('Blocked', 'ブロック') : t('Allowed', '許可')}</td></tr>`).join('');
    const checks = s.aiReadinessChecks.map((c) => `<li class="${c.passed ? 'ok' : 'bad'}">${c.passed ? '✓' : '✗'} ${esc(c.check)}</li>`).join('');
    return `<!doctype html><html lang="${ja ? 'ja' : 'en'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t('SEO & AI Search Audit', 'SEO・AI検索 診断')} — ${esc(s.site)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:960px;margin:24px auto;padding:0 16px;color:#222;line-height:1.5}h1{font-size:22px}h2{font-size:18px;margin-top:28px}.scores{display:flex;gap:32px;flex-wrap:wrap}.score{font-size:44px;font-weight:700}.label{font-size:13px;color:#666}table{border-collapse:collapse;width:100%;font-size:14px}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left;vertical-align:top}ul{padding-left:20px}.ok{color:#1a7f37}.bad{color:#cf222e}</style>
<h1>${t('SEO & AI Search Readiness Audit', 'SEO・AI検索対応 診断レポート')}: ${esc(s.site)}</h1>
<div class="scores"><div><div class="score">${s.siteScore}/100</div><div class="label">${t('SEO score', 'SEOスコア')}</div></div><div><div class="score">${s.aiReadinessScore}/100</div><div class="label">${t('AI search readiness', 'AI検索対応スコア')}</div></div></div>
<p>${t('Pages audited', '診断ページ数')}: ${s.pagesAudited} / ${t('Broken internal URLs', '内部リンク切れ')}: ${s.brokenInternalUrls.length}${s.llmsTxtDraftGenerated ? ` / ${t('llms.txt draft: see the "llms.txt" record in the key-value store', 'llms.txtの下書き: キーバリューストアの「llms.txt」')}` : ''}</p>
<h2>${t('Site-level issues', 'サイト全体の問題')}</h2><ul>${s.siteIssues.map((i) => `<li>${esc(i)}</li>`).join('') || `<li>${t('None', 'なし')}</li>`}</ul>
<h2>${t('AI search readiness checks', 'AI検索対応チェック')}</h2><ul style="list-style:none;padding-left:0">${checks}</ul>
<h2>${t('AI crawler access (robots.txt)', 'AIクローラーのアクセス（robots.txt）')}</h2><table><tr><th>${t('Crawler', 'クローラー')}</th><th>${t('Owner', '提供元')}</th><th>${t('Purpose', '用途')}</th><th>${t('Status', '状態')}</th></tr>${bots}</table>
<h2>${t('Most common issues', 'よくある問題')}</h2><ul>${s.topIssues.map((i) => `<li>${esc(i.issue)} — ${i.pages} ${t('pages', 'ページ')}</li>`).join('') || `<li>${t('None', 'なし')}</li>`}</ul>
<h2>${t('Pages (worst first)', 'ページ別（スコアの低い順）')}</h2><table><tr><th>${t('Score', '点')}</th><th>URL</th><th>${t('Issues', '問題点')}</th></tr>${rows}</table></html>`;
}
