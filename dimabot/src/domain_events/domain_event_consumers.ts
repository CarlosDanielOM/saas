import type { DomainEventConsumerOptions } from '../utils/domain_event_consumer.js';

export interface DomainEventConsumerDefinition extends DomainEventConsumerOptions {
    schemaVersions: readonly number[];
}

const twitchSources = { $in: ['twitch-eventsub', 'twitch-eventsub-test'] };

export const DOMAIN_EVENT_CONSUMERS: readonly DomainEventConsumerDefinition[] = [
    {
        consumer: 'follow-defense-v1',
        topics: ['channel'],
        schemaVersions: [1],
        eventFilter: {
            source: 'twitch-eventsub',
            'metadata.durableDefenseHandled': true,
            type: { $in: ['channel.follow.received', 'channel.raid.received'] }
        },
        handler: async (event) => (await import('./follow_defense_events.js')).applyFollowDefenseDomainEvent(event)
    },
    {
        consumer: 'stream-analytics-v1',
        topics: ['channel'],
        schemaVersions: [1],
        eventFilter: { source: twitchSources },
        handler: async (event) => (await import('./stream_analytics_events.js')).applyStreamAnalyticsDomainEvent(event)
    },
    {
        consumer: 'stream-operations-v1',
        topics: ['channel'],
        schemaVersions: [1],
        eventFilter: { source: twitchSources, type: { $in: ['stream.started', 'stream.ended'] } },
        handler: async (event) => (await import('./stream_operations_events.js')).applyStreamOperationsDomainEvent(event)
    },
    {
        consumer: 'chat-announcements-v1',
        topics: ['channel'],
        schemaVersions: [1],
        eventFilter: {
            source: twitchSources,
            'metadata.durableChatHandled': true,
            type: { $in: [
                'channel.bits.received', 'channel.follow.received',
                'channel.subscription.received', 'channel.subscription.gifted', 'channel.subscription.ended',
                'stream.started', 'stream.ended'
            ] }
        },
        handler: async (event) => (await import('./chat_announcement_events.js')).applyChatAnnouncementDomainEvent(event)
    },
    {
        consumer: 'account-health-notifications-v1',
        topics: ['channel'],
        schemaVersions: [1],
        eventFilter: { source: twitchSources, 'metadata.durableChatHandled': true, type: 'stream.started' },
        handler: async (event) => (await import('./chat_announcement_events.js')).applyAccountHealthNotificationDomainEvent(event)
    },
    {
        consumer: 'polar-plan-v1', topics: ['domain'], schemaVersions: [1],
        eventFilter: { source: 'polar-webhook', type: { $in: ['billing.order.paid', 'billing.subscription.updated'] } },
        handler: async (event) => (await import('./polar_billing_events.js')).applyPolarPlanDomainEvent(event)
    },
    {
        consumer: 'polar-credits-v1', topics: ['domain'], schemaVersions: [1],
        eventFilter: { source: 'polar-webhook', type: 'billing.customer.state.changed' },
        handler: async (event) => (await import('./polar_billing_events.js')).applyPolarCreditsDomainEvent(event)
    },
    {
        consumer: 'polar-rewards-v1', topics: ['domain'], schemaVersions: [1],
        eventFilter: { source: 'polar-webhook', type: 'billing.order.paid' },
        handler: async (event) => (await import('./polar_billing_events.js')).applyPolarRewardDomainEvent(event)
    }
];
