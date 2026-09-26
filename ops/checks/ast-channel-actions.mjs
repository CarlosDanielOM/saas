// Run with disposable Mongo/Redis and ast-timer-fixtures. The service starts
// using its normal command; the tests exercise real AST and Helix adapters
// against fixtures, without sending announcements/warnings to real channels.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

if (process.env.SAAS_TARGET === 'bot' || process.env.SAAS_TARGET === 'api') {
  const bot = process.env.SAAS_TARGET === 'bot';
  const deadline = Date.now() + 15000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(bot ? 'http://127.0.0.1:3333/eventsub' : 'http://127.0.0.1:3000/config/site/analytics',
        bot ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' } : {});
      ready = response.status === (bot ? 403 : 200);
    } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'normal service entrypoint must become ready');
}
execFileSync(process.execPath, ['--experimental-test-module-mocks', '--test',
  'dist/utils/ast_parser/channel_actions.test.js',
  'dist/utils/ast_parser/poll_prediction_actions.test.js',
  'dist/utils/ast_parser/command_references.test.js',
  'dist/utils/ast_parser/permission_gate_authored.test.js'], { stdio: 'inherit', timeout: 30000 });
const catalog = JSON.parse(readFileSync('/app/src/utils/ai/ast_catalog/ast-catalog.json', 'utf8'));
for (const name of ['lock.prediction', 'get.poll', 'announce', 'warn', 'twitch.live']) {
  assert.ok(catalog.entries.some(entry => entry.name === name), `catalog missing ${name}`);
}
assert.ok(catalog.entries.find(entry => entry.name === 'announce').aliases.includes('chat.announcement'));
console.log(`PASS ${process.env.SAAS_TARGET}: new AST actions, Helix requests, input validation, conditional behavior, authorization, command references and catalog`);
