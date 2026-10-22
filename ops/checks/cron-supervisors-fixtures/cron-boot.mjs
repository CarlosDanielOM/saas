// The normal boot uses two real native workers and one harmless real Node child.
import { installCronFixture } from './native-cron-fixture.mjs';
installCronFixture({
    selected: process.env.CRON_SUPERVISORS_FIXTURE_SCOPE?.startsWith('once-')
        ? ['roulette-completion', 'raid-sessions'] : ['stream-activity', 'raid-analytics'],
    databasePrefix: 'cron_supervisors_fixture_',
    scopeEnv: 'CRON_SUPERVISORS_FIXTURE_SCOPE', log: '/tmp/saas-fixtures/cron-supervisors.jsonl',
    typescriptWorker: 'follow-ledger', typescriptEntry: '/tmp/saas-fixtures/typescript-child.mjs',
});
