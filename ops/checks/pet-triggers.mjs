/** Run the source-backed compiled producer suites inside an isolated saas-ops candidate.
 * No live services/providers: each suite mocks its own admission and transport boundaries.
 * Run on bot and cron candidates to verify their actual packaged shared producer code.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
const suites = [
  '/app/dist/utils/ast_parser/pet_triggers.test.js',
  '/app/dist/utils/ast_parser/command_references.test.js',
  '/app/dist/utils/ast_parser/loop.test.js',
  '/app/dist/utils/ast_parser/timer.test.js',
  '/app/dist/domain_events/chat_announcement_events.test.js',
  '/app/dist/bot/eventsub.twitch.test.js',
  '/app/dist/handlers/eventsub.handler.test.js'
];
assert.match(process.env.MONGO_URI || '', /^mongodb:\/\/mongo:27017\/saas_ops_[a-z_]+_test$/, 'disposable candidate configuration required');
const packagedRaidFixture = readFileSync('/app/dist/bot/eventsub.twitch.test.js', 'utf8')
  .includes("mock.module('../utils/raid_subscriptions.js'");
if (process.env.SAAS_TARGET === 'cron') assert.ok(packagedRaidFixture, 'new cron image includes its own eligible-raid unit fixture');
console.log(JSON.stringify({ packagedRaidFixture, supplementalRaidPreload: !packagedRaidFixture }));
const env = { ...process.env, NODE_OPTIONS: '', OTEL_SDK_DISABLED: 'true', OBSERVABILITY_DISABLED: 'true',
  MONGO_URI: 'mongodb://invalid.test:1/pet_never_connect', DRAGONFLY_HOST: 'invalid.test', DRAGONFLY_PORT: '1' };
const child = spawn(process.execPath, ['--experimental-test-module-mocks', '--import=/tmp/saas-fixtures/unit-preload.mjs',
  '--test', '--test-timeout=20000', '--test-concurrency=1', ...suites], {
  cwd: '/app', env, stdio: 'inherit', timeout: 120_000
});
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
assert.equal(code, 0, 'packaged producer and shared AST regression suites must pass');
console.log(`PASS: ${process.env.SAAS_TARGET} packaged pet trigger/ingress/durable consumer and AST regression suites`);
