import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

let executedContext: Record<string, any> | undefined;
mock.module('../../ast_command_delivery.js', { namedExports: { deliverAstMessage: async () => {} } });
mock.module('../../ast_parser/index.js', { namedExports: {
    parseAndEvaluate: async (_command: string, context: Record<string, any>) => {
        executedContext = context;
        return { result: '', context: { commandReferences: [] } };
    }
} });
mock.module('../ast_catalog/index.js', { namedExports: { findAstCatalogEntry: () => undefined } });
mock.module('../../../classes/twitch_streamers.class.js', { defaultExport: {
    getTwitchAccountById: async () => ({ plan_tier: 'free' })
} });

const { execute } = await import('./ast_parser.tool.js');

test('AST tool binds the self-moderation target to the verified EventSub ID', async () => {
    const result = await execute({ command: 'ban.self 600', userlevel: 9 }, {
        channelID: '100', streamer: {}, username: 'Viewer', userID: '200',
        tags: { chatter_user_id: '200', userLevel: 1 }
    });
    assert.equal(result.success, true);
    assert.equal(executedContext?.userId, '200');
    assert.equal(executedContext?.userLevel, 1);
    assert.equal(executedContext?.authorization.origin, 'llm');
});

test('AST tool withholds the self-moderation target when the EventSub ID is absent or mismatched', async () => {
    for (const tags of [{ userLevel: 1 }, { userLevel: 1, chatter_user_id: '201' }]) {
        await execute({ command: 'ban.self 600', userlevel: 1 }, {
            channelID: '100', streamer: {}, username: 'Viewer', userID: '200', tags
        });
        assert.equal(executedContext?.userId, '');
    }
});
