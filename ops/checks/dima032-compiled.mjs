/** Packaged source regressions plus actual Lua against the exact disposable candidate. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
assert.equal(process.env.DRAGONFLY_HOST, 'redis', 'require the saas-ops private disposable dependency alias');
assert.equal(process.env.DRAGONFLY_PORT, '6379', 'require the disposable dependency port');
const dependencyRedis = new URL(`redis://${process.env.DRAGONFLY_HOST}:${process.env.DRAGONFLY_PORT}`);
assert.equal(dependencyRedis.hostname, 'redis'); assert.equal(dependencyRedis.port, '6379');
assert.equal(dependencyRedis.username, ''); assert.equal(dependencyRedis.password, '');
const suites = ['pets/read_tts', 'pets/tts_envelope', 'pets/admission', 'pets/state', 'pets/delivery', 'pets/readiness',
    'handlers/dima032_queue', 'handlers/dima032_session', 'handlers/tts_controls', 'handlers/tts_queue_credits',
    'handlers/tts_credit_fallback', 'overlays/dima032_delivery', 'pets/wakeups', 'domain_events/stream_operations_events', 'utils/ast_parser/pet_triggers', 'utils/tts/tts_session'];
const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', '--test-force-exit', '--test-concurrency=1',
    ...suites.map(suite => `/app/dist/${suite}.test.js`)], {
    env: { ...process.env, NODE_OPTIONS: '', DIMA032_TEST_REDIS_URL: dependencyRedis.href }, stdio: 'inherit', timeout: 180000 });
assert.ifError(result.error); assert.equal(result.status, 0);
console.log(`PASS DIMA032 exact-candidate compiled regressions and actual Dragonfly Lua (${suites.length} suites)`);
