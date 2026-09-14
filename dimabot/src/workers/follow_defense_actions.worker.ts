import dotenv from 'dotenv';
dotenv.config();

if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify({ worker: 'follow-defense-actions', initialRequestsPerSecond: 5, maximumRequestsPerSecond: 10, adaptivePacing: true, deadlineMinutes: 60 }));
    process.exit(0);
}

let stopping = false;
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });

async function main(): Promise<void> {
    const [{ getMongoDBConnection }, actions] = await Promise.all([
        import('../utils/databases/mongodb.database.js'), import('../utils/follow_defense_actions.js')
    ]);
    await getMongoDBConnection('follow-defense-actions');
    console.log('Follow defense action worker ready');
    let nextAuditAt = 0;
    do {
        // Hard exit before the 60s lease can expire. A Promise timeout cannot stop a late external effect.
        const watchdog = setTimeout(() => { console.error('Follow defense action watchdog expired'); process.exit(1); }, 40_000);
        let busy = false;
        try {
            busy = await actions.processFollowDefenseAction();
            if (Date.now() >= nextAuditAt) {
                await actions.reconcileFollowDefenseActionLogs();
                nextAuditAt = Date.now() + 1000;
            }
        } catch (error) {
            console.error('Follow defense action tick failed:', error instanceof Error ? error.message : String(error));
        } finally { clearTimeout(watchdog); }
        if (process.argv.includes('--once')) break;
        if (!stopping) await new Promise(resolve => setTimeout(resolve, busy ? 20 : actions.followDefenseActionPollDelay()));
    } while (!stopping);
    process.exit(0);
}
main().catch(error => { console.error('Follow defense action worker failed:', error); process.exit(1); });
