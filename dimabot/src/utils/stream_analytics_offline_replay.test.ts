import assert from 'node:assert/strict';
import test, { mock, type TestContext } from 'node:test';
import { Types } from 'mongoose';
import { StreamSessionSchema } from '../schemas/stream_session.schema.js';
import { ClipRecommendationConfigSchema } from '../schemas/clip_recommendation_config.schema.js';
import UsersSchema from '../schemas/users.schema.js';
import { DomainEventSchema } from '../schemas/domain_event.schema.js';
import { DomainEventDeliverySchema } from '../schemas/domain_event_delivery.schema.js';
import { DomainEventCheckpointSchema } from '../schemas/domain_event_checkpoint.schema.js';

// Block eager service imports as well as every queue/network boundary before importing analytics.
mock.module('../classes/twitch_streamers.class.js', { defaultExport: {} });
mock.module('./header.js', { namedExports: { getTwitchAppHeader: () => assert.fail('No Helix calls') } });
mock.module('./siteanalytics.js', { namedExports: { getLiveChannelsBoard: () => assert.fail('No cache reconciliation') } });
mock.module('./logger.js', { namedExports: { error: async () => undefined, info: async () => undefined, warn: async () => undefined } });
mock.module('./databases/dragonfly.database.js', { namedExports: { getDragonflyClient: () => assert.fail('No database connections') } });
let enqueue: (step: 'summary' | 'clips', input: any) => Promise<any>;
mock.module('./ai/memory/stream_memory_queue.js', { namedExports: { enqueueStreamMemorySummaryJob: (input: any) => enqueue('summary', input) } });
mock.module('./ai/clip_recommendations/clip_recommendations_queue.js', { namedExports: { enqueueClipRecommendationJob: (input: any) => enqueue('clips', input) } });
const { recordStreamOnlineEvent, recordStreamOfflineEvent, recordStreamBitsEvent, recordStreamFollowEvent, recordStreamSubEvent } = await import('./stream_analytics.js');
const { drainDomainEvents } = await import('./domain_event_consumer.js');

function query<T>(value: T) {
    return { sort() { return this; }, limit() { return this; }, select() { return this; }, lean() { return this; }, exec: async () => value,
        then: Promise.resolve(value).then.bind(Promise.resolve(value)) };
}

function setup(t: TestContext) {
    t.mock.method(console, 'log', () => undefined);
    t.mock.method(console, 'error', () => undefined);
    const session: any = {
        _id: new Types.ObjectId(), channelID: 'channel', channel: 'streamer', stream_id: 'stream',
        started_at: new Date('2026-09-05T12:00:00Z'), ended_at: null, status: 'live',
        applied_domain_event_keys: [], offline_summary_enqueued_at: null, offline_clips_completed_at: null
    };
    const state = {
        absent: false, updateCount: 0, updateLost: false, failUpdate: false,
        failReceipt: '', loseReceipt: '', failEnqueue: '', loseEnqueue: '', configFailure: false,
        enabled: true, accepted: new Set<string>(), calls: [] as string[],
        removedDuringUpdate: false, otherSessions: [] as any[], beforeUpdate: () => undefined as void
    };
    const matchesFilter = (row: any, filter: any): boolean => Object.entries(filter).every(([key, value]: [string, any]) => {
        if (key === '$or') return value.some((part: any) => matchesFilter(row, part));
        const actual = row[key];
        if (value && typeof value === 'object' && !(value instanceof Date) && !(value instanceof Types.ObjectId)) {
            return Object.entries(value).every(([operator, operand]: [string, any]) => {
                if (operator === '$ne') return Array.isArray(actual) ? !actual.includes(operand) : actual !== operand;
                if (operator === '$gte') return actual >= operand;
                if (operator === '$lte') return actual <= operand;
                assert.fail(`Unsupported query operator: ${operator}`);
            });
        }
        if (value === null) return actual == null;
        if (value instanceof Date) return actual instanceof Date && actual.getTime() === value.getTime();
        if (value instanceof Types.ObjectId) return String(actual) === String(value);
        return Array.isArray(actual) ? actual.includes(value) : actual === value;
    });
    t.mock.method(StreamSessionSchema, 'findOne', ((filter: any) => {
        assert.equal(filter.channelID, 'channel');
        const rows = [...(state.absent ? [] : [session]), ...state.otherSessions].filter(row => matchesFilter(row, filter));
        const result = query<any>(null);
        result.sort = function (sort?: any) {
            if (sort?.started_at) rows.sort((a, b) => (a.started_at - b.started_at) * sort.started_at);
            return this;
        };
        result.lean = () => query(rows[0] ? { ...rows[0], applied_domain_event_keys: [...rows[0].applied_domain_event_keys] } : null);
        return result;
    }) as never);
    t.mock.method(StreamSessionSchema, 'exists', ((filter: any) => query(
        [...(state.absent ? [] : [session]), ...state.otherSessions].find(row => matchesFilter(row, filter)) || null)) as never);
    t.mock.method(StreamSessionSchema, 'updateOne', (async (filter: any, update: any, options: any) => {
        assert.deepEqual(options.writeConcern, { w: 1, j: true });
        state.beforeUpdate();
        if (state.removedDuringUpdate) { state.absent = true; return { matchedCount: 0, modifiedCount: 0 }; }
        if (state.absent && options.upsert) {
            Object.assign(session, update.$setOnInsert, update.$set, { applied_domain_event_keys: [] });
            if (update.$addToSet) session.applied_domain_event_keys.push(update.$addToSet.applied_domain_event_keys);
            state.absent = false;
            return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
        }
        if (!matchesFilter(session, filter)) return { matchedCount: 0, modifiedCount: 0 };
        if (update.$set?.status) {
            if (state.failUpdate) throw new Error('Session update failed');
            if (session.applied_domain_event_keys.includes(filter.applied_domain_event_keys?.$ne)) return { matchedCount: 0, modifiedCount: 0 };
            state.updateCount++;
            Object.assign(session, update.$set);
            if (update.$addToSet) session.applied_domain_event_keys.push(update.$addToSet.applied_domain_event_keys);
            if (state.updateLost) { state.updateLost = false; throw new Error('Session update response lost'); }
        } else if (update.$set) {
            const field = Object.keys(update.$set)[0];
            assert.equal(filter.applied_domain_event_keys, 'offline:event');
            if (state.failReceipt === field) throw new Error('Receipt write failed');
            Object.assign(session, update.$set);
            if (state.loseReceipt === field) { state.loseReceipt = ''; throw new Error('Receipt response lost'); }
        } else if (update.$addToSet) {
            if (!session.applied_domain_event_keys.includes(update.$addToSet.applied_domain_event_keys)) {
                session.applied_domain_event_keys.push(update.$addToSet.applied_domain_event_keys);
            }
        }
        return { matchedCount: 1, modifiedCount: 1 };
    }) as never);
    t.mock.method(StreamSessionSchema, 'findOneAndUpdate', (async (filter: any, update: any, options: any) => {
        const result = await StreamSessionSchema.updateOne(filter, update, options);
        if (result.matchedCount || result.upsertedCount) return { ...session };
        if (!state.absent && options.upsert) throw Object.assign(new Error('Duplicate stream identity'), { code: 11000 });
        return null;
    }) as never);
    t.mock.method(ClipRecommendationConfigSchema, 'findOne', (() => ({
        lean() { return this; }, async exec() {
            if (state.configFailure) throw new Error('Config unavailable');
            return { autoAnalyzeEnabled: state.enabled };
        }
    })) as never);
    t.mock.method(UsersSchema, 'findOne', (() => query({ plan_tier: 'pro' })) as never);
    enqueue = async (step, input) => {
        assert.equal(session.status, 'offline');
        assert.equal(input.sessionID, String(session._id));
        assert.equal(input.force, undefined);
        state.calls.push(step);
        if (state.failEnqueue === step) throw new Error(`${step} unavailable`);
        const enqueued = !state.accepted.has(step);
        state.accepted.add(step);
        if (state.loseEnqueue === step) { state.loseEnqueue = ''; throw new Error('Enqueue response lost'); }
        return { enqueued, dedupeKey: `${step}:session`, message: enqueued ? 'queued' : 'already queued' };
    };
    const input = { channelID: 'channel', endedAt: new Date('2026-09-05T14:00:00Z'), eventKey: 'offline:event' };
    return { state, session, run: () => recordStreamOfflineEvent(input), online: () => recordStreamOnlineEvent({
        channelID: 'channel', channel: 'streamer', streamID: 'stream', startedAt: session.started_at,
        eventKey: 'online:event', reopenClosed: false
    }) };
}

test('late durable online repairs a snapshot orphan so a different offline event closes it and enqueues both jobs', async t => {
    const h = setup(t);
    Object.assign(h.session, {
        status: 'orphaned', ended_at: new Date('2026-09-05T12:10:00Z'), consecutive_offline_checks: 2,
        duration_minutes: 10, sample_count: 3, sample_total_viewers: 90, peak_viewers: 50,
        average_viewers: 30, follows: 7, subs: 2, bits: 100, donations: 12, messages: 40, commands: 4
    });
    const metrics = Object.fromEntries(['sample_count', 'sample_total_viewers', 'peak_viewers', 'average_viewers',
        'follows', 'subs', 'bits', 'donations', 'messages', 'commands'].map(key => [key, h.session[key]]));
    const id = String(h.session._id);
    await assert.rejects(h.run(), { name: 'DomainEventPrerequisiteMissingError' });
    await h.online();
    assert.equal(h.session.status, 'live');
    assert.equal(h.session.ended_at, null);
    assert.equal(h.session.consecutive_offline_checks, 0);
    assert.deepEqual(h.session.applied_domain_event_keys, ['online:event']);
    for (const [key, value] of Object.entries(metrics)) assert.equal(h.session[key], value);
    await h.run();
    await h.run();
    assert.equal(String(h.session._id), id);
    assert.equal(h.session.stream_id, 'stream');
    assert.equal(h.session.status, 'offline');
    assert.equal(h.session.ended_at.toISOString(), '2026-09-05T14:00:00.000Z');
    assert.equal(h.session.duration_minutes, 120);
    assert.deepEqual(h.session.applied_domain_event_keys, ['online:event', 'offline:event']);
    assert.deepEqual(h.state.calls, ['summary', 'clips']);
    assert.ok(h.session.offline_summary_enqueued_at);
    assert.ok(h.session.offline_clips_completed_at);
});

test('late online receipts a genuinely offline no-op without changing metrics or lifecycle', async t => {
    const h = setup(t);
    await h.run();
    const before = { ...h.session, applied_domain_event_keys: ['offline:event', 'online:event'] };
    await h.online();
    await h.online();
    assert.deepEqual(h.session, before);
    assert.deepEqual(h.state.calls, ['summary', 'clips']);
});

test('an already applied online event cannot reopen its later snapshot orphan', async t => {
    const h = setup(t);
    Object.assign(h.session, { status: 'orphaned', ended_at: new Date('2026-09-05T12:10:00Z'),
        consecutive_offline_checks: 2, applied_domain_event_keys: ['online:event'] });
    const before = structuredClone(h.session);
    await h.online();
    assert.equal(h.session.status, before.status);
    assert.deepEqual(h.session.ended_at, before.ended_at);
    assert.equal(h.state.updateCount, 0);
});

for (const status of ['live', 'offline', 'orphaned']) {
    test(`late online cannot reopen an orphan superseded by a newer ${status} session`, async t => {
        const h = setup(t);
        Object.assign(h.session, { status: 'orphaned', ended_at: new Date('2026-09-05T12:10:00Z'), consecutive_offline_checks: 2 });
        const newer = { ...h.session, _id: new Types.ObjectId(), stream_id: 'newer',
            started_at: new Date('2026-09-05T13:00:00Z'), status,
            ended_at: status === 'live' ? null : new Date('2026-09-05T13:30:00Z'), applied_domain_event_keys: [] };
        h.state.otherSessions.push(newer);
        const before = { ...newer };
        await h.online();
        assert.equal(h.session.status, 'orphaned');
        assert.equal(h.session.ended_at.toISOString(), '2026-09-05T12:10:00.000Z');
        assert.deepEqual(h.session.applied_domain_event_keys, ['online:event']);
        assert.deepEqual(newer, before);
        assert.deepEqual(h.state.calls, []);
    });
}

test('an orphan without snapshot evidence remains closed', async t => {
    const h = setup(t);
    Object.assign(h.session, { status: 'orphaned', ended_at: new Date('2026-09-05T12:10:00Z'), consecutive_offline_checks: 0 });
    await h.online();
    assert.equal(h.session.status, 'orphaned');
    assert.deepEqual(h.session.applied_domain_event_keys, ['online:event']);
});

test('a lost snapshot-recovery response replays by receipt without another lifecycle mutation', async t => {
    const h = setup(t);
    Object.assign(h.session, { status: 'orphaned', ended_at: new Date('2026-09-05T12:10:00Z'), consecutive_offline_checks: 2 });
    h.state.updateLost = true;
    await assert.rejects(h.online(), /Session update response lost/);
    assert.equal(h.session.status, 'live');
    await h.online();
    assert.equal(h.state.updateCount, 1);
    await h.run();
    assert.deepEqual(h.state.calls, ['summary', 'clips']);
});

test('a genuine offline transition racing snapshot recovery is not overwritten', async t => {
    const h = setup(t);
    Object.assign(h.session, { status: 'orphaned', ended_at: new Date('2026-09-05T12:10:00Z'), consecutive_offline_checks: 2 });
    h.state.beforeUpdate = () => { h.session.status = 'offline'; };
    await assert.rejects(h.online(), /Session changed/);
    assert.equal(h.session.status, 'offline');
    assert.deepEqual(h.session.applied_domain_event_keys, []);
});

test('an orphan with offline completion evidence cannot be treated as a provisional end', async t => {
    const h = setup(t);
    Object.assign(h.session, { status: 'orphaned', ended_at: new Date('2026-09-05T12:10:00Z'),
        consecutive_offline_checks: 2, offline_summary_enqueued_at: new Date() });
    await h.online();
    assert.equal(h.session.status, 'orphaned');
    assert.deepEqual(h.session.applied_domain_event_keys, ['online:event']);
});

for (const status of ['orphaned', 'offline']) {
    test(`closed ${status} online cannot orphan a different earlier live session`, async t => {
        const h = setup(t);
        Object.assign(h.session, { status, ended_at: new Date('2026-09-05T12:10:00Z'), consecutive_offline_checks: 2 });
        const other = { ...h.session, _id: new Types.ObjectId(), stream_id: 'other', status: 'live', ended_at: null,
            started_at: new Date('2026-09-05T11:00:00Z'), applied_domain_event_keys: [] };
        h.state.otherSessions.push(other);
        await h.online();
        assert.equal(other.status, 'live');
        assert.equal(other.ended_at, null);
        assert.equal(h.session.status, status);
        assert.deepEqual(h.state.calls, []);
    });
}

for (const status of ['live', 'offline', 'orphaned']) {
    test(`an unseen old online is recorded as history behind a newer ${status} session`, async t => {
        const h = setup(t);
        h.state.absent = true;
        const other = { ...h.session, _id: new Types.ObjectId(), stream_id: 'newer', status,
            started_at: new Date('2026-09-05T13:00:00Z'),
            ended_at: status === 'live' ? null : new Date('2026-09-05T13:30:00Z'), applied_domain_event_keys: [] };
        h.state.otherSessions.push(other);
        await h.online();
        assert.equal(h.session.status, 'orphaned');
        assert.equal(h.session.ended_at.toISOString(), '2026-09-05T13:00:00.000Z');
        assert.deepEqual(h.session.applied_domain_event_keys, ['online:event']);
        assert.equal(other.status, status);
        assert.deepEqual(other.applied_domain_event_keys, []);
        assert.deepEqual(h.state.calls, []);
    });
}

for (const status of ['orphaned', 'offline', 'live']) {
    test(`zero-match online ${status} update cannot announce success`, async t => {
        const h = setup(t);
        Object.assign(h.session, { status, ended_at: status === 'live' ? null : new Date('2026-09-05T12:10:00Z'),
            consecutive_offline_checks: 2 });
        h.state.removedDuringUpdate = true;
        await assert.rejects(h.online());
        assert.deepEqual(h.session.applied_domain_event_keys, []);
        assert.deepEqual(h.state.calls, []);
    });
}

test('a new online session records its receipt and can complete the distinct offline event', async t => {
    const h = setup(t);
    h.state.absent = true;
    await h.online();
    assert.equal(h.session.status, 'live');
    assert.deepEqual(h.session.applied_domain_event_keys, ['online:event']);
    await h.run();
    assert.deepEqual(h.state.calls, ['summary', 'clips']);
});

test('online creation cannot overwrite a genuinely offline session inserted after its reads', async t => {
    const h = setup(t);
    h.state.absent = true;
    h.state.beforeUpdate = () => {
        h.state.absent = false;
        h.session.status = 'offline';
        h.session.ended_at = new Date('2026-09-05T12:10:00Z');
    };
    await assert.rejects(h.online(), /Duplicate stream identity/);
    assert.equal(h.session.status, 'offline');
    assert.deepEqual(h.session.applied_domain_event_keys, []);
});

test('online creation returning no session cannot announce success', async t => {
    const h = setup(t);
    h.state.absent = true;
    h.state.removedDuringUpdate = true;
    await assert.rejects(h.online(), /Session changed while creating/);
    assert.deepEqual(h.session.applied_domain_event_keys, []);
});

test('offline without a session defers, then the same event finishes after a delayed session appears', async t => {
    const h = setup(t);
    h.state.absent = true;
    await assert.rejects(h.run(), { name: 'DomainEventPrerequisiteMissingError' });
    assert.deepEqual(h.state.calls, []);
    h.state.absent = false;
    await h.run();
    assert.equal(h.state.updateCount, 1);
    assert.deepEqual(h.state.calls, ['summary', 'clips']);
    assert.ok(h.session.offline_summary_enqueued_at instanceof Date);
    assert.ok(h.session.offline_clips_completed_at instanceof Date);
});

test('lost session-update response resumes side effects without updating the session again', async t => {
    const h = setup(t);
    h.state.updateLost = true;
    await assert.rejects(h.run(), /Session update response lost/);
    assert.deepEqual(h.state.calls, []);
    assert.equal(h.session.offline_summary_enqueued_at, null);
    await h.run();
    await h.run();
    assert.equal(h.state.updateCount, 1);
    assert.deepEqual(h.state.calls, ['summary', 'clips']);
});

test('summary enqueue failure after session mutation is not swallowed or mistaken for completed work', async t => {
    const h = setup(t);
    h.state.failEnqueue = 'summary';
    await assert.rejects(h.run(), /summary unavailable/);
    assert.equal(h.session.status, 'offline');
    assert.equal(h.session.offline_summary_enqueued_at, null);
    assert.equal(h.session.offline_clips_completed_at, null);
    h.state.failEnqueue = '';
    await h.run();
    assert.deepEqual(h.state.calls, ['summary', 'summary', 'clips']);
    assert.equal(h.state.accepted.size, 2);
});

test('partial enqueue success skips the acknowledged summary even after queue dedupe expires', async t => {
    const h = setup(t);
    h.state.failEnqueue = 'clips';
    await assert.rejects(h.run(), /clips unavailable/);
    assert.ok(h.session.offline_summary_enqueued_at);
    assert.equal(h.session.offline_clips_completed_at, null);
    h.state.accepted.clear();
    h.state.failEnqueue = '';
    // A lifecycle correction must not hide the applied event's session from replay.
    h.session.ended_at = new Date('2026-09-05T13:00:00Z');
    await h.run();
    assert.deepEqual(h.state.calls, ['summary', 'clips', 'clips']);
    assert.equal(h.state.updateCount, 1);
});

for (const [step, receipt] of [['summary', 'offline_summary_enqueued_at'], ['clips', 'offline_clips_completed_at']] as const) {
    test(`${step}: lost enqueue acknowledgement retries the same dedupe identity before recording completion`, async t => {
        const h = setup(t);
        h.state.loseEnqueue = step;
        await assert.rejects(h.run(), /Enqueue response lost/);
        assert.equal(h.session[receipt], null);
        await h.run();
        await h.run();
        assert.equal(h.state.accepted.size, 2);
        assert.equal(h.state.calls.filter(s => s === step).length, 2);
    });

    test(`${step}: a persisted completion receipt survives its lost response`, async t => {
        const h = setup(t);
        h.state.loseReceipt = receipt;
        await assert.rejects(h.run(), /Receipt response lost/);
        assert.ok(h.session[receipt]);
        h.state.accepted.clear();
        await h.run();
        assert.equal(h.state.calls.filter(s => s === step).length, 1);
    });
}

test('config errors retry, while intentional clip opt-out is durably completed', async t => {
    const h = setup(t);
    h.state.configFailure = true;
    await assert.rejects(h.run(), /Config unavailable/);
    assert.equal(h.session.offline_clips_completed_at, null);
    h.state.configFailure = false;
    h.state.enabled = false;
    await h.run();
    assert.ok(h.session.offline_clips_completed_at);
    h.state.enabled = true;
    await h.run();
    assert.deepEqual(h.state.calls, ['summary']);
});

test('a failed receipt write keeps delivery unfinished and retries accepted enqueue safely', async t => {
    const h = setup(t);
    h.state.failReceipt = 'offline_summary_enqueued_at';
    await assert.rejects(h.run(), /Receipt write failed/);
    assert.equal(h.session.offline_summary_enqueued_at, null);
    assert.equal(h.state.accepted.size, 1);
    h.state.failReceipt = '';
    await h.run();
    assert.deepEqual(h.state.calls, ['summary', 'summary', 'clips']);
    assert.equal(h.state.accepted.size, 2);
});

test('a zero-match session update is not proof of duplicate application', async t => {
    const h = setup(t);
    h.state.removedDuringUpdate = true;
    await assert.rejects(h.run());
    assert.deepEqual(h.state.calls, []);
});

test('ordinary offline callers without event keys still ignore absent sessions', async t => {
    const h = setup(t);
    h.state.absent = true;
    await recordStreamOfflineEvent({ channelID: 'channel' });
    assert.deepEqual(h.state.calls, []);
});

test('public bits/follows/subs helpers propagate prerequisite deferrals without fabricating sessions', async t => {
    const h = setup(t);
    h.state.absent = true;
    t.mock.method(StreamSessionSchema, 'findOneAndUpdate', (() => query(null)) as never);
    for (const record of [recordStreamBitsEvent, recordStreamFollowEvent, recordStreamSubEvent]) {
        await assert.rejects(record({ channelID: 'channel', eventKey: 'metric', bits: 10 }), { name: 'DomainEventPrerequisiteMissingError' });
        await record({ channelID: 'channel', bits: 10 });
    }
});

test('the delivery engine only completes offline work after both downstream step receipts', async t => {
    const h = setup(t);
    const event = new DomainEventSchema({
        eventKey: 'offline:event', topic: 'channel', type: 'stream.ended',
        journaledAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000)
    });
    let delivery: any = { _id: new Types.ObjectId(), eventID: event._id, status: 'pending', attempts: 0 };
    t.mock.method(DomainEventDeliverySchema, 'find', (() => query([delivery])) as never);
    t.mock.method(DomainEventSchema, 'findById', (() => query(event)) as never);
    t.mock.method(DomainEventSchema, 'find', (() => query([])) as never);
    t.mock.method(DomainEventCheckpointSchema, 'findOne', (() => query(null)) as never);
    t.mock.method(DomainEventDeliverySchema, 'findOneAndUpdate', ((_filter: any, update: any) => {
        if (update.$setOnInsert) return query({ ...delivery });
        delivery = { ...delivery, ...update.$set, attempts: delivery.attempts + 1 };
        return query({ ...delivery });
    }) as never);
    t.mock.method(DomainEventDeliverySchema, 'updateOne', (async (_filter: any, update: any) => {
        if (update.$set.status === 'succeeded') {
            assert.ok(h.session.offline_summary_enqueued_at);
            assert.ok(h.session.offline_clips_completed_at);
        }
        Object.assign(delivery, update.$set);
        return { modifiedCount: 1 };
    }) as never);
    const drain = () => drainDomainEvents({ consumer: 'stage2-offline', topics: ['channel'], handler: h.run });
    h.state.failEnqueue = 'clips';
    assert.equal((await drain()).retried, 1);
    assert.equal(delivery.status, 'retry');
    assert.equal(delivery.completedAt, null);
    assert.ok(h.session.offline_summary_enqueued_at);
    assert.equal(h.session.offline_clips_completed_at, null);
    delivery.nextAttemptAt = new Date(0);
    h.state.failEnqueue = '';
    assert.equal((await drain()).succeeded, 1);
    assert.equal(delivery.status, 'succeeded');
    assert.deepEqual(h.state.calls, ['summary', 'clips', 'clips']);
});
