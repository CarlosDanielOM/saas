import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// Keep the real parser, AST handlers and Helix adapters. Only authentication,
// storage and HTTP are fixtures; this suite cannot reach production services.
const botId = 'fixture-bot';
const header = { 'Client-Id': 'fixture', Authorization: 'Bearer fixture', 'Content-Type': 'application/json' };
const auth = async () => ({ error: false, message: 'fixture', header });
mock.module('../header.js', { namedExports: { TWITCH_BOT_ACCOUNT_ID: botId,
    getTwitchAppHeader: async () => header, getTwitchBotHeader: auth,
    getTwitchModeratorHeader: auth, getTwitchStreamerHeaderById: auth } });
mock.module('../logger.js', { namedExports: { error: async () => {}, debug: async () => {}, info: async () => {} } });
mock.module('../databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => ({
    zRangeByScore: async () => [], del: async () => 1
}) } });
mock.module('../../classes/twitch_streamers.class.js', { defaultExport: {} });
mock.module('../ai/openrouter/command.ai.js', { namedExports: { executeAiCommand: async () => '' } });
mock.module('../../functions/search/index.js', { namedExports: { searchCategories: async () => ({}) } });
const { isLive } = await import('../../functions/channels/is_live.channel.js');
const { sendAnnouncement } = await import('../../functions/chats/announcement.chat.js');
const { warnUser } = await import('../../functions/moderation/warn.moderation.js');
const { ban } = await import('../../functions/moderation/ban.moderation.js');
const { getTwitchUserByLogin } = await import('../../functions/users/get_user_by_login.users.js');
const { getPrediction } = await import('../../functions/predictions/get.prediction.js');
const { endPrediction } = await import('../../functions/predictions/end.prediction.js');
const { getPoll } = await import('../../functions/polls/get.poll.js');
mock.module('../../functions/channels/index.js', { namedExports: { isLive } });
mock.module('../../functions/chats/index.js', { namedExports: { sendAnnouncement } });
mock.module('../../functions/moderation/index.js', { namedExports: { warnUser, ban } });
mock.module('../../functions/users/index.js', { namedExports: { getTwitchUserByLogin } });
mock.module('../../functions/predictions/index.js', { namedExports: { getPrediction, endPrediction, createPrediction: async () => ({}) } });
mock.module('../../functions/polls/index.js', { namedExports: { getPoll, endPoll: async () => ({}), createPoll: async () => ({}) } });

const { parse } = await import('./parser.js');
const { evaluate, createExecutionContext, getFunctionMetadata } = await import('./evaluator.js');
const { registerChatFunctions } = await import('./functions/chat.functions.js');
const { registerTwitchFunctions } = await import('./functions/twitch.functions.js');
const { registerChannelFunctions } = await import('./functions/channel.functions.js');
const { registerModerationFunctions } = await import('./functions/moderation.functions.js');
const interval = mock.method(globalThis, 'setInterval', () => 0 as any);
registerModerationFunctions();
interval.mock.restore();
registerChatFunctions(); registerTwitchFunctions(); registerChannelFunctions();

type Call = { url: URL; method: string; body: any };
let calls: Call[] = [];
let respond: (call: Call) => Response;
mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: new URL(typeof input === 'object' && 'url' in input ? input.url : String(input)),
        method: init?.method || 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return respond(call);
});
function setup(handler: (call: Call) => Response) { calls = []; respond = handler; }
async function run(source: string, level = 7, authored = false) {
    const parsed = parse(source);
    assert.equal(parsed.error, undefined);
    return (await evaluate(parsed.ast, createExecutionContext({ broadcasterId: 'channel-1',
        userLevel: level, enforceFunctionPermissions: !authored }))).value;
}
async function runSelf(source: string, overrides: Record<string, unknown> = {}) {
    const parsed = parse(source);
    assert.equal(parsed.error, undefined);
    return (await evaluate(parsed.ast, createExecutionContext({
        broadcasterId: '100', userId: '200', userLogin: 'viewer', userLevel: 1,
        authorization: { origin: 'llm', identity: { level: 1, tags: [] } },
        ...overrides
    }))).value;
}
const prediction = (status: string) => ({ id: 'p1', title: 'Win?', status, outcomes: [{ id: 'yes', title: 'Yes' }, { id: 'no', title: 'No' }] });
const poll = (status: string) => ({ id: 'poll1', title: 'Next game?', status, choices: [{ id: 'a', title: 'A', votes: 8 }, { id: 'b', title: 'B', votes: 3 }] });

test('lock.prediction fetches the current ID and locks without choosing a winner', async () => {
    setup(call => Response.json({ data: [prediction(call.method === 'PATCH' ? 'LOCKED' : 'ACTIVE')] }));
    assert.equal(await run('$(lock.prediction)'), '');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url.searchParams.get('broadcaster_id'), 'channel-1');
    assert.deepEqual(calls[1].body, { broadcaster_id: 'channel-1', id: 'p1', status: 'LOCKED' });
});
test('locking is idempotent and never mutates a finished or absent prediction', async () => {
    setup(() => Response.json({ data: [prediction('LOCKED')] }));
    assert.equal(await run('$(lock.prediction)'), '');
    assert.equal(calls.length, 1);
    setup(() => Response.json({ data: [prediction('RESOLVED')] }));
    assert.match(String(await run('$(lock.prediction)')), /no active prediction/);
    assert.equal(calls.length, 1);
    setup(() => Response.json({ data: [] }));
    assert.match(String(await run('$(lock.prediction)')), /not found/i);
    assert.equal(calls.length, 1);
});
test('poll reading returns numbered options, totals and status for active or finished polls', async () => {
    for (const status of ['ACTIVE', 'COMPLETED', 'ARCHIVED']) {
        setup(() => Response.json({ data: [poll(status)] }));
        const output = String(await run('$(get.poll)'));
        assert.match(output, /Next game\?/); assert.match(output, /1: A \(8 votes\)/);
        assert.match(output, /2: B \(3 votes\)/); assert.ok(output.includes(status));
        assert.equal(calls.length, 1); assert.equal(calls[0].method, 'GET');
    }
});
test('poll reading prefers active over older finished polls and reports missing polls', async () => {
    setup(() => Response.json({ data: [{ ...poll('ARCHIVED'), title: 'Old' }, poll('ACTIVE')] }));
    assert.match(String(await run('$(get.poll)')), /Next game/);
    setup(() => Response.json({ data: [] }));
    assert.match(String(await run('$(get.poll)')), /not found/i);
});
test('announce and its alias send full messages with the bot moderator identity', async () => {
    setup(() => new Response(null, { status: 204 }));
    assert.equal(await run('$(announce Hello everyone!)'), '');
    assert.deepEqual(calls[0].body, { message: 'Hello everyone!', color: 'primary' });
    assert.equal(calls[0].url.searchParams.get('moderator_id'), botId);
    assert.equal(calls[0].url.pathname, '/helix/chat/announcements');
    assert.equal(await run('$(chat.announcement purple "Five minutes left!")'), '');
    assert.deepEqual(calls[1].body, { message: 'Five minutes left!', color: 'purple' });
    assert.equal(getFunctionMetadata('chat.announcement')?.aliasOf, 'announce');
});
test('announce rejects empty or oversized messages before sending', async () => {
    setup(() => assert.fail('must not send'));
    for (const expression of ['$(announce)', '$(announce purple)', `$(announce "${'a'.repeat(501)}")`]) {
        assert.match(String(await run(expression)), /Usage:|at most 500/);
    }
    assert.equal(calls.length, 0);
});
test('warn resolves the target and uses the bot token identity with the complete reason', async () => {
    setup(call => Response.json({ data: call.url.pathname.endsWith('/users') ? [{ id: 'target-id' }] : [{}] }));
    assert.equal(await run('$(warn @SomeUser Please stop posting spoilers)'), '');
    assert.equal(calls[0].url.searchParams.get('login'), 'someuser');
    assert.equal(calls[1].url.pathname, '/helix/moderation/warnings');
    assert.equal(calls[1].url.searchParams.get('moderator_id'), botId);
    assert.deepEqual(calls[1].body, { data: { user_id: 'target-id', reason: 'Please stop posting spoilers' } });
});
test('warn rejects missing reasons and does not warn missing users', async () => {
    setup(() => Response.json({ data: [] }));
    assert.match(String(await run('$(warn someuser)')), /Usage:/);
    assert.match(String(await run('$(warn someuser "")')), /Usage:/);
    assert.equal(calls.length, 0);
    assert.match(String(await run('$(warn someuser No spoilers)')), /User not found/);
    assert.equal(calls.length, 1);
});
test('AI self moderation targets the verified chatter ID for timeout and ban', async () => {
    setup(() => Response.json({ data: [{}] }));
    assert.equal(await runSelf('$(ban.self 600)'), '');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.pathname, '/helix/moderation/bans');
    assert.equal(calls[0].url.searchParams.get('broadcaster_id'), '100');
    assert.equal(calls[0].url.searchParams.get('moderator_id'), botId);
    assert.deepEqual(calls[0].body, { data: { user_id: '200', duration: 600, reason: 'DimaBot AI channel rule violation' } });
    assert.equal(await runSelf('$(ban.self)'), '');
    assert.deepEqual(calls[1].body, { data: { user_id: '200', reason: 'DimaBot AI channel rule violation' } });
});
test('AI self moderation rejects missing identity, other targets, authored calls and bad durations', async () => {
    setup(() => Response.json({ data: [{}] }));
    assert.match(String(await runSelf('$(ban anotheruser 600)')), /permission denied/i);
    for (const overrides of [
        { userId: '' }, { userId: 'anotheruser' }, { userId: '100' },
        { userId: botId }, { userLevel: 7 }, { authorization: { origin: 'chat' } },
        { enforceFunctionPermissions: false }
    ]) {
        assert.match(String(await runSelf('$(ban.self 600)', overrides)), /self moderation requires/i);
    }
    for (const source of ['$(ban.self 0)', '$(ban.self 604801)', '$(ban.self abc)', '$(ban.self 600 otheruser)']) {
        assert.match(String(await runSelf(source)), /Error:|Usage:/);
    }
    assert.equal(calls.length, 0);
});
test('AI self moderation surfaces Twitch failures', async () => {
    setup(() => Response.json({ error: 'Forbidden', message: 'Fixture denied' }, { status: 403 }));
    assert.match(String(await runSelf('$(ban.self 600)')), /^Error: Fixture denied$/);
});
test('moderator permission is checked before lookups or mutations, authored templates retain their outer gate', async () => {
    setup(() => new Response(null, { status: 204 }));
    for (const action of ['lock.prediction', 'get.poll', 'announce hello', 'chat.announcement hello', 'warn user reason']) {
        assert.match(String(await run(`$(${action})`, 1)), /permission denied/i);
    }
    assert.equal(calls.length, 0);
    assert.equal(await run('$(announce hello)', 1, true), '');
    assert.equal(calls.length, 1);
});
test('Twitch errors are returned for actions without claiming success', async () => {
    setup(() => Response.json({ error: 'Forbidden', message: 'Fixture denied' }, { status: 403 }));
    for (const action of ['lock.prediction', 'get.poll', 'announce hello', 'warn user reason']) {
        assert.match(String(await run(`$(${action})`)), /Fixture denied/);
    }
    setup(call => call.method === 'GET' ? Response.json({ data: [prediction('ACTIVE')] })
        : Response.json({ error: 'Forbidden', message: 'Lock denied' }, { status: 403 }));
    assert.match(String(await run('$(lock.prediction)')), /Lock denied/);
});
test('twitch.live works in true/false conditionals without moderator permission', async () => {
    for (const live of [true, false]) {
        setup(() => Response.json({ data: live ? [{ id: 'stream-1' }] : [] }));
        assert.equal(await run('$(twitch.live)', 1), String(live));
        assert.equal(await run('*($(twitch.live) ? "Live" : "Offline")', 1), live ? 'Live' : 'Offline');
        assert.equal(await run('*($(twitch.live) == true ? "Live" : "Offline")', 1), live ? 'Live' : 'Offline');
    }
});
test('live lookup failure cannot become a truthy error string or run live-only actions', async () => {
    setup(() => Response.json({ error: 'Unavailable', message: 'Fixture unavailable' }, { status: 503 }));
    assert.equal(await run('*($(twitch.live) ? $(announce should-not-send) : "Unavailable")'), 'Unavailable');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.pathname, '/helix/streams');
});
