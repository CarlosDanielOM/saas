import assert from 'node:assert/strict';
import test from 'node:test';
import type { CronQueueJob } from '../../cron_jobs_queue.js';
import { getClipJobFailureDisposition, shouldStopAfterHeartbeatFailure } from './vod_clip_recommender_policy.js';

const job: CronQueueJob = {
    id: 'job-1',
    job: 'clip-recommendation-analysis',
    requestedAt: '2026-09-02T00:00:00.000Z',
    data: { attempt: 1 }
};

test('a failed job is requeued with an incremented attempt below the cap', () => {
    const disposition = getClipJobFailureDisposition(job, 2);
    assert.equal(disposition.action, 'requeue');
    assert.equal(disposition.attempt, 2);
    assert.equal(disposition.job.data?.attempt, 2);
});

test('a failed job is dead-lettered at the attempt cap', () => {
    const disposition = getClipJobFailureDisposition({
        ...job,
        data: { attempt: 2 }
    }, 2);
    assert.equal(disposition.action, 'dead-letter');
    assert.equal(disposition.attempt, 2);
});

test('an invalid attempt cap fails closed to one attempt', () => {
    const disposition = getClipJobFailureDisposition(job, Number.NaN);
    assert.equal(disposition.action, 'dead-letter');
    assert.equal(disposition.attempt, 1);
});

test('a transient heartbeat failure is tolerated until the configured limit', () => {
    assert.equal(shouldStopAfterHeartbeatFailure(1, 3), false);
    assert.equal(shouldStopAfterHeartbeatFailure(2, 3), false);
    assert.equal(shouldStopAfterHeartbeatFailure(3, 3), true);
});
