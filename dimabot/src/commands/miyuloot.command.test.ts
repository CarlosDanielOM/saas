import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// Mock before importing the real command: never initialize Redis or Twitch clients.
const ban = mock.fn(async (..._args: unknown[]) => ({ error: false }));
const getDragonflyClient = mock.fn(async (_caller: string) => ({}));
mock.module('../functions/moderation/index.js', { namedExports: { ban } });
mock.module('../utils/databases/dragonfly.database.js', { namedExports: { getDragonflyClient } });
const { miyulootCommand } = await import('./miyuloot.command.js');

const tags = { username: 'testviewer', 'display-name': 'TestViewer', 'user-id': 'test-user' };
const channelID = 'test-channel';
// Independent contract fixtures: retain the order and all relative weights.
const prizes = [
    { name: 'Insulto', weight: 0.66, message: 'Jaja que pendejo, no gano nada el baboso' },
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

test.afterEach(() => {
    mock.restoreAll(); // Restore Math.random even after an assertion fails.
    ban.mock.resetCalls();
    getDragonflyClient.mock.resetCalls();
});

async function expectPrize(context: test.TestContext, rng: number, index: number) {
    assert.ok(rng >= 0 && rng < 1);
    let draws = 0;
    context.mock.method(Math, 'random', () => draws++ === 0 ? rng : 0);
    const result = await miyulootCommand(channelID, tags);
    assert.deepEqual(result, { error: false, message: prizes[index].message, status: 200, type: 'Miyu' });
    assert.equal(draws, index === 0 ? 2 : 1);
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
