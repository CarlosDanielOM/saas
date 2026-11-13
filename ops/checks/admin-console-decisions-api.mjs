// API target only: saas-ops verify api-<id> --dependency mongo --dependency redis \
//   --test-env ops/checks/admin-console-fixtures/test-env.json --fixtures ops/checks/admin-console-fixtures --check ops/checks/admin-console-decisions-api.mjs
// The owner's chat protection decisions ledger: every filter and sort over a hand-counted fixture set
// (seed-decisions.mjs), paging without duplicates, the summary's numbers, one decision with its chat and the
// chatter's history, and the owner's verdict on any single decision (including ones outside every Review
// queue) with its effect on the Review queues' counts. Strict input validation, owner-only access, and no
// policy text, provider/Polar ids or reviewer ids in any response.
// It replaces the contents of `moderation_decisions` in the disposable test database.
// APP_DIST / FIXTURES_DIR / API_BASE point it at the worktree source and an in-process API when run locally.
import assert from 'node:assert/strict';
const APP = process.env.APP_DIST || '/app/dist';
const FIXTURES = process.env.FIXTURES_DIR || '/tmp/saas-fixtures';
const API = process.env.API_BASE || 'http://127.0.0.1:3000';
const { getMongoDBConnection } = await import(`${APP}/utils/databases/mongodb.database.js`);
const { getDragonflyClient } = await import(`${APP}/utils/databases/dragonfly.database.js`);
const { ModerationDecision: Decisions } = await import(`${APP}/schemas/moderation_decision.schema.js`);
const { moderationReviewCounts } = await import(`${APP}/server/services/moderation_review.service.js`);
const { seedDecisions, expected, CHANNELS, CHANNEL_LOGINS, U1, OWNER } = await import(`${FIXTURES}/seed-decisions.mjs`);

const mongo = await getMongoDBConnection('admin-decisions-check');
const redis = await getDragonflyClient('admin-decisions-check');
const DAY = 86_400_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 150; i++) { try { if (await fn()) return; } catch { /* not listening yet */ } await sleep(200); } throw new Error(`Timeout: ${label}`); }

const OWNER_TOKEN = 'agvdec-owner';
const STREAMER_TOKEN = 'agvdec-streamer';
await redis.hSet(`token:${OWNER_TOKEN}`, { id: OWNER.id, login: OWNER.login, display_name: 'CDOM201' });
await redis.hSet(`token:${STREAMER_TOKEN}`, { id: '700000001', login: 'some_streamer', display_name: 'Some Streamer' });
const now = Date.now();
await seedDecisions(mongo.connection.db, now);

const seen = [];
const api = async (method, path, body, token = OWNER_TOKEN) => {
    const res = await fetch(`${API}/admin-site/${path}`, {
        method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    seen.push(text);
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
};
const get = async path => {
    const res = await api('GET', path);
    assert.equal(res.status, 200, `${path}: ${JSON.stringify(res.body).slice(0, 200)}`);
    return res.body.data;
};
const put = (id, body, token) => api('PUT', `decisions/${encodeURIComponent(id)}/feedback`, body, token);
const ids = rows => rows.map(row => row.id).sort();
const close = (a, b, label) => assert.ok(Math.abs(a - b) < 1e-9, `${label}: ${a} vs ${b}`);
await until(async () => (await api('GET', 'decisions')).status === 200, 'API ready');

// ---- Owner only ----
for (const [method, path] of [['GET', 'decisions'], ['GET', 'decisions/summary'], ['GET', 'decisions/dec-ai-ban'], ['PUT', 'decisions/dec-ai-ban/feedback']]) {
    const body = method === 'PUT' ? { label: 'allow' } : undefined;
    assert.equal((await api(method, path, body, null)).status, 401, `${path} needs a sign-in`);
    assert.equal((await api(method, path, body, STREAMER_TOKEN)).status, 403, `${path} is owner only`);
}
assert.equal((await Decisions.findById('dec-ai-ban').lean()).feedback, null, 'a refused verdict saved nothing');

// ---- Input validation ----
const badLists = ['page=0', 'page=abc', 'page=1.5', 'limit=0', 'limit=51', 'show=everything', 'sort=random', 'kind=model', 'source=chat', 'feedback=maybe',
    'channel=bad!login', 'chatter=abc', 'from=yesterday', 'from=2026-02-01&to=2026-01-01', `from=${new Date(now - 200 * DAY).toISOString()}`,
    'show[$ne]=x', 'chatter[$ne]=1', 'channel[$gt]=', 'model[$regex]=.*', 'model=a$b', `model=${'m'.repeat(101)}`, `chatterName=${'n'.repeat(51)}`, 'chatterName=a%01b',
    'channel=1&channel=2', 'sort=newest&sort=cost'];
for (const query of badLists) assert.equal((await api('GET', `decisions?${query}`)).status, 400, query);
for (const query of ['channel=bad!login', 'chatter=abc', 'from=2026-02-01&to=2026-01-01', 'chatter[$ne]=1']) assert.equal((await api('GET', `decisions/summary?${query}`)).status, 400, `summary ${query}`);
assert.equal((await api('GET', `decisions/${encodeURIComponent('bad id!')}`)).status, 400);
assert.equal((await api('GET', `decisions/${'x'.repeat(129)}`)).status, 400);
assert.equal((await api('GET', 'decisions/never-existed')).status, 404);

// ---- The list ----
const first = await api('GET', 'decisions');
assert.equal(first.headers.get('cache-control'), 'no-store');
assert.equal(first.body.error, false);
const ROW_KEYS = ['id', 'at', 'channelID', 'channel', 'chatter', 'messageText', 'kind', 'ruleType', 'ruleReason', 'source', 'messageOrdinal', 'verdict', 'status', 'outcome',
    'action', 'actionError', 'model', 'provider', 'scores', 'thresholdPercent', 'inputTokens', 'providerUSD', 'credits', 'included', 'latencyMs', 'nearMiss', 'feedback'].sort();
assert.deepEqual(first.body.data.pagination, { page: 1, limit: 25, total: 19, totalPages: 1 });
for (const row of first.body.data.rows) {
    assert.deepEqual(Object.keys(row).sort(), ROW_KEYS, row.id);
    // The row's own near-miss mark is the same test as the `show=near_miss` filter.
    assert.equal(row.nearMiss, expected.lists['show=near_miss'].includes(row.id), `${row.id} nearMiss`);
    assert.deepEqual(Object.keys(row.chatter).sort(), ['id', 'login', 'name']);
}
assert.equal(first.body.data.rows[0].id, 'dec-plan-required', 'newest first');
const byId = Object.fromEntries((await get('decisions?limit=50')).rows.map(row => [row.id, row]));
assert.equal(Object.keys(byId).length, 19, 'the 40-day-old decision is outside the default 30 days');

assert.deepEqual(byId['dec-ai-ban'], {
    id: 'dec-ai-ban', at: byId['dec-ai-ban'].at, channelID: CHANNELS.A, channel: CHANNEL_LOGINS.A, chatter: { id: '810000002', login: 'chatter_2', name: 'Chatter_2' },
    messageText: 'text of dec-ai-ban', kind: 'ai', ruleType: 'builtin', ruleReason: null, source: 'first_message', messageOrdinal: 1, verdict: 'violation', status: 'completed',
    outcome: 'acted', action: 'ban', actionError: null, model: 'openai/gpt-6-luna-decisions', provider: 'OpenAI',
    scores: { spam: 0.5, ads: 0.95, self_promotion: 0.01, safe: 0.03, violation: 0.95 }, thresholdPercent: 85, inputTokens: 1900, providerUSD: 0.00018, credits: 0,
    included: true, latencyMs: 1100, nearMiss: false, feedback: null
});
assert.ok(Math.abs(Date.parse(byId['dec-ai-ban'].at) - (now - 38 * 60_000)) < 1000);
assert.deepEqual([byId['dec-ban-refused'].outcome, byId['dec-ban-refused'].action, byId['dec-ban-refused'].actionError],
    ['action_failed', 'ban', 'The user specified in the user_id field is already banned.']);
const old = byId['dec-rule-delete'];
assert.deepEqual([old.kind, old.ruleType, old.ruleReason, old.source, old.messageOrdinal, old.model, old.provider, old.scores, old.thresholdPercent, old.outcome, old.action, old.actionError],
    ['rule', 'blacklist', 'Blocked word', 'rule', null, null, null, null, null, 'action_failed', 'delete', 'Bad Request']);
assert.deepEqual(old.chatter, { id: '810000005', login: null, name: 'Usuario_Cinco' }, 'decisions stored before logins have none');
assert.deepEqual([byId['dec-rule-warn'].ruleType, byId['dec-rule-warn'].outcome, byId['dec-rule-warn'].action], ['caps', 'acted', 'warn']);
assert.deepEqual([byId['dec-rule-timeout'].channel, byId['dec-rule-timeout'].action], [null, 'timeout'], 'a channel with no account has no login');
assert.deepEqual([byId['dec-charged'].included, byId['dec-charged'].credits, byId['dec-charged'].model, byId['dec-charged'].source, byId['dec-charged'].messageOrdinal],
    [false, 9, 'typesafe/jev-1.13', 'spam_continuous', null]);
assert.deepEqual([byId['dec-jev-first'].included, byId['dec-jev-first'].credits], [false, 9], 'a charged first message is not an included one');
assert.deepEqual([byId['dec-timeout'].outcome, byId['dec-timeout'].model, byId['dec-timeout'].scores, byId['dec-timeout'].action], ['not_reviewed', 'openai/gpt-6-luna-decisions', null, null]);
assert.deepEqual([byId['dec-pending'].outcome, byId['dec-plan-required'].outcome], ['not_reviewed', 'not_reviewed']);
assert.deepEqual([byId['dec-near-miss'].outcome, byId['dec-near-miss'].messageOrdinal, byId['dec-contradiction'].outcome], ['allowed', 2, 'allowed']);
assert.deepEqual(byId['dec-labelled-agree'].feedback, { label: 'violation', note: 'obvious seller', reviewedAt: new Date(now - 60_000).toISOString() });
assert.deepEqual(byId['dec-rule-labelled'].feedback.note, null);

for (const [query, want] of Object.entries(expected.lists)) {
    const data = await get(`decisions?limit=50${query ? `&${query}` : ''}`);
    if (typeof want === 'number') assert.equal(data.pagination.total, want, query);
    else {
        assert.deepEqual(ids(data.rows), [...want].sort(), query);
        assert.equal(data.pagination.total, want.length, query);
    }
}
assert.equal((await get(`decisions?chatter=${U1.id}&from=${new Date(now - 50 * DAY).toISOString()}`)).pagination.total, 6, 'a wider window reaches older decisions');
assert.equal((await get(`decisions?to=${new Date(now - 30 * 60_000).toISOString()}&limit=50`)).pagination.total, 10, 'to bounds the window');

for (const [sort, want] of Object.entries(expected.firstBySort)) {
    assert.deepEqual((await get(`decisions?sort=${sort}`)).rows.slice(0, want.length).map(row => row.id), want, sort);
}
for (const sort of ['newest', 'cost', 'score', 'slowest']) {
    const pages = [];
    for (let page = 1; page <= 3; page++) {
        const data = await get(`decisions?sort=${sort}&limit=7&page=${page}`);
        assert.deepEqual(data.pagination, { page, limit: 7, total: 19, totalPages: 3 }, sort);
        pages.push(...data.rows.map(row => row.id));
    }
    assert.equal(pages.length, 19, sort);
    assert.equal(new Set(pages).size, 19, `${sort}: no row on two pages`);
    assert.equal((await get(`decisions?sort=${sort}&limit=7&page=4`)).rows.length, 0);
}

// ---- The summary ----
const SUMMARY_KEYS = ['from', 'to', 'total', 'aiReviews', 'ruleHits', 'violations', 'bans', 'bansFailed', 'notReviewed', 'included', 'providerUSD', 'credits', 'latencyP50Ms',
    'latencyP95Ms', 'channels', 'labelled', 'agree', 'disagree', 'verdictsWaiting', 'daily', 'byModel', 'byChannel'].sort();
const summary = await get('decisions/summary');
assert.deepEqual(Object.keys(summary).sort(), SUMMARY_KEYS);
for (const [key, value] of Object.entries(expected.summary)) {
    if (key === 'providerUSD') close(summary[key], value, key);
    else assert.equal(summary[key], value, key);
}
assert.ok(summary.latencyP95Ms >= 1100 && summary.latencyP95Ms <= 1200, `p95 ${summary.latencyP95Ms}`);
assert.ok(Math.abs(Date.parse(summary.to) - Date.parse(summary.from) - 30 * DAY) < 1000, 'the last 30 days by default');
assert.equal(summary.daily.length, 31, 'today and the 30 days before it');
assert.deepEqual(summary.daily.map(day => day.date), [...summary.daily.map(day => day.date)].sort(), 'oldest first');
assert.equal(new Set(summary.daily.map(day => day.date)).size, summary.daily.length, 'one row per day');
assert.equal(summary.daily.reduce((sum, day) => sum + day.reviews, 0), 19);
assert.equal(summary.daily.reduce((sum, day) => sum + day.violations, 0), 3);
assert.equal(summary.daily.reduce((sum, day) => sum + day.notReviewed, 0), 4);
close(summary.daily.reduce((sum, day) => sum + day.providerUSD, 0), 0.00139, 'daily USD');
assert.ok(summary.daily.filter(day => day.reviews === 0).length >= 28, 'empty days are there, with zeros');
assert.deepEqual(Object.keys(summary.daily[0]).sort(), ['date', 'notReviewed', 'providerUSD', 'reviews', 'violations']);
assert.deepEqual(summary.byModel.map(({ latencyP50Ms, providerUSD, ...row }) => row), expected.byModel.map(({ providerUSD, ...row }) => row));
summary.byModel.forEach((row, index) => close(row.providerUSD, expected.byModel[index].providerUSD, row.model));
assert.equal(summary.byModel[0].latencyP50Ms, 900, 'Luna: 600 700 800 900 1000 1100 1200');
assert.equal(summary.byModel[3].latencyP50Ms, 600);
assert.deepEqual(summary.byChannel.map(row => [row.channelID, row.channel, row.reviews, row.violations]),
    expected.byChannel.map(row => [CHANNELS[row.key], CHANNEL_LOGINS[row.key] ?? null, row.reviews, row.violations]));
const channelA = await get(`decisions/summary?channel=${CHANNELS.A}`);
for (const [key, value] of Object.entries(expected.summaryChannelA)) {
    if (key === 'providerUSD') close(channelA[key], value, key);
    else assert.equal(channelA[key], value, `channel A ${key}`);
}
assert.equal(channelA.verdictsWaiting, 4, 'the queue count is all time and every channel');
assert.equal((await get(`decisions/summary?channel=${CHANNEL_LOGINS.A}`)).total, 12, 'a channel login works too');
assert.equal((await get(`decisions/summary?chatter=${U1.id}`)).total, 5);
const none = await get('decisions/summary?channel=nobody_here');
assert.deepEqual([none.total, none.byModel, none.byChannel, none.latencyP50Ms], [0, [], [], 0]);
const narrow = await get(`decisions/summary?from=${new Date(now - 3 * DAY).toISOString()}`);
assert.equal(narrow.daily.length, 4);
assert.equal(narrow.total, 19);

// ---- One decision ----
const detail = await get('decisions/dec-near-miss');
assert.deepEqual(Object.keys(detail).sort(), [...ROW_KEYS, 'categories', 'context', 'history', 'invited'].sort());
assert.deepEqual(detail.context, [
    { username: CHANNEL_LOGINS.A, message: 'share your links!', isBroadcaster: true, at: new Date(now - 40_000).toISOString() },
    { username: 'Chatter_20', message: 'later line', isBroadcaster: false, at: new Date(now - 20_000).toISOString() }
], 'oldest first');
assert.deepEqual([detail.invited, detail.categories], [true, ['ads', 'self_promotion']]);
assert.deepEqual(detail.history.map(item => item.id), expected.nearMissHistory);
assert.deepEqual(Object.keys(detail.history[0]).sort(), ['action', 'at', 'id', 'messageText', 'outcome', 'verdict']);
assert.deepEqual(detail.history[0], { id: 'dec-rule-warn', at: byId['dec-rule-warn'].at, messageText: 'text of dec-rule-warn', verdict: 'violation', outcome: 'acted', action: 'warn' });
const plain = await get('decisions/dec-rule-timeout');
assert.deepEqual([plain.context, plain.invited, plain.categories, plain.history], [[], false, [], []]);

// ---- The owner's verdict on any single decision ----
assert.deepEqual(await moderationReviewCounts(), expected.reviewCounts);
const raw = id => Decisions.collection.findOne({ _id: id });
const without = ({ feedback, ...rest }) => rest;
const before = { warn: await raw('dec-rule-warn'), miss: await raw('dec-near-miss'), timeout: await raw('dec-timeout') };

for (const body of [{ label: 'uncertain' }, { label: 'maybe' }, {}, { note: 'x' }, { label: ['violation'] }, { label: { $ne: null } }, { label: 'allow', note: 'n'.repeat(501) },
    { label: 'allow', note: 12 }, { label: 'allow', note: { $literal: 'x' } }, []]) {
    assert.equal((await put('dec-rule-warn', body)).status, 400, JSON.stringify(body).slice(0, 60));
}
assert.equal((await put('bad id!', { label: 'allow' })).status, 400);
assert.equal((await put('never-existed', { label: 'allow' })).status, 404);
assert.deepEqual(await raw('dec-rule-warn'), before.warn, 'refused verdicts changed nothing');

// A rule hit is in no Review queue: the ledger can still take a verdict on it, and the queues do not move.
const onRule = await put('dec-rule-warn', { label: 'allow', note: '  caps are fine in this channel  ' });
assert.equal(onRule.status, 200);
assert.deepEqual(Object.keys(onRule.body.data), ['feedback']);
assert.deepEqual(Object.keys(onRule.body.data.feedback).sort(), ['label', 'note', 'reviewedAt']);
assert.deepEqual([onRule.body.data.feedback.label, onRule.body.data.feedback.note], ['allow', 'caps are fine in this channel']);
assert.ok(Math.abs(Date.parse(onRule.body.data.feedback.reviewedAt) - Date.now()) < 60_000);
const warnAfter = await raw('dec-rule-warn');
assert.deepEqual(without(warnAfter), without(before.warn), 'nothing else about the decision changed, retention included');
assert.equal(warnAfter.expiresAt.getTime(), before.warn.expiresAt.getTime());
assert.deepEqual([warnAfter.feedback.label, warnAfter.feedback.note, warnAfter.feedback.reviewerID], ['allow', 'caps are fine in this channel', OWNER.id]);
assert.deepEqual(await moderationReviewCounts(), expected.reviewCounts);
assert.deepEqual(ids((await get('decisions?feedback=disagree')).rows), ['dec-labelled-disagree', 'dec-rule-labelled', 'dec-rule-warn']);

// So is a review that never finished.
assert.equal((await put('dec-timeout', { label: 'violation', note: '$cost' })).status, 200);
const timeoutAfter = await raw('dec-timeout');
assert.equal(timeoutAfter.feedback.note, '$cost', 'a note is stored as written, never read as a field');
assert.deepEqual(without(timeoutAfter), without(before.timeout));

// A near miss: the verdict takes it out of the Review queue; changing it keeps it out; clearing it puts it back.
assert.equal((await put('dec-near-miss', { label: 'violation' })).status, 200);
assert.deepEqual(await moderationReviewCounts(), { ...expected.reviewCounts, near_miss: 0 });
assert.equal((await get('decisions/summary')).verdictsWaiting, 3);
assert.deepEqual((await get('decisions/dec-near-miss')).feedback.note, null);
const changed = await put('dec-near-miss', { label: 'allow', note: 'n'.repeat(500) });
assert.equal(changed.status, 200, 'a 500-character note fits');
assert.deepEqual([changed.body.data.feedback.label, changed.body.data.feedback.note.length], ['allow', 500]);
assert.deepEqual(await moderationReviewCounts(), { ...expected.reviewCounts, near_miss: 0 });
assert.ok(ids((await get('decisions?feedback=agree')).rows).includes('dec-near-miss'));
const cleared = await put('dec-near-miss', { label: null, note: 'ignored' });
assert.equal(cleared.status, 200);
assert.deepEqual(cleared.body.data, { feedback: null });
const missAfter = await raw('dec-near-miss');
assert.equal(missAfter.feedback, null, 'cleared exactly as the Review page clears it');
assert.deepEqual(without(missAfter), without(before.miss));
assert.deepEqual(await moderationReviewCounts(), expected.reviewCounts);
assert.equal((await get('decisions/summary')).verdictsWaiting, 4);
assert.equal((await get('decisions/dec-near-miss')).feedback, null);
assert.equal((await put('dec-ai-allow', { label: 'allow', note: '   ' })).body.data.feedback.note, null, 'a blank note is no note');
for (const doc of await Decisions.collection.find({}).toArray()) assert.equal(doc.expiresAt.getTime(), doc.createdAt.getTime() + 180 * DAY, `${doc._id} keeps its retention`);

// ---- Nothing secret, ever ----
const everything = seen.join('\n');
for (const secret of ['SECRET-', 'reviewerID', 'customerID', 'externalID', 'providerRequestID', 'policy', 'examples', 'billableCostUSD']) {
    assert.equal(everything.includes(secret), false, `${secret} is never sent`);
}

console.log(`PASS admin console decisions API: ${Object.keys(expected.lists).length} filters, 4 sorts paged without duplicates, summary totals/percentiles/days/models/channels, detail with ordered chat and history, verdicts on decisions outside every Review queue (set, change, clear, notes, Review counts and retention untouched), strict validation, nothing secret, owner-only access`);
await Promise.allSettled([redis.del(`token:${OWNER_TOKEN}`), redis.del(`token:${STREAMER_TOKEN}`)]);
await Promise.allSettled([mongo.disconnect(), redis.quit()]);
process.exit(0);
