import assert from 'node:assert/strict';
import test from 'node:test';
import { StreamSessionSchema } from '../schemas/stream_session.schema.js';
import { incrementSessionMetricAtEventTime } from './stream_session_event_projection.js';

for (const field of ['bits', 'follows', 'subs'] as const) {
    test(`${field}: absent session defers, delayed session applies once, response loss remains deduplicated`, async t => {
        let session = false;
        let total = 0;
        const receipts = new Set<string>();
        let loseResponse = false;
        t.mock.method(StreamSessionSchema, 'findOne', (() => ({
            sort() { return this; }, select() { return this; }, lean: async () => session ? { _id: 'session' } : null
        })) as never);
        t.mock.method(StreamSessionSchema, 'exists', (async (filter: any) => {
            assert.equal(filter.channelID, 'channel');
            return receipts.has(filter.applied_domain_event_keys) ? { _id: 'session' } : null;
        }) as never);
        t.mock.method(StreamSessionSchema, 'findOneAndUpdate', ((filter: any, update: any, options: any) => ({
            select() { return this; },
            async lean() {
                assert.equal(filter._id, 'session');
                assert.deepEqual(filter.started_at, { $lte: new Date('2026-09-05T12:00:00Z') });
                assert.deepEqual(filter.$or, [{ ended_at: null }, { ended_at: { $gte: new Date('2026-09-05T12:00:00Z') } }]);
                assert.deepEqual(options.writeConcern, { w: 1, j: true });
                const key = filter.applied_domain_event_keys.$ne;
                if (!session || receipts.has(key)) return null;
                total += update.$inc[field];
                assert.equal(update.$addToSet.applied_domain_event_keys, key);
                receipts.add(key);
                if (loseResponse) throw new Error('Metric response lost');
                return { _id: 'session' };
            }
        })) as never);
        const input = { channelID: 'channel', occurredAt: new Date('2026-09-05T12:00:00Z'), eventKey: `event:${field}`, field, quantity: 5 };
        await assert.rejects(incrementSessionMetricAtEventTime(input), { name: 'DomainEventPrerequisiteMissingError' });
        assert.equal(total, 0);
        session = true;
        assert.equal(await incrementSessionMetricAtEventTime(input), 'applied');
        assert.equal(await incrementSessionMetricAtEventTime(input), 'already-applied');
        assert.equal(total, 5);
        loseResponse = true;
        const next = { ...input, eventKey: `next:${field}` };
        await assert.rejects(incrementSessionMetricAtEventTime(next), /Metric response lost/);
        session = false; // A changed time window must not turn a receipt into a missing prerequisite.
        assert.equal(await incrementSessionMetricAtEventTime(next), 'already-applied');
        assert.equal(total, 10);
    });
}

test('historical callers without an event key keep the benign offline-window outcome', async t => {
    t.mock.method(StreamSessionSchema, 'findOneAndUpdate', (() => ({
        select() { return this; }, lean: async () => null
    })) as never);
    t.mock.method(StreamSessionSchema, 'exists', (() => assert.fail('No journal receipt lookup for historical callers')) as never);
    assert.equal(await incrementSessionMetricAtEventTime({ channelID: 'channel', field: 'follows', quantity: 1 }), false);
});

test('a racing duplicate cannot fall through to an older overlapping session', async t => {
    let applied = false;
    t.mock.method(StreamSessionSchema, 'exists', (async () => applied ? { _id: 'newest' } : null) as never);
    t.mock.method(StreamSessionSchema, 'findOne', ((filter: any) => {
        assert.equal(filter.applied_domain_event_keys, undefined, 'select the target without excluding already-applied sessions');
        return { sort() { return this; }, select() { return this; }, lean: async () => ({ _id: 'newest' }) };
    }) as never);
    t.mock.method(StreamSessionSchema, 'findOneAndUpdate', ((filter: any) => {
        assert.equal(filter._id, 'newest');
        applied = true; // Another execution won the atomic update of this same session.
        return { select() { return this; }, lean: async () => null };
    }) as never);
    assert.equal(await incrementSessionMetricAtEventTime({
        channelID: 'channel', eventKey: 'race', field: 'bits', quantity: 10
    }), 'already-applied');
});
