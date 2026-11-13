import { observe } from './telemetry.js';

export type WorkerPhases = Record<string, number | null | undefined>;
export type WorkerHealth = Record<string, number | boolean | null | undefined>;

/**
 * Batch, phase and health metrics for one cron worker. `prefix` is the worker's entry file name
 * without `.worker.ts` (`raid_analytics`); the admin Observability page joins it with the
 * process's runtime metrics (`raid_analytics.worker.*`) to show memory, batches and health together.
 */
export function workerMetrics(prefix: string, batchMetric: string) {
    return {
        /** A failed pass reports no events; an empty successful pass is `idle`, not an error. */
        batch(events: number, durationMs: number, success = true, phases: WorkerPhases = {}): void {
            const outcome = !success ? 'error' : events > 0 ? 'ok' : 'idle';
            observe('worker', `${prefix}.${batchMetric}`, success ? events : 0, outcome);
            observe('queue_run', `${prefix}.project_batch`, durationMs, outcome);
            for (const [phase, value] of Object.entries(phases)) {
                if (typeof value === 'number') observe('queue_run', `${prefix}.phase.${phase}`, value, outcome);
            }
        },
        /** `values` is null when the probe itself failed; only the last-success age is still known then. */
        health(values: WorkerHealth | null, lastSuccessAgeMs?: number): void {
            observe('worker', `${prefix}.health_query`, values ? 1 : 0);
            if (!values) observe('worker', `${prefix}.health_errors`, 1, 'error');
            for (const [name, value] of Object.entries(values ?? {})) {
                if (typeof value === 'boolean') observe('worker', `${prefix}.${name}`, value ? 1 : 0);
                else if (typeof value === 'number') observe('worker', `${prefix}.${name}`, value);
            }
            if (lastSuccessAgeMs !== undefined) observe('worker', `${prefix}.last_success_age_ms`, lastSuccessAgeMs);
        },
    };
}
