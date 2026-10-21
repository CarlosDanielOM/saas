import path from 'node:path';
import dotenv from 'dotenv';
if (process.env.NODE_ENV !== 'production') dotenv.config({ path: path.resolve('.env.local') });
dotenv.config();
async function main() {
    if (process.argv.includes('--dry-run')) { console.log('Raid analytics: one channel per pass, bounded follow-count refresh'); return; }
    const [{ getMongoDBConnection }, { projectRaidSummaryOnce }] = await Promise.all([
        import('../utils/databases/mongodb.database.js'), import('../utils/raid_analytics.js')
    ]);
    await getMongoDBConnection('raid-analytics');
    let stopping = false;
    process.once('SIGTERM', () => { stopping = true; }); process.once('SIGINT', () => { stopping = true; });
    do {
        try { await projectRaidSummaryOnce(); } catch (error) { console.error('Raid summary refresh failed', error); }
        if (process.argv.includes('--once')) process.exit(0);
        await new Promise(resolve => setTimeout(resolve, 1000));
    } while (!stopping);
    process.exit(0);
}
main().catch(error => { console.error('Raid analytics worker failed', error); process.exit(1); });
