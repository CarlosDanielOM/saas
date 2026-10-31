/** Regression checks use compiled modules from the exact candidate image. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const suites = [
  'desktop_ai/input', 'desktop_ai/service', 'desktop_ai/execution', 'desktop_ai/activity',
  'pets/socket_adapter', 'pets/admission', 'pets/state', 'pets/delivery', 'pets/wakeups',
  'pets/readiness', 'pets/speech_text', 'pets/queue', 'pets/read_tts',
  'handlers/tts_controls', 'handlers/tts_queue_credits', 'handlers/tts_pet_lane',
  'handlers/dima032_queue', 'handlers/dima032_session', 'handlers/tts_credit_fallback',
  'overlays/dima032_delivery', 'utils/tts_usage', 'utils/ai_credit_status',
  'utils/ai/openrouter/ai.tools_disabled', 'utils/ai/openrouter/command.ai',
  'utils/ai/openrouter/attribution', 'utils/ai/prompts.ai', 'utils/ai/tools/ast_parser.tool',
  'utils/permissions/roles', 'utils/ast_parser/permission_gate',
  'utils/ast_parser/permission_gate_authored', 'utils/ast_parser/functions/moderation',
  'server/services/tts/fish_tts_backend', 'server/services/tts/kokoro_tts'
];
const env = { ...process.env }; delete env.NODE_OPTIONS;
const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', '--test-force-exit',
  '--test-concurrency=1', ...suites.map(name => `/app/dist/${name}.test.js`)],
{ env, stdio: 'inherit', timeout: 180_000 });
assert.ifError(result.error);
assert.equal(result.status, 0, `compiled desktop regression exit ${result.status}, signal ${result.signal}`);
console.log(`PASS exact-image desktop AI and affected existing behavior regressions: ${suites.length} serial suites`);
