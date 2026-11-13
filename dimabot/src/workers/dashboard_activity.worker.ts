import { runWorker } from './worker_loop.js';

await runWorker({
    name: 'dashboard-activity', prefix: 'dashboard_activity', batchMetric: 'batch_events',
    dryRun: 'Dashboard activity: bounded metadata batches and cached 7/30-day ranks',
    onFailure: 'retry',
    // A stalled operation cannot keep running beyond a 60-second projection lease.
    watchdogMs: 40_000,
    async setup() {
        const [{ getMongoDBConnection }, activity, insights] = await Promise.all([
            import('../utils/databases/mongodb.database.js'), import('../utils/dashboard_activity.js'), import('../utils/dashboard_insights.js')
        ]);
        await getMongoDBConnection('dashboard-activity');
        const once = process.argv.includes('--once');
        return {
            async pass() {
                const events = await activity.projectDashboardActivityBatch()
                    + Number(await activity.refreshDashboardActivityOnce()) + Number(await insights.refreshDashboardInsightsOnce());
                return { events, ready: !once && (await activity.dashboardActivityReady() || await insights.dashboardInsightsReady()) };
            },
            // Either queue can be ready without any projected event, so the count never decides the wait.
            delayMs: outcome => outcome?.ready ? 0 : 1000,
        };
    },
});
