import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDomainEventKey, journalDomainEvent } from './domain_events.js';

test('domain event keys encode delimiter-bearing components without collisions', () => {
    assert.notEqual(
        buildDomainEventKey('a:b', 'c', 'd'),
        buildDomainEventKey('a', 'b:c', 'd')
    );
    assert.equal(buildDomainEventKey('twitch', 'message-1', 'stream.started'), 'twitch:message-1:stream.started');
});

test('journalDomainEvent rejects an invalid occurrence time before database access', async () => {
    await assert.rejects(journalDomainEvent({
        source: 'test',
        sourceEventId: 'invalid-date',
        type: 'test.invalid-date',
        topic: 'channel',
        channelID: 'channel-1',
        occurredAt: 'not-a-date',
        payload: {}
    }), /occurredAt must be a valid date/);
});

test('journalDomainEvent rejects non-finite numeric settings before database access', async () => {
    await assert.rejects(journalDomainEvent({
        source: 'test',
        sourceEventId: 'invalid-retention',
        type: 'test.invalid-retention',
        topic: 'channel',
        channelID: 'channel-1',
        retentionSeconds: Number.NaN,
        payload: {}
    }), /must be finite numbers/);
});

test('channel events still require their provider channel ID', async () => {
    await assert.rejects(journalDomainEvent({
        source: 'twitch-eventsub', sourceEventId: 'missing-channel', topic: 'channel',
        type: 'stream.started', payload: {}
    }), /channelID is required/);
});

test('provider-neutral events require an owner or subject identity', async () => {
    await assert.rejects(journalDomainEvent({
        source: 'polar', sourceEventId: 'missing-owner', topic: 'domain',
        type: 'billing.order.paid', channelID: 'not-an-owner', payload: {}
    }), /requires a subject or owner identity/);
});

test('owner identity cannot be a provider channel ID', async () => {
    await assert.rejects(journalDomainEvent({
        source: 'polar', sourceEventId: 'bad-owner', topic: 'domain',
        type: 'billing.order.paid', ownerUserId: '12345', payload: {}
    }), /ownerUserId must be an internal user ObjectId/);
});
