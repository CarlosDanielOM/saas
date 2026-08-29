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
        topic: 'domain',
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
        topic: 'domain',
        channelID: 'channel-1',
        retentionSeconds: Number.NaN,
        payload: {}
    }), /must be finite numbers/);
});
