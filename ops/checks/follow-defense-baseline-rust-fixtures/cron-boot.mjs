// Stage native-cron-fixture.mjs beside this preload in the disposable candidate.
import { installCronFixture } from './native-cron-fixture.mjs';
installCronFixture({
    selected: ['follow-defense-baseline'], databasePrefix: 'follow_baseline_fixture_',
    scopeEnv: 'FOLLOW_BASELINE_FIXTURE_SCOPE', log: '/tmp/saas-fixtures/baseline-spawns.jsonl',
});
