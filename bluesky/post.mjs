// Posts today's scheduled entry from posts.json to Bluesky.
// No dependencies (Node 18+ built-in fetch).
// Env: BSKY_HANDLE, BSKY_APP_PASSWORD, optional DRY_RUN=1, optional POST_DATE=YYYY-MM-DD
import { readFileSync } from 'node:fs';

const SERVICE = 'https://bsky.social';
const posts = JSON.parse(readFileSync(new URL('./posts.json', import.meta.url), 'utf8'));

// Today's date in Japan time, so the schedule matches the user's calendar.
const today = process.env.POST_DATE ||
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());

const entry = posts.find((p) => p.date === today);
if (!entry && process.env.LOGIN_ONLY !== '1') {
  console.log(`No post scheduled for ${today}. Nothing to do.`);
  process.exit(0);
}

const text = entry ? entry.text : '';
if ([...new Intl.Segmenter().segment(text)].length > 300) {
  throw new Error(`Post for ${today} is over 300 characters.`);
}

// Make URLs clickable: Bluesky needs "facets" with UTF-8 byte offsets.
const facets = [];
const enc = new TextEncoder();
for (const m of text.matchAll(/https?:\/\/[^\s)]+/g)) {
  const byteStart = enc.encode(text.slice(0, m.index)).length;
  const byteEnd = byteStart + enc.encode(m[0]).length;
  facets.push({
    index: { byteStart, byteEnd },
    features: [{ $type: 'app.bsky.richtext.facet#link', uri: m[0] }],
  });
}

// Make #hashtags clickable and discoverable in Bluesky hashtag feeds.
for (const m of text.matchAll(/(^|\s)#([A-Za-z][A-Za-z0-9_]{1,63})/g)) {
  const start = m.index + m[1].length;
  const byteStart = enc.encode(text.slice(0, start)).length;
  const byteEnd = byteStart + enc.encode('#' + m[2]).length;
  facets.push({
    index: { byteStart, byteEnd },
    features: [{ $type: 'app.bsky.richtext.facet#tag', tag: m[2] }],
  });
}

const record = {
  $type: 'app.bsky.feed.post',
  text,
  langs: ['en'],
  createdAt: new Date().toISOString(),
  ...(facets.length ? { facets } : {}),
};

if (process.env.DRY_RUN === '1') {
  console.log(`[dry run] ${today}\n${JSON.stringify(record, null, 2)}`);
  process.exit(0);
}

const handle = process.env.BSKY_HANDLE;
const password = process.env.BSKY_APP_PASSWORD;
if (!handle || !password) throw new Error('BSKY_HANDLE or BSKY_APP_PASSWORD is not set.');

async function call(path, body, token) {
  const res = await fetch(`${SERVICE}/xrpc/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} failed (${res.status}): ${data.error || ''} ${data.message || ''}`);
  return data;
}

const session = await call('com.atproto.server.createSession', { identifier: handle, password });
if (process.env.LOGIN_ONLY === '1') {
  console.log(`Login OK as ${session.handle}. Nothing was posted.`);
  process.exit(0);
}
// Skip if this exact text was already posted (protects against delayed/duplicate runs).
const feedRes = await fetch(`${SERVICE}/xrpc/app.bsky.feed.getAuthorFeed?actor=${session.did}&limit=30`, {
  headers: { Authorization: `Bearer ${session.accessJwt}` },
});
if (feedRes.ok) {
  const feed = await feedRes.json();
  if ((feed.feed || []).some((f) => f.post?.record?.text === text)) {
    console.log(`Already posted for ${today}. Skipping.`);
    process.exit(0);
  }
}
const result = await call(
  'com.atproto.repo.createRecord',
  { repo: session.did, collection: 'app.bsky.feed.post', record },
  session.accessJwt,
);
console.log(`Posted for ${today}: ${result.uri}`);
