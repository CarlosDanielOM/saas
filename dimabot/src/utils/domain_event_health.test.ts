import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DomainEventDeliverySchema } from '../schemas/domain_event_delivery.schema.js';
import { DomainEventSchema } from '../schemas/domain_event.schema.js';
import { getDomainEventHealth, DOMAIN_EVENT_HEALTH_LIMIT, DOMAIN_EVENT_HEALTH_MAX_TIME_MS } from './domain_event_health.js';

const NOW = new Date('2026-09-05T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function fixture(t: TestContext, rows: Record<string, object> = {}) {
    const calls: { pipeline: any[]; options: any; journal: boolean }[] = [];
    for (const [model, journal] of [[DomainEventDeliverySchema, false], [DomainEventSchema, true]] as const) {
        t.mock.method(model, 'aggregate', ((pipeline: any[]) => ({
            option(options: any) {
                calls.push({ pipeline, options, journal });
                const row = rows[journal ? 'dispatch' : pipeline[0].$match.status];
                return Promise.resolve(row ? [row] : []);
            }
        })) as never);
    }
    return calls;
}

test('health reads independent indexed, bounded status buckets with no payload joins or cache', async t => {
    const calls = fixture(t);
    await getDomainEventHealth('polar-plan-v1', NOW);
    assert.equal(calls.length, 7);
    for (const { pipeline, options, journal } of calls) {
        assert.equal(options.maxTimeMS, DOMAIN_EVENT_HEALTH_MAX_TIME_MS);
        assert.equal(options.allowDiskUse, false);
        assert.deepEqual(pipeline[1], { $limit: DOMAIN_EVENT_HEALTH_LIMIT });
        assert.equal(pipeline.length, 4, 'no unbounded sort, lookup or facet before the limit');
        assert.deepEqual(pipeline[3], { $project: { _id: 0 } });
        if (journal) {
            assert.deepEqual(pipeline[0], { $match: { dispatchPending: true } });
            assert.deepEqual(options.hint, { dispatchPending: 1, _id: 1 });
            assert.deepEqual(pipeline[2].$group.oldestAt, { $min: '$journaledAt' });
        } else {
            assert.equal(pipeline[0].$match.consumer, 'polar-plan-v1');
            assert.deepEqual(options.hint, { consumer: 1, status: 1, nextAttemptAt: 1 });
        }
        assert.doesNotMatch(JSON.stringify(pipeline), /payload|lastError"|ownerUserId|subject\.id|leaseToken|\$lookup|\$bsonSize/);
    }
    assert.deepEqual(calls.filter(c => !c.journal).map(c => c.pipeline[0].$match.status),
        ['pending', 'processing', 'retry', 'succeeded', 'skipped', 'dead']);
});

test('counts preserve status meaning, report lag and label truncated samples as lower bounds', async t => {
    fixture(t, {
        retry: { count: 4, oldestAt: ago(90_000), oldestReadyAt: ago(60_000), dueRetries: 2,
            staleProcessing: 0, approachingExpiry: 1, expired: 1, prerequisiteMissing: 2,
            ownerUnresolved: 1, subjectUnresolved: 0, maxLastAttemptDurationMs: 350 },
        processing: { count: 3, oldestAt: ago(30_000), oldestReadyAt: ago(20_000), staleProcessing: 1 },
        skipped: { count: 10, oldestAt: ago(10_000) },
        dead: { count: 2, oldestAt: ago(10_000) },
        succeeded: { count: DOMAIN_EVENT_HEALTH_LIMIT, oldestAt: ago(86400_000) },
        dispatch: { count: 2, oldestAt: ago(5000), approachingExpiry: 1, expired: 0 }
    });
    const health = await getDomainEventHealth(undefined, NOW);
    assert.equal(health.consumer, null);
    assert.equal(health.asOf, NOW.toISOString());
    assert.equal(health.deliveries.retry.count, 4);
    assert.equal(health.deliveries.retry.dueRetries, 2);
    assert.equal(health.deliveries.retry.oldestAgeMs, 90_000);
    assert.equal(health.deliveries.retry.oldestReadyAgeMs, 60_000);
    assert.equal(health.deliveries.retry.ownerUnresolved, 1);
    assert.equal(health.deliveries.retry.maxLastAttemptDurationMs, 350);
    assert.equal(health.deliveries.processing.staleProcessing, 1);
    assert.equal(health.deliveries.succeeded.count, DOMAIN_EVENT_HEALTH_LIMIT, 'skipped/dead are not successes');
    assert.equal(health.deliveries.succeeded.capped, true);
    assert.equal(health.deliveries.retry.capped, false);
    assert.equal(health.dispatchPending.oldestAgeMs, 5000);
    assert.equal(health.deliveries.pending.oldestAgeMs, null, 'empty lag is unknown, not a fabricated zero');
    assert.equal(health.deliveries.pending.count, 0);
    assert.match(health.semantics, /lower bounds/);
});

test('due/stale/expiry predicates use the fixed request time and distinguish owner from subject prerequisites', async t => {
    const calls = fixture(t);
    await getDomainEventHealth(undefined, NOW);
    const group = (status: string) => calls.find(c => c.pipeline[0].$match.status === status)!.pipeline[2].$group;
    const countIf = (condition: unknown) => ({ $sum: { $cond: [condition, 1, 0] } });
    const due = { $lte: [{ $ifNull: ['$nextAttemptAt', NOW] }, NOW] };
    const stale = { $lte: [{ $ifNull: ['$lockedUntil', NOW] }, NOW] };
    assert.deepEqual(group('retry').dueRetries, countIf(due));
    assert.deepEqual(group('processing').staleProcessing, countIf(stale));
    assert.deepEqual(group('retry').oldestReadyAt, { $min: { $cond: [due, '$createdAt', null] } });
    assert.deepEqual(group('processing').oldestReadyAt, { $min: { $cond: [stale, '$createdAt', null] } });
    for (const status of ['pending', 'processing', 'retry']) {
        assert.deepEqual(group(status).approachingExpiry, countIf({ $and: [
            { $gt: ['$expiresAt', NOW] }, { $lte: ['$expiresAt', new Date(NOW.getTime() + 3600_000)] }
        ] }));
        assert.deepEqual(group(status).expired, countIf({ $lte: ['$expiresAt', NOW] }));
    }
    for (const status of ['succeeded', 'skipped', 'dead']) {
        assert.deepEqual(group(status).approachingExpiry, { $sum: 0 });
        assert.deepEqual(group(status).oldestReadyAt, { $min: { $cond: [false, '$createdAt', null] } });
    }
    for (const [metric, kind] of [['ownerUnresolved', 'owner'], ['subjectUnresolved', 'subject']]) {
        assert.deepEqual(group('retry')[metric], countIf({ $and: [
            { $eq: ['$lastErrorCode', 'prerequisite_missing'] }, { $eq: ['$lastPrerequisiteKind', kind] }
        ] }));
    }
    assert.deepEqual(calls[0].options.hint, { status: 1 });
});

test('a query timeout fails health rather than reporting empty healthy counts', async t => {
    fixture(t);
    t.mock.method(DomainEventDeliverySchema, 'aggregate', (() => ({
        option: async () => { throw new Error('query exceeded maxTimeMS'); }
    })) as never);
    await assert.rejects(getDomainEventHealth(undefined, NOW), /maxTimeMS/);
});

test('clock-skewed dates clamp lag to zero; an entirely empty journal is not successful work', async t => {
    fixture(t, { dispatch: { count: 1, oldestAt: ago(-1000) } });
    const health = await getDomainEventHealth(undefined, NOW);
    assert.equal(health.dispatchPending.oldestAgeMs, 0);
    assert.equal(health.deliveries.succeeded.count, 0);
    assert.equal(health.deliveries.succeeded.maxLastAttemptDurationMs, null);
});
