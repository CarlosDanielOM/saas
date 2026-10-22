// Stage native-cron-fixture.mjs beside this preload in the disposable candidate.
import { installCronFixture } from './native-cron-fixture.mjs';
installCronFixture({
    selected: ['stream-activity'], databasePrefix: 'stream_activity_fixture_',
    scopeEnv: 'STREAM_ACTIVITY_FIXTURE_SCOPE', log: '/tmp/saas-fixtures/spawns.jsonl',
});
