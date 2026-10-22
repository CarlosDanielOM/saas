// Stage native-cron-fixture.mjs beside this preload in the disposable candidate.
import { installCronFixture } from './native-cron-fixture.mjs';
installCronFixture({
    selected: ['raid-analytics'], databasePrefix: 'raid_analytics_fixture_',
    scopeEnv: 'RAID_ANALYTICS_FIXTURE_SCOPE', log: '/tmp/saas-fixtures/raid-spawns.jsonl',
    frameEvent: 'batch',
});
