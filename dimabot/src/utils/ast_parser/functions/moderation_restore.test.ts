import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// Exercise the real parser, ban.mod handler, and restore worker. All external
// effects are in-memory fixtures; no Twitch or production storage is reachable.
const jobs = new Map<string, string>();
const queue = new Map<string, number>();
const effects: string[] = [];
let moderator = false;
let roleError = false;
let unmodError = false;
let timeoutError = false;
let tick: (() => void) | undefined;
const cache = {
    set: async (key: string, value: string) => { jobs.set(key, value); },
    get: async (key: string) => jobs.get(key),
    del: async (key: string) => Number(jobs.delete(key)),
    zAdd: async (_key: string, entry: { value: string; score: number }) => { queue.set(entry.value, entry.score); },
    zRangeByScore: async (_key: string, _min: number, max: number) =>
        [...queue].filter(([, score]) => score <= max).map(([id]) => id),
    zRem: async (_key: string, id: string) => Number(queue.delete(id)),
};
mock.module('../../../utils/databases/dragonfly.database.js', {
    namedExports: { getDragonflyClient: async () => cache },
});
mock.module('../../../utils/header.js', { namedExports: { TWITCH_BOT_ACCOUNT_ID: 'fixture-bot' } });
mock.module('../../../classes/twitch_streamers.class.js', { defaultExport: {} });
mock.module('../../../schemas/vip.schema.js', { namedExports: { VipSchema: {} } });
mock.module('../../../schemas/temporary_moderator.schema.js', { namedExports: { TemporaryModeratorSchema: {} } });
mock.module('../../../utils/moderation/permit.js', {
    namedExports: { grantPermit: async () => {}, parsePermitArgs: () => ({}), PERMIT_USAGE: '' },
});
mock.module('../../../functions/chats/index.js', { namedExports: {} });
mock.module('../../../functions/users/index.js', { namedExports: {
    getTwitchUserByLogin: async (login: string) => ({ error: false, data: { id: 'fixture-user', login } }),
} });
mock.module('../../../functions/moderation/index.js', { namedExports: {
    isTwitchModeratorById: async () => ({ error: roleError, isModerator: moderator, message: 'Role lookup failed' }),
    ban: async (_channel: string, _user: string, _bot: string, seconds: number) => {
        effects.push(`timeout:${seconds}`);
        return { error: timeoutError, message: 'Timeout failed' };
    },
} });
mock.module('../../../functions/channels/index.js', { namedExports: {
    removeChannelModerator: async () => {
        effects.push('unmod');
        if (!unmodError) moderator = false;
        return { error: unmodError, message: 'Unmod failed' };
    },
    addModerator: async () => {
        effects.push('mod'); moderator = true;
        return { error: false, status: 200 };
    },
} });

const { parse } = await import('../parser.js');
const { evaluate, createExecutionContext } = await import('../evaluator.js');
const { registerModerationFunctions } = await import('./moderation.functions.js');
const { registerUserFunctions } = await import('./user.functions.js');
const interval = mock.method(globalThis, 'setInterval', (callback: () => void) => {
    tick = callback;
    return 0 as any;
});
registerModerationFunctions();
registerUserFunctions();
interval.mock.restore();
await new Promise<void>(resolve => setImmediate(resolve));

test.beforeEach(() => {
    jobs.clear(); queue.clear(); effects.length = 0;
    moderator = false; roleError = false; unmodError = false; timeoutError = false;
});

async function run(flag = 'true') {
    const parsed = parse(`$(ban.mod $(user) 900 ${flag})`);
    assert.equal(parsed.error, undefined);
    return (await evaluate(parsed.ast, createExecutionContext({
        broadcasterId: 'fixture-channel', userLevel: 10,
        eventData: { chatter_user_name: 'FixtureViewer' },
    }))).value;
}

async function processDueJobs() {
    const clock = mock.method(Date, 'now', () => 2 ** 50);
    try {
        assert.ok(tick);
        tick();
        await new Promise<void>(resolve => setImmediate(resolve));
    } finally {
        clock.mock.restore();
    }
}

test('ban.mod true never queues or grants mod to an ordinary viewer', async () => {
    assert.equal(await run(), '');
    assert.deepEqual(effects, ['timeout:900']);
    assert.equal(queue.size, 0);
    assert.equal(jobs.size, 0);
    await processDueJobs();
    assert.deepEqual(effects, ['timeout:900']);
    assert.equal(moderator, false);
});

test('ban.mod true restores a prior moderator only after the timeout', async () => {
    moderator = true;
    const before = Date.now();
    assert.equal(await run(), '');
    assert.deepEqual(effects, ['unmod', 'timeout:900']);
    assert.equal(moderator, false);
    assert.equal(queue.size, 1);
    assert.equal(jobs.size, 1);
    assert.ok([...queue.values()][0] >= before + 905000);
    await new Promise<void>(resolve => { tick!(); setImmediate(resolve); });
    assert.deepEqual(effects, ['unmod', 'timeout:900']);
    await processDueJobs();
    assert.deepEqual(effects, ['unmod', 'timeout:900', 'mod']);
    assert.equal(moderator, true);
    assert.equal(queue.size, 0);
    assert.equal(jobs.size, 0);
});

for (const flag of ['false', '']) {
    test(`ban.mod ${flag || 'omitted flag'} does not restore a prior moderator`, async () => {
        moderator = true;
        assert.equal(await run(flag), '');
        await processDueJobs();
        assert.deepEqual(effects, ['unmod', 'timeout:900']);
        assert.equal(queue.size, 0);
        assert.equal(moderator, false);
    });
}

for (const failure of ['role', 'unmod', 'timeout']) {
    test(`ban.mod does not schedule restoration after ${failure} failure`, async () => {
        moderator = true;
        roleError = failure === 'role';
        unmodError = failure === 'unmod';
        timeoutError = failure === 'timeout';
        assert.match(String(await run()), /failed/i);
        await processDueJobs();
        assert.equal(queue.size, 0);
        assert.equal(jobs.size, 0);
        assert.ok(!effects.includes('mod'));
        assert.deepEqual(effects, failure === 'role' ? [] : failure === 'unmod' ? ['unmod'] : ['unmod', 'timeout:900']);
    });
}
