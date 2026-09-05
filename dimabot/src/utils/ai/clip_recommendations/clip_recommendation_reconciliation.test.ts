import assert from 'node:assert/strict';
import { mock, test, type TestContext } from 'node:test';
import type { EnqueueCronJobInput, EnqueueCronJobResult } from '../../cron_jobs_queue.js';

type Snapshot = Record<string, unknown> & {
    _id: string;
    queueJobID?: string | null;
    status: string;
    billingStatus: string;
};

const mockModel = {
    find(_filter: Record<string, unknown>): unknown { return assert.fail('Unexpected find'); },
    updateOne(_filter: Record<string, unknown>, _update: Record<string, unknown>): unknown {
        return assert.fail('Unexpected update');
    }
};

// Mock before importing the real reconciler so no database or queue client is loaded.
mock.module('../../../schemas/clip_recommendation.schema.js', {
    namedExports: { ClipRecommendationSchema: mockModel }
});
mock.module('../../cron_jobs_queue.js', {
    namedExports: {
        enqueueCronJob: () => assert.fail('Must use the injected enqueue'),
        getCronJobDedupeKey: () => assert.fail('Must not use the normal clip producer')
    }
});
const { reconcileClipRecommendations } = await import('./clip_recommendation_reconciliation.js');

const now = Date.UTC(2026, 8, 5, 12);
const intervalMs = 15 * 60_000;

function recommendation(overrides: Partial<Snapshot> = {}): Snapshot {
    return {
        _id: 'recommendation-1',
        queueJobID: 'original-queue-job',
        channelID: 'channel-123',
        channel: 'example-channel',
        sessionID: 'accepted-session-123',
        streamID: 'stream-123',
        vodID: '123',
        vodUrl: 'https://www.twitch.tv/videos/123',
        vodDurationMinutes: 90,
        source: 'stream_offline',
        status: 'completed',
        billingStatus: 'pending',
        notificationStatus: 'pending',
        ...overrides
    };
}

function fixture(t: TestContext, recommendations: Snapshot[] = []) {
    t.mock.timers.enable({ apis: ['Date'], now });
    const query = {
        sort: mock.fn((_sort: Record<string, number>): unknown => query),
        limit: mock.fn((_limit: number): unknown => query),
        select: mock.fn((_fields: string): unknown => query),
        lean: mock.fn((): unknown => query),
        exec: mock.fn(async () => recommendations)
    };
    const find = t.mock.method(mockModel, 'find', (_filter: Record<string, unknown>) => query);
    const updateExec = mock.fn(async () => ({ matchedCount: 1, modifiedCount: 1 }));
    const updateOne = t.mock.method(mockModel, 'updateOne', (
        _filter: Record<string, unknown>, _update: Record<string, unknown>
    ) => ({ exec: updateExec }));
    const enqueue = mock.fn(async (input: EnqueueCronJobInput): Promise<EnqueueCronJobResult> => ({
        enqueued: true,
        message: 'Queued',
        job: { id: 'new-recovery-job', job: input.job, requestedAt: new Date().toISOString() }
    }));
    return { query, find, updateOne, updateExec, enqueue };
}

test('queries pending and failed billing, charged notifications, and uncharged failed cleanup only when due', async (t) => {
    const { query, find, enqueue, updateOne } = fixture(t);
    assert.equal(await reconcileClipRecommendations({ enqueue }), 0);
    assert.equal(find.mock.callCount(), 1);
    assert.deepEqual(find.mock.calls[0].arguments[0], {
        queueJobID: { $type: 'string', $ne: '' },
        $or: [
            {
                status: 'completed',
                analysisCompletedAt: { $ne: null },
                $or: [
                    {
                        billingStatus: { $in: ['pending', 'failed'] },
                        $or: [{ billingNextRetryAt: null }, { billingNextRetryAt: { $lte: new Date(now) } }]
                    },
                    {
                        billingStatus: 'charged',
                        notificationStatus: { $in: ['pending', 'failed'] },
                        $or: [{ notificationNextRetryAt: null }, { notificationNextRetryAt: { $lte: new Date(now) } }]
                    }
                ]
            },
            {
                status: 'failed',
                analysisCompletedAt: null,
                billingStatus: { $ne: 'charged' },
                previewCleanupPending: true,
                $or: [{ previewCleanupNextRetryAt: null }, { previewCleanupNextRetryAt: { $lte: new Date(now) } }]
            }
        ]
    });
    assert.deepEqual(query.sort.mock.calls[0].arguments, [{ updated_at: 1 }]);
    assert.deepEqual(query.limit.mock.calls[0].arguments, [25]);
    assert.equal(query.select.mock.callCount(), 1);
    assert.equal(query.lean.mock.callCount(), 1);
    assert.equal(query.exec.mock.callCount(), 1);
    assert.equal(enqueue.mock.callCount(), 0);
    assert.equal(updateOne.mock.callCount(), 0);
});

for (const source of ['stream_offline', 'manual']) {
    for (const status of ['completed', 'failed']) {
        test(`${source} ${status} recovery preserves the original job and session without cloning user or candidate data`, async (t) => {
            const rec = recommendation({ source, status, queueJobID: '  original-queue-job  ' });
            for (const field of ['user', 'userData', 'candidates']) {
                Object.defineProperty(rec, field, {
                    enumerable: true,
                    get: () => assert.fail(`Must not read or clone ${field}`)
                });
            }
            const { enqueue, query } = fixture(t, [rec]);
            assert.equal(await reconcileClipRecommendations({ enqueue }), 1);
            assert.deepEqual(enqueue.mock.calls[0].arguments[0], {
                job: 'clip-recommendation-analysis',
                requestedBy: 'clip-recommendation-reconciliation',
                channelID: 'channel-123',
                queueKey: 'cron:clip-recommendations:queue',
                dedupeToken: 'clip-recommendation-recovery:original-queue-job',
                dedupeSeconds: 3600,
                data: {
                    recommendationQueueJobID: 'original-queue-job',
                    recoveryMode: status === 'failed' ? 'cleanup' : 'completion',
                    channelID: 'channel-123',
                    channel: 'example-channel',
                    sessionID: 'accepted-session-123',
                    streamID: 'stream-123',
                    vodID: '123',
                    vodUrl: 'https://www.twitch.tv/videos/123',
                    vodDurationMinutes: 90,
                    source: 'recovery',
                    originalSource: source
                }
            });
            const fields = query.select.mock.calls[0].arguments[0].split(/\s+/);
            assert.deepEqual(new Set(fields), new Set([
                'queueJobID', 'channelID', 'channel', 'sessionID', 'streamID', 'vodID', 'vodUrl',
                'vodDurationMinutes', 'source', 'status', 'billingStatus', 'notificationStatus',
                'billingNextRetryAt', 'notificationNextRetryAt', 'previewCleanupNextRetryAt'
            ]));
            assert.equal(rec.queueJobID, '  original-queue-job  ');
            assert.equal(rec.source, source);
        });
    }
}

for (const [status, billingStatus, retryField] of [
    ['completed', 'pending', 'billingNextRetryAt'],
    ['completed', 'failed', 'billingNextRetryAt'],
    ['completed', 'charged', 'notificationNextRetryAt'],
    ['failed', 'pending', 'previewCleanupNextRetryAt'],
    ['failed', 'failed', 'previewCleanupNextRetryAt']
]) {
    for (const deadline of [undefined, null, new Date(now - 60_000), new Date(now)]) {
        test(`${status}/${billingStatus} rotates ${retryField} with the ${String(deadline)} snapshot CAS guard`, async (t) => {
            const rec = recommendation({ status, billingStatus, [retryField]: deadline });
            const { enqueue, updateOne, updateExec } = fixture(t, [rec]);
            await reconcileClipRecommendations({ enqueue });
            assert.equal(updateOne.mock.callCount(), 1);
            assert.deepEqual(updateOne.mock.calls[0].arguments, [
                { _id: rec._id, status, billingStatus, [retryField]: deadline ?? null },
                { $set: { [retryField]: new Date(now + intervalMs) } }
            ]);
            assert.equal(updateExec.mock.callCount(), 1);
            assert.equal(rec[retryField], deadline);
        });
    }
}

test('counts successful enqueues, but rotates deduplicated records too so they do not monopolize the next batch', async (t) => {
    const records = Array.from({ length: 3 }, (_, i) => recommendation({ _id: `rec-${i}`, queueJobID: `job-${i}` }));
    const { enqueue, updateOne, updateExec } = fixture(t, records);
    enqueue.mock.mockImplementationOnce(async (input) => ({
        enqueued: false, message: 'Already queued',
        job: { id: 'existing-recovery-job', job: input.job, requestedAt: new Date().toISOString() }
    }), 1);
    assert.equal(await reconcileClipRecommendations({ enqueue, intervalMs: 30 * 60_000 }), 2);
    assert.equal(enqueue.mock.callCount(), 3);
    assert.equal(updateExec.mock.callCount(), 3);
    assert.deepEqual(updateOne.mock.calls.map((call) => call.arguments[0]._id), ['rec-0', 'rec-1', 'rec-2']);
    for (const call of updateOne.mock.calls) {
        assert.deepEqual(call.arguments[1], { $set: { billingNextRetryAt: new Date(now + 30 * 60_000) } });
    }
    assert.ok(enqueue.mock.calls.every((call) => call.arguments[0].dedupeSeconds === 7200));
});

test('a lost CAS race does not overwrite a newer workflow deadline or stop the remaining batch', async (t) => {
    const snapshotDeadline = new Date(now - 1);
    let persistedDeadline = snapshotDeadline;
    const rec = recommendation({ billingNextRetryAt: snapshotDeadline });
    const { enqueue, updateOne, updateExec } = fixture(t, [rec, recommendation({ _id: 'rec-2' })]);
    enqueue.mock.mockImplementationOnce(async (input) => {
        persistedDeadline = new Date(now + 2 * intervalMs);
        return { enqueued: true, message: 'Queued', job: { id: 'recovery-job', job: input.job, requestedAt: new Date().toISOString() } };
    });
    updateExec.mock.mockImplementationOnce(async () => {
        const [filter, update] = updateOne.mock.calls[0].arguments;
        assert.equal(filter.billingNextRetryAt, snapshotDeadline);
        if (filter.billingNextRetryAt === persistedDeadline) {
            persistedDeadline = (update.$set as { billingNextRetryAt: Date }).billingNextRetryAt;
            return { matchedCount: 1, modifiedCount: 1 };
        }
        return { matchedCount: 0, modifiedCount: 0 };
    });
    assert.equal(await reconcileClipRecommendations({ enqueue }), 2);
    assert.equal(persistedDeadline.getTime(), now + 2 * intervalMs);
    assert.equal(updateExec.mock.callCount(), 2);
});

test('shutdown before iteration prevents enqueue and retry updates', async (t) => {
    const { enqueue, updateOne } = fixture(t, [recommendation()]);
    assert.equal(await reconcileClipRecommendations({ enqueue, shouldContinue: () => false }), 0);
    assert.equal(enqueue.mock.callCount(), 0);
    assert.equal(updateOne.mock.callCount(), 0);
});

test('shutdown during enqueue finishes that record but stops before the next one', async (t) => {
    const { enqueue, updateOne } = fixture(t, [recommendation(), recommendation({ _id: 'rec-2' })]);
    let running = true;
    enqueue.mock.mockImplementationOnce(async (input) => {
        running = false;
        return { enqueued: true, message: 'Queued', job: { id: 'recovery-job', job: input.job, requestedAt: new Date().toISOString() } };
    });
    assert.equal(await reconcileClipRecommendations({ enqueue, shouldContinue: () => running }), 1);
    assert.equal(enqueue.mock.callCount(), 1);
    assert.equal(updateOne.mock.callCount(), 1);
});

test('enqueue failure propagates without overwriting its retry deadline or processing later records', async (t) => {
    const deadline = new Date(now - 1);
    const rec = recommendation({ billingNextRetryAt: deadline });
    const { enqueue, updateOne, updateExec } = fixture(t, [rec, recommendation({ _id: 'rec-2' })]);
    const failure = new Error('Injected enqueue failure');
    enqueue.mock.mockImplementationOnce(async () => { throw failure; });
    await assert.rejects(reconcileClipRecommendations({ enqueue }), (error: unknown) => error === failure);
    assert.equal(enqueue.mock.callCount(), 1);
    assert.equal(updateOne.mock.callCount(), 0);
    assert.equal(updateExec.mock.callCount(), 0);
    assert.equal(rec.billingNextRetryAt, deadline);
});

test('missing, empty, and whitespace-only queue IDs are skipped without retry writes', async (t) => {
    const { enqueue, updateOne } = fixture(t, [
        ...[undefined, null, '', '   '].map((queueJobID) => recommendation({ queueJobID })),
        recommendation()
    ]);
    assert.equal(await reconcileClipRecommendations({ enqueue }), 1);
    assert.equal(enqueue.mock.callCount(), 1);
    assert.equal(updateOne.mock.callCount(), 1);
});

for (const [batchSize, expected] of [[undefined, 25], [-10, 1], [0, 1], [1, 1], [37, 37], [500, 500], [501, 500]]) {
    test(`batch size ${String(batchSize)} applies a bounded database limit of ${expected}`, async (t) => {
        const { enqueue, query } = fixture(t);
        await reconcileClipRecommendations({ enqueue, batchSize });
        assert.equal(query.limit.mock.callCount(), 1);
        assert.deepEqual(query.limit.mock.calls[0].arguments, [expected]);
    });
}
