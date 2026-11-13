// API target only: saas-ops verify api-<id> --dependency mongo --dependency redis \
//   --test-env ops/checks/admin-console-fixtures/test-env.json --fixtures ops/checks/admin-console-fixtures --check ops/checks/admin-console-overview-api.mjs
// The owner's overview (`/admin-site/overview`) and per-channel debugging (`/admin-site/users/:channelID/logs`,
// `/command-stats`, `/eventsub-activity`): owner-only access, strict input (digits-only channel ids, no operator
// injection, bounded limits), every number against hand-computed fixtures, the 15-second cache, and no token,
// e-mail or Polar customer id in any response (a log line carries token-like fields on purpose).
// APP_DIST / OVERVIEW_FIXTURES / OVERVIEW_API override the compiled app, fixtures folder and API base for a local run.
import assert from 'node:assert/strict';
const APP_DIST = process.env.APP_DIST || '/app/dist';
const FIXTURES = process.env.OVERVIEW_FIXTURES || '/tmp/saas-fixtures';
const BASE = process.env.OVERVIEW_API || 'http://127.0.0.1:3000';
const { getMongoDBConnection } = await import(`${APP_DIST}/utils/databases/mongodb.database.js`);
const { getDragonflyClient } = await import(`${APP_DIST}/utils/databases/dragonfly.database.js`);
const { seedOverview, OVERVIEW_CHANNELS, OVERVIEW_SEED_CHANNEL_IDS } = await import(`${FIXTURES}/seed-overview.mjs`);

const mongo = await getMongoDBConnection('admin-console-overview-check');
const redis = await getDragonflyClient('admin-console-overview-check');
const db = mongo.connection.db;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, tries = 150) { for (let i = 0; i < tries; i++) { try { if (await fn()) return; } catch { /* not ready yet */ } await sleep(200); } throw new Error(`Timeout: ${label}`); }

await redis.hSet('token:overview-owner', { id: '533538623', login: 'cdom201', display_name: 'CDOM201' });
await redis.hSet('token:overview-streamer', { id: '700000001', login: 'some_streamer', display_name: 'Some Streamer' });
const now = new Date();
const seed = await seedOverview({ db, redis, ObjectId: mongo.Types.ObjectId, now });
const E = seed.expected;
const A = OVERVIEW_CHANNELS.alpha.id;
const C = OVERVIEW_CHANNELS.charlie.id;
// Another check in the same run may seed the same stores; then only channel-scoped numbers are exact.
const outside = { channelID: { $nin: OVERVIEW_SEED_CHANNEL_IDS } };
const foreign = (await Promise.all([
    db.collection('activity_logs').countDocuments({ channelID: { $nin: [...OVERVIEW_SEED_CHANNEL_IDS, ''] } }),
    db.collection('ai_usage_receipts').countDocuments(outside),
    db.collection('moderation_decisions').countDocuments(outside),
    db.collection('domain_events').countDocuments({ topic: 'channel', ...outside }),
    db.collection('site_agent_turn_logs').countDocuments({ channelId: { $nin: OVERVIEW_SEED_CHANNEL_IDS } })
])).reduce((sum, n) => sum + n, 0);
const exact = foreign === 0;

const get = (path, token = 'overview-owner') => fetch(`${BASE}/admin-site/${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const SECRETS = ['SECRET', 'example.com', 'customerId', 'customerID', 'accessToken', 'refresh_token', 'Authorization', 'Bearer'];
const read = async (path) => {
    const res = await get(path);
    const text = await res.text();
    assert.equal(res.status, 200, `${path}: ${text.slice(0, 200)}`);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    for (const secret of SECRETS) assert.equal(text.includes(secret), false, `${path} leaks ${secret}`);
    const body = JSON.parse(text);
    assert.equal(body.error, false);
    return body.data;
};
const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);
const atLeast = (actual, expected, label) => assert.ok(actual >= expected - 1e-9, `${label}: ${actual} < ${expected}`);

try {
    await until(async () => (await get(`users/${A}/command-stats`)).status === 200, 'API ready');

    // ---- Access and input ----
    const paths = ['overview', `users/${A}/logs`, `users/${A}/command-stats`, `users/${A}/eventsub-activity`];
    for (const path of paths) {
        assert.equal((await get(path, null)).status, 401, `${path} without a token`);
        assert.equal((await get(path, 'overview-streamer')).status, 403, `${path} for a streamer`);
    }
    for (const id of ['abc', '12a', '-1', '1.5', '%24ne', '123456789012345678901', 'logger%3A*']) {
        for (const tail of ['logs', 'command-stats', 'eventsub-activity']) {
            assert.equal((await get(`users/${id}/${tail}`)).status, 400, `channel ${id} ${tail}`);
        }
    }
    for (const query of ['level=trace', 'level=bogus', 'level[$ne]=x', 'level=warn&level=error', 'limit=0', 'limit=201', 'limit=abc', 'limit[$gt]=1']) {
        assert.equal((await get(`users/${A}/logs?${query}`)).status, 400, `logs ${query}`);
    }
    for (const query of ['days=0', 'days=31', 'days=abc', 'days[$ne]=1']) {
        assert.equal((await get(`users/${A}/command-stats?${query}`)).status, 400, `command-stats ${query}`);
    }

    // ---- Overview ----
    // The answer is cached for about 15 s: wait for one built after the seed.
    let overview;
    await until(async () => {
        overview = await read('overview');
        return overview.topChannels.some(row => row.channelID === A) || (!exact && overview.day.credits >= E.dayCredits);
    }, 'overview with the seed', 120);
    assert.deepEqual(Object.keys(overview).sort(), ['attention', 'daily', 'day', 'features', 'generatedAt', 'partial', 'recent', 'topChannels']);
    assert.deepEqual(overview.partial, [], 'every part answered');
    assert.deepEqual(Object.keys(overview.day).sort(), ['activeChannels', 'credits', 'from', 'kinds', 'providerUSD', 'to']);
    close(new Date(overview.day.to) - new Date(overview.day.from), 86_400_000, 'day window');
    const failed24h = overview.day.kinds.reduce((sum, kind) => sum + kind.failed, 0);
    const attention = Object.fromEntries(overview.attention.map(row => [row.key, row.count]));
    assert.equal(attention.failed_24h, failed24h || undefined, 'failed_24h is the feed summary');
    assert.ok(overview.attention.every(row => row.count > 0), 'only keys above zero');
    for (const [key, count] of Object.entries(E.attention)) atLeast(attention[key] || 0, count, key);
    assert.equal('polar_unsent' in attention || 'credits_exhausted' in attention, false, 'not computed');
    assert.ok(overview.recent.length <= 8);

    assert.equal(overview.daily.length, 14);
    overview.daily.forEach((row, index) => {
        assert.deepEqual(Object.keys(row).sort(), ['credits', 'date', 'events', 'problems', 'providerUSD']);
        if (index) assert.equal(Date.parse(row.date) - Date.parse(overview.daily[index - 1].date), 86_400_000, 'consecutive days, oldest first');
    });
    assert.equal(overview.daily.at(-1).date, overview.generatedAt.slice(0, 10));
    assert.deepEqual(overview.features.map(row => row.feature).sort(), ['ai_chat', 'assistant', 'docs', 'memory', 'other', 'protection', 'voice']);
    const spend = row => row.credits / 100_000 + (row.providerUSD ?? 0);
    overview.features.forEach((row, index) => { if (index) assert.ok(spend(overview.features[index - 1]) >= spend(row) - 1e-9, 'biggest spend first'); });

    const top = Object.fromEntries(overview.topChannels.map(row => [row.channelID, row]));
    assert.ok(overview.topChannels.length <= 8);
    for (const [channelID, want] of Object.entries(E.topChannels)) {
        if (!top[channelID]) { assert.equal(exact, false, `${channelID} missing from topChannels`); continue; }
        assert.deepEqual(top[channelID], { channelID, ...want }, `top channel ${channelID}`);
    }
    if (exact) {
        assert.equal(overview.day.activeChannels, E.activeChannels);
        assert.equal(overview.day.credits, E.dayCredits);
        close(overview.day.providerUSD, E.dayProviderUSD, 'day providerUSD');
        const totals = overview.daily.reduce((sum, row) => ({ events: sum.events + row.events, problems: sum.problems + row.problems, credits: sum.credits + row.credits, providerUSD: sum.providerUSD + row.providerUSD }), { events: 0, problems: 0, credits: 0, providerUSD: 0 });
        assert.deepEqual({ ...totals, providerUSD: 0 }, { ...E.daily.totals, providerUSD: 0 });
        close(totals.providerUSD, E.daily.totals.providerUSD, 'daily providerUSD');
        assert.deepEqual(overview.features.map(row => row.feature), E.featureOrder);
        for (const row of overview.features) {
            const want = E.features[row.feature];
            assert.deepEqual({ count: row.count, failed: row.failed, credits: row.credits }, { count: want.count, failed: want.failed, credits: want.credits }, row.feature);
            if (want.providerUSD === null) assert.equal(row.providerUSD, null, row.feature);
            else close(row.providerUSD, want.providerUSD, `${row.feature} providerUSD`);
        }
    } else {
        atLeast(overview.day.activeChannels, E.activeChannels, 'activeChannels');
        atLeast(overview.day.credits, E.dayCredits, 'day credits');
        atLeast(overview.day.providerUSD, E.dayProviderUSD, 'day providerUSD');
    }
    const again = await read('overview');
    // Same answer, unless the first one was already at the end of its 15 seconds.
    assert.ok(again.generatedAt === overview.generatedAt || Date.parse(again.generatedAt) - Date.parse(overview.generatedAt) >= 14_000, 'served from the cache');

    // ---- Logs ----
    const logs = await read(`users/${A}/logs`);
    assert.deepEqual(logs.counts, E.logs.counts);
    assert.deepEqual(logs.entries.map(entry => entry.function), E.logs.problemFunctions);
    assert.deepEqual(logs.entries.map(entry => entry.level), ['error', 'error', 'warn']);
    assert.equal(logs.entries[0].message, E.logs.firstMessage);
    assert.deepEqual(logs.entries[0].data, E.logs.firstData);
    assert.equal(logs.truncated, false);
    for (const entry of logs.entries) {
        assert.deepEqual(Object.keys(entry).sort(), ['at', 'data', 'function', 'id', 'level', 'message']);
        assert.ok(Object.values(entry.data).every(value => value === null || ['string', 'number', 'boolean'].includes(typeof value)), 'flat values');
    }
    const info = await read(`users/${A}/logs?level=info&limit=1`);
    assert.deepEqual([info.entries.length, info.entries[0].message, info.truncated], [1, 'Pet talked', true]);
    assert.deepEqual((await read(`users/${A}/logs?level=fatal`)).entries, []);
    assert.equal((await read(`users/${C}/logs`)).entries.length, 0, 'another channel sees none of these lines');

    // ---- Command stats ----
    const stats = await read(`users/${A}/command-stats`);
    assert.deepEqual(stats.commands, E.commands7d);
    assert.equal(stats.recordsSince, E.recordsSince);
    close(new Date(stats.to) - new Date(stats.from), 7 * 86_400_000, 'default 7 days');
    const hi = (await read(`users/${A}/command-stats?days=30`)).commands.find(row => row.name === '!hi');
    assert.deepEqual({ runs: hi.runs, ok: hi.ok, failed: hi.failed, lastOutcome: hi.lastOutcome, reasons: hi.reasons }, E.commands30dHi);
    assert.deepEqual(await read(`users/${C}/command-stats`).then(data => [data.commands, data.recordsSince]), [[], null]);

    // ---- EventSub activity ----
    const eventsub = await read(`users/${A}/eventsub-activity`);
    assert.deepEqual(eventsub.types, E.eventsub);
    assert.deepEqual(eventsub.revoked, E.revoked);
    assert.deepEqual(await read(`users/${C}/eventsub-activity`), { types: [], revoked: [] });

    console.log(`PASS admin console overview API (${exact ? 'exact totals' : 'channel-scoped totals: other seeds present'})`);
} finally {
    await seed.cleanup();
    await redis.del(['token:overview-owner', 'token:overview-streamer']);
}
await Promise.allSettled([mongo.disconnect(), redis.quit()]);
process.exit(0);
