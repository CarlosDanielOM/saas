// Keep a real timer consumer and native index/roulette child; unrelated workers
// are inert fixtures to stay within the disposable candidate's memory cap.
import { installCronFixture } from './native-cron-fixture.mjs';
installCronFixture({ selected: ['roulette-completion'], databasePrefix: 'saas_ops_',
  scopeEnv: 'SHOUTOUT_FIXTURE_SCOPE', log: '/tmp/saas-fixtures/cron.jsonl',
  typescriptWorker: 'timer', typescriptEntry: '/tmp/saas-fixtures/timer-child.mjs' });
