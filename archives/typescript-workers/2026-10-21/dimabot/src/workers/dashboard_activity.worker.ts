import path from 'node:path';
import dotenv from 'dotenv';
if (process.env.NODE_ENV !== 'production') dotenv.config({ path: path.resolve('.env.local') });
dotenv.config();
async function main() {
    if (process.argv.includes('--dry-run')) { console.log('Dashboard activity: bounded metadata batches and cached 7/30-day ranks'); return; }
    const [{ getMongoDBConnection }, { projectDashboardActivityBatch, refreshDashboardActivityOnce }, { refreshDashboardInsightsOnce }] = await Promise.all([
        import('../utils/databases/mongodb.database.js'), import('../utils/dashboard_activity.js'), import('../utils/dashboard_insights.js')
    ]);
    await getMongoDBConnection('dashboard-activity');
    let stopping = false;
    process.once('SIGTERM', () => { stopping = true; }); process.once('SIGINT', () => { stopping = true; });
    do {
        // A stalled operation cannot keep running beyond a projection lease.
        const deadline = setTimeout(() => { console.error('Dashboard activity tick stalled'); process.exit(1); }, 40000);
        let count = 0;
        try { count = await projectDashboardActivityBatch(); await refreshDashboardActivityOnce(); await refreshDashboardInsightsOnce(); }
        catch (error) { console.error('Dashboard activity refresh failed', error); }
        finally { clearTimeout(deadline); }
        if (process.argv.includes('--once')) process.exit(0);
        if (!count) await new Promise(resolve => setTimeout(resolve, 1000));
    } while (!stopping);
    process.exit(0);
}
main().catch(error => { console.error('Dashboard activity worker failed', error); process.exit(1); });
