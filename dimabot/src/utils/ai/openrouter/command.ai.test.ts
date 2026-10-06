import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const chat = mock.fn(async (..._args: unknown[]) => ({ error: false, message: 'A fresh roast' }));
const getChannelPersonality = mock.fn(async (_channelID: string) => ({ enabled: true }));
mock.module('./ai.js', { namedExports: { chat, getChannelPersonality } });
mock.module('../../logger.js', { namedExports: { error: async () => {} } });
mock.module('../../../classes/twitch_streamers.class.js', { defaultExport: {
    getTwitchAccountById: async () => ({ id: 'test-channel', name: 'miyu', plan_tier: 'pro' })
} });
mock.module('../../databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => ({}) } });
mock.module('../../../functions/moderation/index.js', { namedExports: {
    ban: async () => assert.fail('An insult must never call moderation')
} });
const { miyulootCommand } = await import('../../../commands/miyuloot.command.js');
const { executeAiCommand } = await import('./command.ai.js');
const streamer = { user_id: 'test-channel', name: 'miyu', plan_tier: 'pro' as const };
const user = { username: 'TestViewer', userLevel: 1 };

test.beforeEach(() => {
    chat.mock.mockImplementation(async () => ({ error: false, message: 'A fresh roast' }));
});

test.afterEach(() => {
    mock.restoreAll();
    chat.mock.resetCalls();
    getChannelPersonality.mock.resetCalls();
});

test('Miyuloot can request the normal AI command path with tools disabled', async () => {
    const result = await executeAiCommand(streamer, user, 'Roast my bad luck', 'miyuloot', { disableTools: true });
    assert.deepEqual(result, { error: false, message: 'A fresh roast' });
    assert.deepEqual(chat.mock.calls[0].arguments, [{
        channelID: 'test-channel', message: 'Roast my bad luck', streamer, history: [],
        tags: { badges: [], username: 'TestViewer', userLevel: 1 }, disableTools: true
    }]);
    assert.deepEqual(getChannelPersonality.mock.calls[0].arguments, ['test-channel']);
});
test('ordinary AI commands retain tools by default', async () => {
    await executeAiCommand(streamer, user, 'An ordinary command');
    const options = chat.mock.calls[0].arguments[0] as { disableTools?: boolean };
    assert.notEqual(options.disableTools, true);
});
test('AI output remains sanitized with tools disabled', async () => {
    chat.mock.mockImplementation(async () => ({ error: false, message: '$' + '(ban) 100% *roast*' }));
    const result = await executeAiCommand(streamer, user, 'Roast', 'miyuloot', { disableTools: true });
    assert.equal(result.message, String.raw`\$(ban) 100\% \*roast\*`);
});

test('real Miyuloot command uses the real AI helper and returns sanitized generation', async context => {
    context.mock.method(Math, 'random', () => 0);
    chat.mock.mockImplementation(async () => ({ error: false, message: '  TestViewer,\n hasta tu suerte vale 0%.  ' }));
    const result = await miyulootCommand('test-channel', {
        username: 'testviewer', 'display-name': 'TestViewer', 'user-id': 'test-user'
    });
    assert.deepEqual(result, { error: false, message: String.raw`TestViewer, hasta tu suerte vale 0\%.`, status: 200, type: 'Miyu' });
    assert.equal(chat.mock.callCount(), 1);
    const options = chat.mock.calls[0].arguments[0] as { disableTools: boolean; channelID: string };
    assert.equal(options.disableTools, true);
    assert.equal(options.channelID, 'test-channel');
});
test('real Miyuloot command falls back when the real AI helper receives a provider error', async context => {
    context.mock.method(Math, 'random', () => 0);
    chat.mock.mockImplementation(async () => ({ error: true, message: 'Mock provider error' }));
    const result = await miyulootCommand('test-channel', {
        username: 'testviewer', 'display-name': 'TestViewer', 'user-id': 'test-user'
    });
    assert.deepEqual(result, { error: false, message: 'Jaja que pendejo, no gano nada el baboso', status: 200, type: 'Miyu' });
    assert.equal(chat.mock.callCount(), 1);
});
