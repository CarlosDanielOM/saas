import type { DomainEventEnvelope } from './domain_event.types.js';

interface OperationResult {
    error?: boolean;
    message?: string;
    type?: string;
}

export interface StreamOperationsDependencies {
    loadChannelTimersIntoCache(channelID: string): Promise<void>;
    unloadChannelTimersFromCache(channelID: string): Promise<void>;
    getChannelEditors(channelID: string, cache: boolean): Promise<OperationResult>;
    loadChannelAdminsIntoCache(channelID: string): Promise<void>;
    unVIPExpiredUser(eventData: { broadcaster_user_id: string; broadcaster_user_login: string }): Promise<OperationResult | undefined>;
    resetRedemptionCost(channelID: string): Promise<OperationResult>;
    resetSumimetro(channelID: string): Promise<void>;
    clearChannelCache(channelID: string): Promise<void>;
    clearSpeechFiles(channelID: string): Promise<void>;
    clearHistory(channelID: string): Promise<void>;
    clearLifecycleCache(channelID: string): Promise<void>;
    hasNewerLifecycleEvent(event: DomainEventEnvelope): Promise<boolean>;
}

let dependenciesPromise: Promise<StreamOperationsDependencies> | null = null;

async function getDependencies(): Promise<StreamOperationsDependencies> {
    dependenciesPromise ||= Promise.all([
        import('../classes/chat_history.js'),
        import('../functions/channels/get_editors.channel.js'),
        import('../functions/redemptions/resetredemptioncost.redemption.js'),
        import('../functions/redemptions/unvipexpired.redemption.js'),
        import('../schemas/domain_event.schema.js'),
        import('../utils/cache.js'),
        import('../utils/databases/dragonfly.database.js'),
        import('../utils/speech.js'),
        import('../utils/timer_cache.js')
    ]).then(([
        { default: ChatHistory },
        { getChannelEditors },
        { resetRedemptionCost },
        { unVIPExpiredUser },
        { DomainEventSchema },
        { clearChannelCache, loadChannelAdminsIntoCache, resetSumimetro },
        { getDragonflyClient },
        { clearSpeechFiles },
        { loadChannelTimersIntoCache, unloadChannelTimersFromCache }
    ]) => ({
        loadChannelTimersIntoCache,
        unloadChannelTimersFromCache,
        getChannelEditors,
        loadChannelAdminsIntoCache,
        unVIPExpiredUser,
        resetRedemptionCost,
        resetSumimetro,
        clearChannelCache,
        clearSpeechFiles,
        clearHistory: (channelID) => ChatHistory.clearHistory(channelID),
        async clearLifecycleCache(channelID) {
            const cache = await getDragonflyClient('streamOperationsCleanup');
            await cache.del(`twitch:${channelID}:editors`);
            const adminKeys = await cache.keys(`twitch:${channelID}:admins*`);
            for (const key of adminKeys) {
                await cache.del(key);
            }
        },
        async hasNewerLifecycleEvent(event) {
            const newerEvent = await DomainEventSchema.exists({
                channelID: event.channelID,
                source: { $ne: 'twitch-eventsub-test' },
                type: { $in: ['stream.started', 'stream.ended'] },
                $or: [
                    { occurredAt: { $gt: event.occurredAt } },
                    { occurredAt: event.occurredAt, _id: { $gt: event._id } }
                ]
            });
            return Boolean(newerEvent);
        }
    }));
    return dependenciesPromise;
}

function payloadEvent(event: DomainEventEnvelope): Record<string, unknown> {
    const value = event.payload.event;
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function requireSuccessful(result: OperationResult | undefined, benignTypes: string[], operation: string): void {
    if (!result?.error || (result.type && benignTypes.includes(result.type))) return;
    throw new Error(`${operation} failed: ${result.message || result.type || 'unknown error'}`);
}

export async function applyStreamOperationsDomainEvent(
    event: DomainEventEnvelope,
    injectedOperations?: StreamOperationsDependencies
): Promise<void> {
    if (event.source === 'twitch-eventsub-test') return;
    if (event.type !== 'stream.started' && event.type !== 'stream.ended') return;

    const rawEvent = payloadEvent(event);
    const channelID = event.channelID;
    const operations = injectedOperations || await getDependencies();
    if (await operations.hasNewerLifecycleEvent(event)) return;

    if (event.type === 'stream.started') {
        await operations.loadChannelTimersIntoCache(channelID);
        requireSuccessful(await operations.getChannelEditors(channelID, true), [], 'Loading channel editors');
        await operations.loadChannelAdminsIntoCache(channelID);
        requireSuccessful(await operations.unVIPExpiredUser({
            broadcaster_user_id: channelID,
            broadcaster_user_login: String(rawEvent.broadcaster_user_login || '')
        }), ['no_vips_found'], 'Removing expired VIPs');
    } else if (event.type === 'stream.ended') {
        await operations.unloadChannelTimersFromCache(channelID);
        requireSuccessful(
            await operations.resetRedemptionCost(channelID),
            ['channel_not_premium', 'no_rewards_found'],
            'Resetting redemption costs'
        );
        await operations.resetSumimetro(channelID);
        await operations.clearChannelCache(channelID);
        await operations.clearSpeechFiles(channelID);
        await operations.clearHistory(channelID);
        await operations.clearLifecycleCache(channelID);
    }
}
