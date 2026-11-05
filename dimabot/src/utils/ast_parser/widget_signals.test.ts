import assert from 'node:assert/strict';
import test, { beforeEach, mock } from 'node:test';
import type { CommandReferenceRequest } from './types.js';
import type { DimaSignal } from '../../widget_feed/types.js';

// Commands, chat and Dragonfly are test-owned mocks; signals are captured instead of published.
const commands = new Map<string, Record<string, unknown>>();
const sent: string[] = [];
mock.module('../../classes/command.class.js', { defaultExport: {
    getCommandFromDB: async (_channel: string, command: string) => ({ error: !commands.has(command), command: commands.get(command), message: 'missing', status: 404 }),
    updateCommandInDB: async () => undefined
} });
mock.module('../../classes/twitch_streamers.class.js', { defaultExport: { getTwitchAccountById: async () => ({ id: '12345', name: 'fixture', plan_tier: 'free' }) } });
mock.module('../databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => { throw new Error('Unexpected Redis access'); } } });
mock.module('../tokens.js', { namedExports: { getAppToken: async () => null } });
mock.module('../logger.js', { namedExports: { warn: async () => undefined, error: async () => undefined, info: async () => undefined } });
mock.module('./functions/index.js', { namedExports: { registerAllFunctions: () => undefined } });
const { commandHandler } = await import('../../handlers/commands.handler.js');
const { deliverAstMessage } = await import('../ast_command_delivery.js');
const { createTwitchEffectContext, scopeAstEffectContext } = await import('./effects.js');
const { getFunctionMetadata } = await import('./evaluator.js');
const { registerWidgetFunctions, widgetSignalHandler } = await import('./functions/widget.functions.js');
const { widgetSignals, signalJson } = await import('../../widget_feed/signals.js');
const { createUserIdentity } = await import('../permissions/index.js');
registerWidgetFunctions();

const published: { channel: string; signal: DimaSignal; actionKey?: string }[] = [];
let skipped = 0;
widgetSignals.publish = async (channel, signal, actionKey) => { published.push({ channel, signal, actionKey }); return 'sent'; };
widgetSignals.countSkipped = async () => { skipped++; };

const channelID = '12345', occurredAt = '2026-11-05T12:00:00.000Z';
const event = { broadcaster_user_id: channelID, message_id: 'chat-1', chatter_user_id: '42', chatter_user_name: 'Ada', chatter_user_login: 'ada', badges: [] };
const chatAuth = { origin: 'chat' as const, identity: createUserIdentity(1) };
const ingress = (chat?: { badges: { set_id: string; id: string; info: string }[] }) => createTwitchEffectContext({ channelId: channelID,
    origin: { kind: 'chat-command', id: event.message_id, occurredAt },
    actor: { userId: '42', displayName: 'Ada', ...(chat ? { chat: { login: 'ada', message: '!x', badges: chat.badges } } : {}) } });
const define = (name: string, message: string) => commands.set(name, { _id: `stored-${name}`, cmd: name, message, enabled: true, userLevel: 1, cooldown: 0 });
const delivery = {
    send: async (_channel: string, text: string) => { sent.push(text); return { error: false, message: 'sent' }; },
    execute: async (request: CommandReferenceRequest) => commandHandler(request.channelID, request.eventData, request.commandName, request.argument, request.authorization, request.state, request.effectContext)
};
async function command(name: string, argument = '', effect = ingress()) {
    const result = await commandHandler(channelID, event, name, argument, chatAuth, undefined, effect);
    await deliverAstMessage(channelID, { parsedText: result.message, commandReferences: result.commandReferences }, true, delivery);
    return result;
}
beforeEach(() => { commands.clear(); sent.length = 0; published.length = 0; skipped = 0; });

test('a chat command sends one signal with the viewer\'s value and verified sender; chat text stays', async () => {
    define('feed', 'Ada fed Mochi! $(widget.signal feed &p1)');
    const result = await command('feed', 'pizza');
    assert.equal(result.error, false);
    assert.deepEqual(sent, ['Ada fed Mochi!']);
    assert.equal(published.length, 1);
    const { channel, signal, actionKey } = published[0];
    assert.equal(channel, channelID);
    assert.match(actionKey!, /^signal:v1:[a-f0-9]{64}$/);
    assert.deepEqual({ ...signal, id: 'x', at: 0 }, { id: 'x', at: 0, name: 'feed', value: 'pizza', json: null, args: ['pizza'], target: null,
        user: { id: '42', login: 'ada', name: 'Ada', roles: { broadcaster: false, moderator: false, vip: false, subscriber: false } },
        source: { kind: 'command', name: 'feed' } });
    for (const name of ['widget.signal', 'widget.signal.to']) assert.deepEqual(
        { category: getFunctionMetadata(name)?.category, planTier: getFunctionMetadata(name)?.planTier, surfaces: getFunctionMetadata(name)?.surfaces },
        { category: 'overlay', planTier: 'free', surfaces: ['authoring'] });
});

test('roles come from signed badges; viewer text stays literal; JSON values and .to targets', async () => {
    define('mod', '$(widget.signal theme &t)');
    await command('mod', 'night', ingress({ badges: [{ set_id: 'moderator', id: '1', info: '' }, { set_id: 'subscriber', id: '12', info: '14' }] }));
    assert.deepEqual(published[0].signal.user!.roles, { broadcaster: false, moderator: true, vip: false, subscriber: true });
    define('inject', '$(widget.signal say &t)');
    await command('inject', '$(widget.signal hack) hi');
    assert.deepEqual(published.slice(1).map(p => [p.signal.name, p.signal.value]), [['say', '$(widget.signal hack) hi']], 'viewer text is data, not code');
    define('set', '$(widget.signal set &t)');
    await command('set', '{"color":"#f00","size":3}');
    assert.deepEqual(published.at(-1)!.signal.json, { color: '#f00', size: 3 });
    define('focus', '$(widget.signal.to "Chat box" FOCUS on)');
    await command('focus');
    assert.deepEqual([published.at(-1)!.signal.target, published.at(-1)!.signal.name, published.at(-1)!.signal.value], ['Chat box', 'focus', 'on']);
});

test('Studio snippets: quoted layer names reach .to exactly (spaces, apostrophes, accents)', async () => {
    for (const layer of ['Chat box', "Pet's corner", 'Mascota 2', 'Cámara, ¡hola!']) {
        define('to', `$(widget.signal.to "${layer}" feed &p1)`);
        await command('to', 'pizza');
        assert.deepEqual([published.at(-1)!.signal.target, published.at(-1)!.signal.name, published.at(-1)!.signal.value], [layer, 'feed', 'pizza'], layer);
    }
    assert.equal(published.length, 4);
});

test('five signals per run, shared with referenced commands; extra ones are skipped and counted', async () => {
    define('burst', Array.from({ length: 7 }, (_, i) => `$(widget.signal s${i})`).join(' '));
    await command('burst');
    assert.deepEqual(published.map(p => p.signal.name), ['s0', 's1', 's2', 's3', 's4']);
    assert.equal(skipped, 2);
    published.length = 0; skipped = 0;
    define('inner', '$(widget.signal i1) $(widget.signal i2) $(widget.signal i3)');
    define('outer', '$(widget.signal o1) $(widget.signal o2) $(widget.signal o3) #(inner)');
    await command('outer');
    assert.equal(published.length, 5, `references share the run budget (got ${published.map(p => p.signal.name)})`);
});

test('invalid names and values are errors and use no budget', async () => {
    define('bad', '$(widget.signal pet.feed x) $(widget.signal "" x)');
    const bad = await command('bad');
    assert.match(bad.message, /Error: invalid_widget_signal_name/);
    define('long', `$(widget.signal feed ${'x'.repeat(501)})`);
    assert.match((await command('long')).message, /widget_signal_too_long/);
    assert.equal(published.length, 0);
    // Viewer values may start with punctuation, or be a lone "." (only a dot followed by more name is a dotted name).
    define('move', '$(widget.signal move &p1)');
    await command('move', '-5');
    await command('move', '.');
    assert.deepEqual(published.map(p => [p.signal.name, p.signal.value, p.signal.json]), [['move', '-5', -5], ['move', '.', null]]);
});

test('no signal without live Twitch authority: missing, copied, other channel, AI requests', async () => {
    define('feed', '$(widget.signal feed now)');
    const effect = scopeAstEffectContext(ingress(), channelID, 'command:fixture');
    for (const attempt of [undefined, JSON.parse(JSON.stringify(effect)), scopeAstEffectContext(createTwitchEffectContext({ channelId: '999',
        origin: { kind: 'chat-command', id: 'x', occurredAt }, actor: { userId: '1', displayName: 'X' } }), '999', 'command:x')]) {
        const result = await commandHandler(channelID, event, 'feed', '', chatAuth, undefined, attempt);
        assert.match(result.message, /widget_signal_context_required/);
    }
    const llm = await commandHandler(channelID, event, 'feed', '', { origin: 'llm', identity: createUserIdentity(10) } as never, undefined, ingress());
    assert.match(llm.message, /widget_signal_context_required/);
    assert.equal(published.length, 0);
});

test('signal values: JSON only for numbers, booleans, arrays and objects', () => {
    assert.deepEqual(['42', '-1.5', 'true', '[1,2]', '{"a":1}', 'pizza', 'NaN', '1e999', 'null', '"text"', ''].map(signalJson),
        [42, -1.5, true, [1, 2], { a: 1 }, null, null, null, null, null, null]);
});

// The handler as the evaluator calls it for keyword bodies and Chat event messages (both need real Twitch ingress).
const authored = (effectContext: unknown, scope: { scopeName: string; scopeAliases?: string[]; commandName?: string }) => ({ enforceFunctionPermissions: false,
    authorization: { origin: 'authored' }, timerDepth: 0, platform: 'twitch', broadcasterId: channelID, effectContext, scopeAliases: [], ...scope }) as never;
test('keywords say so in source; event senders get no roles; anonymous events never read as the broadcaster', async () => {
    const send = widgetSignalHandler(false);
    await send(['wave'], authored(scopeAstEffectContext(ingress(), channelID, 'command:kw-1'), { scopeName: 'keyword:kw-1', scopeAliases: ['Hello_kw'], commandName: 'keyword:kw-1' }));
    assert.deepEqual(published.at(-1)!.signal.source, { kind: 'keyword', name: 'Hello_kw' });
    const event = (actor: { userId: string; displayName: string }) => scopeAstEffectContext(createTwitchEffectContext({ channelId: channelID,
        origin: { kind: 'twitch-event', id: 'evt-' + actor.userId, occurredAt }, actor }), channelID, 'eventsub:cheer');
    await send(['cheer'], authored(event({ userId: channelID, displayName: '' }), { scopeName: 'cheer' }));
    assert.deepEqual([published.at(-1)!.signal.user, published.at(-1)!.signal.source.kind], [null, 'event'], 'anonymous Bits fall back to the channel ID: no user');
    await send(['cheer'], authored(event({ userId: '77', displayName: 'Luna' }), { scopeName: 'cheer' }));
    assert.deepEqual(published.at(-1)!.signal.user, { id: '77', login: 'luna', name: 'Luna', roles: { broadcaster: false, moderator: false, vip: false, subscriber: false } });
});
