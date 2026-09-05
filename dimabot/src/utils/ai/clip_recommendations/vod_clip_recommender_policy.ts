import type { CronQueueJob } from '../../cron_jobs_queue.js';

export interface ClipJobFailureDisposition {
    action: 'requeue' | 'dead-letter';
    attempt: number;
    job: CronQueueJob;
}

export function getClipJobAttempt(job: CronQueueJob): number {
    const attempt = Number(job.data?.attempt || 1);
    return Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 1;
}

export function getClipJobFailureDisposition(job: CronQueueJob, maxAttempts: number): ClipJobFailureDisposition {
    const attempt = getClipJobAttempt(job);
    const attemptLimit = Number.isFinite(maxAttempts) ? Math.max(1, Math.floor(maxAttempts)) : 1;
    if (attempt >= attemptLimit) {
        return { action: 'dead-letter', attempt, job };
    }
    const nextAttempt = attempt + 1;
    return {
        action: 'requeue',
        attempt: nextAttempt,
        job: {
            ...job,
            data: {
                ...(job.data || {}),
                attempt: nextAttempt
            }
        }
    };
}

export function getClipWorkflowFailureDisposition(
    job: CronQueueJob,
    maxAttempts: number,
    retryable: boolean | undefined
): ClipJobFailureDisposition {
    if (retryable === false) {
        return { action: 'dead-letter', attempt: getClipJobAttempt(job), job };
    }
    return getClipJobFailureDisposition(job, maxAttempts);
}

export function shouldStopAfterHeartbeatFailure(consecutiveFailures: number, failureLimit: number): boolean {
    const limit = Number.isFinite(failureLimit) ? Math.max(2, Math.floor(failureLimit)) : 2;
    return Math.max(0, Math.floor(consecutiveFailures)) >= limit;
}
