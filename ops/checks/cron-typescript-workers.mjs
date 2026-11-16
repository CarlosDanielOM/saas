// Behavior check for the seven cron workers that run as TypeScript again (they were Rust
// binaries from 2026-10-21 to 2026-11-12): stream-activity, dashboard-activity, raid-analytics,
// roulette-completion, follow-defense-baseline, raid-sessions and ai-usage-receipts.
//
// It runs inside a cron candidate started by the real supervisor against disposable databases:
//
//   scripts/saas-ops verify cron-<run-id> --check ops/checks/cron-typescript-workers.mjs \
//     --dependency mongo --dependency redis \
//     --test-env ops/checks/cron-typescript-workers-fixtures/test-env.json \
//     --fixtures ops/checks/cron-typescript-workers-fixtures
//
// Each worker gets seeded work and must finish it the way production expects: the data it
// writes, the pacing it keeps under a backlog, the health numbers it reports, and recovery
// after a crash. Nothing here talks to production or to a provider.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const app = process.env.SAAS_APP_ROOT || '/app';
const supervisorPid = Number(process.env.SAAS_SUPERVISOR_PID || 1);
const load = file => import(`${app}/dist/${file}`);
const uri = new URL(process.env.MONGO_URI || '');
assert.match(decodeURIComponent(uri.pathname.slice(1)), /^cron_ts_workers_fixture[a-z0-9_]*$/, 'disposable fixture database only');
assert(['mongo', '127.0.0.1'].includes(uri.hostname) && ['redis', '127.0.0.1'].includes(process.env.DRAGONFLY_HOST), 'disposable dependencies only');

const WORKERS = { 'dashboard-activity': 'dashboard_activity', 'raid-analytics': 'raid_analytics', 'stream-activity': 'stream_activity',
    'roulette-completion': 'roulette_completion', 'follow-defense-baseline': 'follow_defense_baseline',
    'raid-sessions': 'raid_sessions', 'ai-usage-receipts': 'ai_usage_receipts' };
const started = Date.now();
const passed = [];
const group = async (name, run) => { const at = Date.now(); await run(); passed.push(name); console.log(`ok ${passed.length} - ${name} (${Date.now() - at} ms)`); };
async function until(check, label, timeout = 30000, interval = 50) {
    const end = Date.now() + timeout;
    for (;;) {
        const value = await check();
        if (value) return value;
        if (Date.now() >= end) throw new Error(`Timed out: ${label}`);
        await sleep(interval);
    }
}

// ---------------------------------------------------------------- process tree
function children() {
    const rows = [];
    for (const entry of readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        try {
            const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
            const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
            if (Number(fields[1]) !== supervisorPid || fields[0] === 'Z') continue;
            const args = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').filter(Boolean);
            const file = /\/([a-z_-]+)\.worker\.(js|ts)$/.exec(args.find(arg => /\.worker\.(js|ts)$/.test(arg)) || '')?.[1];
            rows.push({ pid: Number(entry), args, file, startTicks: fields[19] });
        } catch { /* The process ended while it was being read. */ }
    }
    return rows;
}
const workerProcess = file => children().find(row => row.file === file);

const { getMongoDBConnection } = await load('utils/databases/mongodb.database.js');
const { getDragonflyClient } = await load('utils/databases/dragonfly.database.js');
const mongo = await getMongoDBConnection('cron-typescript-workers-check');
const redis = await getDragonflyClient('cron-typescript-workers-check');
const db = mongo.connection.db;
const day = 86400000, now = () => Date.now();

await group('supervisor runs exactly the seven workers as Node processes and nothing native ships', async () => {
    const live = await until(() => { const rows = children().filter(row => row.file); return rows.length === 7 ? rows : null; }, 'seven worker processes');
    assert.deepEqual(live.map(row => row.file).sort(), Object.values(WORKERS).sort());
    for (const row of live) assert.match(row.args[0], /(^|\/)node$/, `${row.file} runs under Node`);
    for (const binary of ['cron_index', 'stream_activity', 'raid_analytics', 'follow_defense_baseline', 'roulette_completion',
        'ai_usage_receipts', 'raid_sessions', 'dashboard_activity']) assert(!existsSync(`/usr/local/bin/${binary}`), `${binary} must not ship`);
    for (const stale of ['workers/cron_native_bridge.js', 'utils/observability/native_worker_metrics.js', 'workers/roulette.worker.js']) {
        assert(!existsSync(`${app}/dist/${stale}`), `${stale} must not ship`);
    }
    const { WORKERS: registered } = await load('workers/cron.index.js');
    assert.equal(registered.length, 27);
    for (const [name, file] of Object.entries(WORKERS)) {
        assert.equal(registered.find(worker => worker.name === name)?.distEntry, `dist/workers/${file}.worker.js`);
        assert(existsSync(`${app}/dist/workers/${file}.worker.js`));
    }
});

// ---------------------------------------------------------------- stream + dashboard activity
const channel = '900000001';
const activities = db.collection('stream_activities');
await group('stream activity projects a batch into fenced aggregates and advances its checkpoint', async () => {
    const { Types } = await import(`${app}/node_modules/mongoose/index.js`).then(module => module.default ?? module);
    const session = new Types.ObjectId(), at = new Date(now() - 60000);
    const row = (id, kind, actor, extra = {}) => ({ _id: `fixture-${id}`, channelID: channel, session_id: session, occurredAt: new Date(+at + id), offset: 10,
        kind, actor, actorLabel: actor, key: '', label: '', value: 1, outcome: 'ok', emotes: [], processed: false, dashboardProcessed: null,
        expiresAt: new Date(now() + day), ...extra });
    await redis.set(`twitch:${channel}:emote-catalog:v1`, JSON.stringify({ emotes: [{ id: '25', name: 'Kappa' }], checkedAt: new Date().toISOString(), retryAt: now() + 3600000 }), { EX: 600 });
    await activities.insertMany([
        row(1, 'message', 'viewer-a', { emotes: [{ key: 'twitch:25', label: 'Kappa', count: 2 }] }),
        row(2, 'message', 'viewer-b'), row(3, 'message', 'viewer-a'),
        row(4, 'command', 'viewer-b', { key: '!hello', label: '!hello' }),
        row(5, 'follow', 'viewer-c'),
    ]);
    await until(async () => await activities.countDocuments({ channelID: channel, processed: true }) === 5, 'stream activity processed');
    const aggregates = db.collection('stream_activity_aggregates');
    const summary = await until(() => aggregates.findOne({ channelID: channel, scope: 'summary' }), 'stream summary aggregate');
    assert.deepEqual([summary.messages, summary.commands, summary.emotes, summary.emoteMessages, summary.follows], [3, 1, 2, 1, 1]);
    const chart = await aggregates.findOne({ channelID: channel, scope: 'chart', bucket: 0 });
    assert.equal(chart.chatters, 2, 'two distinct chatters counted once each');
    assert.equal((await aggregates.findOne({ channelID: channel, scope: 'rank', kind: 'command', key: '!hello' })).count, 1);
    const state = await until(async () => { const row = await db.collection('stream_activity_states').findOne({ _id: 'projector-v1' }); return row?.seq >= 1 && !row.active?.ids?.length && row; }, 'stream checkpoint');
    assert.equal(+state.leaseUntil, 0, 'lease released after the batch');
    // A replayed batch must not count twice: reopen the same rows under the same sequence.
    const before = summary.messages;
    await db.collection('stream_activity_states').updateOne({ _id: 'projector-v1', leaseUntil: new Date(0) }, { $set: { active: { seq: state.seq, ids: ['fixture-1', 'fixture-2'] } } });
    await until(async () => !(await db.collection('stream_activity_states').findOne({ _id: 'projector-v1' })).active?.ids?.length, 'replayed batch completed');
    assert.equal((await aggregates.findOne({ channelID: channel, scope: 'summary' })).messages, before);
});

await group('dashboard activity builds daily ranks, a channel summary and insights from the same events', async () => {
    await until(async () => await activities.countDocuments({ channelID: channel, kind: { $in: ['command', 'message'] }, dashboardProcessed: true }) === 4, 'dashboard projection');
    const dailies = db.collection('dashboard_activity_dailies');
    assert.equal((await dailies.findOne({ channelID: channel, kind: 'command', key: '!hello' })).count, 1);
    assert.equal((await dailies.findOne({ channelID: channel, kind: 'emote', key: 'twitch:25' })).count, 2);
    assert.equal((await dailies.findOne({ channelID: channel, kind: 'coverage' })).count, 4);
    const summary = await until(async () => { const row = await db.collection('dashboard_activity_summaries').findOne({ _id: channel }); return row?.payload && row; }, 'dashboard summary');
    assert.equal(summary.error, false);
    assert.deepEqual(summary.payload['7'].commands.map(item => [item.key, item.count]), [['!hello', 1]]);
    assert.deepEqual(summary.payload['30'].streamerEmotes.map(item => [item.key, item.count]), [['twitch:25', 2]]);
    assert.equal(summary.payload['7'].emoteCatalog.status, 'ready');
    assert.equal(+summary.leaseUntil, 0);
    await db.collection('dashboard_insights').insertOne({ _id: channel, nextRefreshAt: new Date(0), leaseUntil: new Date(0), expiresAt: new Date(now() + day) });
    const insights = await until(async () => { const row = await db.collection('dashboard_insights').findOne({ _id: channel }); return row?.payload && row; }, 'dashboard insights');
    assert.deepEqual(Object.keys(insights.payload).sort(), ['30:exclude', '30:include', '7:exclude', '7:include']);
    assert(+insights.nextRefreshAt > now() + 200000, 'insights rescheduled five minutes out');
});

// ---------------------------------------------------------------- roulette completion
await group('roulette completion settles 205 due channels back to back instead of one batch per second', async () => {
    const { emptyState } = await load('roulette/model.js');
    const channels = db.collection('roulette_channels');
    const hideAt = now() - 1000;
    await channels.insertMany(Array.from({ length: 205 }, (_, index) => ({ _id: `81${String(index).padStart(4, '0')}`, revision: 3,
        state: { ...emptyState(), visible: true, hideAt }, tokenHash: null, dueAt: hideAt, receipts: [], actions: [], actionDueAt: null })));
    // A deadline in the future and a stale deadline that cannot settle must both be left alone.
    await channels.insertMany([
        { _id: '820001', revision: 1, state: { ...emptyState(), visible: true, hideAt: now() + 600000 }, tokenHash: null, dueAt: now() + 600000, receipts: [], actions: [], actionDueAt: null },
    ]);
    const settledCount = () => channels.countDocuments({ _id: /^81/, dueAt: null });
    await until(async () => await settledCount() > 0, 'first roulette settlement', 15000, 10);
    const first = now();
    await until(async () => await settledCount() === 205, 'all roulette settlements', 15000, 10);
    const drain = now() - first;
    // Three bounded passes (100/100/5). With a one-second wait between passes this took over two seconds.
    assert(drain < 1900, `roulette backlog drained in ${drain} ms`);
    const row = await channels.findOne({ _id: '810000' });
    assert.deepEqual([row.revision, row.state.visible, row.state.hideAt, row.dueAt], [4, false, null, null]);
    assert.equal((await channels.findOne({ _id: '820001' })).revision, 1);
});

// ---------------------------------------------------------------- follow-defense baseline
await group('follow-defense baseline drains eight due channels, pauses, then finishes the rest', async () => {
    const due = 'follow:defense:baseline:due', ids = Array.from({ length: 10 }, (_, index) => `83000${index}`);
    await redis.zAdd(due, ids.map((value, index) => ({ value, score: now() - 5000 + index })));
    const seen = new Map();
    await until(async () => {
        for (const id of ids) if (!seen.has(id) && await redis.exists(`follow:defense:baseline:${id}`)) seen.set(id, now());
        return seen.size === ids.length;
    }, 'ten baselines', 30000, 10);
    const times = [...seen.values()].sort((a, b) => a - b);
    assert(times[7] - times[0] < 1500, `first eight refreshed in one burst (${times[7] - times[0]} ms)`);
    assert(times[8] - times[7] >= 800, `one-second pause after the eighth (${times[8] - times[7]} ms)`);
    const baseline = JSON.parse(await redis.get(`follow:defense:baseline:${ids[0]}`));
    assert.deepEqual(Object.keys(baseline).sort(), ['attackThreshold', 'averageDaily', 'averageStream', 'calculatedAt', 'excludedDays', 'sampleDays', 'streamCount']);
    assert.equal(baseline.attackThreshold, null, 'no history means no threshold, never a low fixed one');
    assert(await redis.ttl(`follow:defense:baseline:${ids[0]}`) > 6 * 86400);
    for (const row of await redis.zRangeWithScores(due, 0, -1)) assert(row.score > now() + 3500000, 'rescheduled one hour out');
});

// ---------------------------------------------------------------- raid sessions
await group('raid sessions widens retention to 72 hours and closes an empty backfill', async () => {
    const sessions = db.collection('raid_sessions'), startedAt = new Date(now() - 3600000);
    await sessions.insertOne({ _id: 'fixture-raid-session', channelID: channel, eventID: 'fixture-raid', raiderID: '900000002', raiderLogin: 'raider', raiderName: 'Raider',
        viewers: 50, startedAt, endedAt: null, captureUntil: new Date(now() - 1800000), retentionHours: 24, expiresAt: new Date(+startedAt + day),
        purgeAt: new Date(+startedAt + day + 3600000), backfillUntil: new Date(now() - 1800000), backfillCursor: '', backfillDone: false, manualRequestID: '' });
    const session = await until(async () => { const row = await sessions.findOne({ _id: 'fixture-raid-session' }); return row.retentionHours === 72 && row.backfillDone && row; }, 'raid session maintenance');
    assert.equal(+session.expiresAt, +startedAt + 72 * 3600000);
    assert.equal(+session.purgeAt, +startedAt + 73 * 3600000);
});

// ---------------------------------------------------------------- AI usage receipts
await group('AI usage receipts drains a backlog of full batches without waiting, and dead-letters an invalid job', async () => {
    assert.equal(process.env.AI_USAGE_RECEIPTS_BATCH_SIZE, '2');
    const queue = 'cron:ai-usage-receipts:queue', customer = randomUUID(), usage = '900000003';
    const receipt = index => JSON.stringify({ channelID: usage, customerId: customer, id: `fixture-${index}`, requestId: null, occurredAt: new Date(now() - 1000).toISOString(),
        entryKind: 'usage', category: 'chat', operation: 'usage', provider: 'fixture', model: 'fixture-model', quantity: 10, unit: 'tokens', credits: 3 });
    await redis.rPush(queue, Array.from({ length: 7 }, (_, index) => receipt(index)));
    const receipts = db.collection('ai_usage_receipts');
    await until(async () => await receipts.countDocuments({ channelID: usage }) > 0, 'first receipt', 15000, 10);
    const first = now();
    await until(async () => await receipts.countDocuments({ channelID: usage }) === 7, 'all receipts', 15000, 10);
    // Batches of 2/2/2/1: the three full ones continue at once. Waiting the interval each time took three seconds.
    assert(now() - first < 1900, `receipt backlog drained in ${now() - first} ms`);
    await until(async () => await redis.lLen(queue) === 0 && await redis.lLen('cron:ai-usage-receipts:processing') === 0, 'receipt queues empty');
    assert.equal(await redis.get(`twitch:${usage}:ai:usage-receipts:generation`), '7');
    assert.equal((await receipts.findOne({ channelID: usage, entryId: 'fixture-0' })).retentionTier, 'free');
    assert.equal(await db.collection('ai_usage_dailies').countDocuments({ channelID: usage }) > 0, true, 'daily aggregate rebuilt');
    await redis.rPush(queue, 'not-a-receipt');
    await until(async () => await redis.lLen('cron:ai-usage-receipts:queue:dead') === 1, 'invalid receipt dead-lettered');
    assert.equal(await redis.lLen(queue), 0);
    // A duplicate delivery never writes a second receipt.
    await redis.rPush(queue, receipt(0));
    await until(async () => await redis.get(`twitch:${usage}:ai:usage-receipts:generation`) === '8', 'duplicate acknowledged');
    assert.equal(await receipts.countDocuments({ channelID: usage }), 7);
});

// ---------------------------------------------------------------- raid analytics
await group('raid analytics publishes a summary once and leaves it untouched until its source changes', async () => {
    const { queueRaidSummary } = await load('utils/raid_analytics.js');
    const histories = db.collection('raid_analytics_histories'), summaries = db.collection('raid_analytics_summaries');
    const raid = (id, direction, peer, minutesAgo, viewers) => ({ _id: createHash('sha256').update(`${channel}:${id}`).digest('hex'), channelID: channel, direction,
        peerID: peer, peerLogin: `peer${peer}`, peerName: `Peer${peer}`, viewers, occurredAt: new Date(now() - minutesAgo * 60000),
        followsAfter: null, followsComputedAt: null, expiresAt: new Date(now() + 30 * day) });
    await histories.insertMany([raid('a', 'incoming', '1001', 600, 40), raid('b', 'incoming', '1002', 480, 25), raid('c', 'outgoing', '1001', 300, 60)]);
    await queueRaidSummary(channel);
    const published = await until(async () => { const row = await summaries.findOne({ _id: channel }); return row?.payload && +row.leaseUntil === 0 && row; }, 'raid summary');
    const totals = period => Object.fromEntries(published.payload[period].totals.map(row => [row._id, row.raids]));
    assert.deepEqual([totals('7'), totals('30')], [{ incoming: 2, outgoing: 1 }, { incoming: 2, outgoing: 1 }]);
    assert.equal(published.error, false);
    assert.equal(published.payload['7'].incoming.find(row => row.peerID === '1001').lastOutgoingAt instanceof Date, true, 'reciprocity attached');
    const fingerprint = row => JSON.stringify([row.payload, +row.updatedAt]);
    globalThis.raidCheckpoint = { at: now(), value: fingerprint(published), summaries, fingerprint, histories, raid, queueRaidSummary };
});

// ---------------------------------------------------------------- telemetry
const inbox = new Map();
async function collectTelemetry() {
    for (const raw of await redis.lRange('observability:v1:inbox', 0, -1)) {
        const batch = JSON.parse(raw);
        if (!inbox.has(batch.id)) inbox.set(batch.id, batch);
    }
    const names = new Map();
    // This check process reports its own runtime numbers too (as another service); only cron's count.
    for (const batch of inbox.values()) for (const metric of batch.service === 'cron' ? batch.metrics : []) {
        names.set(`${metric.kind}:${metric.name}`, [...(names.get(`${metric.kind}:${metric.name}`) || []), metric]);
    }
    return names;
}
await group('every worker reports memory, batches and health under the names the admin Observability page reads', async () => {
    const expected = [
        ...Object.values(WORKERS).flatMap(file => [`runtime:${file}.worker.rss_bytes`, `runtime:${file}.worker.cpu_cores`, `queue_run:${file}.project_batch`]),
        'worker:stream_activity.batch_events', 'worker:dashboard_activity.batch_events', 'worker:raid_analytics.batch_channels',
        'worker:roulette_completion.batch_channels', 'worker:follow_defense_baseline.batch_channels', 'worker:raid_sessions.batch_items',
        'worker:ai_usage_receipts.batch_receipts',
        ...['stream_activity', 'raid_analytics', 'follow_defense_baseline'].map(file => `worker:${file}.health_query`),
        'worker:stream_activity.pending_work', 'worker:stream_activity.checkpoint_seq', 'worker:stream_activity.active_batch_events',
        'worker:raid_analytics.backlog_channels', 'worker:follow_defense_baseline.backlog_channels',
        'worker:stream_activity.last_success_age_ms', 'worker:follow_defense_baseline.last_success_age_ms',
        ...['queueMs', 'claimMs', 'ledgerMs', 'streamsMs', 'attacksMs', 'publishMs', 'rescheduleMs'].map(phase => `queue_run:follow_defense_baseline.phase.${phase}`),
        'queue_run:raid_analytics.phase.claimMs', 'queue_run:raid_analytics.phase.publishMs',
    ];
    let names;
    await until(async () => { names = await collectTelemetry(); return expected.every(name => names.has(name)); }, 'worker telemetry', 75000, 500)
        .catch(error => { throw new Error(`${error.message}; missing ${expected.filter(name => !names.has(name)).join(', ')}`); });
    const sum = (name, outcome) => names.get(name).filter(metric => !outcome || metric.outcome === outcome).reduce((total, metric) => total + metric.sum, 0);
    assert.equal(sum('worker:stream_activity.batch_events', 'ok'), 7, 'five projected events plus two replayed');
    assert.equal(sum('worker:roulette_completion.batch_channels', 'ok'), 205);
    assert.equal(sum('worker:follow_defense_baseline.batch_channels', 'ok'), 10);
    assert.equal(sum('worker:ai_usage_receipts.batch_receipts', 'ok'), 8, 'seven receipts and one duplicate');
    assert(names.get('worker:ai_usage_receipts.batch_receipts').some(metric => metric.outcome === 'error'), 'the invalid receipt is a failed batch');
    assert(names.get('worker:stream_activity.health_query').every(metric => metric.max === 1), 'health probes succeeded');
    assert(!names.has('worker:stream_activity.health_errors') && !names.has('worker:raid_analytics.health_errors'));
    for (const name of names.keys()) assert(!/_rust\b|cron_index|native/.test(name), `no Rust-era metric name: ${name}`);
});

await group('a worker that exits while a flush is in flight still sends what it recorded since', async () => {
    // Same module the workers use on exit; this process is not a cron worker, so its rows are easy to tell apart.
    const { observe, flushTelemetry, drainTelemetry } = await load('utils/observability/telemetry.js');
    const find = async name => (await redis.lRange('observability:v1:inbox', 0, -1)).map(raw => JSON.parse(raw))
        .some(batch => batch.service !== 'cron' && batch.metrics.some(metric => metric.name === name));
    observe('worker', 'exit_drain_check.before');
    const inFlight = flushTelemetry();
    observe('worker', 'exit_drain_check.during');
    await drainTelemetry();
    await inFlight;
    assert.equal(await find('exit_drain_check.before'), true);
    assert.equal(await find('exit_drain_check.during'), true, 'recorded after the first flush took its snapshot');
});

// ---------------------------------------------------------------- supervision
await group('a killed worker is restarted alone; a stopped one exits cleanly and comes back', async () => {
    const before = Object.fromEntries(children().map(row => [row.file, row.pid]));
    process.kill(before.roulette_completion, 'SIGKILL');
    const replaced = await until(() => { const row = workerProcess('roulette_completion'); return row && row.pid !== before.roulette_completion && row; }, 'roulette worker restarted', 15000);
    process.kill(before.stream_activity, 'SIGTERM');
    await until(() => { const row = workerProcess('stream_activity'); return row && row.pid !== before.stream_activity; }, 'stream worker restarted', 15000);
    const after = Object.fromEntries(children().map(row => [row.file, row.pid]));
    for (const file of Object.values(WORKERS)) {
        if (!['roulette_completion', 'stream_activity'].includes(file)) assert.equal(after[file], before[file], `${file} was not disturbed`);
    }
    // The replacement works: a newly due channel is settled by the new process.
    const channels = db.collection('roulette_channels'), { emptyState } = await load('roulette/model.js');
    await channels.insertOne({ _id: '840001', revision: 0, state: { ...emptyState(), visible: true, hideAt: now() - 10 }, tokenHash: null, dueAt: now() - 10, receipts: [], actions: [], actionDueAt: null });
    await until(async () => (await channels.findOne({ _id: '840001' })).dueAt === null, 'replacement roulette worker settles');
    assert.equal(workerProcess('roulette_completion').pid, replaced.pid);
    const names = await until(async () => { const names = await collectTelemetry(); return names.has('worker:roulette_completion.restarts') && names.has('worker:stream_activity.restarts') && names; }, 'restart metrics', 30000, 500);
    assert.equal(names.get('worker:roulette_completion.restarts').reduce((total, metric) => total + metric.count, 0), 1);
    assert(!names.has('worker:raid_analytics.restarts'));
});

// ---------------------------------------------------------------- raid analytics, change-driven
await group('a quiet raid summary is not rewritten for over a minute, a duplicate queue publishes nothing, a new raid does', async () => {
    const { at, summaries, fingerprint, histories, raid, queueRaidSummary } = globalThis.raidCheckpoint;
    let { value } = globalThis.raidCheckpoint;
    await sleep(Math.max(0, 65000 - (now() - at)));
    const quiet = await summaries.findOne({ _id: channel });
    if (Math.floor(at / day) === Math.floor(now() / day)) {
        assert.equal(fingerprint(quiet), value, 'payload and updatedAt unchanged after 65 quiet seconds');
    } else {
        // The run crossed UTC midnight: the 7/30-day ranges moved, so exactly this republish is expected.
        assert.equal(+quiet.payload['7'].from, Math.floor(now() / day) * day - 6 * day, 'range start follows the new UTC day');
        value = fingerprint(quiet);
    }
    await queueRaidSummary(channel);
    await until(async () => { const row = await summaries.findOne({ _id: channel }); return +row.leaseUntil === 0 && +row.nextRefreshAt > now() && row; }, 'duplicate queue handled');
    assert.equal(fingerprint(await summaries.findOne({ _id: channel })), value, 'duplicate queueing changes nothing');
    await histories.insertOne(raid('d', 'incoming', '1003', 5, 90));
    await queueRaidSummary(channel);
    const updated = await until(async () => { const row = await summaries.findOne({ _id: channel }); return fingerprint(row) !== value && +row.leaseUntil === 0 && row; }, 'new raid published');
    assert.equal(updated.payload['7'].totals.find(row => row._id === 'incoming').raids, 3);
    assert.equal(updated.payload['7'].totals.find(row => row._id === 'incoming').biggest, 90);
});

await group('all seven workers are still the same healthy processes at the end', async () => {
    const live = children();
    assert.deepEqual(live.map(row => row.file).sort(), Object.values(WORKERS).sort());
    for (const row of await db.collection('raid_analytics_summaries').find({}).toArray()) assert.notEqual(row.error, true);
    assert.equal(await db.collection('dashboard_activity_summaries').countDocuments({ error: true }), 0);
});

console.log(`PASS cron TypeScript workers: ${passed.length} groups in ${Date.now() - started} ms`);
await mongo.disconnect();
redis.destroy();
process.exit(0);
