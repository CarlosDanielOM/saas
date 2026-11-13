import { idleBackoff, runWorker } from './worker_loop.js';

await runWorker({
    name: 'raid-analytics', prefix: 'raid_analytics', batchMetric: 'batch_channels',
    dryRun: 'Raid analytics: one channel per pass, bounded follow-count refresh',
    // The channel stays queued with its error state; a fresh process retries it.
    onFailure: 'exit',
    async setup() {
        const [{ getMongoDBConnection }, raids] = await Promise.all([
            import('../utils/databases/mongodb.database.js'), import('../utils/raid_analytics.js')
        ]);
        await getMongoDBConnection('raid-analytics');
        const idle = idleBackoff();
        return {
            async pass() {
                // A failure carries the phases that did run, for the loop to report before it exits.
                const pass = await raids.projectRaidSummaryOnceObserved();
                return { events: pass.published, phases: { ...pass.phases }, claimed: pass.channels > 0 };
            },
            // A pass that changed nothing still claimed a channel: keep draining due channels without backing off.
            delayMs: outcome => idle(Boolean(outcome?.claimed)),
            async health() {
                const backlog = await raids.raidAnalyticsBacklogHealth();
                return { backlog_channels: backlog.dueChannels, oldest_due_age_ms: backlog.oldestDueAgeMs };
            },
        };
    },
});
