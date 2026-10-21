import 'dotenv/config';
if (process.argv.includes('--dry-run')) { console.log(JSON.stringify({ worker: 'follow-defense-baseline' })); process.exit(0); }
let stopping = false;
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });
async function main() {
    const [{ getMongoDBConnection }, { processDefenseBaseline }] = await Promise.all([
        import('../utils/databases/mongodb.database.js'), import('../utils/follow_defense_baseline.js')
    ]);
    await getMongoDBConnection('follow-defense-baseline');
    console.log('Follow defense baseline worker ready');
    do {
        const watchdog = setTimeout(() => process.exit(1), 30000);
        try { await processDefenseBaseline(); }
        catch (error) { console.error('Follow defense baseline refresh failed:', error instanceof Error ? error.message : String(error)); }
        finally { clearTimeout(watchdog); }
        if (process.argv.includes('--once')) break;
        if (!stopping) await new Promise(resolve => setTimeout(resolve, 1000));
    } while (!stopping);
    process.exit(0);
}
main().catch(error => { console.error(error); process.exit(1); });
