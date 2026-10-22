// Stage native-cron-fixture.mjs beside this preload in the disposable candidate.
import { installCronFixture } from './native-cron-fixture.mjs';
installCronFixture({
    selected: ['raid-sessions'], databasePrefix: 'raid_sessions_fixture_',
    scopeEnv: 'RAID_SESSIONS_FIXTURE_SCOPE', log: '/tmp/saas-fixtures/raid-sessions-spawns.jsonl',
    frameEvent: 'batch',
});
