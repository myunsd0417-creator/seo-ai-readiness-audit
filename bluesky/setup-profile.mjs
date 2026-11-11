// Updates the Bluesky profile (name, bio) and creates + pins an intro post if none is pinned.
// Keeps the existing avatar and banner. Env: BSKY_HANDLE, BSKY_APP_PASSWORD.
import { readFileSync } from 'node:fs';

const SERVICE = 'https://bsky.social';
const cfg = JSON.parse(readFileSync(new URL('./profile.json', import.meta.url), 'utf8'));

async function xrpc(method, path, { body, token, query } = {}) {
  const qs = query ? '?' + new URLSearchParams(query) : '';
  const res = await fetch(`${SERVICE}/xrpc/${path}${qs}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`${path} ${res.status}: ${data.error || ''} ${data.message || ''}`), { status: res.status, data });
  return data;
}

const s = await xrpc('POST', 'com.atproto.server.createSession', {
  body: { identifier: process.env.BSKY_HANDLE, password: process.env.BSKY_APP_PASSWORD },
});
const auth = { token: s.accessJwt };

let current = {};
let swap;
try {
  const r = await xrpc('GET', 'com.atproto.repo.getRecord', { ...auth, query: { repo: s.did, collection: 'app.bsky.actor.profile', rkey: 'self' } });
  current = r.value || {};
  swap = r.cid;
} catch (e) {
  if (e.status !== 400 && e.status !== 404) throw e;
}

let pinnedPost = current.pinnedPost;
if (!pinnedPost) {
  const text = cfg.pinnedText;
  const enc = new TextEncoder();
  const facets = [...text.matchAll(/https?:\/\/[^\s)]+/g)].map((m) => {
    const byteStart = enc.encode(text.slice(0, m.index)).length;
    return { index: { byteStart, byteEnd: byteStart + enc.encode(m[0]).length }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: m[0] }] };
  });
  const post = await xrpc('POST', 'com.atproto.repo.createRecord', {
    ...auth,
    body: { repo: s.did, collection: 'app.bsky.feed.post', record: { $type: 'app.bsky.feed.post', text, langs: ['en'], facets, createdAt: new Date().toISOString() } },
  });
  pinnedPost = { uri: post.uri, cid: post.cid };
  console.log('Created intro post:', post.uri);
} else {
  console.log('A post is already pinned; keeping it.');
}

const record = { ...current, $type: 'app.bsky.actor.profile', displayName: cfg.displayName, description: cfg.description, pinnedPost };
await xrpc('POST', 'com.atproto.repo.putRecord', {
  ...auth,
  body: { repo: s.did, collection: 'app.bsky.actor.profile', rkey: 'self', record, ...(swap ? { swapRecord: swap } : {}) },
});
console.log('Profile updated:', cfg.displayName);
