import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { parse } from './parser.js';
import { createExecutionContext, evaluate } from './evaluator.js';

const forbiddenEffect = mock.fn(() => assert.fail('An unrelated provider action ran'));
const sentMessages: string[] = [];
const savedVoices: string[] = [];
let favorites = [
    { id: 'a'.repeat(32), name: 'My Favorite Voice', alias: 'my_favorite_voice' }
];
let failSave = false;

mock.module('../../functions/channels/index.js', { namedExports: { setChannelInformation: forbiddenEffect } });
mock.module('../../functions/chats/index.js', { namedExports: {
    sendTwitchChatMessage: async (_channelID: string, message: string) => { sentMessages.push(message); }
} });
mock.module('../../functions/users/index.js', { namedExports: { getTwitchUserByLogin: forbiddenEffect } });
mock.module('../../functions/search/index.js', { namedExports: { searchCategories: forbiddenEffect } });
mock.module('../../functions/predictions/index.js', { namedExports: { createPrediction: forbiddenEffect } });
mock.module('../../functions/polls/index.js', { namedExports: { createPoll: forbiddenEffect } });
mock.module('../../classes/twitch_streamers.class.js', { defaultExport: { getTwitchAccountById: forbiddenEffect } });
mock.module('../ai/openrouter/command.ai.js', { namedExports: { executeAiCommand: forbiddenEffect } });
mock.module('../../schemas/channel_fish_voice_favorites.schema.js', { namedExports: {
    getFishVoiceFavorites: async () => favorites
} });
mock.module('../../schemas/channel_tts_settings.schema.js', { namedExports: {
    setChannelFishVoice: async (_channelID: string, voice: string) => {
        if (failSave) throw new Error('test storage failure');
        savedVoices.push(voice);
    }
} });
mock.module('../../server/services/tts/fish_tts.service.js', { namedExports: { FISH_VOICES: {
    gojo: '1', rias_gremory: '2', toji_fushiguro: '3', carlos_bodoque: '4'
} } });

const { registerChannelFunctions } = await import('./functions/channel.functions.js');
registerChannelFunctions();

async function run(source: string, userLevel = 7): Promise<string> {
    const context = createExecutionContext({ broadcasterId: 'channel-123' });
    context.userLevel = userLevel;
    const parsed = parse(source);
    assert.equal(parsed.error, undefined);
    return String((await evaluate(parsed.ast, context)).value);
}

test('LLM level 6 cannot change the channel voice', async () => {
    const result = await run('$(set.voice gojo)', 6);
    assert.match(result, /permission denied.*set\.voice.*userlevel 7/i);
    assert.deepEqual(savedVoices, []);
});

test('all four built-in voices are accepted at level 7', async () => {
    for (const name of ['gojo', 'rias_gremory', 'toji_fushiguro', 'carlos_bodoque']) {
        assert.equal(await run(`$(set.voice ${name})`), '');
    }
    assert.deepEqual(savedVoices, ['gojo', 'rias_gremory', 'toji_fushiguro', 'carlos_bodoque']);
    assert.equal(sentMessages.length, 4);
});

test('saved favorite aliases and display names are accepted', async () => {
    assert.equal(await run('$(set.voice my_favorite_voice)'), '');
    assert.equal(await run('$(set.voice My Favorite Voice)'), '');
    assert.deepEqual(savedVoices.slice(-2), ['my_favorite_voice', 'my_favorite_voice']);
});

test('an unknown voice never changes settings', async () => {
    const previous = savedVoices.length;
    assert.match(await run('$(set.voice unknown_voice)'), /not on this account/i);
    assert.match(await run(`$(set.voice ${'b'.repeat(32)})`), /not on this account/i);
    assert.equal(savedVoices.length, previous);
});

test('missing name and failed persistence report an error', async () => {
    assert.match(await run('$(set.voice)'), /Usage:.*set\.voice/);
    const previous = sentMessages.length;
    failSave = true;
    assert.match(await run('$(set.voice gojo)'), /Unable to change/i);
    failSave = false;
    assert.equal(sentMessages.length, previous);
});
