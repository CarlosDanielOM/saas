import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// Real search, command and AST selection; authentication, HTTP and writes are fixtures.
mock.module('../../utils/header.js', { namedExports: { getTwitchAppHeader: async () => ({ 'Client-Id': 'fixture', Authorization: 'Bearer fixture' }) } });
mock.module('../../utils/logger.js', { namedExports: { error: async () => {}, debug: async () => {}, info: async () => {} } });
const { searchCategories } = await import('./search_categories.search.js');
mock.module('./index.js', { namedExports: { searchCategories } });
let writes: unknown[] = [];
mock.module('../channels/index.js', { namedExports: {
    getChannelInformation: async () => ({ error: false, data: { game_name: 'Current game' } }),
    setChannelInformation: async (_id: string, data: unknown) => { writes.push(data); return { error: false }; }
} });
mock.module('../chats/index.js', { namedExports: { sendTwitchChatMessage: async () => {} } });
mock.module('../users/index.js', { namedExports: { getTwitchUserByLogin: async () => ({}) } });
mock.module('../predictions/index.js', { namedExports: { createPrediction: async () => ({}), getPrediction: async () => ({}), endPrediction: async () => ({}) } });
mock.module('../polls/index.js', { namedExports: { createPoll: async () => ({}), getPoll: async () => ({}), endPoll: async () => ({}) } });
mock.module('../../classes/twitch_streamers.class.js', { defaultExport: {} });
mock.module('../../utils/ai/openrouter/command.ai.js', { namedExports: { executeAiCommand: async () => '' } });
mock.module('../../schemas/channel_fish_voice_favorites.schema.js', { namedExports: { getFishVoiceFavorites: async () => [] } });
mock.module('../../schemas/channel_tts_settings.schema.js', { namedExports: { setChannelFishVoice: async () => {} } });
mock.module('../../server/services/tts/fish_tts.service.js', { namedExports: { FISH_VOICES: {} } });
const { gameCommand } = await import('../../commands/game.command.js');
const { parse } = await import('../../utils/ast_parser/parser.js');
const { evaluate, createExecutionContext } = await import('../../utils/ast_parser/evaluator.js');
const { registerChannelFunctions } = await import('../../utils/ast_parser/functions/channel.functions.js');
registerChannelFunctions();

const category = (name: string, id = name) => ({ name, id, box_art_url: '' });
let queries: string[] = [];
let respond: (url: URL) => Response;
mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'api.twitch.tv');
    assert.equal(url.pathname, '/helix/search/categories');
    queries.push(url.searchParams.get('query') || '');
    return respond(url);
});
function setup(names: string[] | ((url: URL) => Response)) {
    queries = []; writes = [];
    respond = typeof names === 'function' ? names : () => Response.json({ data: names.map(name => category(name)) });
}
async function ast(query: string) {
    const parsed = parse(`$(set.game "${query}")`);
    assert.equal(parsed.error, undefined);
    return String((await evaluate(parsed.ast, createExecutionContext({ broadcasterId: 'fixture', userLevel: 7 }))).value);
}

test('screenshot: Arabic input selects Roman sequel despite base game first in both setters', async () => {
    setup(['Mortal Shell', 'Mortal Shell II']);
    assert.equal((await gameCommand('fixture', 'mortal shell 2', 7)).message, 'The game has been set to Mortal Shell II');
    assert.deepEqual(writes, [{ game_id: 'Mortal Shell II', game_name: 'Mortal Shell II' }]);
    writes = [];
    assert.equal(await ast('mortal shell 2'), '');
    assert.deepEqual(writes, [{ game_id: 'Mortal Shell II' }]);
});
test('search retrieves numeral variants omitted by the original Twitch query', async () => {
    setup(url => {
        assert.equal(url.searchParams.get('first'), '100');
        return Response.json({ data: [category(url.searchParams.get('query') === 'mortal shell ii' ? 'Mortal Shell II' : 'Mortal Shell')] });
    });
    assert.equal((await searchCategories('mortal shell 2')).data?.[0].name, 'Mortal Shell II');
    assert.deepEqual(queries, ['mortal shell 2', 'mortal shell ii']);
});
test('numerals in either direction, middle of titles, attached digits and subtitles', async () => {
    for (const [query, title] of [
        ['dark souls III', 'Dark Souls 3'], ['final fantasy 14 online', 'FINAL FANTASY XIV Online'],
        ['baldurs gate3', 'Baldur’s Gate III'], ['civilization 6', "Sid Meier's Civilization VI"],
        ['witcher 3', 'The Witcher 3: Wild Hunt'], ['cyberpunk 2077', 'Cyberpunk 2077']
    ]) {
        setup(['Unrelated Game', title]);
        const result = await searchCategories(query);
        assert.equal(result.error, false, query);
        assert.equal(result.data?.[0].name, title, query);
    }
});
test('base search retrieves subtitles but retains requested installment', async () => {
    setup(url => Response.json({ data: url.searchParams.get('query') === 'dark souls'
        ? ['Dark Souls', 'Dark Souls II', 'Dark Souls III: The Fire Fades Edition'].map(name => category(name)) : [] }));
    assert.equal((await searchCategories('dark souls 3')).data?.[0].name, 'Dark Souls III: The Fire Fades Edition');
    assert.deepEqual(queries, ['dark souls 3', 'dark souls iii', 'dark souls']);
});
test('missing or different installment never falls back to original game', async () => {
    setup(['Mortal Shell', 'Mortal Shell III']);
    assert.equal((await gameCommand('fixture', 'mortal shell 2', 7)).error, true);
    assert.match(await ast('mortal shell 2'), /Error finding game/);
    assert.deepEqual(writes, []);
});
test('exact base title wins; punctuation, accents, whitespace and partial names work', async () => {
    for (const [query, names, expected] of [
        ['mortal shell', ['Mortal Shell II', 'Mortal Shell'], 'Mortal Shell'],
        ['  Pokémon:   Violet  ', ['Pokémon Scarlet', 'Pokémon Violet'], 'Pokémon Violet'],
        ['baldurs gate 3', ['Baldur’s Gate', 'Baldur’s Gate III'], 'Baldur’s Gate III'],
        ['V Rising', ['V Rising'], 'V Rising'], ['fort', ['Fortnite Festival', 'Fortnite'], 'Fortnite']
    ] as const) {
        setup([...names]);
        assert.equal((await searchCategories(query)).data?.[0].name, expected, query);
    }
});
test('ambiguous franchises or editions ask for a specific title without writing', async () => {
    for (const [query, names] of [
        ['final fantasy', ['Final Fantasy VII', 'Final Fantasy XIV', 'Final Fantasy XVI']],
        ['dark souls 2', ['Dark Souls II: Scholar of the First Sin', 'Dark Souls II: Remastered']]
    ] as const) {
        setup([...names]);
        const result = await gameCommand('fixture', query, 7);
        assert.equal(result.error, true);
        assert.match(result.message, /more specific/i);
        assert.deepEqual(writes, []);
    }
});
test('empty, unrelated and unknown queries do not write; unauthorized callers read', async () => {
    setup([]);
    assert.equal((await gameCommand('fixture', 'unknown game', 7)).error, true);
    assert.deepEqual(writes, []);
    setup(['Unrelated Game']);
    assert.equal((await searchCategories('mortal shell')).data?.length, 0);
    setup(() => assert.fail('must not search'));
    assert.equal((await searchCategories('   ')).error, true);
    assert.equal((await gameCommand('fixture', 'mortal shell 2', 1)).message, 'The current game is Current game');
});
test('HTTP failures including variant searches propagate without writing', async () => {
    setup(() => Response.json({ error: 'Unauthorized', message: 'Fixture denied', status: 401 }, { status: 401 }));
    assert.equal((await gameCommand('fixture', 'mortal shell 2', 7)).message, 'Fixture denied');
    assert.deepEqual(writes, []);
    setup(url => url.searchParams.get('query') === 'mortal shell 2'
        ? Response.json({ data: [category('Mortal Shell')] }) : Response.json({ message: 'Fixture unavailable' }, { status: 503 }));
    assert.equal((await gameCommand('fixture', 'mortal shell 2', 7)).error, true);
    assert.deepEqual(writes, []);
});
test('duplicate IDs across queries do not cause false ambiguity', async () => {
    setup(() => Response.json({ data: [category('Dark Souls III: Deluxe', 'same-id')] }));
    assert.equal((await searchCategories('dark souls 3')).error, false);
});
