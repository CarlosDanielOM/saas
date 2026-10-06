import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// Mock before importing the real command: never initialize Redis or Twitch clients.
const ban = mock.fn(async (..._args: unknown[]) => ({ error: false }));
const getDragonflyClient = mock.fn(async (_caller: string) => ({}));
mock.module('../functions/moderation/index.js', { namedExports: { ban } });
mock.module('../utils/databases/dragonfly.database.js', { namedExports: { getDragonflyClient } });
const streamer = { id: 'test-channel', name: 'miyu', plan_tier: 'pro' as const };
const generatedInsult = 'TestViewer, hasta tu mala suerte pidió cambiar de streamer.';
const generateMiyulootInsult = mock.fn(async (..._args: unknown[]) => ({ error: false, message: generatedInsult }));
const getTwitchAccountById = mock.fn(async (_id: string): Promise<typeof streamer | null> => streamer);
mock.module('../classes/twitch_streamers.class.js', { defaultExport: { getTwitchAccountById } });
mock.module('../utils/ai/openrouter/miyuloot.ai.js', { namedExports: { generateMiyulootInsult } });
const { miyulootCommand } = await import('./miyuloot.command.js');

const tags = { username: 'testviewer', 'display-name': 'TestViewer', 'user-id': 'test-user' };
const channelID = 'test-channel';
// Independent contract fixtures: retain the order and all relative weights.
const prizes = [
    { name: 'Insulto', weight: 0.66, message: generatedInsult },
    { name: 'besito', weight: 0.21, message: 'TestViewer ganó el besito!' },
    { name: 'VIP', weight: 0.024, message: 'TestViewer ganó el VIP por un stream!' },
    { name: '1 Cofre', weight: 0.005, message: 'TestViewer ganó 1 Cofre de StreamLoots!' },
    { name: 'IRL rana', weight: 0.0005, message: 'TestViewer ganó IRL rana asi que Miyu no sea floja y pongasela!' },
    { name: 'Timeout 15m', weight: 0.10, message: 'TestViewer ganó Timeout 15m, alli nos vemos!' },
    { name: '10 Cofres', weight: 0.0000005, message: 'TestViewer ganó 10 Cofres de StreamLoots!' },
    { name: 'Miyu Arriesgada', weight: 0.0001, message: 'Miyu TestViewer ganó la miyu arriesgada!' },
];
const total = prizes.reduce((sum, prize) => sum + prize.weight, 0);
const starts = prizes.map((_, index) => prizes.slice(0, index).reduce((sum, prize) => sum + prize.weight, 0));

test.beforeEach(() => {
    generateMiyulootInsult.mock.mockImplementation(async () => ({ error: false, message: generatedInsult }));
    getTwitchAccountById.mock.mockImplementation(async () => streamer);
});

test.afterEach(() => {
    mock.restoreAll(); // Restore Math.random even after an assertion fails.
    ban.mock.resetCalls();
    getDragonflyClient.mock.resetCalls();
    generateMiyulootInsult.mock.resetCalls();
    getTwitchAccountById.mock.resetCalls();
});

async function expectPrize(context: test.TestContext, rng: number, index: number) {
    assert.ok(rng >= 0 && rng < 1);
    let draws = 0;
    context.mock.method(Math, 'random', () => draws++ === 0 ? rng : 0);
    const result = await miyulootCommand(channelID, tags);
    assert.deepEqual(result, { error: false, message: prizes[index].message, status: 200, type: 'Miyu' });
    assert.equal(draws, 1);
    assert.equal(generateMiyulootInsult.mock.callCount(), index === 0 ? 1 : 0);
    assert.deepEqual(getTwitchAccountById.mock.calls.map(call => call.arguments), index === 0 ? [[channelID]] : []);
    if (index === 0) {
        assert.deepEqual(generateMiyulootInsult.mock.calls[0].arguments,
            [{ ...streamer, user_id: channelID }, tags['display-name']]);
    }
    assert.deepEqual(getDragonflyClient.mock.calls.map(call => call.arguments), [['miyulootCommand']]);
    assert.deepEqual(ban.mock.calls.map(call => call.arguments), index === 5
        ? [[channelID, tags['user-id'], '698614112', 15 * 60, 'Miyu Loot']]
        : []);
}

for (const [index, prize] of prizes.entries()) {
    test(`relative-weight interval selects ${prize.name}`, async context => {
        await expectPrize(context, (starts[index] + prize.weight / 2) / total, index);
    });
}

for (let index = 1; index < prizes.length; index++) {
    const boundary = starts[index] / total;
    test(`just below ${prizes[index].name} boundary selects previous prize`, async context => {
        await expectPrize(context, boundary - Number.EPSILON, index - 1);
    });
    test(`exact ${prizes[index].name} boundary selects next prize`, async context => {
        // These fixtures round-trip to the cumulative boundary in IEEE-754.
        assert.equal(boundary * total, starts[index]);
        await expectPrize(context, boundary, index);
    });
    test(`just above ${prizes[index].name} boundary selects next prize`, async context => {
        await expectPrize(context, boundary + Number.EPSILON, index);
    });
}

test('RNG=0 selects the first prize', async context => {
    await expectPrize(context, 0, 0);
});
test('RNG near 1 selects the last prize and its dedicated message', async context => {
    await expectPrize(context, 1 - Number.EPSILON / 2, 7);
});
test('non-normalized weights scale the draw by their actual total', async context => {
    assert.ok(Math.abs(total - 0.9996005) < Number.EPSILON);
    // Without scaling, this draw crosses the 1 Cofre / IRL rana boundary.
    await expectPrize(context, (starts[4] + starts[4] / total) / 2, 3);
});
test('Miyu Arriesgada uses its dedicated message', async context => {
    await expectPrize(context, (starts[7] + prizes[7].weight / 2) / total, 7);
});

const fallbackInsults = [
    'Jaja que pendejo, no gano nada el baboso',
    'Jaja, mejor suerte la proxima, pendejo',
    'Tu suerte es tan mala que ni la botarga de rana te quiere.',
    'Con esa suerte que tienes, compras la loteria y terminas perdiendo hasta tu casa',
    'Alguien intento ganar algo hoy y gano pura verga :)',
    'Felicidades, acabas de ganar pura verga',
    'Denle aplausos al pendejo que gano puro aire, a ver si con eso comes',
    'Y tu premio es valer verga, no te preocupes, es pura verga',
];

for (const failure of ['error', 'empty', 'status message', 'throws', 'missing streamer', 'lookup throws']) {
    test(`AI ${failure} preserves the static insult fallback`, async context => {
        generateMiyulootInsult.mock.mockImplementation(async () => {
            if (failure === 'throws') throw new Error('Mock provider unavailable');
            return { error: failure === 'error', message: failure === 'empty' ? '  ' : '[AI: Chat responses disabled]' };
        });
        getTwitchAccountById.mock.mockImplementation(async () => {
            if (failure === 'lookup throws') throw new Error('Mock cache unavailable');
            return failure === 'missing streamer' ? null : streamer;
        });
        context.mock.method(console, 'error', () => {});
        let draws = 0;
        context.mock.method(Math, 'random', () => draws++ === 0 ? 0 : 0.5);
        assert.deepEqual(await miyulootCommand(channelID, tags), {
            error: false, message: fallbackInsults[4], status: 200, type: 'Miyu'
        });
        assert.equal(generateMiyulootInsult.mock.callCount(), failure === 'missing streamer' || failure === 'lookup throws' ? 0 : 1);
        assert.equal(getTwitchAccountById.mock.callCount(), 1);
        assert.equal(draws, 2);
        assert.equal(ban.mock.callCount(), 0);
    });
}

test('AI insult is trimmed to one chat line', async context => {
    generateMiyulootInsult.mock.mockImplementation(async () => ({ error: false, message: '  TestViewer,\n tu suerte apesta.  ' }));
    context.mock.method(Math, 'random', () => 0);
    assert.equal((await miyulootCommand(channelID, tags)).message, 'TestViewer, tu suerte apesta.');
});
test('AI insult stays within 400 Unicode characters', async context => {
    generateMiyulootInsult.mock.mockImplementation(async () => ({ error: false, message: '🐸'.repeat(450) }));
    context.mock.method(Math, 'random', () => 0);
    assert.equal((await miyulootCommand(channelID, tags)).message, '🐸'.repeat(400));
});
test('fallback still selects the last of the eight original insults', async context => {
    generateMiyulootInsult.mock.mockImplementation(async () => ({ error: true, message: 'Unavailable' }));
    let draws = 0;
    context.mock.method(Math, 'random', () => draws++ === 0 ? 0 : 1 - Number.EPSILON / 2);
    assert.equal((await miyulootCommand(channelID, tags)).message, fallbackInsults[7]);
    assert.equal(generateMiyulootInsult.mock.callCount(), 1);
});
