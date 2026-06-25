import { enqueueCronJob, getCronJobDedupeKey } from '../../cron_jobs_queue.js';

export const CLIP_RECOMMENDATIONS_QUEUE_KEY = 'cron:clip-recommendations:queue';
export const CLIP_RECOMMENDATIONS_DEAD_LETTER_KEY = 'cron:clip-recommendations:dead-letter';
export const CLIP_RECOMMENDATION_ANALYSIS_JOB = 'clip-recommendation-analysis';

const DEFAULT_DEDUPE_SECONDS = Math.max(60, Number(process.env.CLIP_RECOMMENDATIONS_DEDUPE_SECONDS || 6 * 60 * 60));

function normalizeValue(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

export interface EnqueueClipRecommendationJobInput {
    channelID: string;
    channel?: string;
    sessionID?: string;
    streamID?: string;
    vodID?: string;
    vodUrl: string;
    source: 'stream_offline' | 'manual';
    requestedBy?: string;
    vodDurationMinutes?: number;
    notBeforeUnix?: number;
}

export interface EnqueueClipRecommendationJobResult {
    enqueued: boolean;
    message: string;
    dedupeKey: string;
    job?: {
        id: string;
        job: string;
        requestedAt: string;
        requestedBy?: string;
        channelID?: string;
        accountID?: string;
        dedupeKey?: string;
        data?: Record<string, unknown>;
    };
}

export function getClipRecommendationDedupeKey(channelID: string, sessionID?: string, vodID?: string): string {
    const token = [
        'clip-recommendation-analysis',
        normalizeValue(channelID),
        normalizeValue(sessionID),
        normalizeValue(vodID)
    ].filter(Boolean).join(':');
    return getCronJobDedupeKey(token);
}

export async function enqueueClipRecommendationJob(
    input: EnqueueClipRecommendationJobInput
): Promise<EnqueueClipRecommendationJobResult> {
    const channelID = normalizeValue(input.channelID);
    const vodUrl = normalizeValue(input.vodUrl);
    const sessionID = normalizeValue(input.sessionID);
    const streamID = normalizeValue(input.streamID);
    const vodID = normalizeValue(input.vodID);

    if (!channelID) {
        return { enqueued: false, message: 'Invalid channel ID', dedupeKey: '' };
    }

    if (!vodUrl) {
        return { enqueued: false, message: 'Missing VOD URL', dedupeKey: '' };
    }

    const dedupeToken = [
        'clip-recommendation-analysis',
        channelID,
        sessionID,
        vodID || streamID || vodUrl
    ].filter(Boolean).join(':');

    const enqueueResult = await enqueueCronJob({
        job: CLIP_RECOMMENDATION_ANALYSIS_JOB,
        queueKey: CLIP_RECOMMENDATIONS_QUEUE_KEY,
        requestedBy: normalizeValue(input.requestedBy) || undefined,
        channelID,
        accountID: channelID,
        dedupeToken,
        dedupeSeconds: DEFAULT_DEDUPE_SECONDS,
        data: {
            channel: normalizeValue(input.channel),
            sessionID,
            streamID,
            vodID,
            vodUrl,
            source: input.source,
            vodDurationMinutes: Number(input.vodDurationMinutes || 0),
            notBeforeUnix: Number(input.notBeforeUnix || 0)
        }
    });

    return {
        enqueued: enqueueResult.enqueued,
        message: enqueueResult.message,
        dedupeKey: enqueueResult.job.dedupeKey || getCronJobDedupeKey(dedupeToken),
        job: enqueueResult.job
    };
}
