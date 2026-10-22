// Stage native-cron-fixture.mjs beside this preload in the disposable candidate.
import { installCronFixture } from './native-cron-fixture.mjs';
installCronFixture({
    selected: ['roulette-completion'], databasePrefix: 'roulette_completion_fixture_',
    scopeEnv: 'ROULETTE_COMPLETION_FIXTURE_SCOPE', log: '/tmp/saas-fixtures/roulette-spawns.jsonl',
    frameEvent: 'batch',
});
