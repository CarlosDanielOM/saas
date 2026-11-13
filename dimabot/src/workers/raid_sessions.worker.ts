import { runWorker } from './worker_loop.js';

await runWorker({
    name: 'raid-sessions', prefix: 'raid_sessions', batchMetric: 'batch_items',
    dryRun: JSON.stringify({ worker: 'raid-sessions', batchSize: 200 }),
    onFailure: 'retry',
    // The whole tick must finish well inside the 60-second moderation request lease.
    watchdogMs: 20_000,
    async setup() {
        const [{ getMongoDBConnection }, { runRaidSessionsTick }] = await Promise.all([
            import('../utils/databases/mongodb.database.js'), import('../utils/raid_sessions.js')
        ]);
        await getMongoDBConnection('raid-sessions');
        console.log('Raid session worker ready');
        const once = process.argv.includes('--once');
        return {
            async pass() { return runRaidSessionsTick(!once); },
            delayMs: outcome => outcome?.ready ? 0 : 1000,
        };
    },
});
