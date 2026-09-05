import assert from 'node:assert/strict';
import test from 'node:test';
import { Types } from 'mongoose';
import type { DomainEventEnvelope } from './domain_event.types.js';
import {
    applyAccountHealthNotificationDomainEvent,
    applyChatAnnouncementDomainEvent,
    type ChatAnnouncementDependencies
} from './chat_announcement_events.js';

function createEvent(
    type: string,
    originalEventType: string,
    eventData: Record<string, unknown> = {},
    source = 'twitch-eventsub'
): DomainEventEnvelope {
    const now = new Date('2026-09-03T12:00:00.000Z');
    return {
        _id: new Types.ObjectId(),
        eventKey: `event:${originalEventType}`,
        source,
        sourceEventId: `source:${originalEventType}`,
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
                ...eventData
            }
        },
        metadata: { originalEventType, durableChatHandled: true },
        expiresAt: new Date('2026-10-03T12:00:00.000Z')
    };
}

function createDependencies(calls: string[]): ChatAnnouncementDependencies {
    return {
        async getStreamer(channelID) {
            calls.push(`streamer:${channelID}`);
            return {
                chat_enabled: 'true',
                actived: 'true',
                has_permissions: 'true',
                refresh_token: 'refresh-token',
                up_to_date_permissions: 'true'
            };
        },
        async getEventsubConfig(channelID, originalEventType) {
            calls.push(`config:${channelID}:${originalEventType}`);
            return {
                enabled: true,
                message: 'Configured message',
                type: originalEventType,
                cheerTiers: [],
                todayFollows: false
            };
        },
        async shouldSkipLegacyBits() { return false; },
        async incrementFollowCount(channelID, eventKey) {
            calls.push(`count:${channelID}:${eventKey}`);
            return 4;
        },
        async shouldSuppressFollowAlerts(channelID) {
            calls.push(`suppress:${channelID}`);
            return false;
        },
        async sendMessage(channelID, message, context) {
            calls.push(`send:${channelID}:${message}:${String(context?.variables || '')}`);
            return { error: false, message: 'sent' };
        },
        async hasCommands(channelID) {
            calls.push(`commands:${channelID}`);
            return true;
        },
        async getLanguage(channelID) {
            calls.push(`language:${channelID}`);
            return 'en';
        },
        async hasNewerLifecycleEvent() { return false; }
    };
}

test('bits announcements use the original event config and matching tier', async () => {
    const calls: string[] = [];
    const dependencies = createDependencies(calls);
    dependencies.getEventsubConfig = async (_channelID, originalEventType) => {
        calls.push(`config:${originalEventType}`);
        return {
            enabled: true,
            message: 'Default cheer',
            type: originalEventType,
            cheerTiers: [{ name: 'large', message: 'Large cheer', min_amount: 100, max_amount: 500 }]
        };
    };

    await applyChatAnnouncementDomainEvent(createEvent(
        'channel.bits.received',
        'channel.cheer',
        { bits: 250, user_name: 'Viewer', user_login: 'viewer' }
    ), dependencies);

    assert.equal(calls.includes('config:channel.cheer'), true);
    assert.equal(calls.some((call) => call.startsWith('send:channel-1:Large cheer:')), true);
});

test('an empty matching bits tier suppresses the announcement rather than sending the default', async () => {
    const calls: string[] = [];
    const dependencies = createDependencies(calls);
    dependencies.getEventsubConfig = async () => ({
        enabled: true,
        message: 'Default cheer',
        type: 'channel.bits.use',
        cheerTiers: [{ name: 'quiet', message: '', min_amount: 1, max_amount: 99 }]
    });

    await applyChatAnnouncementDomainEvent(
        createEvent('channel.bits.received', 'channel.bits.use', { bits: 10 }),
        dependencies
    );

    assert.equal(calls.some((call) => call.startsWith('send:')), false);
});

test('subscription announcements select config using metadata.originalEventType', async () => {
    const calls: string[] = [];

    await applyChatAnnouncementDomainEvent(createEvent(
        'channel.subscription.received',
        'channel.subscription.message',
        { user_name: 'Subscriber' }
    ), createDependencies(calls));

    assert.equal(calls.includes('config:channel-1:channel.subscription.message'), true);
    assert.equal(calls.some((call) => call.startsWith('send:channel-1:Configured message:')), true);
});

test('follow announcements use the retry-stable count assigned to the event key', async () => {
    const calls: string[] = [];
    const dependencies = createDependencies(calls);
    dependencies.getEventsubConfig = async () => ({
        enabled: true,
        message: 'Thanks for following',
        type: 'channel.follow',
        cheerTiers: [],
        todayFollows: true
    });

    await applyChatAnnouncementDomainEvent(createEvent(
        'channel.follow.received',
        'channel.follow',
        { user_name: 'Follower', user_login: 'follower' }
    ), dependencies);

    assert.equal(calls.includes('count:channel-1:event:channel.follow'), true);
    assert.equal(calls.some((call) => call.startsWith('send:channel-1:Thanks for following (Follow #4):')), true);
});

test('chat send failures reject so the durable delivery retries', async () => {
    const calls: string[] = [];
    const dependencies = createDependencies(calls);
    dependencies.sendMessage = async () => ({ error: true, message: 'Twitch unavailable' });

    await assert.rejects(
        applyChatAnnouncementDomainEvent(createEvent('stream.ended', 'stream.offline'), dependencies),
        /Sending stream.offline chat announcement failed: Twitch unavailable/
    );
});

test('test-source and unsupported events do not load production dependencies', async () => {
    const calls: string[] = [];
    const dependencies = createDependencies(calls);

    await applyChatAnnouncementDomainEvent(
        createEvent('stream.started', 'stream.online', {}, 'twitch-eventsub-test'),
        dependencies
    );
    await applyChatAnnouncementDomainEvent(
        createEvent('channel.raid.received', 'channel.raid'),
        dependencies
    );

    assert.deepEqual(calls, []);
});

test('historical events handled immediately do not produce durable chat or account warnings', async () => {
    const calls: string[] = [];
    const dependencies = createDependencies(calls);
    const event = createEvent('stream.started', 'stream.online');
    delete event.metadata.durableChatHandled;

    await applyChatAnnouncementDomainEvent(event, dependencies);
    await applyAccountHealthNotificationDomainEvent(event, dependencies);

    assert.deepEqual(calls, []);
});

for (const disabledBy of ['chat', 'event-config', 'test-source'] as const) {
    test(`${disabledBy} suppresses both announcements and account-health notifications`, async () => {
        const calls: string[] = [];
        const dependencies = createDependencies(calls);
        dependencies.getStreamer = async () => ({
            chat_enabled: disabledBy === 'chat' ? 'false' : 'true',
            actived: 'false'
        });
        dependencies.getEventsubConfig = async () => ({
            enabled: disabledBy !== 'event-config',
            message: 'Do not send',
            type: 'stream.online',
            cheerTiers: []
        });
        const event = createEvent('stream.started', 'stream.online', {},
            disabledBy === 'test-source' ? 'twitch-eventsub-test' : 'twitch-eventsub');

        await applyChatAnnouncementDomainEvent(event, dependencies);
        await applyAccountHealthNotificationDomainEvent(event, dependencies);

        assert.equal(calls.some((call) => call.startsWith('send:')), false);
    });
}

test('legacy bits suppression skips duplicate announcements', async () => {
    const calls: string[] = [];
    const dependencies = createDependencies(calls);
    dependencies.shouldSkipLegacyBits = async () => true;

    await applyChatAnnouncementDomainEvent(
        createEvent('channel.bits.received', 'channel.cheer', { bits: 100 }),
        dependencies
    );

    assert.equal(calls.some((call) => call.startsWith('config:') || call.startsWith('send:')), false);
});

test('follow-defense suppression still counts a follow without announcing it', async () => {
    const calls: string[] = [];
    const dependencies = createDependencies(calls);
    dependencies.shouldSuppressFollowAlerts = async () => true;

    await applyChatAnnouncementDomainEvent(
        createEvent('channel.follow.received', 'channel.follow'),
        dependencies
    );

    assert.equal(calls.includes('count:channel-1:event:channel.follow'), true);
    assert.equal(calls.some((call) => call.startsWith('send:')), false);
});

test('superseded lifecycle announcements are not sent late', async () => {
    const calls: string[] = [];
    const dependencies = createDependencies(calls);
    dependencies.hasNewerLifecycleEvent = async () => true;

    await applyChatAnnouncementDomainEvent(
        createEvent('stream.started', 'stream.online'),
        dependencies
    );

    assert.deepEqual(calls, []);
});

test('account-health notifications are durable and localized independently', async () => {
    const calls: string[] = [];
    const dependencies = createDependencies(calls);
    dependencies.getStreamer = async () => ({
        chat_enabled: 'true',
        actived: 'false',
        has_permissions: 'false',
        refresh_token: '',
        up_to_date_permissions: 'false'
    });
    dependencies.getLanguage = async () => 'es';

    await applyAccountHealthNotificationDomainEvent(
        createEvent('stream.started', 'stream.online'),
        dependencies
    );

    assert.equal(calls.some((call) => call.includes('send:channel-1:Tu cuenta fue desactivada.')), true);
});

test('account-health send failures reject independently for retry', async () => {
    const calls: string[] = [];
    const dependencies = createDependencies(calls);
    dependencies.getStreamer = async () => ({
        chat_enabled: 'true',
        actived: 'false'
    });
    dependencies.sendMessage = async () => ({ error: true, message: 'Twitch unavailable' });

    await assert.rejects(
        applyAccountHealthNotificationDomainEvent(
            createEvent('stream.started', 'stream.online'),
            dependencies
        ),
        /Sending account health notification failed: Twitch unavailable/
    );
});

test('superseded stream starts do not send delayed account-health warnings', async () => {
    const calls: string[] = [];
    const dependencies = createDependencies(calls);
    dependencies.hasNewerLifecycleEvent = async () => true;

    await applyAccountHealthNotificationDomainEvent(
        createEvent('stream.started', 'stream.online'),
        dependencies
    );

    assert.deepEqual(calls, []);
});
