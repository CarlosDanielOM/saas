// Use ast-timer-fixtures for API/bot, or roulette-fixtures/cron-env.json for
// cron. Each candidate runs its normal entrypoint with disposable Mongo/Redis
// and blocked external providers. The compiled regression suite replaces all
// moderation/storage boundaries and cannot grant roles to real Twitch users.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const target = process.env.SAAS_TARGET;
const entrypoint = { api: 'server/index.js', bot: 'bot/index.js', cron: 'workers/cron.index.js' }[target];
assert.ok(entrypoint, 'expected an API, bot, or cron candidate');
assert.ok(readFileSync('/proc/1/cmdline', 'utf8').includes(`dist/${entrypoint}`), 'normal service entrypoint');

if (target !== 'cron') {
    const bot = target === 'bot';
    let ready = false;
    const deadline = Date.now() + 15000;
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

execFileSync(process.execPath, ['--experimental-test-module-mocks', '--test', '--test-concurrency=1',
    'dist/utils/ast_parser/functions/moderation_restore.test.js',
    'dist/utils/ast_parser/functions/moderation.test.js',
    'dist/utils/ast_parser/channel_actions.test.js',
    'dist/utils/ast_parser/permission_gate_authored.test.js'], { stdio: 'inherit', timeout: 30000 });
console.log(`PASS ${target}: ordinary viewers never gain mod; prior mods restore after timeout; opt-out and failures do not queue grants; parser and permission regressions pass`);
