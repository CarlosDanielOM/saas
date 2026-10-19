import path from 'node:path';
import dotenv from 'dotenv';
if (process.env.NODE_ENV !== 'production') dotenv.config({ path: path.resolve('.env.local') });
dotenv.config();
async function main() {
    if (process.argv.includes('--dry-run')) { console.log('Stream activity: bounded 500-event batches'); return; }
    const [{ getMongoDBConnection }, { projectStreamActivityBatch }] = await Promise.all([
        import('../utils/databases/mongodb.database.js'), import('../utils/stream_activity.js')
    ]);
    await getMongoDBConnection('stream-activity');
    let stopping = false;
    process.once('SIGTERM', () => { stopping = true; });
    process.once('SIGINT', () => { stopping = true; });
    do {
        const count = await projectStreamActivityBatch();
        if (process.argv.includes('--once')) { process.exit(0); }
        if (!count) await new Promise(resolve => setTimeout(resolve, 1000));
    } while (!stopping);
    process.exit(0);
}
main().catch(error => { console.error('Stream activity projection failed', error); process.exit(1); });
