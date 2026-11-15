// Sends upcoming Threads posts from posts.json to Buffer as scheduled posts.
// Env: BUFFER_API_KEY (required), BUFFER_CHANNEL_ID (optional, auto-detects the Threads channel),
//      DAYS (how many days ahead to send, default 1 = tomorrow), POST_TIME (JST "HH:MM", default 07:30),
//      DRY_RUN=1 to only print.
import { readFileSync, writeFileSync } from 'node:fs';

const API = 'https://api.buffer.com';
const posts = JSON.parse(readFileSync(new URL('./posts.json', import.meta.url), 'utf8'));
const days = Math.max(1, Number(process.env.DAYS || 1));
const [hh, mm] = (process.env.POST_TIME || '07:30').split(':').map(Number);

const jstDate = (offsetDays) => {
  const d = new Date(Date.now() + 9 * 3600e3 + offsetDays * 86400e3);
  return d.toISOString().slice(0, 10);
};
const dueAtUtc = (date, time) => {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = time ? time.split(':').map(Number) : [hh, mm];
  return new Date(Date.UTC(y, m - 1, d, h - 9, mi)).toISOString();
};

// Dates already sent to Buffer (kept in sent.json so repeated runs never double-post).
const sentFile = new URL('./sent.json', import.meta.url);
let sent = [];
try { sent = JSON.parse(readFileSync(sentFile, 'utf8')); } catch {}

const targets = [];
const keyOf = (p) => p.id || p.date;
for (let i = 0; i <= days; i++) {
  const date = jstDate(i);
  for (const entry of posts.filter((p) => p.date === date)) {
    const k = keyOf(entry);
    if (sent.includes(k)) continue;
    let dueAt = dueAtUtc(date, entry.time);
    // If GitHub ran late and the slot already passed: post the main post soon; skip optional extra posts.
    const soon = new Date(Date.now() + 10 * 60e3).toISOString();
    if (dueAt < soon) {
      if (entry.optional) { sent.push(k); continue; }
      dueAt = soon;
    }
    targets.push({ key: k, date, text: entry.text, dueAt });
  }
}
targets.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
if (!targets.length) {
  console.log('No posts to schedule for the next', days, 'day(s).');
  process.exit(0);
}

if (process.env.DRY_RUN === '1') {
  for (const t of targets) console.log(`[dry run] ${t.date} at ${t.dueAt}\n${t.text}\n`);
  process.exit(0);
}

const key = process.env.BUFFER_API_KEY;
if (!key) throw new Error('BUFFER_API_KEY is not set.');

async function gql(query) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.errors) {
    throw new Error(`Buffer API error (${res.status}): ${JSON.stringify(data.errors || data).slice(0, 500)}`);
  }
  return data.data;
}

let channelId = process.env.BUFFER_CHANNEL_ID;
if (!channelId) {
  const { account } = await gql('query { account { organizations { id name } } }');
  for (const org of account.organizations) {
    const { channels } = await gql(
      `query { channels(input: { organizationId: ${JSON.stringify(org.id)} }) { id name service } }`,
    );
    const th = channels.find((c) => String(c.service).toLowerCase() === 'threads');
    if (th) { channelId = th.id; console.log(`Using Threads channel: ${th.name} (${th.id})`); break; }
  }
  if (!channelId) throw new Error('No Threads channel found in Buffer.');
}

for (const t of targets) {
  let data;
  try {
    data = await gql(`mutation {
    createPost(input: {
      text: ${JSON.stringify(t.text)},
      channelId: ${JSON.stringify(channelId)},
      schedulingType: automatic,
      mode: customScheduled,
      dueAt: ${JSON.stringify(t.dueAt)}
    }) {
      ... on PostActionSuccess { post { id } }
      ... on MutationError { message }
    }
  }`);
  } catch (err) {
    console.log(`Stopped at ${t.key}: ${err.message}`);
    break;
  }
  const r = data.createPost;
  if (r?.message) {
    // Usually the free plan's queue limit; the next run will try again once slots free up.
    console.log(`Stopped at ${t.key}: ${r.message}`);
    break;
  }
  console.log(`Scheduled ${t.key} (${t.dueAt}): ${r?.post?.id}`);
  sent.push(t.key);
  writeFileSync(sentFile, JSON.stringify(sent.sort(), null, 0) + '\n');
}
