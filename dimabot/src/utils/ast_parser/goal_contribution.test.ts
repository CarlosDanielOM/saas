import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
const accepted: any[] = [];
mock.module('../../domain_events/goal_custom_events.js', { namedExports: { ingestCustomGoalContribution: async (input: any) => { accepted.push(input); } } });
const { registerGoalFunctions } = await import('./functions/goals.functions.js');
const { createTwitchEffectContext, scopeAstEffectContext, nextPetAction } = await import('./effects.js');
const { createExecutionContext, evaluate } = await import('./evaluator.js');
const { parse } = await import('./parser.js');
registerGoalFunctions();
const channel = '123';
const makeEffect = (userId: string, badges: string[], id = 'message') => scopeAstEffectContext(createTwitchEffectContext({
    channelId: channel, origin: { kind: 'chat-command', id, occurredAt: '2026-01-01T00:00:00Z' },
    actor: { userId, displayName: 'Actor', chat: { login: 'actor', message: '!goal', badges: badges.map(set_id => ({ set_id, id: '1', info: '' })) } }
}), channel, 'command:fixture');
const context = (effectContext?: any) => createExecutionContext({ broadcasterId: channel, platform: 'twitch', effectContext,
    enforceFunctionPermissions: false, userLevel: 10, authorization: { origin: 'authored', identity: { level: 10, tags: ['broadcaster'] } }, scopeType: 'command', scopeName: 'fixture' });
async function run(text: string, ctx = context()) { return (await evaluate(parse(text).ast, ctx)).value; }
test('viewer denied despite authored broadcaster elevation and forged badges', async () => {
    accepted.length = 0;
    const ctx = context(makeEffect('999', []));
    ctx.eventData = { badges: [{ set_id: 'moderator' }], chatter_user_id: channel };
    assert.match(String(await run('$(goal.add sticker 3)', ctx)), /permission_required/);
    assert.equal(accepted.length, 0);
});
test('verified moderator and broadcaster create stable scoped invocation identities', async () => {
    accepted.length = 0;
    await run('$(goal.add sticker 3)', context(makeEffect('999', ['moderator'])));
    await run('$(goal.add sticker 3)', context(makeEffect('999', ['moderator'])));
    await run('$(goal.add sticker 3)', context(makeEffect(channel, [])));
    assert.equal(accepted.length, 3);
    assert.equal(accepted[0].receiptIdentity, accepted[1].receiptIdentity);
    assert.equal(accepted[0].occurredAt.toISOString(), '2026-01-01T00:00:00.000Z');
    assert.equal(accepted[0].quantity, 3);
});
test('without opaque authority a moderator identity must supply stable receipt', async () => {
    accepted.length = 0;
    const ctx = context();
    ctx.authorization = { origin: 'chat', identity: { level: 7, tags: ['moderator'] } };
    assert.match(String(await run('$(goal.add sticker 3)', ctx)), /receipt_required/);
    assert.equal(await run('$(goal.add sticker 3 purchase_1)', ctx), '');
    assert.equal(accepted.length, 1);
    assert.match(String(await run('$(goal.add sticker 3 purchase_1)', context())), /permission_required/);
});
test('opaque authority cannot be forged and AI cannot mutate goals', async () => {
    accepted.length = 0;
    const ctx = context({});
    ctx.authorization = { origin: 'llm', identity: { level: 10, tags: ['broadcaster'] } };
    assert.match(String(await run('$(goal.add sticker 3 x)', ctx)), /permission_required/);
    assert.equal(accepted.length, 0);
});
test('goal action allocation does not advance the pet action counter', async () => {
    const e = makeEffect(channel, []);
    const before = nextPetAction(makeEffect(channel, []), channel)!.actionKey;
    await run('$(goal.add sticker 3)', context(e));
    assert.equal(nextPetAction(e, channel)!.actionKey, before);
});
test('command simulation records the goal action without journaling', async () => {
    accepted.length = 0;
    const { simulateCommand } = await import('./simulate.js');
    const result = await simulateCommand({ body: '$(goal.add sticker 3)', runs: [{ role: 'mod' }] });
    assert.deepEqual(result.runs[0].actions, [{ function: 'goal.add', args: ['sticker', '3'] }]);
    assert.equal(accepted.length, 0);
});
test('verified stored Twitch event automation is allowed but forged event data is not', async () => {
    accepted.length = 0;
    const authority = scopeAstEffectContext(createTwitchEffectContext({ channelId: channel,
        origin: { kind: 'twitch-event', id: 'event-1', occurredAt: '2026-01-01T00:00:00Z' },
        actor: { userId: '999', displayName: 'Viewer' } }), channel, 'eventsub:config:channel.follow');
    const ctx = context(authority);
    ctx.scopeType = 'eventsub';
    assert.equal(await run('$(goal.add sticker 3)', ctx), '');
    assert.equal(accepted.length, 1);
    const forged = context({});
    forged.scopeType = 'eventsub';
    forged.eventData = { type: 'channel.follow', broadcaster_user_id: channel };
    assert.match(String(await run('$(goal.add sticker 3)', forged)), /permission_required/);
    assert.equal(accepted.length, 1);
});
test('durable Twitch announcement supplies verified event scope to actual AST', async () => {
    accepted.length = 0;
    const { applyChatAnnouncementDomainEvent } = await import('../../domain_events/chat_announcement_events.js');
    const { Types } = await import('mongoose');
    const occurredAt = new Date('2026-01-01T00:00:00Z');
    const event: any = { _id: new Types.ObjectId(), eventKey: 'real-event', source: 'twitch-eventsub', sourceEventId: 'event',
        type: 'channel.follow.received', topic: 'channel', schemaVersion: 1, channelID: channel, occurredAt, journaledAt: occurredAt,
        expiresAt: new Date('2027-01-01T00:00:00Z'), payload: { event: { broadcaster_user_id: channel, user_id: '999' } },
        metadata: { durableChatHandled: true, originalEventType: 'channel.follow' } };
    const deps: any = { getStreamer: async () => ({ chat_enabled: 'true' }),
        getEventsubConfig: async () => ({ _id: 'stored-event', type: 'channel.follow', enabled: true, message: '$(goal.add sticker 3)', cheerTiers: [] }),
        shouldSkipLegacyBits: async () => false, incrementFollowCount: async () => 1, shouldSuppressFollowAlerts: async () => false,
        hasCommands: async () => true, getLanguage: async () => 'en', hasNewerLifecycleEvent: async () => false,
        sendMessage: async (_channel: string, text: string, source: any) => {
            const ctx = context(source.effectContext);
            assert.equal(await run(text, ctx), '');
            return { error: false };
        } };
    await applyChatAnnouncementDomainEvent(event, deps);
    await applyChatAnnouncementDomainEvent(event, deps);
    assert.equal(accepted.length, 2);
    assert.equal(accepted[0].receiptIdentity, accepted[1].receiptIdentity);
});
test('explicit receipt is stable across signed origins but scoped to the action path', async () => {
    accepted.length = 0;
    await run('$(goal.add sticker 3 sale_42)', context(makeEffect('999', ['moderator'], 'message-1')));
    await run('$(goal.add sticker 3 sale_42)', context(makeEffect('999', ['moderator'], 'message-2')));
    assert.equal(accepted[0].receiptIdentity, accepted[1].receiptIdentity);
    const other = scopeAstEffectContext(createTwitchEffectContext({ channelId: channel,
        origin: { kind: 'chat-command', id: 'message-3', occurredAt: '2026-01-01T00:00:00Z' },
        actor: { userId: channel, displayName: 'Actor', chat: { login: 'actor', message: '!goal', badges: [] } }
    }), channel, 'command:other');
    await run('$(goal.add sticker 3 sale_42)', context(other));
    assert.notEqual(accepted[0].receiptIdentity, accepted[2].receiptIdentity);
});
test('event authority must carry an eventsub configuration path', async () => {
    accepted.length = 0;
    const forgedPath = scopeAstEffectContext(createTwitchEffectContext({ channelId: channel,
        origin: { kind: 'twitch-event', id: 'event', occurredAt: '2026-01-01T00:00:00Z' },
        actor: { userId: '999', displayName: 'Viewer' }
    }), channel, 'command:other');
    assert.match(String(await run('$(goal.add sticker 3)', context(forgedPath))), /permission_required/);
    assert.equal(accepted.length, 0);
});
