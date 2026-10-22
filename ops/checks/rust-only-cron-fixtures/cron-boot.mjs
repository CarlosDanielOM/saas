// Faults substitute only disposable candidate binaries; Rust still spawns/reaps/retries.
import { installCronFixture } from './native-cron-fixture.mjs';
installCronFixture({
    selected: ['stream-activity', 'ai-usage-receipts', 'roulette-completion'],
    databasePrefix: 'rust_only_fixture_', scopeEnv: 'RUST_ONLY_FIXTURE_SCOPE',
    log: '/tmp/saas-fixtures/rust-only-spawns.jsonl', frameEvent: 'frame',
    faults: { 'ai-usage-receipts': 'missing', 'roulette-completion': 7 },
});
