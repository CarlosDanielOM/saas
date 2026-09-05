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
const { recordStreamOfflineEvent, recordStreamBitsEvent, recordStreamFollowEvent, recordStreamSubEvent } = await import('./stream_analytics.js');
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
        removedDuringUpdate: false
    };
    t.mock.method(StreamSessionSchema, 'findOne', ((filter: any) => {
        assert.equal(filter.channelID, 'channel');
        const matches = !state.absent && (filter.applied_domain_event_keys
            ? session.applied_domain_event_keys.includes(filter.applied_domain_event_keys)
            : session.started_at <= filter.started_at.$lte && (!session.ended_at || session.ended_at >= filter.started_at.$lte));
        return query(matches ? { ...session, applied_domain_event_keys: [...session.applied_domain_event_keys] } : null);
    }) as never);
    t.mock.method(StreamSessionSchema, 'exists', ((filter: any) => query(!state.absent &&
        session.applied_domain_event_keys.includes(filter.applied_domain_event_keys) ? { _id: session._id } : null)) as never);
    t.mock.method(StreamSessionSchema, 'updateOne', (async (filter: any, update: any, options: any) => {
        assert.deepEqual(options.writeConcern, { w: 1, j: true });
        if (state.removedDuringUpdate) { state.absent = true; return { matchedCount: 0, modifiedCount: 0 }; }
        if (update.$set.status) {
            if (state.failUpdate) throw new Error('Session update failed');
            if (session.applied_domain_event_keys.includes(filter.applied_domain_event_keys?.$ne)) return { matchedCount: 0, modifiedCount: 0 };
            state.updateCount++;
            Object.assign(session, update.$set);
            if (update.$addToSet) session.applied_domain_event_keys.push(update.$addToSet.applied_domain_event_keys);
            if (state.updateLost) { state.updateLost = false; throw new Error('Session update response lost'); }
        } else {
            const field = Object.keys(update.$set)[0];
            assert.equal(filter.applied_domain_event_keys, 'offline:event');
            if (state.failReceipt === field) throw new Error('Receipt write failed');
            Object.assign(session, update.$set);
            if (state.loseReceipt === field) { state.loseReceipt = ''; throw new Error('Receipt response lost'); }
        }
        return { matchedCount: 1, modifiedCount: 1 };
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
    return { state, session, run: () => recordStreamOfflineEvent(input) };
}

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
    assert.equal(delivery.completedAt, undefined);
    assert.ok(h.session.offline_summary_enqueued_at);
    assert.equal(h.session.offline_clips_completed_at, null);
    delivery.nextAttemptAt = new Date(0);
    h.state.failEnqueue = '';
    assert.equal((await drain()).succeeded, 1);
    assert.equal(delivery.status, 'succeeded');
    assert.deepEqual(h.state.calls, ['summary', 'clips', 'clips']);
});
