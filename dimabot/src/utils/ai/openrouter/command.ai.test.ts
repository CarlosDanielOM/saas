import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const chat = mock.fn(async (..._args: unknown[]) => ({ error: false, message: 'A fresh roast' }));
const generateStandaloneText = mock.fn(async (..._args: unknown[]) => ({ error: false, message: 'A fresh roast' }));
const getChannelPersonality = mock.fn(async (_channelID: string) => ({ enabled: true }));
mock.module('./ai.js', { namedExports: { chat, getChannelPersonality, generateStandaloneText } });
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
    generateStandaloneText.mock.mockImplementation(async () => ({ error: false, message: 'A fresh roast' }));
});

test.afterEach(() => {
    mock.restoreAll();
    chat.mock.resetCalls();
    generateStandaloneText.mock.resetCalls();
    getChannelPersonality.mock.resetCalls();
});

test('ordinary AI helper supports explicitly disabled tools', async () => {
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

test('real Miyuloot command uses its dedicated AI helper and returns sanitized generation', async context => {
    context.mock.method(Math, 'random', () => 0);
    generateStandaloneText.mock.mockImplementation(async () => ({ error: false, message: '  TestViewer,\n hasta tu suerte vale 0%.  ' }));
    const result = await miyulootCommand('test-channel', {
        username: 'testviewer', 'display-name': 'TestViewer', 'user-id': 'test-user'
    });
    assert.deepEqual(result, { error: false, message: String.raw`TestViewer, hasta tu suerte vale 0\%.`, status: 200, type: 'Miyu' });
    assert.equal(generateStandaloneText.mock.callCount(), 1);
    assert.equal(chat.mock.callCount(), 0);
    const [account, messages, reason] = generateStandaloneText.mock.calls[0].arguments as [typeof streamer, Array<{role: string; content: string}>, string];
    assert.equal(account.user_id, 'test-channel');
    assert.equal(reason, 'miyuloot_insult');
    assert.equal(messages[0].role, 'system');
    assert.match(messages[0].content, /humor negro/);
    assert.equal(messages[1].content, JSON.stringify({ player: 'TestViewer', prize: 'Insulto' }));
});
test('real Miyuloot command falls back when its dedicated AI helper receives a provider error', async context => {
    context.mock.method(Math, 'random', () => 0);
    generateStandaloneText.mock.mockImplementation(async () => ({ error: true, message: 'Mock provider error' }));
    const result = await miyulootCommand('test-channel', {
        username: 'testviewer', 'display-name': 'TestViewer', 'user-id': 'test-user'
    });
    assert.deepEqual(result, { error: false, message: 'Jaja que pendejo, no gano nada el baboso', status: 200, type: 'Miyu' });
    assert.equal(generateStandaloneText.mock.callCount(), 1);
});

test('Miyuloot generates a roast while normal channel AI is disabled', async context => {
    context.mock.method(Math, 'random', () => 0);
    getChannelPersonality.mock.mockImplementation(async () => ({ enabled: false }));
    try {
        const result = await miyulootCommand('test-channel', {
            username: 'testviewer', 'display-name': 'TestViewer', 'user-id': 'test-user'
        });
        assert.equal(result.message, 'A fresh roast');
    } finally {
        getChannelPersonality.mock.mockImplementation(async () => ({ enabled: true }));
    }
});
test('Miyuloot does not consult the channel personality', async context => {
    context.mock.method(Math, 'random', () => 0);
    await miyulootCommand('test-channel', {
        username: 'testviewer', 'display-name': 'TestViewer', 'user-id': 'test-user'
    });
    assert.equal(getChannelPersonality.mock.callCount(), 0);
});

test('ordinary AI commands still stop when channel AI is disabled', async () => {
    getChannelPersonality.mock.mockImplementation(async () => ({ enabled: false }));
    try {
        assert.deepEqual(await executeAiCommand(streamer, user, 'An ordinary command'), {
            error: false, message: '[AI: Chat responses disabled]'
        });
        assert.equal(chat.mock.callCount(), 0);
        assert.equal(generateStandaloneText.mock.callCount(), 0);
    } finally {
        getChannelPersonality.mock.mockImplementation(async () => ({ enabled: true }));
    }
});
