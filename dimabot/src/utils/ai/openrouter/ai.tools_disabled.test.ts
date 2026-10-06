import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// Run the real harness while mocking all external I/O and tool execution.
const personality = { enabled: true, learningConfig: { semanticChatHistoryEnabled: false }, memoryPolicy: { allowUserPreferenceMemories: false } };
const cache = { get: async () => JSON.stringify(personality), set: async () => {} };
mock.module('../../databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => cache } });
mock.module('../../../classes/twitch_streamers.class.js', { defaultExport: { getTwitchAccountById: async () => ({ id: 'test-channel', name: 'miyu', plan_tier: 'pro' }) } });
mock.module('../../../schemas/channel_ai_personality.schema.js', { namedExports: { ChannelAIPersonalitySchema: {} } });
mock.module('../../badges.js', { namedExports: { formatBadges: async () => ({ formattedBadges: '' }) } });
mock.module('../../billing.js', { namedExports: { isAiCreditsExhausted: async () => false } });
mock.module('../../polarsh.js', { namedExports: { ingestPolarSHEvent: () => assert.fail('No real billing in tests') } });
mock.module('../prompts.ai.js', { namedExports: { constructChatSystemMessages: () => [{ role: 'user', content: 'Roast my bad luck' }] } });
mock.module('../chat_context.js', { namedExports: { mergeChatHistories: () => [] } });
mock.module('../../logger.js', { namedExports: { error: async () => {}, debug: async () => {} } });
mock.module('../../qdrant/functions/chat_logs/retrieve_chat_context.qdrant.js', { namedExports: { retrieveSemanticChatContext: async () => ({ error: false, items: [] }), getSemanticMemoryLimitForTier: () => 0 } });
mock.module('../../qdrant/functions/memory/retrieve_memory_context.qdrant.js', { namedExports: { retrieveChannelMemoryContext: async () => ({ error: true, items: [] }) } });
mock.module('../memory/memory.service.js', { namedExports: { getKnownUserMemoryContext: async () => [], recordChannelMemoryUsage: async () => {}, validateChannelMemoryContext: async () => [] } });
mock.module('../stream_context.ai.js', { namedExports: { getAIStreamContext: async () => null } });
mock.module('../emote_context.ai.js', { namedExports: { getChannelEmoteNames: async () => null } });

let assistantMessage: Record<string, unknown>;
const provider = mock.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({
    choices: [{ message: provider.mock.callCount() === 0 ? assistantMessage : { role: 'assistant', content: 'Final reply' } }]
}), { status: 200 }));
mock.module('../fetch.utils.js', { namedExports: { createFetchWithRetry: () => provider } });
const executeTool = mock.fn(async (..._args: unknown[]) => ({ success: true, data: {} }));
const definitions = [{ type: 'function', function: { name: 'AST_PARSER', parameters: { type: 'object' } } }];
mock.module('../tools/index.js', { namedExports: { executeTool, getToolDefinitions: () => definitions } });
const { chat } = await import('./ai.js');
const options = { channelID: 'test-channel', streamer: { user_id: 'test-channel', name: 'miyu', plan_tier: 'pro' as const }, message: 'Roast my bad luck' };

test.afterEach(() => {
    mock.restoreAll();
    provider.mock.resetCalls();
    executeTool.mock.resetCalls();
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
