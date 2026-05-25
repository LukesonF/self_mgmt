import Anthropic from '@anthropic-ai/sdk';
import { Resend } from 'resend';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SLACK_TOKEN     = process.env.SLACK_TOKEN;       // User OAuth token
const SLACK_USER_ID   = process.env.SLACK_USER_ID;     // e.g. U01234567
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
const RESEND_KEY      = process.env.RESEND_API_KEY;
const USER_EMAIL      = process.env.USER_EMAIL || 'lukas@equalfood.co';

const HISTORY_FILE = path.join(__dirname, 'data', 'history.json');

// ── Slack helpers ─────────────────────────────────────────────────────

async function slackGet(method, params = {}) {
  const url = new URL(`https://slack.com/api/${method}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${SLACK_TOKEN}` },
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack ${method}: ${data.error}`);
  return data;
}

async function slackPost(method, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SLACK_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack ${method}: ${data.error}`);
  return data;
}

// ── Fetch this week's messages ────────────────────────────────────────

async function fetchWeekMessages() {
  const now = new Date();
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const after = weekAgo.toISOString().split('T')[0]; // YYYY-MM-DD

  let messages = [];
  let page = 1;

  while (true) {
    const data = await slackGet('search.messages', {
      query: `from:<@${SLACK_USER_ID}> after:${after}`,
      sort: 'timestamp',
      sort_dir: 'asc',
      count: 100,
      page,
    });

    messages = messages.concat(data.messages.matches);
    if (page >= data.messages.pagination.page_count) break;
    page++;
    await new Promise(r => setTimeout(r, 600)); // rate limit
  }

  return messages;
}

// ── Compute stats ─────────────────────────────────────────────────────

function computeStats(messages) {
  const channelCounts = {};
  const hourCounts = Array(24).fill(0);
  const peopleMentioned = {};
  let totalWords = 0;
  let threadReplies = 0;
  let topLevelMessages = 0;
  let questionCount = 0;

  messages.forEach(msg => {
    const ch = msg.channel?.name || msg.channel?.id || 'unknown';
    channelCounts[ch] = (channelCounts[ch] || 0) + 1;

    const ts = new Date(parseFloat(msg.ts) * 1000);
    hourCounts[ts.getHours()]++;

    const words = (msg.text || '').trim().split(/\s+/).filter(Boolean);
    totalWords += words.length;

    const mentions = (msg.text || '').match(/<@U[A-Z0-9]+>/g) || [];
    mentions.forEach(m => {
      const uid = m.replace(/<@|>/g, '');
      if (uid !== SLACK_USER_ID) peopleMentioned[uid] = (peopleMentioned[uid] || 0) + 1;
    });

    if (msg.thread_ts && msg.thread_ts !== msg.ts) threadReplies++;
    else topLevelMessages++;

    if ((msg.text || '').includes('?')) questionCount++;
  });

  const peakHour = hourCounts.indexOf(Math.max(...hourCounts));

  return {
    week: new Date().toISOString().split('T')[0],
    messageCount: messages.length,
    topLevelMessages,
    threadReplies,
    totalWords,
    avgWordsPerMessage: messages.length > 0 ? Math.round(totalWords / messages.length) : 0,
    channelCount: Object.keys(channelCounts).length,
    topChannels: Object.entries(channelCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8),
    peakHour,
    peopleMentionedCount: Object.keys(peopleMentioned).length,
    questionCount,
  };
}

// ── History ───────────────────────────────────────────────────────────

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); }
  catch { return []; }
}

function saveHistory(history, thisWeek) {
  const updated = [...history.filter(h => h.week !== thisWeek.week), thisWeek]
    .sort((a, b) => a.week.localeCompare(b.week))
    .slice(-16); // keep 4 months
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(updated, null, 2));
}

// ── Claude analysis ───────────────────────────────────────────────────

async function generateDigest(thisWeek, history, messages) {
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

  const prevWeeks = history.slice(-4);

  const sampleMessages = messages
    .sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts))
    .slice(0, 60)
    .map(m => `[#${m.channel?.name || 'dm'}] ${(m.text || '').replace(/<[^>]+>/g, '').trim()}`)
    .join('\n---\n');

  const trendSection = prevWeeks.length > 0
    ? prevWeeks.map(w =>
        `${w.week}: ${w.messageCount} msgs · ${w.totalWords} words · ${w.channelCount} channels · peak at ${w.peakHour}h`
      ).join('\n')
    : 'No previous weeks recorded yet.';

  const prompt = `You are analysing the weekly Slack activity of Lukas, a co-founder of Equal Food (food delivery startup in Lisbon, Portugal). Your job is to give him honest, personal, useful feedback — not flattery.

## This week (${thisWeek.week})
- Messages sent: ${thisWeek.messageCount}
- Top-level vs replies: ${thisWeek.topLevelMessages} new threads started / ${thisWeek.threadReplies} replies
- Total words: ${thisWeek.totalWords} (avg ${thisWeek.avgWordsPerMessage} words/message)
- Active in ${thisWeek.channelCount} channels
- Top channels: ${thisWeek.topChannels.map(([ch, n]) => `#${ch} (${n})`).join(', ')}
- Peak activity: ${thisWeek.peakHour}:00
- People tagged: ${thisWeek.peopleMentionedCount}
- Messages containing a question: ${thisWeek.questionCount}

## Previous weeks
${trendSection}

## Sample messages (most recent 60, newest first)
${sampleMessages}

---

Write Lukas's weekly digest. Be a sharp, honest coach. Structure it exactly like this:

**This week in numbers**
2–3 sentences. How active was he vs his own recent average? Any notable shift in volume or intensity?

**Where attention went**
Which channels dominated and what does that say about his priorities? Anything conspicuously missing?

**Communication style this week**
Tone, message length, questioning vs asserting, initiating vs reacting. Be specific — quote or paraphrase if something stands out.

**One thing done well**
One concrete observation. Don't be vague.

**One thing to improve next week**
One concrete, actionable suggestion. Don't be vague.

Keep it under 380 words total. Write in English. Be direct.`;

  const response = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0].text;
}

// ── Delivery ──────────────────────────────────────────────────────────

async function sendSlackDM(digestText) {
  const dm = await slackPost('conversations.open', { users: SLACK_USER_ID });
  const channelId = dm.channel.id;
  const date = new Date().toLocaleDateString('pt-PT', { day: 'numeric', month: 'long', year: 'numeric' });

  await slackPost('chat.postMessage', {
    channel: channelId,
    text: `*📊 Weekly Digest — ${date}*\n\n${digestText}`,
    mrkdwn: true,
  });
}

async function sendEmail(digestText) {
  const resend = new Resend(RESEND_KEY);
  const date = new Date().toLocaleDateString('pt-PT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  const bodyHtml = digestText
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');

  await resend.emails.send({
    from: 'Equal Food Digest <digest@equalfood.co>',
    to: USER_EMAIL,
    subject: `Weekly Slack Digest — ${new Date().toLocaleDateString('pt-PT', { day: 'numeric', month: 'long' })}`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;color:#1a1a1a;">
        <p style="font-size:11px;color:#999;text-transform:uppercase;letter-spacing:1px;margin:0 0 24px;">${date}</p>
        <h1 style="font-size:22px;font-weight:700;margin:0 0 24px;">📊 Weekly Slack Digest</h1>
        <div style="line-height:1.7;font-size:15px;">${bodyHtml}</div>
        <p style="margin-top:40px;font-size:11px;color:#bbb;">Generated by Claude · Equal Food</p>
      </div>
    `,
  });
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  console.log('📡 Fetching Slack messages for the past 7 days...');
  const messages = await fetchWeekMessages();
  console.log(`   Found ${messages.length} messages`);

  const thisWeek = computeStats(messages);
  const history  = loadHistory();

  console.log('🤖 Generating digest with Claude...');
  const digest = await generateDigest(thisWeek, history, messages);

  console.log('💾 Saving history...');
  saveHistory(history, thisWeek);

  console.log('💬 Sending Slack DM...');
  await sendSlackDM(digest);

  console.log('📧 Sending email...');
  await sendEmail(digest);

  console.log('\n✅ Done!\n');
  console.log('─'.repeat(60));
  console.log(digest);
  console.log('─'.repeat(60));
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
