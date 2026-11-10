// SEO & AI Search Readiness Monitor + llms.txt Generator — Apify Actor
// Audits one or more websites (same hostname only, respects robots.txt) for SEO and
// AI-search (GEO/AEO) readiness. Built to run on a schedule: every run is compared with
// the previous run of the same site, and regressions (score drops, new noindex pages,
// newly blocked AI crawlers, new broken links, removed llms.txt/sitemap…) are reported
// and can be pushed to a webhook (Slack, Discord, Make, Zapier, n8n…).
// Outputs:
//   - dataset: one row per page (worst first) with change vs. previous run
//   - SUMMARY: site score, AI-readiness score, AI crawler access, top issues, changes
//   - CHANGES: what changed since the previous run, per site
//   - REPORT.html: shareable report (English or Japanese)
//   - llms.txt: ready-to-publish draft (first site; llms-<host>.txt for every site)
// Pricing: pay per event — one "page-audited" event per audited page. No platform usage fees.
import { Actor, log } from 'apify';
import { CheerioCrawler, RequestQueue } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    startUrl,
    startUrls = [],
    maxPages = 50,
    checkExternalLinks = false,
    generateLlmsTxt = true,
    language = 'en',
    monitorChanges = true,
    alertWebhookUrl = '',
    alertOn = 'regressions',
    scoreDropThreshold = 3,
    failOnRegression = false,
} = input;

const ja = language === 'ja';
const t = (en, jp) => (ja ? jp : en);

// Accept a single startUrl, a list of strings, or a list of { url } objects.
const sites = [...new Set(
    [startUrl, ...(Array.isArray(startUrls) ? startUrls : [])]
        .map((s) => (typeof s === 'string' ? s : s?.url))
        .filter(Boolean)
        .map((s) => s.trim()),
)];
const badUrl = sites.find((s) => !/^https?:\/\//i.test(s));
if (!sites.length || badUrl) {
    await Actor.fail(t(
        `Enter at least one website URL starting with http:// or https://${badUrl ? ` (invalid: ${badUrl})` : ''}`,
        `http:// または https:// で始まるサイトURLを1つ以上入力してください${badUrl ? `（不正なURL: ${badUrl}）` : ''}`,
    ));
}

// Previous results are kept in a named key-value store in the user's own account,
// so scheduled runs can compare against the last run of the same site.
const stateStore = monitorChanges ? await Actor.openKeyValueStore('seo-ai-monitor-state') : null;
const stateKey = (url) => {
    const u = new URL(url);
    const raw = `${u.host}${u.pathname.replace(/\/+$/, '')}`;
    return `site-${raw.replace(/[^a-zA-Z0-9.-]+/g, '_')}`.slice(0, 250);
};

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
const label = (code) => (LABELS[code] ? t(...LABELS[code]) : code);

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

function normalizeUrl(u) {
    try {
        const x = new URL(u);
        x.hash = '';
        return x.href;
    } catch {
        return u;
    }
}

let spendingLimitReached = false;
let totalCharged = 0;

// ---------- audit one site ----------
async function auditSite(siteUrl, index) {
    const origin = new URL(siteUrl).origin;
    const host = new URL(siteUrl).host;

    // site-level checks (robots.txt / sitemap / llms.txt)
    const robots = await fetchText(`${origin}/robots.txt`);
    const robotsGroups = robots.status === 200 ? parseRobots(robots.text) : [];
    const sitemapFromRobots = (robots.text.match(/^\s*sitemap:\s*(\S+)/gim) || [])
        .map((l) => l.replace(/^\s*sitemap:\s*/i, '').trim());
    const sitemapUrl = sitemapFromRobots[0] || `${origin}/sitemap.xml`;
    const sitemap = await fetchText(sitemapUrl);
    const hasRobotsTxt = robots.status === 200;
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
    if (!hasRobotsTxt) siteIssues.push(t('robots.txt not found', 'robots.txtがありません'));
    if (!hasSitemap) siteIssues.push(t('XML sitemap not found', 'XMLサイトマップが見つかりません'));
    if (!hasLlmsTxt) siteIssues.push(t('llms.txt not found — a draft was generated for you (AI search readiness)', 'llms.txtがありません（下書きを自動生成しました・AI検索対応）'));
    else if (!llmsTxtValid) siteIssues.push(t('llms.txt does not start with a "# Site name" heading', 'llms.txtの1行目が「# サイト名」の形式になっていません'));
    if (blockedSearchBots.length) {
        siteIssues.push(t(`AI search crawlers blocked in robots.txt (site will not appear in AI answers): ${blockedSearchBots.join(', ')}`,
            `robots.txtでAI検索用クローラーをブロック中（AIの回答に表示されません）: ${blockedSearchBots.join(', ')}`));
    }

    // page crawl
    const linkStatus = new Map(); // internal url -> status code
    const pageResults = [];
    const enqueued = new Set([normalizeUrl(siteUrl)]);
    // A separate, unnamed-per-run queue for each site so sites never share crawl state.
    const queue = await RequestQueue.open(`site-${index}-${Date.now()}`);

    const crawler = new CheerioCrawler({
        requestQueue: queue,
        maxConcurrency: 5,
        respectRobotsTxtFile: true,
        requestHandlerTimeoutSecs: 60,
        ignoreHttpErrorStatusCodes: [404, 410, 500, 502, 503],
        async requestHandler({ request, $, response, enqueueLinks }) {
            if (spendingLimitReached) return;
            const url = request.loadedUrl || request.url;
            const status = response.statusCode;
            linkStatus.set(normalizeUrl(request.url), status);
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
            const schemaTypes = new Set();
            $('script[type="application/ld+json"]').each((_, el) => {
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
            const imgsNoAlt = $('img').filter((_, el) => $(el).attr('alt') === undefined).length;
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
                site: origin,
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
            totalCharged++;
            if (chargeResult?.eventChargeLimitReached) {
                spendingLimitReached = true;
                log.info('Spending limit reached — stopping.');
                await crawler.autoscaledPool?.abort();
                return;
            }

            // Cap the crawl at maxPages unique URLs for this site.
            await enqueueLinks({
                strategy: 'same-hostname',
                transformRequestFunction: (req) => {
                    const key = normalizeUrl(req.url);
                    if (enqueued.has(key)) return req;
                    if (enqueued.size >= maxPages) return false;
                    enqueued.add(key);
                    return req;
                },
            });
        },
        failedRequestHandler({ request }, error) {
            linkStatus.set(normalizeUrl(request.url), 0);
            log.warning(`Failed: ${request.url} — ${error.message}`);
        },
    });

    await crawler.run([siteUrl]);
    await queue.drop().catch(() => {});

    // broken links
    const brokenInternal = [...linkStatus].filter(([, s]) => s >= 400 || s === 0);
    const brokenInternalSet = new Set(brokenInternal.map(([u]) => u));
    const externalBroken = [];
    if (checkExternalLinks && !spendingLimitReached) {
        const externals = [...new Set(pageResults.flatMap((p) => p.externalLinks))].slice(0, 300);
        for (const u of externals) {
            const r = await fetchText(u);
            if (r.status >= 400 || r.status === 0) externalBroken.push({ url: u, status: r.status });
        }
    }
    const externalBrokenSet = new Set(externalBroken.map((b) => b.url));
    for (const p of pageResults) {
        const broken = [...new Set(p.internalLinks.map(normalizeUrl).filter((l) => brokenInternalSet.has(l)))];
        const brokenExt = [...new Set(p.externalLinks.filter((l) => externalBrokenSet.has(l)))];
        const nb = broken.length + brokenExt.length;
        if (nb) {
            p.score = Math.max(0, p.score - Math.min(15, nb * 5));
            p.issues.push(t(`${nb} broken link(s) on this page`, `このページにリンク切れが${nb}件あります`));
            p.codes.push('broken-links');
        }
        p.brokenLinks = [...broken, ...brokenExt];
        delete p.internalLinks;
        delete p.externalLinks;
    }

    // scores
    const n = pageResults.length;
    const share = (fn) => (n ? pageResults.filter(fn).length / n : 0);
    const avg = n ? Math.round(pageResults.reduce((s, p) => s + p.score, 0) / n) : 0;
    const siteScore = Math.max(0, avg - siteIssues.length * 3);

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

    // llms.txt draft
    let llmsTxtDraft = null;
    if (generateLlmsTxt && n) {
        const home = pageResults.find((p) => new URL(p.url).pathname === '/') || pageResults[0];
        const name = (home?.siteName || home?.title || host).replace(/\s+/g, ' ').trim();
        const summaryLine = (home?.metaDescription || '').replace(/\s+/g, ' ').trim();
        const sections = new Map();
        for (const p of [...pageResults].sort((a, b) => a.url.localeCompare(b.url))) {
            if (p.noindex || p.status >= 400) continue;
            const seg = new URL(p.url).pathname.split('/').filter(Boolean)[0];
            const key = seg ? decodeURIComponent(seg).replace(/[-_]+/g, ' ') : 'Pages';
            const sec = key.charAt(0).toUpperCase() + key.slice(1);
            if (!sections.has(sec)) sections.set(sec, []);
            const list = sections.get(sec);
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
        llmsTxtDraft = `${out.join('\n').trim()}\n`;
    }

    pageResults.sort((a, b) => a.score - b.score);
    const issueCounts = {};
    for (const p of pageResults) for (const c of p.codes) issueCounts[c] = (issueCounts[c] || 0) + 1;

    const current = {
        checkedAt: new Date().toISOString(),
        siteScore,
        aiReadinessScore,
        hasRobotsTxt,
        hasSitemap,
        hasLlmsTxt,
        blockedSearchBots,
        blockedTrainingBots,
        brokenUrls: brokenInternal.map(([u]) => u),
        pages: Object.fromEntries(pageResults.map((p) => [normalizeUrl(p.url), { score: p.score, codes: p.codes, noindex: p.noindex }])),
    };

    // compare with the previous run of the same site
    const key = stateKey(siteUrl);
    const previous = stateStore ? await stateStore.getValue(key) : null;
    const changes = previous ? diff(previous, current) : [];
    const regressions = changes.filter((c) => c.severity === 'regression');
    const improvements = changes.filter((c) => c.severity === 'improvement');
    const changeStatus = !stateStore ? 'not-monitored'
        : !previous ? 'baseline'
            : regressions.length ? 'regressed'
                : improvements.length ? 'improved' : 'unchanged';

    // per-page change columns for the dataset
    for (const p of pageResults) {
        const prev = previous?.pages?.[normalizeUrl(p.url)];
        p.scoreChange = prev ? p.score - prev.score : null;
        p.newIssues = prev ? p.codes.filter((c) => !prev.codes.includes(c)).map(label) : [];
        p.isNewPage = !!previous && !prev;
    }

    // Save state only when the crawl was complete enough to be a fair baseline.
    if (stateStore && n && !spendingLimitReached) await stateStore.setValue(key, current);

    for (const p of pageResults) { delete p.codes; delete p.siteName; }

    const summary = {
        site: origin,
        checkedAt: current.checkedAt,
        siteScore,
        aiReadinessScore,
        pagesAudited: n,
        changeStatus,
        previousCheckAt: previous?.checkedAt ?? null,
        siteScoreChange: previous ? siteScore - previous.siteScore : null,
        aiReadinessScoreChange: previous ? aiReadinessScore - previous.aiReadinessScore : null,
        regressions: regressions.length,
        improvements: improvements.length,
        changes,
        siteIssues,
        aiReadinessChecks: aiChecks,
        hasLlmsTxt,
        llmsTxtValid,
        llmsTxtDraftGenerated: !!llmsTxtDraft,
        hasSitemap,
        aiCrawlerAccess,
        blockedAiSearchCrawlers: blockedSearchBots,
        blockedAiTrainingCrawlers: blockedTrainingBots,
        brokenInternalUrls: brokenInternal.map(([url, status]) => ({ url, status })),
        brokenExternalUrls: externalBroken,
        topIssues: Object.entries(issueCounts).sort((a, b) => b[1] - a[1]).slice(0, 10)
            .map(([code, pages]) => ({ issue: label(code), pages })),
        worstPages: pageResults.slice(0, 10).map((p) => ({ url: p.url, score: p.score })),
    };
    return { summary, pageResults, llmsTxtDraft, host };
}

// ---------- change detection ----------
function diff(prev, cur) {
    const out = [];
    const add = (severity, type, en, jp, url) => out.push({ severity, type, message: t(en, jp), ...(url ? { url } : {}) });
    const th = Math.max(1, scoreDropThreshold);

    const ds = cur.siteScore - prev.siteScore;
    if (ds <= -th) add('regression', 'site-score-drop', `SEO score dropped ${prev.siteScore} → ${cur.siteScore} (${ds})`, `SEOスコアが下がりました ${prev.siteScore} → ${cur.siteScore}（${ds}）`);
    else if (ds >= th) add('improvement', 'site-score-up', `SEO score improved ${prev.siteScore} → ${cur.siteScore} (+${ds})`, `SEOスコアが上がりました ${prev.siteScore} → ${cur.siteScore}（+${ds}）`);
    const da = cur.aiReadinessScore - prev.aiReadinessScore;
    if (da <= -th) add('regression', 'ai-score-drop', `AI search readiness dropped ${prev.aiReadinessScore} → ${cur.aiReadinessScore} (${da})`, `AI検索対応スコアが下がりました ${prev.aiReadinessScore} → ${cur.aiReadinessScore}（${da}）`);
    else if (da >= th) add('improvement', 'ai-score-up', `AI search readiness improved ${prev.aiReadinessScore} → ${cur.aiReadinessScore} (+${da})`, `AI検索対応スコアが上がりました ${prev.aiReadinessScore} → ${cur.aiReadinessScore}（+${da}）`);

    const newlyBlocked = cur.blockedSearchBots.filter((b) => !prev.blockedSearchBots.includes(b));
    if (newlyBlocked.length) add('regression', 'ai-search-bot-blocked', `AI search crawler newly blocked in robots.txt: ${newlyBlocked.join(', ')}`, `robots.txtでAI検索クローラーが新たにブロックされました: ${newlyBlocked.join(', ')}`);
    const unblocked = prev.blockedSearchBots.filter((b) => !cur.blockedSearchBots.includes(b));
    if (unblocked.length) add('improvement', 'ai-search-bot-allowed', `AI search crawler now allowed: ${unblocked.join(', ')}`, `AI検索クローラーが許可されました: ${unblocked.join(', ')}`);
    const newTraining = cur.blockedTrainingBots.filter((b) => !(prev.blockedTrainingBots || []).includes(b));
    if (newTraining.length) add('info', 'ai-training-bot-blocked', `AI training crawler newly blocked: ${newTraining.join(', ')}`, `AI学習用クローラーが新たにブロックされました: ${newTraining.join(', ')}`);

    const flag = (key, type, lostEn, lostJp, backEn, backJp) => {
        if (prev[key] && !cur[key]) add('regression', `${type}-removed`, lostEn, lostJp);
        else if (!prev[key] && cur[key]) add('improvement', `${type}-added`, backEn, backJp);
    };
    flag('hasRobotsTxt', 'robots-txt', 'robots.txt is no longer reachable', 'robots.txtにアクセスできなくなりました', 'robots.txt is now published', 'robots.txtが公開されました');
    flag('hasSitemap', 'sitemap', 'XML sitemap is no longer reachable', 'XMLサイトマップにアクセスできなくなりました', 'XML sitemap is now published', 'XMLサイトマップが公開されました');
    flag('hasLlmsTxt', 'llms-txt', 'llms.txt is no longer reachable', 'llms.txtにアクセスできなくなりました', 'llms.txt is now published', 'llms.txtが公開されました');

    const prevBroken = new Set(prev.brokenUrls || []);
    const curBroken = new Set(cur.brokenUrls || []);
    for (const u of [...curBroken].filter((x) => !prevBroken.has(x)).slice(0, 50)) add('regression', 'new-broken-link', `New broken URL: ${u}`, `新しいリンク切れ: ${u}`, u);
    const fixed = [...prevBroken].filter((x) => !curBroken.has(x));
    if (fixed.length) add('improvement', 'broken-links-fixed', `${fixed.length} broken URL(s) fixed`, `リンク切れが${fixed.length}件直りました`);

    let pageDrops = 0;
    for (const [u, p] of Object.entries(cur.pages)) {
        const before = prev.pages?.[u];
        if (!before) continue;
        if (p.noindex && !before.noindex) {
            add('regression', 'page-noindex', `Page became noindex (will drop out of Google and AI search): ${u}`, `ページがnoindexになりました（Google・AI検索から消えます）: ${u}`, u);
            continue;
        }
        const d = p.score - before.score;
        if (d <= -th && pageDrops < 50) {
            pageDrops++;
            const added = p.codes.filter((c) => !before.codes.includes(c)).map(label);
            add('regression', 'page-score-drop', `Page score ${before.score} → ${p.score}${added.length ? ` (new: ${added.join(', ')})` : ''}: ${u}`,
                `ページの点数 ${before.score} → ${p.score}${added.length ? `（新しい問題: ${added.join('、')}）` : ''}: ${u}`, u);
        }
    }
    const newPages = Object.keys(cur.pages).filter((u) => !prev.pages?.[u]);
    if (newPages.length) add('info', 'new-pages', `${newPages.length} new page(s) found`, `新しいページが${newPages.length}件見つかりました`);
    return out;
}

// ---------- run all sites ----------
const results = [];
for (const [i, s] of sites.entries()) {
    if (spendingLimitReached) break;
    log.info(`Auditing ${s} (${i + 1}/${sites.length})`);
    results.push(await auditSite(s, i));
}

await Actor.pushData(results.flatMap((r) => r.pageResults));
const summaries = results.map((r) => r.summary);
await Actor.setValue('SUMMARY', summaries.length === 1 ? summaries[0] : { sites: summaries });
await Actor.setValue('CHANGES', summaries.map((s) => ({
    site: s.site,
    changeStatus: s.changeStatus,
    previousCheckAt: s.previousCheckAt,
    siteScore: s.siteScore,
    siteScoreChange: s.siteScoreChange,
    aiReadinessScore: s.aiReadinessScore,
    aiReadinessScoreChange: s.aiReadinessScoreChange,
    changes: s.changes,
})));
await Actor.setValue('REPORT.html', renderHtml(summaries, results), { contentType: 'text/html; charset=utf-8' });
for (const [i, r] of results.entries()) {
    if (!r.llmsTxtDraft) continue;
    if (i === 0) await Actor.setValue('llms.txt', r.llmsTxtDraft, { contentType: 'text/plain; charset=utf-8' });
    if (results.length > 1) await Actor.setValue(`llms-${r.host.replace(/[^a-zA-Z0-9.-]+/g, '_')}.txt`, r.llmsTxtDraft, { contentType: 'text/plain; charset=utf-8' });
}

// ---------- alerts ----------
const regressed = summaries.filter((s) => s.changeStatus === 'regressed');
const shouldAlert = alertWebhookUrl && (alertOn === 'always' || (alertOn === 'changes' && summaries.some((s) => s.changes.length)) || (alertOn === 'regressions' && regressed.length));
if (shouldAlert) {
    const env = Actor.getEnv();
    const reportUrl = env.defaultKeyValueStoreId ? `https://api.apify.com/v2/key-value-stores/${env.defaultKeyValueStoreId}/records/REPORT.html` : '';
    const lines = [];
    for (const s of summaries) {
        const head = `${s.site} — SEO ${s.siteScore}${s.siteScoreChange != null ? ` (${s.siteScoreChange >= 0 ? '+' : ''}${s.siteScoreChange})` : ''}, AI ${s.aiReadinessScore}${s.aiReadinessScoreChange != null ? ` (${s.aiReadinessScoreChange >= 0 ? '+' : ''}${s.aiReadinessScoreChange})` : ''}`;
        lines.push(`${s.changeStatus === 'regressed' ? '🔴' : s.changeStatus === 'improved' ? '🟢' : '⚪'} ${head}`);
        for (const c of s.changes.filter((x) => x.severity === 'regression').slice(0, 10)) lines.push(`  • ${c.message}`);
    }
    if (reportUrl) lines.push(t(`Report: ${reportUrl}`, `レポート: ${reportUrl}`));
    const text = `${t('SEO & AI search monitor', 'SEO・AI検索 監視')}: ${regressed.length ? t(`${regressed.length} site(s) regressed`, `${regressed.length}サイトで悪化`) : t('no regressions', '悪化なし')}\n${lines.join('\n')}`;
    try {
        const res = await fetch(alertWebhookUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            // "text" is read by Slack/Make/Zapier/n8n, "content" by Discord; full data for custom handlers.
            body: JSON.stringify({ text, content: text.slice(0, 1900), event: 'seo-ai-monitor', reportUrl, sites: summaries.map((s) => ({ site: s.site, changeStatus: s.changeStatus, siteScore: s.siteScore, siteScoreChange: s.siteScoreChange, aiReadinessScore: s.aiReadinessScore, aiReadinessScoreChange: s.aiReadinessScoreChange, changes: s.changes })) }),
            signal: AbortSignal.timeout(15000),
        });
        log.info(`Alert webhook sent (HTTP ${res.status}).`);
    } catch (e) {
        log.warning(`Alert webhook failed: ${e.message}`);
    }
}

const statusMsg = summaries.map((s) => `${new URL(s.site).host}: SEO ${s.siteScore}, AI ${s.aiReadinessScore}, ${s.changeStatus}${s.regressions ? ` (${s.regressions} regressions)` : ''}`).join(' | ');
log.info(`Done. ${statusMsg}. ${totalCharged} pages charged.`);
await Actor.setStatusMessage(statusMsg.slice(0, 900) || 'Done');

if (failOnRegression && regressed.length) {
    await Actor.fail(t(`Regression detected on ${regressed.length} site(s) — see CHANGES / REPORT.html`, `${regressed.length}サイトで悪化を検知しました（CHANGES / REPORT.html を確認）`));
} else {
    await Actor.exit();
}

// ---------- HTML report ----------
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmtDelta(d) { return d == null ? '' : ` <span class="${d < 0 ? 'bad' : d > 0 ? 'ok' : 'muted'}">(${d > 0 ? '+' : ''}${d})</span>`; }
function renderSite(s, pages) {
    const statusText = {
        baseline: t('First check — saved as the baseline. The next run will show what changed.', '初回チェックです。基準として保存しました。次回から変化を表示します。'),
        regressed: t(`${s.regressions} regression(s) since ${s.previousCheckAt?.slice(0, 10)}`, `${s.previousCheckAt?.slice(0, 10)} から ${s.regressions}件の悪化`),
        improved: t(`Improved since ${s.previousCheckAt?.slice(0, 10)}`, `${s.previousCheckAt?.slice(0, 10)} から改善`),
        unchanged: t(`No significant change since ${s.previousCheckAt?.slice(0, 10)}`, `${s.previousCheckAt?.slice(0, 10)} から大きな変化なし`),
        'not-monitored': t('Change monitoring is off.', '変化の監視はオフです。'),
    }[s.changeStatus];
    const changes = s.changes.map((c) => `<li class="${c.severity === 'regression' ? 'bad' : c.severity === 'improvement' ? 'ok' : 'muted'}">${c.severity === 'regression' ? '▼' : c.severity === 'improvement' ? '▲' : '•'} ${esc(c.message)}</li>`).join('');
    const rows = pages.map((p) => `<tr><td>${p.score}${fmtDelta(p.scoreChange)}</td><td><a href="${esc(p.url)}">${esc(p.url)}</a></td><td>${p.issues.map(esc).join('<br>') || '—'}</td></tr>`).join('');
    const bots = s.aiCrawlerAccess.map((b) => `<tr><td>${esc(b.bot)}</td><td>${esc(b.owner)}</td><td>${b.kind === 'search' ? t('AI search', 'AI検索') : t('Training', '学習')}</td><td class="${b.blocked ? 'bad' : 'ok'}">${b.blocked ? t('Blocked', 'ブロック') : t('Allowed', '許可')}</td></tr>`).join('');
    const checks = s.aiReadinessChecks.map((c) => `<li class="${c.passed ? 'ok' : 'bad'}">${c.passed ? '✓' : '✗'} ${esc(c.check)}</li>`).join('');
    return `<section><h1>${esc(s.site)}</h1>
<div class="scores"><div><div class="score">${s.siteScore}/100${fmtDelta(s.siteScoreChange)}</div><div class="label">${t('SEO score', 'SEOスコア')}</div></div><div><div class="score">${s.aiReadinessScore}/100${fmtDelta(s.aiReadinessScoreChange)}</div><div class="label">${t('AI search readiness', 'AI検索対応スコア')}</div></div></div>
<p class="status ${s.changeStatus}">${esc(statusText)}</p>
${changes ? `<h2>${t('Changes since last check', '前回からの変化')}</h2><ul class="plain">${changes}</ul>` : ''}
<p>${t('Pages audited', '診断ページ数')}: ${s.pagesAudited} / ${t('Broken internal URLs', '内部リンク切れ')}: ${s.brokenInternalUrls.length}${s.llmsTxtDraftGenerated ? ` / ${t('llms.txt draft: see the key-value store', 'llms.txtの下書き: キーバリューストア')}` : ''}</p>
<h2>${t('Site-level issues', 'サイト全体の問題')}</h2><ul>${s.siteIssues.map((i) => `<li>${esc(i)}</li>`).join('') || `<li>${t('None', 'なし')}</li>`}</ul>
<h2>${t('AI search readiness checks', 'AI検索対応チェック')}</h2><ul class="plain">${checks}</ul>
<h2>${t('AI crawler access (robots.txt)', 'AIクローラーのアクセス（robots.txt）')}</h2><table><tr><th>${t('Crawler', 'クローラー')}</th><th>${t('Owner', '提供元')}</th><th>${t('Purpose', '用途')}</th><th>${t('Status', '状態')}</th></tr>${bots}</table>
<h2>${t('Most common issues', 'よくある問題')}</h2><ul>${s.topIssues.map((i) => `<li>${esc(i.issue)} — ${i.pages} ${t('pages', 'ページ')}</li>`).join('') || `<li>${t('None', 'なし')}</li>`}</ul>
<h2>${t('Pages (worst first)', 'ページ別（スコアの低い順）')}</h2><table><tr><th>${t('Score', '点')}</th><th>URL</th><th>${t('Issues', '問題点')}</th></tr>${rows}</table></section>`;
}
function renderHtml(summaries, res) {
    const overview = summaries.length > 1
        ? `<h1>${t('All sites', '全サイト')}</h1><table><tr><th>${t('Site', 'サイト')}</th><th>SEO</th><th>AI</th><th>${t('Status', '状態')}</th></tr>${summaries.map((s) => `<tr><td>${esc(s.site)}</td><td>${s.siteScore}${fmtDelta(s.siteScoreChange)}</td><td>${s.aiReadinessScore}${fmtDelta(s.aiReadinessScoreChange)}</td><td class="${s.changeStatus === 'regressed' ? 'bad' : s.changeStatus === 'improved' ? 'ok' : 'muted'}">${esc(s.changeStatus)}${s.regressions ? ` (${s.regressions})` : ''}</td></tr>`).join('')}</table>`
        : '';
    return `<!doctype html><html lang="${ja ? 'ja' : 'en'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t('SEO & AI Search Monitor', 'SEO・AI検索 監視レポート')}</title>
<style>body{font-family:system-ui,sans-serif;max-width:960px;margin:24px auto;padding:0 16px;color:#222;line-height:1.5}h1{font-size:22px;margin-top:36px}h2{font-size:18px;margin-top:28px}.scores{display:flex;gap:32px;flex-wrap:wrap}.score{font-size:40px;font-weight:700}.score span{font-size:20px}.label{font-size:13px;color:#666}table{border-collapse:collapse;width:100%;font-size:14px}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left;vertical-align:top;word-break:break-word}ul{padding-left:20px}ul.plain{list-style:none;padding-left:0}.ok{color:#1a7f37}.bad{color:#cf222e}.muted{color:#666}.status{padding:8px 12px;border-radius:6px;background:#f3f4f6}.status.regressed{background:#ffebe9}.status.improved{background:#dafbe1}section+section{border-top:2px solid #ddd;margin-top:40px}</style>
<p class="muted">${t('SEO & AI Search Readiness Monitor', 'SEO・AI検索対応 監視レポート')} — ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</p>
${overview}
${res.map((r) => renderSite(r.summary, r.pageResults)).join('\n')}</html>`;
}
