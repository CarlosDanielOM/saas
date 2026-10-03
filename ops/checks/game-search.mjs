// Normal service command with disposable Mongo/Redis and mocked external providers.
// Compiled regression tests run the real search and both setters with HTTP fixtures.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

if (process.env.SAAS_TARGET === 'api' || process.env.SAAS_TARGET === 'bot') {
    const bot = process.env.SAAS_TARGET === 'bot';
    const response = await fetch(bot ? 'http://127.0.0.1:3333/eventsub' : 'http://127.0.0.1:3000/config/site/analytics',
        bot ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' } : {});
    assert.equal(response.status, bot ? 403 : 200, 'normal entrypoint readiness');
}
execFileSync(process.execPath, ['--experimental-test-module-mocks', '--test',
    'dist/functions/search/search_categories.test.js',
    'dist/utils/ast_parser/channel_actions.test.js',
    'dist/utils/ast_parser/poll_prediction_actions.test.js',
    'dist/utils/ast_parser/set_voice.test.js'], { stdio: 'inherit', timeout: 30000 });
console.log(`PASS ${process.env.SAAS_TARGET}: numeral retrieval, sequel selection, ambiguity, failure handling and permission gates`);
