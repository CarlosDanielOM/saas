import UsersSchema from '../schemas/users.schema.js';
import EventsubSchema, { type ICondition, type IEventsub } from '../schemas/eventsub.schema.js';
import {
    SUBSCRIPTION_TYPES,
    CANONICAL_BITS_EVENT_TYPE,
    LEGACY_BITS_EVENT_TYPES,
    getEventsubs,
    migrateLegacyBitsEventsubs,
    subscribeTwitchEvent,
    unsubscribeTwitchEvent,
} from './eventsub.js';
import { buildExpectedEventsubCondition } from './eventsub_condition.js';

interface RemoteEventsub {
    id: string;
    status: string;
    type: string;
    version: string;
    condition: ICondition;
    created_at: string;
    transport: { method: string; callback: string };
    cost: number;
}

export interface EventsubReconciliationResult {
    activeChannels: number;
    remoteSubscriptions: number;
    staleLocalRemoved: number;
    remoteSubscriptionsRemoved: number;
    localSubscriptionsSynced: number;
    subscriptionsCreated: number;
    errors: string[];
}

const DEFAULT_MISSING_GRACE_MS = 12 * 60 * 60_000;
const PENDING_VERIFICATION_GRACE_MS = 30 * 60_000;

function stableCondition(condition: ICondition): string {
    return JSON.stringify(Object.fromEntries(
        Object.entries(condition || {}).sort(([left], [right]) => left.localeCompare(right))
    ));
}

function subscriptionKey(type: string, version: string, condition: ICondition): string {
    return `${type}:${version}:${stableCondition(condition)}`;
}

function resolveRemoteChannelID(remote: RemoteEventsub): string {
    return String(
        remote.condition?.broadcaster_user_id
        || remote.condition?.to_broadcaster_user_id
        || remote.condition?.user_id
        || ''
    );
}

function eventsubConfig(eventsub: Partial<IEventsub> | undefined): Partial<IEventsub> {
    if (!eventsub) return {};
    return {
        enabled: eventsub.enabled,
        message: eventsub.message,
        endMessage: eventsub.endMessage,
        endEnabled: eventsub.endEnabled,
        minViewers: eventsub.minViewers,
        temporalBanMessage: eventsub.temporalBanMessage,
        clipEnabled: eventsub.clipEnabled,
        delay: eventsub.delay,
        cheerTiers: eventsub.cheerTiers,
        todayFollows: eventsub.todayFollows
    };
}

function configurationScore(eventsub: Partial<IEventsub>): number {
    return Number(eventsub.enabled === false) * 10
        + Number(Boolean(eventsub.message)) * 4
        + Number(Boolean(eventsub.endMessage)) * 2
        + Number(eventsub.endEnabled === true) * 2
        + Number(eventsub.clipEnabled === true) * 2
        + Number(Boolean(eventsub.temporalBanMessage))
        + Number((eventsub.cheerTiers?.length || 0) > 0) * 3
        + Number((eventsub.delay || 0) !== 0)
        + Number((eventsub.minViewers || 2) !== 2)
        + Number(eventsub.todayFollows === true);
}

export async function reconcileEventsubs(options?: {
    requestDelayMs?: number;
    missingGraceMs?: number;
    shouldContinue?: () => boolean | Promise<boolean>;
}): Promise<EventsubReconciliationResult> {
    const requestDelayMs = Math.max(0, Number(options?.requestDelayMs || 0));
    const missingGraceMs = Math.max(60_000, Number(options?.missingGraceMs || DEFAULT_MISSING_GRACE_MS));
    const ensureActive = async (): Promise<void> => {
        if (options?.shouldContinue && !await options.shouldContinue()) {
            throw new Error('EventSub reconciliation cancelled because worker ownership was lost');
        }
    };
    const result: EventsubReconciliationResult = {
        activeChannels: 0,
        remoteSubscriptions: 0,
        staleLocalRemoved: 0,
        remoteSubscriptionsRemoved: 0,
        localSubscriptionsSynced: 0,
        subscriptionsCreated: 0,
        errors: []
    };

    const users = await UsersSchema.find({
        accounts: {
            $elemMatch: {
                type: 'twitch',
                actived: true,
                has_permissions: true
            }
        }
    }).select('accounts').lean();
    const activeChannels = new Map<string, string>();
    for (const user of users) {
        for (const account of user.accounts || []) {
            if (account.type === 'twitch' && account.actived && account.has_permissions && account.id) {
                activeChannels.set(account.id, account.name || account.id);
            }
        }
    }
    result.activeChannels = activeChannels.size;

    await ensureActive();
    let remoteResponse = await getEventsubs();
    if (remoteResponse?.error || remoteResponse?.complete !== true || !Array.isArray(remoteResponse?.data)) {
        throw new Error(String(remoteResponse?.message || remoteResponse?.error || 'Failed to list Twitch EventSub subscriptions'));
    }
    let remoteSubscriptions = remoteResponse.data as RemoteEventsub[];
    const initialRemoteIDs = new Set(remoteSubscriptions.map((subscription) => subscription.id));
    const legacyChannels = new Set<string>();
    for (const remote of remoteSubscriptions) {
        await ensureActive();
        const isLegacyBits = LEGACY_BITS_EVENT_TYPES.includes(remote.type as (typeof LEGACY_BITS_EVENT_TYPES)[number]);
        if (!isLegacyBits && remote.type !== CANONICAL_BITS_EVENT_TYPE) continue;
        const channelID = resolveRemoteChannelID(remote);
        if (!activeChannels.has(channelID)) continue;
        if (isLegacyBits) legacyChannels.add(channelID);
        await EventsubSchema.findOneAndUpdate({ id: remote.id }, {
            $set: {
                ...remote,
                channelID,
                channel: activeChannels.get(channelID) || channelID,
                remote_missing_since: null
            }
        }, { upsert: true, new: true, setDefaultsOnInsert: true });
    }
    for (const channelID of legacyChannels) {
        await ensureActive();
        const staleCanonical = await EventsubSchema.findOne({
            channelID,
            type: CANONICAL_BITS_EVENT_TYPE,
            id: { $nin: Array.from(initialRemoteIDs) }
        }).lean() as IEventsub | null;
        if (staleCanonical) {
            await EventsubSchema.updateMany({
                channelID,
                type: { $in: LEGACY_BITS_EVENT_TYPES }
            }, {
                $set: eventsubConfig(staleCanonical)
            });
            await EventsubSchema.deleteOne({ id: staleCanonical.id });
        }
        const migration = await migrateLegacyBitsEventsubs(channelID);
        result.remoteSubscriptionsRemoved += migration.removedLegacyCount;
        result.subscriptionsCreated += migration.createdCanonical ? 1 : 0;
        result.errors.push(...migration.errors.map((error) => `${channelID}:bits-migration: ${error}`));
    }
    if (legacyChannels.size > 0) {
        remoteResponse = await getEventsubs();
        if (remoteResponse?.error || remoteResponse?.complete !== true || !Array.isArray(remoteResponse?.data)) {
            throw new Error(String(remoteResponse?.message || remoteResponse?.error || 'Failed to refresh Twitch EventSub subscriptions after bits migration'));
        }
        remoteSubscriptions = remoteResponse.data as RemoteEventsub[];
    }
    result.remoteSubscriptions = remoteSubscriptions.length;
    const localSubscriptions = await EventsubSchema.find({
        channelID: { $in: Array.from(activeChannels.keys()) }
    }).lean() as IEventsub[];
    const remoteIDs = remoteSubscriptions.map((subscription) => subscription.id).filter(Boolean);
    const remoteIDSet = new Set(remoteIDs);
    const awaitingMissingConfirmation = new Set<string>();
    const now = new Date();
    for (const local of localSubscriptions) {
        await ensureActive();
        const key = subscriptionKey(local.type, local.version, local.condition);
        if (remoteIDSet.has(local.id)) {
            if (local.remote_missing_since) {
                await EventsubSchema.updateOne({ id: local.id }, { $set: { remote_missing_since: null } });
            }
            continue;
        }
        const missingSince = local.remote_missing_since ? new Date(local.remote_missing_since) : null;
        if (!missingSince || now.getTime() - missingSince.getTime() < missingGraceMs) {
            await EventsubSchema.updateOne(
                { id: local.id },
                { $set: { remote_missing_since: missingSince || now } }
            );
            awaitingMissingConfirmation.add(key);
            continue;
        }
        const deletion = await EventsubSchema.deleteOne({ id: local.id, remote_missing_since: local.remote_missing_since });
        if (deletion.deletedCount > 0) {
            result.staleLocalRemoved += 1;
        }
    }

    const currentLocalSubscriptions = await EventsubSchema.find({
        channelID: { $in: Array.from(activeChannels.keys()) }
    }).lean() as Array<IEventsub & { _id: unknown }>;
    const localGroups = new Map<string, Array<IEventsub & { _id: unknown }>>();
    const localByKey = new Map<string, IEventsub & { _id: unknown }>();
    for (const local of currentLocalSubscriptions) {
        const key = subscriptionKey(local.type, local.version, local.condition);
        const group = localGroups.get(key) || [];
        group.push(local);
        localGroups.set(key, group);
        const selected = localByKey.get(key);
        if (!selected || configurationScore(local) > configurationScore(selected)) {
            localByKey.set(key, local);
        }
    }

    const healthyRemoteByKey = new Map<string, RemoteEventsub>();
    const remoteGroups = new Map<string, RemoteEventsub[]>();
    for (const remote of remoteSubscriptions) {
        const key = subscriptionKey(remote.type, remote.version, remote.condition);
        const group = remoteGroups.get(key) || [];
        group.push(remote);
        remoteGroups.set(key, group);
    }
    const remoteRemovalFailed = new Set<string>();
    for (const [key, remotes] of remoteGroups) {
        await ensureActive();
        const channelID = resolveRemoteChannelID(remotes[0]);
        if (!activeChannels.has(channelID)) {
            continue;
        }
        const expected = SUBSCRIPTION_TYPES.some((subscription) => {
            return subscriptionKey(
                subscription.type,
                subscription.version,
                buildExpectedEventsubCondition(subscription, channelID)
            ) === key;
        });
        if (!expected) continue;
        const healthy = remotes.filter((remote) => {
            const pendingAgeMs = Date.now() - new Date(remote.created_at).getTime();
            return remote.status === 'enabled'
                || (remote.status === 'webhook_callback_verification_pending'
                    && Number.isFinite(pendingAgeMs)
                    && pendingAgeMs <= PENDING_VERIFICATION_GRACE_MS);
        }).sort((left, right) => {
            const statusDifference = Number(left.status !== 'enabled') - Number(right.status !== 'enabled');
            if (statusDifference !== 0) return statusDifference;
            const createdDifference = new Date(left.created_at).getTime() - new Date(right.created_at).getTime();
            return createdDifference || left.id.localeCompare(right.id);
        });
        const selected = healthy[0];
        if (selected) healthyRemoteByKey.set(key, selected);
        for (const remote of remotes) {
            if (remote.id === selected?.id) continue;
            await ensureActive();
            const response = await unsubscribeTwitchEvent(remote.id);
            if ((response as { error?: unknown })?.error) {
                remoteRemovalFailed.add(key);
                result.errors.push(`Failed to remove duplicate or unhealthy ${remote.type} subscription ${remote.id}`);
            } else {
                result.remoteSubscriptionsRemoved += 1;
            }
        }
    }

    for (const [channelID, channel] of activeChannels) {
        for (const subscription of SUBSCRIPTION_TYPES) {
            await ensureActive();
            const condition = buildExpectedEventsubCondition(subscription, channelID);
            const key = subscriptionKey(subscription.type, subscription.version, condition);
            const remote = healthyRemoteByKey.get(key);
            const preservedConfig = eventsubConfig(localByKey.get(key));
            if (remote) {
                await EventsubSchema.findOneAndUpdate({ id: remote.id }, {
                    $set: {
                        id: remote.id,
                        status: remote.status,
                        type: remote.type,
                        version: remote.version,
                        condition: remote.condition,
                        created_at: remote.created_at,
                        transport: remote.transport,
                        cost: remote.cost,
                        channel,
                        channelID,
                        ...(subscription.config || {}),
                        ...preservedConfig
                    }
                }, { upsert: true, new: true, setDefaultsOnInsert: true });
                const duplicateLocalIDs = (localGroups.get(key) || [])
                    .filter((local) => local.id !== remote.id)
                    .map((local) => local._id);
                if (duplicateLocalIDs.length > 0) {
                    const deletion = await EventsubSchema.deleteMany({ _id: { $in: duplicateLocalIDs } });
                    result.staleLocalRemoved += deletion.deletedCount || 0;
                    awaitingMissingConfirmation.delete(key);
                }
                result.localSubscriptionsSynced += 1;
                continue;
            }
            if (awaitingMissingConfirmation.has(key)) {
                continue;
            }
            if (remoteRemovalFailed.has(key)) continue;

            const response = await subscribeTwitchEvent(
                channelID,
                subscription.type,
                subscription.version,
                condition,
                {
                    ...(subscription.config || {}),
                    ...preservedConfig
                },
                { ignoreExisting: true }
            );
            if ('error' in response) {
                result.errors.push(`${channelID}:${subscription.type}: ${response.message || response.error}`);
            } else {
                result.subscriptionsCreated += 1;
                const staleCandidateIDs = (localGroups.get(key) || []).map((candidate) => candidate._id);
                if (staleCandidateIDs.length > 0) {
                    const deletion = await EventsubSchema.deleteMany({ _id: { $in: staleCandidateIDs } });
                    result.staleLocalRemoved += deletion.deletedCount || 0;
                }
            }
            if (requestDelayMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, requestDelayMs));
            }
        }
    }

    return result;
}
