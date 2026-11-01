import assert from 'node:assert/strict';
import test from 'node:test';
import { Types } from 'mongoose';
import type { DomainEventEnvelope } from './domain_event.types.js';
import {
    applyStreamOperationsDomainEvent,
    reconcileCurrentStreamOperations,
    type StepOutcome,
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
    const progress: Record<string, StepOutcome> = {};
    return {
        async getAuthSkipReason() { return null; },
        async readProgress() { return { ...progress }; },
        async writeProgress(_event, step, outcome) { progress[step] = outcome; },
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
        'load-editors:channel-1:true',
        'load-admins:channel-1'
    ]);
});

test('stream.ended rejects when offline role reconciliation fails so delivery retries', async () => {
    const calls: string[] = [];
    const operations = createOperations(calls);
    operations.getChannelEditors = async (channelID, cache) => {
        calls.push(`load-editors:${channelID}:${cache}`);
        return {
            error: true,
            message: 'Twitch editor lookup unavailable',
            type: 'provider_error'
        };
    };

    await assert.rejects(
        applyStreamOperationsDomainEvent(createEvent('stream.ended'), operations),
        /Reconciling channel editors failed: Twitch editor lookup unavailable/
    );
    assert.deepEqual(calls, [
        'unload-timers:channel-1',
        'reset-rewards:channel-1',
        'reset-sumimetro:channel-1',
        'clear-channel:channel-1',
        'clear-speech:channel-1',
        'clear-history:channel-1',
        'load-editors:channel-1:true',
        'load-admins:channel-1'
    ]);
});

test('stream.ended retries when the authoritative admin rebuild fails', async () => {
    const calls: string[] = [];
    const operations = createOperations(calls);
    operations.loadChannelAdminsIntoCache = async (channelID) => {
        calls.push(`load-admins:${channelID}`);
        throw new Error('Mongo admin lookup unavailable');
    };

    await assert.rejects(
        applyStreamOperationsDomainEvent(createEvent('stream.ended'), operations),
        /Mongo admin lookup unavailable/
    );
    assert.deepEqual(calls.slice(-2), [
        'load-editors:channel-1:true',
        'load-admins:channel-1'
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
        /Reconciling channel editors failed: Failed to authenticate/
    );
    assert.deepEqual(calls, ['load-timers:channel-1', 'load-admins:channel-1', 'expire-vips:channel-1:streamer']);
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


test('failed steps retry while completed effects are not repeated', async () => {
    const calls: string[] = [];
    const operations = createOperations(calls);
    const event = createEvent('stream.started');
    let fail = true;
    operations.getChannelEditors = async () => {
        calls.push('editors');
        if (fail) throw new Error('provider unavailable');
        return { error: false };
    };
    await assert.rejects(applyStreamOperationsDomainEvent(event, operations), /provider unavailable/);
    fail = false;
    await applyStreamOperationsDomainEvent(event, operations);
    assert.deepEqual(calls, ['load-timers:channel-1', 'editors', 'load-admins:channel-1', 'expire-vips:channel-1:streamer', 'editors']);
    assert.equal((await operations.readProgress(event)).editors.status, 'completed');
});

test('disabled auth skips Twitch steps explicitly but preserves local and admin effects', async () => {
    const calls: string[] = [];
    const operations = createOperations(calls);
    operations.getAuthSkipReason = async () => 'permissions_disabled';
    const event = createEvent('stream.ended');
    await applyStreamOperationsDomainEvent(event, operations);
    const progress = await operations.readProgress(event);
    assert.equal(progress.rewards.reason, 'permissions_disabled');
    assert.equal(progress.editors.status, 'skipped');
    assert.equal(progress.admins.status, 'completed');
    assert.ok(calls.includes('clear-history:channel-1'));
    assert.ok(!calls.some(call => call.startsWith('reset-rewards') || call.startsWith('load-editors')));
});

test('auth lookup failures are retried and do not prevent local steps', async () => {
    const calls: string[] = [];
    const operations = createOperations(calls);
    operations.getAuthSkipReason = async () => { throw new Error('Mongo unavailable'); };
    const event = createEvent('stream.started');
    await assert.rejects(applyStreamOperationsDomainEvent(event, operations), /Mongo unavailable/);
    assert.equal((await operations.readProgress(event)).editors.status, 'failed');
    assert.ok(calls.includes('load-admins:channel-1'));
});

test('newer lifecycle observed between steps stops the stale transition', async () => {
    const calls: string[] = [];
    const operations = createOperations(calls);
    let checks = 0;
    operations.hasNewerLifecycleEvent = async () => ++checks > 2;
    await applyStreamOperationsDomainEvent(createEvent('stream.started'), operations);
    assert.deepEqual(calls, ['load-timers:channel-1']);
});


test('reauthorization retry uses current stream state and retains successful step receipts', async () => {
    const calls: string[] = [];
    const operations = createOperations(calls);
    let live = true;
    let failed = true;
    operations.getChannelEditors = async () => {
        calls.push('editors');
        if (failed) throw new Error('provider down');
        return {};
    };
    const injected = { operations, currentStreamIsLive: async () => live };
    await assert.rejects(reconcileCurrentStreamOperations('channel-1', 1, injected), /provider down/);
    failed = false;
    live = false;
    await reconcileCurrentStreamOperations('channel-1', 1, injected);
    assert.deepEqual(calls, ['load-admins:channel-1', 'editors', 'expire-vips:channel-1:', 'editors', 'reset-rewards:channel-1']);
});

test('reauthorization disabled again records skips without Twitch requests', async () => {
    const calls: string[] = [];
    const operations = createOperations(calls);
    operations.getAuthSkipReason = async () => 'account_deactivated';
    await reconcileCurrentStreamOperations('channel-1', 2, { operations, currentStreamIsLive: async () => { throw new Error('should not fetch'); } });
    assert.deepEqual(calls, ['load-admins:channel-1']);
    const progress = await operations.readProgress(createEvent('stream.started'));
    assert.equal(progress.editors.reason, 'account_deactivated');
    assert.equal(progress.stream.status, 'skipped');
});

test('persistent editor authorization rejection is recorded as skipped', async () => {
    const operations = createOperations([]);
    operations.getChannelEditors = async () => ({ error: true, type: 'auth_required', message: 'Twitch rejected access' });
    const event = createEvent('stream.started');
    await applyStreamOperationsDomainEvent(event, operations);
    const progress = await operations.readProgress(event);
    assert.equal(progress.editors.status, 'skipped');
    assert.match(progress.editors.reason!, /^auth_required:/);
    assert.equal(progress.admins.status, 'completed');
});

test('temporary refresh failure remains failed and retryable', async () => {
    const operations = createOperations([]);
    operations.getChannelEditors = async () => ({ error: true, type: 'transient', message: 'Refresh unavailable' });
    const event = createEvent('stream.started');
    await assert.rejects(applyStreamOperationsDomainEvent(event, operations), /Refresh unavailable/);
    assert.equal((await operations.readProgress(event)).editors.status, 'failed');
});

test('account revoked during a failed operation is recorded as skipped', async () => {
    const operations = createOperations([]);
    let revoked = false;
    operations.getAuthSkipReason = async () => revoked ? 'permissions_disabled' : null;
    operations.getChannelEditors = async () => { revoked = true; return { error: true, type: 'transient', message: 'Refresh failed' }; };
    const event = createEvent('stream.started');
    await applyStreamOperationsDomainEvent(event, operations);
    assert.equal((await operations.readProgress(event)).editors.reason, 'permissions_disabled');
});
