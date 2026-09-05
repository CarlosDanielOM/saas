import { ClipRecommendationSchema } from '../../../schemas/clip_recommendation.schema.js';
import { enqueueCronJob } from '../../cron_jobs_queue.js';
import { CLIP_RECOMMENDATION_ANALYSIS_JOB, CLIP_RECOMMENDATIONS_QUEUE_KEY } from './clip_recommendations_queue.js';

export async function reconcileClipRecommendations({
    batchSize = 25,
    intervalMs = 15 * 60_000,
    shouldContinue = () => true,
    enqueue = enqueueCronJob
}: {
    batchSize?: number;
    intervalMs?: number;
    shouldContinue?: () => boolean;
    enqueue?: typeof enqueueCronJob;
} = {}): Promise<number> {
    const now = new Date();
    const due = (field: string) => ({ $or: [{ [field]: null }, { [field]: { $lte: now } }] });
    const recommendations = await ClipRecommendationSchema.find({
        queueJobID: { $type: 'string', $ne: '' },
        $or: [
            {
                status: 'completed', analysisCompletedAt: { $ne: null },
                $or: [
                    { billingStatus: { $in: ['pending', 'failed'] }, ...due('billingNextRetryAt') },
                    { billingStatus: 'charged', notificationStatus: { $in: ['pending', 'failed'] }, ...due('notificationNextRetryAt') }
                ]
            },
            {
                status: 'failed', analysisCompletedAt: null, billingStatus: { $ne: 'charged' },
                previewCleanupPending: true, ...due('previewCleanupNextRetryAt')
            }
        ]
    }).sort({ updated_at: 1 }).limit(Math.max(1, Math.min(500, batchSize)))
        .select('queueJobID channelID channel sessionID streamID vodID vodUrl vodDurationMinutes source status billingStatus notificationStatus billingNextRetryAt notificationNextRetryAt previewCleanupNextRetryAt')
        .lean().exec();

    let enqueued = 0;
    for (const recommendation of recommendations) {
        if (!shouldContinue()) break;
        const originalQueueJobID = recommendation.queueJobID?.trim();
        if (!originalQueueJobID) continue;
        const cleanup = recommendation.status === 'failed';
        const result = await enqueue({
            job: CLIP_RECOMMENDATION_ANALYSIS_JOB,
            requestedBy: 'clip-recommendation-reconciliation',
            channelID: recommendation.channelID,
            queueKey: CLIP_RECOMMENDATIONS_QUEUE_KEY,
            dedupeToken: `clip-recommendation-recovery:${originalQueueJobID}`,
            dedupeSeconds: Math.max(3600, Math.ceil(intervalMs * 4 / 1000)),
            data: {
                recommendationQueueJobID: originalQueueJobID,
                recoveryMode: cleanup ? 'cleanup' : 'completion',
                channelID: recommendation.channelID,
                channel: recommendation.channel,
                sessionID: recommendation.sessionID,
                streamID: recommendation.streamID,
                vodID: recommendation.vodID,
                vodUrl: recommendation.vodUrl,
                vodDurationMinutes: recommendation.vodDurationMinutes,
                // This retries an accepted job, not the one-shot stream-offline trigger.
                source: 'recovery',
                originalSource: recommendation.source
            }
        });
        if (result.enqueued) enqueued += 1;
        const retryField = cleanup ? 'previewCleanupNextRetryAt'
            : recommendation.billingStatus === 'charged' ? 'notificationNextRetryAt' : 'billingNextRetryAt';
        // Rotate already-queued records out of the next limited scan without
        // overwriting a newer retry deadline written by the running workflow.
        await ClipRecommendationSchema.updateOne({
            _id: recommendation._id,
            status: recommendation.status,
            billingStatus: recommendation.billingStatus,
            [retryField]: recommendation[retryField] ?? null
        }, { $set: { [retryField]: new Date(now.getTime() + intervalMs) } }).exec();
    }
    return enqueued;
}
