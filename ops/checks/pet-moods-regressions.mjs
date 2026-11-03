/** Run the exact candidate's existing pet and affected desktop/TTS suites serially. */
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// The existing cross-project cue parity test reads the real frontend catalog.
// Stage that unchanged source file rather than reconstructing it from backend data.
mkdirSync('/dimasite/src/app/models', { recursive: true });
copyFileSync('/tmp/saas-fixtures/tts-settings.model.ts', '/dimasite/src/app/models/tts-settings.model.ts');

const suites = [
  ...readdirSync('/app/dist/pets').filter(name => name.endsWith('.test.js')).map(name => `pets/${name}`),
  'assets/mood-library.test.js', 'assets/mood-upload.test.js',
  'server/services/pet_settings.moods.test.js',
  'desktop_ai/input.test.js', 'desktop_ai/service.test.js', 'desktop_ai/execution.test.js', 'desktop_ai/activity.test.js',
  'handlers/tts_controls.test.js', 'handlers/tts_queue_credits.test.js', 'handlers/tts_pet_lane.test.js',
  'handlers/dima032_queue.test.js', 'handlers/dima032_session.test.js', 'handlers/tts_credit_fallback.test.js',
  'overlays/dima032_delivery.test.js', 'utils/tts/expressive_tts_tags.test.js', 'utils/tts_usage.test.js',
  'utils/ai_credit_status.test.js', 'utils/ai/openrouter/ai.tools_disabled.test.js',
  'utils/ai/openrouter/command.ai.test.js', 'utils/ai/openrouter/attribution.test.js',
  'utils/ai/prompts.ai.test.js', 'utils/ai/tools/ast_parser.tool.test.js',
  'utils/permissions/roles.test.js', 'utils/ast_parser/permission_gate.test.js',
  'utils/ast_parser/permission_gate_authored.test.js', 'utils/ast_parser/functions/moderation.test.js',
  'server/services/tts/fish_tts_backend.test.js', 'server/services/tts/kokoro_tts.test.js'
];
const env = { ...process.env }; delete env.NODE_OPTIONS;
const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', '--test-force-exit',
  '--test-concurrency=1', ...suites.map(name => `/app/dist/${name}`)],
{ env, stdio: 'inherit', timeout: 240_000 });
assert.ifError(result.error);
assert.equal(result.status, 0, `pet mood regression exit ${result.status}, signal ${result.signal}`);
console.log(`PASS DIMA-046 exact-image pet, mood assets, desktop AI and TTS regressions: ${suites.length} serial suites`);
