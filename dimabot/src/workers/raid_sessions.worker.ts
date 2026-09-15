import 'dotenv/config';
if (process.argv.includes('--dry-run')) { console.log(JSON.stringify({ worker: 'raid-sessions', batchSize: 200 })); process.exit(0); }
let stopping = false;
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });
async function main() {
    const [{ getMongoDBConnection }, { processRaidModerationRequests, backfillRaidSession }] = await Promise.all([
        import('../utils/databases/mongodb.database.js'), import('../utils/raid_sessions.js')
    ]);
    await getMongoDBConnection('raid-sessions');
    console.log('Raid session worker ready');
    do {
        const watchdog = setTimeout(() => process.exit(1), 40000);
        try { await backfillRaidSession(); await processRaidModerationRequests(); }
        catch (error) { console.error('Raid session tick failed:', error instanceof Error ? error.message : String(error)); }
        finally { clearTimeout(watchdog); }
        if (process.argv.includes('--once')) break;
        if (!stopping) await new Promise(resolve => setTimeout(resolve, 1000));
    } while (!stopping);
    process.exit(0);
}
main().catch(error => { console.error(error); process.exit(1); });
