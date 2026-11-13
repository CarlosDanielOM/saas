import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

let appToken: string | null = 'app-token';
mock.module('../../utils/tokens.js', { namedExports: { getAppToken: async () => appToken } });
mock.module('../../utils/logger.js', { namedExports: { error: async () => undefined, warn: async () => undefined } });
mock.module('../../handlers/special_parser.handler.js', { namedExports: {
    parseSpecialCommands: async (text: string) => ({ parsedText: `${text} (parsed)`, count: 0, countModified: false })
} });

const { sendTwitchChatMessage } = await import('./send_message.chat.js');
const { pendingActivityRowsForTests, setActivityLogSinkForTests } = await import('../../utils/activity_log.js');

async function withFetch(reply: () => Promise<{ status: number; json: () => Promise<unknown> }>, run: () => Promise<void>) {
    const previous = globalThis.fetch;
    globalThis.fetch = mock.fn(reply) as unknown as typeof fetch;
    setActivityLogSinkForTests(async () => undefined);
    try { await run(); } finally {
        globalThis.fetch = previous;
        setActivityLogSinkForTests(null);
        appToken = 'app-token';
    }
}

const rows = () => pendingActivityRowsForTests().map(row => ({
    kind: row.kind, name: row.name, outcome: row.outcome, reason: row.reason, text: row.text, ref: row.ref,
    actorID: row.actorID, data: row.data
}));

test('a sent message is one ok row with its Twitch id; the return value is unchanged', async () => {
    await withFetch(async () => ({ status: 200, json: async () => ({ data: [{ message_id: 'tw-1', is_sent: true }] }) }), async () => {
        const result = await sendTwitchChatMessage('100', 'hello', 'msg-1', undefined, { origin: 'command', actor: { id: '42' } });
        assert.deepEqual(result, { error: false, message: 'Message sent', status: 200, type: 'success', data: { message_id: 'tw-1', is_sent: true } });
        assert.deepEqual(rows(), [{ kind: 'bot_message', name: 'command', outcome: 'ok', reason: '', text: 'hello', ref: 'tw-1',
            actorID: '42', data: { origin: 'command', messageId: 'tw-1', replyTo: 'msg-1' } }]);
        assert.equal(typeof pendingActivityRowsForTests()[0].durationMs, 'number');
    });
});

test('a parsed message records the parsed text and takes the origin from the context', async () => {
    await withFetch(async () => ({ status: 200, json: async () => ({ data: [{ message_id: 'tw-2', is_sent: true }] }) }), async () => {
        await sendTwitchChatMessage('100', 'hi $(user)', null, { channelID: '100', origin: 'alert' });
        assert.deepEqual(rows().map(row => [row.name, row.text]), [['alert', 'hi $(user) (parsed)']]);
    });
});

test('a held message is blocked; no origin means bot', async () => {
    await withFetch(async () => ({ status: 200, json: async () => ({ data: [{
        message_id: 'tw-3', is_sent: false, drop_reason: { code: 'automod_held', message: 'Held by AutoMod' }
    }] }) }), async () => {
        const result = await sendTwitchChatMessage('100', 'risky');
        assert.equal(result.type, 'held_for_moderation');
        assert.deepEqual(rows(), [{ kind: 'bot_message', name: 'bot', outcome: 'blocked', reason: 'held_for_moderation', text: 'risky',
            ref: 'tw-3', actorID: '', data: { origin: 'bot', messageId: 'tw-3', twitchMessage: 'Held by AutoMod' } }]);
    });
});

test('a rejected message records the HTTP status and what Twitch said, never the token', async () => {
    await withFetch(async () => ({ status: 403, json: async () => ({ error: 'Forbidden', message: 'The sender is banned' }) }), async () => {
        const result = await sendTwitchChatMessage('100', 'hello', null, undefined, { origin: 'timer' });
        assert.deepEqual(result, { error: true, message: 'The sender is banned', status: 403, type: 'Forbidden' });
        assert.deepEqual(rows(), [{ kind: 'bot_message', name: 'timer', outcome: 'failed', reason: 'twitch_rejected', text: 'hello', ref: '',
            actorID: '', data: { origin: 'timer', httpStatus: 403, twitchMessage: 'The sender is banned' } }]);
        assert.equal(JSON.stringify(pendingActivityRowsForTests()).includes('app-token'), false);
    });
});

test('a network error and a missing token are failed rows, recorded once', async () => {
    await withFetch(async () => { throw new Error('fetch failed'); }, async () => {
        const result = await sendTwitchChatMessage('100', 'hello');
        assert.equal(result.type, 'error');
        assert.deepEqual(rows().map(row => [row.outcome, row.reason]), [['failed', 'exception']]);
    });
    await withFetch(async () => { throw new Error('must not be called'); }, async () => {
        appToken = null;
        const result = await sendTwitchChatMessage('100', 'hello');
        assert.equal(result.message, 'Failed to get Twitch app token');
        assert.deepEqual(rows().map(row => [row.outcome, row.reason]), [['failed', 'no_token']]);
    });
});

test('an empty message sends nothing and writes no row', async () => {
    await withFetch(async () => { throw new Error('must not be called'); }, async () => {
        const result = await sendTwitchChatMessage('100', '   ');
        assert.equal(result.error, false);
        assert.deepEqual(rows(), []);
    });
});
