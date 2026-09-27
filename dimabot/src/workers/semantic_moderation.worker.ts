import path from 'node:path';
import dotenv from 'dotenv';
if (process.env.NODE_ENV !== 'production') dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

async function main(): Promise<void> {
    if (process.argv.includes('--dry-run')) { console.log('semantic-moderation: dry run'); return; }
    const { getMongoDBConnection } = await import('../utils/databases/mongodb.database.js');
    const { processNextSemanticDecision, maintainSemanticDecisions } = await import('../utils/moderation/semantic_worker.js');
    const { processNextVariationJob } = await import('../utils/moderation/variation_jobs.js');
    await getMongoDBConnection('SemanticModerationWorker');
    let stopping = false;
    process.once('SIGTERM', () => { stopping = true; });
    process.once('SIGINT', () => { stopping = true; });
    const active = new Set<Promise<unknown>>();
    let maintenanceAt = 0;
    let variationTask: Promise<unknown> | undefined;
    let variationAt = 0;
    console.log('semantic-moderation: ready');
    while (!stopping) {
        if (Date.now() >= maintenanceAt) {
            try { await maintainSemanticDecisions(); } catch (error) { console.error('semantic-moderation maintenance failed', error instanceof Error ? error.message : 'unknown'); }
            maintenanceAt = Date.now() + 1000;
        }
        if (!variationTask && Date.now() >= variationAt) {
            variationTask = processNextVariationJob().catch(error => console.error('variation-generation failed', error instanceof Error ? error.message : 'unknown'))
                .finally(() => { variationTask = undefined; variationAt = Date.now() + 1000; });
        }
        while (active.size < 4 && !stopping) {
            const task = processNextSemanticDecision().catch(error => console.error('semantic-moderation review failed', error instanceof Error ? error.message : 'unknown'));
            active.add(task);
            void task.finally(() => active.delete(task));
            // Let claims proceed concurrently, with a fixed upper bound.
            if (active.size >= 4) break;
        }
        if (process.argv.includes('--once')) break;
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    await Promise.allSettled([...active, ...(variationTask ? [variationTask] : [])]);
    process.exit(0);
}
main().catch(error => { console.error(error); process.exit(1); });
