// API target only: saas-ops verify api-<id> --dependency mongo --dependency redis \
//   --test-env ops/checks/admin-console-fixtures/test-env.json --fixtures ops/checks/admin-console-fixtures --check ops/checks/admin-console-usage-api.mjs
// The owner's cross-channel AI usage API (`/admin-site/usage/summary`, `/admin-site/usage/transactions`): owner-only
// access, strict input (no operator injection, bounded window, bad cursors), every total and breakdown against
// hand-computed fixtures, filters, both sorts with cursor paging (ties, no gaps or duplicates, the 500-row cap for
// the credits sort), expired receipts never shown, and no Polar customer id or other secret in any response.
// APP_DIST / USAGE_FIXTURES / USAGE_API override the compiled app, fixtures folder and API base for a local run.
import assert from 'node:assert/strict';
const APP_DIST = process.env.APP_DIST || '/app/dist';
const FIXTURES = process.env.USAGE_FIXTURES || '/tmp/saas-fixtures';
const BASE = process.env.USAGE_API || 'http://127.0.0.1:3000';
const { getMongoDBConnection } = await import(`${APP_DIST}/utils/databases/mongodb.database.js`);
const { getDragonflyClient } = await import(`${APP_DIST}/utils/databases/dragonfly.database.js`);
const { seedUsage } = await import(`${FIXTURES}/seed-usage.mjs`);

const mongo = await getMongoDBConnection('admin-console-usage-check');
const redis = await getDragonflyClient('admin-console-usage-check');
const db = mongo.connection.db;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 150; i++) { try { if (await fn()) return; } catch { /* not listening yet */ } await sleep(200); } throw new Error(`Timeout: ${label}`); }

await redis.hSet('token:usage-owner', { id: '533538623', login: 'cdom201', display_name: 'CDOM201' });
await redis.hSet('token:usage-streamer', { id: '700000001', login: 'some_streamer', display_name: 'Some Streamer' });
const now = new Date();
const seed = await seedUsage(db, now);
const E = seed.expected;
const C = seed.channels;
// Another check in the same run may seed receipts too; then only channel- and chatter-scoped numbers are exact.
const foreign = await db.collection('ai_usage_receipts').countDocuments({ channelID: { $nin: seed.seedChannelIds } });
const exact = foreign === 0;

const get = (path, token = 'usage-owner') => fetch(`${BASE}/admin-site/usage/${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const read = async (path) => {
    const res = await get(path);
    const text = await res.text();
    assert.equal(res.status, 200, `${path}: ${text.slice(0, 200)}`);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    for (const secret of ['SECRET', 'customerId', 'requestId', 'resourceId', 'expiresAt', 'retentionTier']) {
        assert.equal(text.includes(secret), false, `${path} leaks ${secret}`);
    }
    const body = JSON.parse(text);
    assert.equal(body.error, false);
    return body.data;
};
const qs = query => new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])).toString();
// The seed's own instant, so the day list cannot shift if the check crosses UTC midnight.
const window = { from: new Date(now.getTime() - 7 * 86_400_000).toISOString(), to: now.toISOString() };

await until(async () => (await get('summary')).status === 200, 'API ready');

// ---- Access and input ----
for (const path of ['summary', 'transactions']) {
    assert.equal((await get(path, null)).status, 401, `${path} without a token`);
    assert.equal((await get(path, 'usage-streamer')).status, 403, `${path} for a streamer`);
}
const badCommon = ['category[$ne]=tts', 'category=tts&category=memory', 'category=credit_adjustment', 'channel=abc', 'channel[$gt]=1', 'actor=12a',
    'provider[$regex]=fi', 'model=.*', 'source=a%20b%3B%24x', 'from=yesterday', 'from=2026-01-01T00:00:00Z&to=2026-06-01T00:00:00Z',
    `from=${encodeURIComponent(now.toISOString())}&to=${encodeURIComponent(new Date(now.getTime() - 1000).toISOString())}`];
for (const q of badCommon) {
    for (const path of ['summary', 'transactions']) {
        const res = await get(`${path}?${q}`);
        assert.equal(res.status, 400, `${path}?${q}`);
        const body = await res.json();
        assert.equal(body.error, true);
    }
}
const timeCursor = Buffer.from(JSON.stringify([now.getTime(), 'usage-seed-01'])).toString('base64url');
const skipCursor = Buffer.from(JSON.stringify(['credits', 40])).toString('base64url');
for (const q of ['limit=0', 'limit=101', 'limit=abc', 'sort=oldest', 'entryKind=other', 'entryKind[$ne]=usage', 'cursor=not-a-cursor',
    `cursor=${Buffer.from('{"$gt":""}').toString('base64url')}`, `cursor=${skipCursor}`, `sort=credits&cursor=${timeCursor}`,
    `sort=credits&cursor=${Buffer.from(JSON.stringify(['credits', 500])).toString('base64url')}`]) {
    assert.equal((await get(`transactions?${q}`)).status, 400, `transactions?${q}`);
}

// ---- Summary ----
const summary = await read(`summary?${qs(window)}`);
assert.deepEqual(Object.keys(summary).sort(), ['byActor', 'byCategory', 'byChannel', 'byModel', 'bySource', 'daily', 'from', 'granted', 'to', 'totals']);
assert.equal(summary.from, window.from);
assert.equal(summary.to, window.to);
assert.deepEqual(summary.daily, seed.dailyFor(new Date(window.from)));
const mine = summary.byChannel.filter(row => seed.seedChannelIds.includes(row.channelID));
assert.deepEqual(mine, E.byChannel);
assert.deepEqual(summary.byActor.filter(row => row.actor.id?.startsWith('72000000')), E.byActor);
if (exact) {
    assert.deepEqual(summary.totals, E.totals);
    assert.equal(summary.granted, E.granted);
    for (const key of ['byCategory', 'byModel', 'bySource', 'byChannel', 'byActor']) assert.deepEqual(summary[key], E[key], key);
    assert.deepEqual((await read('summary')).totals, E.totals, 'default window');
}
for (const [query, count, credits] of E.filters) {
    if (!exact && !query.channel && !query.actor) continue;
    const scoped = await read(`summary?${qs({ ...window, ...query })}`);
    assert.deepEqual([scoped.totals.count, scoped.totals.credits], [count, credits], qs(query));
}
const thirtyFrom = new Date(now.getTime() - 30 * 86_400_000).toISOString();
for (const [query, count, credits, granted] of E.thirtyDays) {
    const scoped = await read(`summary?${qs({ ...query, from: thirtyFrom, to: window.to })}`);
    assert.deepEqual([scoped.totals.count, scoped.totals.credits, scoped.granted], [count, credits, granted], `30 days ${qs(query)}`);
    assert.equal(scoped.daily.length, 31);
}
const ninety = await read(`summary?${qs({ channel: C.alpha.id, from: new Date(now.getTime() - 90 * 86_400_000).toISOString(), to: window.to })}`);
assert.equal(ninety.daily.length, 91);

// ---- Transactions ----
const ITEM_KEYS = ['actor', 'adjustmentType', 'at', 'category', 'channel', 'channelID', 'credits', 'entryKind', 'id', 'model', 'operation', 'provider',
    'providerUSD', 'quantity', 'source', 'unit', 'voice'];
async function walk(query) {
    const ids = []; let cursor = null; let pages = 0;
    do {
        const page = await read(`transactions?${qs({ ...query, cursor })}`);
        assert.deepEqual(Object.keys(page).sort(), ['items', 'nextCursor']);
        for (const item of page.items) assert.deepEqual(Object.keys(item).sort(), ITEM_KEYS);
        ids.push(...page.items.map(item => item.id)); cursor = page.nextCursor; pages++;
    } while (cursor && pages < 200);
    return { ids, pages };
}
const alphaIds = ['usage-seed-01', 'usage-seed-02', 'usage-tie-a', 'usage-seed-03', 'usage-seed-04'];
const alpha = await read(`transactions?${qs({ ...window, channel: C.alpha.id })}`);
assert.deepEqual(alpha.items.map(item => item.id), alphaIds);
assert.equal(alpha.nextCursor, null);
const [first, second] = alpha.items;
assert.deepEqual(first, { id: 'usage-seed-01', at: first.at, channelID: C.alpha.id, channel: C.alpha.login, entryKind: 'usage', category: 'tts', operation: 'synthesize',
    source: 'ast', adjustmentType: null, provider: 'fish', model: null, voice: 'voice-a', quantity: 100, unit: 'characters', credits: 150, providerUSD: 0.002,
    actor: { id: '7200000001', login: 'viewer_one', name: 'Viewer_One' } });
assert.deepEqual([second.actor, second.providerUSD, second.voice], [null, null, null], 'missing new fields read as null');
const delta = await read(`transactions?${qs({ ...window, channel: C.delta.id })}`);
assert.deepEqual(delta.items.map(item => [item.id, item.channel, item.actor]), [['usage-seed-09', null, { id: '7200000003', login: 'viewer_three', name: null }]]);
assert.deepEqual((await walk({ ...window, channel: C.alpha.id, limit: 2 })).ids, alphaIds);
assert.deepEqual((await read(`transactions?${qs({ ...window, actor: '7200000002' })}`)).items.map(item => item.id), ['usage-seed-03', 'usage-seed-04']);
assert.deepEqual((await read(`transactions?${qs({ ...window, channel: C.beta.id, source: 'ast' })}`)).items.map(item => item.id), ['usage-tie-b']);
const gammaAll = await read(`transactions?${qs({ ...window, channel: C.gamma.id, entryKind: 'all' })}`);
assert.deepEqual(gammaAll.items.map(item => item.id), ['usage-seed-15', 'usage-seed-07', 'usage-seed-08'], 'expired receipt never listed');
assert.deepEqual(gammaAll.items[0], { ...gammaAll.items[0], entryKind: 'adjustment', category: 'credit_adjustment', adjustmentType: 'monthly_reset', credits: -25000, actor: null });
for (const sort of ['newest', 'credits']) {
    for (const kind of ['usage', 'adjustment', 'all']) {
        const { ids } = await walk({ from: thirtyFrom, to: window.to, channel: C.gamma.id, sort, entryKind: kind, limit: 1 });
        assert.equal(ids.includes('usage-expired'), false, `expired row hidden (${sort}, ${kind})`);
    }
}
if (exact) {
    assert.deepEqual((await read(`transactions?${qs(window)}`)).items.map(item => item.id), E.newestIds);
    assert.deepEqual((await walk({ ...window, limit: 3 })).ids, E.newestIds);
    assert.deepEqual((await walk({ ...window, sort: 'credits', limit: 3 })).ids, E.creditsIds);
    assert.deepEqual((await read(`transactions?${qs({ ...window, entryKind: 'adjustment' })}`)).items.map(item => item.id), E.adjustmentIds);
}
// Bulk channel: 520 rows in pairs that share an instant.
const bulk = { channel: seed.bulk.channel, from: seed.bulk.from.toISOString(), to: seed.bulk.to.toISOString() };
const expectedNewest = Array.from({ length: seed.bulk.rows }, (_, i) => `usage-bulk-${String(i).padStart(4, '0')}`).reverse();
for (const limit of [100, 7]) assert.deepEqual((await walk({ ...bulk, limit })).ids, expectedNewest, `newest paging, limit ${limit}`);
const credits = await walk({ ...bulk, sort: 'credits', limit: 100 });
assert.equal(credits.ids.length, 500, 'the credits sort stops at 500 rows');
assert.equal(new Set(credits.ids).size, 500);
assert.equal(credits.pages, 5);
const top = await read(`transactions?${qs({ ...bulk, sort: 'credits', limit: 100 })}`);
assert.ok(top.items.every((item, i, rows) => !i || rows[i - 1].credits >= item.credits), 'most expensive first');
assert.equal(top.items[0].credits, 7);

console.log(`PASS admin console usage API: access, input, summary${exact ? ' (exact)' : ` (channel-scoped; ${foreign} foreign receipts)`}, filters, paging, retention, no leaks`);
await Promise.allSettled([mongo.disconnect(), redis.quit()]);
process.exit(0);
