import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// Run the real harness while mocking all external I/O and tool execution.
const personality = { enabled: true, learningConfig: { semanticChatHistoryEnabled: false }, memoryPolicy: { allowUserPreferenceMemories: false } };
const cache = {
    get: mock.fn(async () => JSON.stringify(personality)), set: async () => {},
    hIncrBy: mock.fn(async (..._args: unknown[]) => 0), expire: mock.fn(async (..._args: unknown[]) => true)
};
const getTwitchAccountById = mock.fn(async () => ({ id: 'test-channel', name: 'miyu', plan_tier: 'pro' }));
const isAiCreditsExhausted = mock.fn(async (..._args: unknown[]) => false);
const ingestPolarSHEvent = mock.fn((_event: unknown) => {});
const constructChatSystemMessages = mock.fn(() => [{ role: 'user', content: 'Roast my bad luck' }]);
mock.module('../../databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => cache } });
mock.module('../../../classes/twitch_streamers.class.js', { defaultExport: { getTwitchAccountById } });
mock.module('../../../schemas/channel_ai_personality.schema.js', { namedExports: { ChannelAIPersonalitySchema: {} } });
mock.module('../../badges.js', { namedExports: { formatBadges: async () => ({ formattedBadges: '' }) } });
mock.module('../../billing.js', { namedExports: { isAiCreditsExhausted } });
mock.module('../../polarsh.js', { namedExports: { ingestPolarSHEvent } });
mock.module('../prompts.ai.js', { namedExports: { constructChatSystemMessages } });
mock.module('../chat_context.js', { namedExports: { mergeChatHistories: () => [] } });
mock.module('../../logger.js', { namedExports: { error: async () => {}, debug: async () => {} } });
mock.module('../../qdrant/functions/chat_logs/retrieve_chat_context.qdrant.js', { namedExports: { retrieveSemanticChatContext: async () => ({ error: false, items: [] }), getSemanticMemoryLimitForTier: () => 0 } });
mock.module('../../qdrant/functions/memory/retrieve_memory_context.qdrant.js', { namedExports: { retrieveChannelMemoryContext: async () => ({ error: true, items: [] }) } });
mock.module('../memory/memory.service.js', { namedExports: { getKnownUserMemoryContext: async () => [], recordChannelMemoryUsage: async () => {}, validateChannelMemoryContext: async () => [] } });
mock.module('../stream_context.ai.js', { namedExports: { getAIStreamContext: async () => null } });
mock.module('../emote_context.ai.js', { namedExports: { getChannelEmoteNames: async () => null } });

let assistantMessage: Record<string, unknown>;
let usage: Record<string, unknown> | undefined;
const providerResponse = async (_url: string, _init: RequestInit) => new Response(JSON.stringify({
    usage, choices: [{ message: provider.mock.callCount() === 0 ? assistantMessage : { role: 'assistant', content: 'Final reply' } }]
}), { status: 200 });
const provider = mock.fn(providerResponse);
mock.module('../fetch.utils.js', { namedExports: { createFetchWithRetry: () => provider } });
const executeTool = mock.fn(async (..._args: unknown[]) => ({ success: true, data: {} }));
const definitions = [{ type: 'function', function: { name: 'AST_PARSER', parameters: { type: 'object' } } }];
mock.module('../tools/index.js', { namedExports: { executeTool, getToolDefinitions: () => definitions } });
mock.module('../../../functions/moderation/index.js', { namedExports: {
    ban: async () => assert.fail('No moderation while generating an insult')
} });
const { chat, generateStandaloneText } = await import('./ai.js');
const { miyulootCommand } = await import('../../../commands/miyuloot.command.js');
const { MODELS } = await import('../constants.js');
const options = { channelID: 'test-channel', streamer: { user_id: 'test-channel', name: 'miyu', plan_tier: 'pro' as const }, message: 'Roast my bad luck' };

test.beforeEach(() => {
    personality.enabled = true;
    usage = undefined;
    provider.mock.mockImplementation(providerResponse);
    isAiCreditsExhausted.mock.mockImplementation(async () => false);
});
test.afterEach(() => {
    mock.restoreAll();
    provider.mock.resetCalls();
    executeTool.mock.resetCalls();
    cache.get.mock.resetCalls();
    cache.hIncrBy.mock.resetCalls();
    cache.expire.mock.resetCalls();
    getTwitchAccountById.mock.resetCalls();
    isAiCreditsExhausted.mock.resetCalls();
    ingestPolarSHEvent.mock.resetCalls();
    constructChatSystemMessages.mock.resetCalls();
});

const structuredCalls = [{ id: 'tool-test', type: 'function', function: { name: 'AST_PARSER', arguments: '{}' } }];
const dsml = '<｜DSML｜tool_calls><｜DSML｜invoke name="AST_PARSER"></｜DSML｜invoke></｜DSML｜tool_calls>';
for (const format of ['structured', 'DSML']) {
    test(`disabled tools ignore unsolicited ${format} tool calls`, async () => {
        assistantMessage = format === 'structured'
            ? { role: 'assistant', content: 'A fresh roast', tool_calls: structuredCalls }
            : { role: 'assistant', content: 'A fresh roast' + dsml };
        const result = await chat({ ...options, disableTools: true });
        assert.equal(executeTool.mock.callCount(), 0);
        assert.deepEqual(result, { error: false, message: 'A fresh roast' });
        assert.equal(provider.mock.callCount(), 1);
        const request = JSON.parse(String(provider.mock.calls[0].arguments[1].body));
        assert.deepEqual(request.tools, []);
    });
}
test('tool-only output with tools disabled returns empty text for the insult fallback', async () => {
    assistantMessage = { role: 'assistant', tool_calls: structuredCalls };
    const result = await chat({ ...options, disableTools: true });
    assert.equal(executeTool.mock.callCount(), 0);
    assert.deepEqual(result, { error: false, message: '' });
});
test('ordinary chat retains tool execution', async () => {
    assistantMessage = { role: 'assistant', content: null, tool_calls: structuredCalls };
    const result = await chat(options);
    assert.equal(executeTool.mock.callCount(), 1);
    assert.equal(provider.mock.callCount(), 2);
    assert.deepEqual(result, { error: false, message: 'Final reply' });
});

const roastMessages = [
    { role: 'system' as const, content: 'Dedicated roast instructions' },
    { role: 'user' as const, content: 'TestViewer lost the game' }
];
test('standalone generation ignores disabled personality and ambient chat context', async () => {
    personality.enabled = false;
    assistantMessage = { role: 'assistant', content: 'A fresh roast' };
    assert.deepEqual(await generateStandaloneText(options.streamer, roastMessages, 'miyuloot_insult'), {
        error: false, message: 'A fresh roast'
    });
    assert.equal(cache.get.mock.callCount(), 0);
    assert.equal(getTwitchAccountById.mock.callCount(), 0);
    assert.equal(constructChatSystemMessages.mock.callCount(), 0);
    assert.deepEqual(isAiCreditsExhausted.mock.calls[0].arguments, ['test-channel', cache]);
    const request = JSON.parse(String(provider.mock.calls[0].arguments[1].body));
    assert.deepEqual(request.messages, roastMessages);
    assert.equal(request.model, MODELS.pro);
    assert.ok(request.max_tokens <= 2048);
    assert.deepEqual(request.tools, []);
});
for (const format of ['structured', 'DSML']) {
    test(`standalone generation never executes ${format} tool calls`, async () => {
        assistantMessage = format === 'structured'
            ? { role: 'assistant', content: 'A fresh roast', tool_calls: structuredCalls }
            : { role: 'assistant', content: 'A fresh roast' + dsml };
        assert.deepEqual(await generateStandaloneText(options.streamer, roastMessages, 'miyuloot_insult'), {
            error: false, message: 'A fresh roast'
        });
        assert.equal(executeTool.mock.callCount(), 0);
        assert.equal(provider.mock.callCount(), 1);
    });
}
test('standalone generation preserves exhausted-credit model selection', async () => {
    isAiCreditsExhausted.mock.mockImplementation(async () => true);
    assistantMessage = { role: 'assistant', content: 'A fresh roast' };
    await generateStandaloneText(options.streamer, roastMessages, 'miyuloot_insult');
    const request = JSON.parse(String(provider.mock.calls[0].arguments[1].body));
    assert.equal(request.model, MODELS.exhausted);
});
test('standalone generation retains token usage and billing attribution', async () => {
    assistantMessage = { role: 'assistant', content: 'A fresh roast' };
    usage = { total_tokens: 30, prompt_tokens: 20, completion_tokens: 10,
        cost_details: { upstream_inference_prompt_cost: 0.01, upstream_inference_completions_cost: 0.02 } };
    await generateStandaloneText({ ...options.streamer, polar_sh_customer_id: 'dummy-customer' }, roastMessages, 'miyuloot_insult');
    assert.deepEqual(cache.hIncrBy.mock.calls.map(call => call.arguments), [
        ['test-channel:chatbot:usage', 'total_tokens', 30],
        ['test-channel:chatbot:usage', 'prompt_tokens', 20],
        ['test-channel:chatbot:usage', 'completion_tokens', 10]
    ]);
    assert.equal(cache.expire.mock.callCount(), 1);
    const event = ingestPolarSHEvent.mock.calls[0].arguments[0] as { reason: string; customerId: string; cost: number };
    assert.equal(event.reason, 'miyuloot_insult');
    assert.equal(event.customerId, 'dummy-customer');
    assert.equal(event.cost, 0.03);
});
test('standalone generation returns provider errors for the command fallback', async () => {
    provider.mock.mockImplementation(async () => new Response('Mock unavailable', { status: 503 }));
    const result = await generateStandaloneText(options.streamer, roastMessages, 'miyuloot_insult');
    assert.equal(result.error, true);
    assert.equal(result.status, 503);
});
test('standalone generation rejects missing channel context without requesting a provider', async () => {
    assert.equal((await generateStandaloneText({}, roastMessages, 'miyuloot_insult')).error, true);
    assert.equal(provider.mock.callCount(), 0);
});
test('real Miyuloot command generates through the real dedicated path with channel AI disabled', async context => {
    personality.enabled = false;
    assistantMessage = { role: 'assistant', content: 'TestViewer, hasta tu suerte pidió cambiar de streamer.' };
    context.mock.method(Math, 'random', () => 0);
    assert.deepEqual(await miyulootCommand('test-channel', {
        username: 'testviewer', 'display-name': 'TestViewer', 'user-id': 'test-user'
    }), { error: false, message: assistantMessage.content, status: 200, type: 'Miyu' });
    assert.equal(provider.mock.callCount(), 1);
    assert.equal(cache.get.mock.callCount(), 0);
    assert.equal(constructChatSystemMessages.mock.callCount(), 0);
    assert.equal(executeTool.mock.callCount(), 0);
    const request = JSON.parse(String(provider.mock.calls[0].arguments[1].body));
    assert.match(request.messages[0].content, /humor negro/);
    assert.equal(request.messages[1].content, JSON.stringify({ player: 'TestViewer', prize: 'Insulto' }));
    assert.deepEqual(request.tools, []);
});
test('ordinary chat still respects its disabled personality', async () => {
    personality.enabled = false;
    assert.equal((await chat(options)).error, true);
    assert.equal(provider.mock.callCount(), 0);
});

test('standalone generation converts provider exceptions into a fallback result', async () => {
    provider.mock.mockImplementation(async () => { throw new Error('Mock connection timeout'); });
    assert.deepEqual(await generateStandaloneText(options.streamer, roastMessages, 'miyuloot_insult'), {
        error: true, message: 'AI generation unavailable'
    });
    assert.equal(executeTool.mock.callCount(), 0);
});
test('real Miyuloot command falls back when standalone generation returns only a tool call', async context => {
    personality.enabled = false;
    assistantMessage = { role: 'assistant', tool_calls: structuredCalls };
    context.mock.method(Math, 'random', () => 0);
    assert.deepEqual(await miyulootCommand('test-channel', {
        username: 'testviewer', 'display-name': 'TestViewer', 'user-id': 'test-user'
    }), { error: false, message: 'Jaja que pendejo, no gano nada el baboso', status: 200, type: 'Miyu' });
    assert.equal(provider.mock.callCount(), 1);
    assert.equal(executeTool.mock.callCount(), 0);
});

for (const exhausted of [false, true]) {
    test(`Miyuloot pins DeepSeek V4.1 Flash when credits exhausted=${exhausted}`, async () => {
        isAiCreditsExhausted.mock.mockImplementation(async () => exhausted);
        assistantMessage = { role: 'assistant', content: 'A fresh roast' };
        const { generateMiyulootInsult } = await import('./miyuloot.ai.js');
        assert.equal((await generateMiyulootInsult(options.streamer, 'TestViewer')).error, false);
        const request = JSON.parse(String(provider.mock.calls[0].arguments[1].body));
        assert.equal(request.model, 'deepseek/deepseek-v4.1-flash');
        assert.match(request.messages[0].content, /metáforas macabras/);
        assert.equal(executeTool.mock.callCount(), 0);
    });
}
