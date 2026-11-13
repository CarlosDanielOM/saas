import { runWorker } from './worker_loop.js';

await runWorker({
    name: 'roulette-completion', prefix: 'roulette_completion', batchMetric: 'batch_channels',
    dryRun: 'roulette-completion: durable Mongo deadlines, no external providers',
    // The supervisor restarts this worker if storage fails; each settlement is one compare-and-set.
    onFailure: 'exit',
    watchdogMs: 20_000,
    async setup() {
        const [{ getMongoDBConnection }, { settleDue }] = await Promise.all([
            import('../utils/databases/mongodb.database.js'), import('../roulette/service.js')
        ]);
        await getMongoDBConnection('roulette-worker');
        return {
            async pass() {
                const pass = await settleDue();
                return { events: pass.changed, ready: pass.ready };
            },
            delayMs: outcome => outcome?.ready ? 0 : 1000,
        };
    },
});
