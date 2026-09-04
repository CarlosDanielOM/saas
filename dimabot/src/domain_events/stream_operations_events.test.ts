import assert from 'node:assert/strict';
import test from 'node:test';
import { Types } from 'mongoose';
import type { DomainEventEnvelope } from './domain_event.types.js';
import {
    applyStreamOperationsDomainEvent,
    type StreamOperationsDependencies
} from './stream_operations_events.js';

function createEvent(type: string, source = 'twitch-eventsub'): DomainEventEnvelope {
    const now = new Date('2026-09-03T12:00:00.000Z');
    return {
        _id: new Types.ObjectId(),
        eventKey: `event:${type}`,
        source,
        sourceEventId: `source:${type}`,
        type,
        topic: 'channel',
        schemaVersion: 1,
        channelID: 'channel-1',
        streamID: type === 'stream.started' ? 'stream-1' : undefined,
        occurredAt: now,
        journaledAt: now,
        payload: {
            event: {
                broadcaster_user_id: 'channel-1',
                broadcaster_user_login: 'streamer'
            }
        },
        metadata: {},
        expiresAt: new Date('2026-10-03T12:00:00.000Z')
    };
}

function createOperations(calls: string[]): StreamOperationsDependencies {
    return {
        async loadChannelTimersIntoCache(channelID) { calls.push(`load-timers:${channelID}`); },
        async unloadChannelTimersFromCache(channelID) { calls.push(`unload-timers:${channelID}`); },
        async getChannelEditors(channelID, cache) {
            calls.push(`load-editors:${channelID}:${cache}`);
            return { error: false };
        },
        async loadChannelAdminsIntoCache(channelID) { calls.push(`load-admins:${channelID}`); },
        async unVIPExpiredUser(eventData) {
            calls.push(`expire-vips:${eventData.broadcaster_user_id}:${eventData.broadcaster_user_login}`);
            return { error: true, message: 'No VIPs found', type: 'no_vips_found' };
        },
        async resetRedemptionCost(channelID) {
            calls.push(`reset-rewards:${channelID}`);
            return { error: true, message: 'No rewards found', type: 'no_rewards_found' };
        },
        async resetSumimetro(channelID) { calls.push(`reset-sumimetro:${channelID}`); },
        async clearChannelCache(channelID) { calls.push(`clear-channel:${channelID}`); },
        async clearSpeechFiles(channelID) { calls.push(`clear-speech:${channelID}`); },
        async clearHistory(channelID) { calls.push(`clear-history:${channelID}`); },
        async clearLifecycleCache(channelID) { calls.push(`clear-lifecycle:${channelID}`); },
        async hasNewerLifecycleEvent() { return false; }
    };
}

test('stream.started runs retry-safe online operations in order', async () => {
    const calls: string[] = [];

    await applyStreamOperationsDomainEvent(createEvent('stream.started'), createOperations(calls));

    assert.deepEqual(calls, [
        'load-timers:channel-1',
        'load-editors:channel-1:true',
        'load-admins:channel-1',
        'expire-vips:channel-1:streamer'
    ]);
});

test('stream.ended treats channels without reward resets as a successful no-op', async () => {
    const calls: string[] = [];

    await applyStreamOperationsDomainEvent(createEvent('stream.ended'), createOperations(calls));

    assert.deepEqual(calls, [
        'unload-timers:channel-1',
        'reset-rewards:channel-1',
        'reset-sumimetro:channel-1',
        'clear-channel:channel-1',
        'clear-speech:channel-1',
        'clear-history:channel-1',
        'clear-lifecycle:channel-1'
    ]);
});

test('operational failures reject so the durable delivery can retry', async () => {
    const calls: string[] = [];
    const operations = createOperations(calls);
    operations.getChannelEditors = async () => ({
        error: true,
        message: 'Failed to authenticate',
        type: 'authentication_error'
    });

    await assert.rejects(
        applyStreamOperationsDomainEvent(createEvent('stream.started'), operations),
        /Loading channel editors failed: Failed to authenticate/
    );
    assert.deepEqual(calls, ['load-timers:channel-1']);
});

test('test and unrelated events do not run operational side effects', async () => {
    const calls: string[] = [];
    const operations = createOperations(calls);

    await applyStreamOperationsDomainEvent(createEvent('stream.started', 'twitch-eventsub-test'), operations);
    await applyStreamOperationsDomainEvent(createEvent('channel.follow.received'), operations);

    assert.deepEqual(calls, []);
});

test('a retry does not apply operations after a newer lifecycle event', async () => {
    const calls: string[] = [];
    const operations = createOperations(calls);
    operations.hasNewerLifecycleEvent = async () => true;

    await applyStreamOperationsDomainEvent(createEvent('stream.started'), operations);

    assert.deepEqual(calls, []);
});
