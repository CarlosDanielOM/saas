/** Compiled tests from the exact API candidate, under saas-ops container limits. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const suites = [
  'pets/admission', 'pets/state', 'pets/delivery', 'pets/wakeups', 'pets/readiness',
  'utils/domain_event_wakeups', 'utils/tts_usage', 'utils/ai_credit_status',
  'utils/ai/openrouter/ai.tools_disabled', 'utils/ai/openrouter/command.ai',
  'utils/ai/openrouter/attribution', 'server/services/tts/fish_tts_backend',
  'server/services/tts/kokoro_tts', 'handlers/tts_credit_fallback', 'handlers/tts_queue_credits',
];
const env = { ...process.env }; delete env.NODE_OPTIONS;
const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', '--test-force-exit', '--test-concurrency=1',
  ...suites.map(name => `/app/dist/${name}.test.js`)], { env, stdio: 'inherit', timeout: 180_000 });
assert.ifError(result.error);
assert.equal(result.status, 0, `compiled pet/provider regression exit ${result.status}, signal ${result.signal}`);
console.log(`PASS compiled pet/provider regressions (${suites.length} suites, serial execution)`);
