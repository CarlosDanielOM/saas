// Stage native-cron-fixture.mjs beside this preload in the disposable candidate.
import { installCronFixture } from './native-cron-fixture.mjs';
installCronFixture({
    selected: ['ai-usage-receipts'], databasePrefix: 'ai_usage_receipts_fixture_',
    scopeEnv: 'AI_USAGE_RECEIPTS_FIXTURE_SCOPE', log: '/tmp/saas-fixtures/ai-usage-spawns.jsonl',
    frameEvent: 'batch',
    reconnect: true,
});
