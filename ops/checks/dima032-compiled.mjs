/** Compile-packaged source regressions against the exact candidate; each test mocks its own boundary. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const suites = ['pets/read_tts', 'pets/tts_envelope', 'pets/admission', 'pets/state', 'pets/delivery', 'pets/readiness',
    'handlers/dima032_queue', 'handlers/dima032_session', 'handlers/tts_controls', 'handlers/tts_queue_credits',
    'handlers/tts_credit_fallback', 'overlays/dima032_delivery', 'pets/wakeups', 'domain_events/stream_operations_events', 'utils/ast_parser/pet_triggers'];
const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', '--test-force-exit', '--test-concurrency=1',
    ...suites.map(suite => `/app/dist/${suite}.test.js`)], { env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'inherit', timeout: 180000 });
assert.ifError(result.error); assert.equal(result.status, 0);
console.log(`PASS DIMA032 exact-candidate compiled regressions (${suites.length} suites)`);
