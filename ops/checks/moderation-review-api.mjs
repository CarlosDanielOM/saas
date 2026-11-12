// API target only: run with saas-ops, disposable Mongo/Redis and spam-protection-fixtures (+ its test-env).
// Operator review of chat protection: which decisions land in each queue (contradictions, near
// misses, bans), identical messages grouped into one card that only carries the copies whose
// preceding chat it shows, verdicts saved on exactly those copies (retention untouched), changing
// and clearing a verdict, strict input validation and owner-only access.
import assert from 'node:assert/strict';
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
const { ModerationDecision: Decisions } = await import('/app/dist/schemas/moderation_decision.schema.js');

const mongo = await getMongoDBConnection('moderation-review-check');
const redis = await getDragonflyClient('moderation-review-check');
const DAY = 86_400_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 150; i++) { try { if (await fn()) return; } catch { /* not listening yet */ } await sleep(200); } throw new Error(`Timeout: ${label}`); }

await redis.hSet('token:review-owner', { id: '533538623', login: 'cdom201', display_name: 'CDOM201' });
await redis.hSet('token:review-streamer', { id: '700000001', login: 'some_streamer', display_name: 'Some Streamer' });
await mongo.connection.db.collection('users').insertMany([
    { accounts: [{ type: 'twitch', id: '700000001', name: 'some_streamer' }], plan_tier: 'free' },
    { accounts: [{ type: 'twitch', id: '700000002', name: 'other_streamer' }], plan_tier: 'pro' }
]);
let seq = 0;
const said = (username, message, isBroadcaster = false) => ({ messageID: `c-${username}`, username, message, timestamp: 1, isBroadcaster });
const rule = (extra = {}) => ({ id: 'builtin-spam-protection', semantic: { categories: ['spam', 'ads', 'self_promotion'], thresholdPercent: 85, policy: 'SECRET-POLICY-TEXT', ...extra } });
const row = (text, scores, extra = {}) => {
    const id = `review-${++seq}`;
    const createdAt = new Date(Date.now() - (200 - seq) * 60_000);
    return { _id: id, channelID: '700000001', userID: `SECRET-USER-${seq}`, username: `viewer_${seq}`, messageID: id, messageText: text, ruleID: 'builtin-spam-protection',
        rule: rule(), settingsVersion: 0, matches: [], context: [], mode: 'semantic', reviewSource: 'first_message', messageOrdinal: 1,
        state: 'completed', verdict: 'uncertain', status: 'uncertain', model: 'openai/gpt-6-luna-decisions-20261006', providerRequestID: 'SECRET-PROVIDER-ID',
        scores: { spam: 0.1, ads: scores[0], safe: scores[1], violation: scores[0] },
        consequence: { status: 'allowed_fallback' }, feedback: null, createdAt, expiresAt: new Date(createdAt.getTime() + 180 * DAY), ...extra };
};
const CAMPAIGN = 'Best viewers with streamboo .com';
const asked = [said('some_streamer', 'what did that bot say? copy it here', true)];
await Decisions.collection.insertMany([
    // Near misses. Three copies of one line: two with no chat before them, one after the streamer asked for a quote.
    row(CAMPAIGN, [0.7, 0.73]), row(CAMPAIGN, [0.84, 0.47], { channelID: '700000002' }), row(CAMPAIGN, [0.62, 0.84], { context: asked }),
    // The same words with and without a broadcaster's invitation are different questions: two cards.
    row('Follow my channel twitch.tv/mine', [0.7, 0.5], { rule: rule({ broadcasterInvitation: true }), context: [said('some_streamer', 'share your channel links!', true)] }),
    row('Follow my channel twitch.tv/mine', [0.72, 0.4]),
    // Below a custom 90% bar: a near miss, not a contradiction. A tie with the safe score is a near miss too.
    row('Viewers baratos crecetucanal .com', [0.88, 0.8], { rule: rule({ thresholdPercent: 90 }) }),
    row('Tied with safe', [0.9, 0.9]),
    // Contradictions: over the bar and above the safe score, but the overall answer is under 30%.
    row('Juega mis cartas en Streamloots', [0.99, 0.96]),
    row('Over a custom bar', [0.92, 0.8], { rule: rule({ thresholdPercent: 90 }) }),
    // In no queue: an old model's greeting, a clear allow, a custom rule, no scores, and answers that came after the deadline.
    row('Hola', [0.76, 0.97], { verdict: 'allow', status: 'completed' }),
    row('buenas noches', [0.02, 0.99], { verdict: 'allow', status: 'completed' }),
    row('custom rule hit', [0.95, 0.05], { ruleID: 'custom-rule', verdict: 'violation' }),
    row('no scores', [0.9, 0.1], { scores: null, status: 'timeout' }),
    row('late answer, would have been a ban', [0.95, 0.1], { status: 'timeout' }),
    row('late answer, contradictory', [0.99, 0.96], { status: 'timeout' }),
    // Ban verdicts: carried out, exactly at the 30% overall limit, and cancelled before it ran.
    row('Buy viewers now', [0.95, 0.05], { verdict: 'violation', status: 'completed', consequence: { status: 'executed', action: 'ban', success: true } }),
    row('At the limit', [0.99, 0.7], { verdict: 'violation', status: 'completed', consequence: { status: 'executed', action: 'ban', success: true } }),
    row('Cancelled ban', [0.97, 0.03], { verdict: 'violation', status: 'completed', consequence: { status: 'cancelled' } }),
    // Ten copies, each after different chat: a card shows eight of those chats and carries only those copies.
    ...Array.from({ length: 10 }, (_, index) => row('Many chats before it', [0.6, 0.6], { context: [said(`chatter_${index}`, `line ${index}`)] }))
]);

const api = (method, path, body, token = 'review-owner') => fetch(`http://127.0.0.1:3000/admin-site/${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
const list = async query => (await (await api('GET', `moderation-reviews?${query}`)).json()).data;
const put = body => api('PUT', 'moderation-reviews', body);
await until(async () => (await api('GET', 'moderation-reviews')).status === 200, 'API ready');

// Owner only: the queue shows chat messages from every channel.
assert.equal((await api('GET', 'moderation-reviews', null, null)).status, 401);
assert.equal((await api('GET', 'moderation-reviews', null, 'review-streamer')).status, 403);
assert.equal((await api('PUT', 'moderation-reviews', { kind: 'ban', ids: ['review-16'], label: 'allow' }, 'review-streamer')).status, 403);
for (const query of ['kind=everything', 'state=done', 'page=0', 'page=0.5', 'page=abc', 'page=10001', 'limit=0.5', 'limit=51', 'kind[$ne]=ban']) {
    assert.equal((await api('GET', `moderation-reviews?${query}`)).status, 400, query);
}

const texts = data => data.rows.map(item => item.messageText).sort();
const contradictions = await list('kind=contradiction');
assert.deepEqual(texts(contradictions), ['Juega mis cartas en Streamloots', 'Over a custom bar']);
assert.deepEqual(contradictions.counts, { contradiction: 2, near_miss: 6, ban: 3 });
const misses = await list('kind=near_miss');
assert.deepEqual(texts(misses), [CAMPAIGN, 'Follow my channel twitch.tv/mine', 'Follow my channel twitch.tv/mine', 'Many chats before it', 'Tied with safe', 'Viewers baratos crecetucanal .com']);
const campaign = misses.rows.find(item => item.messageText === CAMPAIGN);
assert.deepEqual([campaign.count, campaign.more, campaign.channels, campaign.withoutContext, campaign.label], [3, 0, 2, 2, null]);
assert.deepEqual(campaign.ids.sort(), ['review-1', 'review-2', 'review-3']);
assert.deepEqual(campaign.contexts, [{ copies: 1, channel: 'some_streamer', lines: [{ username: 'some_streamer', message: 'what did that bot say? copy it here', isBroadcaster: true }] }],
    'every chat that preceded a covered copy is shown');
assert.equal(campaign.latest.channel, 'some_streamer');
assert.equal(campaign.latest.scores.violation, 0.62);
assert.equal(campaign.latest.thresholdPercent, 85);
assert.deepEqual(misses.rows.filter(item => item.messageText === 'Follow my channel twitch.tv/mine').map(item => item.invited).sort(), [false, true]);
const many = misses.rows.find(item => item.messageText === 'Many chats before it');
assert.deepEqual([many.count, many.more, many.contexts.length, many.withoutContext], [8, 2, 8, 0], 'only copies whose chat is shown are on the card');
for (const secret of ['SECRET-POLICY-TEXT', 'SECRET-PROVIDER-ID', 'SECRET-USER']) assert.equal(JSON.stringify(misses).includes(secret), false, `${secret} is never sent`);
const bans = await list('kind=ban');
assert.deepEqual(texts(bans), ['At the limit', 'Buy viewers now', 'Cancelled ban']);
assert.equal(bans.rows.find(item => item.messageText === 'Cancelled ban').latest.consequence.status, 'cancelled');
const paged = await list('kind=ban&limit=1&page=2');
assert.equal(paged.rows.length, 1);
assert.deepEqual(paged.pagination, { page: 2, limit: 1, total: 3, totalPages: 3 });

// A verdict is saved on exactly the copies the card listed, and nothing else about them changes.
for (const body of [{ kind: 'nope', ids: campaign.ids, label: 'allow' }, { kind: 'near_miss', ids: campaign.ids, label: 'maybe' }, { kind: 'near_miss', ids: campaign.ids },
    { kind: 'near_miss', ids: [], label: 'allow' }, { kind: 'near_miss', ids: 'review-1', label: 'allow' }, { kind: 'near_miss', ids: ['review-1', 'review-1'], label: 'allow' },
    { kind: 'near_miss', ids: [{ $ne: null }], label: 'allow' }, { kind: 'near_miss', ids: ['bad id!'], label: 'allow' },
    { kind: 'near_miss', ids: Array.from({ length: 501 }, (_, index) => `x${index}`), label: 'allow' }]) {
    assert.equal((await put(body)).status, 400, JSON.stringify(body).slice(0, 80));
}
assert.equal((await put({ kind: 'near_miss', ids: ['never-existed'], label: 'allow' })).status, 404);
assert.equal((await put({ kind: 'ban', ids: campaign.ids, label: 'allow' })).status, 404, 'a verdict only reaches the queue it was given in');
const saved = await (await put({ kind: 'near_miss', ids: [...campaign.ids, 'review-16'], label: 'violation' })).json();
assert.equal(saved.data.updated, 3, 'an ID from another queue is ignored');
for (const copy of await Decisions.find({ messageText: CAMPAIGN }).lean()) {
    assert.equal(copy.feedback.label, 'violation');
    assert.equal(copy.feedback.reviewerID, '533538623');
    assert.equal(copy.expiresAt.getTime(), copy.createdAt.getTime() + 180 * DAY, 'a verdict does not change how long the message is kept');
}
assert.equal((await Decisions.findById('review-16').lean()).feedback, null);
assert.equal(texts(await list('kind=near_miss')).includes(CAMPAIGN), false);
const labelled = await list('kind=near_miss&state=labelled');
assert.deepEqual(texts(labelled), [CAMPAIGN]);
assert.deepEqual([labelled.rows[0].label, labelled.rows[0].count], ['violation', 3]);
assert.ok(labelled.rows[0].reviewedAt);
assert.deepEqual(labelled.counts, { contradiction: 2, near_miss: 5, ban: 3 }, 'counts are what still waits');

// A copy that arrives later was never looked at: it waits as its own card and does not inherit the verdict.
await Decisions.collection.insertOne(row(CAMPAIGN, [0.71, 0.6], { context: [said('new_chatter', 'hola')] }));
const again = (await list('kind=near_miss')).rows.find(item => item.messageText === CAMPAIGN);
assert.deepEqual([again.count, again.label, again.ids.length], [1, null, 1]);
assert.equal((await list('kind=near_miss&state=labelled')).rows[0].count, 3, 'reviewed copies stay reviewed');

// Eight chats were shown, so eight copies are answered; the other two come up next.
assert.equal((await (await put({ kind: 'near_miss', ids: many.ids, label: 'allow' })).json()).data.updated, 8);
const rest = (await list('kind=near_miss')).rows.find(item => item.messageText === 'Many chats before it');
assert.deepEqual([rest.count, rest.more, rest.contexts.length], [2, 0, 2]);

// The verdict can be changed, and cleared.
assert.equal((await put({ kind: 'near_miss', ids: campaign.ids, label: 'allow' })).status, 200);
assert.equal((await list('kind=near_miss&state=labelled')).rows.find(item => item.messageText === CAMPAIGN).label, 'allow');
assert.equal((await put({ kind: 'near_miss', ids: campaign.ids, label: null })).status, 200);
for (const id of campaign.ids) assert.equal((await Decisions.findById(id).lean()).feedback, null);
assert.equal((await list('kind=near_miss')).rows.find(item => item.messageText === CAMPAIGN).count, 4);
assert.equal((await Decisions.findById('review-10').lean()).feedback, null, 'decisions outside the queues are never touched');
console.log('PASS moderation review API: contradiction, near-miss and ban queues (custom bars, ties, late answers and old-model greetings handled), cards split by invitation and limited to copies whose chat is shown, counts, paging, verdicts on exactly the listed copies without touching retention, later copies waiting on their own, change and clear, strict validation, nothing secret in responses, owner-only access');
await Promise.allSettled([mongo.disconnect(), redis.quit()]);
process.exit(0);
