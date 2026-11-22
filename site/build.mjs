// Publishes queued guides on their date and rebuilds docs/sitemap.xml.
// Queue: guides-queue/queue.json = [{ "date": "YYYY-MM-DD", "file": "x.html", "title": "...", "summary": "..." }]
// A guide is published (copied to docs/ and linked from docs/index.html) on or after its date, Japan time.
import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const BASE = 'https://myunsd0417-creator.github.io/seo-ai-readiness-audit/';
const today = process.env.TODAY_OVERRIDE || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 1. Publish due guides.
const queue = JSON.parse(readFileSync('guides-queue/queue.json', 'utf8'));
let index = readFileSync('docs/index.html', 'utf8');
const marker = '<div class="note">One tip a day';
for (const g of queue) {
  if (g.date > today) continue;
  if (!existsSync(`docs/${g.file}`)) {
    copyFileSync(`guides-queue/${g.file}`, `docs/${g.file}`);
    console.log(`Published ${g.file}`);
  }
  if (!index.includes(`href="${g.file}"`)) {
    const card = `<div class="card">\n<h2><a href="${g.file}">${esc(g.title)}</a></h2>\n<p>${esc(g.summary)}</p>\n</div>\n\n`;
    if (!index.includes(marker)) throw new Error('index.html marker not found');
    index = index.replace(marker, card + marker);
    console.log(`Linked ${g.file} from index.html`);
  }
}
writeFileSync('docs/index.html', index);

// 2. Sitemap of every page in docs/, with the date each page last changed in git.
const lastmod = (f) => {
  try {
    return execSync(`git log -1 --format=%cs -- "docs/${f}"`).toString().trim() || today;
  } catch {
    return today;
  }
};
const pages = readdirSync('docs').filter((f) => f.endsWith('.html') && f !== '404.html').sort();
const urls = pages.map((f) => {
  const loc = f === 'index.html' ? BASE : BASE + f;
  return `  <url><loc>${loc}</loc><lastmod>${lastmod(f)}</lastmod></url>`;
});
const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
const old = existsSync('docs/sitemap.xml') ? readFileSync('docs/sitemap.xml', 'utf8') : '';
if (old !== xml) {
  writeFileSync('docs/sitemap.xml', xml);
  console.log(`Sitemap: ${pages.length} pages`);
}
