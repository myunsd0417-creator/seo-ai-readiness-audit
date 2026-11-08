// Sends upcoming Threads posts from posts.json to Buffer as scheduled posts.
// Env: BUFFER_API_KEY (required), BUFFER_CHANNEL_ID (optional, auto-detects the Threads channel),
//      DAYS (how many days ahead to send, default 1 = tomorrow), POST_TIME (JST "HH:MM", default 07:30),
//      DRY_RUN=1 to only print.
import { readFileSync } from 'node:fs';

const API = 'https://api.buffer.com';
const posts = JSON.parse(readFileSync(new URL('./posts.json', import.meta.url), 'utf8'));
const days = Math.max(1, Number(process.env.DAYS || 1));
const [hh, mm] = (process.env.POST_TIME || '07:30').split(':').map(Number);

const jstDate = (offsetDays) => {
  const d = new Date(Date.now() + 9 * 3600e3 + offsetDays * 86400e3);
  return d.toISOString().slice(0, 10);
};
const dueAtUtc = (date) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh - 9, mm)).toISOString();
};

const targets = [];
for (let i = 1; i <= days; i++) {
  const date = jstDate(i);
  const entry = posts.find((p) => p.date === date);
  if (entry) targets.push({ date, text: entry.text, dueAt: dueAtUtc(date) });
}
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
  const data = await gql(`mutation {
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
  const r = data.createPost;
  if (r?.message) throw new Error(`Could not schedule ${t.date}: ${r.message}`);
  console.log(`Scheduled ${t.date} (${t.dueAt}): ${r?.post?.id}`);
}
