import assert from 'node:assert/strict';
import test from 'node:test';
import { Types } from 'mongoose';
import type { DomainEventEnvelope } from './domain_event.types.js';
import { applyFollowDefenseDomainEvent, type FollowDefenseEventDependencies } from './follow_defense_events.js';

function event(type = 'channel.follow.received'): DomainEventEnvelope {
    return {
        _id: new Types.ObjectId(), eventKey: 'twitch:receipt-1', sourceEventId: 'receipt-1',
        source: 'twitch-eventsub', topic: 'channel', schemaVersion: 1, channelID: 'channel', type,
        occurredAt: new Date('2026-09-05T10:00:00Z'), journaledAt: new Date('2026-09-05T10:00:01Z'),
        expiresAt: new Date('2026-12-05T10:00:00Z'), metadata: { durableDefenseHandled: true },
        payload: { event: {
            user_id: 'follower', user_login: 'viewer', user_name: 'Viewer',
            broadcaster_user_login: 'channel', broadcaster_user_name: 'Channel',
            followed_at: 'ignored-invalid-payload-time',
            from_broadcaster_user_id: 'raider', from_broadcaster_user_login: 'raider', from_broadcaster_user_name: 'Raider',
            to_broadcaster_user_login: 'channel', to_broadcaster_user_name: 'Channel', viewers: 20
        } }
    };
}

function dependencies(effects: unknown[] = []): FollowDefenseEventDependencies {
    return {
        async getStreamer() { return { chat_enabled: 'false' }; },
        async getEventsubConfig() { return null; },
        async processFollow(payload) { effects.push(payload); },
        async setRaidMarker(payload) { effects.push(payload); }
    };
}

test('follow calls direct processing with stable journal identity and original times across retries', async () => {
    const effects: unknown[] = [];
    const input = event();
    await applyFollowDefenseDomainEvent(input, dependencies(effects));
    await applyFollowDefenseDomainEvent(input, dependencies(effects));
    assert.deepEqual(effects, Array(2).fill({
        eventID: input.eventKey, channelID: 'channel', channelLogin: 'channel', channelName: 'Channel',
        followerID: 'follower', followerLogin: 'viewer', followerName: 'Viewer',
        followedAt: input.occurredAt.toISOString(), receivedAt: input.journaledAt.getTime()
    }));
});

test('raid marker identity and expiry come from occurrence, not replay time', async () => {
    const effects: unknown[] = [];
    const input = event('channel.raid.received');
    await applyFollowDefenseDomainEvent(input, dependencies(effects));
    await applyFollowDefenseDomainEvent(input, dependencies(effects));
    assert.deepEqual(effects, Array(2).fill({
        eventID: input.eventKey, channelID: 'channel', channelLogin: 'channel', channelName: 'Channel',
        raiderChannelID: 'raider', raiderChannelLogin: 'raider', raiderChannelName: 'Raider', raidViewers: 20,
        createdAt: input.occurredAt.getTime(), expiresAt: input.occurredAt.getTime() + 300_000
    }));
});

test('historical, test, foreign-source, unsupported type/topic/version never load dependencies', async () => {
    for (const patch of [
        { metadata: {} }, { metadata: { durableDefenseHandled: 'true' } },
        { source: 'twitch-eventsub-test' }, { source: 'kick' },
        { type: 'channel.bits.received' }, { topic: 'domain' as const }, { schemaVersion: 2 }
    ]) {
        await applyFollowDefenseDomainEvent({ ...event(), ...patch });
    }
});

test('preserves streamer, enabled config and minimum raid viewer gates, independent of chat', async () => {
    for (const type of ['channel.follow.received', 'channel.raid.received']) {
        const effects: unknown[] = [];
        const deps = dependencies(effects);
        deps.getStreamer = async () => null;
        await applyFollowDefenseDomainEvent(event(type), deps);
        deps.getStreamer = async () => ({ chat_enabled: 'false' });
        deps.getEventsubConfig = async () => ({ enabled: false });
        await applyFollowDefenseDomainEvent(event(type), deps);
        assert.deepEqual(effects, []);
        deps.getEventsubConfig = async () => ({ enabled: true, minViewers: 21 });
        await applyFollowDefenseDomainEvent(event(type), deps);
        assert.equal(effects.length, type === 'channel.follow.received' ? 1 : 0);
    }
});

test('all required dependency failures propagate to the isolated delivery', async () => {
    for (const type of ['channel.follow.received', 'channel.raid.received']) {
        for (const key of ['getStreamer', 'getEventsubConfig', type === 'channel.follow.received' ? 'processFollow' : 'setRaidMarker'] as const) {
            const deps = dependencies();
            deps[key] = async () => { throw new Error(`failed:${key}`); };
            await assert.rejects(applyFollowDefenseDomainEvent(event(type), deps), new RegExp(`failed:${key}`));
        }
    }
});

test('invalid required identities fail rather than silently completing', async () => {
    for (const patch of [{ channelID: undefined }, { eventKey: '' }, { occurredAt: new Date('invalid') }, { payload: {} }]) {
        await assert.rejects(applyFollowDefenseDomainEvent({ ...event(), ...patch }, dependencies()), /requires/);
    }
});

test('production dependency wiring uses a precise account query and propagates Mongo errors', async (context) => {
    let fail = false;
    const effects: unknown[] = [];
    context.mock.module('../schemas/users.schema.js', { defaultExport: { exists: async (filter: unknown) => {
        assert.deepEqual(filter, { accounts: { $elemMatch: { type: 'twitch', id: 'channel' } } });
        if (fail) throw new Error('Mongo unavailable');
        return { _id: 'owner' };
    } } });
    context.mock.module('../schemas/eventsub.schema.js', { defaultExport: { findOne: (filter: unknown) => {
        assert.deepEqual(filter, { channelID: 'channel', type: 'channel.follow' });
        return { lean: async () => null };
    } } });
    context.mock.module('../utils/follow_defense.js', { namedExports: {
        processDurableFollowDefenseFollow: async (payload: unknown) => { effects.push(payload); }
    } });
    context.mock.module('../utils/follow_defense_queue.js', { namedExports: {
        applyDurableFollowDefenseRaidMarker: async () => assert.fail('Not a raid')
    } });
    await applyFollowDefenseDomainEvent(event());
    assert.equal(effects.length, 1);
    fail = true;
    await assert.rejects(applyFollowDefenseDomainEvent(event()), /Mongo unavailable/);
    assert.equal(effects.length, 1);
});
