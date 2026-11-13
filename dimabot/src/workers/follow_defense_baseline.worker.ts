import { burstBackoff, runWorker } from './worker_loop.js';

await runWorker({
    name: 'follow-defense-baseline', prefix: 'follow_defense_baseline', batchMetric: 'batch_channels',
    dryRun: JSON.stringify({ worker: 'follow-defense-baseline' }),
    onFailure: 'retry',
    watchdogMs: 30_000,
    async setup() {
        const [{ getMongoDBConnection }, baseline] = await Promise.all([
            import('../utils/databases/mongodb.database.js'), import('../utils/follow_defense_baseline.js')
        ]);
        await getMongoDBConnection('follow-defense-baseline');
        console.log('Follow defense baseline worker ready');
        return {
            async pass() {
                const phases = {};
                // A failed refresh keeps its retry receipt in the due set; report the phases that did run.
                try { return { events: await baseline.processDefenseBaseline(phases), phases }; }
                catch (error) {
                    console.error('Follow defense baseline refresh failed:', error instanceof Error ? error.message : String(error));
                    return { events: 0, phases, failed: true };
                }
            },
            // Drain due channels back to back, but pause after every eighth so a burst cannot monopolize the databases.
            delayMs: burstBackoff(8),
            health: () => baseline.defenseBaselineBacklog(),
        };
    },
});
