// API target only: saas-ops verify api-<id> --dependency mongo --dependency redis \
//   --test-env ops/checks/admin-console-fixtures/test-env.json --fixtures ops/checks/admin-console-fixtures --check ops/checks/admin-console-feed-api.mjs
// The owner's activity feed (`/admin-site/feed`, `/admin-site/feed/summary`, `/admin-site/events/:eventKey`): owner-only
// access, strict input (operator injection, unknown kinds, windows over 90 days, bad cursors, bad event keys), the
// merged order of every store against the seed's expected feed (small pages, five stores in one millisecond, no
// gaps or duplicates), each filter, per-kind counts, event detail with deliveries and stream steps, and nothing
// secret in any response: assistant rows carry the question preview but never the answer or tool data, and the
// event payload never carries a token-like key. A viewer is found in every store and channel by id; a login is
// turned into an id through Helix, and when it cannot be (unknown login, Twitch down: the provider mock answers
// `/helix/users` with no users), the stores that cannot search a login are listed in `partial`, never left out silently. Another check may seed the same database, so every comparison is
// limited to this seed's own rows. APP_DIST / FEED_FIXTURES / FEED_API override the compiled app, fixtures folder
// and API base for a local run.
import assert from 'node:assert/strict';
const APP_DIST = process.env.APP_DIST || '/app/dist';
const FIXTURES = process.env.FEED_FIXTURES || '/tmp/saas-fixtures';
const BASE = process.env.FEED_API || 'http://127.0.0.1:3000';
const { getMongoDBConnection } = await import(`${APP_DIST}/utils/databases/mongodb.database.js`);
const { getDragonflyClient } = await import(`${APP_DIST}/utils/databases/dragonfly.database.js`);
const { seedFeed, expectedFeed, expectedCounts, expectedPartial, FEED_CHANNELS, FEED_CHATTER, FEED_DOCS_IDS, FEED_EVENT_KEYS, FEED_LOGINS, FEED_SENTENCE_SECRET, FEED_UNKNOWN_LOGIN } = await import(`${FIXTURES}/seed-feed.mjs`);

const mongo = await getMongoDBConnection('admin-console-feed-check');
const redis = await getDragonflyClient('admin-console-feed-check');
const db = mongo.connection.db;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 150; i++) { try { if (await fn()) return; } catch { /* not listening yet */ } await sleep(200); } throw new Error(`Timeout: ${label}`); }

await redis.hSet('token:feed-owner', { id: '533538623', login: 'cdom201', display_name: 'CDOM201' });
await redis.hSet('token:feed-streamer', { id: '700000001', login: 'some_streamer', display_name: 'Some Streamer' });
const now = new Date();
const seed = await seedFeed(db, redis, now, mongo.Types.ObjectId);
const A = FEED_CHANNELS.alpha;
const B = FEED_CHANNELS.bravo;
const X = FEED_CHATTER;
const window = { from: seed.window.from.toISOString(), to: seed.window.to.toISOString() };

const get = (path, token = 'feed-owner') => fetch(`${BASE}/admin-site/${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const qs = query => new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)])).toString();
const read = async (path) => {
    const res = await get(path);
    const text = await res.text();
    assert.equal(res.status, 200, `${path}: ${text.slice(0, 300)}`);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(text.includes('SECRET'), false, `${path} leaks a secret marker`);
    for (const word of ['customerId', 'requestId', 'resourceId', 'expiresAt', 'mongodb://']) assert.equal(text.includes(word), false, `${path} leaks ${word}`);
    const body = JSON.parse(text);
    assert.equal(body.error, false);
    return body.data;
};
const status = async (path, token) => (await get(path, token)).status;

try {
    await until(async () => (await get(`feed?${qs(window)}`)).status === 200, 'API ready');

    // ---- Access and input ----
    const eventPath = `events/${encodeURIComponent(FEED_EVENT_KEYS.follow)}`;
    for (const path of ['feed', 'feed/summary', eventPath]) {
        assert.equal(await status(path, null), 401, `${path} without a token`);
        assert.equal(await status(path, 'feed-streamer'), 403, `${path} for a streamer`);
    }
    const bad = ['kinds=command,nope', 'kinds[$ne]=x', 'kinds=command&kinds=alert', 'outcome=ok', 'outcome[$ne]=ok', 'limit=0', 'limit=101', 'limit=abc',
        'channel=abc', 'channel[$gt]=1', 'actor=12a', 'actor[$ne]=1', 'actorLogin=a.b', 'actorLogin[$regex]=x', 'from=yesterday',
        'from=2026-01-01T00:00:00Z&to=2026-06-01T00:00:00Z', `from=${encodeURIComponent(now.toISOString())}&to=${encodeURIComponent(new Date(now.getTime() - 1000).toISOString())}`,
        'cursor=not-a-cursor', `cursor=${Buffer.from('[1,2]').toString('base64url')}`, `cursor=${Buffer.from(JSON.stringify([Date.now(), 'nocolon'])).toString('base64url')}`, 'cursor[$ne]=x'];
    for (const q of bad) assert.equal(await status(`feed?${q}`), 400, `feed?${q}`);
    for (const q of ['channel=abc', 'actor[$ne]=1', 'from=2026-01-01T00:00:00Z&to=2026-06-01T00:00:00Z', 'actorLogin=a.b']) assert.equal(await status(`feed/summary?${q}`), 400, `feed/summary?${q}`);
    assert.equal(await status(`events/${encodeURIComponent('not a key')}`), 400);
    assert.equal(await status(`events/${encodeURIComponent('a:b:c:d')}`), 400);
    assert.equal(await status(`events/${encodeURIComponent(`a:b:${'c'.repeat(400)}`)}`), 400);
    assert.equal(await status(`events/${encodeURIComponent('twitch-eventsub:feed-unknown:channel.follow.received')}`), 404);
    assert.equal(await status(`events/${encodeURIComponent(FEED_EVENT_KEYS.billing)}`), 404, 'billing events are not Twitch events');

    // ---- Shape ----
    const first = await read(`feed?${qs({ ...window, limit: 5 })}`);
    assert.deepEqual(Object.keys(first).sort(), ['items', 'nextCursor', 'partial']);
    assert.deepEqual(first.partial, []);
    assert.equal(first.items.length, 5);
    assert.equal(typeof first.nextCursor, 'string');
    const itemKeys = ['actor', 'at', 'channel', 'channelID', 'credits', 'data', 'durationMs', 'id', 'kind', 'name', 'outcome', 'providerUSD', 'reason', 'ref', 'text'];
    for (const item of first.items) assert.deepEqual(Object.keys(item).sort(), itemKeys);

    // ---- Order and paging: everything, then every filter ----
    // Does the provider mock know the seed's viewer? Then a login search is an id search; otherwise the fallback.
    const probe = await read(`feed?${qs({ ...window, actorLogin: X.login, kinds: 'voice', limit: 1 })}`);
    const loginResolves = probe.partial.length === 0;
    const expectation = query => loginResolves && query.actorLogin === X.login ? { ...query, actorLogin: undefined, actor: X.id } : query;
    async function all(query, limit) {
        const ids = [];
        const items = [];
        let cursor;
        let pages = 0;
        do {
            const page = await read(`feed?${qs({ ...window, ...query, limit, cursor })}`);
            assert.ok(page.items.length <= limit);
            assert.deepEqual(page.partial, expectedPartial(expectation(query)), `partial for ${JSON.stringify(query)}`);
            for (const item of page.items) { ids.push(item.id); items.push(item); }
            cursor = page.nextCursor ?? undefined;
            assert.ok(++pages < 300, 'paging ends');
        } while (cursor);
        assert.equal(new Set(ids).size, ids.length, `no duplicates for ${JSON.stringify(query)} limit ${limit}`);
        return items.filter(item => seed.ids.has(item.id));
    }
    const expectIds = query => expectedFeed(seed, expectation(query)).map(entry => entry.id);
    for (const limit of [1, 3, 40, 100]) assert.deepEqual((await all({}, limit)).map(item => item.id), expectIds({}), `everything, limit ${limit}`);
    const tieSources = expectedFeed(seed).filter(entry => entry.at === seed.tie).map(entry => entry.id.split(':')[0]);
    assert.ok(tieSources.length >= 5, 'the seed has five stores in one millisecond');

    const cases = [
        { channel: A }, { channel: B }, { actor: X.id }, { actorLogin: X.login }, { channel: A, actor: X.id }, { channel: B, actorLogin: X.login },
        { kinds: ['protection'] }, { kinds: ['voice', 'ai', 'credits'] }, { kinds: ['twitch_event'] }, { kinds: ['twitch_event', 'alert'], channel: A },
        { kinds: ['docs'] }, { kinds: ['assistant'] }, { kinds: ['mcp'] }, { kinds: ['mcp'], outcome: 'problems' }, { kinds: ['mcp'], channel: B }, { outcome: 'problems' }, { outcome: 'failed' }, { outcome: 'problems', channel: A },
        { outcome: 'failed', actor: X.id }, { kinds: ['command'], outcome: 'problems' }, { kinds: ['voice'], channel: B }, { kinds: ['credits'] }, { kinds: ['system', 'bot_message'] },
        { actor: X.id, kinds: ['twitch_event'] }, { actorLogin: X.login, outcome: 'problems' }, { actorLogin: X.login, kinds: ['voice', 'command'] }, { actorLogin: FEED_UNKNOWN_LOGIN }
    ];
    for (const query of cases) assert.deepEqual((await all(query, 2)).map(item => item.id), expectIds(query), JSON.stringify(query));

    // Everything from this viewer, no channel: Twitch events from three payload fields, usage and decisions, in both channels.
    const viewer = await all({ actor: X.id }, 3);
    const seen = new Set(viewer.map(item => `${item.kind}:${item.channelID}`));
    for (const want of [`twitch_event:${A}`, `twitch_event:${B}`, `voice:${A}`, `ai:${B}`, `protection:${A}`, `protection:${B}`, `command:${A}`, `voice:${B}`]) assert.ok(seen.has(want), `viewer search finds ${want}`);
    assert.deepEqual(viewer.filter(item => item.id.startsWith('event:')).map(item => item.ref.id).sort(),
        [FEED_EVENT_KEYS.bits, FEED_EVENT_KEYS.follow, FEED_EVENT_KEYS.resub, FEED_EVENT_KEYS.viewerRaid].sort(), 'by user_id, chatter_user_id and from_broadcaster_user_id; never a billing event');
    const unknown = await read(`feed?${qs({ ...window, actorLogin: FEED_UNKNOWN_LOGIN })}`);
    assert.deepEqual(unknown.partial, ['twitch_event', 'protection', 'voice', 'ai', 'assistant', 'mcp', 'credits'], 'an unresolvable login names every store it could not search');
    // AI app calls: tool, app, outcome code and the message the app got; never the session id.
    const mcpRows = await all({ kinds: ['mcp'] }, 40);
    for (const expected of expectedFeed(seed, { kinds: ['mcp'] })) {
        const row = mcpRows.find(item => item.id === expected.id);
        assert.ok(row, `${expected.id} listed`);
        assert.equal(row.text, expected.text, 'the refusal message the app got');
        assert.equal(row.reason, expected.reason ?? null);
        assert.equal(row.data.app, 'Claude');
    }
    assert.equal(JSON.stringify(mcpRows).includes('SECRET-session'), false, 'no session ids');

    // ---- Row facts ----
    const items = await all({ channel: A }, 100);
    const byId = new Map(items.map(item => [item.id, item]));
    for (const item of items) {
        assert.equal(item.channel, FEED_LOGINS.alpha, `${item.id} channel login`);
        assert.ok(item.text === null || item.text.length <= 300);
    }
    const follow = items.find(item => item.kind === 'twitch_event' && item.ref?.id === FEED_EVENT_KEYS.follow);
    assert.equal(follow.name, 'channel.follow');
    assert.deepEqual(follow.actor, { id: X.id, login: X.login, name: X.name });
    assert.equal(follow.data.failedDeliveries, 1);
    assert.deepEqual(items.find(item => item.kind === 'alert').ref, { type: 'event', id: FEED_EVENT_KEYS.follow });
    assert.equal(items.find(item => item.name === 'stream.online').data.test, true);
    const ban = items.find(item => item.kind === 'protection' && item.outcome === 'ok' && item.data.action === 'ban');
    assert.deepEqual([ban.data.model, ban.data.included, ban.data.ruleType, ban.credits, ban.providerUSD], ['openai/gpt-6-luna-decisions', true, 'builtin', 0, 0.00021]);
    assert.ok(items.some(item => item.kind === 'protection' && item.reason === 'action_failed'));
    assert.equal(items.filter(item => item.kind === 'ai').length, 0, 'the chat protection receipt is not shown twice');
    const grant = items.find(item => item.kind === 'credits');
    assert.deepEqual([grant.name, grant.credits], ['manual_grant', -800000]);
    for (const expected of expectedFeed(seed, { kinds: ['assistant'] })) {
        const turn = (await all({ kinds: ['assistant'] }, 40)).find(item => item.id === expected.id);
        assert.equal(turn.text, expected.text, 'assistant rows carry the question preview');
        assert.equal(/answer|steer|tool-args|tool-result/i.test(JSON.stringify({ ...turn, data: { ...turn.data, tools: '' } })), false, 'never the answer or tool data');
    }
    const docs = (await all({ kinds: ['docs'] }, 40));
    assert.deepEqual(docs.map(item => [item.text, item.data.page, item.outcome, item.reason]), [
        ['How do I add a command?', '/en/commands/', 'ok', null], ['¿Por qué mi timer no habla?', '/es/timers/', 'failed', 'timeout'], ['What is a timer?', '/en/commands/', 'ok', null]
    ]);
    // A failed docs question is a problem: `outcome=failed` returns it, with no provider cost.
    const failedDocs = await all({ kinds: ['docs'], outcome: 'failed' }, 1);
    assert.deepEqual(failedDocs.map(item => [item.id, item.outcome, item.reason, item.providerUSD]), [[`docs:${FEED_DOCS_IDS.failed}`, 'failed', 'timeout', null]]);
    assert.deepEqual((await all({ kinds: ['docs'], outcome: 'problems' }, 1)).map(item => item.id), [`docs:${FEED_DOCS_IDS.failed}`]);
    assert.ok(byId.size > 0);

    // ---- Summary ----
    for (const query of [{ channel: A }, { channel: B }, { actor: X.id }, { channel: A, actor: X.id }, { channel: B, actorLogin: X.login }, { actorLogin: X.login }, { actorLogin: FEED_UNKNOWN_LOGIN }]) {
        const summary = await read(`feed/summary?${qs({ ...window, ...query, kinds: 'docs', outcome: 'failed' })}`);
        assert.deepEqual(Object.keys(summary).sort(), ['from', 'kinds', 'partial', 'to']);
        assert.deepEqual(summary.partial, expectedPartial(expectation(query)), `summary partial ${JSON.stringify(query)}`);
        assert.equal(summary.kinds.length, 12);
        const expected = expectedCounts(seed, expectation(query));
        for (const row of summary.kinds) {
            assert.deepEqual({ total: row.total, problems: row.problems, failed: row.failed }, expected[row.kind] || { total: 0, problems: 0, failed: 0 }, `${JSON.stringify(query)} ${row.kind}`);
        }
    }
    const everything = await read(`feed/summary?${qs(window)}`);
    const everythingExpected = expectedCounts(seed, {});
    for (const row of everything.kinds) {
        const seeded = everythingExpected[row.kind] || { total: 0, problems: 0, failed: 0 };
        assert.ok(row.total >= seeded.total && row.problems >= seeded.problems && row.failed >= seeded.failed, `summary ${row.kind} counts the seed`);
    }
    const docsCount = everything.kinds.find(row => row.kind === 'docs');
    assert.ok(docsCount.failed >= 1 && docsCount.problems >= docsCount.failed, 'the failed docs question counts as failed and as a problem');

    // ---- Event detail ----
    const detail = await read(eventPath);
    assert.deepEqual(Object.keys(detail).sort(), ['actor', 'channel', 'channelID', 'deliveries', 'eventKey', 'journaledAt', 'occurredAt', 'payload', 'source', 'steps', 'test', 'traceId', 'twitchType', 'type']);
    assert.deepEqual([detail.eventKey, detail.type, detail.twitchType, detail.channel, detail.test], [FEED_EVENT_KEYS.follow, 'channel.follow.received', 'channel.follow', FEED_LOGINS.alpha, false]);
    assert.deepEqual(detail.deliveries.map(row => [row.consumer, row.status, row.reason]), [
        ['stream-timeline-v1', 'succeeded', null],
        ['stream-analytics-v1', 'dead', 'handler_failed: MongoServerError: connect ECONNREFUSED [address]'],
        ['chat-announcements-v1', 'skipped', 'event_too_old']
    ]);
    const stream = await read(`events/${encodeURIComponent(FEED_EVENT_KEYS.stream)}`);
    assert.equal(stream.test, true);
    assert.equal(stream.traceId, 'feedtrace0001');
    assert.deepEqual(stream.steps.map(step => [step.step, step.status, step.reason]), [['timers', 'completed', null], ['editors', 'failed', 'Twitch said 401 at [address]']]);
    const keys = [];
    const walk = value => { if (value && typeof value === 'object') for (const [key, inner] of Object.entries(value)) { keys.push(key); walk(inner); } };
    walk(stream.payload);
    assert.equal(keys.some(key => /token|secret|signature|email|password/i.test(key)), false, `payload keys: ${keys.join(',')}`);
    assert.equal(stream.payload.broadcaster_user_id, A);
    assert.equal(stream.payload.nested.note, 'retry with Bearer [redacted] later', 'a secret inside a sentence comes back masked');
    assert.equal(JSON.stringify(stream).includes(FEED_SENTENCE_SECRET), false);

    console.log(`PASS admin feed API: ${expectedFeed(seed).length} seeded rows across 6 stores in order (pages of 1–100), ${cases.length} filters, viewer across channels, login ${loginResolves ? 'resolved by Helix' : 'unresolved: fallback with partial'}, summaries, event detail, ${bad.length} bad inputs refused, no secrets`);
} finally {
    await seed.cleanup().catch(() => null);
    await redis.del(['token:feed-owner', 'token:feed-streamer']).catch(() => null);
    await Promise.allSettled([mongo.disconnect(), redis.quit()]);
}
process.exit(0);
