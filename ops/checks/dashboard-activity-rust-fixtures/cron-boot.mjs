// Stage native-cron-fixture.mjs beside this preload in the disposable candidate.
import { installCronFixture } from './native-cron-fixture.mjs';
installCronFixture({
    selected: ['dashboard-activity'], databasePrefix: 'dashboard_activity_fixture_',
    scopeEnv: 'DASHBOARD_ACTIVITY_FIXTURE_SCOPE', log: '/tmp/saas-fixtures/dashboard-activity-spawns.jsonl',
    frameEvent: 'batch',
    faults: process.env.DASHBOARD_ACTIVITY_FIXTURE_FAULT ? { 'dashboard-activity':
        process.env.DASHBOARD_ACTIVITY_FIXTURE_FAULT === 'missing' ? 'missing' :
        process.env.DASHBOARD_ACTIVITY_FIXTURE_FAULT === 'exit' ? 17 : 'invalid' } : undefined,
});
