// Exact-candidate check. Uses only disposable Mongo/Redis and the existing
// kokoro fixtures' blocked provider boundary; no speech or messages leave it.
// For api, bot and cron, use --fixtures ops/checks/kokoro-fixtures and
// --test-env ops/checks/kokoro-fixtures/api-env.json with mongo/redis dependencies.
// This shared environment keeps the real bot webhook listener enabled.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

execFileSync(process.execPath, ['--experimental-test-module-mocks', '--test-force-exit', '--test',
    'dist/utils/ast_parser/functions/user.functions.test.js',
    'dist/utils/ast_parser/functions/string.test.js',
    'dist/utils/ast_parser/tts_settings.test.js'], {
    stdio: 'inherit', timeout: 60_000, env: { ...process.env, NODE_OPTIONS: '' }
});

const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
const { parseSpecialCommands } = await import('/app/dist/handlers/special_parser.handler.js');
const { renderTimerMessage } = await import('/app/dist/utils/timer_runtime.js');
await getMongoDBConnection('tts-user-filters-check');
const redis = await getDragonflyClient('tts-user-filters-check');
const channelID = 'tts-user-filters-fixture';
await redis.hSet(`accounts:twitch:${channelID}:data`, {
    id: channelID, name: 'filterfixture', plan_tier: 'free'
});
const render = async (source, name, argument = 'Hello 201!') => parseSpecialCommands(source, {
    channelID, scopeType: 'command', scopeName: 'speech', userPlan: 'free',
    argument, literalArguments: true,
    eventData: { chatter_user_id: 'viewer-fixture', chatter_user_login: 'the_mighty_kill201', chatter_user_name: name }
});
const speeches = () => (existsSync('/tmp/saas-fixtures/calls.jsonl')
    ? readFileSync('/tmp/saas-fixtures/calls.jsonl', 'utf8').trim().split('\n').filter(Boolean) : [])
    .map(line => JSON.parse(line)).filter(call => call.channelID === channelID && call.speech);

assert.equal((await render('$(user)', 'the_mighty_$kill201')).parsedText, 'the_mighty_$kill201');
assert.equal((await render('$(user ignore symbols)', 'the_mighty_$kill201')).parsedText, 'themightykill201');
assert.equal((await render('$(user ignore numbers)', 'cdom201')).parsedText, 'cdom');
assert.equal((await render('$(user ignore symbols numbers)', 'José_٢٠١')).parsedText, 'José');
assert.equal((await render('$(user ignore symbols numbers)', '_$201')).parsedText, 'viewer');

for (const options of ['symbols numbers', 'numbers symbols']) {
    const before = speeches().length;
    const result = await render(`$(tts $(user ignore ${options}) says: &t)`, 'the_mighty_$kill201');
    assert.equal(result.parsedText, '');
    assert.equal(speeches().length, before + 1, 'exactly one speech request');
    const payload = speeches().at(-1).speech;
    // The existing AST renderer separates the colon token with whitespace.
    assert.equal(payload.text, 'themightykill says : Hello 201!');
    assert.equal(payload.requestedBy.userName, 'the_mighty_$kill201', 'tracking retains original identity');
}

const before = speeches().length;
const timerResult = await renderTimerMessage({ channelID, streamerName: 'Timer_201', timerName: 'filter-fixture',
    message: '$(tts $(user ignore symbols numbers) says hello)', planTier: 'free', parse: parseSpecialCommands });
assert.equal(timerResult.parsedText, '');
assert.equal(speeches().length, before + 1);
assert.equal(speeches().at(-1).speech.text, 'Timer says hello');

if (process.env.SAAS_TARGET === 'api') {
    const response = await fetch('http://127.0.0.1:3000/config/site/analytics');
    assert.equal(response.status, 200, 'actual API entrypoint ready');
}
if (process.env.SAAS_TARGET === 'bot') {
    const response = await fetch('http://127.0.0.1:3333/eventsub', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    assert.equal(response.status, 403, 'actual bot entrypoint ready');
}
console.log(`PASS ${process.env.SAAS_TARGET}: username filters, nested TTS, literal message numbers, original identity and cron timer rendering`);
await redis.quit();
process.exit(0);
