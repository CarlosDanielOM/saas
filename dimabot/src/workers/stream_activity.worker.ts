import { idleBackoff, runWorker } from './worker_loop.js';

await runWorker({
    name: 'stream-activity', prefix: 'stream_activity', batchMetric: 'batch_events',
    dryRun: 'Stream activity: bounded 500-event batches',
    // A failed batch keeps its checkpoint; a fresh process replays it under the same sequence.
    onFailure: 'exit',
    async setup() {
        const [{ getMongoDBConnection }, { projectStreamActivityBatch, streamActivityHealth }] = await Promise.all([
            import('../utils/databases/mongodb.database.js'), import('../utils/stream_activity.js')
        ]);
        await getMongoDBConnection('stream-activity');
        const idle = idleBackoff();
        return {
            pass: async () => ({ events: await projectStreamActivityBatch() }),
            delayMs: outcome => idle(Boolean(outcome?.events)),
            health: () => streamActivityHealth(),
        };
    },
});
