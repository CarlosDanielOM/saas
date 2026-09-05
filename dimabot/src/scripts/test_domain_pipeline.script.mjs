import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { constants } from 'node:os';

// Reviewed service-free suites only. Never replace this allowlist with all repo tests.
const SAFE_SUITES = [
    'src/utils/domain_events.test.ts',
    'src/utils/domain_event_consumer.test.ts',
    'src/utils/domain_event_dispatch.test.ts',
    'src/utils/domain_event_execution.test.ts',
    'src/utils/domain_event_execution_lease.test.ts',
    'src/utils/domain_event_prerequisite.test.ts',
    'src/utils/domain_event_wakeups.test.ts',
    'src/utils/domain_event_health.test.ts',
    'src/domain_events/domain_event_contracts.test.ts',
    'src/domain_events/domain_event_consumers.test.ts',
    'src/domain_events/domain_event_delivery_policy.test.ts',
    'src/domain_events/domain_event_identity.test.ts',
    'src/domain_events/domain_event_producers.test.ts',
    'src/domain_events/chat_announcement_events.test.ts',
    'src/domain_events/follow_defense_events.test.ts',
    'src/domain_events/polar_billing_events.test.ts',
    'src/domain_events/polar_events.test.ts',
    'src/domain_events/stream_operations_events.test.ts',
    'src/domain_events/twitch_eventsub_events.test.ts',
    'src/bot/eventsub.twitch.test.ts',
    'src/handlers/eventsub.handler.test.ts',
    'src/server/routes/webhooks/polarsh.webhook.test.ts',
    'src/server/routes/admin_site.domain_events.test.ts',
    'src/utils/follow_defense.test.ts',
    'src/utils/follow_defense_queue.test.ts',
    'src/utils/cron_jobs_queue_atomic.test.ts',
    'src/utils/stream_analytics_missing_session.test.ts',
    'src/utils/stream_analytics_offline_replay.test.ts',
    'src/utils/stream_session_event_projection.test.ts',
    'src/utils/paid_order_reward.test.ts'
];

// Restrict passthrough to reporters; positional paths/loaders could escape the safe list.
const args = process.argv.slice(2);
if (args.some(arg => !/^--test-reporter=(spec|dot|tap|junit|lcov)$/.test(arg))) {
    console.error('Usage: node test_domain_pipeline.script.mjs [--test-reporter=spec|dot|tap|junit|lcov]');
    process.exitCode = 2;
} else {
    console.error(`Domain pipeline: ${SAFE_SUITES.length} service-free test files. Standalone Lua is optional; its test skips if unavailable.`);
    const child = spawn(process.execPath, [
        '--experimental-test-module-mocks', '--import', 'tsx', '--test',
        ...(args.length ? args : ['--test-reporter=spec']), ...SAFE_SUITES
    ], { cwd: fileURLToPath(new URL('../../', import.meta.url)), stdio: 'inherit' });
    child.on('error', error => {
        console.error(`Unable to start pipeline tests: ${error.message}`);
        process.exitCode = 1;
    });
    child.on('exit', (code, signal) => {
        process.exitCode = code ?? (signal ? 128 + constants.signals[signal] : 1);
    });
    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.once(signal, () => { child.kill(signal); });
    }
}
