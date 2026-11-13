import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

type Result = { error: boolean; message: string; status: number; type: string };
let nextResult: Result | Error = { error: false, message: 'hi', status: 200, type: 'success' };
const delivered: unknown[] = [];

mock.module('../utils/header.js', { namedExports: { TWITCH_BOT_ACCOUNT_ID: 'bot-id' } });
mock.module('../utils/keyword_cache.js', { namedExports: {
    keywordIndexCache: { get: async () => ({}) },
    getKeywordBody: async (_channelID: string, id: string) => ({ _id: id, cmd: 'hello there', func: 'custom', enabled: true })
} });
mock.module('../utils/keywords.js', { namedExports: {
    matchKeywords: () => [{ id: 'kw-1' }],
    keywordMatches: () => true,
    normalizeKeyword: (text: string) => text
} });
mock.module('./commands.handler.js', { namedExports: {
    executeCustomCommand: async () => { if (nextResult instanceof Error) throw nextResult; return nextResult; }
} });
mock.module('../utils/ast_command_delivery.js', { namedExports: {
    deliverAstMessage: async (_channelID: string, message: unknown) => { delivered.push(message); return { error: false, message: 'ok' }; }
} });

const { handleKeywords } = await import('./keywords.handler.js');
const { pendingActivityRowsForTests, setActivityLogSinkForTests } = await import('../utils/activity_log.js');

const event = {
    message_id: 'msg-9', chatter_user_id: '42', chatter_user_login: 'viewer', chatter_user_name: 'Viewer',
    message: { text: 'hello there everyone' }
} as never;

async function run(result: Result | Error) {
    nextResult = result;
    delivered.length = 0;
    setActivityLogSinkForTests(async () => undefined);
    let thrown: unknown = null;
    try { await handleKeywords('100', event, {} as never); } catch (error) { thrown = error; }
    const rows = pendingActivityRowsForTests().map(row => [row.name, row.outcome, row.reason, row.data.trigger, row.actorID, row.ref]);
    setActivityLogSinkForTests(null);
    return { rows, thrown };
}

test('a keyword that runs is an ok row and its reply is tagged as a command reply for the chatter', async () => {
    const { rows } = await run({ error: false, message: 'hi', status: 200, type: 'success' });
    assert.deepEqual(rows, [['hello there', 'ok', '', 'keyword', '42', 'msg-9']]);
    assert.deepEqual(delivered, [{ parsedText: 'hi', commandReferences: undefined, origin: 'command',
        actor: { id: '42', login: 'viewer', name: 'Viewer' }, referencePath: 'keyword:kw-1' }]);
});

test('a keyword on cooldown is skipped and sends nothing', async () => {
    const { rows } = await run({ error: true, message: 'Command is on cooldown', status: 429, type: 'command_cooldown' });
    assert.deepEqual(rows, [['hello there', 'skipped', 'cooldown', 'keyword', '42', 'msg-9']]);
    assert.deepEqual(delivered, []);
});

test('a keyword that throws is a failed row and the error still reaches the caller', async () => {
    const { rows, thrown } = await run(new Error('kaput'));
    assert.deepEqual(rows, [['hello there', 'failed', 'error', 'keyword', '42', 'msg-9']]);
    assert.equal((thrown as Error)?.message, 'kaput');
});
