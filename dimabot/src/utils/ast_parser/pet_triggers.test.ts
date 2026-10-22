import assert from 'node:assert/strict';
import test, { beforeEach, mock } from 'node:test';
import { Types } from 'mongoose';
import type { AdmitPetActionInput } from '../../pets/admission.js';
import type { DomainEventEnvelope } from '../../domain_events/domain_event.types.js';
import type { ChatAnnouncementDependencies } from '../../domain_events/chat_announcement_events.js';
import type { CommandReferenceRequest } from './types.js';

// All services/providers/chat are test-owned mocks. No environment credentials or paid effects.
const commands = new Map<string, Record<string, unknown>>();
const admissions: AdmitPetActionInput[] = [];
const accepted = new Map<string, string>();
let rejection: unknown;
let appToken: string | null = null;
let tokenReads = 0;
let sendFails = false;
let chatSends = 0;
const sent: string[] = [];
mock.module('../../classes/command.class.js', { defaultExport: {
    getCommandFromDB: async (_channel: string, command: string) => ({ error: !commands.has(command),
        command: commands.get(command), message: 'missing', status: 404 }),
    updateCommandInDB: async () => undefined
} });
mock.module('../../classes/twitch_streamers.class.js', { defaultExport: {
    getTwitchAccountById: async () => ({ id: '12345', name: 'fixture', plan_tier: 'premium' })
} });
mock.module('../databases/dragonfly.database.js', { namedExports: {
    getDragonflyClient: async () => { throw new Error('Unexpected Redis access'); }
} });
mock.module('../tokens.js', { namedExports: { getAppToken: async () => { tokenReads++; return appToken; } } });
mock.module('../logger.js', { namedExports: { warn: async () => undefined, error: async () => undefined, info: async () => undefined } });
mock.module('./functions/index.js', { namedExports: { registerAllFunctions: () => undefined } });
mock.module('../../pets/admission.js', { namedExports: { admitPetAction: async (input: AdmitPetActionInput) => {
    admissions.push(structuredClone(input));
    if (rejection) throw rejection;
    const key = JSON.stringify([input.channelId, input.origin.kind, input.origin.id, input.actionKey]);
    // A minimal receipt ledger tests producer identities, not backend provider/billing dedupe.
    if (!accepted.has(key)) accepted.set(key, `request-${accepted.size}`);
    return { requestId: accepted.get(key), status: 'accepted' };
} } });
const { commandHandler } = await import('../../handlers/commands.handler.js');
const { parseSpecialCommands } = await import('../../handlers/special_parser.handler.js');
const { sendTwitchChatMessage } = await import('../../functions/chats/send_message.chat.js');
const { applyChatAnnouncementDomainEvent } = await import('../../domain_events/chat_announcement_events.js');
const { deliverAstMessage } = await import('../ast_command_delivery.js');
const { createTwitchEffectContext, scopeAstEffectContext } = await import('./effects.js');
const { createExecutionContext, evaluate, registerFunction, getFunctionMetadata } = await import('./evaluator.js');
const { parse } = await import('./parser.js');
const { snapshotTimerContext } = await import('./timer.js');
const { registerPetFunctions } = await import('./functions/pet.functions.js');
const { createUserIdentity } = await import('../permissions/index.js');
registerPetFunctions();
const channelID = '12345';
const occurredAt = '2026-10-22T12:00:00.000Z';
const event = { broadcaster_user_id: channelID, message_id: 'chat-1', chatter_user_id: '42', chatter_user_name: 'Viewer',
    chatter_user_login: 'viewer', badges: [{ set_id: 'broadcaster', id: '1', info: '' }] };
const chatAuth = { origin: 'chat' as const, identity: createUserIdentity(1) };
function ingress() {
    return createTwitchEffectContext({ channelId: channelID, origin: { kind: 'chat-command', id: event.message_id, occurredAt },
        actor: { userId: event.chatter_user_id, displayName: event.chatter_user_name } });
}
function define(name: string, message: string, extras = {}) {
    commands.set(name, { _id: `stored-${name}`, cmd: name, message, enabled: true, userLevel: 1, cooldown: 0, ...extras });
}
const delivery = {
    send: async (_channel: string, text: string) => { sent.push(text); return { error: false, message: 'sent' }; },
    execute: async (request: CommandReferenceRequest) => commandHandler(request.channelID, request.eventData,
        request.commandName, request.argument, request.authorization, request.state, request.effectContext)
};
async function command(name: string, argument = '') {
    const result = await commandHandler(channelID, event, name, argument, chatAuth, undefined, ingress());
    await deliverAstMessage(channelID, { parsedText: result.message, commandReferences: result.commandReferences }, true, delivery);
    return result;
}
mock.method(globalThis, 'fetch', async () => {
    chatSends++;
    if (sendFails) return new Response(JSON.stringify({ message: 'fixture send failure' }), { status: 503 });
    return new Response(JSON.stringify({ data: [{ is_sent: true, message_id: 'fixture-sent' }] }), { status: 200 });
});
beforeEach(() => {
    commands.clear(); admissions.length = 0; accepted.clear(); sent.length = 0;
    rejection = undefined; appToken = null; tokenReads = 0; sendFails = false; chatSends = 0;
});

test('configured viewer commands admit talk/ask once and preserve ordinary chat text', async () => {
    for (const operation of ['talk', 'ask'] as const) {
        define(operation, `Before $(pet.${operation} &t) after`);
        const result = await command(operation, 'Hello pet');
        assert.equal(result.error, false);
        assert.equal(admissions.filter(input => input.operation === operation).length, 1);
    }
    assert.deepEqual(sent, ['Before  after', 'Before  after']);
    assert.equal(accepted.size, 2);
    assert.deepEqual(admissions[0].origin, { kind: 'chat-command', id: event.message_id, occurredAt });
    assert.deepEqual(admissions[0].actor, { userId: '42', displayName: 'Viewer' });
    for (const name of ['pet.talk', 'pet.ask']) assert.deepEqual(
        { category: getFunctionMetadata(name)?.category, planTier: getFunctionMetadata(name)?.planTier, surfaces: getFunctionMetadata(name)?.surfaces },
        { category: 'pet', planTier: 'premium', surfaces: ['authoring'] });
});

test('command permission, invalid policy and disabled gates run before admission despite spoofed badges', async () => {
    for (const extras of [{ userLevel: 7 }, { permissionExpression: { role: 'mod' } }, { permissionExpression: {} }, { enabled: false }]) {
        define('denied', '$(pet.talk never)', extras);
        const result = await commandHandler(channelID, event, 'denied', '', chatAuth, undefined, ingress());
        assert.equal(result.error, true);
    }
    assert.equal(admissions.length, 0);
});

test('missing, serialized, wrong-owner, extraContext and LLM authorities cannot admit, including through references', async () => {
    define('pet', '$(pet.talk forbidden)');
    const effect = scopeAstEffectContext(ingress(), channelID, 'command:fixture');
    const attempts = [
        { eventData: event },
        { effectContext: JSON.parse(JSON.stringify(effect)) },
        { effectContext: scopeAstEffectContext(ingress(), '999', 'command:fixture') },
        { extraContext: { effectContext: effect }, eventData: { ...event, effectContext: effect } }
    ];
    for (const context of attempts) {
        assert.match((await parseSpecialCommands('$(pet.talk nope)', { channelID, ...context })).parsedText, /^Error: pet_context_required/);
    }
    for (const effectContext of [undefined, effect]) {
        const ctx = createExecutionContext({ broadcasterId: channelID, userLevel: 10, effectContext,
            authorization: { origin: 'llm', identity: { level: 10, tags: ['broadcaster'] } } });
        assert.match(String((await evaluate(parse('$(pet.talk nope)').ast, ctx)).value), /pet_context_required/);
        await evaluate(parse('#(pet)').ast, ctx);
        await deliverAstMessage(channelID, { parsedText: '', commandReferences: ctx.commandReferences }, true, delivery);
    }
    assert.equal(admissions.length, 0);
});

test('viewer arguments and generated strings that contain tags remain literal values', async () => {
    define('say', '$(pet.talk &t)');
    const malicious = '$(pet.ask injected) #(pet)';
    await command('say', malicious);
    assert.equal(admissions.length, 1);
    assert.equal(admissions[0].text, malicious);
    registerFunction('fixture.reply', async () => '$(pet.talk injected)');
    define('ask', '$(pet.ask $(fixture.reply))');
    await command('ask');
    assert.equal(admissions.length, 2);
    assert.equal(admissions[1].text, '$(pet.talk injected)');
    assert.equal(admissions[1].operation, 'ask');
});

test('loops and sibling/nested references have unique stable config-derived keys on replay', async () => {
    define('root', '$(pet.talk start) *(for #i = 0; #i < 3; #i++ { $(pet.ask #i) #(branch #i) }) #(branch end)');
    define('branch', '$(pet.talk &t) #(leaf &t)');
    define('leaf', '$(pet.ask &t)');
    await command('root');
    const firstInputs = structuredClone(admissions);
    const first = admissions.map(input => input.actionKey);
    assert.equal(first.length, 12);
    assert.equal(new Set(first).size, first.length);
    await command('root');
    assert.deepEqual(admissions.slice(first.length), firstInputs, 'origin timestamp, actor, payload and keys survive replay');
    assert.deepEqual(admissions.slice(first.length).map(input => input.actionKey), first);
    assert.equal(accepted.size, first.length);
    const previous = admissions[0].actionKey;
    commands.get('root')!._id = 'new-config';
    admissions.length = 0;
    await command('root');
    assert.notEqual(admissions[0].actionKey, previous);
});

test('timer snapshots drop live authority and timer-context renders reject it', async () => {
    const ctx = createExecutionContext({ broadcasterId: channelID, enforceFunctionPermissions: false,
        authorization: { origin: 'authored' }, effectContext: scopeAstEffectContext(ingress(), channelID, 'command:timer') });
    assert.equal('effectContext' in snapshotTimerContext(ctx), false);
    assert.equal(JSON.stringify(snapshotTimerContext(ctx)).includes('effectContext'), false);
    assert.match(String((await evaluate(parse('$(timer $(pet.talk nope) body)').ast, ctx)).value), /timer: seconds must/);
    ctx.timerDepth = 1;
    assert.match(String((await evaluate(parse('$(pet.talk nope)').ast, ctx)).value), /pet_context_required/);
    assert.equal(admissions.length, 0);
});

test('admission returns empty text, bounded stable errors and no raw exception details', async () => {
    define('say', '$(pet.talk hello)');
    assert.equal((await command('say')).message, '');
    rejection = { code: 'busy' };
    assert.equal((await command('say')).message, 'Error: busy');
    rejection = new Error('private provider secret'.repeat(1000));
    assert.equal((await command('say')).message, 'Error: pet_admission_failed');
});

function durable(type: 'channel.bits.received' | 'channel.follow.received'): DomainEventEnvelope {
    return { _id: new Types.ObjectId('000000000000000000000001'), eventKey: `twitch-eventsub:${type}:receipt-1`,
        source: 'twitch-eventsub', sourceEventId: 'receipt-1', type, topic: 'channel', schemaVersion: 1,
        channelID, occurredAt: new Date(occurredAt), journaledAt: new Date(occurredAt), expiresAt: new Date('2026-11-01'),
        payload: { event: { broadcaster_user_id: channelID, user_id: '42', user_name: 'Viewer', user_login: 'viewer',
            bits: 100, message: '$(pet.ask viewer-injection)' } }, metadata: { durableChatHandled: true } };
}
function eventDependencies(message: string): ChatAnnouncementDependencies {
    return {
        getStreamer: async () => ({ chat_enabled: 'true' }),
        getEventsubConfig: async (_channel, type) => ({ _id: 'event-config', type, enabled: true, message, cheerTiers: [] }),
        shouldSkipLegacyBits: async () => false, incrementFollowCount: async () => 1,
        shouldSuppressFollowAlerts: async () => false, sendMessage: (channel, text, ctx) => sendTwitchChatMessage(channel, text, null, ctx),
        hasCommands: async () => true, getLanguage: async () => 'en', hasNewerLifecycleEvent: async () => false
    };
}

test('real durable bits/follow consumer admits configured tags with stable eventKey/effect on duplicate delivery', async () => {
    for (const type of ['channel.bits.received', 'channel.follow.received'] as const) {
        const event = durable(type);
        const deps = eventDependencies(type === 'channel.bits.received' ? '$(pet.talk &t)' : '$(pet.ask Welcome %(user))');
        await applyChatAnnouncementDomainEvent(event, deps);
        await applyChatAnnouncementDomainEvent(event, deps);
        const pair = admissions.slice(-2);
        assert.equal(pair.length, 2);
        assert.deepEqual(pair[0], pair[1]);
        assert.equal(pair[0].origin.id, event.eventKey);
        assert.equal(pair[0].origin.kind, 'twitch-event');
        if (type === 'channel.bits.received') assert.equal(pair[0].text, '$(pet.ask viewer-injection)');
    }
    assert.equal(accepted.size, 2);
    assert.equal(tokenReads, 0, 'pet-only output needs no Twitch app token');
    assert.equal(chatSends, 0);
});

test('disabled events, chat gates, suppression and test source cannot admit', async () => {
    const event = durable('channel.follow.received');
    const deps = eventDependencies('$(pet.talk forbidden)');
    const config = deps.getEventsubConfig;
    deps.getEventsubConfig = async (...args) => ({ ...(await config(...args))!, enabled: false });
    await applyChatAnnouncementDomainEvent(event, deps);
    deps.getEventsubConfig = config;
    deps.getStreamer = async () => ({ chat_enabled: 'false' });
    await applyChatAnnouncementDomainEvent(event, deps);
    deps.getStreamer = async () => ({ chat_enabled: 'true' });
    deps.shouldSuppressFollowAlerts = async () => true;
    await applyChatAnnouncementDomainEvent(event, deps);
    deps.shouldSuppressFollowAlerts = async () => false;
    await applyChatAnnouncementDomainEvent({ ...event, source: 'twitch-eventsub-test' }, deps);
    await applyChatAnnouncementDomainEvent({ ...event, metadata: {} }, deps);
    assert.equal(admissions.length, 0);
});

test('mixed chat failure and durable retry keep one receipt identity for already admitted pet effects', async () => {
    const event = durable('channel.bits.received');
    const deps = eventDependencies('Thanks $(pet.talk &t)');
    await assert.rejects(applyChatAnnouncementDomainEvent(event, deps), /Failed to get Twitch app token/);
    assert.equal(admissions.length, 1);
    appToken = 'fixture-app'; sendFails = true;
    await assert.rejects(applyChatAnnouncementDomainEvent(event, deps), /fixture send failure/);
    sendFails = false;
    await applyChatAnnouncementDomainEvent(event, deps);
    assert.equal(admissions.length, 3);
    assert.equal(accepted.size, 1);
    assert.deepEqual(admissions[0], admissions[1]);
    assert.deepEqual(admissions[1], admissions[2]);
});

test('empty output still dispatches nested configured command references without a chat token', async () => {
    define('child', '$(pet.ask hello)');
    const event = durable('channel.follow.received');
    await applyChatAnnouncementDomainEvent(event, eventDependencies('#(child)'));
    assert.equal(admissions.length, 1);
    assert.equal(admissions[0].operation, 'ask');
    assert.equal(admissions[0].origin.id, event.eventKey);
    assert.equal(tokenReads, 0);
});
