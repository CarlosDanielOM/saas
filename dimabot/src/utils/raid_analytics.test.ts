import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import mongoose from 'mongoose';
import { BSON, type Document } from 'mongodb';
import { RaidAnalyticsHistorySchema as History, RaidAnalyticsSummarySchema as Summary } from '../schemas/raid_analytics.schema.js';
import { DomainEventSchema as Events } from '../schemas/domain_event.schema.js';
import {
    createRaidSourceFingerprint, raidFollowValues, raidFollowWindow, raidNextRefreshAt, raidRangeStart,
    sameRaidPayload, projectRaidSummaryOnce, projectRaidSummaryOnceObserved, raidAnalyticsBacklogHealth,
    RaidProjectionError, queueRaidSummary, applyRaidAnalyticsEvent, type RaidRefreshState
} from './raid_analytics.js';

const DAY = 86400000, NOW = new Date('2030-06-15T12:00:00Z'), REPAIR = 900000;
const at = (offset = 0) => new Date(+NOW + offset);
function refresh(extra: Partial<RaidRefreshState> = {}): RaidRefreshState {
    return { version: 1, fingerprint: '', nextSourceAt: null, nextRepairAt: null, nextOpenAt: null,
        dirtyAt: null, hasFollowWindows: false, ...extra };
}
function history(id = 'raid', direction = 'incoming', occurredAt = at(-3600000), extra: Document = {}) {
    return new History({ _id: id, channelID: 'channel', direction, peerID: 'peer', peerLogin: 'peer_login',
        peerName: 'Peer', viewers: 10, occurredAt, expiresAt: at(90 * DAY), ...extra }).toObject() as Document & { _id: string };
}
function fingerprint(rows: Document[], now = NOW) {
    const state = createRaidSourceFingerprint(now);
    for (const row of [...rows].sort((a, b) => +b.occurredAt - +a.occurredAt || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0))) state.add(row);
    return state.finish();
}
// Independent encoding from the Rust check: length-prefixed BSON, then signed UTC range starts.
function rustFingerprint(rows: Document[], now = NOW) {
    const digest = createHash('sha256'); let hasPeriodRows = false;
    for (const row of [...rows].sort((a, b) => +b.occurredAt - +a.occurredAt || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0))) {
        if (row.expiresAt <= now || row.occurredAt > now) continue;
        const inPeriod = row.occurredAt >= raidRangeStart(30, now);
        if (!inPeriod && row.direction !== 'outgoing') continue;
        hasPeriodRows ||= inPeriod;
        const fields = inPeriod ? ['_id', 'direction', 'peerID', 'peerLogin', 'peerName', 'viewers', 'occurredAt', 'followsAfter', 'followWindowEnd']
            : ['_id', 'direction', 'peerID', 'occurredAt'];
        const bytes = BSON.serialize(Object.fromEntries(fields.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]])));
        const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(bytes.length)); digest.update(length); digest.update(bytes);
    }
    if (hasPeriodRows) for (const days of [7, 30]) {
        const bytes = Buffer.alloc(8); bytes.writeBigInt64LE(BigInt(+raidRangeStart(days, now))); digest.update(bytes);
    }
    return digest.digest('hex');
}

test('UTC inclusive ranges include pre-epoch dates', () => {
    for (const millis of [0, 1, DAY - 1, DAY, 20000 * DAY + 12345, -1]) for (const days of [7, 30])
        assert.equal(+raidRangeStart(days, new Date(millis)), (Math.floor(millis / DAY) - days + 1) * DAY);
});
test('follow windows are half-open, capped at five minutes, and tied raids close at the same instant', () => {
    for (const [next, now, end, computed] of [
        [null, 1100000, 1100000, 0], [null, 1300000, 1300000, 1300000], [null, 1900000, 1300000, 1900000],
        [1050000, 1100000, 1050000, 1100000], [1200000, 1100000, 1100000, 0], [1000000, 1100000, 1000000, 1100000]
    ]) assert.deepEqual(raidFollowWindow(new Date(1000000), next == null ? null : new Date(next), new Date(now!)),
        { end: new Date(end!), computed: new Date(computed!) });
});
test('unchanged open probes write nothing; finalization and closed repair update only necessary fields', () => {
    const row = { followsAfter: 0, followWindowEnd: at(-120000), followsComputedAt: new Date(0) };
    assert.deepEqual(raidFollowValues(row, 0, at(-60000), new Date(0)), { values: {}, changed: false });
    assert.deepEqual(raidFollowValues(row, 1, at(-60000), new Date(0)), {
        values: { followsAfter: 1, followWindowEnd: at(-60000) }, changed: true
    });
    const closed = { ...row, followWindowEnd: NOW, followsComputedAt: NOW };
    assert.deepEqual(raidFollowValues(closed, 0, NOW, at(REPAIR)), { values: { followsComputedAt: at(REPAIR) }, changed: false });
    assert.equal(raidFollowValues(row, 0, NOW, NOW).changed, true);
    assert.equal(raidFollowValues({ ...row, followsAfter: null }, 0, NOW, NOW).changed, true);
});
test('payload equality ignores only to and totals ordering and preserves input', () => {
    const old = { '7': { from: at(-DAY), to: NOW, totals: [{ _id: 'outgoing' }, { _id: 'incoming' }],
        incoming: [{ peerID: 'a' }, { peerID: 'b' }] }, '30': {} };
    const copy = structuredClone(old), candidate = structuredClone(old);
    candidate['7'].to = at(60000); candidate['7'].totals.reverse();
    assert.equal(sameRaidPayload(old, candidate), true);
    assert.deepEqual(old, copy);
    candidate['7'].incoming.reverse(); assert.equal(sameRaidPayload(old, candidate), false);
    candidate['7'].incoming.reverse(); candidate['7'].from = NOW; assert.equal(sameRaidPayload(old, candidate), false);
});
test('fingerprints use Rust BSON encoding and retain explicit numeric BSON types', () => {
    const rows = [history('in'), history('out', 'outgoing', at(-40 * DAY)), history('expired', 'incoming', NOW, { expiresAt: at(-1) }),
        history('future', 'incoming', at(1000))];
    rows[0]!.viewers = new BSON.Double(10) as never;
    rows[0]!.followsAfter = new BSON.Long(0) as never;
    assert.equal(fingerprint(rows).fingerprint, rustFingerprint(rows));
    assert.equal(+fingerprint(rows).nextSourceAt!, +at(1000));
    const numeric = structuredClone(rows[0]); numeric.viewers = 10;
    assert.notEqual(fingerprint([rows[0]!]).fingerprint, fingerprint([numeric]).fingerprint);
    assert.equal(fingerprint([history('old-in', 'incoming', at(-40 * DAY))]).fingerprint, createHash('sha256').digest('hex'));
    assert.notEqual(fingerprint([history('old-out', 'outgoing', at(-40 * DAY))]).fingerprint, createHash('sha256').digest('hex'));
});
test('source deadlines include expiry, activation and midnight only when period rows exist', () => {
    assert.deepEqual(fingerprint([]), { fingerprint: createHash('sha256').digest('hex'), nextSourceAt: null, hasFollowWindows: false });
    assert.equal(+fingerprint([history('future', 'incoming', at(10000), { expiresAt: at(5000) })]).nextSourceAt!, +at(5000));
    assert.equal(+fingerprint([history('out', 'outgoing')]).nextSourceAt!, +new Date('2030-06-16T00:00:00Z'));
    assert.equal(+fingerprint([history('old', 'outgoing', at(-40 * DAY))]).nextSourceAt!, +at(90 * DAY));
    assert.equal(fingerprint([history('out', 'outgoing')]).hasFollowWindows, false);
});
test('next refresh drains pending work, unschedules empty channels, and chooses earliest persisted deadline', () => {
    assert.equal(raidNextRefreshAt(refresh(), false, NOW), null);
    assert.equal(raidNextRefreshAt(refresh(), true, NOW), NOW);
    assert.deepEqual(raidNextRefreshAt(refresh({ nextRepairAt: at(REPAIR), nextOpenAt: at(60000), nextSourceAt: at(5000) }), false, NOW), at(5000));
});

const uri = process.env.RAIDPORT_TEST_MONGO_URI;
test('disposable MongoDB projector behavior', { skip: !uri }, async t => {
    const parsed = new URL(uri!);
    assert.equal(parsed.hostname, '127.0.0.1');
    assert.match(parsed.pathname, /^\/raidport_fixture_[a-zA-Z0-9_]+$/);
    assert.notEqual(parsed.port, '27017');
    await mongoose.connect(uri!, { autoIndex: false, serverSelectionTimeoutMS: 5000, monitorCommands: true });
    const histories = mongoose.connection.db!.collection<Document & { _id: string }>(History.collection.name);
    const summaries = mongoose.connection.db!.collection<Document & { _id: string }>(Summary.collection.name);
    const commands: Document[] = [];
    const record = (event: Document) => commands.push(event);
    mongoose.connection.getClient().on('commandStarted', record);
    const reset = async () => {
        for (const model of [History, Summary, Events]) await model.collection.deleteMany({});
        commands.length = 0;
    };
    const queue = async (extra: Document = {}) => summaries.updateOne({ _id: 'channel' }, { $set: {
        dirtyAt: at(-1), nextRefreshAt: NOW, leaseUntil: new Date(0), ...extra
    } }, { upsert: true });
    const state = async () => (await summaries.findOne({ _id: 'channel' }))!;
    const snapshot = (row: Document) => BSON.serialize({ payload: row.payload, updatedAt: row.updatedAt });
    const aggregateCount = () => commands.filter(row => row.commandName === 'aggregate' && row.command.aggregate === History.collection.name).length;
    const outgoing = async () => { await histories.insertOne(history('sent', 'outgoing')); await queue(); };
    try {
        for (const model of [History, Summary, Events]) {
            await model.createCollection();
            for (const [keys, options] of model.schema.indexes()) await model.collection.createIndex(
                keys as Parameters<typeof model.collection.createIndex>[0], options as Parameters<typeof model.collection.createIndex>[1]);
        }
        await t.test('new raid publishes; idle pass reports only claim; unchanged/duplicate queues skip all aggregates', async () => {
            await reset(); await outgoing();
            const first = await projectRaidSummaryOnceObserved(NOW);
            assert.equal(first.channels, 1); assert.equal(first.published, 1); assert.equal(aggregateCount(), 4);
            for (const key of ['claimMs', 'followQueriesMs', 'period7Ms', 'period30Ms', 'reciprocityMs', 'publishMs', 'releaseMs'])
                assert.equal(typeof first.phases[key as keyof typeof first.phases], 'number');
            const before = await state();
            const idle = await projectRaidSummaryOnceObserved(NOW);
            assert.deepEqual({ ...idle, phases: Object.keys(idle.phases) }, { channels: 0, published: 0, phases: ['claimMs'] });
            for (let i = 0; i < 2; i++) {
                await queueRaidSummary('channel'); commands.length = 0;
                const pass = await projectRaidSummaryOnceObserved(at(60000));
                assert.equal(pass.channels, 1); assert.equal(pass.published, 0); assert.equal(aggregateCount(), 0);
                assert.deepEqual(snapshot(await state()), snapshot(before));
            }
            await histories.insertOne(history('new', 'outgoing', at(-1000))); await queue();
            assert.equal((await projectRaidSummaryOnceObserved(NOW)).published, 1);
        });
        await t.test('legacy payload adoption preserves bytes, then adopts handwritten Rust metadata without aggregates', async () => {
            await reset(); await outgoing(); await projectRaidSummaryOnceObserved(NOW);
            const before = await state();
            await summaries.updateOne({ _id: 'channel' }, { $unset: { rustRefresh: '', rustPending: '' } });
            await queue(); commands.length = 0;
            assert.equal((await projectRaidSummaryOnceObserved(at(60000))).published, 0);
            assert.equal(aggregateCount(), 4); assert.deepEqual(snapshot(await state()), snapshot(before));
            const raw = await histories.find({}, { promoteValues: false }).toArray();
            const fingerprint = rustFingerprint(raw);
            await queue({ rustRefresh: { version: 1, fingerprint, nextSourceAt: new Date('2030-06-16T00:00:00Z'),
                nextRepairAt: null, nextOpenAt: null, dirtyAt: at(-1), hasFollowWindows: false }, rustPending: false });
            commands.length = 0;
            assert.equal((await projectRaidSummaryOnceObserved(at(120000))).published, 0);
            assert.equal(aggregateCount(), 0); assert.deepEqual(snapshot(await state()), snapshot(before));
            assert.equal((await state()).rustRefresh.fingerprint, fingerprint);
        });
        await t.test('same-millisecond queueing rescans and detects a newly inserted raid', async () => {
            await reset(); await outgoing(); await projectRaidSummaryOnceObserved(NOW);
            await histories.insertOne(history('second', 'outgoing', at(-1000)));
            await queue({ dirtyAt: at(-1), nextRefreshAt: at(-1) });
            assert.equal((await projectRaidSummaryOnceObserved(NOW)).published, 1);
        });
        await t.test('Rust fingerprints retain BSON doubles and longs across a queued source scan', async () => {
            await reset();
            await histories.insertOne({ ...history('typed', 'outgoing'), viewers: new BSON.Double(10), followsAfter: new BSON.Long(3) } as never);
            await queue(); await projectRaidSummaryOnceObserved(NOW);
            const raw = await histories.find({}, { promoteValues: false }).toArray(), before = await state();
            assert.equal(before.rustRefresh.fingerprint, rustFingerprint(raw));
            await queue({ rustRefresh: { ...before.rustRefresh, fingerprint: rustFingerprint(raw) } }); commands.length = 0;
            assert.equal((await projectRaidSummaryOnceObserved(at(60000))).published, 0);
            assert.equal(aggregateCount(), 0); assert.deepEqual(snapshot(await state()), snapshot(before));
        });
        await t.test('late lower-ObjectId follows repair at the inclusive fifteen-minute bound', async () => {
            await reset(); await histories.insertOne(history()); await queue();
            await Events.collection.insertOne({ _id: new mongoose.Types.ObjectId('ffffffffffffffffffffffff'), eventKey: 'first-follow', sourceEventId: 'first-follow', channelID: 'channel',
                source: 'twitch-eventsub', type: 'channel.follow.received', occurredAt: at(-3599999), expiresAt: at(DAY) } as never);
            await projectRaidSummaryOnceObserved(NOW);
            assert.equal((await History.findById('raid').lean())!.followsAfter, 1);
            await Events.collection.insertOne({ _id: new mongoose.Types.ObjectId('000000000000000000000001'), eventKey: 'late-follow', sourceEventId: 'late-follow', channelID: 'channel',
                source: 'twitch-eventsub', type: 'channel.follow.received', occurredAt: at(-3599998), expiresAt: at(DAY) } as never);
            const pass = await projectRaidSummaryOnceObserved(at(REPAIR));
            assert.equal(pass.published, 1); assert.equal((await History.findById('raid').lean())!.followsAfter, 2);
            assert.equal((await state()).payload['7'].totals[0].followsAfter, 2);
        });
        await t.test('unchanged closed repair skips source scan and aggregates; open probe freezes its end and schedules without looping', async () => {
            await reset(); await histories.insertOne(history()); await queue(); await projectRaidSummaryOnceObserved(NOW);
            const before = await state(); commands.length = 0;
            assert.equal((await projectRaidSummaryOnceObserved(at(REPAIR))).published, 0);
            assert.equal(aggregateCount(), 0); assert.deepEqual(snapshot(await state()), snapshot(before));
            assert.equal(commands.filter(row => row.commandName === 'find' && row.command.find === History.collection.name
                && row.command.projection?.peerName).length, 0);
            await reset(); await histories.insertOne(history('open', 'incoming', at(-30000))); await queue();
            await projectRaidSummaryOnceObserved(NOW);
            const open = await History.findById('open').lean(), initial = await state();
            commands.length = 0;
            assert.equal((await projectRaidSummaryOnceObserved(at(60000))).published, 0);
            assert.equal(aggregateCount(), 0); assert.deepEqual(await History.findById('open').lean(), open);
            assert.deepEqual(snapshot(await state()), snapshot(initial)); assert.equal(+(await state()).nextRefreshAt, +at(120000));
            assert.equal((await projectRaidSummaryOnceObserved(at(270000))).published, 1);
            assert.equal(+(await History.findById('open').lean())!.followWindowEnd!, +at(270000));
        });
        await t.test('history expiry, future activation and UTC rollover persist precise source deadlines', async () => {
            for (const scenario of ['expiry', 'future', 'midnight']) {
                await reset();
                const boundary = scenario === 'midnight' ? new Date('2030-06-16T00:00:00Z') : at(5000);
                await histories.insertOne(history('sent', 'outgoing', scenario === 'future' ? boundary : at(-1000),
                    scenario === 'expiry' ? { expiresAt: boundary } : {}));
                await queue(); await projectRaidSummaryOnceObserved(NOW);
                assert.equal(+(await state()).nextRefreshAt, +boundary);
                assert.equal((await projectRaidSummaryOnceObserved(boundary)).published, 1);
                if (scenario === 'expiry') assert.equal((await state()).nextRefreshAt, undefined);
                if (scenario === 'midnight') assert.equal(+(await state()).payload['7'].from, +raidRangeStart(7, boundary));
                if (scenario === 'future') assert.equal((await state()).payload['7'].totals[0].raids, 1);
            }
        });
        await t.test('empty channels unschedule and old outgoing history retains reciprocity until expiry', async () => {
            await reset(); await queue(); await projectRaidSummaryOnceObserved(NOW);
            assert.equal((await state()).nextRefreshAt, undefined); assert.equal(await projectRaidSummaryOnce(NOW), false);
            await histories.insertMany([history('in'), history('old', 'outgoing', at(-40 * DAY), { expiresAt: at(5000) })]);
            await queue(); await projectRaidSummaryOnceObserved(NOW);
            assert.equal(+(await state()).payload['7'].incoming[0].lastOutgoingAt, +at(-40 * DAY));
            assert.equal(+(await state()).nextRefreshAt, +at(5000));
            await projectRaidSummaryOnceObserved(at(5000)); assert.equal((await state()).payload['7'].incoming[0].lastOutgoingAt, null);
        });
        await t.test('forty due windows drain 25 then 15, with at most five count queries in flight', async sub => {
            await reset();
            await histories.insertMany(Array.from({ length: 40 }, (_, i) => history(`batch-${String(i).padStart(2, '0')}`, 'incoming', at(-3600000 - i * 600000))));
            await queue(); let active = 0, peak = 0;
            const original = Events.countDocuments.bind(Events);
            sub.mock.method(Events, 'countDocuments', ((...args: Parameters<typeof Events.countDocuments>) => {
                const query = original(...args), maxTime = query.maxTimeMS.bind(query);
                query.maxTimeMS = ((ms: number) => ({ then: async (resolve: (value: number) => void, reject: (error: unknown) => void) => {
                    active++; peak = Math.max(peak, active);
                    try { await delay(5); resolve(await maxTime(ms)); } catch (error) { reject(error); } finally { active--; }
                } })) as never;
                return query;
            }) as never);
            assert.equal((await projectRaidSummaryOnceObserved(NOW)).channels, 1);
            assert.equal(await History.countDocuments({ followsComputedAt: NOW }), 25); assert.equal(+(await state()).nextRefreshAt, +NOW);
            assert.equal((await projectRaidSummaryOnceObserved(NOW)).channels, 1);
            assert.equal(await History.countDocuments({ followsComputedAt: NOW }), 40); assert(peak <= 5 && peak > 1);
            assert(+(await state()).nextRefreshAt > +NOW);
        });
        await t.test('held leases are skipped but included in backlog health', async () => {
            await reset(); await outgoing(); await queue({ nextRefreshAt: at(-10000), owner: 'other', leaseUntil: new Date(Date.now() + 60000) });
            assert.deepEqual(await raidAnalyticsBacklogHealth(NOW), { dueChannels: 1, oldestDueAgeMs: 10000 });
            assert.equal((await projectRaidSummaryOnceObserved(NOW)).channels, 0); assert.equal((await state()).owner, 'other');
            await Summary.deleteMany({}); assert.deepEqual(await raidAnalyticsBacklogHealth(NOW), { dueChannels: 0, oldestDueAgeMs: null });
        });
        await t.test('new dirtyAt during projection leaves producer schedule, payload and pending marker intact', async sub => {
            await reset(); await histories.insertOne(history()); await queue();
            const original = History.aggregate.bind(History); let queued = false;
            sub.mock.method(History, 'aggregate', ((...args: Parameters<typeof History.aggregate>) => {
                const aggregate = original(...args), option = aggregate.option.bind(aggregate);
                aggregate.option = ((options: Document) => ({ then: async (resolve: (value: unknown) => void, reject: (error: unknown) => void) => {
                    try {
                        if (!queued) { queued = true; await summaries.updateOne({ _id: 'channel' }, { $set: { dirtyAt: at(1), nextRefreshAt: at(1) } }); }
                        resolve(await option(options));
                    } catch (error) { reject(error); }
                } })) as never;
                return aggregate;
            }) as never);
            assert.equal((await projectRaidSummaryOnceObserved(NOW)).published, 0);
            const row = await state(); assert.equal(row.payload, undefined); assert.equal(row.rustPending, true);
            assert.equal(+row.nextRefreshAt, +at(1)); assert.equal(+row.leaseUntil, 0);
            sub.mock.restoreAll(); assert.equal((await projectRaidSummaryOnceObserved(at(1))).published, 1);
        });
        await t.test('failure retains phases, pending flag, error and retry deadline; recovery rebuilds even when follow writes already match', async sub => {
            await reset(); await histories.insertOne(history()); await queue();
            sub.mock.method(History, 'aggregate', (() => ({ option() { throw new Error('fixture aggregate failure'); } })) as never);
            const started = Date.now();
            await assert.rejects(projectRaidSummaryOnceObserved(NOW), error => {
                assert(error instanceof RaidProjectionError); assert.equal(error.channels, 1);
                assert.equal((error.cause as Error).message, 'fixture aggregate failure');
                for (const key of ['claimMs', 'followQueriesMs', 'followWriteMs', 'period7Ms', 'releaseMs'])
                    assert.equal(typeof error.phases[key as keyof typeof error.phases], 'number');
                assert.equal(error.phases.period30Ms, undefined); return true;
            });
            const failed = await state(); assert.equal(failed.rustPending, true); assert.equal(failed.error, true);
            assert(+failed.nextRefreshAt >= started + 30000 && +failed.nextRefreshAt <= Date.now() + 30000); assert.equal(+failed.leaseUntil, 0);
            sub.mock.restoreAll(); assert.equal((await projectRaidSummaryOnceObserved(NOW)).published, 1);
            assert.equal((await state()).rustPending, false); assert.equal((await state()).error, false);
        });
        await t.test('partial history bulk failure keeps durable recovery state', async sub => {
            await reset(); await histories.insertMany([history('a'), history('b')]); await queue();
            const bulk = History.bulkWrite.bind(History);
            sub.mock.method(History, 'bulkWrite', (async (operations: Parameters<typeof History.bulkWrite>[0]) => {
                await bulk(operations.slice(0, 1), { ordered: false, writeConcern: { w: 1, j: true } });
                throw new Error('fixture partial bulk');
            }) as never);
            await assert.rejects(projectRaidSummaryOnceObserved(NOW), RaidProjectionError);
            assert.equal((await state()).rustPending, true); assert.equal(await History.countDocuments({ followsAfter: 0 }), 1);
            sub.mock.restoreAll(); assert.equal((await projectRaidSummaryOnceObserved(NOW)).published, 1);
            assert.equal(await History.countDocuments({ followsAfter: 0 }), 2);
        });
        await t.test('persisted pending or error forces recovery with compatible metadata and no newly changed follow fields', async () => {
            for (const marker of ['rustPending', 'error']) {
                await reset(); await histories.insertOne(history()); await queue(); await projectRaidSummaryOnceObserved(NOW);
                await histories.updateOne({ _id: 'raid' }, { $set: { followsAfter: 1 } });
                await summaries.updateOne({ _id: 'channel' }, { $set: { [marker]: true, nextRefreshAt: NOW } });
                commands.length = 0;
                const pass = await projectRaidSummaryOnceObserved(NOW);
                assert.equal(pass.published, 1); assert.equal(aggregateCount(), 4); assert.equal(pass.phases.followWriteMs, undefined);
                assert.equal((await state()).payload['7'].totals[0].followsAfter, 1);
                assert.equal((await state()).rustPending, false); assert.equal((await state()).error, false);
            }
        });
        await t.test('metadata publication failure preserves payload and retries without unnecessary aggregation', async sub => {
            await reset(); await outgoing(); await projectRaidSummaryOnceObserved(NOW); const before = await state();
            await queue();
            const original = Summary.updateOne.bind(Summary); let failed = false;
            sub.mock.method(Summary, 'updateOne', ((filter: Document, update: Document) => {
                if (!failed && update.$set?.rustRefresh) { failed = true; throw new Error('fixture metadata publication'); }
                return original(filter, update);
            }) as never);
            await assert.rejects(projectRaidSummaryOnceObserved(NOW), error => error instanceof RaidProjectionError
                && typeof error.phases.publishMs === 'number' && typeof error.phases.releaseMs === 'number');
            assert.deepEqual(snapshot(await state()), snapshot(before)); assert.equal((await state()).error, true);
            sub.mock.restoreAll(); commands.length = 0;
            assert.equal((await projectRaidSummaryOnceObserved(NOW)).published, 0);
            assert.equal(aggregateCount(), 0); assert.deepEqual(snapshot(await state()), snapshot(before));
        });
        await t.test('lease loss never publishes, releases, or marks a replacement owner as failed', async sub => {
            await reset(); await outgoing();
            const original = History.aggregate.bind(History); let replaced = false;
            sub.mock.method(History, 'aggregate', ((...args: Parameters<typeof History.aggregate>) => {
                if (!replaced) {
                    replaced = true;
                    const aggregate = original(...args), option = aggregate.option.bind(aggregate);
                    aggregate.option = ((options: Document) => ({ then: async (resolve: (value: unknown) => void, reject: (error: unknown) => void) => {
                        try {
                            await summaries.updateOne({ _id: 'channel' }, { $set: { owner: 'replacement', leaseUntil: new Date(Date.now() + 60000) } });
                            resolve(await option(options));
                        } catch (error) { reject(error); }
                    } })) as never;
                    return aggregate;
                }
                return original(...args);
            }) as never);
            await assert.rejects(projectRaidSummaryOnceObserved(NOW), error => error instanceof RaidProjectionError
                && (error.cause as Error).message === 'Raid analytics lease lost');
            const row = await state(); assert.equal(row.owner, 'replacement'); assert(+row.leaseUntil > Date.now());
            assert.equal(row.error, undefined); assert.equal(row.payload, undefined); assert.equal(+row.nextRefreshAt, +NOW);
        });
        await t.test('heartbeat renews wall-clock lease while business time is fixed', async sub => {
            await reset(); await outgoing();
            const original = History.aggregate.bind(History); let delayed = false, before = 0, after = 0;
            sub.mock.method(History, 'aggregate', ((...args: Parameters<typeof History.aggregate>) => {
                const aggregate = original(...args), option = aggregate.option.bind(aggregate);
                aggregate.option = ((options: Document) => ({ then: async (resolve: (value: unknown) => void, reject: (error: unknown) => void) => {
                    try {
                        if (!delayed) {
                            delayed = true; before = +(await state()).leaseUntil;
                            await delay(10500); after = +(await state()).leaseUntil;
                        }
                        resolve(await option(options));
                    } catch (error) { reject(error); }
                } })) as never;
                return aggregate;
            }) as never);
            assert.equal((await projectRaidSummaryOnceObserved(NOW)).published, 1); assert(after >= before + 9000);
            assert.equal(+((await state()).leaseUntil), 0);
        });
        await t.test('existing producer remains idempotent and preserves Rust metadata through strict mongoose updates', async () => {
            await reset();
            const event = new Events({ eventKey: 'raid-event', sourceEventId: 'raid-event', source: 'twitch-eventsub',
                type: 'channel.raid.received', topic: 'channel', channelID: 'channel', occurredAt: at(-3600000),
                expiresAt: at(DAY), payload: { event: { from_broadcaster_user_id: 'peer', viewers: 10 } } }).toObject();
            await applyRaidAnalyticsEvent(event); await projectRaidSummaryOnceObserved(NOW);
            const before = await state(); await applyRaidAnalyticsEvent(event);
            assert.equal(await History.countDocuments({}), 1); assert.deepEqual((await state()).rustRefresh, before.rustRefresh);
            assert.equal((await projectRaidSummaryOnceObserved(NOW)).published, 0);
        });
    } finally {
        mongoose.connection.getClient().off('commandStarted', record);
        await mongoose.connection.dropDatabase();
        await mongoose.disconnect();
    }
});
