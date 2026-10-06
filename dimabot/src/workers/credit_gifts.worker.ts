import 'dotenv/config';
if (process.argv.includes('--dry-run')) { console.log(JSON.stringify({ worker: 'credit-gifts' })); process.exit(0); }
let stopping = false;
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });
async function main() {
    const [{ getMongoDBConnection }, { processCreditGift }] = await Promise.all([
        import('../utils/databases/mongodb.database.js'), import('../utils/credit_gifts.js'),
    ]);
    await getMongoDBConnection('credit-gifts');
    console.log('Credit gift worker ready');
    do {
        // Shorter than the durable lease; a hung stage dies before another process may claim it.
        const watchdog = setTimeout(() => process.exit(1), 90_000);
        try { await processCreditGift(); }
        catch (error) { console.error('Credit gift worker failed:', error instanceof Error ? error.message : String(error)); }
        finally { clearTimeout(watchdog); }
        if (process.argv.includes('--once')) break;
        if (!stopping) await new Promise(resolve => setTimeout(resolve, 1_000));
    } while (!stopping);
    process.exit(0);
}
main().catch(error => { console.error(error); process.exit(1); });
