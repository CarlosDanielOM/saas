import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { Types } from 'mongoose';

let failure: unknown;
let journalAttempts = 0;
let tokenReads = 0;
let appToken: string | null = null;
let sentText = '';
const receipts = new Map<string, unknown>();
mock.module('../utils/ast_parser/functions/index.js', { namedExports: { registerAllFunctions: () => {} } });
mock.module('../classes/twitch_streamers.class.js', { defaultExport: { getTwitchAccountById: async () => ({ id: '123', plan_tier: 'premium' }) } });
mock.module('../utils/tokens.js', { namedExports: { getAppToken: async () => { tokenReads++; return appToken; } } });
mock.module('../utils/logger.js', { namedExports: { info: async () => {}, warn: async () => {}, error: async () => {}, debug: async () => {} } });
mock.module('../utils/databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => { throw new Error('unexpected Redis'); } } });
mock.module('./goal_custom_events.js', { namedExports: { ingestCustomGoalContribution: async (input: any) => {
    journalAttempts++;
    if (failure) throw failure;
    receipts.set(input.receiptIdentity, input);
} } });
mock.method(globalThis, 'fetch', async (_url: any, init: any) => {
    sentText = String(JSON.parse(init.body).message);
    return new Response(JSON.stringify({ data: [{ is_sent: true }] }), { status: 200 });
});
const { registerGoalFunctions } = await import('../utils/ast_parser/functions/goals.functions.js');
const { sendTwitchChatMessage } = await import('../functions/chats/send_message.chat.js');
const { applyChatAnnouncementDomainEvent } = await import('./chat_announcement_events.js');
const { GoalError } = await import('../goals/model.js');
const { RequiredGoalContributionError } = await import('../utils/ast_parser/required_goal_contribution_error.js');
registerGoalFunctions();
const now = new Date('2026-11-01T00:00:00Z');
const event: any = { _id: new Types.ObjectId(), eventKey: 'event-key', source: 'twitch-eventsub', sourceEventId: 'receipt',
    type: 'channel.follow.received', topic: 'channel', schemaVersion: 1, channelID: '123', occurredAt: now, journaledAt: now,
    expiresAt: new Date('2027-01-01T00:00:00Z'), payload: { event: { broadcaster_user_id: '123', user_id: '456' } },
    metadata: { durableChatHandled: true, originalEventType: 'channel.follow' } };
const deps: any = { getStreamer: async () => ({ chat_enabled: 'true' }),
    getEventsubConfig: async () => ({ _id: 'stored-config', type: 'channel.follow', enabled: true, message: '$(goal.add sticker 3)', cheerTiers: [] }),
    shouldSkipLegacyBits: async () => false, incrementFollowCount: async () => 1, shouldSuppressFollowAlerts: async () => false,
    hasCommands: async () => true, getLanguage: async () => 'en', hasNewerLifecycleEvent: async () => false,
    sendMessage: (channel: string, text: string, context: any) => sendTwitchChatMessage(channel, text, null, context) };

test('transient journal failure escapes real announcement, parser, and chat sender so delivery retries once', async () => {
    failure = new Error('database unavailable'); appToken = null; journalAttempts = tokenReads = 0; receipts.clear();
    await assert.rejects(applyChatAnnouncementDomainEvent(event, deps), RequiredGoalContributionError);
    assert.equal(tokenReads, 0, 'failure must not send raw template or an error message');
    assert.equal(receipts.size, 0);
    failure = null;
    await applyChatAnnouncementDomainEvent(event, deps);
    await applyChatAnnouncementDomainEvent(event, deps);
    assert.equal(journalAttempts, 3);
    assert.equal(receipts.size, 1, 'replay uses the same contribution identity');
    assert.equal(tokenReads, 0, 'empty goal-only output does not post chat');
});

test('known receipt conflict renders a business error without required-effect retry', async () => {
    failure = new GoalError('conflict', 'receipt already used', 409); tokenReads = 0; appToken = 'fake-token'; sentText = '';
    await applyChatAnnouncementDomainEvent(event, deps);
    assert.equal(tokenReads, 1);
    assert.equal(sentText, 'Error: goal_contribution_failed');
});

test('ordinary parser exceptions retain the existing fallback to the original message', async () => {
    failure = null; appToken = null; tokenReads = 0;
    const result = await sendTwitchChatMessage('123', 'original text', null, {
        channelID: '123', variables: new Proxy({}, { ownKeys: () => { throw new Error('ordinary parser failure'); } })
    });
    assert.equal(result.error, true);
    assert.equal(tokenReads, 1, 'ordinary failure still falls back to sending original text');
});

test('durable delivery records retry then succeeds once the journal is available', async t => {
    const { DomainEventSchema } = await import('../schemas/domain_event.schema.js');
    const { DomainEventDeliverySchema } = await import('../schemas/domain_event_delivery.schema.js');
    const { DomainEventCheckpointSchema } = await import('../schemas/domain_event_checkpoint.schema.js');
    const { drainDomainEvents } = await import('../utils/domain_event_consumer.js');
    const doc = new DomainEventSchema({ ...event, subject: { provider: 'twitch', kind: 'streaming-account', id: '123' },
        payload: { subscription: { type: 'channel.follow' }, event: { broadcaster_user_id: '123', user_id: '456' } } });
    const query = (value: any) => {
        const result: any = { sort: () => result, limit: () => result, select: () => result, lean: async () => value,
            then: (resolve: any, reject: any) => Promise.resolve(value).then(resolve, reject) };
        return result;
    };
    let delivery: any;
    let checkpoint: Types.ObjectId | undefined;
    t.mock.method(DomainEventDeliverySchema, 'init', (async () => DomainEventDeliverySchema) as never);
    t.mock.method(DomainEventDeliverySchema, 'find', (() => query(delivery?.status === 'retry' ? [{ ...delivery }] : [])) as never);
    t.mock.method(DomainEventSchema, 'findById', (() => query(doc)) as never);
    t.mock.method(DomainEventSchema, 'find', (() => query(checkpoint ? [] : [doc])) as never);
    t.mock.method(DomainEventCheckpointSchema, 'findOne', (() => query(checkpoint ? { lastEventID: checkpoint } : null)) as never);
    t.mock.method(DomainEventCheckpointSchema, 'updateOne', ((_filter: any, update: any) => { checkpoint = update.$max.lastEventID; return query({ modifiedCount: 1 }); }) as never);
    t.mock.method(DomainEventDeliverySchema, 'findOneAndUpdate', ((_filter: any, update: any) => {
        if (update.$setOnInsert) delivery ||= { _id: new Types.ObjectId(), ...update.$setOnInsert };
        else { Object.assign(delivery, update.$set); delivery.attempts += update.$inc.attempts; }
        return query({ ...delivery });
    }) as never);
    t.mock.method(DomainEventDeliverySchema, 'updateOne', ((_filter: any, update: any) => {
        Object.assign(delivery, update.$set); return query({ modifiedCount: 1 });
    }) as never);
    const options = { consumer: 'goal-required-test', topics: ['channel' as const], schemaVersions: [1],
        handler: (envelope: any) => applyChatAnnouncementDomainEvent(envelope, deps) };
    failure = new Error('Mongo unavailable'); appToken = null; tokenReads = journalAttempts = 0; receipts.clear();
    const first = await drainDomainEvents(options);
    assert.equal(first.retried, 1);
    assert.equal(delivery.status, 'retry');
    assert.equal(tokenReads, 0);
    failure = null;
    delivery.nextAttemptAt = new Date(0);
    const second = await drainDomainEvents(options);
    assert.equal(second.succeeded, 1);
    assert.equal(delivery.status, 'succeeded');
    assert.equal(journalAttempts, 2);
    assert.equal(receipts.size, 1);
    assert.equal(tokenReads, 0);
});
